import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config, Sides } from "../src/config/schema.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { MemorySink, PoolSimulator, type PositionResult } from "../src/sim/engine.ts";
import type { PositionSpec, VirtualPosition } from "../src/sim/position.ts";
import { costClass } from "../src/analysis/scorecard.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

/**
 * Swap costs paid in kind: a balancing / rebalance / compounding swap leaves fewer tokens in the
 * position instead of a fixed dollar loss next to a full deposit. Session 8691ab49, pool 56pmBt1W
 * (rugged -81%): base-only $1000 positions in a $430 pool paid a $333 balancing swap and still held
 * $1000 of tokens, so they lost 115.8% of their capital.
 */
const cfg = (): Config => structuredClone(loadConfig().config);
const META: PoolMeta = {
  pool: "POOL", name: "T-USD", tokenX: "T", tokenY: "USD", symbolX: "T", symbolY: "USD", decimalsX: 6, decimalsY: 6,
  binStep: 100, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep: 100, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt: null,
};
const state = (ts: number, activeId: number, fee = 0.05): PoolStateUpdate => ({
  pool: "POOL", ts, slot: ts, activeId, priceUi: binUiPrice(activeId, 100, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: fee, feeRateLp: fee * 0.95,
});
const snapshot = (ts: number, activeId: number): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  for (let id = activeId - 30; id <= activeId + 30; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= activeId ? 1_000_000_000n : 0n;
    const y = id <= activeId ? 1_000_000_000n : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: 0n, feeY: 0n, priceRaw: P });
  }
  return { pool: "POOL", ts, slot: ts, activeId, lower: activeId - 30, upper: activeId + 30, missingBinArrays: [], bins };
};
const RANGES: Record<Sides, Partial<PositionSpec>> = {
  two_sided: { sides: "two_sided", binsBelow: 10, binsAbove: 10 },
  base_only: { sides: "base_only", binsBelow: 0, binsAbove: 20 },
  quote_only: { sides: "quote_only", binsBelow: 20, binsAbove: 0 },
};
/** Thin pool (TVL $430) so a $1000 position pays the capped size impact, as in session 8691ab49. */
const open = (sides: Sides, mut?: (c: Config) => void) => {
  const c = cfg();
  c.simulation.exit_to = "quote";
  mut?.(c);
  const sink = new MemorySink();
  const sim = new PoolSimulator(META, c, sink, () => "p1");
  sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 10_000, tvlUsd: 430 });
  sim.onState(state(0, 0));
  sim.onBins(snapshot(0, 0));
  const p = sim.request({ strategy: "spot", capitalUsd: 1000, entryMode: "all_pools_baseline", combo: {}, ...RANGES[sides] } as PositionSpec, 0);
  sim.onState(state(3000, 0));
  return { sim, sink, p, c };
};
const book = (p: VirtualPosition, type = "balancing_swap") => p.costs.filter((x) => x.type === type).reduce((s, x) => s + x.usd, 0);
type ResultCost = { type: string; usd: number; refundable: boolean; inKind?: boolean; bookUsd?: number };
const resultCosts = (r: PositionResult) => r.detail.costs as ResultCost[];
/** Costs that do not scale with a swap: transactions, bin arrays, composition fee, token tax. */
const fixedCosts = (r: PositionResult) => resultCosts(r).filter((x) => !x.refundable && costClass(x.type) !== "swap").reduce((s, x) => s + x.usd, 0);
/** id of the bin whose price is `ratio` x the entry price (bin step 100 bp) */
const idAt = (ratio: number) => Math.round(Math.log(ratio) / Math.log(1.01));

describe("swap costs paid in kind", () => {
  it("open: the balancing swap leaves fewer X tokens; the HODL basket is the capital; IL starts at 0", () => {
    const { sim, p, c } = open("base_only");
    const swap = book(p);
    const rate = 0.005 + c.simulation.costs.size_impact.max_pct / 100 + c.simulation.costs.slippage_margin_pct / 100;
    expect(swap).toBeCloseTo(1000 * rate, 6); // $1000 into a $430 pool: capped impact
    expect(p.costs.find((x) => x.type === "balancing_swap")!.inKind!.x).toBeGreaterThan(0);
    const v = sim.valuation(p);
    expect(v.valueUsd).toBeCloseTo(1000 - swap, 3);
    expect(v.hodlUsd).toBeCloseTo(1000, 3);
    expect(v.ilUsd).toBeCloseTo(0, 3);
    expect(v.inKindCostUsd).toBeCloseTo(swap, 6);
    expect(v.costUsd).toBeCloseTo(p.sunkCostUsd() + swap, 6);
    expect(v.netPnlUsd).toBeCloseTo(v.valueUsd - 1000 - p.sunkCostUsd(), 9); // the swap once, not twice
    expect(v.netPnlUsd).toBeCloseTo(-swap - p.sunkCostUsd(), 3);
  });

  it("a dump scales the swap cost with the token (the -81% rug of session 8691ab49)", () => {
    const { sim, p } = open("base_only");
    const swap = book(p);
    const dumpId = idAt(0.19);
    sim.onState(state(60_000, dumpId));
    const r = sim.close(p.id, "test", 60_000)!;
    const ratio = r.exitPrice / r.entryPrice;
    expect(ratio).toBeCloseTo(0.19, 2);
    // the swap cost now weighs what the tokens it kept are worth after the dump
    expect(r.detail.inKindCostUsd as number).toBeCloseTo(swap * ratio, 3);
    const item = resultCosts(r).find((x) => x.type === "balancing_swap")!;
    expect(item.inKind).toBe(true);
    expect(item.bookUsd).toBeCloseTo(swap, 9);
    expect(item.usd).toBeCloseTo(swap * ratio, 3);
    // deposited (1000 - swap) of X, 81% down, sold at the capped exit rate
    expect(r.finalValueUsd).toBeCloseTo((1000 - swap) * ratio, 0);
    expect(r.netPnlUsd).toBeGreaterThan(-1000);
    expect(r.netPnlPct).toBeGreaterThan(-100);
    // before the change: value (1000 x ratio) - 1000 - book swap - exit swap = about -115%
    expect(r.netPnlUsd).toBeGreaterThan(1000 * ratio - 1000 - swap);
  });

  it("the cost split of the result adds up to cost_usd (break-even report, scorecard cost classes)", () => {
    const { sim, p } = open("two_sided");
    sim.onState(state(30_000, idAt(0.4)));
    sim.rebalance(p.id, "test", 30_000); // all X: sells X for the Y side, paid in Y
    expect(p.costs.filter((x) => x.inKind).map((x) => (x.inKind!.y > 0 ? "y" : "x"))).toEqual(["x", "y"]);
    sim.onState(state(60_000, idAt(0.1)));
    const r = sim.close(p.id, "test", 60_000)!;
    const nonRefundable = resultCosts(r).filter((x) => !x.refundable);
    expect(nonRefundable.reduce((s, x) => s + x.usd, 0)).toBeCloseTo(r.costUsd, 9);
    expect(nonRefundable.every((x) => costClass(x.type) !== null)).toBe(true);
    // tracker PnL (before costs) and the decomposition: nothing counted twice
    expect(r.netPnlUsd).toBeCloseTo(r.feeUsd + r.ilUsd + (r.hodlValueUsd - 1000) - r.costUsd, 9);
    expect(r.detail.pnlVsHodlUsd as number).toBeCloseTo(r.feeUsd + r.ilUsd - r.costUsd, 9);
  });

  it("a position never loses more than its capital plus its fixed costs", () => {
    const sides: Sides[] = ["two_sided", "base_only", "quote_only"];
    const moves = [0.01, 0.19, 0.5, 1, 1.5];
    for (const s of sides)
      for (const exitTo of ["quote", "none"] as const)
        for (const move of moves)
          for (const rebalance of [false, true]) {
            const { sim, p } = open(s, (c) => (c.simulation.exit_to = exitTo));
            const id = idAt(move);
            if (rebalance) {
              sim.onState(state(30_000, Math.round(id / 2)));
              sim.rebalance(p.id, "test", 30_000);
            }
            sim.onState(state(60_000, id));
            const r = sim.close(p.id, "test", 60_000)!;
            const where = `${s} exit_to=${exitTo} move=${move} rebalance=${rebalance}`;
            expect(-r.netPnlUsd, where).toBeLessThanOrEqual(1000 + fixedCosts(r) + 1e-6);
            expect(r.finalValueUsd, where).toBeGreaterThanOrEqual(0);
            expect(r.netPnlUsd, where).toBeCloseTo(r.feeUsd + r.ilUsd + (r.hodlValueUsd - 1000) - r.costUsd, 6);
          }
  });

  it("the exit swap stays a cash cost at the close price, never above the X value sold", () => {
    const { sim, p } = open("base_only");
    sim.onState(state(60_000, idAt(0.01)));
    const r = sim.close(p.id, "test", 60_000)!;
    const exit = resultCosts(r).find((x) => x.type === "exit_swap")!;
    expect(exit.inKind).toBeUndefined();
    expect(exit.usd).toBeLessThan(r.finalValueUsd);
  });
});
