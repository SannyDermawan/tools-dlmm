import type { Sides, Strategy } from "../config/schema.ts";
import type { CostItem } from "./costs.ts";
import type { RangeSpec } from "./distribution.ts";
import type { GapInterval, TaintVerdict } from "./taint.ts";
import type { ScalarExitPolicy } from "./policies.ts";

export type Variant = "none" | "partial_harvest" | "fee_compounding" | "single_sided_reseed" | "wide_range";

/**
 * Yunus flip: when the position has been fully converted to the base token (price fell through the
 * whole range) it is redeployed base-only above the new price ("ask"), with an optional shape mix.
 */
export interface FlipSpec {
  /** second shape and its share of the flip range (Yunus: 30% spot on 70% bid-ask); null = one shape */
  blend: { strategy: Strategy; share: number } | null;
  shape: Strategy;
  /** the flip range covers this upside price move (%) */
  upPct: number;
  maxFlips: number;
}

export interface PositionSpec {
  strategy: Strategy;
  sides: Sides;
  binsBelow: number;
  binsAbove: number;
  capitalUsd: number;
  entryMode: string;
  /** grid exit policy (hold_to_session_end when absent) */
  exitPolicy?: ScalarExitPolicy;
  /** strategy variant (addendum 2.2; none when absent) */
  variant?: Variant;
  cohort?: number;
  signalId?: string | null;
  /** width as the downside price move covered (%): resolved to bins per pool from its bin step at the open */
  rangePct?: number;
  /** phase 10: skip pools in cooldown (signal modes; null = not applicable) */
  cooldownEnabled?: boolean | null;
  /** phase 13: indicator entry filter (none when absent) */
  entryFilter?: string;
  /** yunus_flip entry mode: redeploy base-only above once fully converted to the base token */
  flip?: FlipSpec;
  /** full grid combination, journaled as JSON */
  combo: Record<string, unknown>;
}

export interface VBin {
  /** liquidity in raw quote units (P_raw * x + y), constant while held (constant-sum bin) */
  L: number;
  priceRaw: number;
}

export type PositionStatus = "pending" | "active" | "closed" | "failed";

export interface Composition {
  x: number; // raw
  y: number; // raw
}

/**
 * A virtual DLMM position. Token amounts are raw units (floats; relative precision is ample).
 * Composition is a pure function of the active bin (DLMM mechanics):
 *   bins below active -> all Y (= L), bins above -> all X (= L / P_bin),
 *   active bin -> split like the real active bin (x-value fraction fx).
 */
export class VirtualPosition {
  status: PositionStatus = "pending";
  openedAt: number | null = null;
  closedAt: number | null = null;
  closeReason: string | null = null;
  failReason: string | null = null;
  lower = 0;
  upper = 0;
  bins = new Map<number, VBin>();
  /** deposited amounts incl. idle remainder (the HODL basket), raw */
  x0 = 0;
  y0 = 0;
  idleX = 0;
  idleY = 0;
  entryActiveId = 0;
  entryPriceUi = 0;
  entryQuoteUsd = 0;
  /** pool TVL at the open and the position's size as % of it (null: TVL unknown); size_limit journals it */
  tvlOpenUsd: number | null = null;
  sizePctTvl: number | null = null;
  cappedFromUsd: number | null = null;
  feeX = 0; // raw, accrued
  feeY = 0;
  costs: CostItem[] = [];
  activeMs = 0;
  inRangeMs = 0;
  inRange = true;
  outOfRangeSince: number | null = null;
  lastMarkTs = 0;
  peakEquityUsd = 0;
  maxDrawdownUsd = 0;
  maxDrawdownPct = 0;
  gapTainted = false;
  /** data gaps overlapping the position (key source|start) and the times it acted (gap taint) */
  gapIntervals = new Map<string, GapInterval>();
  actionTimes: number[] = [];
  taint: TaintVerdict | null = null;
  lastFeeEventTs = 0;
  crossCount = 0;
  rebalanceCount = 0;
  /** value withdrawn by partial exits, held as cash (quote UI units at withdrawal prices) */
  realizedQuote = 0;
  partialExits = 0;
  /** range used by rebalances after a single-sided reseed (null: the spec range) */
  rangeOverride: RangeSpec | null = null;
  reseeds = 0;
  compounds = 0;
  /** fees re-added as liquidity (USD at compounding time); they are inside the position value now */
  compoundedFeeUsd = 0;
  /** fees accrue only over data intervals starting at or after this time (open / last rebalance) */
  accrualFrom: number | null = null;
  last: { valueUsd: number; feeUsd: number; hodlUsd: number; priceUi: number; quoteUsd: number } | null = null;

  constructor(
    readonly id: string,
    readonly pool: string,
    readonly spec: PositionSpec,
    readonly requestedAt: number,
    readonly activateAt: number,
  ) {}

  /** Token amounts held at active bin `activeId` (fx = x-value share of the real active bin). */
  composition(activeId: number, fx: number): Composition {
    let x = this.idleX;
    let y = this.idleY;
    for (const [id, b] of this.bins) {
      if (id < activeId) y += b.L;
      else if (id > activeId) x += b.L / b.priceRaw;
      else {
        x += (fx * b.L) / b.priceRaw;
        y += (1 - fx) * b.L;
      }
    }
    return { x, y };
  }

  liquidityAt(binId: number): number {
    return this.bins.get(binId)?.L ?? 0;
  }

  sunkCostUsd(): number {
    return this.costs.filter((c) => !c.refundable).reduce((s, c) => s + c.usd, 0);
  }

  lockedRentUsd(): number {
    return this.costs.filter((c) => c.refundable).reduce((s, c) => s + c.usd, 0);
  }

  inRangeAt(activeId: number): boolean {
    return activeId >= this.lower && activeId <= this.upper;
  }
}

export interface Valuation {
  valueUsd: number;
  feeUsd: number;
  hodlUsd: number;
  ilUsd: number;
  costUsd: number;
  netPnlUsd: number;
  x: number;
  y: number;
}

/** USD valuation. X is valued at the current market (active bin) price, as in blueprint 12.4. */
export function valuePosition(
  p: VirtualPosition,
  activeId: number,
  fx: number,
  priceUi: number,
  quoteUsd: number,
  decX: number,
  decY: number,
): Valuation {
  const c = p.composition(activeId, fx);
  const toQuote = (xRaw: number, yRaw: number) => (xRaw / 10 ** decX) * priceUi + yRaw / 10 ** decY;
  const valueUsd = (toQuote(c.x, c.y) + p.realizedQuote) * quoteUsd;
  const feeUsd = toQuote(p.feeX, p.feeY) * quoteUsd;
  const hodlUsd = toQuote(p.x0, p.y0) * quoteUsd;
  const costUsd = p.sunkCostUsd();
  return {
    valueUsd, feeUsd, hodlUsd, ilUsd: valueUsd - hodlUsd, costUsd,
    netPnlUsd: valueUsd + feeUsd - p.spec.capitalUsd - costUsd,
    x: c.x, y: c.y,
  };
}
