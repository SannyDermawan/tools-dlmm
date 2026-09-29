import type { Db } from "../db/index.ts";
import { downsidePct } from "../sim/distribution.ts";

/**
 * Outcomes of real LP positions that OPENED WHILE WE WATCHED (lp_position_sightings.new_in_scan = 1),
 * followed to closure. Why this cohort: the wallet histories of the Data API only show what
 * survived in wallets that are still visible (survivorship) and closed positions only (short holds
 * are over-represented, long holds are still open). Here every position enters the sample when it
 * appears and stays in it until it closes or our observation ends:
 *  - time to close is a Kaplan-Meier estimate on the sightings alone (independent of which wallets
 *    we queried), right-censored at the last scan that saw the position;
 *  - PnL is shown for closed positions and for all positions (open ones at their current mark),
 *    by width, shape, sides and hold time, with the share still open next to every number.
 * Precision: an appearance / disappearance is known to the scan interval (real_lp.scan_minutes).
 */

export interface CohortRow {
  position: string;
  pool: string;
  wallet: string;
  /** minutes from open (or first sighting) to close / to the last time we saw it */
  minutes: number;
  closed: boolean;
  /** PnL known (a wallet fetch reached this position) and deposit large enough */
  pnlPct: number | null;
  pnlUsd: number | null;
  depositUsd: number | null;
  feeUsd: number | null;
  sides: string | null;
  shape: string | null;
  bins: number | null;
  /** downside price move covered by the range, % (see downsideOf) */
  downsidePct: number | null;
}

export interface LpOutcomesOptions {
  pools?: string[];
  /** only positions first seen at or after this time (ms) */
  since?: number;
  minDepositUsd?: number;
}

/** Downside of a real position's range in price %: quote-only = all bins below; otherwise from the active bin at open, else symmetric. */
export function downsideOf(
  r: { sides: string | null; bins: number | null; lower_bin: number | null; open_active_bin: number | null },
  binStep: number,
): number | null {
  if (!r.bins || r.bins < 1) return null;
  let below: number;
  if (r.sides === "quote_only") below = r.bins - 1;
  else if (r.sides === "base_only") below = 0;
  else if (r.open_active_bin !== null && r.lower_bin !== null) below = Math.max(0, r.open_active_bin - r.lower_bin);
  else below = (r.bins - 1) / 2;
  return downsidePct(below, binStep);
}

interface RawRow {
  position: string; pool: string; wallet: string;
  first_seen_at: number; last_seen_at: number; gone_at: number | null; s_shape: string | null;
  opened_at: number | null; closed_at: number | null; is_closed: number | null;
  bins: number | null; lower_bin: number | null; sides: string | null; shape: string | null;
  deposit_usd: number | null; net_pnl_usd: number | null; net_pnl_pct: number | null; fee_usd: number | null;
  open_active_bin: number | null; bin_step: number;
}

export function loadCohort(db: Db, o: LpOutcomesOptions = {}): { rows: CohortRow[]; sightings: number } {
  const where = ["s.new_in_scan = 1"];
  const args: (string | number)[] = [];
  if (o.since !== undefined) {
    where.push("s.first_seen_at >= ?");
    args.push(o.since);
  }
  if (o.pools?.length) {
    where.push(`s.pool IN (${o.pools.map(() => "?").join(",")})`);
    args.push(...o.pools);
  }
  const raw = db.all<RawRow>(
    `SELECT s.position, s.pool, s.wallet, s.first_seen_at, s.last_seen_at, s.gone_at, s.shape s_shape,
            r.opened_at, r.closed_at, r.is_closed, r.bins, r.lower_bin, r.sides, r.shape,
            r.deposit_usd, r.net_pnl_usd, r.net_pnl_pct, r.fee_usd, r.open_active_bin, p.bin_step
     FROM lp_position_sightings s
     JOIN pools p ON p.pool = s.pool
     LEFT JOIN real_lp_positions r ON r.position = s.position
     WHERE ${where.join(" AND ")}`,
    ...args,
  );
  const minDep = o.minDepositUsd ?? 0;
  const rows = raw.map<CohortRow>((r) => {
    const closed = r.is_closed === 1 || r.gone_at !== null;
    const start = r.opened_at !== null && r.opened_at <= r.first_seen_at ? r.opened_at : r.first_seen_at;
    const end = closed ? (r.closed_at ?? r.gone_at ?? r.last_seen_at) : r.last_seen_at;
    const hasPnl = r.net_pnl_pct !== null && r.deposit_usd !== null && r.deposit_usd >= minDep;
    return {
      position: r.position, pool: r.pool, wallet: r.wallet,
      minutes: Math.max(0, (end - start) / 60_000), closed,
      pnlPct: hasPnl ? r.net_pnl_pct : null, pnlUsd: hasPnl ? r.net_pnl_usd : null,
      depositUsd: r.deposit_usd, feeUsd: r.fee_usd,
      sides: r.sides, shape: r.shape ?? r.s_shape, bins: r.bins,
      downsidePct: downsideOf(r, r.bin_step),
    };
  });
  return { rows, sightings: raw.length };
}

// ------------------------------------------------------------------ survival

export interface KmStep {
  t: number;
  /** survival probability (still open) just after t */
  s: number;
  atRisk: number;
}

/** Kaplan-Meier estimate of P(still open at t). `event` = the position closed; otherwise censored at t. */
export function kaplanMeier(obs: { t: number; event: boolean }[]): KmStep[] {
  const sorted = [...obs].sort((a, b) => a.t - b.t);
  const out: KmStep[] = [];
  let s = 1;
  let atRisk = sorted.length;
  for (let i = 0; i < sorted.length; ) {
    const t = sorted[i].t;
    let d = 0;
    let c = 0;
    while (i < sorted.length && sorted[i].t === t) {
      if (sorted[i].event) d++;
      else c++;
      i++;
    }
    if (d > 0) {
      s *= 1 - d / atRisk;
      out.push({ t, s, atRisk });
    }
    atRisk -= d + c;
  }
  return out;
}

/** P(still open at t) from a Kaplan-Meier curve; null when t lies beyond every observation (no information). */
export function survivalAt(km: KmStep[], t: number, maxObserved: number): number | null {
  if (t > maxObserved) return null;
  let s = 1;
  for (const k of km) {
    if (k.t > t) break;
    s = k.s;
  }
  return s;
}

/** Median time to close (minutes): first time the curve reaches 0.5 or below; null when it never does. */
export function medianClose(km: KmStep[]): number | null {
  return km.find((k) => k.s <= 0.5)?.t ?? null;
}

// ------------------------------------------------------------------ outcome tables

export interface GroupRow {
  group: string;
  /** positions of the cohort in the group (with or without PnL) */
  n: number;
  /** of those with PnL */
  withPnl: number;
  closed: number;
  open: number;
  wallets: number;
  /** all positions with PnL (open ones at their mark) */
  winAll: number | null;
  meanAll: number | null;
  medianAll: number | null;
  /** closed positions only */
  winClosed: number | null;
  meanClosed: number | null;
  medianClosed: number | null;
  /** median hold time (hours): closed = time to close, open = age so far */
  medianHoldH: number | null;
}

const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const win = (xs: number[]) => (xs.length ? xs.filter((x) => x > 0).length / xs.length : null);

export function groupOutcomes(rows: CohortRow[], key: (r: CohortRow) => string): GroupRow[] {
  const g = new Map<string, CohortRow[]>();
  for (const r of rows) {
    const k = key(r);
    if (!g.has(k)) g.set(k, []);
    g.get(k)!.push(r);
  }
  return [...g.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([group, v]) => {
      const p = v.filter((r) => r.pnlPct !== null);
      const all = p.map((r) => r.pnlPct!);
      const cl = p.filter((r) => r.closed).map((r) => r.pnlPct!);
      const hold = quantile(v.map((r) => r.minutes), 0.5);
      return {
        group, n: v.length, withPnl: p.length, closed: v.filter((r) => r.closed).length, open: v.filter((r) => !r.closed).length,
        wallets: new Set(v.map((r) => r.wallet)).size,
        winAll: win(all), meanAll: mean(all), medianAll: quantile(all, 0.5),
        winClosed: win(cl), meanClosed: mean(cl), medianClosed: quantile(cl, 0.5),
        medianHoldH: hold === null ? null : hold / 60,
      };
    });
}

const bucket = (v: number | null, cuts: [number, string][], last: string, none = "unknown") => {
  if (v === null) return none;
  for (const [c, name] of cuts) if (v < c) return name;
  return last;
};
export const widthBucket = (r: CohortRow) =>
  r.sides === "base_only"
    ? "0) none (base-only)"
    : bucket(r.downsidePct, [[15, "1) < 15%"], [30, "2) 15-30%"], [50, "3) 30-50%"], [70, "4) 50-70%"], [85, "5) 70-85%"]], "6) >= 85%");
export const holdBucket = (r: CohortRow) =>
  bucket(r.minutes, [[60, "1) < 1 h"], [360, "2) 1-6 h"], [1440, "3) 6-24 h"], [4320, "4) 1-3 d"]], "5) > 3 d") + (r.closed ? "" : " (still open)");

// ------------------------------------------------------------------ report

export interface LpOutcomesReport {
  cohort: { sightings: number; withPnl: number; closed: number; open: number; wallets: number; pools: number; firstSeen: number | null; lastSeen: number | null; maxObservedMin: number };
  survival: { hours: number; surv: number | null }[];
  medianCloseMin: number | null;
  /** positions closed / still open, and the share still open (the censoring) */
  tables: { name: string; rows: GroupRow[] }[];
  overall: GroupRow;
}

export const SURVIVAL_HOURS = [1, 6, 24, 72];

export function lpOutcomes(db: Db, o: LpOutcomesOptions = {}): LpOutcomesReport {
  const { rows, sightings } = loadCohort(db, o);
  const km = kaplanMeier(rows.map((r) => ({ t: r.minutes, event: r.closed })));
  const maxObs = Math.max(0, ...rows.map((r) => r.minutes));
  const seen = db.get<{ a: number | null; b: number | null }>(
    `SELECT MIN(first_seen_at) a, MAX(last_seen_at) b FROM lp_position_sightings WHERE new_in_scan = 1${o.since !== undefined ? " AND first_seen_at >= ?" : ""}`,
    ...(o.since !== undefined ? [o.since] : []),
  );
  return {
    cohort: {
      sightings, withPnl: rows.filter((r) => r.pnlPct !== null).length, closed: rows.filter((r) => r.closed).length,
      open: rows.filter((r) => !r.closed).length, wallets: new Set(rows.map((r) => r.wallet)).size, pools: new Set(rows.map((r) => r.pool)).size,
      firstSeen: seen?.a ?? null, lastSeen: seen?.b ?? null, maxObservedMin: maxObs,
    },
    survival: SURVIVAL_HOURS.map((h) => ({ hours: h, surv: survivalAt(km, h * 60, maxObs) })),
    medianCloseMin: medianClose(km),
    tables: [
      { name: "sides", rows: groupOutcomes(rows, (r) => r.sides ?? "unknown") },
      { name: "shape", rows: groupOutcomes(rows, (r) => r.shape ?? "unknown") },
      { name: "range width (downside price %)", rows: groupOutcomes(rows, widthBucket) },
      { name: "hold time (closed: time to close; open: age so far)", rows: groupOutcomes(rows, holdBucket) },
      { name: "quote-only, by width", rows: groupOutcomes(rows.filter((r) => r.sides === "quote_only"), widthBucket) },
      { name: "quote-only, by hold time", rows: groupOutcomes(rows.filter((r) => r.sides === "quote_only"), holdBucket) },
    ],
    overall: groupOutcomes(rows, () => "all")[0] ?? { group: "all", n: 0, withPnl: 0, closed: 0, open: 0, wallets: 0, winAll: null, meanAll: null, medianAll: null, winClosed: null, meanClosed: null, medianClosed: null, medianHoldH: null },
  };
}

const f = (v: number | null, d = 1) => (v === null ? "-" : v.toFixed(d));
const pc = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(0)}%`);
const when = (t: number | null) => (t === null ? "-" : new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC");

export function lpOutcomesMarkdown(r: LpOutcomesReport): string {
  const c = r.cohort;
  if (!c.sightings)
    return "No real LP position was seen opening while we watched (lp_position_sightings.new_in_scan = 1). Run `dlmm lp collect` repeatedly (or a session with real_lp enabled) first.";
  const out: string[] = [];
  out.push(`Cohort: **${c.sightings}** positions that opened while we watched (${c.pools} pools, ${c.wallets} wallets, ${when(c.firstSeen)} to ${when(c.lastSeen)}); ${c.closed} closed, ${c.open} still open (censored), PnL known for ${c.withPnl}.`);
  out.push("");
  const surv = r.survival.map((s) => `${s.hours} h: ${s.surv === null ? "no data" : (s.surv * 100).toFixed(0) + "% open"}`).join(" · ");
  out.push(`Time to close (Kaplan-Meier, censoring-aware, from sightings only): ${surv}; median ${r.medianCloseMin === null ? "not reached" : (r.medianCloseMin / 60).toFixed(1) + " h"}; longest observation ${(c.maxObservedMin / 60).toFixed(1)} h.`);
  out.push("");
  out.push("PnL is % of the deposit (Meteora Data API, before our costs). *all* = every position with a PnL, open ones at their current mark; *closed* = closed positions only. A large *open* share means the closed-only numbers are biased toward quick exits.");
  for (const t of r.tables) {
    out.push("");
    out.push(`**By ${t.name}**`);
    out.push("");
    out.push("| group | positions | closed | open | wallets | win (all) | mean % (all) | median % (all) | win (closed) | mean % (closed) | median % (closed) | median hold h |\n|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
    for (const g of t.rows)
      out.push(`| ${g.group} | ${g.n} | ${g.closed} | ${g.open} | ${g.wallets} | ${pc(g.winAll)} | ${f(g.meanAll, 2)} | ${f(g.medianAll, 2)} | ${pc(g.winClosed)} | ${f(g.meanClosed, 2)} | ${f(g.medianClosed, 2)} | ${f(g.medianHoldH)} |`);
  }
  out.push("");
  out.push(`Overall: mean ${f(r.overall.meanAll, 2)}% / median ${f(r.overall.medianAll, 2)}% (all), ${f(r.overall.meanClosed, 2)}% / ${f(r.overall.medianClosed, 2)}% (closed only).`);
  out.push("Small groups (a few positions or wallets) say nothing; a claim about a playbook needs a group with many positions from many wallets and few still open.");
  return out.join("\n");
}
