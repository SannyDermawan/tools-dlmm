import type { Config } from "../config/schema.ts";
import type { Db, Row } from "../db/index.ts";
import type { RpcClient, SignatureInfo } from "../chain/rpc.ts";
import type { ReconnectingWs } from "../chain/ws.ts";
import { extractSwaps, feeOnTokenX } from "../chain/dlmm.ts";
import { every, sleep } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { GapTracker } from "./gaps.ts";
import type { MarketBus, PoolMeta, SwapRecord } from "./types.ts";

/** Bounded insertion-ordered set for signature de-duplication. */
export class LruSet {
  private m = new Map<string, true>();
  constructor(private readonly cap: number) {}
  has(k: string) {
    return this.m.has(k);
  }
  add(k: string) {
    if (this.m.has(k)) return;
    this.m.set(k, true);
    if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as string);
  }
  get size() {
    return this.m.size;
  }
}

/** Whether the swap stream runs for a pool (config: categories, include / exclude lists). */
export function swapStreamEnabled(meta: PoolMeta, c: Config["collectors"]["swap_stream"]): boolean {
  if (c.exclude_pools.includes(meta.pool)) return false;
  if (c.include_pools.includes(meta.pool)) return true;
  return c.include_categories.includes(meta.category);
}

export type BudgetState = "ok" | "paced" | "exhausted";

/**
 * Credit budget for the swap stream within one session. `exhausted` once the swap budget or the
 * session-wide budget is spent; `paced` when spending runs ahead of an even pace over the session
 * (budget x elapsed / duration + burst), so later hours still get swap data.
 */
export class SwapBudget {
  constructor(
    private readonly o: {
      swapBudget: number;
      sessionBudget: number;
      startTs: number;
      durationMs: number | null;
      pacing: boolean;
      burstPct: number;
      swapCredits: () => number;
      sessionCredits: () => number;
    },
  ) {}

  allowedNow(now = Date.now()): number {
    const { swapBudget, durationMs, pacing, burstPct, startTs } = this.o;
    if (!pacing || !durationMs) return swapBudget;
    const frac = Math.min(1, Math.max(0, (now - startTs) / durationMs) + burstPct / 100);
    return swapBudget * frac;
  }

  state(now = Date.now()): BudgetState {
    const used = this.o.swapCredits();
    if (used >= this.o.swapBudget || this.o.sessionCredits() >= this.o.sessionBudget) return "exhausted";
    if (used >= this.allowedNow(now)) return "paced";
    return "ok";
  }
}

/** Log lines worth a getTransaction: any swap instruction, or truncated logs (can't tell). */
export function logsMayContainSwap(logs: string[] | null | undefined): boolean {
  if (!logs) return true;
  return logs.some((l) => l.includes("Instruction: Swap") || l.includes("Log truncated"));
}

interface Job {
  signature: string;
  pool: string;
  attempts: number;
  queuedAt: number;
}

export interface SwapDeps {
  rpc: RpcClient;
  ws: ReconnectingWs | null;
  db: Db;
  log: Logger;
  bus: MarketBus;
  gaps: GapTracker;
  config: Config;
  sessionId: string;
  pools: Map<string, PoolMeta>;
  /** When true the workers pause, giving the shared IP rate budget to critical collectors. */
  shouldYield?: () => boolean;
  /** credit budget (optional) */
  budget?: SwapBudget;
}

/**
 * Swap events come from self-CPI inner instructions, so every swap transaction needs one
 * getTransaction. Signature discovery:
 *   1. logsSubscribe(mentions: pool) — low latency, logs pre-filter non-swap transactions;
 *   2. getSignaturesForAddress(until: newest seen) polling — backfills anything the socket missed
 *      (disconnects, dropped notifications). A backfill that cannot reach the previous marker
 *      within the page limit records a data gap.
 */
export class SwapStreamCollector {
  static readonly SOURCE = "swap_stream";
  private seen: LruSet;
  private queue: Job[] = [];
  private newest = new Map<string, { sig: string; ts: number }>(); // pool -> newest signature seen by backfill
  private overflow = new Set<string>();
  stats = { wsNotifications: 0, skippedByLogs: 0, txFetched: 0, swapsStored: 0, dropped: 0, backfilled: 0, yielded: 0, paced: 0, budgetStopped: 0 };
  private stopped = false;
  /** per-pool sampling state (mode: sample) */
  private samp = new Map<string, { minute: number; candidates: number; sampled: number; ewma: number | null }>();
  private rand: () => number = Math.random;

  /**
   * A successful transaction that mentions the pool and may contain a swap. In sample mode it is
   * queued with probability min(1, target / expected rate), capped at 2x target per minute, so
   * the sample is uniform over time; every candidate is counted (free activity census).
   */
  private candidate(signature: string, pool: string, now = Date.now()) {
    if (this.seen.has(signature)) return;
    const c = this.d.config.collectors.swap_stream;
    const minute = Math.floor(now / 60_000) * 60_000;
    let st = this.samp.get(pool);
    if (!st) this.samp.set(pool, (st = { minute, candidates: 0, sampled: 0, ewma: null }));
    if (st.minute !== minute) this.rollMinute(pool, minute);
    st.candidates++;
    if (c.mode === "full") {
      st.sampled++;
      return this.enqueue(signature, pool);
    }
    const target = c.sample_per_minute;
    const p = st.sampled >= 2 * target ? 0 : st.ewma === null ? (st.sampled < target ? 1 : 0) : Math.min(1, target / Math.max(1, st.ewma));
    if (this.rand() < p) {
      st.sampled++;
      this.enqueue(signature, pool);
    } else this.seen.add(signature); // not sampled: never counted twice (socket + backfill)
  }

  /** Close a pool's minute: persist the activity row, update the rate estimate. */
  private rollMinute(pool: string, nextMinute: number) {
    const st = this.samp.get(pool);
    if (!st) return;
    if (st.candidates > 0 || st.sampled > 0) {
      this.d.db.insert(
        "swap_activity",
        { session_id: this.d.sessionId, pool, minute: st.minute, candidates: st.candidates, sampled: st.sampled },
        "OR REPLACE",
      );
    }
    this.d.bus.emitActivity({ pool, ts: st.minute + 60_000, candidates: st.candidates, sampled: st.sampled });
    // exponential moving average of candidates per minute; empty minutes count too
    const gapMinutes = Math.max(1, Math.round((nextMinute - st.minute) / 60_000));
    let e = st.ewma ?? st.candidates;
    e = 0.5 * e + 0.5 * st.candidates;
    for (let i = 1; i < gapMinutes; i++) e = 0.5 * e;
    st.ewma = e;
    st.minute = nextMinute;
    st.candidates = 0;
    st.sampled = 0;
  }

  /** Once a minute: flush every pool's activity row and mark the stream healthy while connected. */
  private flushMinute() {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    for (const pool of this.d.pools.keys()) {
      if (!this.samp.has(pool)) this.samp.set(pool, { minute, candidates: 0, sampled: 0, ewma: null });
      const st = this.samp.get(pool)!;
      if (st.minute !== minute) this.rollMinute(pool, minute);
      if (!this.stopped && (!this.d.ws || this.d.ws.connected)) this.d.gaps.ok(SwapStreamCollector.SOURCE, pool);
    }
  }

  constructor(private readonly d: SwapDeps) {
    this.seen = new LruSet(d.config.collectors.swap_stream.dedupe_cache_size);
  }

  get queueLength() {
    return this.queue.length;
  }

  private enqueue(signature: string, pool: string) {
    if (this.stopped || this.seen.has(signature)) return;
    this.seen.add(signature);
    const max = this.d.config.collectors.swap_stream.max_queue;
    if (this.queue.length >= max) {
      this.stats.dropped++;
      if (!this.overflow.has(pool)) {
        this.overflow.add(pool);
        this.d.gaps.down(SwapStreamCollector.SOURCE, pool, "tx queue overflow");
      }
      return;
    }
    this.queue.push({ signature, pool, attempts: 0, queuedAt: Date.now() });
  }

  private onNotification = (pool: string, value: { value: { signature: string; err: unknown; logs: string[] } }) => {
    const v = value.value;
    this.stats.wsNotifications++;
    if (v.err) {
      this.seen.add(v.signature);
      return;
    }
    if (!logsMayContainSwap(v.logs)) {
      this.stats.skippedByLogs++;
      this.seen.add(v.signature);
      return;
    }
    this.candidate(v.signature, pool);
  };

  private async processJob(job: Job): Promise<void> {
    const { d } = this;
    const tx = await d.rpc.getTransaction(job.signature);
    if (!tx) {
      // Not yet visible at this commitment: retry a few times.
      if (++job.attempts <= 5) {
        await sleep(2000);
        this.queue.push(job);
      } else d.log.warn({ sig: job.signature }, "transaction not found after retries");
      return;
    }
    this.stats.txFetched++;
    if (tx.meta?.err) return;
    const ts = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
    const rows: Row[] = [];
    for (const s of extractSwaps(tx)) {
      const meta = d.pools.get(s.lbPair);
      if (!meta) continue; // routed through a pool we don't monitor
      const onX = feeOnTokenX(s, meta.collectFeeMode);
      const inDec = s.swapForY ? meta.decimalsX : meta.decimalsY;
      const outDec = s.swapForY ? meta.decimalsY : meta.decimalsX;
      const feeDec = onX ? meta.decimalsX : meta.decimalsY;
      rows.push({
        signature: job.signature, event_index: s.eventIndex, pool: s.lbPair, ts, slot: tx.slot, session_id: d.sessionId,
        event_type: s.eventType, wallet: s.from, start_bin: s.startBinId, end_bin: s.endBinId,
        amount_in: s.amountIn.toString(), amount_out: s.amountOut.toString(), amount_left: s.amountLeft?.toString() ?? null,
        swap_for_y: s.swapForY ? 1 : 0, fee: s.fee.toString(), protocol_fee: s.protocolFee.toString(), mm_fee: s.mmFee.toString(),
        limit_order_fee: s.limitOrderFee.toString(), host_fee: s.hostFee.toString(), fee_bps: s.feeBps.toString(),
        fees_on_input: s.feesOnInput === null ? null : s.feesOnInput ? 1 : 0, fees_on_token_x: onX ? 1 : 0,
        amount_in_ui: Number(s.amountIn) / 10 ** inDec, amount_out_ui: Number(s.amountOut) / 10 ** outDec,
        fee_ui: Number(s.fee) / 10 ** feeDec, mm_fee_ui: Number(s.mmFee) / 10 ** feeDec, protocol_fee_ui: Number(s.protocolFee) / 10 ** feeDec,
        received_at: Date.now(),
      });
      const rec: SwapRecord = {
        pool: s.lbPair, signature: job.signature, eventIndex: s.eventIndex, ts, slot: tx.slot, swapForY: s.swapForY,
        startBin: s.startBinId, endBin: s.endBinId, amountIn: s.amountIn, amountOut: s.amountOut, fee: s.fee,
        protocolFee: s.protocolFee, mmFee: s.mmFee, feeOnX: onX, wallet: s.from,
      };
      d.bus.emitSwap(rec);
    }
    if (rows.length) this.stats.swapsStored += d.db.insertMany("swaps", rows, "OR IGNORE");
  }

  private async worker(signal: AbortSignal) {
    while (!signal.aborted) {
      if (this.d.shouldYield?.()) {
        this.stats.yielded++;
        await sleep(1000, signal);
        continue;
      }
      const b = this.d.budget?.state();
      if (b === "exhausted") {
        this.stopForBudget();
        await sleep(5000, signal);
        continue;
      }
      if (b === "paced") {
        this.stats.paced++;
        await sleep(1000, signal);
        continue;
      }
      const job = this.queue.shift();
      if (!job) {
        await sleep(100, signal);
        continue;
      }
      try {
        await this.processJob(job);
      } catch (e) {
        this.d.log.error({ sig: job.signature, err: (e as Error).message }, "swap tx processing failed");
        if (++job.attempts <= 3) this.queue.push(job);
        else this.d.gaps.record(SwapStreamCollector.SOURCE, job.pool, job.queuedAt, Date.now(), `tx fetch failed ${job.signature}`);
      }
      for (const p of [...this.overflow]) {
        if (this.queue.length < this.d.config.collectors.swap_stream.max_queue / 2) {
          this.overflow.delete(p);
          this.d.gaps.close(SwapStreamCollector.SOURCE, p);
        }
      }
    }
  }

  /** Budget spent: stop fetching; the rest of the session is a swap_stream gap for every pool. */
  private stopForBudget() {
    if (this.stopped) return;
    this.stopped = true;
    this.stats.budgetStopped = 1;
    const now = Date.now();
    for (const pool of this.d.pools.keys()) {
      const pending = this.queue.filter((j) => j.pool === pool);
      const since = pending.length ? Math.min(...pending.map((j) => j.queuedAt)) : now;
      this.d.gaps.close(SwapStreamCollector.SOURCE, pool);
      this.d.gaps.unregister(SwapStreamCollector.SOURCE, pool);
      this.d.gaps.down(SwapStreamCollector.SOURCE, pool, "credit budget reached", since);
    }
    this.queue = [];
    this.d.log.warn({ stats: this.stats }, "swap stream stopped: credit budget reached (core collectors continue)");
  }

  /**
   * Transactions still queued when collection stops were never fetched: record them as a gap per
   * pool, from the oldest pending job to the end of collection.
   */
  recordUnprocessed(end: number) {
    const oldest = new Map<string, number>();
    for (const j of this.queue) oldest.set(j.pool, Math.min(oldest.get(j.pool) ?? j.queuedAt, j.queuedAt));
    for (const [pool, start] of oldest) {
      const n = this.queue.filter((j) => j.pool === pool).length;
      this.d.gaps.record(SwapStreamCollector.SOURCE, pool, start, end, `${n} transactions not fetched before shutdown`);
    }
    this.queue = [];
  }

  /** Walk getSignaturesForAddress back to the previous marker. */
  async backfillPool(pool: string): Promise<void> {
    const { d } = this;
    const c = d.config.collectors.swap_stream;
    const marker = this.newest.get(pool);
    if (!marker) {
      // First call: set the marker at "now"; history before the session is not collected.
      const latest = await d.rpc.getSignaturesForAddress(pool, { limit: 1 });
      this.newest.set(pool, latest[0] ? { sig: latest[0].signature, ts: Date.now() } : { sig: "", ts: Date.now() });
      d.gaps.ok(SwapStreamCollector.SOURCE, pool);
      return;
    }
    const collected: SignatureInfo[] = [];
    let before: string | undefined;
    let reached = false;
    for (let page = 0; page < 5; page++) {
      const sigs = await d.rpc.getSignaturesForAddress(pool, { until: marker.sig || undefined, before, limit: c.backfill_page_limit });
      collected.push(...sigs);
      if (sigs.length < c.backfill_page_limit) {
        reached = true;
        break;
      }
      before = sigs[sigs.length - 1].signature;
    }
    if (collected.length) this.newest.set(pool, { sig: collected[0].signature, ts: (collected[0].blockTime ?? 0) * 1000 || Date.now() });
    if (!reached && collected.length && c.mode === "full") {
      const oldest = collected[collected.length - 1];
      d.gaps.record(SwapStreamCollector.SOURCE, pool, marker.ts, (oldest.blockTime ?? 0) * 1000 || Date.now(), "backfill page limit reached");
    }
    for (const s of collected.reverse()) {
      if (s.err) {
        this.seen.add(s.signature);
        continue;
      }
      if (!this.seen.has(s.signature)) this.stats.backfilled++;
      this.candidate(s.signature, pool);
    }
    d.gaps.ok(SwapStreamCollector.SOURCE, pool);
  }

  async run(signal: AbortSignal): Promise<void> {
    const { d } = this;
    for (const p of d.pools.keys()) d.gaps.register(SwapStreamCollector.SOURCE, p);
    if (d.ws) {
      d.ws.on("notification", this.onNotification);
      for (const pool of d.pools.keys()) {
        d.ws.subscribe({
          key: pool,
          method: "logsSubscribe",
          params: [{ mentions: [pool] }, { commitment: d.rpc.commitment === "processed" ? "confirmed" : d.rpc.commitment }],
          notification: "logsNotification",
        });
      }
      d.ws.on("up", () => {
        for (const p of d.pools.keys()) d.gaps.close(SwapStreamCollector.SOURCE, p);
        void this.backfillAll();
      });
      d.ws.on("down", (reason: string) => {
        if (this.stopped) return;
        for (const p of d.pools.keys()) d.gaps.down(SwapStreamCollector.SOURCE, p, `ws down: ${reason}`);
      });
    }
    const c = d.config.collectors.swap_stream;
    const workers = Array.from({ length: c.tx_concurrency }, () => this.worker(signal));
    const minuteTimer = every(60_000, signal, async () => this.flushMinute());
    // full mode polls getSignaturesForAddress for completeness; sample mode relies on the socket
    // (backfill only at start to set markers and after a reconnect)
    const poll = c.mode === "full"
      ? every(c.backfill_interval_seconds * 1000, signal, () => this.backfillAll())
      : this.backfillAll();
    await Promise.all([...workers, poll, minuteTimer]);
  }

  private backfilling = false;
  async backfillAll() {
    if (this.backfilling || this.stopped) return;
    const b = this.d.budget?.state();
    if (b === "exhausted") return this.stopForBudget();
    if (b === "paced") return; // the socket keeps queueing; backfill resumes when back on pace
    this.backfilling = true;
    try {
      for (const pool of this.d.pools.keys()) {
        try {
          await this.backfillPool(pool);
        } catch (e) {
          this.d.log.error({ pool, err: (e as Error).message }, "swap backfill failed");
        }
      }
    } finally {
      this.backfilling = false;
    }
  }
}
