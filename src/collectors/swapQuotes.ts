import type { Config } from "../config/schema.ts";
import type { Db, Row } from "../db/index.ts";
import { JsonHttp } from "../api/meteora.ts";
import type { UsageTracker } from "../chain/usage.ts";
import { every } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { MarketBus, PoolMeta } from "./types.ts";

interface JupQuote {
  inAmount: string;
  outAmount: string;
  routePlan?: { swapInfo?: { label?: string } }[];
}

/** One-way cost (%) from a round trip: sent a, got back b after two swaps -> 1 - sqrt(b / a). */
export function oneWayCostPct(sent: bigint, back: bigint): number | null {
  if (sent <= 0n || back < 0n) return null;
  const r = Number(back) / Number(sent);
  if (!Number.isFinite(r) || r > 1.001) return null; // a profitable round trip is a stale / broken quote
  return Math.max(0, (1 - Math.sqrt(Math.max(0, r))) * 100); // tiny gains from rounding -> 0
}

export interface SwapQuoteDeps {
  db: Db;
  log: Logger;
  config: Config;
  sessionId: string;
  pools: Map<string, PoolMeta>;
  usdPrices: Map<string, { usd: number; ts: number }>;
  bus?: MarketBus;
  usage?: UsageTracker;
  signal?: AbortSignal;
  http?: Pick<JsonHttp, "get">;
}

/**
 * What a balancing swap really costs: a Jupiter round trip (quote -> base -> quote) of the typical
 * swap notional per pool, every interval. Real LPs swap through the aggregator (best route), not
 * through the DLMM pool at its dynamic fee, which on memecoin pools is 1-5 %. The simulator reads
 * the latest quote at or before t (bus in live sessions, swap_quotes in replays).
 */
export class SwapQuoteCollector {
  private readonly http: Pick<JsonHttp, "get">;
  constructor(private readonly d: SwapQuoteDeps) {
    const j = d.config.api.jupiter;
    const key = process.env.JUPITER_API_KEY?.trim();
    this.http = d.http ?? new JsonHttp(
      {
        baseUrl: key ? j.keyed_swap_base_url : j.swap_base_url, maxRps: j.max_rps, timeoutMs: d.config.api.request_timeout_ms,
        retry: { ...d.config.api.retry, max_attempts: 2 }, usage: d.usage, log: d.log, signal: d.signal, headers: key ? { "x-api-key": key } : undefined,
      },
      "jupiter_swap",
    );
  }

  async quotePool(m: PoolMeta, now: number): Promise<number | null> {
    const q = this.d.config.simulation.costs.aggregator;
    const yUsd = this.d.usdPrices.get(m.tokenY)?.usd ?? null;
    const row: Row = { pool: m.pool, ts: now, session_id: this.d.sessionId, notional_usd: q.quote_notional_usd };
    try {
      if (!yUsd) throw new Error("no USD price for the quote token yet");
      const a = BigInt(Math.floor((q.quote_notional_usd / yUsd) * 10 ** m.decimalsY));
      const leg1 = await this.http.get<JupQuote>("/quote", { inputMint: m.tokenY, outputMint: m.tokenX, amount: a.toString(), slippageBps: 50 }, "/swap/v1/quote");
      const leg2 = await this.http.get<JupQuote>("/quote", { inputMint: m.tokenX, outputMint: m.tokenY, amount: leg1.outAmount, slippageBps: 50 }, "/swap/v1/quote");
      const b = BigInt(leg2.outAmount);
      const cost = oneWayCostPct(a, b);
      Object.assign(row, {
        one_way_cost_pct: cost, in_amount: a.toString(), back_amount: b.toString(),
        route: JSON.stringify([...(leg1.routePlan ?? []), ...(leg2.routePlan ?? [])].map((r) => r.swapInfo?.label ?? "?")),
        error: cost === null ? "implausible round trip" : null,
      });
    } catch (e) {
      row.error = (e as Error).message.slice(0, 200);
    }
    this.d.db.insert("swap_quotes", row, "OR REPLACE");
    const cost = (row.one_way_cost_pct as number | null | undefined) ?? null;
    if (cost !== null) this.d.bus?.emit("swapQuote", { pool: m.pool, ts: now, costPct: cost });
    return cost;
  }

  async tick(now = Date.now()) {
    for (const m of this.d.pools.values()) {
      if (this.d.signal?.aborted) return;
      await this.quotePool(m, now);
    }
  }

  run(signal: AbortSignal) {
    return every(this.d.config.simulation.costs.aggregator.quote_interval_minutes * 60_000, signal, () => this.tick());
  }
}
