import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { Db, migrate } from "../src/db/index.ts";
import { createSession, registerConfigVersion } from "../src/db/repo.ts";
import { scoreCalibration, signalVsBaseline } from "../src/report/analytics.ts";
import { markdownToHtml } from "../src/report/html.ts";
import { exportTable } from "../src/report/export.ts";
import { analyzeSessions, pickSessions } from "../src/report/crossSession.ts";
import { writeSessionReport } from "../src/report/sessionReport.ts";
import { sessionView } from "../src/dashboard/data.ts";
import { renderTerminal } from "../src/dashboard/terminal.ts";

/** A simulation session with baseline + signal positions over two cohorts. */
function fixture() {
  const db = new Db(":memory:");
  migrate(db);
  const v = registerConfigVersion(db, loadConfig());
  const sid = createSession(db, { kind: "session", configVersion: v, label: "fx" });
  db.run("UPDATE sessions SET status='completed', end_at=start_at+3600000 WHERE session_id=?", sid);
  for (const pool of ["A", "B"]) {
    db.insert("pools", { pool, name: `P${pool}`, token_x: "X", token_y: "Y", decimals_x: 6, decimals_y: 6, bin_step: 10, category: "memecoin", first_seen_at: 0, last_checked_at: 0 });
    db.insert("session_pools", { session_id: sid, pool, added_at: 0, rank: 1 });
  }
  let n = 0;
  const add = (pool: string, mode: string, cohort: number, net: number, score: number | null, action: string) => {
    const id = `p${++n}`;
    db.insert("sim_positions", {
      position_id: id, session_id: sid, pool, grid_combo: JSON.stringify({ cohort, signal_score: score, signal_action: action, exit_policy: "hold_to_session_end", bins_per_side: 5 }),
      entry_mode: mode, strategy: "spot", sides: "two_sided", bins_below: 5, bins_above: 5, capital_usd: 1000,
      requested_at: cohort * 1000, opened_at: cohort * 1000 + 3000, closed_at: cohort * 1000 + 60000, close_reason: "session_end",
      gap_tainted: 0, config_version: v, status: "closed",
    });
    db.insert("sim_results", {
      position_id: id, fee_usd: 5, il_usd: -net * 0 - 2, cost_usd: 1, net_pnl_usd: net * 10, net_pnl_pct: net, time_in_range_pct: 80,
      duration_min: 60, max_drawdown_pct: 1, final_value_usd: 1000, hodl_value_usd: 1000, detail: "{}",
    });
  };
  // cohort 1: A (MASUK, score 85) does better than B (LEWATI, score 40)
  for (let i = 0; i < 25; i++) {
    add("A", "all_pools_baseline", 1, 1, 85, "MASUK");
    add("B", "all_pools_baseline", 1, -1, 40, "LEWATI");
    add("A", "signal_enter", 1, 1, 85, "MASUK");
  }
  // cohort 2: no signal entries
  for (let i = 0; i < 25; i++) {
    add("A", "all_pools_baseline", 2, 0.5, 65, "PANTAU");
    add("B", "all_pools_baseline", 2, -0.5, 55, "LEWATI");
  }
  db.insert("signals", { signal_id: "s1", session_id: sid, pool: "A", ts: 1000, action: "MASUK", taken: 1, payload: JSON.stringify({ final_score: 85, confidence: 0.8, regime_label: "sideways", top_reasons: ["r"] }) });
  return { db, sid };
}

describe("analytics (blueprint 18.1)", () => {
  it("signal vs baseline compares cohort by cohort", () => {
    const { db, sid } = fixture();
    const c = signalVsBaseline(db, [sid]);
    expect(c.cohorts).toHaveLength(2);
    expect(c.cohorts[0].baseline.net).toBeCloseTo(0); // (1 + -1) / 2
    expect(c.overall.signal_enter.net).toBeCloseTo(1);
    expect(c.overall.signal_enter.diff).toBeCloseTo(1);
    expect(c.overall.signal_enter.betterCohorts).toBe(1);
    expect(c.overall.signal_enter.cohortsWithEntries).toBe(1);
  });

  it("score calibration buckets baseline positions and checks monotonicity", () => {
    const { db, sid } = fixture();
    const cal = scoreCalibration(db, [sid]);
    const b = Object.fromEntries(cal.buckets.map((x) => [x.bucket, x]));
    expect(b["<60"].n).toBe(50);
    expect(b["60-70"].net).toBeCloseTo(0.5);
    expect(b["80-90"].net).toBeCloseTo(1);
    expect(cal.monotonic).toBe(true);
  });
});

describe("reports", () => {
  it("session report contains every section-18 block, in Markdown, HTML, CSV and JSON", () => {
    const { db, sid } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "dlmm-r6-"));
    try {
      const r = writeSessionReport(db, sid, dir);
      const md = readFileSync(r.markdown, "utf8");
      for (const s of [
        "## Summary", "## Signals", "## Signal vs baseline", "## Score calibration", "## Fee reconciliation", "## Data health",
        "### entry mode", "### strategy", "### sides", "### exit policy", "### pool category", "### regime at entry", "### entry hour (WIB)",
        "fee/IL", "max DD", "Top 10 / bottom 10", "not statistically significant", "limitations",
      ]) expect(md).toContain(s);
      const html = readFileSync(r.html, "utf8");
      expect(html).toContain("<table>");
      expect(html).toContain("<h2>Signal vs baseline");
      const json = JSON.parse(readFileSync(r.metricsJson, "utf8"));
      expect(json.signalVsBaseline.overall.signal_enter.diff).toBeCloseTo(1);
      expect(readFileSync(r.positionsCsv, "utf8").trim().split("\n")).toHaveLength(1 + 125);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cross-session analysis keeps holdout sessions apart", () => {
    const { db, sid } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "dlmm-a6-"));
    try {
      const picked = pickSessions(db, {});
      expect(picked.map((p) => p.session_id)).toEqual([sid]);
      const r = analyzeSessions(db, picked, 1, dir);
      expect(r.text).toContain("Holdout sessions");
      expect(r.text).not.toContain("## Selection sessions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("markdown to html handles tables, lists, quotes and escapes html", () => {
    const h = markdownToHtml("# T\n\n| a | b |\n|---|--:|\n| <x> | **1** |\n\n- one\n- two\n\n> note", "t");
    expect(h).toContain("<h1>T</h1>");
    expect(h).toContain('<td style="text-align:right"><strong>1</strong></td>');
    expect(h).toContain("&lt;x&gt;");
    expect(h).toContain("<li>two</li>");
    expect(h).toContain("<blockquote>note</blockquote>");
  });

  it("export streams a session table to CSV and JSONL", async () => {
    const { db, sid } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "dlmm-e6-"));
    try {
      const csv = await exportTable(db, "positions", sid, dir, "csv");
      expect(csv.rows).toBe(125);
      expect(readFileSync(csv.path, "utf8").split("\n")[0]).toContain("net_pnl_usd");
      const jl = await exportTable(db, "signals", sid, dir, "jsonl");
      expect(JSON.parse(readFileSync(jl.path, "utf8").trim()).signal_id).toBe("s1");
      await expect(exportTable(db, "nope", sid, dir, "csv")).rejects.toThrow(/unknown table/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dashboard", () => {
  it("renders from DB aggregates when there is no heartbeat, and uses the heartbeat when present", () => {
    const { db, sid } = fixture();
    const text = renderTerminal(sessionView(db, sid)!).replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("no heartbeat");
    expect(text).toContain("signal_enter");
    expect(text).toContain("MASUK");
    db.insert("session_heartbeat", {
      session_id: sid, ts: Date.now(), pid: 1,
      state: JSON.stringify({
        phase: "active", leftMin: 42, start: 0, warmupEnd: 1, stopNewAt: 2, end: 3, positions: { active: 7, pending: 0, closed: 1, failed: 0 },
        grid: { cohorts: 2, rebalances: 3 }, exitEngine: null, signalsTotal: 9,
        pnl: { byMode: { all_pools_baseline: { n: 8, active: 7, netUsd: 16, feeUsd: 8, ilUsd: -4, win: 4 } }, byStrategy: {}, byExit: {} },
        health: { credits: 123, swapCredits: 100, quotaPct: 0.01, budget: "ok", rpcRps: 3, swapRps: 5, wsConnected: true, wsReconnects: 0, txQueue: 0, swapsStored: 5, openGaps: [], httpCalls: 10, httpErrors: 0 },
      }),
    });
    const live = renderTerminal(sessionView(db, sid)!).replace(/\x1b\[[0-9;]*m/g, "");
    expect(live).toContain("phase active");
    expect(live).toContain("42 min");
    expect(live).toContain("credits this session 123");
    expect(live).toMatch(/all_pools_baseline\s+8\s+7/);
  });

  it("stop requests are stored for the running process to pick up", () => {
    const { db, sid } = fixture();
    db.insert("session_control", { session_id: sid, action: "stop", requested_at: 1 });
    const r = db.get<{ n: number }>("SELECT COUNT(*) n FROM session_control WHERE handled_at IS NULL")!;
    expect(r.n).toBe(1);
  });
});
