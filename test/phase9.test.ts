import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { ConfigSchema, type Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import { createSession, registerConfigVersion } from "../src/db/repo.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { CostModel } from "../src/sim/costs.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { balancedSample, gridCombos, GridRunner, SessionClock } from "../src/sim/gridRunner.ts";
import { evaluateMeridian, loadMeridianPreset, meridianExitPolicy, type PresetInputs } from "../src/sim/meridian.ts";
import { expandExitPolicies, exitPolicyLabel, newTrailing, pnlDecision, trailingStep, type ScalarExitPolicy } from "../src/sim/policies.ts";
import type { PositionSpec } from "../src/sim/position.ts";
import { DbSimSink } from "../src/sim/store.ts";
import { SignalBook } from "../src/signals/signalEngine.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const cfg = (): Config => structuredClone(loadConfig().config);
const meta = (pool = "POOL", binStep = 100): PoolMeta => ({
  pool, name: "T-USD", tokenX: `T-${pool}`, tokenY: "USD", symbolX: "T", symbolY: "USD", decimalsX: 6, decimalsY: 6,
  binStep, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt: null,
});
const state = (ts: number, activeId: number, pool = "POOL"): PoolStateUpdate => ({
  pool, ts, slot: ts, activeId, priceUi: binUiPrice(activeId, 100, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: 0.01, feeRateLp: 0.0095,
});
/** Bin snapshot; `feePerL` is the cumulative fee_amount_y_per_token_stored (fee per unit of liquidity). */
const snapshot = (ts: number, activeId: number, feePerL = 0, pool = "POOL"): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  const feeY = (BigInt(Math.round(feePerL * 1e9)) * Q64) / 1_000_000_000n;
  for (let id = activeId - 80; id <= activeId + 80; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= activeId ? 1_000_000_000n : 0n;
    const y = id <= activeId ? 1_000_000_000n : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: 0n, feeY, priceRaw: P });
  }
  return { pool, ts, slot: ts, activeId, lower: activeId - 80, upper: activeId + 80, missingBinArrays: [], bins };
};
const spec = (c: Config, o: Partial<PositionSpec> = {}): PositionSpec => ({
  strategy: "spot", sides: "two_sided", binsBelow: 2, binsAbove: 2, capitalUsd: c.simulation.virtual_capital_usd,
  entryMode: "test", combo: {}, ...o,
});
const newSim = (c: Config, pool = "POOL") => {
  const sink = new MemorySink();
  let n = 0;
  const sim = new PoolSimulator(meta(pool), c, sink, () => `${pool}-${++n}`);
  sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 10_000 });
  return { sim, sink };
};
const MIN = 60_000;

describe("exit policies (addendum 2.1)", () => {
  it("expands list parameters; trailing trigger/drop are paired", () => {
    const e = expandExitPolicies(cfg().grid.exit_policies);
    const labels = e.map(exitPolicyLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(e.filter((x) => x.type === "take_profit").map((x) => (x as { pct: number }).pct)).toEqual([3, 5, 10]);
    expect(e.filter((x) => x.type === "stop_loss")).toHaveLength(3);
    const tr = e.filter((x) => x.type === "trailing_tp") as Extract<ScalarExitPolicy, { type: "trailing_tp" }>[];
    expect(tr.map((x) => [x.trigger_pct, x.drop_pct])).toEqual([[2, 1], [3, 1.5], [5, 3]]);
    expect(tr[0].confirm_seconds).toBe(15);
  });

  it("take profit (net and fee basis), stop loss", () => {
    const x = { t: 0, netPct: 4, feePct: 1, ageMinutes: 10, feePctPerHourWindow: null };
    const tn = newTrailing();
    expect(pnlDecision({ type: "take_profit", pct: 3, basis: "net" }, x, tn).reason).toBe("take_profit");
    expect(pnlDecision({ type: "take_profit", pct: 3, basis: "fee" }, x, tn).reason).toBeNull();
    expect(pnlDecision({ type: "stop_loss", pct: 5 }, { ...x, netPct: -4.9 }, tn).reason).toBeNull();
    expect(pnlDecision({ type: "stop_loss", pct: 5 }, { ...x, netPct: -5 }, tn).reason).toBe("stop_loss");
  });

  it("low_yield_exit waits for the minimum age and a covered window", () => {
    const pol: ScalarExitPolicy = { type: "low_yield_exit", min_fee_pct_per_hour: 0.02, window_minutes: 30, min_age_minutes: 30 };
    const x = { t: 0, netPct: 0, feePct: 0, ageMinutes: 20, feePctPerHourWindow: 0.001 };
    expect(pnlDecision(pol, x, newTrailing()).reason).toBeNull();
    expect(pnlDecision(pol, { ...x, ageMinutes: 31, feePctPerHourWindow: null }, newTrailing()).reason).toBeNull();
    expect(pnlDecision(pol, { ...x, ageMinutes: 31 }, newTrailing()).reason).toBe("low_yield");
    expect(pnlDecision(pol, { ...x, ageMinutes: 31, feePctPerHourWindow: 0.05 }, newTrailing()).reason).toBeNull();
  });

  it("tp_sl_combo: stop loss first, fee-based take profit, trailing", () => {
    const pol: ScalarExitPolicy = { type: "tp_sl_combo", sl_pct: 15, tp_fee_pct: 5, trigger_pct: 3, drop_pct: 1.5, confirm_seconds: 15, tolerance_pct: 1 };
    const x = { t: 0, netPct: 0, feePct: 0, ageMinutes: 1, feePctPerHourWindow: null };
    expect(pnlDecision(pol, { ...x, netPct: -16, feePct: 6 }, newTrailing()).reason).toBe("stop_loss");
    expect(pnlDecision(pol, { ...x, feePct: 5 }, newTrailing()).reason).toBe("take_profit_fee");
    expect(pnlDecision(pol, { ...x, netPct: 3.2 }, newTrailing()).event).toBe("armed");
  });
});

describe("trailing take profit: two-stage confirmation", () => {
  const p = { trigger_pct: 3, drop_pct: 1.5, confirm_seconds: 15, tolerance_pct: 1 };
  const run = (seq: [number, number][]) => {
    let s = newTrailing();
    const out: { exit: boolean; event?: string; peak: number }[] = [];
    for (const [t, pnl] of seq) {
      const r = trailingStep(s, pnl, t * 1000, p);
      s = r.state;
      out.push({ exit: r.exit, event: r.event, peak: s.peak });
    }
    return out;
  };

  it("does nothing below the trigger", () => {
    expect(run([[0, 1], [30, 2.9], [60, 0]]).every((r) => !r.exit && !r.event)).toBe(true);
  });

  it("drop from the peak -> pending -> exit after the confirmation delay if it holds", () => {
    const r = run([[0, 3.5], [30, 1.9], [40, 1.9], [46, 1.95]]);
    expect(r[0].event).toBe("armed");
    expect(r[1].event).toBe("pending_trailing_exit");
    expect(r[2].exit).toBe(false); // 10 s < 15 s
    expect(r[3].exit).toBe(true); // drop 1.55 >= 1.5 x 0.99
    expect(r[3].event).toBe("trailing_exit");
  });

  it("cancels the pending exit when PnL recovers within the delay", () => {
    const r = run([[0, 3.5], [30, 1.9], [46, 3.0]]);
    expect(r[1].event).toBe("pending_trailing_exit");
    expect(r[2].exit).toBe(false);
    expect(r[2].event).toBe("trailing_exit_cancelled");
  });

  it("a short spike does not raise the peak; a held new high does", () => {
    // spike to 8 for 5 s, then back to 3.6: the peak stays 3.5, so 2.2 is not a 1.5 drop from 8
    const spike = run([[0, 3.5], [30, 8], [35, 3.6], [60, 3.6], [90, 2.2]]);
    expect(spike[4].peak).toBe(3.5);
    expect(spike[4].event).toBeUndefined();
    // a new high held for >= 15 s becomes the peak
    const held = run([[0, 3.5], [30, 6], [50, 6.1]]);
    expect(held[2].peak).toBe(6);
  });
});

describe("balanced grid sampling", () => {
  it("every level appears floor/ceil(n/k) times, deterministic by seed", () => {
    const sizes = [3, 7, 3, 16, 5];
    const a = balancedSample(sizes, 180, 42);
    expect(a.length).toBeGreaterThan(170);
    expect(a.length).toBeLessThanOrEqual(180);
    for (let d = 0; d < sizes.length; d++) {
      const counts = Array(sizes[d]).fill(0);
      for (const t of a) counts[t[d]]++;
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(Math.ceil(180 / sizes[d]) - Math.floor(180 / sizes[d]) + (180 - a.length));
    }
    expect(balancedSample(sizes, 180, 42)).toEqual(a);
    expect(balancedSample(sizes, 180, 7)).not.toEqual(a);
    expect(balancedSample([2, 3], 100, 1)).toHaveLength(6); // small grid: full
  });

  it("gridCombos: same sample for every entry mode, variants recorded, wide_range uses its own widths", () => {
    const c = cfg();
    const combos = gridCombos(c, { allowSignalModes: true });
    const modes = new Set(combos.map((x) => x.entryMode));
    expect(modes).toEqual(new Set(["all_pools_baseline", "signal_enter", "signal_watch"]));
    const key = (x: PositionSpec) => `${x.strategy}|${x.binsBelow}|${x.binsAbove}|${x.combo.exit_policy}|${x.variant}`;
    const base = combos.filter((x) => x.entryMode === "all_pools_baseline").map(key);
    expect(base.length).toBe(c.grid.sampling.baseline_max_combos);
    // signal modes use the whole sample; the baseline its first baseline_max_combos (a subset)
    for (const cd of c.grid.cooldown_enabled) {
      const sig = combos.filter((x) => x.entryMode === "signal_enter" && x.cooldownEnabled === cd).map(key);
      expect(sig.length).toBeLessThanOrEqual(c.grid.sampling.max_combos);
      expect(sig.slice(0, base.length)).toEqual(base);
    }
    expect(combos.filter((x) => x.entryMode === "all_pools_baseline").every((x) => x.cooldownEnabled === null)).toBe(true);
    const wide = combos.filter((x) => x.variant === "wide_range");
    expect(wide.length).toBeGreaterThan(0);
    // wide_range widths are price-% levels (resolved to bins per pool), or fixed bins when range_pct is empty
    expect(wide.every((x) => x.strategy === "spot" && [50, 70, 90].includes(x.combo.range_pct as number))).toBe(true);
    expect(new Set(combos.map((x) => x.variant))).toEqual(new Set(c.grid.variants));
  });

  it("config refuses wide_range widths beyond the position bin limit", () => {
    const c = cfg();
    c.grid.variant_params.wide_range.bins_per_side = [800];
    expect(ConfigSchema.safeParse(c).success).toBe(false);
  });
});

describe("costs: wide positions need several transactions", () => {
  it("tx count = ceil(bins / bins_per_tx), swaps always one", () => {
    const m = new CostModel(cfg().simulation.costs);
    expect(m.txCount("open", 70)).toBe(1);
    expect(m.txCount("open", 71)).toBe(2);
    expect(m.txCount("close", 301)).toBe(5);
    expect(m.txCount("swap", 301)).toBe(1);
    const ctx = { solUsd: 100, priorityMicroLamports: 10_000 };
    expect(m.txCost("open", ctx, 301).usd).toBeCloseTo(5 * m.txCost("open", ctx).usd, 10);
  });

  it("a 301-bin position pays 5 open transactions", () => {
    const c = cfg();
    const { sim, sink } = newSim(c);
    sim.onState(state(0, 0));
    sim.onBins(snapshot(0, 0));
    sim.request(spec(c, { binsBelow: 150, binsAbove: 150 }), 0);
    sim.onState(state(5000, 0));
    const open = sink.events.find((e) => e.type === "open")!;
    expect(open.detail.bins).toBe(301);
    const tx = (open.detail.costs as { type: string; usd: number }[]).find((x) => x.type === "tx_open")!;
    expect(tx.usd).toBeCloseTo(new CostModel(c.simulation.costs).txCost("open", { solUsd: 100, priorityMicroLamports: 10_000 }, 301).usd, 10);
  });
});

describe("strategy variants (addendum 2.2)", () => {
  const opened = (c: Config, o: Partial<PositionSpec> = {}) => {
    const s = newSim(c);
    s.sim.onState(state(0, 0));
    s.sim.onBins(snapshot(0, 0));
    const p = s.sim.request(spec(c, o), 0);
    s.sim.onState(state(5000, 0));
    return { ...s, p };
  };

  it("fee_compounding re-adds fees as liquidity: fees reset, PnL only changes by the extra costs", () => {
    const c = cfg();
    const { sim, sink, p } = opened(c);
    sim.onBins(snapshot(10_000, 0, 0)); // first snapshot inside the position's life
    sim.onBins(snapshot(60_000, 0, 0.01));
    sim.onState(state(61_000, 0));
    const before = sim.valuation(p);
    expect(before.feeUsd).toBeGreaterThan(1);
    const costsBefore = p.sunkCostUsd();
    const Lbefore = p.liquidityAt(0);
    expect(sim.compoundFees(p.id, 62_000)).toBe(true);
    const after = sim.valuation(p);
    const added = p.sunkCostUsd() - costsBefore;
    expect(added).toBeGreaterThan(0);
    expect(after.feeUsd).toBe(0);
    expect(p.compoundedFeeUsd).toBeCloseTo(before.feeUsd, 6);
    expect(p.liquidityAt(0)).toBeGreaterThan(Lbefore);
    expect(after.netPnlUsd).toBeCloseTo(before.netPnlUsd - added, 6);
    const types = (sink.events.find((e) => e.type === "compound")!.detail.costs as { type: string }[]).map((x) => x.type);
    expect(types).toEqual(expect.arrayContaining(["tx_claim", "tx_add"]));
    const r = sim.close(p.id, "test", 63_000)!;
    expect(r.feeUsd).toBeCloseTo(before.feeUsd, 6); // reported fee includes compounded fees
    expect(r.detail.compounds).toBe(1);
  });

  it("single_sided_reseed: price falls below the range (all base) -> base-only above the new active bin", () => {
    const c = cfg();
    const { sim, p } = opened(c);
    expect(sim.reseed(p.id, 10_000)).toBe(false); // still in range
    sim.onBins(snapshot(20_000, -10));
    sim.onState(state(20_000, -10));
    expect(p.inRange).toBe(false);
    expect(sim.reseed(p.id, 21_000)).toBe(true);
    expect(p.reseeds).toBe(1);
    expect(p.rebalanceCount).toBe(0);
    expect(p.lower).toBe(-10);
    expect(p.upper).toBe(-6); // same 5 bins
    const c2 = p.composition(-10, 1);
    expect(c2.y).toBeLessThan(1e-6 * c2.x);
    // price going up out of range: all quote now, not a reseed case
    sim.onState(state(30_000, 0));
    expect(sim.reseed(p.id, 31_000)).toBe(false);
  });

  it("GridRunner runs variants on the PnL clock: harvest once at +trigger, reseeds capped", () => {
    const c = cfg();
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [2];
    c.grid.range_pct = [];
    c.grid.sides = ["two_sided"];
    c.grid.exit_policies = [{ type: "hold_to_session_end" }];
    c.grid.variants = ["partial_harvest", "single_sided_reseed"];
    c.grid.variant_params.partial_harvest.trigger_return_pct = 1;
    c.grid.variant_params.single_sided_reseed.max_reseeds = 2;
    c.grid.entry_modes = ["all_pools_baseline"];
    const { sim } = newSim(c);
    const runner = new GridRunner(c, new Map([["POOL", sim]]), new SessionClock(0, { durationMinutes: 120, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }));
    const step = (ts: number, active: number, fee = 0) => {
      sim.onBins(snapshot(ts, active, fee));
      sim.onState(state(ts, active));
      runner.onPoolState("POOL", ts);
      runner.onTick(ts);
    };
    step(0, 0);
    step(MIN, 0);
    step(MIN + 5000, 0);
    const harvest = sim.list().find((x) => x.spec.variant === "partial_harvest")!;
    const reseed = sim.list().find((x) => x.spec.variant === "single_sided_reseed")!;
    // fees push the return above +1% -> harvest 50% once
    step(2 * MIN, 0, 0.02);
    step(3 * MIN, 0, 0.04);
    expect(harvest.partialExits).toBe(1);
    expect(runner.stats.variantActions.partial_harvest).toBe(1);
    // three drops below the range: only two reseeds
    let t = 4 * MIN;
    for (const a of [-10, -20, -30]) {
      step(t, a, 0.04);
      step(t + 31_000, a, 0.04);
      t += 2 * MIN;
    }
    expect(reseed.reseeds).toBe(2);
    expect(runner.stats.variantActions.single_sided_reseed).toBe(2);
    expect(reseed.status).toBe("active");
  });
});

describe("GridRunner PnL exit policies", () => {
  const setup = (policies: Config["grid"]["exit_policies"]) => {
    const c = cfg();
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [2];
    c.grid.range_pct = [];
    c.grid.sides = ["two_sided"];
    c.grid.exit_policies = policies;
    c.grid.variants = ["none"];
    c.grid.entry_modes = ["all_pools_baseline"];
    const { sim, sink } = newSim(c);
    const runner = new GridRunner(c, new Map([["POOL", sim]]), new SessionClock(0, { durationMinutes: 120, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }));
    const step = (ts: number, active: number, fee = 0) => {
      sim.onBins(snapshot(ts, active, fee));
      sim.onState(state(ts, active));
      runner.onPoolState("POOL", ts);
      runner.onTick(ts);
    };
    step(0, 0);
    step(MIN, 0);
    step(MIN + 5000, 0);
    return { c, sim, sink, runner, step, by: (label: string) => sim.list().find((p) => p.spec.combo.exit_policy === label)! };
  };

  it("stop loss closes on a crash; take profit (fee basis) on fees; evaluated on the pnl clock", () => {
    const { runner, step, by } = setup([
      { type: "stop_loss", pct: 5 },
      { type: "take_profit", pct: 3, basis: "fee" },
      { type: "hold_to_session_end" },
    ]);
    step(2 * MIN, 0, 0.05); // fees > 3% of capital
    expect(by("take_profit:3%:fee").closeReason).toBe("take_profit");
    step(3 * MIN, -30, 0.05); // -26% price: the two-sided position is all base now
    expect(by("stop_loss:5%").closeReason).toBe("stop_loss");
    expect(by("hold_to_session_end").status).toBe("active");
    expect(runner.stats.pnlExits).toEqual({ take_profit: 1, stop_loss: 1 });
  });

  it("trailing TP journals pending / exit in the position events", () => {
    const { sink, step, by } = setup([{ type: "trailing_tp", trigger_pct: [2], drop_pct: [1], confirm_seconds: 15, tolerance_pct: 1 }]);
    step(2 * MIN, 0, 0.05); // fees lift net PnL above +2%: armed
    step(3 * MIN, -30, 0.05); // crash: drop from the peak -> pending
    step(3 * MIN + 31_000, -30, 0.05); // still down after the delay -> exit
    const p = by("trailing_tp:2/1");
    expect(p.closeReason).toBe("trailing_tp");
    const sig = sink.events.filter((e) => e.positionId === p.id && e.type === "exit_signal").map((e) => e.detail.action);
    expect(sig).toEqual(["armed", "pending_trailing_exit", "trailing_exit"]);
  });

  it("low yield exit after the minimum age when fees stay below the threshold", () => {
    const { step, by } = setup([{ type: "low_yield_exit", min_fee_pct_per_hour: 0.02, window_minutes: 30, min_age_minutes: 30 }]);
    for (let t = 2 * MIN; t <= 30 * MIN; t += MIN) step(t, 0);
    expect(by("low_yield_exit:0.02%/h:30m").status).toBe("active");
    for (let t = 31 * MIN; t <= 33 * MIN; t += MIN) step(t, 0);
    expect(by("low_yield_exit:0.02%/h:30m").closeReason).toBe("low_yield");
  });
});

describe("Meridian preset (addendum 2.3)", () => {
  const preset = loadMeridianPreset("presets/meridian.yaml");
  const good: PresetInputs = {
    feeActiveTvlPct: 0.2, tvlUsd: 50_000, volumeUsd: 5_000, binStep: 100, organic: null, holders: 2_000,
    mcapUsd: 1_000_000, top10Pct: 30, botHoldersPct: null, bluechip: false,
    volatility: null, criticalWarning: null, priceChangePct: null, tokenFeesSol: null, binUtilization: null, bundlerPct: null,
  };

  it("loads the preset file; exit is one tp_sl_combo with the Meridian defaults", () => {
    expect(preset.exit.sl_pct).toBe(15);
    const e = meridianExitPolicy(preset);
    expect(e).toMatchObject({ type: "tp_sl_combo", sl_pct: 15, tp_fee_pct: 5, trigger_pct: 3, drop_pct: 1.5, oor_minutes: 30 });
  });

  it("pool filters must pass; missing token data -> partial; ranking formula", () => {
    const ev = evaluateMeridian(preset, good);
    expect(ev.pass).toBe(true);
    expect(ev.missing).toEqual(["organic", "bot_holders"]);
    expect(ev.score).toBeCloseTo(0.2 * 1000 + 5000 / 100 + 2000 / 100, 9);
    expect(evaluateMeridian(preset, { ...good, tvlUsd: 200_000 }).failed).toEqual(["tvl"]);
    expect(evaluateMeridian(preset, { ...good, binStep: 20 }).failed).toEqual(["bin_step"]);
    expect(evaluateMeridian(preset, { ...good, tvlUsd: null }).failed).toEqual(["tvl:missing"]);
    expect(evaluateMeridian(preset, { ...good, top10Pct: 70, mcapUsd: 50_000 }).failed).toEqual(["mcap", "top10"]);
    expect(evaluateMeridian(preset, { ...good, organic: 80, botHoldersPct: 10 }).missing).toEqual([]);
    expect(evaluateMeridian(preset, { ...good, holders: null, bluechip: true }).missing).toEqual([]);
  });

  it("the optional pool-quality filters (volatility, price change, token fees, bin utilization) are off by default", () => {
    // presets/meridian.yaml ships them as null; missing inputs on `good` (also null) still pass
    expect(preset.pool_filter.max_volatility).toBeNull();
    expect(evaluateMeridian(preset, good).failed).toEqual([]);
  });

  it("each optional filter fails closed on missing data once its preset value is set, and can pass or fail on real data", () => {
    const withVol = { ...preset, pool_filter: { ...preset.pool_filter, max_volatility: 5 } };
    expect(evaluateMeridian(withVol, good).failed).toEqual(["volatility:missing"]);
    expect(evaluateMeridian(withVol, { ...good, volatility: 3 }).failed).toEqual([]);
    expect(evaluateMeridian(withVol, { ...good, volatility: 9 }).failed).toEqual(["volatility"]);

    const withChange = { ...preset, pool_filter: { ...preset.pool_filter, max_price_change_pct: 50 } };
    expect(evaluateMeridian(withChange, { ...good, priceChangePct: -80 }).failed).toEqual(["price_change"]); // |change|, not raw
    expect(evaluateMeridian(withChange, { ...good, priceChangePct: 20 }).failed).toEqual([]);

    const withFees = { ...preset, pool_filter: { ...preset.pool_filter, min_token_fees_sol: 30 } };
    expect(evaluateMeridian(withFees, { ...good, tokenFeesSol: 10 }).failed).toEqual(["token_fees_sol"]);
    expect(evaluateMeridian(withFees, { ...good, tokenFeesSol: 30 }).failed).toEqual([]);

    const withWarn = { ...preset, pool_filter: { ...preset.pool_filter, block_critical_warnings: true } };
    expect(evaluateMeridian(withWarn, { ...good, criticalWarning: true }).failed).toEqual(["critical_warning"]);
    expect(evaluateMeridian(withWarn, { ...good, criticalWarning: false }).failed).toEqual([]);
    expect(evaluateMeridian(withWarn, good).failed).toEqual(["critical_warning:missing"]); // not collected: fail closed
    expect(evaluateMeridian(preset, { ...good, criticalWarning: true }).failed).toEqual([]); // off by default

    const withBundlers = { ...preset, token_filter: { ...preset.token_filter, max_bundlers_pct: 30 } };
    expect(evaluateMeridian(withBundlers, { ...good, bundlerPct: 45 }).failed).toEqual(["bundlers"]);
    expect(evaluateMeridian(withBundlers, { ...good, bundlerPct: 10 }).failed).toEqual([]);
    expect(evaluateMeridian(withBundlers, good).missing).toContain("bundlers"); // unknown -> preset_parsial, not a fail

    const withUtil = { ...preset, pool_filter: { ...preset.pool_filter, min_bin_utilization: 0.3 } };
    expect(evaluateMeridian(withUtil, { ...good, binUtilization: 0.2 }).failed).toEqual(["bin_utilization"]);
    expect(evaluateMeridian(withUtil, { ...good, binUtilization: 0.5 }).failed).toEqual([]);
  });

  it("GridRunner opens the preset position in the top-N passing pools, flagged preset_partial", () => {
    const c = cfg();
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [2];
    c.grid.range_pct = [];
    c.grid.sides = ["two_sided"];
    c.grid.exit_policies = [{ type: "hold_to_session_end" }];
    c.grid.variants = ["none"];
    c.grid.entry_modes = ["all_pools_baseline", "meridian_preset"];
    const inputs: Record<string, PresetInputs> = {
      A: { ...good, feeActiveTvlPct: 0.3 },
      B: { ...good, feeActiveTvlPct: 0.1 },
      C: { ...good, tvlUsd: 1_000 },
    };
    const sims = new Map<string, PoolSimulator>();
    for (const pool of Object.keys(inputs)) {
      const { sim } = newSim(c, pool);
      sim.onState(state(0, 0, pool));
      sim.onBins(snapshot(0, 0, 0, pool));
      sims.set(pool, sim);
    }
    const runner = new GridRunner(c, sims, new SessionClock(0, { durationMinutes: 60, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }), undefined, {
      book: new SignalBook(null, c, "S", "v"),
      preset: { ...preset, ranking: { top_n: 1 } },
      presetInputs: (pool) => inputs[pool],
      smartLp: (pool) => (pool === "A" ? { smart: 2, openPositions: 5 } : null),
      tokenInfo: () => ({ tokenAgeHours: 1, mcapUsd: 900_000.4, top10Pct: 23.04, holders: 5531, organic: 76.04, botHoldersPct: 31.44, bundlerPct: 0.64, pdTimeframe: "5m", pdVolatility: 4.2214, pdPriceChangePct: -5.836, pdNetDepositsUsd: 124_657.9, pdUniqueTraders: 363, pdSwapCount: 69, pdCriticalWarning: true,
        regime: { label: "MOMENTUM_DOWN", timeframe: "1h", trend: "down", volatility: "normal", liquidity: "expansion", liquidityPct: 3.21456, unstable: false },
        regime5m: { label: "UNSTABLE", timeframe: "5m", trend: "down", volatility: "normal", liquidity: null, liquidityPct: null, unstable: true },
        volumeAccel: 2.345, holdersChangePct: 1.234, feeActiveTvlPct: 0.01234 }),
    });
    runner.onTick(MIN);
    const mer = [...sims.values()].flatMap((s) => s.list()).filter((p) => p.spec.entryMode === "meridian_preset");
    expect(mer).toHaveLength(1);
    expect(mer[0].pool).toBe("A");
    expect(mer[0].spec).toMatchObject({ strategy: "bidask", sides: "quote_only", binsBelow: 69, binsAbove: 0 });
    expect(mer[0].spec.exitPolicy!.type).toBe("tp_sl_combo");
    expect(mer[0].spec.combo).toMatchObject({ preset_partial: true, preset_rank: 1 });
    expect(runner.stats.preset).toEqual({ evaluated: 3, passed: 2, opened: 1, partial: 1, failed: { tvl: 1 } });
    // token context at entry is journaled with every position (report buckets: market cap, top-10, ...)
    expect(mer[0].spec.combo).toMatchObject({ mcap_usd: 900_000, top10_pct: 23, holders: 5531, organic: 76, bot_holders_pct: 31.4, bundler_pct: 0.6, smart_lp_open: 2, lp_positions_open: 5 });
    expect(mer[0].spec.combo).toMatchObject({ pd_timeframe: "5m", pd_volatility: 4.221, pd_price_change_pct: -5.84, pd_net_deposits_usd: 124_658, pd_unique_traders: 363, pd_swap_count: 69, pd_critical_warning: 1 });
    // market regime at entry (roadmap PHASE 6)
    expect(mer[0].spec.combo).toMatchObject({
      regime: "MOMENTUM_DOWN", regime_tf: "1h", regime_trend: "down", regime_vol: "normal", regime_liquidity: "expansion", regime_liq_pct: 3.215,
      regime_5m: "UNSTABLE", volume_accel: 2.35, holders_change_pct: 1.23, fee_active_tvl_pct: 0.0123,
    });
    // baseline still enters every pool
    expect([...sims.values()].every((s) => s.list().some((p) => p.spec.entryMode === "all_pools_baseline"))).toBe(true);
  });

  it("tp_sl_combo exits after oor_minutes out of range", () => {
    const c = cfg();
    const { sim } = newSim(c);
    c.grid.entry_modes = ["all_pools_baseline"];
    c.grid.exit_policies = [{ type: "hold_to_session_end" }];
    c.grid.variants = ["none"];
    const runner = new GridRunner(c, new Map([["POOL", sim]]), new SessionClock(0, { durationMinutes: 120, warmupMinutes: 60, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }));
    sim.onState(state(0, 0));
    sim.onBins(snapshot(0, 0));
    const p = sim.request(spec(c, { strategy: "bidask", sides: "quote_only", binsBelow: 69, binsAbove: 0, exitPolicy: meridianExitPolicy(preset) }), 0);
    sim.onState(state(5000, 0));
    sim.onState(state(MIN, 5)); // price up: quote-only below the price is out of range
    runner.onPoolState("POOL", MIN);
    sim.onState(state(30 * MIN, 5));
    runner.onPoolState("POOL", 30 * MIN);
    expect(p.status).toBe("active");
    sim.onState(state(31 * MIN + 1, 5));
    runner.onPoolState("POOL", 31 * MIN + 1);
    expect(p.closeReason).toBe("exit_out_of_range");
  });
});

describe("journal: new grid columns (migration 006)", () => {
  it("sim_positions records exit policy params, strategy params and entry filter", () => {
    const c = cfg();
    const db = new Db(":memory:");
    migrate(db);
    const cv = registerConfigVersion(db, loadConfig());
    const sid = createSession(db, { kind: "sim_replay", configVersion: cv, label: "x" });
    const sink = new DbSimSink(db, sid, cv);
    const sim = new PoolSimulator(meta(), c, sink);
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
    sim.onState(state(0, 0));
    sim.onBins(snapshot(0, 0));
    sim.request(spec(c, { exitPolicy: { type: "stop_loss", pct: 5 }, variant: "partial_harvest", combo: { variant_params: { trigger_return_pct: 10, fraction: 0.5 } } }), 0);
    const r = db.get<{ exit_policy_params: string; strategy_params: string; entry_filter: string; cooldown_enabled: number | null }>(
      "SELECT exit_policy_params, strategy_params, entry_filter, cooldown_enabled FROM sim_positions",
    )!;
    expect(JSON.parse(r.exit_policy_params)).toEqual({ type: "stop_loss", pct: 5 });
    expect(JSON.parse(r.strategy_params)).toEqual({ variant: "partial_harvest", trigger_return_pct: 10, fraction: 0.5 });
    expect(r.entry_filter).toBe("none");
    expect(r.cooldown_enabled).toBeNull();
  });
});

describe("report: baseline vs Meridian preset vs signal", () => {
  it("groups and the pool-selection effect on identical baseline positions", async () => {
    const { groupComparison, groupComparisonMarkdown } = await import("../src/report/analytics.ts");
    const db = new Db(":memory:");
    migrate(db);
    const cv = registerConfigVersion(db, loadConfig());
    const sid = createSession(db, { kind: "sim_replay", configVersion: cv, label: "x" });
    let i = 0;
    const add = (pool: string, mode: string, net: number, extra: Record<string, unknown> = {}) => {
      const id = `p${++i}`;
      db.insert("sim_positions", {
        position_id: id, session_id: sid, pool, grid_combo: JSON.stringify({ cohort: 1, ...extra }), entry_mode: mode, strategy: "spot",
        sides: "two_sided", bins_below: 2, bins_above: 2, capital_usd: 1000, requested_at: 0, config_version: cv, status: "closed", gap_tainted: 0,
      });
      db.insert("sim_results", { position_id: id, fee_usd: 1, il_usd: 0, cost_usd: 0.5, net_pnl_usd: net * 10, net_pnl_pct: net });
    };
    add("A", "all_pools_baseline", 2);
    add("A", "all_pools_baseline", 4);
    add("B", "all_pools_baseline", -3);
    add("A", "meridian_preset", 1, { preset_partial: true });
    add("B", "signal_enter", -1);
    const g = groupComparison(db, [sid]);
    expect(g.groups.map((x) => x.group)).toEqual(["all_pools_baseline", "meridian_preset", "signal_enter"]);
    expect(g.groups[1].partial).toBe(1);
    const mer = g.selection.find((s) => s.selector === "meridian_preset")!;
    expect(mer).toMatchObject({ selectedN: 2, selectedNet: 3, allN: 3 });
    expect(mer.diff).toBeCloseTo(3 - 1, 9);
    expect(g.selection.find((s) => s.selector === "signal_enter")!.selectedNet).toBe(-3);
    expect(groupComparisonMarkdown(g)).toContain("preset_parsial");
  });
});
