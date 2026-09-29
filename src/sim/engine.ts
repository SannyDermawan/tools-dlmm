import { randomUUID } from "node:crypto";
import type { Config } from "../config/schema.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate, SwapRecord } from "../collectors/types.ts";
import { binRawPrice } from "../math/bin.ts";
import { CostModel, type CostContext, type CostItem } from "./costs.ts";
import { binCount, deltaRange, distributeFull, xValueFraction, type RangeSpec } from "./distribution.ts";
import { accumulatorFee, allocateSwapAcrossBins, dilutedShare } from "./feeAttribution.ts";
import { gapTaint, taintSource } from "./taint.ts";
import { valuePosition, VirtualPosition, type PositionSpec, type Valuation } from "./position.ts";

export interface SimEvent {
  positionId: string;
  ts: number;
  type: "open" | "fee" | "cross" | "rebalance" | "partial_exit" | "compound" | "exit_signal" | "exit" | "gap" | "fail";
  detail: Record<string, unknown>;
}

export interface PositionResult {
  positionId: string;
  feeUsd: number;
  feeXUi: number;
  feeYUi: number;
  ilUsd: number;
  costUsd: number;
  rentLockedUsd: number;
  netPnlUsd: number;
  netPnlPct: number;
  timeInRangePct: number;
  durationMin: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  finalValueUsd: number;
  hodlValueUsd: number;
  entryPrice: number;
  exitPrice: number;
  detail: Record<string, unknown>;
}

/** Where the simulator journals (DB in production, arrays in tests). */
export interface SimSink {
  positionCreated(p: VirtualPosition): void;
  positionUpdated(p: VirtualPosition): void;
  event(e: SimEvent): void;
  result(p: VirtualPosition, r: PositionResult): void;
}

export class MemorySink implements SimSink {
  created: VirtualPosition[] = [];
  events: SimEvent[] = [];
  results: PositionResult[] = [];
  positionCreated(p: VirtualPosition) { this.created.push(p); }
  positionUpdated() {}
  event(e: SimEvent) { this.events.push(e); }
  result(_p: VirtualPosition, r: PositionResult) { this.results.push(r); }
}

export interface MarketContext {
  quoteUsd: number | null;
  solUsd: number | null;
  priorityMicroLamports: number | null;
  /** aggregator one-way swap cost (%) of this pool and when it was quoted */
  swapCostPct?: number | null;
  swapQuoteTs?: number | null;
  /** pool TVL (USD) from the latest metrics: the depth a swap of our size moves */
  tvlUsd?: number | null;
}

/** Sources whose gaps make a position's result unreliable for calibration. */


/**
 * Demo DLMM simulator for ONE pool. All virtual positions of the pool share its data stream
 * (cost scales with pools, not positions). Feed it market events in timestamp order.
 */
/** Entry modes that honour simulation.avoid_bin_array_init (baseline always pays, as a control). */
const AVOID_INIT_MODES = new Set(["signal_enter", "signal_watch"]);

export class PoolSimulator {
  private state: PoolStateUpdate | null = null;
  private snap: BinSnapshot | null = null;
  private positions = new Map<string, VirtualPosition>();
  private costs: CostModel;
  readonly market: MarketContext = { quoteUsd: null, solUsd: null, priorityMicroLamports: null };
  /** x-value fraction of the real active bin (from the latest snapshot) */
  private activeFx = 0.5;
  private readonly sim: Config["simulation"];

  constructor(
    readonly meta: PoolMeta,
    config: Config,
    private readonly sink: SimSink,
    private readonly idGen: () => string = randomUUID,
  ) {
    this.sim = config.simulation;
    this.costs = new CostModel(config.simulation.costs);
  }

  /** true when every input needed to open a position is present */
  get ready(): boolean {
    return !!(this.state && this.snap && this.market.quoteUsd && this.market.solUsd);
  }

  /** pool_state (price) gaps of this pool, for deferring actions while the price is stale */
  private priceGaps = new Map<number, number | null>(); // start -> end (null: open)

  /**
   * true while the pool's price data is in a gap at time t (simulation.gap_taint.defer_actions):
   * the grid runner and the exit engine then wait for the first fresh update, as a real bot must.
   */
  priceStale(t: number): boolean {
    if (!this.sim.gap_taint.defer_actions) return false;
    for (const [start, end] of this.priceGaps) if (t >= start && (end === null || t < end)) return true;
    return false;
  }

  get now(): number {
    return this.state?.ts ?? 0;
  }

  list(): VirtualPosition[] {
    return [...this.positions.values()];
  }

  get(id: string) {
    return this.positions.get(id);
  }

  // ------------------------------------------------------------------ inputs

  onMarket(m: Partial<MarketContext>) {
    if (m.quoteUsd != null) this.market.quoteUsd = m.quoteUsd;
    if (m.solUsd != null) this.market.solUsd = m.solUsd;
    if (m.priorityMicroLamports != null) this.market.priorityMicroLamports = m.priorityMicroLamports;
    if (m.swapCostPct != null) {
      this.market.swapCostPct = m.swapCostPct;
      this.market.swapQuoteTs = m.swapQuoteTs ?? this.now;
    }
    if (m.tvlUsd != null && m.tvlUsd > 0) this.market.tvlUsd = m.tvlUsd;
  }

  /**
   * Transfer fee (bps) of a token-2022 mint, 0 when none / unknown. Set by the session or replay
   * (token_security); the simulator itself never reads the database.
   */
  transferFeeBps: (token: string) => number | null = () => null;

  /** Tax (USD) when `usd` of `token` moves once (deposit, withdrawal, claim or one swap leg). */
  private taxUsd(token: string, usd: number): number {
    if (!this.sim.costs.transfer_tax || usd <= 0) return 0;
    const bps = this.transferFeeBps(token);
    return bps ? (usd * bps) / 10_000 : 0;
  }

  /** transfer_tax cost item for `legsX` moves of the X value and `legsY` moves of the Y value (null when none). */
  private taxItem(xUsd: number, yUsd: number, label = "transfer_tax"): CostItem | null {
    const usd = this.taxUsd(this.meta.tokenX, xUsd) + this.taxUsd(this.meta.tokenY, yUsd);
    return usd > 0 ? { type: label, usd, refundable: false, detail: { xUsd, yUsd } } : null;
  }

  /**
   * Fraction charged for a balancing / exit swap. aggregator model: the latest Jupiter round-trip
   * quote (fresh within max_quote_age_minutes), else the fallback capped by the pool fee (the
   * aggregator never routes worse than this pool); pool model: the DLMM pool fee.
   */
  swapRate(poolFeeRate: number, notionalUsd = 0): number {
    const k = this.sim.costs;
    let rate: number;
    if (k.swap_model === "pool") rate = poolFeeRate;
    else {
      const q = this.market.swapCostPct;
      const fresh = q != null && this.market.swapQuoteTs != null && this.now - this.market.swapQuoteTs <= k.aggregator.max_quote_age_minutes * 60_000;
      rate = fresh ? Math.min(q! / 100, poolFeeRate) : Math.min(k.aggregator.fallback_cost_pct / 100, poolFeeRate);
    }
    return rate + this.sizeImpact(notionalUsd);
  }

  /**
   * Extra price impact (fraction) of a swap larger than the quoted trade, at the pool's TVL of this
   * moment (constant-product depth: V / (depth_factor x TVL)); the quote / pool-fee part already
   * covers a trade of `quote_notional_usd`, so only the excess is added. Taken at the time of the
   * swap, so a dump that emptied the pool makes the exit expensive.
   */
  sizeImpact(notionalUsd: number): number {
    const k = this.sim.costs;
    const tvl = this.market.tvlUsd;
    if (!k.size_impact.enabled || !tvl || notionalUsd <= 0) return 0;
    const at = (v: number) => v / (k.size_impact.depth_factor * tvl);
    const extra = Math.max(0, at(notionalUsd) - at(k.aggregator.quote_notional_usd));
    return Math.min(k.size_impact.max_pct / 100, extra);
  }

  onState(u: PoolStateUpdate) {
    if (u.pool !== this.meta.pool) return;
    if (this.state && u.ts < this.state.ts) return; // out of order
    this.state = u;
    if (this.snap && this.snap.activeId !== u.activeId) this.activeFx = this.fxGuess(u.activeId);
    this.activatePending(u.ts);
    for (const p of this.positions.values()) if (p.status === "active") this.mark(p, u.ts);
  }

  onBins(s: BinSnapshot) {
    if (s.pool !== this.meta.pool) return;
    const prev = this.snap;
    if (prev && s.ts <= prev.ts) return;
    if (prev && this.sim.fee_attribution === "accumulator") {
      for (const p of this.positions.values()) {
        // Accrue only over intervals fully inside the position's life (pessimistic at both ends).
        if (p.status !== "active" || p.accrualFrom === null || prev.ts < p.accrualFrom) continue;
        for (const [id, b] of p.bins) {
          const f = accumulatorFee(prev.bins.get(id), s.bins.get(id), b.L);
          p.feeX += f.fx;
          p.feeY += f.fy;
        }
      }
    }
    this.snap = s;
    const a = s.bins.get(s.activeId);
    this.activeFx = a ? binXFrac(a) : this.fxGuess(s.activeId);
  }

  onSwap(sw: SwapRecord) {
    if (sw.pool !== this.meta.pool || this.sim.fee_attribution !== "swap_events" || !this.snap) return;
    const lpFee = Number(sw.mmFee);
    if (lpFee <= 0) return;
    const alloc = allocateSwapAcrossBins(
      { startBin: sw.startBin, endBin: sw.endBin, swapForY: sw.swapForY, amountIn: Number(sw.amountIn) },
      this.snap.bins,
    );
    for (const p of this.positions.values()) {
      if (p.status !== "active" || p.accrualFrom === null || sw.ts < p.accrualFrom) continue;
      for (const [id, share] of alloc) {
        const L = p.liquidityAt(id);
        if (L <= 0) continue;
        const b = this.snap.bins.get(id);
        const S = b ? Number(b.supply) / 2 ** 64 : 0;
        const f = dilutedShare(lpFee * share, L, S);
        if (sw.feeOnX) p.feeX += f;
        else p.feeY += f;
      }
    }
  }

  onGap(g: { source: string; start: number; end: number | null }) {
    if (g.source === "pool_state") {
      this.priceGaps.set(g.start, g.end);
      if (this.priceGaps.size > 200) this.priceGaps.delete(this.priceGaps.keys().next().value!); // oldest
    }
    if (!taintSource(g.source, this.sim.fee_attribution)) return;
    const end = g.end ?? Number.MAX_SAFE_INTEGER;
    for (const p of this.positions.values()) {
      if (p.status !== "active" && p.status !== "closed") continue;
      const from = p.openedAt ?? p.requestedAt;
      const to = p.closedAt ?? Number.MAX_SAFE_INTEGER;
      if (g.start > to || end < from) continue;
      const key = `${g.source}|${g.start}`;
      if (!p.gapIntervals.has(key)) this.sink.event({ positionId: p.id, ts: Math.max(g.start, from), type: "gap", detail: g });
      p.gapIntervals.set(key, { source: g.source, start: g.start, end: g.end });
      this.retaint(p, this.now);
    }
  }

  /** Re-evaluate the gap taint of a position (proportional rule, see taint.ts). */
  private retaint(p: VirtualPosition, now: number) {
    if (!p.gapIntervals.size) return;
    const from = p.openedAt ?? p.requestedAt;
    const to = p.closedAt ?? Math.max(now, from);
    p.taint = gapTaint(p.gapIntervals.values(), p.actionTimes, from, to, this.sim.gap_taint);
    if (p.taint.tainted !== p.gapTainted) {
      p.gapTainted = p.taint.tainted;
      this.sink.positionUpdated(p);
    }
  }

  /** Record an action time (open / rebalance / partial / compound / close) for the gap taint. */
  private acted(p: VirtualPosition, ts: number) {
    p.actionTimes.push(ts);
    this.retaint(p, ts);
  }

  // ------------------------------------------------------------------ orders

  /** Request a virtual position; it becomes active after the entry delay, at the price then. */
  request(spec: PositionSpec, ts = this.now): VirtualPosition {
    const p = new VirtualPosition(this.idGen(), this.meta.pool, spec, ts, ts + this.sim.entry_delay_seconds * 1000);
    this.positions.set(p.id, p);
    this.sink.positionCreated(p);
    if (this.state && this.state.ts >= p.activateAt) this.activatePending(this.state.ts);
    return p;
  }

  private costCtx(): CostContext {
    return { solUsd: this.market.solUsd ?? 0, priorityMicroLamports: this.market.priorityMicroLamports };
  }

  private fail(p: VirtualPosition, reason: string, ts: number) {
    p.status = "failed";
    p.failReason = reason;
    p.closedAt = ts;
    p.closeReason = `failed:${reason}`;
    this.sink.event({ positionId: p.id, ts, type: "fail", detail: { reason } });
    this.sink.positionUpdated(p);
  }

  private activatePending(ts: number) {
    for (const p of this.positions.values()) {
      if (p.status !== "pending" || ts < p.activateAt) continue;
      const missing = [
        !this.state && "pool_state", !this.snap && "bin_snapshot",
        !this.market.quoteUsd && "quote_usd", !this.market.solUsd && "sol_usd",
      ].filter(Boolean);
      if (missing.length) {
        if (ts - p.activateAt > 120_000) this.fail(p, `no_data:${missing.join(",")}`, ts);
        continue;
      }
      this.activate(p, ts);
    }
  }

  private activate(p: VirtualPosition, ts: number) {
    const st = this.state!;
    const m = this.meta;
    const r: RangeSpec = { strategy: p.spec.strategy, sides: p.spec.sides, binsBelow: p.spec.binsBelow, binsAbove: p.spec.binsAbove };
    const n = binCount(r);
    if (n > this.sim.max_bins_per_position) return this.fail(p, `too_many_bins:${n}`, ts);
    const quoteUsd = this.market.quoteUsd!;
    const priceUi = st.priceUi;
    const xFrac = xValueFraction(r, this.sim.two_sided_x_value_fraction);
    // size vs pool liquidity (simulation.size_limit): journal, shrink or refuse
    const tvl = this.market.tvlUsd ?? null;
    const lim = this.sim.size_limit;
    if (tvl) {
      const maxUsd = (tvl * lim.max_pct_of_tvl) / 100;
      if (p.spec.capitalUsd > maxUsd) {
        if (lim.mode === "skip") return this.fail(p, "oversized_vs_tvl", ts);
        if (lim.mode === "cap") {
          p.cappedFromUsd = p.spec.capitalUsd;
          p.spec.capitalUsd = Math.max(1, maxUsd);
        }
      }
    }
    const cap = p.spec.capitalUsd;
    p.tvlOpenUsd = tvl;
    p.sizePctTvl = tvl ? (cap / tvl) * 100 : null;
    const placed = this.place(p, r, cap, xFrac);
    p.x0 = placed.x;
    p.y0 = placed.y;
    p.entryActiveId = st.activeId;
    p.entryPriceUi = priceUi;
    p.entryQuoteUsd = quoteUsd;
    // addendum 3.5: optionally skip signal-mode ranges that would pay a (non-refundable) bin array init
    if (this.sim.avoid_bin_array_init && AVOID_INIT_MODES.has(p.spec.entryMode) &&
        this.costs.binArrayInit(p.lower, p.upper, this.snap?.missingBinArrays ?? [], this.costCtx())) {
      return this.fail(p, "bin_array_init_avoided", ts);
    }
    p.openedAt = ts;
    p.actionTimes.push(ts);
    p.accrualFrom = ts;
    p.lastMarkTs = ts;
    p.lastFeeEventTs = ts;
    p.status = "active";
    p.inRange = true;

    // --- costs (blueprint 12.5)
    const ctx = this.costCtx();
    const items: CostItem[] = [this.costs.txCost("open", ctx, n), this.costs.positionRent(n, ctx)];
    const ba = this.costs.binArrayInit(p.lower, p.upper, this.snap?.missingBinArrays ?? [], ctx);
    if (ba) items.push(ba);
    if (this.sim.starting_asset === "quote" && xFrac > 0) {
      items.push(this.costs.txCost("swap", ctx), this.costs.swapCost(cap * xFrac, this.swapRate(st.feeRateTotal, cap * xFrac)));
    }
    // token-2022 transfer fee: the X part is received from the swap (when bought) and deposited; Y is deposited
    const tax = this.taxItem(cap * xFrac * (this.sim.starting_asset === "quote" ? 2 : 1), cap * (1 - xFrac));
    if (tax) items.push(tax);
    const activeL = p.liquidityAt(st.activeId);
    if (activeL > 0) {
      const depFx = p.spec.sides === "base_only" ? 1 : 0; // SDK: two-sided puts Y in the active bin
      const cf = this.costs.compositionFee((activeL / 10 ** m.decimalsY) * quoteUsd, depFx, this.activeFx, st.feeRateTotal);
      if (cf) items.push(cf);
    }
    p.costs.push(...items);
    const v = this.valuation(p);
    p.peakEquityUsd = v.valueUsd + v.feeUsd - v.costUsd;
    p.last = { valueUsd: v.valueUsd, feeUsd: v.feeUsd, hodlUsd: v.hodlUsd, priceUi, quoteUsd };
    this.sink.event({
      positionId: p.id, ts, type: "open",
      detail: {
        activeId: st.activeId, price: priceUi, quoteUsd, lower: p.lower, upper: p.upper, bins: n, xFrac,
        depositX: p.x0 / 10 ** m.decimalsX, depositY: p.y0 / 10 ** m.decimalsY,
        idleX: p.idleX / 10 ** m.decimalsX, idleY: p.idleY / 10 ** m.decimalsY,
        tvlUsd: tvl, sizePctTvl: p.sizePctTvl, cappedFromUsd: p.cappedFromUsd,
        valueUsd: v.valueUsd, delayMs: ts - p.requestedAt,
        costs: items.map((c) => ({ type: c.type, usd: c.usd, refundable: c.refundable })),
      },
    });
    this.sink.positionUpdated(p);
  }

  /**
   * Distribute `valueUsd` over the range centred on the current active bin (SDK shapes).
   * Replaces the position's bins; returns the raw token amounts deposited (incl. idle dust).
   */
  private place(p: VirtualPosition, r: RangeSpec, valueUsd: number, xFrac: number): { x: number; y: number } {
    const st = this.state!;
    const m = this.meta;
    const quoteUsd = this.market.quoteUsd!;
    const xRaw = BigInt(Math.max(0, Math.floor(((valueUsd * xFrac) / (st.priceUi * quoteUsd)) * 10 ** m.decimalsX)));
    const yRaw = BigInt(Math.max(0, Math.floor(((valueUsd * (1 - xFrac)) / quoteUsd) * 10 ** m.decimalsY)));
    const dist = distributeFull(st.activeId, m.binStep, r, xRaw, yRaw);
    let usedX = 0n;
    let usedY = 0n;
    p.bins.clear();
    for (const b of dist) {
      usedX += b.x;
      usedY += b.y;
      const priceRaw = this.snap?.bins.get(b.binId)?.priceRaw || binRawPrice(b.binId, m.binStep);
      const L = priceRaw * Number(b.x) + Number(b.y);
      if (L > 0) p.bins.set(b.binId, { L, priceRaw });
    }
    const d = deltaRange(r);
    p.lower = st.activeId + d.minDelta;
    p.upper = st.activeId + d.maxDelta;
    p.idleX = Number(xRaw - usedX);
    p.idleY = Number(yRaw - usedY);
    return { x: Number(xRaw), y: Number(yRaw) };
  }

  /** Cost (USD) a rebalance would have right now: tx + balancing swap + missing bin arrays. */
  estimateRebalanceCostUsd(id: string): number | null {
    const p = this.positions.get(id);
    if (!p || p.status !== "active" || !this.state || !this.market.quoteUsd) return null;
    const st = this.state;
    const r = rangeOf(p);
    const xFrac = xValueFraction(r, this.sim.two_sided_x_value_fraction);
    const v = this.valuation(p);
    const heldXUsd = (v.x / 10 ** this.meta.decimalsX) * st.priceUi * this.market.quoteUsd;
    const liquid = v.valueUsd - p.realizedQuote * this.market.quoteUsd; // withdrawn cash is not redeployed
    const notional = Math.abs(heldXUsd - liquid * xFrac);
    const ctx = this.costCtx();
    let usd = this.costs.txCost("rebalance", ctx, binCount(r)).usd;
    if (notional > 0.01) usd += this.costs.txCost("swap", ctx).usd + this.costs.swapCost(notional, this.swapRate(st.feeRateTotal, notional)).usd;
    usd += this.taxItem(heldXUsd + liquid * xFrac + notional, liquid - heldXUsd + liquid * (1 - xFrac) + notional)?.usd ?? 0;
    const d = deltaRange(r);
    const ba = this.costs.binArrayInit(st.activeId + d.minDelta, st.activeId + d.maxDelta, this.snap?.missingBinArrays ?? [], ctx);
    if (ba) usd += ba.usd;
    return usd;
  }

  /**
   * Rebalance: withdraw everything and redeploy the current value around the current active bin
   * with the same strategy / width / sides. Full cost: rebalance tx(s) + balancing swap + new bin
   * arrays + composition fee (blueprint 15). Accrued fees and the original HODL basket are kept.
   */
  rebalance(id: string, reason: string, ts = this.now, override?: RangeSpec): boolean {
    const p = this.positions.get(id);
    if (!p || p.status !== "active" || !this.state || !this.market.quoteUsd) return false;
    this.mark(p, ts);
    const st = this.state;
    const m = this.meta;
    const quoteUsd = this.market.quoteUsd;
    const before = this.valuation(p);
    const oldRange = { lower: p.lower, upper: p.upper };
    if (override) p.rangeOverride = override;
    const r = rangeOf(p);
    const xFrac = xValueFraction(r, this.sim.two_sided_x_value_fraction);
    const heldXUsd = (before.x / 10 ** m.decimalsX) * st.priceUi * quoteUsd;
    // only the liquidity still in the pool is redeployed; cash from partial exits stays cash
    const liquidUsd = before.valueUsd - p.realizedQuote * quoteUsd;
    const targetXUsd = liquidUsd * xFrac;
    this.place(p, r, liquidUsd, xFrac);
    const ctx = this.costCtx();
    const items: CostItem[] = [this.costs.txCost("rebalance", ctx, binCount(r))];
    const notional = Math.abs(heldXUsd - targetXUsd);
    if (notional > 0.01) items.push(this.costs.txCost("swap", ctx), this.costs.swapCost(notional, this.swapRate(st.feeRateTotal, notional)));
    // transfer fee: withdraw everything, redeploy the target, plus the swap leg
    const rtax = this.taxItem(heldXUsd + targetXUsd + notional, Math.max(0, liquidUsd - heldXUsd) + (liquidUsd - targetXUsd) + notional);
    if (rtax) items.push(rtax);
    const ba = this.costs.binArrayInit(p.lower, p.upper, this.snap?.missingBinArrays ?? [], ctx);
    if (ba) items.push(ba);
    const activeL = p.liquidityAt(st.activeId);
    if (activeL > 0) {
      const cf = this.costs.compositionFee((activeL / 10 ** m.decimalsY) * quoteUsd, p.spec.sides === "base_only" ? 1 : 0, this.activeFx, st.feeRateTotal);
      if (cf) items.push(cf);
    }
    p.costs.push(...items);
    p.rebalanceCount++;
    p.accrualFrom = ts;
    p.inRange = true;
    p.outOfRangeSince = null;
    this.acted(p, ts);
    this.sink.event({
      positionId: p.id, ts, type: "rebalance",
      detail: {
        reason, n: p.rebalanceCount, activeId: st.activeId, price: st.priceUi, from: oldRange, to: { lower: p.lower, upper: p.upper },
        valueUsd: before.valueUsd, redeployedUsd: liquidUsd, swapNotionalUsd: notional, costs: items.map((c) => ({ type: c.type, usd: c.usd })),
      },
    });
    this.sink.positionUpdated(p);
    return true;
  }

  /**
   * Partial exit (KELUAR SEBAGIAN): withdraw `fraction` of every bin and of the idle balance. The
   * withdrawn tokens are valued at the current price and kept as cash in the position (they no
   * longer earn fees or take IL); a withdrawal transaction is charged.
   */
  partialClose(id: string, fraction: number, reason: string, ts = this.now): boolean {
    const p = this.positions.get(id);
    if (!p || p.status !== "active" || !this.state || fraction <= 0) return false;
    if (fraction >= 1) return this.close(id, reason, ts) !== null;
    this.mark(p, ts);
    const st = this.state;
    const m = this.meta;
    const c = p.composition(st.activeId, this.activeFx);
    const withdrawnQuote = ((c.x * fraction) / 10 ** m.decimalsX) * st.priceUi + (c.y * fraction) / 10 ** m.decimalsY;
    for (const b of p.bins.values()) b.L *= 1 - fraction;
    p.idleX *= 1 - fraction;
    p.idleY *= 1 - fraction;
    p.realizedQuote += withdrawnQuote;
    p.partialExits++;
    const items: CostItem[] = [this.costs.txCost("close", this.costCtx(), p.upper - p.lower + 1)];
    const pq = this.market.quoteUsd ?? p.entryQuoteUsd;
    const wxUsd = ((c.x * fraction) / 10 ** m.decimalsX) * st.priceUi * pq;
    const wyUsd = ((c.y * fraction) / 10 ** m.decimalsY) * pq;
    if (this.sim.exit_to === "quote") {
      if (wxUsd > 0) items.push(this.costs.swapCost(wxUsd, this.swapRate(st.feeRateTotal, wxUsd), "exit_swap"));
    }
    const ptax = this.taxItem(wxUsd + (this.sim.exit_to === "quote" ? wxUsd : 0), wyUsd + (this.sim.exit_to === "quote" ? wxUsd : 0));
    if (ptax) items.push(ptax);
    p.costs.push(...items);
    this.acted(p, ts);
    this.sink.event({
      positionId: p.id, ts, type: "partial_exit",
      detail: { reason, fraction, withdrawnQuote, price: st.priceUi, costs: items.map((x) => ({ type: x.type, usd: x.usd })) },
    });
    this.sink.positionUpdated(p);
    return true;
  }

  /**
   * single_sided_reseed (addendum 2.2): when price fell below the range and the position is
   * (almost) entirely base token, withdraw it and reopen base-only above the new active bin with
   * the same number of bins. Charged like a rebalance (withdraw + deposit tx, new bin arrays; the
   * balancing swap is ~0 because the tokens already are base).
   */
  reseed(id: string, ts = this.now, minXShare = 0.99): boolean {
    const p = this.positions.get(id);
    if (!p || p.status !== "active" || !this.state || !this.market.quoteUsd) return false;
    const st = this.state;
    if (st.activeId >= p.lower) return false;
    const v = this.valuation(p);
    const liquid = v.valueUsd - p.realizedQuote * this.market.quoteUsd;
    const xUsd = (v.x / 10 ** this.meta.decimalsX) * st.priceUi * this.market.quoteUsd;
    if (liquid <= 0 || xUsd / liquid < minXShare) return false;
    const n = binCount(rangeOf(p));
    const r: RangeSpec = { strategy: p.spec.strategy, sides: "base_only", binsBelow: 0, binsAbove: Math.max(0, n - 1) };
    if (!this.rebalance(id, "single_sided_reseed", ts, r)) return false;
    p.rebalanceCount--; // a reseed is counted separately from rebalances
    p.reseeds++;
    return true;
  }

  /**
   * fee_compounding (addendum 2.2): claim the accrued fees and add them back to the position with
   * the same shape. Liquidity of every bin grows by fee value / liquid value; costs: claim tx +
   * add-liquidity tx(s) + a swap of the fee value that does not match the position composition.
   */
  compoundFees(id: string, ts = this.now): boolean {
    const p = this.positions.get(id);
    if (!p || p.status !== "active" || !this.state || !this.market.quoteUsd) return false;
    this.mark(p, ts);
    const st = this.state;
    const m = this.meta;
    const q = this.market.quoteUsd;
    const v = this.valuation(p);
    const liquidUsd = v.valueUsd - p.realizedQuote * q;
    if (v.feeUsd <= 0 || liquidUsd <= 0) return false;
    const k = 1 + v.feeUsd / liquidUsd;
    const xShare = ((v.x / 10 ** m.decimalsX) * st.priceUi * q) / liquidUsd;
    const feeXUsd = (p.feeX / 10 ** m.decimalsX) * st.priceUi * q;
    const notional = Math.abs(feeXUsd - v.feeUsd * xShare);
    for (const b of p.bins.values()) b.L *= k;
    p.idleX *= k;
    p.idleY *= k;
    p.x0 += p.feeX; // the HODL basket includes the reinvested fee tokens
    p.y0 += p.feeY;
    p.feeX = 0;
    p.feeY = 0;
    p.compoundedFeeUsd += v.feeUsd;
    p.compounds++;
    const ctx = this.costCtx();
    const bins = p.upper - p.lower + 1;
    const items: CostItem[] = [this.costs.txCost("claim", ctx, bins), this.costs.txCost("add", ctx, bins)];
    if (notional > 0.01) items.push(this.costs.txCost("swap", ctx), this.costs.swapCost(notional, this.swapRate(st.feeRateTotal, notional)));
    // transfer fee: claim the fees, swap the mismatch, deposit them again
    const ctax = this.taxItem(feeXUsd + xShare * v.feeUsd + notional, Math.max(0, v.feeUsd - feeXUsd) + (1 - xShare) * v.feeUsd + notional);
    if (ctax) items.push(ctax);
    p.costs.push(...items);
    this.acted(p, ts);
    this.sink.event({
      positionId: p.id, ts, type: "compound",
      detail: { feeUsd: v.feeUsd, n: p.compounds, liquidUsd, swapNotionalUsd: notional, costs: items.map((c) => ({ type: c.type, usd: c.usd })) },
    });
    this.sink.positionUpdated(p);
    return true;
  }

  /** Journal an exit-engine decision (TAHAN is not journaled). */
  logExitSignal(id: string, ts: number, detail: Record<string, unknown>) {
    this.sink.event({ positionId: id, ts, type: "exit_signal", detail });
  }

  // ------------------------------------------------------------------ marking

  private fxGuess(activeId: number): number {
    // Active bin unknown in the latest snapshot: when price moved up the new active bin came from
    // the X side, when down from the Y side; without better data use the midpoint.
    void activeId;
    return 0.5;
  }

  valuation(p: VirtualPosition): Valuation {
    const st = this.state!;
    const q = this.market.quoteUsd ?? p.entryQuoteUsd;
    return valuePosition(p, st.activeId, this.activeFx, st.priceUi, q, this.meta.decimalsX, this.meta.decimalsY);
  }

  private mark(p: VirtualPosition, ts: number) {
    const st = this.state!;
    const dt = Math.max(0, ts - p.lastMarkTs);
    p.activeMs += dt;
    if (p.inRange) p.inRangeMs += dt;
    p.lastMarkTs = ts;
    const nowIn = p.inRangeAt(st.activeId);
    if (nowIn !== p.inRange) {
      p.inRange = nowIn;
      p.crossCount++;
      p.outOfRangeSince = nowIn ? null : ts;
      this.sink.event({
        positionId: p.id, ts, type: "cross",
        detail: { direction: nowIn ? "enter" : "exit", activeId: st.activeId, side: st.activeId > p.upper ? "above" : st.activeId < p.lower ? "below" : "in" },
      });
    }
    const v = this.valuation(p);
    const equity = v.valueUsd + v.feeUsd - v.costUsd;
    if (equity > p.peakEquityUsd) p.peakEquityUsd = equity;
    const dd = p.peakEquityUsd - equity;
    if (dd > p.maxDrawdownUsd) {
      p.maxDrawdownUsd = dd;
      p.maxDrawdownPct = p.peakEquityUsd > 0 ? (dd / p.peakEquityUsd) * 100 : 0;
    }
    p.last = { valueUsd: v.valueUsd, feeUsd: v.feeUsd, hodlUsd: v.hodlUsd, priceUi: st.priceUi, quoteUsd: this.market.quoteUsd ?? p.entryQuoteUsd };
    if (ts - p.lastFeeEventTs >= this.sim.fee_event_interval_seconds * 1000) {
      p.lastFeeEventTs = ts;
      this.sink.event({
        positionId: p.id, ts, type: "fee",
        detail: {
          feeX: p.feeX / 10 ** this.meta.decimalsX, feeY: p.feeY / 10 ** this.meta.decimalsY, feeUsd: v.feeUsd,
          valueUsd: v.valueUsd, ilUsd: v.ilUsd, netPnlUsd: v.netPnlUsd, inRange: nowIn, activeId: st.activeId,
        },
      });
    }
  }

  // ------------------------------------------------------------------ closing

  close(id: string, reason: string, ts = this.now): PositionResult | null {
    const p = this.positions.get(id);
    if (!p) return null;
    if (p.status === "pending") {
      this.fail(p, `closed_before_active:${reason}`, ts);
      return null;
    }
    if (p.status !== "active") return null;
    this.mark(p, ts);
    const ctx = this.costCtx();
    const st = this.state!;
    const exitCosts: CostItem[] = [this.costs.txCost("close", ctx, p.upper - p.lower + 1)];
    const pre = this.valuation(p);
    const cq = this.market.quoteUsd ?? p.entryQuoteUsd;
    const xUsd = (pre.x / 10 ** this.meta.decimalsX) * st.priceUi * cq;
    const yUsd = (pre.y / 10 ** this.meta.decimalsY) * cq;
    if (this.sim.exit_to === "quote") {
      if (xUsd > 0) exitCosts.push(this.costs.txCost("swap", ctx), this.costs.swapCost(xUsd, this.swapRate(st.feeRateTotal, xUsd), "exit_swap"));
    }
    // transfer fee: withdrawal and claim of both tokens, and the swap leg when the tokens are sold
    const feeXUsd = (p.feeX / 10 ** this.meta.decimalsX) * st.priceUi * cq;
    const feeYUsd = (p.feeY / 10 ** this.meta.decimalsY) * cq;
    const legs = this.sim.exit_to === "quote" ? xUsd : 0;
    const ctax = this.taxItem(xUsd + feeXUsd + legs, yUsd + feeYUsd + legs);
    if (ctax) exitCosts.push(ctax);
    p.costs.push(...exitCosts);
    const v = this.valuation(p);
    p.status = "closed";
    p.closedAt = ts;
    p.closeReason = reason;
    this.acted(p, ts);
    const cap = p.spec.capitalUsd;
    const dur = (ts - (p.openedAt ?? ts)) / 60000;
    const quoteUsd = this.market.quoteUsd ?? p.entryQuoteUsd;
    const result: PositionResult = {
      positionId: p.id,
      feeUsd: v.feeUsd + p.compoundedFeeUsd,
      feeXUi: p.feeX / 10 ** this.meta.decimalsX,
      feeYUi: p.feeY / 10 ** this.meta.decimalsY,
      ilUsd: v.ilUsd,
      costUsd: v.costUsd,
      rentLockedUsd: p.lockedRentUsd(),
      netPnlUsd: v.netPnlUsd,
      netPnlPct: (v.netPnlUsd / cap) * 100,
      timeInRangePct: p.activeMs > 0 ? (p.inRangeMs / p.activeMs) * 100 : 0,
      durationMin: dur,
      maxDrawdownUsd: p.maxDrawdownUsd,
      maxDrawdownPct: p.maxDrawdownPct,
      finalValueUsd: v.valueUsd,
      hodlValueUsd: v.hodlUsd,
      entryPrice: p.entryPriceUi,
      exitPrice: st.priceUi,
      detail: {
        pnlVsHodlUsd: v.valueUsd + v.feeUsd - v.costUsd - v.hodlUsd,
        netPnlQuote: (v.valueUsd + v.feeUsd - v.costUsd) / quoteUsd - cap / p.entryQuoteUsd,
        entryQuoteUsd: p.entryQuoteUsd,
        exitQuoteUsd: quoteUsd,
        finalX: v.x / 10 ** this.meta.decimalsX,
        finalY: v.y / 10 ** this.meta.decimalsY,
        crossings: p.crossCount,
        rebalances: p.rebalanceCount,
        partialExits: p.partialExits,
        realizedQuote: p.realizedQuote,
        variant: p.spec.variant ?? "none",
        reseeds: p.reseeds,
        compounds: p.compounds,
        compoundedFeeUsd: p.compoundedFeeUsd,
        feeAttribution: this.sim.fee_attribution,
        costs: p.costs.map((c) => ({ type: c.type, usd: c.usd, refundable: c.refundable })),
        sizePctTvl: p.sizePctTvl,
        tvlOpenUsd: p.tvlOpenUsd,
        tvlCloseUsd: this.market.tvlUsd ?? null,
        cappedFromUsd: p.cappedFromUsd,
        gapTainted: p.gapTainted,
        gapMinutes: p.taint ? p.taint.gapMs / 60_000 : 0,
        gapFraction: p.taint?.fraction ?? 0,
        taintReason: p.taint?.reason ?? null,
      },
    };
    this.sink.event({ positionId: p.id, ts, type: "exit", detail: { reason, netPnlUsd: v.netPnlUsd, feeUsd: v.feeUsd, ilUsd: v.ilUsd, price: st.priceUi } });
    this.sink.positionUpdated(p);
    this.sink.result(p, result);
    return result;
  }

  closeAll(reason: string, ts = this.now): PositionResult[] {
    const out: PositionResult[] = [];
    for (const p of this.positions.values()) {
      if (p.status === "active" || p.status === "pending") {
        const r = this.close(p.id, reason, ts);
        if (r) out.push(r);
      }
    }
    return out;
  }
}

/** Range of a position: the spec range, or the one set by a single-sided reseed. */
export function rangeOf(p: VirtualPosition): RangeSpec {
  return p.rangeOverride ?? { strategy: p.spec.strategy, sides: p.spec.sides, binsBelow: p.spec.binsBelow, binsAbove: p.spec.binsAbove };
}

/** x-value fraction of a bin: P*x / (P*x + y). */
export function binXFrac(b: BinObs): number {
  const xv = Number(b.x) * b.priceRaw;
  const t = xv + Number(b.y);
  return t > 0 ? xv / t : 0.5;
}
