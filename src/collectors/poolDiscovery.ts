import type { Config } from "../config/schema.ts";
import type { Db, Row } from "../db/index.ts";
import { JsonHttp } from "../api/meteora.ts";
import type { UsageTracker } from "../chain/usage.ts";
import { every } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { PoolMeta } from "./types.ts";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const warnings = (t: any): string | null =>
  Array.isArray(t?.warnings) ? JSON.stringify(t.warnings.map((w: any) => ({ type: String(w?.type ?? "?"), severity: String(w?.severity ?? "?") }))) : null;

/**
 * One pool object of the pool-discovery API -> pool_discovery row fields (field names verified
 * 2026-09-30 against live responses). `token_x` is the base token, as in Meridian's `base_token_*`.
 */
export function parsePoolDiscovery(p: any): Row {
  const x = p?.token_x;
  return {
    volatility: num(p?.volatility),
    correlation: num(p?.correlation),
    price_change_pct: num(p?.pool_price_change_pct),
    min_price: num(p?.min_price),
    max_price: num(p?.max_price),
    price_trend: Array.isArray(p?.price_trend) ? JSON.stringify(p.price_trend) : null,
    tvl: num(p?.tvl),
    tvl_change_pct: num(p?.tvl_change_pct),
    active_tvl: num(p?.active_tvl),
    fee_active_tvl_ratio: num(p?.fee_active_tvl_ratio),
    volume_active_tvl_ratio: num(p?.volume_active_tvl_ratio),
    volume: num(p?.volume),
    fee: num(p?.fee),
    swap_count: int(p?.swap_count),
    unique_traders: int(p?.unique_traders),
    unique_lps: int(p?.unique_lps),
    net_deposits: num(p?.net_deposits),
    total_deposits: num(p?.total_deposits),
    total_withdraws: num(p?.total_withdraws),
    total_lps: int(p?.total_lps),
    open_positions: int(p?.open_positions),
    active_positions: int(p?.active_positions),
    active_positions_pct: num(p?.active_positions_pct),
    positions_created: int(p?.positions_created),
    permanent_lock_pct: num(p?.permanent_lock_liquidity_pct),
    base_holders: int(p?.base_token_holders),
    base_holders_change_pct: num(p?.base_token_holders_change_pct),
    base_mcap_change_pct: num(p?.base_token_market_cap_change_pct),
    base_top_holders_pct: num(x?.top_holders_pct),
    base_dev_balance_pct: num(x?.dev_balance_pct),
    base_organic_score: num(x?.organic_score),
    warnings_x: warnings(x),
    warnings_y: warnings(p?.token_y),
  };
}

export interface DiscoveryDeps {
  db: Db;
  log: Logger;
  config: Config;
  sessionId: string;
  pools: Map<string, PoolMeta>;
  usage?: UsageTracker;
  signal?: AbortSignal;
  http?: Pick<JsonHttp, "get">;
}

/**
 * Meteora pool-discovery API, every `interval_seconds`: one request per timeframe and per
 * `batch_size` pools (`pool_address in [...]` filter; 40 pools answer in one second, about 150 KB).
 * Pools added during a session are picked up at the next tick because the pool map is shared.
 * Keyless HTTP only: it uses no RPC credits.
 */
export class PoolDiscoveryCollector {
  static readonly SOURCE = "pool_discovery";
  private http: Pick<JsonHttp, "get">;

  constructor(private readonly d: DiscoveryDeps) {
    const c = d.config.collectors.pool_discovery;
    this.http =
      d.http ??
      new JsonHttp(
        { baseUrl: c.base_url, maxRps: c.max_rps, timeoutMs: d.config.api.request_timeout_ms, retry: { ...d.config.api.retry, max_attempts: 2 }, usage: d.usage, log: d.log, signal: d.signal },
        "pool_discovery",
      );
  }

  async tick(now = Date.now()): Promise<Row[]> {
    const { d } = this;
    const c = d.config.collectors.pool_discovery;
    const addrs = [...d.pools.keys()];
    const rows: Row[] = [];
    for (const timeframe of c.timeframes) {
      for (let i = 0; i < addrs.length; i += c.batch_size) {
        const batch = addrs.slice(i, i + c.batch_size);
        let res: { data?: any[] };
        try {
          res = await this.http.get<{ data?: any[] }>(
            "/pools",
            { page_size: batch.length, timeframe, filter_by: `pool_address in [${batch.join(",")}]` },
            "/pools",
          );
        } catch (e) {
          d.log.warn({ err: (e as Error).message, timeframe, n: batch.length }, "pool discovery batch failed");
          continue;
        }
        for (const p of res?.data ?? []) {
          if (typeof p?.pool_address !== "string" || !d.pools.has(p.pool_address)) continue;
          const row: Row = { pool: p.pool_address, ts: now, session_id: d.sessionId, timeframe, ...parsePoolDiscovery(p) };
          d.db.insert("pool_discovery", row, "OR REPLACE");
          rows.push(row);
        }
      }
    }
    return rows;
  }

  run(signal: AbortSignal) {
    return every(this.d.config.collectors.pool_discovery.interval_seconds * 1000, signal, async () => void (await this.tick()));
  }
}

export interface PoolDiscoveryRow {
  pool: string;
  ts: number;
  timeframe: string;
  volatility: number | null;
  price_change_pct: number | null;
  net_deposits: number | null;
  unique_traders: number | null;
  swap_count: number | null;
  unique_lps: number | null;
  fee_active_tvl_ratio: number | null;
  base_holders_change_pct: number | null;
  warnings_x: string | null;
  warnings_y: string | null;
}

/**
 * Latest row of a pool and timeframe at or before t (look-ahead safe), or null when it is older
 * than maxAgeMs: a stale window must not describe the present.
 */
export function poolDiscoveryLookup(db: Db, maxAgeMs: number) {
  return (pool: string, timeframe: string, t: number): PoolDiscoveryRow | null => {
    const r = db.get<PoolDiscoveryRow>(
      `SELECT pool, ts, timeframe, volatility, price_change_pct, net_deposits, unique_traders, swap_count, unique_lps, fee_active_tvl_ratio, base_holders_change_pct, warnings_x, warnings_y
       FROM pool_discovery WHERE pool = ? AND timeframe = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
      pool, timeframe, t,
    );
    return r && t - r.ts <= maxAgeMs ? r : null;
  };
}

/**
 * Meridian's discovery filter `base_token_has_critical_warnings=false` / `quote_token_has_critical_warnings=false`:
 * true when either token carries a warning of severity `critical` (e.g. TRANSFER_FEE_CONFIGURED), false when
 * warnings were reported and none is critical, null when the API gave no warnings field.
 */
export function hasCriticalWarning(r: Pick<PoolDiscoveryRow, "warnings_x" | "warnings_y">): boolean | null {
  if (r.warnings_x === null && r.warnings_y === null) return null;
  return [r.warnings_x, r.warnings_y].some((w) => {
    try {
      return (JSON.parse(w ?? "[]") as { severity?: string }[]).some((x) => x.severity === "critical");
    } catch {
      return false;
    }
  });
}
