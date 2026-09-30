import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { GridRunner, SessionClock } from "../src/sim/gridRunner.ts";
import { buildSignal, SignalBook, sizeFraction, type Signal } from "../src/signals/signalEngine.ts";
import { evaluateExit, type ExitInputs } from "../src/signals/exitEngine.ts";
import type { ScoreResult } from "../src/features/scorer.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const cfg = (): Config => structuredClone(loadConfig().config);
const META: PoolMeta = {
  pool: "POOL", name: "T-USD", tokenX: "T", tokenY: "USD", symbolX: "T", symbolY: "USD", decimalsX: 6, decimalsY: 6,
  binStep: 100, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep: 100, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt: null,
};
const state = (ts: number, activeId: number, pool = "POOL"): PoolStateUpdate => ({
  pool, ts, slot: ts, activeId, priceUi: binUiPrice(activeId, 100, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: 0.01, feeRateLp: 0.0095,
});
const snapshot = (ts: number, activeId: number, pool = "POOL"): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  for (let id = activeId - 60; id <= activeId + 60; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= activeId ? 1_000_000_000n : 0n;
    const y = id <= activeId ? 1_000_000_000n : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: 0n, feeY: 0n, priceRaw: P });
  }
  return { pool, ts, slot: ts, activeId, lower: activeId - 60, upper: activeId + 60, missingBinArrays: [], bins };
};

function score(pool: string, ts: number, action: "MASUK" | "PANTAU" | "LEWATI", o: Partial<ScoreResult> = {}): ScoreResult {
  return {
    pool, ts, category: "memecoin", features: new Map(), norm: new Map(),
    modules: { edge: 80, regime: 70, flow: null, attention: null, competition: 60, safety: 90 },
    gate: { passed: true, reasons: [], missingData: false }, context: { multiplier: 1, reasons: [] }, weights: { edge: 50, regime: 50 },
    baseScore: 80, finalScore: action === "MASUK" ? 80 : action === "PANTAU" ? 65 : 40, confidence: 0.8, regime: "sideways", action,
    edge: null, edgeCandidates: [],
    recommendation: { strategy: "spot", sides: "two_sided", bins_below: 2, bins_above: 2, price_min: 0.98, price_max: 1.02 },
    expectations: { net_return_per_hour_pct: 0.4, fee_il_ratio: 2, p_in_range: 0.7, horizon_minutes: 120 },
    topReasons: ["x"], risks: [], ...o,
  };
}

describe("signal engine", () => {
  it("builds the blueprint 11 structure incl. size fraction scaled by confidence", () => {
    const c = cfg();
    const s = buildSignal(score("P", 1_000, "MASUK"), { sessionId: "S", configVersion: "v", config: c, idGen: () => "id1" });
    expect(s).toMatchObject({
      signal_id: "id1", session_id: "S", config_version: "v", pool: "P", pool_category: "memecoin", action: "MASUK",
      safety_gate: { passed: true, reasons: [] }, context_multiplier: 1, final_score: 80, confidence: 0.8, regime_label: "sideways",
    });
    expect(s.recommendation).toMatchObject({ strategy: "spot", sides: "two_sided", bins_below: 2, bins_above: 2 });
    expect(s.recommendation!.size_fraction).toBeCloseTo(c.signals.size.base_fraction * 0.8);
    expect(s.expectations).toMatchObject({ horizon_minutes: 120, p_in_range: 0.7 });
    expect(sizeFraction("LEWATI", 1, c.signals.size)).toBe(0);
    expect(sizeFraction("PANTAU", 1, c.signals.size)).toBe(c.signals.size.watch_fraction);
    expect(sizeFraction("MASUK", 5, { base_fraction: 0.5, max_fraction: 0.1, watch_fraction: 0 })).toBe(0.1);
  });

  it("the book serves the latest signal only when fresh and never from the future", () => {
    const c = cfg();
    const b = new SignalBook(null, c, "S", "v");
    b.onScores([score("P", 60_000, "MASUK")]);
    expect(b.latestFor("P", 60_000)?.action).toBe("MASUK");
    expect(b.latestFor("P", 59_999)).toBeNull();
    expect(b.latestFor("P", 60_000 + c.signals.max_signal_age_seconds * 1000 + 1)).toBeNull();
  });
});

describe("exit engine rules (blueprint 15)", () => {
  const c = cfg().exit_engine;
  const sig = (o: Partial<Signal> = {}) => ({ safety_gate: { passed: true, reasons: [] }, regime_label: "sideways", ...o }) as Signal;
  const base: ExitInputs = {
    t: 0, ageMinutes: 60, signal: sig(), depthNow: 1000, depthMaxWindow: 1000, largestSellPctSupply: 0,
    feePctPerHourWindow: 1, feeUsd: 10, ilUsd: -1, xShare: 0.5,
  };
  it("holds when nothing triggers", () => expect(evaluateExit(base, c, 2).action).toBe("TAHAN"));
  it("gate failure exits first", () => {
    const d = evaluateExit({ ...base, signal: sig({ safety_gate: { passed: false, reasons: ["mint"] } }), ilUsd: -100 }, c, 2);
    expect(d).toMatchObject({ action: "KELUAR", reason: "gate_failed" });
  });
  it("whale sell > 2% of supply", () => expect(evaluateExit({ ...base, largestSellPctSupply: 2.5 }, c, 2).reason).toBe("whale_sell"));
  it("LP withdrawal > 30% -> partial exit", () => {
    const d = evaluateExit({ ...base, depthNow: 600, depthMaxWindow: 1000 }, c, 2);
    expect(d).toMatchObject({ action: "KELUAR_SEBAGIAN", reason: "lp_withdrawal", fraction: c.partial_fraction });
    expect(evaluateExit({ ...base, depthNow: 800, depthMaxWindow: 1000 }, c, 2).action).toBe("TAHAN");
  });
  it("trending down while holding X", () => {
    expect(evaluateExit({ ...base, signal: sig({ regime_label: "trending_down" }) }, c, 2).reason).toBe("regime_against");
    expect(evaluateExit({ ...base, signal: sig({ regime_label: "trending_down" }), xShare: 0.05 }, c, 2).action).toBe("TAHAN");
  });
  it("IL > fee x 1.5 and low fee rate, only after the minimum age", () => {
    expect(evaluateExit({ ...base, ilUsd: -16, feeUsd: 10 }, c, 2).reason).toBe("il_exceeds_fee");
    expect(evaluateExit({ ...base, ilUsd: -14, feeUsd: 10 }, c, 2).action).toBe("TAHAN");
    expect(evaluateExit({ ...base, ilUsd: -16, feeUsd: 10, ageMinutes: 5 }, c, 2).action).toBe("TAHAN");
    expect(evaluateExit({ ...base, feePctPerHourWindow: 0.001 }, c, 2).reason).toBe("low_fee_rate");
  });
});

describe("partial exit and rebalance accounting", () => {
  it("value is conserved through partial exit + rebalance (withdrawn cash is not redeployed)", () => {
    const c = cfg();
    c.simulation.costs.slippage_margin_pct = 0;
    const sink = new MemorySink();
    const sim = new PoolSimulator(META, c, sink, () => "p1");
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
    sim.onState(state(0, 0));
    sim.onBins(snapshot(0, 0));
    const p = sim.request({ strategy: "spot", sides: "two_sided", binsBelow: 5, binsAbove: 5, capitalUsd: 1000, entryMode: "t", combo: {} }, 0);
    sim.onState(state(3000, 0));
    const v0 = sim.valuation(p).valueUsd;
    expect(sim.partialClose(p.id, 0.5, "test", 4000)).toBe(true);
    const v1 = sim.valuation(p).valueUsd;
    expect(v1).toBeCloseTo(v0, 6); // cash + remaining liquidity
    expect(p.realizedQuote).toBeCloseTo(v0 / 2, 3);
    sim.onState(state(5000, 20)); // leave the range
    const v2 = sim.valuation(p).valueUsd;
    sim.rebalance(p.id, "test", 6000);
    const v3 = sim.valuation(p).valueUsd;
    expect(v3).toBeCloseTo(v2, 3);
    expect(p.realizedQuote).toBeCloseTo(v0 / 2, 3); // unchanged by the rebalance
    const reb = sink.events.find((e) => e.type === "rebalance")!;
    expect(reb.detail.redeployedUsd as number).toBeCloseTo(v2 - p.realizedQuote, 3);
  });
});

describe("grid runner with signals", () => {
  const setup = (actions: Record<string, "MASUK" | "PANTAU" | "LEWATI">) => {
    const c = cfg();
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [2];
    c.grid.range_pct = [];
    c.grid.sides = ["two_sided"];
    c.grid.exit_policies = [{ type: "hold_to_session_end" }, { type: "exit_engine", minutes: 1, max_rebalances: 2 }];
    c.grid.variants = ["none"];
    c.grid.sampling.mode = "full";
    const sims = new Map<string, PoolSimulator>();
    let n = 0;
    for (const pool of Object.keys(actions)) {
      const s = new PoolSimulator({ ...META, pool }, c, new MemorySink(), () => `${pool}-${++n}`);
      s.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
      s.onState(state(0, 0, pool));
      s.onBins(snapshot(0, 0, pool));
      sims.set(pool, s);
    }
    const book = new SignalBook(null, c, "S", "v");
    let expectedFee: number | null = 1000;
    const runner = new GridRunner(c, sims, new SessionClock(0, { durationMinutes: 60, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }), undefined, {
      book, expectedFeeUsd: () => expectedFee,
    });
    book.onScores(Object.entries(actions).map(([pool, a]) => score(pool, 59_000, a)));
    return { c, sims, runner, setFee: (v: number | null) => (expectedFee = v) };
  };

  it("baseline enters every pool, signal modes only matching pools, at the same moment", () => {
    const { sims, runner } = setup({ A: "MASUK", B: "PANTAU", C: "LEWATI" });
    runner.onTick(60_000);
    const pos = [...sims.values()].flatMap((s) => s.list());
    const by = (mode: string) => pos.filter((p) => p.spec.entryMode === mode);
    expect(new Set(by("all_pools_baseline").map((p) => p.pool))).toEqual(new Set(["A", "B", "C"]));
    expect(new Set(by("signal_enter").map((p) => p.pool))).toEqual(new Set(["A"]));
    expect(new Set(by("signal_watch").map((p) => p.pool))).toEqual(new Set(["B"]));
    expect(new Set(pos.map((p) => p.requestedAt))).toEqual(new Set([60_000]));
    // every position records the pool's signal at entry, and whether it matches the recommendation
    const a = by("signal_enter")[0];
    expect(a.spec.signalId).toBeTruthy();
    expect(a.spec.combo.signal_action).toBe("MASUK");
    expect(a.spec.combo.matches_recommendation).toBe(true);
    expect(by("all_pools_baseline").find((p) => p.pool === "C")!.spec.combo.signal_action).toBe("LEWATI");
    // the test session is shorter than grid.cooldown_min_session_minutes: no cooldown dimension
    expect(runner.stats.signalEntries).toEqual({ signal_enter: 2, signal_watch: 2 });
  });

  it("exit_engine positions skip a rebalance that costs more than the expected fee", () => {
    const { sims, runner, setFee } = setup({ A: "MASUK" });
    runner.onTick(60_000);
    const s = sims.get("A")!;
    s.onState(state(63_000, 0, "A"));
    const ee = s.list().filter((p) => p.spec.exitPolicy?.type === "exit_engine");
    expect(ee.every((p) => p.status === "active")).toBe(true);
    setFee(0);
    s.onState(state(70_000, 30, "A")); // out of range
    runner.onPoolState("A", 70_000);
    s.onState(state(131_000, 30, "A")); // > 1 min
    runner.onPoolState("A", 131_000);
    expect(ee.every((p) => p.status === "closed" && p.closeReason === "exit_engine:rebalance_not_worth")).toBe(true);
    expect(runner.stats.rebalanceNotWorth).toBe(ee.length);
    // hold positions are untouched
    expect(s.list().filter((p) => p.spec.exitPolicy?.type === "hold_to_session_end").every((p) => p.status === "active")).toBe(true);
  });

  it("rebalance_out_of_range gets the same gas-aware gate (prism-liquidity-agent), gated by simulation.gas_aware_rebalance", () => {
    const c = cfg();
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [2];
    c.grid.range_pct = [];
    c.grid.sides = ["two_sided"];
    c.grid.exit_policies = [{ type: "rebalance_out_of_range", minutes: 1, max_rebalances: 2 }];
    c.grid.variants = ["none"];
    c.grid.sampling.mode = "full";
    c.grid.entry_modes = ["all_pools_baseline"];
    const s = new PoolSimulator({ ...META, pool: "A" }, c, new MemorySink(), () => `A-${Math.random()}`);
    s.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
    s.onState(state(0, 0, "A"));
    s.onBins(snapshot(0, 0, "A"));
    let expectedFee: number | null = 1000; // huge: rebalancing is worth it at first
    const runner = new GridRunner(c, new Map([["A", s]]), new SessionClock(0, { durationMinutes: 60, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }), undefined, {
      book: new SignalBook(null, c, "S", "v"), expectedFeeUsd: () => expectedFee,
    });
    runner.onTick(60_000);
    s.onState(state(63_000, 0, "A")); // entry_delay_seconds: 3 -- opens in range at the request price
    const oor = s.list().filter((p) => p.spec.exitPolicy?.type === "rebalance_out_of_range");
    expect(oor.length).toBeGreaterThan(0);
    expectedFee = 0; // now not worth it
    s.onState(state(70_000, 30, "A")); // out of range
    runner.onPoolState("A", 70_000);
    s.onState(state(131_000, 30, "A")); // > 1 min out of range
    runner.onPoolState("A", 131_000);
    expect(oor.every((p) => p.status === "closed" && p.closeReason === "rebalance_out_of_range:rebalance_not_worth")).toBe(true);
    expect(runner.stats.rebalanceNotWorth).toBe(oor.length);
  });

  it("gas_aware_horizon_hours scales the expected fee: a longer horizon lets a rebalance through that 2 h would refuse", () => {
    const run = (horizonHours: number) => {
      const c = cfg();
      c.simulation.gas_aware_horizon_hours = horizonHours;
      c.grid.strategies = ["spot"];
      c.grid.bins_per_side = [2];
      c.grid.range_pct = [];
      c.grid.sides = ["two_sided"];
      c.grid.exit_policies = [{ type: "rebalance_out_of_range", minutes: 1, max_rebalances: 2 }];
      c.grid.variants = ["none"];
      c.grid.sampling.mode = "full";
      c.grid.entry_modes = ["all_pools_baseline"];
      const s = new PoolSimulator({ ...META, pool: "A" }, c, new MemorySink(), () => `A-${Math.random()}`);
      s.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
      s.onState(state(0, 0, "A"));
      s.onBins(snapshot(0, 0, "A"));
      let fee = 0;
      const runner = new GridRunner(c, new Map([["A", s]]), new SessionClock(0, { durationMinutes: 60, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }), undefined, {
        book: new SignalBook(null, c, "S", "v"), expectedFeeUsd: () => fee,
      });
      runner.onTick(60_000);
      s.onState(state(63_000, 0, "A"));
      const oor = s.list().filter((p) => p.spec.exitPolicy?.type === "rebalance_out_of_range");
      s.onState(state(70_000, 30, "A"));
      const cost = s.estimateRebalanceCostUsd(oor[0].id)!;
      expect(cost).toBeGreaterThan(0);
      // the fee over the 2 h edge horizon is two thirds of the cost: refused at 2 h, worth it at 4 h (x2)
      fee = (cost * 2) / 3;
      runner.onPoolState("A", 70_000);
      s.onState(state(131_000, 30, "A"));
      runner.onPoolState("A", 131_000);
      return { oor, runner };
    };
    const short = run(2);
    expect(short.oor.every((p) => p.status === "closed" && p.closeReason === "rebalance_out_of_range:rebalance_not_worth")).toBe(true);
    const long = run(4);
    expect(long.runner.stats.rebalanceNotWorth).toBe(0);
    expect(long.runner.stats.rebalances).toBe(long.oor.length);
  });

  it("the gas-aware gate is off when simulation.gas_aware_rebalance is false: it rebalances anyway", () => {
    const c = cfg();
    c.simulation.gas_aware_rebalance = false;
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [2];
    c.grid.range_pct = [];
    c.grid.sides = ["two_sided"];
    c.grid.exit_policies = [{ type: "rebalance_out_of_range", minutes: 1, max_rebalances: 2 }];
    c.grid.variants = ["none"];
    c.grid.sampling.mode = "full";
    c.grid.entry_modes = ["all_pools_baseline"];
    const s = new PoolSimulator({ ...META, pool: "A" }, c, new MemorySink(), () => `A-${Math.random()}`);
    s.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
    s.onState(state(0, 0, "A"));
    s.onBins(snapshot(0, 0, "A"));
    const runner = new GridRunner(c, new Map([["A", s]]), new SessionClock(0, { durationMinutes: 60, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }), undefined, {
      book: new SignalBook(null, c, "S", "v"), expectedFeeUsd: () => 0, // would fail the gate if it were checked
    });
    runner.onTick(60_000);
    s.onState(state(63_000, 0, "A")); // entry_delay_seconds: 3 -- opens in range at the request price
    const oor = s.list().filter((p) => p.spec.exitPolicy?.type === "rebalance_out_of_range");
    s.onState(state(70_000, 30, "A"));
    runner.onPoolState("A", 70_000);
    s.onState(state(131_000, 30, "A"));
    runner.onPoolState("A", 131_000);
    expect(oor.every((p) => p.status === "active")).toBe(true);
    expect(runner.stats.rebalanceNotWorth).toBe(0);
    expect(runner.stats.rebalances).toBe(oor.length);
  });
});

import { PoolTracker } from "../src/features/tracker.ts";

describe("live gap notices", () => {
  it("a close notice ends the tracker's open gap (scoring is unblocked again)", () => {
    const tr = new PoolTracker(META, 3_600_000, 5, 10);
    tr.onGap({ source: "pool_state", start: 1000, end: null });
    expect(tr.openGap("pool_state", 5000)).toBe(true);
    tr.onGap({ source: "pool_state", start: 1000, end: 4000 });
    expect(tr.openGap("pool_state", 5000)).toBe(false);
    expect(tr.gaps).toHaveLength(1);
  });
});
