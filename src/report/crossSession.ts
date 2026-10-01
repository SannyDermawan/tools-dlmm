import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Db } from "../db/index.ts";
import { calibrationMarkdown, scoreCalibration, signalVsBaseline, signalVsBaselineMarkdown } from "./analytics.ts";
import { markdownToHtml } from "./html.ts";

export interface SessionPick {
  session_id: string;
  kind: string;
  label: string | null;
  start_at: number;
  positions: number;
}

/** Simulation sessions (live or replay) with closed positions, oldest first. */
export function pickSessions(db: Db, o: { ids?: string[]; last?: number; label?: string; live?: boolean }): SessionPick[] {
  const rows = db.all<SessionPick>(
    `SELECT s.session_id, s.kind, s.label, s.start_at, COUNT(p.position_id) positions
     FROM sessions s JOIN sim_positions p ON p.session_id = s.session_id
     WHERE s.kind IN ('session', 'sim_replay') AND p.status = 'closed'
     GROUP BY s.session_id ORDER BY s.start_at`,
  );
  let out = rows;
  if (o.ids?.length) out = out.filter((r) => o.ids!.some((id) => r.session_id.startsWith(id)));
  if (o.label) out = out.filter((r) => (r.label ?? "").includes(o.label!));
  if (o.live) out = out.filter((r) => r.kind === "session"); // replays of the same data are not independent evidence
  if (o.last) out = out.slice(-o.last);
  return out;
}

const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(d));

/**
 * Cross-session analytics (blueprint 13.4 / 18): strategies are judged by consistency across
 * sessions, not by one good session. The last `holdout` sessions are reported separately and never
 * used for the "selection" tables.
 */
export function analyzeSessions(db: Db, sessions: SessionPick[], holdout: number, outDir = "reports") {
  const train = holdout > 0 ? sessions.slice(0, Math.max(0, sessions.length - holdout)) : sessions;
  const test = holdout > 0 ? sessions.slice(-holdout) : [];
  const ids = (s: SessionPick[]) => s.map((x) => x.session_id);
  const md: string[] = [];
  md.push(`# Cross-session analysis`);
  md.push("");
  md.push(`${sessions.length} sessions (${train.length} selection / ${test.length} holdout), generated ${new Date().toISOString()}.`);
  md.push("");
  md.push("| # | session | kind | label | start | closed positions | set |");
  md.push("|--:|---|---|---|---|--:|---|");
  sessions.forEach((s, i) =>
    md.push(`| ${i + 1} | \`${s.session_id.slice(0, 8)}\` | ${s.kind} | ${s.label ?? ""} | ${new Date(s.start_at).toISOString().slice(0, 16)} | ${s.positions} | ${test.includes(s) ? "holdout" : "selection"} |`),
  );
  md.push("");
  md.push("> Several replays of the same collected data are not independent evidence. Prefer live sessions on different days and hours (blueprint 14.2).");

  const section = (title: string, set: SessionPick[]) => {
    if (!set.length) return;
    md.push(`\n## ${title}\n`);
    md.push("### Signal vs baseline\n");
    md.push(signalVsBaselineMarkdown(signalVsBaseline(db, ids(set))));
    md.push("\n### Score calibration\n");
    md.push(calibrationMarkdown(scoreCalibration(db, ids(set))));
  };
  section("Selection sessions", train);
  section("Holdout sessions (never used to choose strategies or weights)", test);

  // consistency per grid dimension across the selection sessions
  if (train.length) {
    const ph = train.map(() => "?").join(",");
    md.push("\n## Consistency across selection sessions (baseline, clean positions)\n");
    for (const [title, expr] of [
      ["strategy", "p.strategy"],
      ["sides", "p.sides"],
      ["bins per side", "CAST(json_extract(p.grid_combo,'$.bins_per_side') AS TEXT)"],
      ["exit policy", "json_extract(p.grid_combo,'$.exit_policy')"],
      ["pool category", "(SELECT category FROM pools WHERE pool = p.pool)"],
      ["market cap at entry", "CASE WHEN json_extract(p.grid_combo,'$.mcap_usd') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.mcap_usd') < 500000 THEN '1) < $500k' WHEN json_extract(p.grid_combo,'$.mcap_usd') < 1000000 THEN '2) $500k-1M' WHEN json_extract(p.grid_combo,'$.mcap_usd') < 2000000 THEN '3) $1-2M' WHEN json_extract(p.grid_combo,'$.mcap_usd') < 5000000 THEN '4) $2-5M' WHEN json_extract(p.grid_combo,'$.mcap_usd') < 20000000 THEN '5) $5-20M' ELSE '6) >= $20M' END"],
      ["volume authenticity score at entry", "CASE WHEN json_extract(p.grid_combo,'$.volume_auth_score') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.volume_auth_score') >= 1 THEN '1.0 (clean)' WHEN json_extract(p.grid_combo,'$.volume_auth_score') >= 0.7 THEN '0.7-1.0' WHEN json_extract(p.grid_combo,'$.volume_auth_score') >= 0.4 THEN '0.4-0.7' ELSE '< 0.4 (suspicious)' END"],
      ["bin utilization at entry", "CASE WHEN json_extract(p.grid_combo,'$.bin_utilization') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.bin_utilization') >= 0.8 THEN '>= 80%' WHEN json_extract(p.grid_combo,'$.bin_utilization') >= 0.5 THEN '50-80%' WHEN json_extract(p.grid_combo,'$.bin_utilization') >= 0.3 THEN '30-50%' ELSE '< 30% (clumped)' END"],
      ["pool volatility at entry (Meteora API, 5m)", "CASE WHEN json_extract(p.grid_combo,'$.pd_volatility') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.pd_volatility') < 1 THEN '1) < 1' WHEN json_extract(p.grid_combo,'$.pd_volatility') < 3 THEN '2) 1-3' WHEN json_extract(p.grid_combo,'$.pd_volatility') < 8 THEN '3) 3-8' ELSE '4) >= 8 (Meridian ceiling)' END"],
      ["LP net deposits at entry (5m)", "CASE WHEN json_extract(p.grid_combo,'$.pd_net_deposits_usd') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.pd_net_deposits_usd') < -1000 THEN '1) net outflow > $1k' WHEN json_extract(p.grid_combo,'$.pd_net_deposits_usd') <= 1000 THEN '2) flat (+-$1k)' ELSE '3) net inflow > $1k' END"],
      ["critical token warning at entry", "CASE WHEN json_extract(p.grid_combo,'$.pd_critical_warning') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.pd_critical_warning') = 1 THEN 'critical warning' ELSE 'none' END"],
      ["smart LPs with an open position at entry", "CASE WHEN json_extract(p.grid_combo,'$.smart_lp_open') IS NULL THEN 'unknown (no real-LP data)' WHEN json_extract(p.grid_combo,'$.smart_lp_open') = 0 THEN 'none' WHEN json_extract(p.grid_combo,'$.smart_lp_open') < 3 THEN '1-2' ELSE '>= 3' END"],
      ["top-10 holders at entry", "CASE WHEN json_extract(p.grid_combo,'$.top10_pct') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.top10_pct') < 20 THEN '< 20%' WHEN json_extract(p.grid_combo,'$.top10_pct') < 40 THEN '20-40%' WHEN json_extract(p.grid_combo,'$.top10_pct') < 60 THEN '40-60%' ELSE '>= 60%' END"],
    ] as const) {
      const rows = db.all<{ k: string; sid: string; n: number; net: number }>(
        `SELECT ${expr} k, p.session_id sid, COUNT(*) n, AVG(r.net_pnl_pct) net
         FROM sim_positions p JOIN sim_results r USING(position_id)
         WHERE p.session_id IN (${ph}) AND p.entry_mode = 'all_pools_baseline' AND p.gap_tainted = 0 AND p.status = 'closed'
         GROUP BY k, sid`,
        ...ids(train),
      );
      const by = new Map<string, { n: number; nets: number[] }>();
      for (const r of rows) {
        const a = by.get(r.k) ?? { n: 0, nets: [] };
        a.n += r.n;
        a.nets.push(r.net);
        by.set(r.k, a);
      }
      md.push(`### ${title}\n`);
      md.push("| value | positions | sessions | mean of session avg net % | worst session | best session | sessions > 0 |");
      md.push("|---|--:|--:|--:|--:|--:|--:|");
      for (const [k, a] of [...by].sort((x, y) => avg(y[1].nets) - avg(x[1].nets))) {
        md.push(`| ${k} | ${a.n} | ${a.nets.length} | ${f(avg(a.nets))} | ${f(Math.min(...a.nets))} | ${f(Math.max(...a.nets))} | ${a.nets.filter((x) => x > 0).length}/${a.nets.length} |`);
      }
      md.push("");
    }
  }
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const mdPath = join(dir, `analysis-${stamp}.md`);
  const text = md.join("\n") + "\n";
  writeFileSync(mdPath, text);
  writeFileSync(mdPath.replace(/\.md$/, ".html"), markdownToHtml(text, "Cross-session analysis"));
  return { markdown: mdPath, text };
}

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
