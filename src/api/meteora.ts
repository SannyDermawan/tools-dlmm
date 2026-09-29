import { errText, RateLimiter, RetryableError, withRetry } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { UsageTracker } from "../chain/usage.ts";

/** Shapes verified against https://dlmm.datapi.meteora.ag/api-docs/openapi.json (2026-09-29). */
export interface ApiToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  is_verified: boolean;
  holders?: number;
  freeze_authority_disabled?: boolean;
  total_supply?: number;
  price: number;
  market_cap?: number;
}

export type Windowed = Partial<Record<"5m" | "30m" | "1h" | "2h" | "4h" | "12h" | "24h", number>>;

export interface ApiPool {
  address: string;
  name: string;
  token_x: ApiToken;
  token_y: ApiToken;
  reserve_x: string;
  reserve_y: string;
  token_x_amount: number;
  token_y_amount: number;
  created_at: number; // ms
  pool_config: { bin_step: number; base_fee_pct: number; max_fee_pct: number; protocol_fee_pct: number; collect_fee_mode: number };
  dynamic_fee_pct: number;
  tvl: number;
  current_price: number;
  apr: number;
  volume: Windowed;
  fees: Windowed;
  protocol_fees: Windowed;
  fee_tvl_ratio: Windowed;
  is_blacklisted: boolean;
  launchpad?: string;
  tags?: string[];
}

export interface Paged<T> {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: T[];
}

export interface OhlcvPoint {
  timestamp: number; // seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VolumePoint {
  timestamp: number; // seconds
  volume: number;
  fees: number;
  protocol_fees: number;
}

export interface MeteoraApiOptions {
  baseUrl: string;
  maxRps: number;
  timeoutMs: number;
  retry: { max_attempts: number; base_delay_ms: number; max_delay_ms: number };
  usage?: UsageTracker;
  log?: Logger;
  signal?: AbortSignal;
  /** extra request headers (e.g. an API key); never logged */
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Generic rate-limited JSON GET with retry. */
export class JsonHttp {
  private limiter: RateLimiter;
  lastOkAt = 0;
  consecutiveErrors = 0;
  constructor(private readonly o: MeteoraApiOptions, private readonly endpoint: string) {
    this.limiter = new RateLimiter(o.maxRps, 4);
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}, label = path): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), this.o.baseUrl.endsWith("/") ? this.o.baseUrl : this.o.baseUrl + "/");
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    return withRetry(
      () =>
        this.limiter.run(async () => {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(this.o.timeoutMs), headers: { accept: "application/json", ...this.o.headers } });
            if (res.status === 429) this.limiter.throttle();
            if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status} ${label}`);
            if (!res.ok) throw new HttpError(`HTTP ${res.status} ${label}: ${(await res.text()).slice(0, 200)}`, res.status);
            const body = (await res.json()) as T;
            this.o.usage?.record(this.endpoint, label, true);
            this.limiter.success();
            this.lastOkAt = Date.now();
            this.consecutiveErrors = 0;
            return body;
          } catch (e) {
            this.o.usage?.record(this.endpoint, label, false);
            this.consecutiveErrors++;
            throw e;
          }
        }),
      {
        maxAttempts: this.o.retry.max_attempts,
        baseDelayMs: this.o.retry.base_delay_ms,
        maxDelayMs: this.o.retry.max_delay_ms,
        signal: this.o.signal,
        isRetryable: (e) => !(e instanceof HttpError),
        onRetry: (e, attempt, delay) => this.o.log?.warn({ label, attempt, delay, err: errText(e) }, "http retry"),
      },
    );
  }
}

export class MeteoraApi {
  readonly http: JsonHttp;
  constructor(o: MeteoraApiOptions) {
    this.http = new JsonHttp(o, "api");
  }

  listPools(q: { page?: number; pageSize?: number; sortBy?: string; filterBy?: string; query?: string }) {
    return this.http.get<Paged<ApiPool>>(
      "/pools",
      { page: q.page ?? 1, page_size: q.pageSize ?? 100, sort_by: q.sortBy, filter_by: q.filterBy, query: q.query },
      "/pools",
    );
  }

  getPool(address: string) {
    return this.http.get<ApiPool>(`/pools/${address}`, {}, "/pools/{address}");
  }

  async ohlcv(address: string, timeframe: string, startSec?: number, endSec?: number): Promise<OhlcvPoint[]> {
    const r = await this.http.get<{ data: OhlcvPoint[] }>(
      `/pools/${address}/ohlcv`,
      { timeframe, start_time: startSec, end_time: endSec },
      "/pools/{address}/ohlcv",
    );
    return r.data ?? [];
  }

  async volumeHistory(address: string, timeframe: string, startSec?: number, endSec?: number): Promise<VolumePoint[]> {
    const r = await this.http.get<{ data: VolumePoint[] }>(
      `/pools/${address}/volume/history`,
      { timeframe, start_time: startSec, end_time: endSec },
      "/pools/{address}/volume/history",
    );
    return r.data ?? [];
  }
}
