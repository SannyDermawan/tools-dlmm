import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { binsForRangePct } from "../src/sim/distribution.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { GridRunner, SessionClock } from "../src/sim/gridRunner.ts";
import { SignalBook } from "../src/signals/signalEngine.ts";
import { macdHistSeries, type Candle } from "../src/features/indicators.ts";
import { estimateCycleTransactions } from "../src/strategies/types.ts";
import { evaluateEvilPanda, evilPandaExitSignal, evilPandaModule, loadEvilPandaPreset, type EvilPandaInputs, type EvilPandaPreset } from "../src/strategies/evilPanda.ts";
import { loadRegistry } from "../src/registry/strategies.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const MIN = 60_000;
const cfg = () => structuredClone(loadConfig().config);

/** candles with closes `cs`, 5 minutes apart, high / low 0.5 % around the close */
const candles = (cs: number[]): Candle[] => cs.map((c, i) => ({ ts: i * 5 * MIN, o: c, h: c * 1.005, l: c * 0.995, c }));
const rising = (n = 80) => candles(Array.from({ length: n }, (_, i) => 100 * 1.01 ** i));
const falling = (n = 80) => candles(Array.from({ length: n }, (_, i) => 100 * 0.99 ** i));
/** flat, then a jump on the last candle: RSI(2) 100 and the close far above the upper band */
const spike = (n = 80) => candles([...Array.from({ length: n - 1 }, () => 100), 110]);
const flat = (n = 80) => candles(Array.from({ length: n }, () => 100));

describe("standard strategy interface (roadmap PHASE 3)", () => {
  it("transaction estimate of a cycle from the plan's shape", () => {
    const c = cfg();
    const two = estimateCycleTransactions(c, { sides: "two_sided", binsBelow: 34, binsAbove: 34, exitPolicy: { type: "time_stop", minutes: 15 } });
    expect(two).toMatchObject({ min: 3, max: 4, txPerOperation: 1 }); // open, balancing swap, close (+ exit swap)
    const quote = estimateCycleTransactions(c, { sides: "quote_only", binsBelow: 161, binsAbove: 0, exitPolicy: { type: "hold_to_session_end" } });
    expect(quote).toMatchObject({ min: 2, max: 3, txPerOperation: 3 }); // 162 bins at 70 per transaction
    const reb = estimateCycleTransactions(c, { sides: "quote_only", binsBelow: 10, binsAbove: 0, exitPolicy: { type: "rebalance_out_of_range", minutes: 5, max_rebalances: 3 } });
    expect(reb.max).toBe(3 + 6);
    const flip = estimateCycleTransactions(c, {
      sides: "quote_only", binsBelow: 70, binsAbove: 0, exitPolicy: { type: "hold_to_session_end" },
      flip: { shape: "bidask", blend: null, upPct: 100, maxFlips: 2 },
    });
    expect(flip.max).toBe(3 + 2);
  });

  it("every implemented external strategy of the registry runs as a module of the runner, in a fixed order", () => {
    const c = cfg();
    const runner = new GridRunner(c, new Map(), new SessionClock(0, { durationMinutes: 60, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }), undefined, {
      book: new SignalBook(null, c, "S", "v"),
    });
    expect(runner.modules.map((m) => m.entryMode)).toEqual(["meridian_preset", "friday_scalp", "yunus_flip", "evil_panda"]);
    const external = loadRegistry().strategies.filter((s) => s.kind === "external" && s.status === "implemented").map((s) => s.entry_mode);
    expect([...external].sort()).toEqual(runner.modules.map((m) => m.entryMode).sort());
    for (const m of runner.modules) expect(m.id).toBe(m.entryMode);
  });
});

describe("Evil Panda (Meridian fork) as entry mode evil_panda", () => {
  const preset = () => loadEvilPandaPreset("presets/evil_panda.yaml");
  const ok: EvilPandaInputs = {
    volume24hUsd: 1_000_000, mcapUsd: 5e6, riskIsBase: true, tokenFeesSol: 50, top10Pct: 30, supertrendCandles: rising(), meridianFailed: [],
  };

  it("screen: volume, market cap, base token, fees, top-10, green Supertrend, Meridian screen", () => {
    const p = preset();
    expect(evaluateEvilPanda(p, ok)).toEqual([]);
    expect(evaluateEvilPanda(p, { ...ok, volume24hUsd: 500_000 })).toEqual(["token_volume_24h"]);
    expect(evaluateEvilPanda(p, { ...ok, mcapUsd: 100_000 })).toEqual(["mcap"]);
    expect(evaluateEvilPanda(p, { ...ok, riskIsBase: false })).toEqual(["risk_token_not_base"]);
    expect(evaluateEvilPanda(p, { ...ok, tokenFeesSol: 10 })).toEqual(["token_fees"]);
    expect(evaluateEvilPanda(p, { ...ok, top10Pct: 70 })).toEqual(["top10"]);
    expect(evaluateEvilPanda(p, { ...ok, supertrendCandles: falling() })).toEqual(["supertrend_red"]);
    expect(evaluateEvilPanda(p, { ...ok, supertrendCandles: [] })).toEqual(["supertrend:no_data"]);
    expect(evaluateEvilPanda(p, { ...ok, meridianFailed: ["tvl"] })).toEqual(["meridian:tvl"]);
    expect(evaluateEvilPanda(p, { ...ok, meridianFailed: null })).toEqual(["meridian:no_data"]);
    expect(evaluateEvilPanda(p, { ...ok, volume24hUsd: null })).toEqual(["token_volume_24h:no_data"]);
    const lax: EvilPandaPreset = { ...p, screen: { ...p.screen, missing_data: "ignore" } };
    expect(evaluateEvilPanda(lax, { ...ok, volume24hUsd: null })).toEqual([]);
  });

  it("MACD histogram: warm-up, then it turns positive after a V", () => {
    const v = [...Array.from({ length: 40 }, (_, i) => 100 - i), ...Array.from({ length: 30 }, (_, i) => 61 + 2 * i)];
    const h = macdHistSeries(v, 12, 26, 9);
    expect(h.findIndex((x) => x !== null)).toBe(25 + 8);
    // a steady fall leaves the histogram at zero (line and signal agree); the turn makes it green at once
    expect(h[39]!).toBeCloseTo(0, 6);
    expect(h[40]!).toBeGreaterThan(0);
    expect(h[41]!).toBeGreaterThan(h[40]!);
  });

  it("exit confluence: RSI(2) > 90 with the close above the upper band; nothing on a flat chart or without candles", () => {
    const p = preset();
    expect(evilPandaExitSignal(p, spike())).toMatchObject({ fire: true, aboveBand: true });
    expect(evilPandaExitSignal(p, flat())!.fire).toBe(false);
    expect(evilPandaExitSignal(p, flat(10))).toBeNull();
  });

  it("the module exits only in profit and only on the confluence", () => {
    const c = cfg();
    let chart = spike();
    const m = evilPandaModule(preset(), null, { c, signals: { book: new SignalBook(null, c, "S", "v"), candles: () => chart } });
    const logged: unknown[] = [];
    const x = (netPct: number) => ({ sim: { meta: { pool: "P" }, logExitSignal: (_id: string, _t: number, d: unknown) => logged.push(d) } as never, p: { id: "x" } as never, ts: 0, netPct });
    expect(m.evaluateExit!(x(-0.5))).toBeNull();
    expect(m.evaluateExit!(x(0.5))).toBe("evil_panda_confluence");
    expect(logged).toHaveLength(1);
    chart = flat();
    expect(m.evaluateExit!(x(0.5))).toBeNull();
  });
});

// ---------------------------------------------------------------- in the grid runner
const META: PoolMeta = {
  pool: "POOL", name: "T-SOL", tokenX: "T", tokenY: "SOL", symbolX: "T", symbolY: "SOL", decimalsX: 6, decimalsY: 6,
  binStep: 100, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep: 100, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt: null,
};
const state = (ts: number, activeId: number): PoolStateUpdate => ({
  pool: "POOL", ts, slot: ts, activeId, priceUi: binUiPrice(activeId, 100, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: 0.01, feeRateLp: 0.0095,
});
const snapshot = (ts: number): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  for (let id = -240; id <= 240; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= 0 ? 1_000_000_000n : 0n;
    const y = id <= 0 ? 1_000_000_000n : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: 0n, feeY: 0n, priceRaw: P });
  }
  return { pool: "POOL", ts, slot: ts, activeId: 0, lower: -240, upper: 240, missingBinArrays: [], bins };
};

const runnerFor = (o: { chart: () => Candle[]; mut?: (p: EvilPandaPreset) => void }) => {
  const c = cfg();
  c.grid.entry_modes = ["evil_panda"];
  c.grid.max_positions = 1000;
  const preset = loadEvilPandaPreset("presets/evil_panda.yaml");
  preset.screen.meridian_screen = false;
  preset.exit.meridian_exits = false;
  o.mut?.(preset);
  let n = 0;
  const sim = new PoolSimulator(META, c, new MemorySink(), () => `P${++n}`);
  sim.onMarket({ quoteUsd: 100, solUsd: 100, priorityMicroLamports: 0 });
  sim.onState(state(0, 0));
  sim.onBins(snapshot(0));
  const runner = new GridRunner(
    c, new Map([["POOL", sim]]),
    new SessionClock(0, { durationMinutes: 6000, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }),
    undefined,
    {
      book: new SignalBook(null, c, "S", "v"), evilPanda: preset, candles: () => o.chart(),
      tokenInfo: () => ({ tokenAgeHours: 100, mcapUsd: 8e6, riskIsBase: true, volume24hUsd: 2e6, tokenFeesSol: 80, top10Pct: 25 }),
    },
  );
  return { c, sim, runner };
};

describe("evil_panda in the grid runner", () => {
  it("opens single-sided SOL Spot 80 % below the price when the screen passes; journals the plan", () => {
    const { sim, runner } = runnerFor({ chart: rising });
    runner.onTick(MIN);
    const ps = sim.list();
    expect(ps).toHaveLength(1);
    expect(ps[0].spec).toMatchObject({ entryMode: "evil_panda", strategy: "spot", sides: "quote_only", binsBelow: binsForRangePct(80, 100), binsAbove: 0 });
    expect(ps[0].spec.combo).toMatchObject({ entry_mode: "evil_panda", range_pct: 80, cycle_no: 1, reentry: false, at_cohort: true });
    expect(ps[0].spec.combo).toMatchObject({ tx_est_min: 2, tx_est_max: 3, tx_per_operation: 3 }); // the module's estimate, journaled
    expect(ps[0].spec.combo.range_down_pct).toBeCloseTo(80, 0);
    expect(runner.stats.evilPanda).toMatchObject({ evaluated: 1, opened: 1, failed: {} });
  });

  it("a red Supertrend keeps it out, counted per check", () => {
    const { sim, runner } = runnerFor({ chart: falling });
    runner.onTick(MIN);
    expect(sim.list()).toHaveLength(0);
    expect(runner.stats.evilPanda.failed).toEqual({ supertrend_red: 1 });
  });

  it("the runner closes it through the module's own exit rule; a new cycle waits for the cooldown", () => {
    let chart = rising;
    const { c, sim, runner } = runnerFor({ chart: () => chart(), mut: (p) => (p.exit.require_profit = false) });
    runner.onTick(MIN);
    sim.onState(state(MIN + 5_000, 0));
    const p = sim.list()[0];
    expect(p.status).toBe("active");
    chart = spike;
    const t = MIN + 5_000 + c.simulation.pnl_eval_seconds * 1000;
    runner.onTick(t);
    expect(p.status).toBe("closed");
    expect(p.closeReason).toBe("evil_panda_confluence");
    expect(runner.stats.pnlExits.evil_panda_confluence).toBe(1);
    // re-entry: none before 15 minutes, then a second cycle
    chart = rising;
    runner.onTick(t + 5 * MIN);
    expect(sim.list()).toHaveLength(1);
    runner.onTick(t + 16 * MIN);
    expect(sim.list()).toHaveLength(2);
    expect(sim.list()[1].spec.combo).toMatchObject({ cycle_no: 2, reentry: true, at_cohort: false });
    expect(runner.stats.evilPanda).toMatchObject({ opened: 2, reentries: 1 });
  });
});
