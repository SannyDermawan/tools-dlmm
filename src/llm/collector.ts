import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import type { JsonHttp } from "../api/meteora.ts";
import type { PoolMeta } from "../collectors/types.ts";
import { riskTokens } from "../collectors/extraCollectors.ts";
import { every } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { LlmLayer } from "./layer.ts";

/**
 * LLM token features (addendum 6.2), only while the layer is active:
 *  - token_social: Jupiter metadata + DexScreener profile links -> llm_social_score (safety);
 *  - narrative: needs social posts; no free source is wired yet (X / Telegram), so the role stays
 *    idle until a post source exists — the scoring feature then stays null.
 * Each risk token is refreshed at most every interval_minutes; the layer caches and budgets calls.
 */
export class LlmFeatureCollector {
  constructor(
    private readonly db: Db,
    private readonly c: Config,
    private readonly layer: LlmLayer,
    private readonly pools: Map<string, PoolMeta>,
    private readonly dexscreener: Pick<JsonHttp, "get"> | null,
    private readonly log?: Logger,
    private readonly sessionId?: string,
  ) {}

  async tick(now = Date.now()): Promise<{ scored: number; skipped: string | null }> {
    const act = this.layer.activation();
    if (!act.active) return { scored: 0, skipped: act.reason };
    if (!this.c.llm.roles.token_social) return { scored: 0, skipped: "role token_social disabled" };
    let scored = 0;
    const tokens = [...riskTokens(this.pools.values(), this.c).keys()];
    for (const token of tokens) {
      if (scored >= this.c.llm.max_tokens_per_round) break;
      const recent = this.db.get("SELECT 1 x FROM llm_features WHERE token = ? AND name = 'llm_social_score' AND ts > ?", token, now - this.c.llm.interval_minutes * 60_000);
      if (recent) continue;
      const data = await this.tokenData(token);
      const r = await this.layer.tokenSocial(token, data, { sessionId: this.sessionId });
      if (!r.ok) {
        this.log?.info({ token, reason: r.reason }, "llm token_social skipped");
        if (r.reason?.startsWith("daily budget") || r.reason?.startsWith("hourly call cap")) break;
        continue;
      }
      this.db.insert("llm_features", { token, ts: now, name: "llm_social_score", value: r.value!.social_quality_score, call_id: r.callId ?? null }, "OR REPLACE");
      scored++;
    }
    return { scored, skipped: null };
  }

  /** Our own metadata + profile links; everything third-party is sanitized by the layer. */
  async tokenData(token: string): Promise<Record<string, unknown>> {
    const au = this.db.get<{ symbol: string | null; name: string | null; organic_score: number | null; launchpad: string | null; is_verified: number | null; tags: string | null; holder_count: number | null }>(
      "SELECT symbol, name, organic_score, launchpad, is_verified, tags, holder_count FROM token_audit WHERE token = ? AND error IS NULL ORDER BY ts DESC LIMIT 1", token,
    );
    let links: { websites: string[]; socials: { type: string; url: string }[]; description: string | null } = { websites: [], socials: [], description: null };
    if (this.dexscreener) {
      try {
        const pairs = await this.dexscreener.get<any[]>(`/tokens/v1/solana/${token}`, {}, "/tokens/v1/solana/{mint}");
        const info = (pairs ?? []).map((p) => p?.info).find(Boolean) ?? {};
        links = {
          websites: (info.websites ?? []).map((w: any) => String(w?.url ?? "")).filter(Boolean).slice(0, 5),
          socials: (info.socials ?? []).map((s: any) => ({ type: String(s?.type ?? ""), url: String(s?.url ?? "") })).slice(0, 8),
          description: info.description ?? null,
        };
      } catch (e) {
        this.log?.debug({ token, err: (e as Error).message }, "dexscreener profile failed");
      }
    }
    return {
      mint: token, symbol: au?.symbol ?? null, name: au?.name ?? null, jupiter_verified: au?.is_verified ?? null, jupiter_tags: au?.tags ? JSON.parse(au.tags) : [],
      organic_score: au?.organic_score ?? null, launchpad: au?.launchpad ?? null, holders: au?.holder_count ?? null, ...links,
    };
  }

  run(signal: AbortSignal) {
    return every(this.c.llm.interval_minutes * 60_000, signal, async () => {
      await this.tick();
    });
  }
}

/** Latest LLM feature of a token at t (ts <= t, younger than maxAgeMs). */
export function llmFeatureLookup(db: Db, maxAgeMs: number) {
  const cache = new Map<string, number | null>();
  return (token: string, name: string, t: number): number | null => {
    const k = `${token}|${name}|${Math.floor(t / 60_000)}`;
    if (cache.has(k)) return cache.get(k)!;
    const r = db.get<{ value: number | null; ts: number }>("SELECT value, ts FROM llm_features WHERE token = ? AND name = ? AND ts <= ? ORDER BY ts DESC LIMIT 1", token, name, t);
    const v = r && t - r.ts <= maxAgeMs ? r.value : null;
    if (cache.size > 5000) cache.clear();
    cache.set(k, v);
    return v;
  };
}
