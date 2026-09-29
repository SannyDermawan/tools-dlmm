import type { Config } from "../config/schema.ts";
import type { Db, Row } from "../db/index.ts";
import type { ApiPool, MeteoraApi } from "../api/meteora.ts";
import type { RpcClient } from "../chain/rpc.ts";
import { every, percentile } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { GapTracker } from "./gaps.ts";
import type { MarketBus, PoolMeta, PoolMetrics } from "./types.ts";

export interface ApiDeps {
  api: MeteoraApi;
  rpc: RpcClient;
  db: Db;
  log: Logger;
  bus: MarketBus;
  gaps: GapTracker;
  config: Config;
  sessionId: string;
  pools: Map<string, PoolMeta>;
  /** latest USD price per token mint (from the API) */
  usdPrices: Map<string, { usd: number; ts: number }>;
}

export function metricsRow(p: ApiPool, ts: number, sessionId: string): Row {
  return {
    pool: p.address, ts, source: "api", session_id: sessionId,
    price: p.current_price, tvl_usd: p.tvl,
    volume_5m_usd: p.volume?.["5m"] ?? null, volume_1h_usd: p.volume?.["1h"] ?? null, volume_24h_usd: p.volume?.["24h"] ?? null,
    fee_5m_usd: p.fees?.["5m"] ?? null, fee_1h_usd: p.fees?.["1h"] ?? null, fee_24h_usd: p.fees?.["24h"] ?? null,
    protocol_fee_1h_usd: p.protocol_fees?.["1h"] ?? null,
    fee_tvl_1h: p.fee_tvl_ratio?.["1h"] ?? null,
    token_x_usd: p.token_x?.price ?? null, token_y_usd: p.token_y?.price ?? null,
    reserve_x_ui: p.token_x_amount ?? null, reserve_y_ui: p.token_y_amount ?? null,
    total_fee_rate: p.dynamic_fee_pct != null ? p.dynamic_fee_pct / 100 : null,
  };
}

/** TVL / volume / fees / USD prices for all pools in one /pools request (pool_address OR filter). */
export class PoolMetricsCollector {
  static readonly SOURCE = "pool_metrics";
  constructor(private readonly d: ApiDeps) {}

  async tick() {
    const { d } = this;
    const addrs = [...d.pools.keys()];
    const rows: Row[] = [];
    const ts = Date.now();
    for (let i = 0; i < addrs.length; i += 50) {
      const chunk = addrs.slice(i, i + 50);
      let page;
      try {
        // The OpenAPI doc says `[a|b]`, but the live API only matches with commas (verified 2026-09-29).
        page = await d.api.listPools({ pageSize: chunk.length, filterBy: `pool_address=[${chunk.join(",")}]` });
      } catch (e) {
        d.log.error({ err: (e as Error).message }, "pool_metrics fetch failed");
        continue;
      }
      for (const p of page.data) {
        if (!d.pools.has(p.address)) continue;
        rows.push(metricsRow(p, ts, d.sessionId));
        if (p.token_x?.price) d.usdPrices.set(p.token_x.address, { usd: p.token_x.price, ts });
        if (p.token_y?.price) d.usdPrices.set(p.token_y.address, { usd: p.token_y.price, ts });
        const m: PoolMetrics = {
          pool: p.address, ts, tvlUsd: p.tvl, tokenXUsd: p.token_x.price, tokenYUsd: p.token_y.price,
          volume1hUsd: p.volume?.["1h"] ?? 0, fee1hUsd: p.fees?.["1h"] ?? 0,
          volume24hUsd: p.volume?.["24h"] ?? null, feeTvl1h: p.fee_tvl_ratio?.["1h"] ?? null,
        };
        d.gaps.ok(PoolMetricsCollector.SOURCE, p.address, ts);
        d.bus.emitMetrics(m);
      }
    }
    d.db.insertMany("pool_snapshots", rows, "OR IGNORE");
  }

  run(signal: AbortSignal) {
    for (const p of this.d.pools.keys()) this.d.gaps.register(PoolMetricsCollector.SOURCE, p);
    return every(this.d.config.collectors.pool_metrics.interval_seconds * 1000, signal, () => this.tick());
  }
}

export const TIMEFRAME_SECONDS: Record<string, number> = {
  "5m": 300, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "12h": 43200, "24h": 86400,
};
/** The API rejects long ranges ("time range too large"; 5m: 6h ok, 12h not) — request <= 72 candles at a time. */
export const OHLCV_MAX_CANDLES = 72;
const DAILY_REFRESH_MS = 6 * 3_600_000;

export async function fetchOhlcvChunked(api: MeteoraApi, pool: string, tf: string, startSec: number, endSec: number) {
  const step = TIMEFRAME_SECONDS[tf] * OHLCV_MAX_CANDLES;
  const out = new Map<number, Awaited<ReturnType<MeteoraApi["ohlcv"]>>[number]>();
  for (let s = startSec; s < endSec; s += step) {
    for (const p of await api.ohlcv(pool, tf, s, Math.min(endSec, s + step))) out.set(p.timestamp, p);
  }
  return [...out.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** OHLCV from the Data API (5m and up). Warm-up pulls history; later ticks refresh recent candles. */
export class OhlcvCollector {
  static readonly SOURCE = "ohlcv";
  private warmed = new Set<string>();
  /** last daily-candle pull per pool (ms): full history once, the newest days again every few hours */
  private dailyAt = new Map<string, number>();
  constructor(private readonly d: ApiDeps) {}

  /**
   * Daily candles back to the pool's start (bounded by daily_lookback_days): the base of the ATH feature.
   * Stored as timeframe '24h'. Closed days never change, so later pulls only refresh the last days.
   */
  async dailyHistory(pool: string, nowMs: number) {
    const { d } = this;
    const days = d.config.collectors.ohlcv.daily_lookback_days;
    if (days <= 0) return;
    const last = this.dailyAt.get(pool);
    if (last !== undefined && nowMs - last < DAILY_REFRESH_MS) return;
    const created = d.pools.get(pool)?.createdAt ?? null;
    const full = last === undefined;
    const from = full ? Math.max(nowMs - days * 86_400_000, created ? created - 86_400_000 : 0) : nowMs - 3 * 86_400_000;
    try {
      const pts = await fetchOhlcvChunked(d.api, pool, "24h", Math.floor(from / 1000), Math.floor(nowMs / 1000));
      d.db.insertMany(
        "ohlcv",
        pts.map((p) => ({ pool, timeframe: "24h", ts: p.timestamp * 1000, o: p.open, h: p.high, l: p.low, c: p.close, v: p.volume, source: "meteora_api", fetched_at: nowMs })),
        "OR REPLACE",
      );
      this.dailyAt.set(pool, nowMs);
    } catch (e) {
      d.log.warn({ pool, err: (e as Error).message }, "daily ohlcv fetch failed; ATH uses the shorter history");
    }
  }

  async tick() {
    const { d } = this;
    const c = d.config.collectors.ohlcv;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const pool of d.pools.keys()) {
      await this.dailyHistory(pool, nowSec * 1000);
      const start = this.warmed.has(pool) ? nowSec - c.refresh_lookback_minutes * 60 : nowSec - c.warmup_hours * 3600;
      let ok = true;
      for (const tf of c.timeframes) {
        try {
          const pts = await fetchOhlcvChunked(d.api, pool, tf, start, nowSec);
          const fetched = Date.now();
          d.db.insertMany(
            "ohlcv",
            pts.map((p) => ({ pool, timeframe: tf, ts: p.timestamp * 1000, o: p.open, h: p.high, l: p.low, c: p.close, v: p.volume, source: "meteora_api", fetched_at: fetched })),
            "OR REPLACE",
          );
        } catch (e) {
          ok = false;
          d.log.error({ pool, tf, err: (e as Error).message }, "ohlcv fetch failed");
        }
      }
      if (ok) {
        this.warmed.add(pool);
        d.gaps.ok(OhlcvCollector.SOURCE, pool);
      }
    }
  }

  run(signal: AbortSignal) {
    for (const p of this.d.pools.keys()) this.d.gaps.register(OhlcvCollector.SOURCE, p);
    return every(this.d.config.collectors.ohlcv.interval_seconds * 1000, signal, () => this.tick());
  }
}

/** Priority fees (getRecentPrioritizationFees over the monitored pools) and SOL/USD. */
export class EcosystemCollector {
  static readonly SOURCE = "ecosystem";
  latest: { ts: number; solUsd: number | null; p50: number | null; p75: number | null; p90: number | null } | null = null;
  constructor(private readonly d: ApiDeps) {}

  async tick() {
    const { d } = this;
    const c = d.config.collectors.ecosystem;
    const ts = Date.now();
    let fees: number[] = [];
    try {
      const accts = [...d.pools.keys()].slice(0, 128);
      const r = await d.rpc.call<{ slot: number; prioritizationFee: number }[]>("getRecentPrioritizationFees", [accts]);
      fees = r.map((x) => x.prioritizationFee);
    } catch (e) {
      d.log.error({ err: (e as Error).message }, "priority fee fetch failed");
    }
    let solUsd: number | null = d.usdPrices.get("So11111111111111111111111111111111111111112")?.usd ?? null;
    try {
      const p = await d.api.getPool(c.sol_price_pool);
      if (p.token_x.address === "So11111111111111111111111111111111111111112") solUsd = p.token_x.price;
      d.usdPrices.set(p.token_x.address, { usd: p.token_x.price, ts });
    } catch (e) {
      d.log.warn({ err: (e as Error).message }, "sol price fetch failed; using last known");
    }
    const nonzero = fees.filter((f) => f > 0);
    const row = {
      ts, session_id: d.sessionId, sol_usd: solUsd,
      priority_fee_p50: percentile(fees, 50), priority_fee_p75: percentile(fees, 75), priority_fee_p90: percentile(fees, 90),
      priority_fee_nonzero_p75: percentile(nonzero, 75),
    };
    d.db.insert("ecosystem_metrics", row, "OR IGNORE");
    this.latest = { ts, solUsd, p50: row.priority_fee_p50, p75: row.priority_fee_p75, p90: row.priority_fee_p90 };
    d.bus.emitEco(this.latest);
    if (fees.length && solUsd) d.gaps.ok(EcosystemCollector.SOURCE, null, ts);
  }

  run(signal: AbortSignal) {
    this.d.gaps.register(EcosystemCollector.SOURCE, null);
    return every(this.d.config.collectors.ecosystem.interval_seconds * 1000, signal, () => this.tick());
  }
}
