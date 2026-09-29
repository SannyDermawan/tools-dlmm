import type { Config } from "../config/schema.ts";
import type { Db, Row } from "../db/index.ts";
import { JsonHttp } from "../api/meteora.ts";
import type { UsageTracker } from "../chain/usage.ts";
import { every } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { GapTracker } from "./gaps.ts";
import type { PoolMeta } from "./types.ts";
import { riskTokens } from "./extraCollectors.ts";

const ms = (v: unknown): number | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : v != null && Number.isFinite(Number(v)) ? Number(v) : null);

export interface JupToken {
  id: string;
  symbol?: string;
  name?: string;
  [k: string]: unknown;
}

const volume24h = (j: any): number | null => {
  const s = j?.stats24h;
  if (!s) return null;
  const v = (num(s.buyVolume) ?? 0) + (num(s.sellVolume) ?? 0);
  return Number.isFinite(v) ? v : null;
};

/**
 * Jupiter Tokens API V2 token (+ optional datapi extras) -> token_audit row fields.
 * Field names verified against live responses on 2026-09-29. datapi adds botHoldersPercentage,
 * botHoldersCount, bundlerStats and fees; the official API does not return them.
 */
export function parseJupiterToken(j: any, extra?: any): Row {
  const a = { ...(j?.audit ?? {}), ...(extra?.audit ?? {}) };
  const bundle = extra?.audit?.bundlerStats;
  return {
    symbol: j.symbol ?? null,
    name: j.name ?? null,
    organic_score: num(j.organicScore),
    organic_label: j.organicScoreLabel ?? null,
    holder_count: num(j.holderCount),
    mcap_usd: num(j.mcap),
    fdv_usd: num(j.fdv),
    usd_price: num(j.usdPrice),
    liquidity_usd: num(j.liquidity),
    launchpad: j.launchpad ?? null,
    dev: j.dev ?? null,
    token_created_at: ms(j.createdAt),
    first_pool_at: ms(j.firstPool?.createdAt),
    top_holders_pct: num(a.topHoldersPercentage),
    dev_balance_pct: num(a.devBalancePercentage),
    dev_mints: num(a.devMints),
    dev_migrations: num(a.devMigrations),
    bot_holders_pct: num(a.botHoldersPercentage),
    bot_holders_count: num(a.botHoldersCount),
    bundler_holding_pct: bundle && num(bundle.holdingPct) !== null ? num(bundle.holdingPct)! * 100 : null,
    fees_sol: num(extra?.fees),
    // documented behaviour: audit.isSus is only present when the token was flagged
    is_sus: "isSus" in a ? 1 : 0,
    is_verified: j.isVerified === true ? 1 : j.isVerified === false ? 0 : null,
    tags: JSON.stringify(j.tags ?? []),
    volume_24h_usd: volume24h(j),
  };
}

/**
 * PVP rivals (addendum 3.3): other mints with the same symbol or name (case-insensitive) that
 * traded at least `minVolume` USD in the last 24 h. `results` is a Jupiter symbol search.
 */
export function pvpRivals(
  token: { mint: string; symbol: string | null; name: string | null },
  results: any[],
  minVolume: number,
): { mint: string; symbol: string; name: string; volume_24h: number }[] {
  const sym = token.symbol?.trim().toLowerCase();
  const name = token.name?.trim().toLowerCase();
  const out: { mint: string; symbol: string; name: string; volume_24h: number }[] = [];
  const seen = new Set<string>();
  for (const r of results ?? []) {
    if (!r?.id || r.id === token.mint || seen.has(r.id)) continue;
    const same = (sym && String(r.symbol ?? "").trim().toLowerCase() === sym) || (name && String(r.name ?? "").trim().toLowerCase() === name);
    if (!same) continue;
    const v = volume24h(r) ?? 0;
    if (v < minVolume) continue;
    seen.add(r.id);
    out.push({ mint: r.id, symbol: r.symbol ?? "", name: r.name ?? "", volume_24h: v });
  }
  return out.sort((a, b) => b.volume_24h - a.volume_24h);
}

export interface AuditDeps {
  db: Db;
  log: Logger;
  gaps: GapTracker;
  config: Config;
  sessionId: string;
  pools: Map<string, PoolMeta>;
  usage?: UsageTracker;
  signal?: AbortSignal;
  /** injected clients (tests) */
  tokensHttp?: Pick<JsonHttp, "get">;
  datapiHttp?: Pick<JsonHttp, "get"> | null;
}

/**
 * Jupiter token audit (addendum 3.1): organic score, holders, market cap, launchpad, dev, audit
 * flags and — from the unofficial datapi when enabled — bot holders. One batch request per
 * `batch_size` mints every `interval_minutes` (cache), plus one symbol search per batch for PVP
 * rivals. Rows go to token_audit with their timestamp (readers take the latest row <= t).
 */
export class TokenAuditCollector {
  static readonly SOURCE = "token_audit";
  private tokens: Pick<JsonHttp, "get">;
  private datapi: Pick<JsonHttp, "get"> | null;

  constructor(private readonly d: AuditDeps) {
    const j = d.config.api.jupiter;
    const key = process.env.JUPITER_API_KEY?.trim();
    const mk = (baseUrl: string, label: string, headers?: Record<string, string>) =>
      new JsonHttp(
        { baseUrl, maxRps: j.max_rps, timeoutMs: d.config.api.request_timeout_ms, retry: { ...d.config.api.retry, max_attempts: 3 }, usage: d.usage, log: d.log, signal: d.signal, headers },
        label,
      );
    this.tokens = d.tokensHttp ?? (key ? mk(j.keyed_tokens_base_url, "jupiter", { "x-api-key": key }) : mk(j.tokens_base_url, "jupiter"));
    this.datapi = d.datapiHttp !== undefined ? d.datapiHttp : j.use_datapi ? mk(j.datapi_base_url, "jupiter_datapi") : null;
  }

  async tick(now = Date.now()) {
    const { d } = this;
    const mints = [...riskTokens(d.pools.values(), d.config).keys()];
    const size = d.config.api.jupiter.batch_size;
    for (let i = 0; i < mints.length; i += size) {
      const batch = mints.slice(i, i + size);
      await this.auditBatch(batch, now);
    }
  }

  async auditBatch(batch: string[], now = Date.now()): Promise<Row[]> {
    const { d } = this;
    const rows: Row[] = [];
    let main: any[] = [];
    let err: string | null = null;
    try {
      main = await this.tokens.get<any[]>("/search", { query: batch.join(",") }, "/tokens/v2/search");
    } catch (e) {
      err = `tokens_v2: ${(e as Error).message}`;
    }
    let extras = new Map<string, any>();
    if (this.datapi && !err) {
      try {
        const x = await this.datapi.get<any[]>("/assets/search", { query: batch.join(",") }, "/v1/assets/search");
        extras = new Map((x ?? []).map((t) => [t.id, t]));
      } catch (e) {
        d.log.warn({ err: (e as Error).message }, "jupiter datapi failed (bot holders unavailable this round)");
      }
    }
    const byId = new Map((main ?? []).map((t) => [t.id, t]));
    // PVP: one symbol search per batch (comma-separated symbols)
    const pvp = d.config.collectors.token_audit.pvp;
    let rivalsPool: any[] = [];
    if (pvp.enabled && !err) {
      const symbols = [...new Set(batch.map((m) => byId.get(m)?.symbol).filter((s): s is string => !!s && !/[,]/.test(s)))];
      for (let i = 0; i < symbols.length; i += 20) {
        try {
          const r = await this.tokens.get<any[]>("/search", { query: symbols.slice(i, i + 20).join(",") }, "/tokens/v2/search");
          rivalsPool.push(...(r ?? []));
        } catch (e) {
          d.log.warn({ err: (e as Error).message }, "jupiter symbol search failed (pvp unavailable this round)");
          rivalsPool = [];
          break;
        }
      }
    }
    for (const mint of batch) {
      const j = byId.get(mint);
      const row: Row = { token: mint, ts: now, session_id: d.sessionId, source: extras.size ? "tokens_v2+datapi" : "tokens_v2" };
      if (!j) row.error = err ?? "token not found in Jupiter search";
      else {
        Object.assign(row, parseJupiterToken(j, extras.get(mint)));
        if (pvp.enabled && rivalsPool.length) {
          const riv = pvpRivals({ mint, symbol: j.symbol ?? null, name: j.name ?? null }, rivalsPool, pvp.min_rival_volume_24h_usd);
          row.pvp_rival_count = riv.length;
          row.pvp_rivals = JSON.stringify(riv.slice(0, 10));
        }
      }
      d.db.insert("token_audit", row, "OR REPLACE");
      if (!row.error) d.gaps.ok(TokenAuditCollector.SOURCE, mint);
      rows.push(row);
    }
    if (err) d.log.warn({ err, n: batch.length }, "token audit batch failed");
    return rows;
  }

  run(signal: AbortSignal) {
    return every(this.d.config.collectors.token_audit.interval_minutes * 60_000, signal, () => this.tick());
  }
}
