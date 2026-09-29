import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import { createSession, registerConfigVersion } from "../src/db/repo.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { retaintSession } from "../src/sim/retaint.ts";
import { gapTaint, type GapTaintConfig } from "../src/sim/taint.ts";
import { realismSummary } from "../src/analysis/realism.ts";
import { errText } from "../src/util/async.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const MIN = 60_000;
const P: GapTaintConfig = { mode: "proportional", max_fraction: 0.25, max_single_gap_minutes: 5 };
const cfg = (): Config => structuredClone(loadConfig().config);

describe("gap taint rule", () => {
  const life = { from: 0, to: 60 * MIN };
  it("no gap -> clean", () => {
    expect(gapTaint([], [0, 60 * MIN], life.from, life.to, P).tainted).toBe(false);
  });
  it("a short gap in the middle does not taint (value depends on the current bin, fees are gap-proof)", () => {
    const v = gapTaint([{ source: "pool_state", start: 20 * MIN, end: 22 * MIN }], [0, 60 * MIN], life.from, life.to, P);
    expect(v.tainted).toBe(false);
    expect(v.gapMs).toBe(2 * MIN);
    expect(v.fraction).toBeCloseTo(2 / 60, 9);
  });
  it("an action while data is stale taints (open, rebalance, exit ...)", () => {
    const g = [{ source: "pool_state", start: 29 * MIN, end: 31 * MIN }];
    expect(gapTaint(g, [0, 30 * MIN, 60 * MIN], life.from, life.to, P).reason).toBe("action_during_gap");
    // gap still open at the close: the close happened on stale data
    expect(gapTaint([{ source: "pool_state", start: 59 * MIN, end: null }], [0, 60 * MIN], life.from, life.to, P).reason).toBe("action_during_gap");
    // an action at the gap's end used the fresh data that closed it
    expect(gapTaint(g, [0, 31 * MIN, 60 * MIN], life.from, life.to, P).tainted).toBe(false);
    // bin_snapshot gaps do not make the price stale
    expect(gapTaint([{ source: "bin_snapshot", start: 59 * MIN, end: null }], [0, 60 * MIN], life.from, life.to, P).tainted).toBe(false);
  });
  it("a long single gap or a large share of the life without data taints", () => {
    expect(gapTaint([{ source: "pool_state", start: 10 * MIN, end: 16 * MIN }], [0, 60 * MIN], life.from, life.to, P).reason).toBe("long_gap");
    const many = [10, 20, 30, 40].map((m) => ({ source: "pool_state", start: m * MIN, end: (m + 4.5) * MIN }));
    const v = gapTaint(many, [0, 60 * MIN], life.from, life.to, P);
    expect(v.reason).toBe("gap_fraction");
    expect(v.fraction).toBeCloseTo(18 / 60, 9);
  });
  it("overlapping gaps of two sources are counted once (union)", () => {
    const v = gapTaint(
      [{ source: "pool_state", start: 10 * MIN, end: 13 * MIN }, { source: "bin_snapshot", start: 12 * MIN, end: 14 * MIN }],
      [0, 60 * MIN], life.from, life.to, P,
    );
    expect(v.gapMs).toBe(4 * MIN);
    expect(v.maxGapMs).toBe(3 * MIN);
  });
  it("any_overlap mode keeps the old rule", () => {
    expect(gapTaint([{ source: "pool_state", start: 20 * MIN, end: 20 * MIN + 1000 }], [], life.from, life.to, { ...P, mode: "any_overlap" }).tainted).toBe(true);
  });
});

// ---------------------------------------------------------------- simulator integration
const META: PoolMeta = {
  pool: "POOL", name: "T-USD", tokenX: "T", tokenY: "USD", symbolX: "T", symbolY: "USD", decimalsX: 6, decimalsY: 6,
  binStep: 100, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep: 100, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt: null,
};
const state = (ts: number, activeId: number): PoolStateUpdate => ({
  pool: "POOL", ts, slot: ts, activeId, priceUi: binUiPrice(activeId, 100, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: 0.01, feeRateLp: 0.0095,
});
const snapshot = (ts: number, activeId: number): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  for (let id = activeId - 20; id <= activeId + 20; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= activeId ? 1_000_000_000n : 0n;
    const y = id <= activeId ? 1_000_000_000n : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: 0n, feeY: 0n, priceRaw: P });
  }
  return { pool: "POOL", ts, slot: ts, activeId, lower: activeId - 20, upper: activeId + 20, missingBinArrays: [], bins };
};

describe("simulator applies the proportional taint", () => {
  const open = () => {
    const c = cfg();
    const sim = new PoolSimulator(META, c, new MemorySink(), () => "p1");
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
    sim.onState(state(0, 0));
    sim.onBins(snapshot(0, 0));
    const p = sim.request({ strategy: "spot", sides: "two_sided", binsBelow: 2, binsAbove: 2, capitalUsd: 1000, entryMode: "t", combo: {} }, 0);
    sim.onState(state(5000, 0));
    return { sim, p };
  };
  it("a 1-minute gap in a 60-minute position leaves it clean; closing during a gap taints it", () => {
    const a = open();
    a.sim.onGap({ source: "pool_state", start: 20 * MIN, end: null });
    a.sim.onGap({ source: "pool_state", start: 20 * MIN, end: 21 * MIN });
    a.sim.onState(state(60 * MIN, 0));
    a.sim.close(a.p.id, "session_end", 60 * MIN);
    expect(a.p.gapTainted).toBe(false);
    expect(a.p.taint?.gapMs).toBe(MIN);

    const b = open();
    b.sim.onState(state(40 * MIN, 0));
    b.sim.onGap({ source: "pool_state", start: 39 * MIN, end: null });
    b.sim.close(b.p.id, "session_end", 40 * MIN);
    expect(b.p.gapTainted).toBe(true);
    expect(b.p.taint?.reason).toBe("action_during_gap");
  });
});

describe("actions wait for fresh price data", () => {
  it("an out-of-range exit due during a pool_state gap happens on the first fresh update", async () => {
    const { GridRunner, SessionClock } = await import("../src/sim/gridRunner.ts");
    const c = cfg();
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [2];
    c.grid.sides = ["two_sided"];
    c.grid.exit_policies = [{ type: "exit_out_of_range", minutes: 1 }];
    c.grid.variants = ["none"];
    c.grid.entry_modes = ["all_pools_baseline"];
    c.grid.sampling.mode = "full";
    const sim = new PoolSimulator(META, c, new MemorySink(), () => "p1");
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
    const runner = new GridRunner(c, new Map([["POOL", sim]]), new SessionClock(0, { durationMinutes: 60, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }));
    const step = (ts: number, a: number) => {
      sim.onBins(snapshot(ts, a));
      sim.onState(state(ts, a));
      runner.onPoolState("POOL", ts);
      runner.onTick(ts);
    };
    step(0, 0);
    step(MIN, 0);
    step(MIN + 5000, 0);
    const p = sim.list()[0];
    step(2 * MIN, 10); // out of range
    sim.onGap({ source: "pool_state", start: 2 * MIN + 10_000, end: null }); // network drops
    runner.onPoolState("POOL", 4 * MIN); // exit due, but the price is stale
    runner.onTick(4 * MIN);
    expect(p.status).toBe("active");
    sim.onGap({ source: "pool_state", start: 2 * MIN + 10_000, end: 5 * MIN });
    step(5 * MIN, 10); // fresh data
    expect(p.closeReason).toBe("exit_out_of_range");
    expect(p.closedAt).toBe(5 * MIN);
    expect(p.gapTainted).toBe(false);
  });
});

describe("cohort entries wait for fresh price data", () => {
  it("a cohort due during an outage opens on the first fresh update, with its cohort number", async () => {
    const { GridRunner, SessionClock } = await import("../src/sim/gridRunner.ts");
    const c = cfg();
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [2];
    c.grid.sides = ["two_sided"];
    c.grid.exit_policies = [{ type: "hold_to_session_end" }];
    c.grid.variants = ["none"];
    c.grid.entry_modes = ["all_pools_baseline"];
    c.grid.sampling.mode = "full";
    const sim = new PoolSimulator(META, c, new MemorySink(), () => `p${Math.random()}`);
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
    const runner = new GridRunner(c, new Map([["POOL", sim]]), new SessionClock(0, { durationMinutes: 60, warmupMinutes: 10, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 30 }));
    sim.onBins(snapshot(0, 0));
    sim.onState(state(0, 0));
    sim.onGap({ source: "pool_state", start: 9 * MIN, end: 12 * MIN });
    runner.onTick(10 * MIN); // cohort 1 due, price stale
    runner.onTick(11 * MIN);
    expect(sim.list()).toHaveLength(0);
    sim.onState(state(12 * MIN, 0));
    runner.onTick(12 * MIN); // fresh again
    expect(sim.list()).toHaveLength(1);
    expect(sim.list()[0].spec.combo.cohort).toBe(1);
    expect(runner.stats.cohorts).toBe(1);
  });
});

describe("retaint a stored session", () => {
  it("re-evaluates gap_tainted from the journal and data_gaps", () => {
    const db = new Db(":memory:");
    migrate(db);
    const cv = registerConfigVersion(db, loadConfig());
    const sid = createSession(db, { kind: "session", configVersion: cv, label: "t" });
    const pos = (id: string, closed: number) => {
      db.insert("sim_positions", {
        position_id: id, session_id: sid, pool: "POOL", grid_combo: "{}", entry_mode: "all_pools_baseline", strategy: "spot", sides: "two_sided",
        bins_below: 2, bins_above: 2, capital_usd: 1000, requested_at: 0, opened_at: 0, closed_at: closed, config_version: cv, status: "closed", gap_tainted: 1,
      });
      db.insert("sim_results", { position_id: id, net_pnl_usd: 1, net_pnl_pct: 0.1, detail: JSON.stringify({ costs: [] }) });
      db.insert("sim_position_events", { position_id: id, ts: 0, type: "open", detail: "{}" });
      db.insert("sim_position_events", { position_id: id, ts: closed, type: "exit", detail: "{}" });
    };
    pos("long", 60 * MIN); // 1-min gap in the middle -> clean now
    pos("stale-exit", 30.5 * MIN); // closed inside the gap -> stays tainted
    db.insert("data_gaps", { session_id: sid, source: "pool_state", pool: null, start_at: 30 * MIN, end_at: 31 * MIN, cause: "stale" });
    const r = retaintSession(db, cfg(), sid);
    expect(r.before).toBe(2);
    expect(r.after).toBe(1);
    expect(r.reasons).toEqual({ action_during_gap: 1 });
    const t = db.all<{ position_id: string; gap_tainted: number; reason: string | null }>(
      "SELECT p.position_id, p.gap_tainted, json_extract(r.detail,'$.taintReason') reason FROM sim_positions p JOIN sim_results r USING(position_id) ORDER BY p.position_id",
    );
    expect(t).toEqual([
      { position_id: "long", gap_tainted: 0, reason: null },
      { position_id: "stale-exit", gap_tainted: 1, reason: "action_during_gap" },
    ]);
  });
});

describe("realism summary", () => {
  it("relative fee differences ignore immaterial real fees; the pp column does not blow up", () => {
    const db = new Db(":memory:");
    migrate(db);
    let i = 0;
    const add = (real: number, sim: number) =>
      db.insert("sim_realism_checks", {
        ts: 0, real_position: `r${++i}`, pool: "POOL", data_session_id: "S", status: "ok", spec: JSON.stringify({ capitalUsd: 1000, combo: { shape_known: true } }),
        real_fee_usd: real, sim_fee_usd: sim, fee_diff_pct: real > 0 ? ((sim - real) / real) * 100 : null, pnl_diff_pct: 0, pnl_after_costs_diff_pct: 0,
      });
    add(10, 11); // +10%
    add(5, 4.5); // -10%
    add(0.0001, 0.02); // +19,900%: immaterial
    const s = realismSummary(db, undefined, true);
    expect(s.n).toBe(3);
    expect(s.feeMaterialN).toBe(2);
    expect(s.feeDiffMeanAbsPct).toBeCloseTo(10, 6);
    expect(s.feeDiffMeanAbsPp!).toBeLessThan(0.1);
  });
});

describe("network error text", () => {
  it("appends the cause code hidden behind 'fetch failed'", () => {
    const e = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }) });
    expect(errText(e)).toBe("fetch failed (ENOTFOUND)");
    expect(errText(new Error("HTTP 429"))).toBe("HTTP 429");
  });
});
