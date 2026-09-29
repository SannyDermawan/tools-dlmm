import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { binsForRangePct, downsidePct, upsidePct } from "../src/sim/distribution.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { GridRunner, gridCombos, SessionClock } from "../src/sim/gridRunner.ts";
import { SignalBook } from "../src/signals/signalEngine.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const META = (binStep: number, createdAt: number | null = null): PoolMeta => ({
  pool: "POOL", name: "T-USD", tokenX: "T", tokenY: "USD", symbolX: "T", symbolY: "USD", decimalsX: 6, decimalsY: 6,
  binStep, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt,
});
const state = (ts: number, binStep: number): PoolStateUpdate => ({
  pool: "POOL", ts, slot: ts, activeId: 0, priceUi: binUiPrice(0, binStep, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: 0.01, feeRateLp: 0.0095,
});
const snapshot = (ts: number, binStep: number, span: number): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  for (let id = -span; id <= span; id++) {
    const P = binRawPrice(id, binStep);
    const x = id >= 0 ? 1_000_000_000n : 0n;
    const y = id <= 0 ? 1_000_000_000n : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: 0n, feeY: 0n, priceRaw: P });
  }
  return { pool: "POOL", ts, slot: ts, activeId: 0, lower: -span, upper: span, missingBinArrays: [], bins };
};

describe("price-% widths (playbook point 1)", () => {
  it("bins for a downside move: -50% is 70 bins at step 100 (69.66), 87 at step 80, 693 at step 10", () => {
    expect(binsForRangePct(50, 100)).toBe(70);
    expect(binsForRangePct(50, 80)).toBe(87);
    expect(binsForRangePct(50, 10)).toBe(693);
    expect(binsForRangePct(90, 100)).toBe(231);
    expect(binsForRangePct(30, 100)).toBe(36);
    expect(binsForRangePct(0.01, 100)).toBe(1); // never below one bin
  });

  it("the covered move round-trips through the bins (within one bin)", () => {
    for (const step of [10, 20, 50, 80, 100, 250]) {
      for (const pct of [30, 50, 70, 90]) {
        const n = binsForRangePct(pct, step);
        const back = downsidePct(n, step);
        const oneBin = downsidePct(n + 1, step) - downsidePct(n, step);
        expect(Math.abs(back - pct)).toBeLessThanOrEqual(oneBin);
      }
    }
    expect(downsidePct(0, 100)).toBe(0);
    expect(upsidePct(0, 100)).toBe(0);
    expect(upsidePct(70, 100)).toBeCloseTo(100.7, 0); // the same bin count goes ~+100% up
  });

  it("grid combinations: fixed bins and price-% levels are separate widths; pct combos carry range_pct", () => {
    const c = structuredClone(loadConfig().config);
    c.grid.strategies = ["spot"];
    c.grid.sides = ["quote_only"];
    c.grid.bins_per_side = [10];
    c.grid.range_pct = [50, 90];
    c.grid.exit_policies = [{ type: "hold_to_session_end" }];
    c.grid.variants = ["none"];
    c.grid.entry_filter = ["none"];
    c.grid.cooldown_enabled = [false];
    c.grid.entry_modes = ["all_pools_baseline"];
    c.grid.sampling.mode = "full";
    const combos = gridCombos(c);
    expect(combos).toHaveLength(3);
    expect(combos.filter((s) => s.rangePct === undefined)).toHaveLength(1);
    expect(combos.filter((s) => s.rangePct !== undefined).map((s) => s.combo.range_pct).sort()).toEqual([50, 90]);
  });
});

describe("resolving and journaling widths at open (points 1 and 2)", () => {
  const run = (o: { binStep: number; span: number; mut?: (c: Config) => void; createdAt?: number | null; tokenInfo?: (pool: string, ts: number) => { tokenAgeHours: number | null; mcapUsd: number | null } | null }) => {
    const c = structuredClone(loadConfig().config);
    c.grid.strategies = ["spot"];
    c.grid.sides = ["quote_only"];
    c.grid.bins_per_side = [];
    c.grid.range_pct = [50, 90];
    c.grid.exit_policies = [{ type: "hold_to_session_end" }];
    c.grid.variants = ["none"];
    c.grid.entry_filter = ["none"];
    c.grid.cooldown_enabled = [false];
    c.grid.sampling.mode = "full";
    c.grid.entry_modes = ["all_pools_baseline"];
    o.mut?.(c);
    let n = 0;
    const sim = new PoolSimulator(META(o.binStep, o.createdAt ?? null), c, new MemorySink(), () => `P${++n}`);
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
    sim.onState(state(0, o.binStep));
    sim.onBins(snapshot(0, o.binStep, o.span));
    const book = new SignalBook(null, c, "S", "v");
    const runner = new GridRunner(
      c, new Map([["POOL", sim]]),
      new SessionClock(0, { durationMinutes: 600, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }),
      undefined, { book, tokenInfo: o.tokenInfo },
    );
    runner.onTick(MIN); // the first cohort
    return { runner, sim, c };
  };

  it("a step-100 pool: -50% = 70 bins and -90% = 231 bins below, none above; journaled in price %", () => {
    const { sim, runner } = run({ binStep: 100, span: 240 });
    const ps = sim.list();
    expect(ps).toHaveLength(2);
    const by = (pct: number) => ps.find((p) => p.spec.combo.range_pct === pct)!;
    expect(by(50).spec.binsBelow).toBe(70);
    expect(by(50).spec.binsAbove).toBe(0);
    expect(by(90).spec.binsBelow).toBe(231);
    expect(by(50).spec.combo.range_down_pct).toBeCloseTo(50, 0);
    expect(by(90).spec.combo.range_down_pct).toBeCloseTo(90, 0);
    expect(by(50).spec.combo.range_up_pct).toBe(0);
    expect(runner.stats.widthSkips).toBe(0);
  });

  it("a step-10 pool cannot fit -90% in one position: the level is skipped and counted, not clipped", () => {
    const { sim, runner } = run({ binStep: 10, span: 40, mut: (c) => (c.grid.range_pct = [30, 50, 90]) });
    // -30% needs 357 bins, -50% 693 (fit in 1400), -90% 2303 (does not)
    const got = sim.list().map((p) => p.spec.combo.range_pct).sort();
    expect(got).toEqual([30, 50]);
    expect(runner.stats.widthSkips).toBe(1);
  });

  it("journals pool age, token age and market cap at the entry (report dimensions)", () => {
    const created = -5 * HOUR;
    const { sim } = run({
      binStep: 100, span: 240, createdAt: created,
      tokenInfo: () => ({ tokenAgeHours: 36.789, mcapUsd: 5_123_456.7 }),
    });
    const combo = sim.list()[0].spec.combo;
    expect(combo.pool_age_h).toBeCloseTo(5 + 1 / 60, 1);
    expect(combo.token_age_h).toBe(36.79);
    expect(combo.mcap_usd).toBe(5_123_457);
  });

  it("no token data: the dimensions are null, never zero", () => {
    const { sim } = run({ binStep: 100, span: 240, createdAt: null });
    const combo = sim.list()[0].spec.combo;
    expect(combo.pool_age_h).toBeNull();
    expect(combo.token_age_h).toBeNull();
    expect(combo.mcap_usd).toBeNull();
  });
});
