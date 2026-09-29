import { describe, expect, it } from "vitest";
import BN from "bn.js";
import * as sdk from "@meteora-ag/dlmm";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import { binIdFromUiPrice, binRawPrice, binUiPrice, q64ToNumber, Q64 } from "../src/math/bin.ts";
import { baseFeeNumerator, feeRates, totalFeeNumerator, variableFeeNumerator, type FeeParams } from "../src/math/fee.ts";
import { binCount, distributeFull, distributeLiquidity, xValueFraction, type RangeSpec } from "../src/sim/distribution.ts";
import { accumulatorFee, allocateSwapAcrossBins, dilutedShare, poolFeeFromAccumulators } from "../src/sim/feeAttribution.ts";
import { CostModel } from "../src/sim/costs.ts";
import { binXFrac, MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { valuePosition, VirtualPosition, type PositionSpec } from "../src/sim/position.ts";
import { loadBinSnapshots } from "../src/sim/replay.ts";
import { PriceSeries } from "../src/analysis/reconcile.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const cfg = (): Config => structuredClone(loadConfig().config);

// ---------------------------------------------------------------- bin price
describe("bin price", () => {
  it("matches SDK getPriceOfBinByBinId", () => {
    for (const step of [1, 4, 10, 25, 80, 100, 400])
      for (const id of [-20000, -5306, -1, 0, 1, 77, 4321]) {
        const sdkP = Number(sdk.getPriceOfBinByBinId(id, step).toString());
        if (!Number.isFinite(sdkP) || sdkP === 0) continue;
        expect(binRawPrice(id, step) / sdkP).toBeCloseTo(1, 10);
      }
  });

  it("UI price applies decimals and round-trips to the bin id", () => {
    const p = binUiPrice(-5306, 4, 9, 6);
    expect(p).toBeGreaterThan(100);
    expect(binIdFromUiPrice(p, 4, 9, 6)).toBe(-5306);
    expect(binIdFromUiPrice(p * 1.0001, 4, 9, 6)).toBe(-5306);
    expect(binIdFromUiPrice(p * 1.0005, 4, 9, 6)).toBe(-5305);
  });

  it("matches on-chain Q64 price for SDK getQPriceFromId", () => {
    const q = BigInt(sdk.getQPriceFromId(new BN(-5306), new BN(4)).toString());
    expect(q64ToNumber(q) / binRawPrice(-5306, 4)).toBeCloseTo(1, 8);
    expect(q64ToNumber(Q64 * 3n + Q64 / 2n)).toBe(3.5);
  });
});

// ---------------------------------------------------------------- fee rate
describe("fee rate", () => {
  const cases: (FeeParams & { va: number })[] = [
    { binStep: 4, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 120000, protocolShare: 1000, va: 32619 },
    { binStep: 80, baseFactor: 6250, baseFeePowerFactor: 0, variableFeeControl: 7500, protocolShare: 500, va: 250000 },
    { binStep: 100, baseFactor: 10000, baseFeePowerFactor: 1, variableFeeControl: 30000, protocolShare: 2000, va: 900000 },
    { binStep: 10, baseFactor: 20000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500, va: 5000 },
  ];
  it("matches SDK getBaseFee / getVariableFee / getTotalFee", () => {
    for (const c of cases) {
      const s = { baseFactor: c.baseFactor, baseFeePowerFactor: c.baseFeePowerFactor, variableFeeControl: c.variableFeeControl } as never;
      const v = { volatilityAccumulator: c.va } as never;
      expect(baseFeeNumerator(c).toString()).toBe(sdk.getBaseFee(c.binStep, s).toString());
      expect(variableFeeNumerator(c, c.va).toString()).toBe(sdk.getVariableFee(c.binStep, s, v).toString());
      expect(totalFeeNumerator(c, c.va).toString()).toBe(sdk.getTotalFee(c.binStep, s, v).toString());
    }
  });
  it("0.04% base for bin step 4 / base factor 10000; LP share excludes protocol", () => {
    const r = feeRates(cases[0], 0);
    expect(r.base).toBeCloseTo(0.0004, 12);
    expect(r.lp).toBeCloseTo(0.0004 * 0.9, 12);
    expect(feeRates(cases[2], 10_000_000).total).toBe(0.1); // capped at MAX_FEE_RATE (10%)
  });
});

// ---------------------------------------------------------------- distribution
describe("strategy distribution (SDK helpers)", () => {
  const A = -5306;
  const STEP = 4;
  const value = (b: { binId: number; x: bigint; y: bigint }) => Number(b.x) * binRawPrice(b.binId, STEP) + Number(b.y);
  const r = (strategy: RangeSpec["strategy"], sides: RangeSpec["sides"], n = 10): RangeSpec => ({
    strategy, sides, binsBelow: sides === "base_only" ? 0 : n, binsAbove: sides === "quote_only" ? 0 : n,
  });
  const X = 5_000_000_000n; // 5 SOL
  const Y = 600_000_000n; // 600 USDC

  for (const strategy of ["spot", "curve", "bidask"] as const)
    for (const sides of ["two_sided", "quote_only", "base_only"] as const) {
      it(`${strategy}/${sides}: allocation never exceeds and nearly equals the capital`, () => {
        const d = distributeFull(A, STEP, r(strategy, sides), X, Y);
        const sx = d.reduce((s, b) => s + b.x, 0n);
        const sy = d.reduce((s, b) => s + b.y, 0n);
        expect(d).toHaveLength(binCount(r(strategy, sides)));
        if (sides !== "quote_only") {
          expect(sx <= X).toBe(true);
          expect(Number(sx) / Number(X)).toBeGreaterThan(0.995);
        } else expect(sx).toBe(0n);
        if (sides !== "base_only") {
          expect(sy <= Y).toBe(true);
          expect(Number(sy) / Number(Y)).toBeGreaterThan(0.995);
        } else expect(sy).toBe(0n);
        // DLMM rule: bins above active hold only X, bins below only Y
        for (const b of d) {
          if (b.binId > A) expect(b.y).toBe(0n);
          if (b.binId < A) expect(b.x).toBe(0n);
        }
      });
    }

  it("spot is flat, curve peaks at the active bin, bid-ask grows towards the edges", () => {
    const bid = (s: RangeSpec["strategy"]) => distributeFull(A, STEP, r(s, "quote_only"), 0n, Y).sort((a, b) => a.binId - b.binId).map(value);
    const spot = bid("spot");
    for (const v of spot) expect(v / spot[0]).toBeCloseTo(1, 2);
    const curve = bid("curve"); // ascending bin id -> towards active: increasing
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
    const ba = bid("bidask"); // decreasing towards active
    for (let i = 1; i < ba.length; i++) expect(ba[i]).toBeLessThanOrEqual(ba[i - 1]);
  });

  it("matches the raw SDK path when no rescaling is needed", () => {
    const a = distributeLiquidity(A, STEP, r("spot", "two_sided"), X, Y);
    const b = distributeFull(A, STEP, r("spot", "two_sided"), X, Y);
    expect(b).toEqual(a);
  });

  it("auto X fraction makes spot two-sided uniform in value", () => {
    const rr = r("spot", "two_sided", 10);
    const f = xValueFraction(rr, "auto");
    expect(f).toBeCloseTo(10 / 21, 12);
    const price = binRawPrice(A, STEP);
    const totalQuote = 1_200_000_000; // raw
    const d = distributeFull(A, STEP, rr, BigInt(Math.floor((totalQuote * f) / price)), BigInt(Math.floor(totalQuote * (1 - f))));
    const vals = d.map(value);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    for (const v of vals) expect(Math.abs(v / mean - 1)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------- fee attribution
const bin = (binId: number, o: Partial<BinObs> = {}): BinObs => ({
  binId, x: 1_000_000n, y: 1_000_000n, supply: 2_000_000n * Q64, feeX: 0n, feeY: 0n, priceRaw: 1, ...o,
});

describe("fee attribution", () => {
  it("accumulator: pool fee = S * dFPT; virtual share = L/(S+L)", () => {
    const prev = bin(1, { feeX: 5n * Q64 });
    const curr = bin(1, { feeX: 5n * Q64 + Q64 / 1000n, feeY: Q64 / 2000n }); // +0.001 X and +0.0005 Y per unit
    const pool = poolFeeFromAccumulators(new Map([[1, prev]]), new Map([[1, curr]]));
    expect(pool.fx).toBeCloseTo(2_000_000 * 0.001, 6);
    expect(pool.fy).toBeCloseTo(2_000_000 * 0.0005, 6);
    const L = 2_000_000; // same size as the pool -> half of the diluted pot
    const f = accumulatorFee(prev, curr, L);
    expect(f.fx).toBeCloseTo(L * 0.001 * 0.5, 6);
    // tiny position ~ proportional share without dilution effect
    const t = accumulatorFee(prev, curr, 1);
    expect(t.fx).toBeCloseTo(0.001, 6);
  });

  it("accumulator ignores missing / reset bins", () => {
    expect(accumulatorFee(undefined, bin(1), 10)).toEqual({ fx: 0, fy: 0 });
    expect(accumulatorFee(bin(1, { feeX: 10n }), bin(1, { feeX: 5n }), 10)).toEqual({ fx: 0, fy: 0 });
  });

  it("swap allocation: crossed bins consumed fully, remainder in the end bin", () => {
    // Y in (price up) from bin 0 to 2: bins 0 and 1 give all their X
    const bins = new Map([
      [0, bin(0, { x: 100n, priceRaw: 1 })],
      [1, bin(1, { x: 50n, priceRaw: 2 })], // capacity in Y = 100
      [2, bin(2, { x: 1000n, priceRaw: 4 })],
    ]);
    const a = allocateSwapAcrossBins({ startBin: 0, endBin: 2, swapForY: false, amountIn: 400 }, bins);
    expect(a.get(0)).toBeCloseTo(100 / 400);
    expect(a.get(1)).toBeCloseTo(100 / 400);
    expect(a.get(2)).toBeCloseTo(200 / 400);
    const one = allocateSwapAcrossBins({ startBin: 5, endBin: 5, swapForY: true, amountIn: 1 }, bins);
    expect(one.get(5)).toBe(1);
    const stale = allocateSwapAcrossBins({ startBin: 0, endBin: 2, swapForY: false, amountIn: 10 }, bins);
    const sum = [...stale.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1, 12);
    expect(dilutedShare(10, 1, 9)).toBeCloseTo(1);
  });
});

// ---------------------------------------------------------------- composition & PnL
describe("composition and PnL", () => {
  const spec: PositionSpec = { strategy: "spot", sides: "quote_only", binsBelow: 4, binsAbove: 0, capitalUsd: 1000, entryMode: "t", combo: {} };
  const mkPos = () => {
    const p = new VirtualPosition("p", "pool", spec, 0, 0);
    for (let id = -4; id <= 0; id++) p.bins.set(id, { L: 200, priceRaw: binRawPrice(id, 100) });
    p.y0 = 1000;
    p.lower = -4;
    p.upper = 0;
    return p;
  };

  it("quote-only below price turns fully into base when price falls through the whole range", () => {
    const p = mkPos();
    const c0 = p.composition(1, 0.5);
    expect(c0.x).toBe(0);
    expect(c0.y).toBeCloseTo(1000);
    const c1 = p.composition(-5, 0.5);
    expect(c1.y).toBe(0);
    const expectX = [...p.bins.values()].reduce((s, b) => s + b.L / b.priceRaw, 0);
    expect(c1.x).toBeCloseTo(expectX);
  });

  it("value is conserved at bin prices while the active bin moves through (constant-sum bins)", () => {
    const p = mkPos();
    for (let a = 1; a >= -5; a--) {
      const c = p.composition(a, 0.3);
      const v = [...p.bins.entries()].reduce((s, [id, b]) => {
        if (id < a) return s + b.L;
        if (id > a) return s + b.L; // x * P_bin
        return s + b.L;
      }, 0);
      // recompute from composition at each bin's own price
      let vx = 0;
      for (const [id, b] of p.bins) {
        if (id > a) vx += (b.L / b.priceRaw) * b.priceRaw;
        if (id === a) vx += ((0.3 * b.L) / b.priceRaw) * b.priceRaw;
      }
      expect(vx + c.y).toBeCloseTo(v, 9);
    }
  });

  it("IL vs HODL and net PnL = value + fees - capital - sunk costs (rent excluded)", () => {
    const p = mkPos();
    p.feeY = 5;
    p.costs.push({ type: "tx_open", usd: 0.5, refundable: false }, { type: "position_rent", usd: 10, refundable: true });
    const v = valuePosition(p, 1, 0.5, 1, 1, 0, 0);
    expect(v.valueUsd).toBeCloseTo(1000);
    expect(v.ilUsd).toBeCloseTo(0);
    expect(v.netPnlUsd).toBeCloseTo(1000 + 5 - 1000 - 0.5);
    // price fell through the range: we now hold X bought at bin prices above the new price
    const down = binUiPrice(-6, 100, 0, 0);
    const v2 = valuePosition(p, -6, 0.5, down, 1, 0, 0);
    expect(v2.ilUsd).toBeLessThan(0);
    expect(v2.hodlUsd).toBeCloseTo(1000); // HODL was all quote
  });
});

// ---------------------------------------------------------------- costs
describe("cost model", () => {
  const c = cfg().simulation.costs;
  const m = new CostModel(c);
  it("tx cost = (sigs*base + CU*priority) grossed up by failure rate", () => {
    const t = m.txCost("open", { solUsd: 100, priorityMicroLamports: 50_000 });
    const lamports = (c.signatures.open * 5000 + (c.compute_units.open * 50_000) / 1e6) / (1 - c.tx_failure_rate);
    expect(t.sol).toBeCloseTo(lamports / 1e9, 12);
    expect(t.usd).toBeCloseTo((lamports / 1e9) * 100, 10);
    const floor = m.txCost("open", { solUsd: 100, priorityMicroLamports: 0 });
    expect(floor.detail!.microLamportsPerCu).toBe(c.priority_fee_floor_micro_lamports);
  });
  it("position rent grows past 70 bins and is refundable; bin arrays only when missing", () => {
    const r70 = m.positionRent(70, { solUsd: 100, priorityMicroLamports: 0 });
    const r101 = m.positionRent(101, { solUsd: 100, priorityMicroLamports: 0 });
    expect(r70.sol).toBeCloseTo(c.position_base_rent_sol);
    expect(r101.sol! - r70.sol!).toBeCloseTo((31 * 112 * 6960) / 1e9, 12);
    expect(r70.refundable).toBe(true);
    expect(m.binArrayInit(-10, 10, [], { solUsd: 1, priorityMicroLamports: 0 })).toBeNull();
    const ba = m.binArrayInit(-10, 10, [-1, 5], { solUsd: 1, priorityMicroLamports: 0 })!;
    expect(ba.detail!.arrays).toEqual([-1]);
    expect(ba.refundable).toBe(false);
  });
});

// ---------------------------------------------------------------- engine
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
const snapshot = (ts: number, activeId: number, fpt: bigint): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  for (let id = activeId - 30; id <= activeId + 30; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= activeId ? 1_000_000_000n : 0n;
    const y = id <= activeId ? 1_000_000_000n : 0n;
    const L = P * Number(x) + Number(y);
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(L)) * Q64, feeX: fpt, feeY: fpt, priceRaw: P });
  }
  return { pool: "POOL", ts, slot: ts, activeId, lower: activeId - 30, upper: activeId + 30, missingBinArrays: [], bins };
};
const pspec = (o: Partial<PositionSpec> = {}): PositionSpec => ({
  strategy: "spot", sides: "two_sided", binsBelow: 5, binsAbove: 5, capitalUsd: 1000, entryMode: "all_pools_baseline", combo: {}, ...o,
});

describe("PoolSimulator", () => {
  const setup = (mut?: (c: Config) => void) => {
    const c = cfg();
    mut?.(c);
    const sink = new MemorySink();
    let n = 0;
    const sim = new PoolSimulator(META, c, sink, () => `p${++n}`);
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 10000 });
    return { sim, sink, c };
  };

  it("entry delay: activates at the first state >= request + delay, at that price", () => {
    const { sim, sink } = setup();
    sim.onState(state(0, 0));
    sim.onBins(snapshot(0, 0, 0n));
    const p = sim.request(pspec(), 0);
    expect(p.status).toBe("pending");
    sim.onState(state(2000, 3)); // before delay (3 s)
    expect(p.status).toBe("pending");
    sim.onState(state(3000, 7));
    expect(p.status).toBe("active");
    expect(p.entryActiveId).toBe(7);
    expect(p.lower).toBe(2);
    expect(p.upper).toBe(12);
    expect(sink.events.find((e) => e.type === "open")!.detail.delayMs).toBe(3000);
  });

  it("fails when required data never arrives", () => {
    const { sim } = setup();
    sim.onState(state(0, 0)); // no bin snapshot ever
    const p = sim.request(pspec(), 0);
    sim.onState(state(200_000, 0));
    expect(p.status).toBe("failed");
  });

  it("full lifecycle: fees accrue only inside the position's life, result is consistent", () => {
    const { sim, sink } = setup();
    sim.onState(state(0, 0));
    sim.onBins(snapshot(0, 0, 0n));
    const p = sim.request(pspec(), 0);
    sim.onState(state(3000, 0));
    // this pair starts before openedAt -> not accrued
    sim.onBins(snapshot(30_000, 0, Q64 / 1000n));
    expect(p.feeX).toBe(0);
    sim.onBins(snapshot(60_000, 0, (2n * Q64) / 1000n));
    expect(p.feeX).toBeGreaterThan(0);
    sim.onState(state(60_000, 0));
    const r = sim.close(p.id, "session_end", 60_000)!;
    expect(r.feeUsd).toBeGreaterThan(0);
    expect(r.netPnlUsd).toBeCloseTo(r.finalValueUsd + r.feeUsd - 1000 - r.costUsd, 9);
    expect(r.timeInRangePct).toBeCloseTo(100);
    expect(r.rentLockedUsd).toBeGreaterThan(0);
    expect(sink.results).toHaveLength(1);
    // exact check: every bin paid 0.001 per unit of liquidity on X and Y, diluted by S/(S+L)
    const snap = snapshot(60_000, 0, 0n);
    let expected = 0;
    for (const [id, b] of p.bins) {
      const S = Number(snap.bins.get(id)!.supply) / 2 ** 64;
      expected += b.L * 0.001 * (S / (S + b.L));
    }
    expect(p.feeX).toBeCloseTo(expected, 6);
    expect(p.feeY).toBeCloseTo(expected, 6);
  });

  it("price leaving the range emits cross events and lowers time in range", () => {
    const { sim, sink } = setup();
    sim.onState(state(0, 0));
    sim.onBins(snapshot(0, 0, 0n));
    const p = sim.request(pspec({ binsBelow: 2, binsAbove: 2 }), 0);
    sim.onState(state(3000, 0));
    sim.onState(state(63_000, 10)); // above the range for the next minute
    sim.onState(state(123_000, 10));
    const r = sim.close(p.id, "session_end", 123_000)!;
    expect(sink.events.filter((e) => e.type === "cross")).toHaveLength(1);
    expect(r.timeInRangePct).toBeCloseTo(50, 0);
    expect(r.detail.finalX as number).toBeCloseTo(0, 5); // all converted to quote above the range (idle dust only)
    expect(r.ilUsd).toBeLessThan(0);
  });

  it("gap taint (rule from simulation.gap_taint, see test/gapTaint.test.ts): only a long gap or an action on stale data", () => {
    const { sim } = setup();
    sim.onState(state(0, 0));
    sim.onBins(snapshot(0, 0, 0n));
    const p = sim.request(pspec(), 0);
    sim.onState(state(3000, 0));
    // a short bin_snapshot gap: fees are gap-proof (bin accumulators), the value follows the active bin
    sim.onGap({ source: "bin_snapshot", start: 10_000, end: 20_000 });
    expect(p.gapTainted).toBe(false);
    // swap_stream gaps are irrelevant in accumulator mode, however long
    sim.onGap({ source: "swap_stream", start: 10_000, end: 20_000 + 10 * 60_000 });
    expect(p.gapTainted).toBe(false);
    // one gap longer than max_single_gap_minutes: exit rules could not react
    sim.onGap({ source: "bin_snapshot", start: 30_000, end: 30_000 + 6 * 60_000 });
    expect(p.gapTainted).toBe(false); // the gap only counts up to the position's life so far
    sim.onState(state(30_000 + 6 * 60_000 + 1000, 0));
    sim.close(p.id, "test", 30_000 + 6 * 60_000 + 1000);
    expect(p.gapTainted).toBe(true);
    expect(p.taint?.reason).toBe("long_gap");
  });

  it("swap_events mode attributes the LP fee of swaps through our bins", () => {
    const { sim } = setup((c) => (c.simulation.fee_attribution = "swap_events"));
    sim.onState(state(0, 0));
    sim.onBins(snapshot(0, 0, 0n));
    const p = sim.request(pspec(), 0);
    sim.onState(state(3000, 0));
    sim.onSwap({ pool: "POOL", signature: "s", eventIndex: 0, ts: 4000, slot: 1, swapForY: true, startBin: 0, endBin: 0, amountIn: 1000n, amountOut: 1000n, fee: 1_000_000n, protocolFee: 50_000n, mmFee: 950_000n, feeOnX: true, wallet: "w" });
    expect(p.feeX).toBeGreaterThan(0);
    expect(p.feeX).toBeLessThan(950_000);
  });

  it("binXFrac is the x-value share", () => {
    expect(binXFrac({ binId: 0, x: 1n, y: 1n, supply: 1n, feeX: 0n, feeY: 0n, priceRaw: 3 })).toBeCloseTo(0.75);
  });
});

// ---------------------------------------------------------------- storage round trip
describe("delta-encoded bin snapshots", () => {
  it("replay reconstructs keyframes + deltas + emptied bins", () => {
    const db = new Db(":memory:");
    migrate(db);
    const meta = (ts: number, full: number) =>
      db.insert("bin_snapshot_meta", { pool: "P", ts, active_bin: 0, lower_bin: -2, upper_bin: 2, missing_bin_arrays: "[]", bin_count: 0, stored_count: 0, full, slot: ts });
    const row = (ts: number, id: number, supply: string, fee = "0") =>
      db.insert("bin_snapshots", { pool: "P", ts, bin_id: id, x_amount: "1", y_amount: "2", liquidity_supply: supply, fee_x_per_token: fee, fee_y_per_token: "0" });
    meta(1, 1); row(1, -1, "10"); row(1, 0, "10"); row(1, 1, "10");
    meta(2, 0); row(2, 0, "10", "5"); row(2, 1, "0");
    meta(3, 0);
    const s = loadBinSnapshots(db, "P", 0, 10, 1);
    expect(s.map((x) => x.ts)).toEqual([1, 2, 3]);
    expect([...s[0].bins.keys()].sort()).toEqual([-1, 0, 1]);
    expect([...s[1].bins.keys()].sort()).toEqual([-1, 0]);
    expect(s[1].bins.get(0)!.feeX).toBe(5n);
    expect(s[2].bins.get(-1)!.supply).toBe(10n);
    // starting mid-stream begins from the last keyframe
    expect(loadBinSnapshots(db, "P", 2, 10, 1).map((x) => x.ts)).toEqual([2, 3]);
    db.close();
  });

  it("PriceSeries returns the value at or before t", () => {
    const p = new PriceSeries([{ ts: 10, token_x_usd: 1, token_y_usd: 2 }, { ts: 20, token_x_usd: 3, token_y_usd: 4 }]);
    expect(p.at(5)).toEqual({ x: 1, y: 2 });
    expect(p.at(15)).toEqual({ x: 1, y: 2 });
    expect(p.at(25)).toEqual({ x: 3, y: 4 });
  });
});
