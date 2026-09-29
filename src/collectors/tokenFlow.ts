import type { Config } from "../config/schema.ts";
import type { Db, Row } from "../db/index.ts";
import { JsonHttp } from "../api/meteora.ts";
import type { UsageTracker } from "../chain/usage.ts";
import { every } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { GapTracker } from "./gaps.ts";
import type { PoolMeta } from "./types.ts";
import { riskTokens } from "./extraCollectors.ts";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : v != null && Number.isFinite(Number(v)) ? Number(v) : null);

/** Jupiter token (+ datapi extras) -> token_flow row fields (field names verified 2026-09-29). */
export function parseTokenFlow(j: any, extra?: any): Row {
  const s = j?.stats5m ?? {};
  const b = extra?.audit?.bundlerStats;
  return {
    holder_count: num(extra?.holderCount) ?? num(j?.holderCount),
    bundler_pct: b ? num(b.holdingPct) : null, // already in % (not a fraction: live values up to 4.3)
    buy_volume_5m: num(s.buyVolume),
    sell_volume_5m: num(s.sellVolume),
    num_buys_5m: num(s.numBuys),
    num_sells_5m: num(s.numSells),
    liquidity_usd: num(j?.liquidity),
    usd_price: num(j?.usdPrice),
  };
}

export interface FlowDeps {
  db: Db;
  log: Logger;
  gaps: GapTracker;
  config: Config;
  sessionId: string;
  pools: Map<string, PoolMeta>;
  usage?: UsageTracker;
  signal?: AbortSignal;
  tokensHttp?: Pick<JsonHttp, "get">;
  datapiHttp?: Pick<JsonHttp, "get"> | null;
}

/**
 * Per-minute token flow (Friday playbook, stage 2): holder count, bundler holding % (datapi,
 * unofficial) and Jupiter's rolling 5-minute buy / sell stats for every risk token of the
 * monitored pools. One batch request per `batch_size` mints (+ one datapi request) per interval.
 */
export class TokenFlowCollector {
  static readonly SOURCE = "token_flow";
  private tokens: Pick<JsonHttp, "get">;
  private datapi: Pick<JsonHttp, "get"> | null;

  constructor(private readonly d: FlowDeps) {
    const j = d.config.api.jupiter;
    const key = process.env.JUPITER_API_KEY?.trim();
    const mk = (baseUrl: string, label: string, headers?: Record<string, string>) =>
      new JsonHttp(
        { baseUrl, maxRps: j.max_rps, timeoutMs: d.config.api.request_timeout_ms, retry: { ...d.config.api.retry, max_attempts: 2 }, usage: d.usage, log: d.log, signal: d.signal, headers },
        label,
      );
    this.tokens = d.tokensHttp ?? (key ? mk(j.keyed_tokens_base_url, "jupiter_flow", { "x-api-key": key }) : mk(j.tokens_base_url, "jupiter_flow"));
    this.datapi = d.datapiHttp !== undefined ? d.datapiHttp : j.use_datapi ? mk(j.datapi_base_url, "jupiter_flow_datapi") : null;
  }

  async tick(now = Date.now()): Promise<Row[]> {
    const { d } = this;
    const mints = [...riskTokens(d.pools.values(), d.config).keys()];
    const size = d.config.api.jupiter.batch_size;
    const rows: Row[] = [];
    for (let i = 0; i < mints.length; i += size) {
      const batch = mints.slice(i, i + size);
      let main: any[] = [];
      try {
        main = await this.tokens.get<any[]>("/search", { query: batch.join(",") }, "/tokens/v2/search");
      } catch (e) {
        d.log.warn({ err: (e as Error).message, n: batch.length }, "token flow batch failed");
        continue;
      }
      let extras = new Map<string, any>();
      if (this.datapi) {
        try {
          extras = new Map(((await this.datapi.get<any[]>("/assets/search", { query: batch.join(",") }, "/v1/assets/search")) ?? []).map((t) => [t.id, t]));
        } catch (e) {
          d.log.warn({ err: (e as Error).message }, "token flow datapi failed (bundlers unavailable this minute)");
        }
      }
      const byId = new Map((main ?? []).map((t) => [t.id, t]));
      for (const mint of batch) {
        const j = byId.get(mint);
        if (!j) continue;
        const row: Row = { token: mint, ts: now, session_id: d.sessionId, source: extras.has(mint) ? "tokens_v2+datapi" : "tokens_v2", ...parseTokenFlow(j, extras.get(mint)) };
        d.db.insert("token_flow", row, "OR REPLACE");
        d.gaps.ok(TokenFlowCollector.SOURCE, mint);
        rows.push(row);
      }
    }
    return rows;
  }

  run(signal: AbortSignal) {
    return every(this.d.config.collectors.token_flow.interval_seconds * 1000, signal, async () => void (await this.tick()));
  }
}

export interface TokenFlowRow {
  token: string;
  ts: number;
  holder_count: number | null;
  bundler_pct: number | null;
  buy_volume_5m: number | null;
  sell_volume_5m: number | null;
}

/**
 * Token flow at t and one minute earlier (look-ahead safe: rows with ts <= t only). `now` must be
 * at most maxAgeMs old; `prev` is the latest row at or before t - 60 s, at most maxAgeMs older.
 */
export function tokenFlowLookup(db: Db, maxAgeMs: number) {
  const q = (token: string, t: number) =>
    db.get<TokenFlowRow>(
      "SELECT token, ts, holder_count, bundler_pct, buy_volume_5m, sell_volume_5m FROM token_flow WHERE token = ? AND ts <= ? ORDER BY ts DESC LIMIT 1",
      token, t,
    ) ?? null;
  return (token: string, t: number): { now: TokenFlowRow; prev: TokenFlowRow | null } | null => {
    const now = q(token, t);
    if (!now || t - now.ts > maxAgeMs) return null;
    const prev = q(token, now.ts - 60_000);
    return { now, prev: prev && now.ts - 60_000 - prev.ts <= maxAgeMs ? prev : null };
  };
}
