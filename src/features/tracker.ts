import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate, SwapRecord } from "../collectors/types.ts";
import { Q64_NUM } from "../math/bin.ts";

/** Look-ahead guard (blueprint 17.1): a tracker can never contain data newer than the decision. */
export class LookaheadError extends Error {}

export interface PricePoint {
  ts: number;
  price: number;
  activeId: number;
  feeRate: number;
}

export interface FeeInterval {
  ts: number; // end of the interval (snapshot time)
  dtMs: number;
  usd: number; // LP fee paid in the pool during the interval (all observed bins)
  byOffset: Map<number, number>; // usd by (bin - active at interval end)
  /** existing liquidity (USD) by offset from the active bin at the start of the interval */
  depthByOffset: Map<number, number>;
  supplyChanges: number; // bins within +-k of active whose supply changed (LP add/remove)
}

export interface SwapObs {
  ts: number;
  wallet: string;
  buy: boolean; // Y in, X out: price up
  usd: number;
}

export interface MetricsObs {
  ts: number;
  tvlUsd: number | null;
  volume1h: number | null;
  volume24h: number | null;
  fee1h: number | null;
  feeTvl1h: number | null;
  xUsd: number | null;
  yUsd: number | null;
}

/**
 * Rolling, look-ahead-free view of one pool. It is fed market events in time order (live bus or
 * replay) and keeps only what feature computation needs. `assertNotAfter(t)` is the explicit
 * guard used by the scorer: every stored item has ts <= t.
 */
export class PoolTracker {
  prices: PricePoint[] = [];
  fees: FeeInterval[] = [];
  swaps: SwapObs[] = [];
  /** per-minute swap-like transaction counts seen by the socket (complete, free) */
  activity: { ts: number; candidates: number; sampled: number }[] = [];
  metrics: MetricsObs | null = null;
  metricsHistory: { ts: number; volume1h: number }[] = [];
  snap: BinSnapshot | null = null;
  /** token reserves of the observed bins per snapshot (raw units; rug detection, phase 10) */
  reserves: { ts: number; x: number; y: number }[] = [];
  private prevSnap: BinSnapshot | null = null;
  gaps: { source: string; start: number; end: number | null }[] = [];
  lastEventTs = 0;
  firstEventTs = 0;
  /** false when the swap stream is not collected for this pool (flow features unavailable) */
  swapsCollected = true;

  constructor(
    readonly meta: PoolMeta,
    private readonly keepMs: number,
    private readonly depthBins: number,
    private readonly feeOffsets: number,
  ) {}

  private seen(ts: number) {
    if (!this.firstEventTs) this.firstEventTs = ts;
    if (ts > this.lastEventTs) this.lastEventTs = ts;
  }

  assertNotAfter(t: number) {
    if (this.lastEventTs > t) throw new LookaheadError(`tracker ${this.meta.pool} has data at ${this.lastEventTs} > decision ${t}`);
  }

  private trim(now: number) {
    const cut = now - this.keepMs;
    const drop = <T extends { ts: number }>(a: T[]) => {
      let i = 0;
      while (i < a.length && a[i].ts < cut) i++;
      if (i) a.splice(0, i);
    };
    drop(this.prices);
    drop(this.fees);
    drop(this.swaps);
    drop(this.activity);
    drop(this.metricsHistory);
    drop(this.reserves);
    this.gaps = this.gaps.filter((g) => g.end === null || g.end >= cut);
  }

  onState(u: PoolStateUpdate) {
    if (u.pool !== this.meta.pool) return;
    const last = this.prices[this.prices.length - 1];
    if (last && u.ts <= last.ts) return;
    this.prices.push({ ts: u.ts, price: u.priceUi, activeId: u.activeId, feeRate: u.feeRateTotal });
    this.seen(u.ts);
    this.trim(u.ts);
  }

  onBins(s: BinSnapshot) {
    if (s.pool !== this.meta.pool) return;
    if (this.snap && s.ts <= this.snap.ts) return;
    this.prevSnap = this.snap;
    this.snap = s;
    this.seen(s.ts);
    let rx = 0, ry = 0;
    for (const b of s.bins.values()) (rx += Number(b.x)), (ry += Number(b.y));
    this.reserves.push({ ts: s.ts, x: rx, y: ry });
    const prev = this.prevSnap;
    if (prev && this.metrics?.xUsd != null && this.metrics?.yUsd != null) {
      const { xUsd, yUsd } = this.metrics;
      const dx = this.meta.decimalsX;
      const dy = this.meta.decimalsY;
      let usd = 0;
      let changes = 0;
      const byOffset = new Map<number, number>();
      for (const [id, c] of s.bins) {
        const p = prev.bins.get(id);
        if (!p) continue;
        if (Math.abs(id - s.activeId) <= this.depthBins && p.supply !== c.supply) changes++;
        const fx = c.feeX - p.feeX;
        const fy = c.feeY - p.feeY;
        if (fx < 0n || fy < 0n || (fx === 0n && fy === 0n)) continue;
        const S = Number(p.supply) / Q64_NUM;
        const v = ((S * Number(fx)) / Q64_NUM / 10 ** dx) * xUsd + ((S * Number(fy)) / Q64_NUM / 10 ** dy) * yUsd;
        usd += v;
        const off = Math.max(-this.feeOffsets, Math.min(this.feeOffsets, id - s.activeId));
        byOffset.set(off, (byOffset.get(off) ?? 0) + v);
      }
      const depthByOffset = new Map<number, number>();
      for (const [id, b] of prev.bins) {
        const off = id - prev.activeId;
        if (Math.abs(off) > this.feeOffsets) continue;
        depthByOffset.set(off, (depthByOffset.get(off) ?? 0) + binValueUsd(b, dy, yUsd));
      }
      this.fees.push({ ts: s.ts, dtMs: s.ts - prev.ts, usd, byOffset, depthByOffset, supplyChanges: changes });
    }
    this.trim(s.ts);
  }

  onSwap(w: SwapRecord) {
    if (w.pool !== this.meta.pool) return;
    const m = this.metrics;
    if (!m || m.xUsd == null || m.yUsd == null) return;
    // amount_in is X when swap_for_y (sell X), else Y (buy X)
    const usd = w.swapForY ? (Number(w.amountIn) / 10 ** this.meta.decimalsX) * m.xUsd : (Number(w.amountIn) / 10 ** this.meta.decimalsY) * m.yUsd;
    this.swaps.push({ ts: w.ts, wallet: w.wallet, buy: !w.swapForY, usd });
    this.swaps.sort((a, b) => a.ts - b.ts); // swaps can arrive late (queue); keep time order
    this.seen(w.ts);
  }

  onActivity(a: { ts: number; candidates: number; sampled: number }) {
    this.activity.push(a);
    this.seen(a.ts);
  }

  onMetrics(m: MetricsObs) {
    this.metrics = m;
    if (m.volume1h != null) this.metricsHistory.push({ ts: m.ts, volume1h: m.volume1h });
    this.seen(m.ts);
  }

  /** A gap notice; a later notice with the same source and start closes an open gap. */
  onGap(g: { source: string; start: number; end: number | null }) {
    const open = this.gaps.find((x) => x.source === g.source && x.start === g.start && x.end === null);
    if (open) open.end = g.end;
    else this.gaps.push({ source: g.source, start: g.start, end: g.end });
  }

  // ------------------------------------------------------------------ derived series

  /** 1-minute close prices (last observation per minute), oldest first, minutes ending <= t. */
  minuteCloses(t: number): { ts: number; price: number }[] {
    const out: { ts: number; price: number }[] = [];
    let curMin = -1;
    for (const p of this.prices) {
      if (p.ts > t) break;
      const m = Math.floor(p.ts / 60_000);
      if (m === curMin) out[out.length - 1] = { ts: p.ts, price: p.price };
      else {
        out.push({ ts: p.ts, price: p.price });
        curMin = m;
      }
    }
    return out;
  }

  priceAt(t: number): number | null {
    let lo = 0;
    let hi = this.prices.length - 1;
    if (hi < 0 || this.prices[0].ts > t) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.prices[mid].ts <= t) lo = mid;
      else hi = mid - 1;
    }
    return this.prices[lo].price;
  }

  /** Fraction of [from, to] not covered by a gap of `source` (for this pool or global). */
  coverage(source: string, from: number, to: number): number {
    if (to <= from) return 0;
    let covered = to - from;
    const ivs = this.gaps
      .filter((g) => g.source === source)
      .map((g) => [Math.max(from, g.start), Math.min(to, g.end ?? to)] as const)
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let curA = -1;
    let curB = -1;
    for (const [a, b] of ivs) {
      if (a > curB) {
        if (curB > curA) covered -= curB - curA;
        curA = a;
        curB = b;
      } else curB = Math.max(curB, b);
    }
    if (curB > curA) covered -= curB - curA;
    return Math.max(0, covered / (to - from));
  }

  openGap(source: string, t: number): boolean {
    return this.gaps.some((g) => g.source === source && g.start <= t && (g.end === null || g.end > t));
  }

  /** Liquidity (USD) of observed bins, by absolute bin id. */
  depthUsd(): Map<number, number> {
    const out = new Map<number, number>();
    const s = this.snap;
    const m = this.metrics;
    if (!s || !m || m.yUsd == null) return out;
    for (const [id, b] of s.bins) out.set(id, binValueUsd(b, this.meta.decimalsY, m.yUsd));
    return out;
  }
}

export function binValueUsd(b: BinObs, decY: number, yUsd: number): number {
  return ((Number(b.x) * b.priceRaw + Number(b.y)) / 10 ** decY) * yUsd;
}

/** Global context: SOL trend and network congestion. */
export class EcoTracker {
  sol: { ts: number; price: number }[] = [];
  priority: { ts: number; p75: number | null } | null = null;
  lastEventTs = 0;
  constructor(private readonly keepMs: number) {}
  onEco(e: { ts: number; solUsd: number | null; p75: number | null }) {
    if (e.solUsd != null) {
      const last = this.sol[this.sol.length - 1];
      if (!last || e.ts > last.ts) this.sol.push({ ts: e.ts, price: e.solUsd });
    }
    this.priority = { ts: e.ts, p75: e.p75 };
    if (e.ts > this.lastEventTs) this.lastEventTs = e.ts;
    const cut = e.ts - this.keepMs;
    while (this.sol.length && this.sol[0].ts < cut) this.sol.shift();
  }
  assertNotAfter(t: number) {
    if (this.lastEventTs > t) throw new LookaheadError(`eco tracker has data at ${this.lastEventTs} > decision ${t}`);
  }
}
