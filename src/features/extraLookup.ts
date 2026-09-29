import type { Db } from "../db/index.ts";

export interface VenueRow {
  ts: number;
  pairs: number;
  volume_h1_usd: number;
  pairs_json: string;
}
export interface AttentionView {
  ts: number;
  trending_rank: number | null;
  boosts_active: number | null;
  socials: number | null;
  websites: number | null;
}
export interface MacroRow {
  ts: number;
  btc_usd: number | null;
  btc_dominance: number | null;
  fear_greed: number | null;
  usd_idr: number | null;
  sol_dex_change_1d: number | null;
  tps: number | null;
  launchpad_pools_1h: number | null;
}

/** Look-ahead-safe access to the phase 7 tables: latest rows with ts <= t (and not older than maxAge). */
export interface ExtraLookup {
  venues(token: string, t: number): VenueRow | null;
  attention(token: string, t: number): AttentionView | null;
  macro(t: number, windowMs: number): MacroRow[];
}

export function extraLookup(db: Db, maxAgeMs: { venues: number; attention: number; macro: number }): ExtraLookup {
  const fresh = <T extends { ts: number }>(r: T | undefined, t: number, age: number) => (r && t - r.ts <= age ? r : null);
  return {
    venues: (token, t) =>
      fresh(db.get<VenueRow>("SELECT ts, pairs, volume_h1_usd, pairs_json FROM token_venues WHERE token = ? AND ts <= ? ORDER BY ts DESC LIMIT 1", token, t), t, maxAgeMs.venues),
    attention: (token, t) => {
      const tr = fresh(
        db.get<{ ts: number; trending_rank: number | null }>(
          "SELECT ts, trending_rank FROM attention_metrics WHERE token = ? AND ts <= ? AND source = 'coingecko' ORDER BY ts DESC LIMIT 1", token, t,
        ),
        t, maxAgeMs.attention,
      );
      const ds = fresh(
        db.get<{ ts: number; boosts_active: number | null; socials: number | null; websites: number | null }>(
          "SELECT ts, boosts_active, socials, websites FROM attention_metrics WHERE token = ? AND ts <= ? AND source = 'dexscreener' ORDER BY ts DESC LIMIT 1", token, t,
        ),
        t, maxAgeMs.venues,
      );
      if (!tr && !ds) return null;
      return {
        ts: Math.max(tr?.ts ?? 0, ds?.ts ?? 0),
        trending_rank: tr ? tr.trending_rank : null,
        boosts_active: ds?.boosts_active ?? null,
        socials: ds?.socials ?? null,
        websites: ds?.websites ?? null,
      };
    },
    macro: (t, windowMs) =>
      db.all<MacroRow>(
        "SELECT ts, btc_usd, btc_dominance, fear_greed, usd_idr, sol_dex_change_1d, tps, launchpad_pools_1h FROM macro_metrics WHERE ts <= ? AND ts > ? ORDER BY ts",
        t, t - Math.max(windowMs, maxAgeMs.macro),
      ),
  };
}
