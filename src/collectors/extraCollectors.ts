import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import { JsonHttp, type MeteoraApi } from "../api/meteora.ts";
import type { RpcClient } from "../chain/rpc.ts";
import type { UsageTracker } from "../chain/usage.ts";
import { every } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { GapTracker } from "./gaps.ts";
import type { PoolMeta } from "./types.ts";

export interface ExtraDeps {
  db: Db;
  log: Logger;
  gaps: GapTracker;
  config: Config;
  sessionId: string;
  pools: Map<string, PoolMeta>;
  api: MeteoraApi;
  rpc: RpcClient;
  usage?: UsageTracker;
  signal?: AbortSignal;
}

/** Free public APIs share one conservative client (they rate-limit per IP). */
export function publicHttp(c: Config, baseUrl: string, label: string, d: { usage?: UsageTracker; log?: Logger; signal?: AbortSignal }) {
  return new JsonHttp(
    { baseUrl, maxRps: c.api.public_max_rps, timeoutMs: c.api.request_timeout_ms, retry: { ...c.api.retry, max_attempts: 3 }, usage: d.usage, log: d.log, signal: d.signal },
    label,
  );
}

/** Tokens whose other venues / attention matter: the non-bluechip tokens of the monitored pools. */
export function riskTokens(pools: Iterable<PoolMeta>, c: Config): Map<string, string> {
  const blue = new Set(c.categories.bluechip_tokens);
  const out = new Map<string, string>(); // mint -> symbol
  for (const p of pools) {
    if (!blue.has(p.tokenX)) out.set(p.tokenX, p.symbolX);
    if (!blue.has(p.tokenY)) out.set(p.tokenY, p.symbolY);
  }
  return out;
}

export interface VenuePair {
  dex: string;
  labels: string[];
  pair: string;
  quote: string;
  volume_h1: number;
  volume_h24: number;
  liquidity: number;
  boosts: number;
}

/** DexScreener token-pairs -> compact pair list. */
export function parseDexPairs(raw: any[]): { pairs: VenuePair[]; socials: number; websites: number } {
  const pairs: VenuePair[] = (raw ?? []).map((p) => ({
    dex: p.dexId,
    labels: p.labels ?? [],
    pair: p.pairAddress,
    quote: p.quoteToken?.symbol ?? "",
    volume_h1: Number(p.volume?.h1 ?? 0),
    volume_h24: Number(p.volume?.h24 ?? 0),
    liquidity: Number(p.liquidity?.usd ?? 0),
    boosts: Number(p.boosts?.active ?? 0),
  }));
  const info = (raw ?? []).map((p) => p.info).find((i) => i) ?? {};
  return { pairs, socials: (info.socials ?? []).length, websites: (info.websites ?? []).length };
}

/**
 * Other venues of each risk token (blueprint 4.5): every pair across DEXes with volume and
 * liquidity -> this pool's share of the token's volume. Also yields attention proxies from the
 * token profile (social links) and paid boosts.
 */
export class VenueCollector {
  static readonly SOURCE = "venues";
  private http: JsonHttp;
  constructor(private readonly d: ExtraDeps) {
    this.http = publicHttp(d.config, d.config.api.dexscreener_base_url, "dexscreener", d);
  }

  async tick() {
    const { d } = this;
    const ts = Date.now();
    for (const [mint] of riskTokens(d.pools.values(), d.config)) {
      try {
        const raw = await this.http.get<any[]>(`/token-pairs/v1/solana/${mint}`, {}, "/token-pairs");
        const { pairs, socials, websites } = parseDexPairs(raw);
        d.db.insert(
          "token_venues",
          {
            token: mint, ts, session_id: d.sessionId, pairs: pairs.length,
            volume_h1_usd: pairs.reduce((s, p) => s + p.volume_h1, 0), volume_h24_usd: pairs.reduce((s, p) => s + p.volume_h24, 0),
            liquidity_usd: pairs.reduce((s, p) => s + p.liquidity, 0), pairs_json: JSON.stringify(pairs), source: "dexscreener",
          },
          "OR REPLACE",
        );
        d.db.run(
          `INSERT INTO attention_metrics (token, ts, session_id, boosts_active, socials, websites, source) VALUES (?,?,?,?,?,?,'dexscreener')
           ON CONFLICT(token, ts) DO UPDATE SET boosts_active=excluded.boosts_active, socials=excluded.socials, websites=excluded.websites`,
          mint, ts, d.sessionId, pairs.reduce((s, p) => s + p.boosts, 0), socials, websites,
        );
        d.gaps.ok(VenueCollector.SOURCE, null, ts);
      } catch (e) {
        d.log.warn({ mint, err: (e as Error).message }, "venues fetch failed");
      }
    }
  }

  run(signal: AbortSignal) {
    this.d.gaps.register(VenueCollector.SOURCE, null);
    return every(this.d.config.collectors.venues.interval_seconds * 1000, signal, () => this.tick());
  }
}

/**
 * Attention proxies (blueprint 4.6, P1-P2): CoinGecko trending (matched by symbol — a weak link,
 * kept as a proxy) for the risk tokens. X/Twitter mentions need a paid API and are not collected.
 */
export class AttentionCollector {
  static readonly SOURCE = "attention";
  private http: JsonHttp;
  constructor(private readonly d: ExtraDeps) {
    this.http = publicHttp(d.config, d.config.api.coingecko_base_url, "coingecko", d);
  }

  async tick() {
    const { d } = this;
    const ts = Date.now();
    try {
      const r = await this.http.get<{ coins: { item: { symbol: string } }[] }>("/search/trending", {}, "/search/trending");
      const rank = new Map<string, number>();
      (r.coins ?? []).forEach((c, i) => rank.set(String(c.item.symbol).toUpperCase(), i + 1));
      for (const [mint, sym] of riskTokens(d.pools.values(), d.config)) {
        const tr = rank.get(String(sym).toUpperCase()) ?? null;
        d.db.run(
          `INSERT INTO attention_metrics (token, ts, session_id, trending_rank, source) VALUES (?,?,?,?,'coingecko')
           ON CONFLICT(token, ts) DO UPDATE SET trending_rank=excluded.trending_rank`,
          mint, ts, d.sessionId, tr,
        );
      }
      d.gaps.ok(AttentionCollector.SOURCE, null, ts);
    } catch (e) {
      d.log.warn({ err: (e as Error).message }, "attention fetch failed");
    }
  }

  run(signal: AbortSignal) {
    this.d.gaps.register(AttentionCollector.SOURCE, null);
    return every(this.d.config.collectors.attention.interval_seconds * 1000, signal, () => this.tick());
  }
}

/**
 * Macro / ecosystem context (blueprint 4.7-4.9): BTC price + dominance, Fear & Greed, USD/IDR
 * (reporting only), Solana DEX volume and stablecoin supply (DefiLlama), network TPS, new DLMM
 * pools and launchpad pools per hour. Each source is optional; failures leave NULLs.
 */
export class MacroCollector {
  static readonly SOURCE = "macro";
  private cg: JsonHttp;
  private fng: JsonHttp;
  private fx: JsonHttp;
  private llama: JsonHttp;
  private stables: JsonHttp;
  constructor(private readonly d: ExtraDeps) {
    const c = d.config.api;
    this.cg = publicHttp(d.config, c.coingecko_base_url, "coingecko", d);
    this.fng = publicHttp(d.config, c.fear_greed_url, "fear_greed", d);
    this.fx = publicHttp(d.config, c.fx_url, "fx", d);
    this.llama = publicHttp(d.config, c.defillama_base_url, "defillama", d);
    this.stables = publicHttp(d.config, c.defillama_stables_url, "defillama", d);
  }

  private async safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      this.d.log.warn({ source: label, err: (e as Error).message }, "macro source failed");
      return null;
    }
  }

  async tick() {
    const { d } = this;
    const ts = Date.now();
    const price = await this.safe("coingecko", () => this.cg.get<any>("/simple/price", { ids: "bitcoin", vs_currencies: "usd" }, "/simple/price"));
    const global = await this.safe("coingecko", () => this.cg.get<any>("/global", {}, "/global"));
    const fng = await this.safe("fear_greed", () => this.fng.get<any>("", { limit: 1 }, "fng"));
    const fx = await this.safe("fx", () => this.fx.get<any>("/USD", {}, "fx"));
    const dex = await this.safe("defillama", () =>
      this.llama.get<any>("/overview/dexs/solana", { excludeTotalDataChart: "true", excludeTotalDataChartBreakdown: "true" }, "/overview/dexs"),
    );
    const st = await this.safe("defillama", () => this.stables.get<any[]>("/stablecoincharts/Solana", {}, "/stablecoincharts"));
    const perf = await this.safe("rpc", () => d.rpc.call<{ numTransactions: number; samplePeriodSecs: number }[]>("getRecentPerformanceSamples", [5]));
    const pools = await this.safe("meteora", () => d.api.listPools({ pageSize: 200, sortBy: "pool_created_at:desc" }));
    const recent = pools ? pools.data.filter((p) => p.created_at && ts - p.created_at <= 3_600_000) : null;
    const row = {
      ts, session_id: d.sessionId,
      btc_usd: price?.bitcoin?.usd ?? null,
      btc_dominance: global?.data?.market_cap_percentage?.btc ?? null,
      fear_greed: fng?.data?.[0]?.value != null ? Number(fng.data[0].value) : null,
      usd_idr: fx?.rates?.IDR ?? null,
      sol_dex_volume_24h: dex?.total24h ?? null,
      sol_dex_change_1d: dex?.change_1d ?? null,
      sol_stablecoins_usd: st?.length ? Number(st[st.length - 1]?.totalCirculatingUSD?.peggedUSD ?? NaN) || null : null,
      tps: perf?.length ? perf.reduce((s, x) => s + x.numTransactions, 0) / perf.reduce((s, x) => s + x.samplePeriodSecs, 0) : null,
      new_pools_1h: recent ? recent.length : null,
      launchpad_pools_1h: recent ? recent.filter((p) => p.launchpad).length : null,
    };
    d.db.insert("macro_metrics", row, "OR REPLACE");
    if (row.btc_usd !== null) d.gaps.ok(MacroCollector.SOURCE, null, ts);
  }

  run(signal: AbortSignal) {
    this.d.gaps.register(MacroCollector.SOURCE, null);
    return every(this.d.config.collectors.macro.interval_seconds * 1000, signal, () => this.tick());
  }
}
