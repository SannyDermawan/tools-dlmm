import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { Db, migrate } from "../src/db/index.ts";
import { registerConfigVersion } from "../src/db/repo.ts";
import {
  DEFAULT_PORTFOLIO, dayKey, loadCandidates, portfolioMarkdown, portfolioReportMarkdown, simulatePortfolio, type Candidate, type PortfolioOptions,
} from "../src/analysis/portfolio.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const D0 = Date.UTC(2026, 8, 29, 0, 0); // 07:00 WIB
const opts = (o: Partial<PortfolioOptions> = {}): PortfolioOptions => ({ ...DEFAULT_PORTFOLIO, sessionIds: ["S"], mode: "m", maxTradeUsd: null, ...o });
const cand = (id: string, openMin: number, durMin: number, pct: number, o: Partial<Candidate> = {}): Candidate => ({
  id, pool: "P", openedAt: D0 + openMin * MIN, closedAt: D0 + (openMin + durMin) * MIN, pct, score: null, ...o,
});

describe("sequential portfolio (stage 4)", () => {
  it("compounds: each trade uses the equity of the previous one", () => {
    const r = simulatePortfolio([cand("a", 0, 10, 10), cand("b", 20, 10, -5), cand("c", 40, 10, 20)], opts());
    expect(r.taken.map((t) => t.equityAfter)).toEqual([1100, 1100 * 0.95, 1100 * 0.95 * 1.2].map((x) => expect.closeTo(x, 9)));
    expect(r.finalEquity).toBeCloseTo(1100 * 0.95 * 1.2, 9);
    expect(r.totalReturnPct).toBeCloseTo(25.4, 9);
    expect(r.winRate).toBeCloseTo(2 / 3, 9);
    expect(r.longestLosingStreak).toBe(1);
    expect(r.maxDrawdownPct).toBeCloseTo(5, 9); // 1100 -> 1045
  });

  it("one position at a time: positions opening while busy are skipped; a busy trader takes the next free one", () => {
    const r = simulatePortfolio([cand("a", 0, 30, 5), cand("b", 10, 5, 50), cand("c", 29, 5, 50), cand("d", 40, 5, 1)], opts());
    expect(r.taken.map((t) => t.id)).toEqual(["a", "d"]);
    expect(r.skipped.busy).toBe(2);
  });

  it("one opportunity = candidates opening within the window; the pick rule chooses", () => {
    const group = [cand("a", 0, 10, 1, { score: 50 }), cand("b", 0.5, 10, 2, { score: 90 }), cand("c", 0.9, 10, 3, { score: 70 })];
    expect(simulatePortfolio(group, opts({ pick: "first" })).taken[0].id).toBe("a");
    expect(simulatePortfolio(group, opts({ pick: "score" })).taken[0].id).toBe("b");
    const r1 = simulatePortfolio(group, opts({ pick: "random", seed: 3 }));
    const r2 = simulatePortfolio(group, opts({ pick: "random", seed: 3 }));
    expect(r1.taken[0].id).toBe(r2.taken[0].id); // seeded: reproducible
    expect(r1.skipped.notPicked).toBe(2);
    expect(r1.candidatesPerOpportunity).toBe(3);
    // outside the window they are separate opportunities
    expect(simulatePortfolio([cand("a", 0, 1, 1), cand("b", 5, 1, 1)], opts()).taken).toHaveLength(2);
  });

  it("daily stop: after a realized loss of X% of the day's start equity no new trades that day; the next day starts again", () => {
    const cs = [cand("a", 0, 10, -6), cand("b", 60, 10, 30), cand("c", 24 * 60 + 60, 10, 10)]; // c: next day (WIB day boundary is 17:00 UTC)
    const on = simulatePortfolio(cs, opts({ dailyStopPct: 5 }));
    expect(on.taken.map((t) => t.id)).toEqual(["a", "c"]);
    expect(on.skipped.dailyStop).toBe(1);
    expect(on.days.find((d) => d.stopped)?.day).toBe("2026-09-29");
    const off = simulatePortfolio(cs, opts({ dailyStopPct: 0 }));
    expect(off.taken.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(on.finalEquity).toBeLessThan(off.finalEquity);
  });

  it("trade size: fraction of the equity and a USD cap (liquidity)", () => {
    const half = simulatePortfolio([cand("a", 0, 10, 10)], opts({ sizeFraction: 0.5 }));
    expect(half.taken[0].sizeUsd).toBe(500);
    expect(half.finalEquity).toBeCloseTo(1050, 9);
    const capped = simulatePortfolio([cand("a", 0, 10, 100), cand("b", 20, 10, 100), cand("c", 40, 10, 100)], opts({ maxTradeUsd: 1500 }));
    expect(capped.taken.map((t) => t.sizeUsd)).toEqual([1000, 1500, 1500]);
    expect(capped.finalEquity).toBeCloseTo(1000 + 1000 + 1500 + 1500, 9);
  });

  it("calendar days follow the day boundary in WIB or UTC, by close time; ruin stops the account", () => {
    expect(dayKey(Date.UTC(2026, 8, 29, 16, 59), "WIB")).toBe("2026-09-29");
    expect(dayKey(Date.UTC(2026, 8, 29, 17, 0), "WIB")).toBe("2026-09-30");
    expect(dayKey(Date.UTC(2026, 8, 29, 17, 0), "UTC")).toBe("2026-09-29");
    // a trade opened before midnight WIB and closed after it belongs to the next day
    const r = simulatePortfolio([cand("a", 16 * 60 + 50, 20, 10)], opts()); // 16:50 UTC -> 17:10 UTC
    expect(r.days.map((d) => [d.day, d.trades])).toEqual([["2026-09-30", 1]]);
    const ruin = simulatePortfolio([cand("a", 0, 5, -100), cand("b", 10, 5, 50)], opts());
    expect(ruin.finalEquity).toBe(0);
    expect(ruin.taken).toHaveLength(1);
    expect(ruin.skipped.ruin).toBe(1);
  });

  it("day returns are against the equity at the start of the day; profit factor, best / worst day", () => {
    const r = simulatePortfolio([cand("a", 0, 10, 10), cand("b", 24 * 60, 10, -10)], opts());
    expect(r.days).toHaveLength(2);
    expect(r.days[0].returnPct).toBeCloseTo(10, 9);
    expect(r.days[1].returnPct).toBeCloseTo(-10, 9); // -110 of 1100
    expect(r.profitFactor).toBeCloseTo(100 / 110, 9);
    expect(r.worstDay!.day).toBe(r.days[1].day);
    expect(r.maxDailyDrawdownPct).toBeCloseTo(10, 9);
    expect(r.positiveDayShare).toBe(0.5);
    expect(portfolioMarkdown(r)).toMatch(/final equity/);
  });
});

describe("candidates from the journal", () => {
  const setup = () => {
    const db = new Db(":memory:");
    migrate(db);
    const cv = registerConfigVersion(db, loadConfig());
    db.insert("sessions", { session_id: "S", kind: "session", start_at: 0, status: "completed", config_version: cv });
    db.insert("pools", { pool: "P", token_x: "T", token_y: "USD", decimals_x: 6, decimals_y: 6, bin_step: 100, category: "memecoin", first_seen_at: 0, last_checked_at: 0 });
    const add = (id: string, mode: string, combo: object, o: { tainted?: number; status?: string; pct?: number } = {}) => {
      db.insert("sim_positions", {
        position_id: id, session_id: "S", pool: "P", grid_combo: JSON.stringify(combo), entry_mode: mode, strategy: "spot", sides: "two_sided", bins_below: 1, bins_above: 1,
        capital_usd: 1000, requested_at: 0, opened_at: D0, closed_at: D0 + MIN, gap_tainted: o.tainted ?? 0, config_version: cv, status: o.status ?? "closed",
      });
      db.insert("sim_results", { position_id: id, net_pnl_pct: o.pct ?? 1, net_pnl_usd: 10 });
    };
    return { db, add };
  };
  it("filters by mode, grid_combo keys (= and prefix ~) and clean positions", () => {
    const { db, add } = setup();
    add("a", "friday_scalp", { exit_policy: "scalp:ts15m:oor0m", bins_per_side: 34, signal_score: 70 });
    add("b", "friday_scalp", { exit_policy: "hold_to_session_end", bins_per_side: 34 });
    add("c", "friday_scalp", { exit_policy: "scalp:ts5m", bins_per_side: 20 }, { tainted: 1 });
    add("d", "meridian_preset", { exit_policy: "scalp:x" });
    add("e", "friday_scalp", { exit_policy: "scalp:ts5m" }, { status: "failed" });
    const ids = (w: { key: string; op: "=" | "~"; value: string }[], clean = true) =>
      loadCandidates(db, { sessionIds: ["S"], mode: "friday_scalp", where: w, cleanOnly: clean }).map((x) => x.id).sort();
    expect(ids([])).toEqual(["a", "b"]);
    expect(ids([], false)).toEqual(["a", "b", "c"]);
    expect(ids([{ key: "exit_policy", op: "~", value: "scalp" }])).toEqual(["a"]);
    expect(ids([{ key: "bins_per_side", op: "=", value: "34" }])).toEqual(["a", "b"]);
    expect(ids([{ key: "bins_per_side", op: "=", value: "20" }], false)).toEqual(["c"]);
    expect(loadCandidates(db, { sessionIds: ["S"], mode: "friday_scalp", cleanOnly: true })[0].score).toBe(70);
    expect(() => loadCandidates(db, { sessionIds: ["S"], mode: "x", where: [{ key: "a; DROP TABLE x", op: "=", value: "1" }], cleanOnly: true })).toThrow(/bad filter key/);
  });
  it("session report section lists only modes with enough sequential trades", () => {
    const { db, add } = setup();
    const c = loadConfig().config.portfolio;
    expect(portfolioReportMarkdown(db, "S", c)).toMatch(/No mode with at least/);
    for (let i = 0; i < 6; i++) {
      db.insert("sim_positions", {
        position_id: `t${i}`, session_id: "S", pool: "P", grid_combo: "{}", entry_mode: "friday_scalp", strategy: "spot", sides: "two_sided", bins_below: 1, bins_above: 1,
        capital_usd: 1000, requested_at: 0, opened_at: D0 + i * 10 * MIN, closed_at: D0 + i * 10 * MIN + 5 * MIN, gap_tainted: 0, config_version: registerConfigVersion(db, loadConfig()), status: "closed",
      });
      db.insert("sim_results", { position_id: `t${i}`, net_pnl_pct: 1, net_pnl_usd: 10 });
    }
    void add;
    expect(portfolioReportMarkdown(db, "S", c)).toMatch(/### friday_scalp[\s\S]*trades taken/);
  });
});
