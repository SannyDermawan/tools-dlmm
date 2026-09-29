import type { Db } from "../db/index.ts";
import type { BinObs, BinSnapshot, PoolStateUpdate, SwapRecord } from "../collectors/types.ts";
import { binRawPrice } from "../math/bin.ts";

export type ReplayEvent =
  | { kind: "state"; ts: number; u: PoolStateUpdate }
  | { kind: "bins"; ts: number; s: BinSnapshot }
  | { kind: "swap"; ts: number; s: SwapRecord }
  | {
      kind: "metrics"; ts: number; pool: string; tokenXUsd: number | null; tokenYUsd: number | null;
      tvlUsd?: number | null; volume1h?: number | null; volume24h?: number | null; fee1h?: number | null; feeTvl1h?: number | null;
    }
  | { kind: "eco"; ts: number; solUsd: number | null; p50: number | null; p75: number | null; p90: number | null }
  | { kind: "gap"; ts: number; source: string; pool: string | null; start: number; end: number | null }
  | { kind: "activity"; ts: number; pool: string; candidates: number; sampled: number }
  | { kind: "swapquote"; ts: number; pool: string; costPct: number };

/** Replays of data at the same timestamp run in this order (state before bins before swaps). */
const ORDER: Record<ReplayEvent["kind"], number> = { eco: 0, metrics: 1, swapquote: 1, gap: 2, state: 3, bins: 4, swap: 5, activity: 6 };

/**
 * Rebuild bin snapshots from delta-encoded storage (keyframe = full window, else changed bins;
 * rows with supply 0 mean the bin emptied).
 */
export function loadBinSnapshots(db: Db, pool: string, from: number, to: number, binStep: number): BinSnapshot[] {
  const metas = db.all<{ ts: number; slot: number; active_bin: number; lower_bin: number; upper_bin: number; missing_bin_arrays: string; full: number }>(
    "SELECT ts, slot, active_bin, lower_bin, upper_bin, missing_bin_arrays, full FROM bin_snapshot_meta WHERE pool = ? AND ts <= ? ORDER BY ts",
    pool, to,
  );
  // Start from the last keyframe at or before `from`.
  let startIdx = 0;
  for (let i = 0; i < metas.length; i++) if (metas[i].full && metas[i].ts <= from) startIdx = i;
  const rows = db.all<{ ts: number; bin_id: number; x_amount: string; y_amount: string; liquidity_supply: string; fee_x_per_token: string; fee_y_per_token: string }>(
    "SELECT ts, bin_id, x_amount, y_amount, liquidity_supply, fee_x_per_token, fee_y_per_token FROM bin_snapshots WHERE pool = ? AND ts >= ? AND ts <= ? ORDER BY ts",
    pool, metas[startIdx]?.ts ?? from, to,
  );
  const byTs = new Map<number, typeof rows>();
  for (const r of rows) {
    let a = byTs.get(r.ts);
    if (!a) byTs.set(r.ts, (a = []));
    a.push(r);
  }
  const state = new Map<number, BinObs>();
  const out: BinSnapshot[] = [];
  for (const m of metas.slice(startIdx)) {
    const rs = byTs.get(m.ts) ?? [];
    if (m.full) state.clear();
    for (const r of rs) {
      const supply = BigInt(r.liquidity_supply);
      if (supply === 0n) {
        state.delete(r.bin_id);
        continue;
      }
      state.set(r.bin_id, {
        binId: r.bin_id, x: BigInt(r.x_amount), y: BigInt(r.y_amount), supply,
        feeX: BigInt(r.fee_x_per_token), feeY: BigInt(r.fee_y_per_token), priceRaw: binRawPrice(r.bin_id, binStep),
      });
    }
    if (m.ts < from) continue;
    const bins = new Map<number, BinObs>();
    for (const [id, b] of state) if (id >= m.lower_bin && id <= m.upper_bin) bins.set(id, b);
    out.push({
      pool, ts: m.ts, slot: m.slot, activeId: m.active_bin, lower: m.lower_bin, upper: m.upper_bin,
      missingBinArrays: JSON.parse(m.missing_bin_arrays ?? "[]"), bins,
    });
  }
  return out;
}

export interface ReplayOptions {
  pools: string[];
  from: number;
  to: number;
  binSteps: Map<string, number>;
  collectFeeModes: Map<string, number>;
  sessionId?: string;
}

/** All market events of a time window, merged in timestamp order. */
export function loadReplay(db: Db, o: ReplayOptions): ReplayEvent[] {
  const ev: ReplayEvent[] = [];
  // aggregator swap quotes (phase 10+ data; older sessions have none -> fallback cost)
  for (const pool of o.pools)
    for (const q of db.all<{ ts: number; c: number }>(
      "SELECT ts, one_way_cost_pct c FROM swap_quotes WHERE pool = ? AND ts BETWEEN ? AND ? AND one_way_cost_pct IS NOT NULL ORDER BY ts", pool, o.from - 30 * 60_000, o.to,
    ))
      ev.push({ kind: "swapquote", ts: Math.max(q.ts, o.from), pool, costPct: q.c });
  for (const pool of o.pools) {
    for (const r of db.all<{ ts: number; slot: number; active_bin: number; price: number; volatility_accumulator: number; volatility_reference: number; index_reference: number; v_last_update_ts: number; total_fee_rate: number }>(
      "SELECT * FROM pool_snapshots WHERE pool = ? AND source = 'chain' AND ts BETWEEN ? AND ? ORDER BY ts", pool, o.from, o.to,
    )) {
      ev.push({
        kind: "state", ts: r.ts,
        u: {
          pool, ts: r.ts, slot: r.slot, activeId: r.active_bin, priceUi: r.price,
          v: { volatilityAccumulator: r.volatility_accumulator, volatilityReference: r.volatility_reference, indexReference: r.index_reference, lastUpdateTimestamp: r.v_last_update_ts },
          feeRateTotal: r.total_fee_rate, feeRateLp: r.total_fee_rate,
        },
      });
    }
    for (const s of loadBinSnapshots(db, pool, o.from, o.to, o.binSteps.get(pool)!)) ev.push({ kind: "bins", ts: s.ts, s });
    for (const r of db.all<{ ts: number; token_x_usd: number | null; token_y_usd: number | null; tvl_usd: number | null; volume_1h_usd: number | null; volume_24h_usd: number | null; fee_1h_usd: number | null; fee_tvl_1h: number | null }>(
      "SELECT ts, token_x_usd, token_y_usd, tvl_usd, volume_1h_usd, volume_24h_usd, fee_1h_usd, fee_tvl_1h FROM pool_snapshots WHERE pool = ? AND source = 'api' AND ts BETWEEN ? AND ? ORDER BY ts",
      pool, o.from - 600_000, o.to,
    )) {
      ev.push({
        kind: "metrics", ts: Math.max(r.ts, o.from), pool, tokenXUsd: r.token_x_usd, tokenYUsd: r.token_y_usd,
        tvlUsd: r.tvl_usd, volume1h: r.volume_1h_usd, volume24h: r.volume_24h_usd, fee1h: r.fee_1h_usd, feeTvl1h: r.fee_tvl_1h,
      });
    }
    for (const r of db.all<{ signature: string; event_index: number; ts: number; slot: number; swap_for_y: number; start_bin: number; end_bin: number; amount_in: string; amount_out: string; fee: string; protocol_fee: string; mm_fee: string; fees_on_token_x: number; wallet: string }>(
      "SELECT * FROM swaps WHERE pool = ? AND ts BETWEEN ? AND ? ORDER BY ts, slot, event_index", pool, o.from, o.to,
    )) {
      ev.push({
        kind: "swap", ts: r.ts,
        s: {
          pool, signature: r.signature, eventIndex: r.event_index, ts: r.ts, slot: r.slot, swapForY: r.swap_for_y === 1,
          startBin: r.start_bin, endBin: r.end_bin, amountIn: BigInt(r.amount_in), amountOut: BigInt(r.amount_out),
          fee: BigInt(r.fee), protocolFee: BigInt(r.protocol_fee), mmFee: BigInt(r.mm_fee), feeOnX: r.fees_on_token_x === 1, wallet: r.wallet,
        },
      });
    }
  }
  for (const r of db.all<{ ts: number; sol_usd: number | null; priority_fee_p50: number | null; priority_fee_p75: number | null; priority_fee_p90: number | null }>(
    "SELECT * FROM ecosystem_metrics WHERE ts BETWEEN ? AND ? ORDER BY ts", o.from - 600_000, o.to,
  )) ev.push({ kind: "eco", ts: Math.max(r.ts, o.from), solUsd: r.sol_usd, p50: r.priority_fee_p50, p75: r.priority_fee_p75, p90: r.priority_fee_p90 });
  if (o.sessionId) {
    for (const r of db.all<{ pool: string; minute: number; candidates: number; sampled: number }>(
      "SELECT pool, minute, candidates, sampled FROM swap_activity WHERE session_id = ? AND minute + 60000 BETWEEN ? AND ?", o.sessionId, o.from, o.to,
    )) {
      if (o.pools.includes(r.pool)) ev.push({ kind: "activity", ts: r.minute + 60_000, pool: r.pool, candidates: r.candidates, sampled: r.sampled });
    }
    for (const g of db.all<{ source: string; pool: string | null; start_at: number; end_at: number | null }>(
      "SELECT source, pool, start_at, end_at FROM data_gaps WHERE session_id = ?", o.sessionId,
    )) {
      if (g.pool && !o.pools.includes(g.pool)) continue;
      ev.push({ kind: "gap", ts: Math.max(o.from, g.start_at), source: g.source, pool: g.pool, start: g.start_at, end: g.end_at });
    }
  }
  ev.sort((a, b) => a.ts - b.ts || ORDER[a.kind] - ORDER[b.kind]);
  return ev;
}
