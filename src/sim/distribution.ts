import BN from "bn.js";
import { meteoraSdk as sdk } from "../chain/sdk.ts";
import type { Sides, Strategy } from "../config/schema.ts";

/** SDK StrategyType enum values (Spot=0, Curve=1, BidAsk=2). */
const STRATEGY_TYPE: Record<Strategy, number> = { spot: 0, curve: 1, bidask: 2 };

export interface RangeSpec {
  strategy: Strategy;
  sides: Sides;
  /** bins below the active bin (two_sided / quote_only) */
  binsBelow: number;
  /** bins above the active bin (two_sided / base_only) */
  binsAbove: number;
  /**
   * Mix of two shapes over the same range (Yunus flip: 70% bid-ask + 30% spot): `share` of every
   * side's amount is laid out with `strategy`, the rest with the main one. Absent = a single shape.
   */
  blend?: { strategy: Strategy; share: number };
}

export interface BinAmount {
  binId: number;
  x: bigint; // raw
  y: bigint; // raw
}

/**
 * Delta range relative to the active bin, following the SDK conventions:
 *   two_sided : [-below, +above], active bin on the bid (Y) side  (favorXInActiveBin = false)
 *   quote_only: [-below, 0],     Y only, active bin included
 *   base_only : [0, +above],     X only, active bin included       (favorXInActiveBin = true)
 */
export function deltaRange(r: RangeSpec): { minDelta: number; maxDelta: number; favorX: boolean } {
  switch (r.sides) {
    case "two_sided":
      return { minDelta: -r.binsBelow, maxDelta: r.binsAbove, favorX: false };
    case "quote_only":
      return { minDelta: -r.binsBelow, maxDelta: 0, favorX: false };
    case "base_only":
      return { minDelta: 0, maxDelta: r.binsAbove, favorX: true };
  }
}

export function binCount(r: RangeSpec): number {
  const d = deltaRange(r);
  return d.maxDelta - d.minDelta + 1;
}

/**
 * Distribute raw token amounts into bins exactly like the SDK's add-liquidity-by-strategy path
 * (buildLiquidityStrategyParameters -> toAmountIntoBins, lb_clmm 0.12 "rebalance" strategy
 * parameters). Amounts are floored per bin; the caller keeps the remainder as idle balance.
 */
export function distributeLiquidity(
  activeId: number,
  binStep: number,
  r: RangeSpec,
  amountX: bigint,
  amountY: bigint,
): BinAmount[] {
  const { minDelta, maxDelta, favorX } = deltaRange(r);
  if (r.sides === "quote_only") amountX = 0n;
  if (r.sides === "base_only") amountY = 0n;
  const builder = sdk.getLiquidityStrategyParameterBuilder(STRATEGY_TYPE[r.strategy] as never);
  const p = sdk.buildLiquidityStrategyParameters(
    new BN(amountX.toString()),
    new BN(amountY.toString()),
    new BN(minDelta),
    new BN(maxDelta),
    new BN(binStep),
    favorX,
    new BN(activeId),
    builder,
  );
  const bins = sdk.toAmountIntoBins(
    new BN(activeId), new BN(minDelta), new BN(maxDelta), p.deltaX, p.deltaY, p.x0, p.y0, new BN(binStep), favorX,
  );
  return bins.map((b) => ({
    binId: b.binId.toNumber(),
    x: BigInt(b.amountX.toString()),
    y: BigInt(b.amountY.toString()),
  }));
}

const sum = (bins: BinAmount[], k: "x" | "y") => bins.reduce((s, b) => s + b[k], 0n);

/**
 * Like distributeLiquidity, but deploys (almost) all of the target amounts. Some SDK shapes do not
 * spend the whole input on one side (e.g. Curve bid side uses ~87.5%); the input for that side is
 * scaled up and re-distributed, never exceeding the target.
 */
export function distributeFull(activeId: number, binStep: number, r: RangeSpec, targetX: bigint, targetY: bigint): BinAmount[] {
  if (r.blend) return distributeBlend(activeId, binStep, r, targetX, targetY);
  let inX = targetX;
  let inY = targetY;
  let best = distributeLiquidity(activeId, binStep, r, inX, inY);
  for (let i = 0; i < 4; i++) {
    const ux = sum(best, "x");
    const uy = sum(best, "y");
    const needX = targetX > 0n && ux * 1000n < targetX * 995n;
    const needY = targetY > 0n && uy * 1000n < targetY * 995n;
    if (!needX && !needY) break;
    if (needX && ux > 0n) inX = (inX * targetX * 999n) / (ux * 1000n);
    if (needY && uy > 0n) inY = (inY * targetY * 999n) / (uy * 1000n);
    const next = distributeLiquidity(activeId, binStep, r, inX, inY);
    if (sum(next, "x") > targetX || sum(next, "y") > targetY) break;
    best = next;
  }
  return best;
}

/** Two shapes over one range: the amounts are split by `blend.share` (per mille), laid out separately and summed per bin. */
function distributeBlend(activeId: number, binStep: number, r: RangeSpec, targetX: bigint, targetY: bigint): BinAmount[] {
  const b = r.blend!;
  const share = BigInt(Math.round(Math.min(1, Math.max(0, b.share)) * 1000));
  const part = (v: bigint) => (v * share) / 1000n;
  const main: RangeSpec = { strategy: r.strategy, sides: r.sides, binsBelow: r.binsBelow, binsAbove: r.binsAbove };
  const second: RangeSpec = { ...main, strategy: b.strategy };
  const out = new Map<number, BinAmount>();
  const add = (bins: BinAmount[]) => {
    for (const x of bins) {
      const cur = out.get(x.binId);
      if (cur) out.set(x.binId, { binId: x.binId, x: cur.x + x.x, y: cur.y + x.y });
      else out.set(x.binId, x);
    }
  };
  if (share < 1000n) add(distributeFull(activeId, binStep, main, targetX - part(targetX), targetY - part(targetY)));
  if (share > 0n) add(distributeFull(activeId, binStep, second, part(targetX), part(targetY)));
  return [...out.values()].sort((a, c) => a.binId - c.binId);
}

/** Fraction of capital placed as X for a range: auto = proportional to ask-side bin count. */
export function xValueFraction(r: RangeSpec, setting: "auto" | number): number {
  if (r.sides === "base_only") return 1;
  if (r.sides === "quote_only") return 0;
  if (setting !== "auto") return setting;
  const { minDelta, maxDelta, favorX } = deltaRange(r);
  const total = maxDelta - minDelta + 1;
  const ask = favorX ? maxDelta + 1 : maxDelta;
  return ask / total;
}

/**
 * Bins that cover a downside price move of `pct` % at a bin step (bps): price falls by (1+step)^-n,
 * so n = ln(1 - pct/100) / ln(1/(1+step)). 70 bins are -50% at step 100 but only -6.8% at step 10.
 */
export function binsForRangePct(pct: number, binStep: number): number {
  const n = Math.round(-Math.log(1 - pct / 100) / Math.log(1 + binStep / 10_000));
  return Math.max(1, n);
}

/** Downside price move (%) covered by `bins` bins at a bin step. */
export const downsidePct = (bins: number, binStep: number) => (bins <= 0 ? 0 : 100 * (1 - Math.pow(1 + binStep / 10_000, -bins)));

/** Upside price move (%) covered by `bins` bins at a bin step. */
export const upsidePct = (bins: number, binStep: number) => (bins <= 0 ? 0 : 100 * (Math.pow(1 + binStep / 10_000, bins) - 1));

/** Bins that cover an upside price move of `pct` %: n = ln(1 + pct/100) / ln(1 + step). */
export function binsForUpPct(pct: number, binStep: number): number {
  const n = Math.round(Math.log(1 + pct / 100) / Math.log(1 + binStep / 10_000));
  return Math.max(1, n);
}
