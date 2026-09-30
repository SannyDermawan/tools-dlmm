import type { Db } from "../db/index.ts";

/**
 * Rug post-mortem: what did the tokens that our detector flagged (blocklist_tokens, source
 * auto_rug) look like SOME MINUTES BEFORE the rug, and which pre-entry screens would have kept a
 * position out of them? Every screen is also applied to the other tokens we audited, because a
 * screen that blocks everything catches every rug for free: the useful number is rugs caught next
 * to the share of other tokens the same screen would have thrown away.
 * Features are read at least `leadMinutes` before the rug (no look-ahead into the collapse).
 */

export interface RugFeatures {
  token: string;
  symbol: string | null;
  /** age of the newest row used (ms) */
  rowTs: number;
  mcapUsd: number | null;
  top10Pct: number | null;
  holders: number | null;
  organic: number | null;
  botHoldersPct: number | null;
  bundlerPct: number | null;
  mintActive: boolean | null;
  freezeActive: boolean | null;
  tokenAgeHours: number | null;
}

export interface RugCase {
  token: string;
  pool: string | null;
  t: number;
  rule: string | null;
  priceDropPct: number | null;
  lpWithdrawalPct: number | null;
  before: RugFeatures | null;
}

/** A screen passes a token (true), blocks it (false) or cannot tell (null: the feature is missing). */
export interface Screen {
  name: string;
  pass: (f: RugFeatures) => boolean | null;
}

const rng = (v: number | null, lo: number, hi: number) => (v === null ? null : v >= lo && v <= hi);

export const RUG_SCREENS: Screen[] = [
  { name: "market cap $500k-2M (Friday)", pass: (f) => rng(f.mcapUsd, 500_000, 2_000_000) },
  { name: "market cap >= $150k (Meridian)", pass: (f) => rng(f.mcapUsd, 150_000, Infinity) },
  { name: "market cap >= $1M", pass: (f) => rng(f.mcapUsd, 1_000_000, Infinity) },
  { name: "organic score >= 60 (Meridian)", pass: (f) => rng(f.organic, 60, Infinity) },
  { name: "holders >= 500 (Meridian)", pass: (f) => rng(f.holders, 500, Infinity) },
  { name: "top-10 holders <= 60% (Meridian)", pass: (f) => rng(f.top10Pct, 0, 60) },
  { name: "top-10 holders <= 40%", pass: (f) => rng(f.top10Pct, 0, 40) },
  { name: "bot holders <= 30% (Meridian)", pass: (f) => rng(f.botHoldersPct, 0, 30) },
  { name: "bundler supply <= 15%", pass: (f) => rng(f.bundlerPct, 0, 15) },
  {
    name: "no mint / freeze authority",
    pass: (f) => (f.mintActive === null || f.freezeActive === null ? null : !f.mintActive && !f.freezeActive),
  },
  { name: "token age >= 6 h", pass: (f) => rng(f.tokenAgeHours, 6, Infinity) },
];

/** Features of a token from the newest audit / security / flow rows at or before `at`. */
export function featuresAt(db: Db, token: string, at: number): RugFeatures | null {
  const a = db.get<{
    ts: number; symbol: string | null; organic_score: number | null; holder_count: number | null; mcap_usd: number | null;
    top_holders_pct: number | null; bot_holders_pct: number | null; bundler_holding_pct: number | null;
    token_created_at: number | null; first_pool_at: number | null;
  }>(
    `SELECT ts, symbol, organic_score, holder_count, mcap_usd, top_holders_pct, bot_holders_pct, bundler_holding_pct, token_created_at, first_pool_at
     FROM token_audit WHERE token = ? AND ts <= ? AND error IS NULL ORDER BY ts DESC LIMIT 1`,
    token, at,
  );
  const s = db.get<{ ts: number; top10_pct: number | null; mint_auth_active: number | null; freeze_auth_active: number | null }>(
    "SELECT ts, top10_pct, mint_auth_active, freeze_auth_active FROM token_security WHERE token = ? AND ts <= ? AND error IS NULL ORDER BY ts DESC LIMIT 1",
    token, at,
  );
  const fl = db.get<{ ts: number; holder_count: number | null; bundler_pct: number | null }>(
    "SELECT ts, holder_count, bundler_pct FROM token_flow WHERE token = ? AND ts <= ? ORDER BY ts DESC LIMIT 1",
    token, at,
  );
  if (!a && !s && !fl) return null;
  const born = a ? (a.token_created_at ?? a.first_pool_at) : null;
  const rowTs = Math.max(a?.ts ?? 0, s?.ts ?? 0, fl?.ts ?? 0);
  return {
    token, symbol: a?.symbol ?? null, rowTs,
    mcapUsd: a?.mcap_usd ?? null,
    top10Pct: s?.top10_pct ?? a?.top_holders_pct ?? null,
    holders: fl?.holder_count ?? a?.holder_count ?? null,
    organic: a?.organic_score ?? null,
    botHoldersPct: a?.bot_holders_pct ?? null,
    bundlerPct: fl?.bundler_pct ?? a?.bundler_holding_pct ?? null,
    mintActive: s?.mint_auth_active == null ? null : s.mint_auth_active === 1,
    freezeActive: s?.freeze_auth_active == null ? null : s.freeze_auth_active === 1,
    tokenAgeHours: born != null ? Math.max(0, (at - born) / 3_600_000) : null,
  };
}

export function loadRugCases(db: Db, leadMinutes: number): RugCase[] {
  const rows = db.all<{ mint: string; added_at: number; detail: string | null }>(
    "SELECT mint, added_at, detail FROM blocklist_tokens WHERE source = 'auto_rug' AND removed_at IS NULL ORDER BY added_at",
  );
  return rows.map((r) => {
    let d: { pool?: string; rule?: string; priceDropPct?: number | null; lpWithdrawalPct?: number | null } = {};
    try { d = r.detail ? JSON.parse(r.detail) : {}; } catch { /* free-text detail */ }
    return {
      token: r.mint, pool: d.pool ?? null, t: r.added_at, rule: d.rule ?? null,
      priceDropPct: d.priceDropPct ?? null, lpWithdrawalPct: d.lpWithdrawalPct ?? null,
      before: featuresAt(db, r.mint, r.added_at - leadMinutes * 60_000),
    };
  });
}

export interface ScreenRow {
  name: string;
  rugs: number;
  rugsBlocked: number;
  rugsUnknown: number;
  others: number;
  othersBlocked: number;
  othersUnknown: number;
}

export interface RugReport {
  leadMinutes: number;
  cases: RugCase[];
  otherTokens: number;
  screens: ScreenRow[];
}

/** Screens over rugged tokens (features before the rug) and over the tokens never flagged (newest row). */
export function rugReport(db: Db, leadMinutes = 10, screens: Screen[] = RUG_SCREENS): RugReport {
  const cases = loadRugCases(db, leadMinutes);
  const rugged = new Set(cases.map((c) => c.token));
  const tokens = db.all<{ token: string }>("SELECT DISTINCT token FROM token_audit WHERE error IS NULL").map((r) => r.token);
  const others: RugFeatures[] = [];
  for (const tk of tokens) {
    if (rugged.has(tk)) continue;
    const f = featuresAt(db, tk, Date.now());
    if (f) others.push(f);
  }
  const rugF = cases.map((c) => c.before).filter((f): f is RugFeatures => !!f);
  const rows = screens.map((s): ScreenRow => {
    const count = (fs: RugFeatures[]) => {
      let blocked = 0;
      let unknown = 0;
      for (const f of fs) {
        const p = s.pass(f);
        if (p === null) unknown++;
        else if (!p) blocked++;
      }
      return { blocked, unknown };
    };
    const r = count(rugF);
    const o = count(others);
    return {
      name: s.name, rugs: rugF.length, rugsBlocked: r.blocked, rugsUnknown: r.unknown,
      others: others.length, othersBlocked: o.blocked, othersUnknown: o.unknown,
    };
  });
  return { leadMinutes, cases, otherTokens: others.length, screens: rows };
}

const n = (v: number | null, d = 0) => (v === null ? "-" : v.toFixed(d));
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "-");

export function rugReportMarkdown(r: RugReport): string {
  const md: string[] = [];
  md.push(`# Rug post-mortem (features read at least ${r.leadMinutes} min before the rug)\n`);
  if (!r.cases.length) return md.concat("No tokens flagged by the rug detector (blocklist source auto_rug) yet.").join("\n") + "\n";
  md.push("| token | when (UTC) | rule | price drop % | LP withdrawn % | market cap $ | top-10 % | holders | organic | bot % | bundler % | mint / freeze auth | token age h |");
  md.push("|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|---|--:|");
  for (const c of r.cases) {
    const f = c.before;
    const auth = !f || f.mintActive === null ? "-" : `${f.mintActive ? "mint" : "-"} / ${f.freezeActive ? "freeze" : "-"}`;
    md.push(
      `| ${f?.symbol ?? c.token.slice(0, 6)} | ${new Date(c.t).toISOString().slice(0, 16).replace("T", " ")} | ${c.rule ?? "-"} | ${n(c.priceDropPct)} | ${n(c.lpWithdrawalPct)} | ` +
        `${f ? n(f.mcapUsd) : "-"} | ${f ? n(f.top10Pct, 1) : "-"} | ${f ? n(f.holders) : "-"} | ${f ? n(f.organic) : "-"} | ${f ? n(f.botHoldersPct, 1) : "-"} | ` +
        `${f ? n(f.bundlerPct, 1) : "-"} | ${auth} | ${f ? n(f.tokenAgeHours, 1) : "-"} |`,
    );
  }
  md.push("");
  md.push(`Screens on the ${r.cases.length} rugged token(s) against ${r.otherTokens} other audited token(s) (a rug without any audit / security / flow row before it, e.g. a pool added minutes earlier, has no features and is left out of the screens). *blocked* = the screen would have kept the position out; *unknown* = the feature was missing (not counted as blocked).\n`);
  md.push("| screen | rugs blocked | rugs unknown | others blocked | others unknown |");
  md.push("|---|--:|--:|--:|--:|");
  for (const s of r.screens)
    md.push(`| ${s.name} | ${s.rugsBlocked}/${s.rugs} (${pct(s.rugsBlocked, s.rugs)}) | ${s.rugsUnknown} | ${s.othersBlocked}/${s.others} (${pct(s.othersBlocked, s.others)}) | ${s.othersUnknown} |`);
  md.push("");
  md.push("A screen is only useful when it blocks a large share of rugs while blocking few other tokens. With a handful of rugs nothing here is significant: collect them over many sessions before turning a screen into a rule.");
  return md.join("\n") + "\n";
}
