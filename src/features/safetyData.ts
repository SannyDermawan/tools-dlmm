import type { Db } from "../db/index.ts";

/** Latest Jupiter audit of a token (token_audit row). */
export interface AuditRow {
  token: string;
  ts: number;
  symbol: string | null;
  organic_score: number | null;
  holder_count: number | null;
  mcap_usd: number | null;
  launchpad: string | null;
  dev: string | null;
  token_created_at: number | null;
  first_pool_at: number | null;
  top_holders_pct: number | null;
  dev_balance_pct: number | null;
  bot_holders_pct: number | null;
  bundler_holding_pct?: number | null;
  is_sus: number | null;
  pvp_rival_count: number | null;
}

/** Latest audit row with ts <= t and younger than maxAgeMs (look-ahead safe), cached per (token, t). */
export function auditLookup(db: Db, maxAgeMs: number) {
  const cache = new Map<string, AuditRow | null>();
  return (token: string, t: number): AuditRow | null => {
    const k = `${token}|${t}`;
    if (cache.has(k)) return cache.get(k)!;
    const r = db.get<AuditRow>(
      `SELECT token, ts, symbol, organic_score, holder_count, mcap_usd, launchpad, dev, token_created_at, first_pool_at, top_holders_pct,
              dev_balance_pct, bot_holders_pct, bundler_holding_pct, is_sus, pvp_rival_count
       FROM token_audit WHERE token = ? AND ts <= ? AND error IS NULL ORDER BY ts DESC LIMIT 1`,
      token, t,
    );
    const v = r && t - r.ts <= maxAgeMs ? r : null;
    if (cache.size > 5000) cache.clear();
    cache.set(k, v);
    return v;
  };
}

/** Audit row of a token `lagMs` before t (for dev-dump detection). */
export function auditAt(db: Db, token: string, t: number): AuditRow | null {
  return db.get<AuditRow>(
    `SELECT token, ts, symbol, organic_score, holder_count, mcap_usd, launchpad, dev, token_created_at, first_pool_at, top_holders_pct,
            dev_balance_pct, bot_holders_pct, bundler_holding_pct, is_sus, pvp_rival_count
     FROM token_audit WHERE token = ? AND ts <= ? AND error IS NULL ORDER BY ts DESC LIMIT 1`,
    token, t,
  ) ?? null;
}

export interface BlockHit {
  kind: "token" | "dev";
  key: string;
  reason: string;
  source: string;
}

/**
 * Blocklist lookup at time t: entries added at or before t and not removed by t, so replays of
 * older sessions are not changed by later additions. Tables are tiny; cached per (key, t).
 */
export function blocklistLookup(db: Db) {
  const cache = new Map<string, BlockHit | null>();
  const q = (table: "blocklist_tokens" | "blocklist_devs", col: "mint" | "wallet", key: string, t: number) =>
    db.get<{ reason: string; source: string }>(
      `SELECT reason, source FROM ${table} WHERE ${col} = ? AND added_at <= ? AND (removed_at IS NULL OR removed_at > ?) ORDER BY added_at DESC LIMIT 1`,
      key, t, t,
    );
  const look = (kind: "token" | "dev", key: string | null | undefined, t: number): BlockHit | null => {
    if (!key) return null;
    const k = `${kind}|${key}|${t}`;
    if (cache.has(k)) return cache.get(k)!;
    const r = kind === "token" ? q("blocklist_tokens", "mint", key, t) : q("blocklist_devs", "wallet", key, t);
    const v = r ? { kind, key, reason: r.reason, source: r.source } : null;
    if (cache.size > 5000) cache.clear();
    cache.set(k, v);
    return v;
  };
  return {
    token: (mint: string, t: number) => look("token", mint, t),
    dev: (wallet: string | null | undefined, t: number) => look("dev", wallet, t),
    /** forget cached misses (after an automatic addition during a live session) */
    invalidate: () => cache.clear(),
  };
}
export type BlocklistLookup = ReturnType<typeof blocklistLookup>;

export function addBlock(db: Db, kind: "token" | "dev", key: string, reason: string, source: string, t = Date.now(), detail?: unknown): boolean {
  const table = kind === "token" ? "blocklist_tokens" : "blocklist_devs";
  const col = kind === "token" ? "mint" : "wallet";
  const active = db.get(`SELECT 1 x FROM ${table} WHERE ${col} = ? AND removed_at IS NULL`, key);
  if (active) return false;
  db.insert(table, { [col]: key, reason, source, added_at: t, detail: detail === undefined ? null : JSON.stringify(detail) });
  return true;
}

export function removeBlock(db: Db, kind: "token" | "dev", key: string, t = Date.now()): number {
  const table = kind === "token" ? "blocklist_tokens" : "blocklist_devs";
  const col = kind === "token" ? "mint" : "wallet";
  return Number(db.run(`UPDATE ${table} SET removed_at = ? WHERE ${col} = ? AND removed_at IS NULL`, t, key).changes);
}

/**
 * Token-2022 transfer fee (bps) of a mint from token_security: the latest row at or before t,
 * whatever its age (a transfer fee is a mint setting), 0 when the mint has no such extension and
 * null when we never checked it. Cached per (token, hour).
 */
export function transferFeeLookup(db: Db) {
  const cache = new Map<string, number | null>();
  return (token: string, t: number): number | null => {
    const k = `${token}|${Math.floor(t / 3_600_000)}`;
    if (cache.has(k)) return cache.get(k)!;
    const r = db.get<{ bps: number | null }>(
      "SELECT transfer_fee_bps bps FROM token_security WHERE token = ? AND ts <= ? AND (error IS NULL OR mint_auth_active IS NOT NULL) ORDER BY ts DESC LIMIT 1", token, t,
    );
    const v = r ? (r.bps ?? 0) : null;
    if (cache.size > 2000) cache.clear();
    cache.set(k, v);
    return v;
  };
}
