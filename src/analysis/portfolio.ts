import type { Db } from "../db/index.ts";

/**
 * Sequential portfolio simulation (stage 4): the grid opens hundreds of virtual positions at once,
 * but a manual trader (Friday's calendar) holds ONE position at a time, compounds, and may stop for
 * the day after a loss. This replays the journal of chosen positions under those rules to answer
 * "what would the account curve, the drawdown and the worst day have looked like?". It is an
 * analysis of stored results, not a new simulation:
 *  - a trade's result is its stored net PnL % (costs included) applied to the account's trade size;
 *    the price impact of a larger size is NOT re-priced (cap it with maxTradeUsd);
 *  - the trader takes the next opportunity after it is free again; positions that open while it is
 *    busy are skipped; positions opening within `windowSeconds` of each other are one opportunity
 *    and one of them is picked (first, random with a seed, or the highest signal score);
 *  - the daily stop looks at the realized PnL of the day (by close time) vs the equity at the day's
 *    start and blocks new trades for the rest of that day.
 */
export interface PortfolioOptions {
  sessionIds: string[];
  /** entry mode, e.g. friday_scalp, meridian_preset, signal_enter, all_pools_baseline */
  mode: string;
  /** grid_combo filters: key, "=" (equal) or "~" (prefix), value — e.g. exit_policy ~ scalp, bins_per_side = 34 */
  where?: { key: string; op: "=" | "~"; value: string }[];
  startCapitalUsd: number;
  /** share of the equity put into each trade (1 = all of it, compounding) */
  sizeFraction: number;
  /** trade size never above this (liquidity: a bigger swap moves the price); null = no cap */
  maxTradeUsd: number | null;
  /** stop new trades for the rest of the day after a realized loss of this % of the day's start equity; 0 = off */
  dailyStopPct: number;
  tz: "WIB" | "UTC";
  pick: "first" | "random" | "score";
  seed: number;
  /** candidates within this many seconds of each other count as one opportunity */
  windowSeconds: number;
  /** only positions without a data gap */
  cleanOnly: boolean;
}

export const DEFAULT_PORTFOLIO: Omit<PortfolioOptions, "sessionIds" | "mode"> = {
  startCapitalUsd: 1000, sizeFraction: 1, maxTradeUsd: null, dailyStopPct: 0, tz: "WIB", pick: "first", seed: 1, windowSeconds: 60, cleanOnly: true,
};

export interface Candidate {
  id: string;
  pool: string;
  openedAt: number;
  closedAt: number;
  pct: number; // net PnL % of capital, costs included
  score: number | null;
}

export interface TakenTrade {
  id: string;
  pool: string;
  openedAt: number;
  closedAt: number;
  sizeUsd: number;
  pct: number;
  pnlUsd: number;
  equityAfter: number;
}

export interface DayRow {
  day: string;
  trades: number;
  pnlUsd: number;
  returnPct: number;
  equityEnd: number;
  stopped: boolean;
}

export interface PortfolioResult {
  options: PortfolioOptions;
  candidates: number;
  taken: TakenTrade[];
  skipped: { busy: number; notPicked: number; dailyStop: number; ruin: number };
  finalEquity: number;
  totalReturnPct: number;
  avgTradePct: number | null;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
  maxDailyDrawdownPct: number;
  longestLosingStreak: number;
  bestTradePct: number | null;
  worstTradePct: number | null;
  days: DayRow[];
  positiveDayShare: number | null;
  worstDay: DayRow | null;
  bestDay: DayRow | null;
  dailySharpe: number | null;
  /** average number of candidates per opportunity: > 1 means the pick rule matters */
  candidatesPerOpportunity: number | null;
}

const KEY_RE = /^[a-z_][a-z0-9_]*$/;

/** Positions of the chosen mode / combination: closed, with a result, in time order. */
export function loadCandidates(db: Db, o: Pick<PortfolioOptions, "sessionIds" | "mode" | "where" | "cleanOnly">): Candidate[] {
  if (!o.sessionIds.length) return [];
  const params: (string | number)[] = [...o.sessionIds, o.mode];
  let sql = `SELECT p.position_id id, p.pool, p.opened_at, p.closed_at, r.net_pnl_pct pct, json_extract(p.grid_combo, '$.signal_score') score
     FROM sim_positions p JOIN sim_results r USING(position_id)
     WHERE p.session_id IN (${o.sessionIds.map(() => "?").join(",")}) AND p.entry_mode = ? AND p.status = 'closed'
       AND p.opened_at IS NOT NULL AND p.closed_at IS NOT NULL AND r.net_pnl_pct IS NOT NULL`;
  if (o.cleanOnly) sql += " AND p.gap_tainted = 0";
  for (const w of o.where ?? []) {
    if (!KEY_RE.test(w.key)) throw new Error(`bad filter key "${w.key}"`);
    if (w.op === "=") sql += " AND CAST(json_extract(p.grid_combo, ?) AS TEXT) = ?";
    else sql += " AND CAST(json_extract(p.grid_combo, ?) AS TEXT) LIKE ? || '%'";
    params.push(`$.${w.key}`, w.value);
  }
  sql += " ORDER BY p.opened_at, p.position_id";
  return db
    .all<{ id: string; pool: string; opened_at: number; closed_at: number; pct: number; score: number | null }>(sql, ...params)
    .map((r) => ({ id: r.id, pool: r.pool, openedAt: r.opened_at, closedAt: r.closed_at, pct: r.pct, score: r.score }));
}

const mulberry = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export function dayKey(ts: number, tz: "WIB" | "UTC"): string {
  return new Date(ts + (tz === "WIB" ? 7 * 3_600_000 : 0)).toISOString().slice(0, 10);
}

/** The sequential account over a list of candidates (sorted by opening time). */
export function simulatePortfolio(cands: Candidate[], o: PortfolioOptions): PortfolioResult {
  const rnd = mulberry(o.seed);
  const sorted = [...cands].sort((a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : 1));
  const taken: TakenTrade[] = [];
  const skipped = { busy: 0, notPicked: 0, dailyStop: 0, ruin: 0 };
  let equity = o.startCapitalUsd;
  let freeAt = -Infinity;
  let curDay: string | null = null;
  let dayStart = equity;
  let dayRealized = 0;
  const dayRows = new Map<string, DayRow>();
  const row = (d: string): DayRow => dayRows.get(d) ?? (dayRows.set(d, { day: d, trades: 0, pnlUsd: 0, returnPct: 0, equityEnd: equity, stopped: false }), dayRows.get(d)!);
  const rollover = (d: string) => {
    if (d === curDay) return;
    curDay = d;
    dayStart = equity;
    dayRealized = 0;
  };
  let opportunities = 0;
  let inGroups = 0;
  let i = 0;
  while (i < sorted.length) {
    const c = sorted[i];
    if (c.openedAt < freeAt) {
      skipped.busy++;
      i++;
      continue;
    }
    // one opportunity: everything opening within the window of the first free candidate
    let j = i;
    while (j < sorted.length && sorted[j].openedAt <= c.openedAt + o.windowSeconds * 1000) j++;
    const group = sorted.slice(i, j);
    i = j;
    opportunities++;
    inGroups += group.length;
    rollover(dayKey(c.openedAt, o.tz));
    if (equity <= 0) {
      skipped.ruin += group.length;
      continue;
    }
    if (o.dailyStopPct > 0 && dayRealized <= -(o.dailyStopPct / 100) * dayStart) {
      skipped.dailyStop += group.length;
      row(curDay!).stopped = true;
      continue;
    }
    const pick =
      o.pick === "random" ? group[Math.floor(rnd() * group.length)]
      : o.pick === "score" ? [...group].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))[0]
      : group[0];
    skipped.notPicked += group.length - 1;
    const size = Math.min(equity, equity * o.sizeFraction, o.maxTradeUsd ?? Infinity);
    const pnl = (size * pick.pct) / 100;
    // a trade that closes on a later day belongs to that day's calendar and stop
    rollover(dayKey(pick.closedAt, o.tz));
    equity += pnl;
    dayRealized += pnl;
    freeAt = pick.closedAt;
    taken.push({ id: pick.id, pool: pick.pool, openedAt: pick.openedAt, closedAt: pick.closedAt, sizeUsd: size, pct: pick.pct, pnlUsd: pnl, equityAfter: equity });
    const r = row(curDay!);
    r.trades++;
    r.pnlUsd += pnl;
    r.equityEnd = equity;
  }
  // day returns vs the day's start equity, in order
  const days = [...dayRows.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  let prevEnd = o.startCapitalUsd;
  for (const d of days) {
    d.returnPct = prevEnd > 0 ? (d.pnlUsd / prevEnd) * 100 : 0;
    prevEnd = d.equityEnd;
  }
  const wins = taken.filter((t) => t.pnlUsd > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = taken.filter((t) => t.pnlUsd < 0).reduce((s, t) => s - t.pnlUsd, 0);
  const dd = (series: number[]) => {
    let peak = o.startCapitalUsd;
    let worst = 0;
    for (const e of series) {
      peak = Math.max(peak, e);
      if (peak > 0) worst = Math.max(worst, ((peak - e) / peak) * 100);
    }
    return worst;
  };
  let streak = 0;
  let longest = 0;
  for (const t of taken) {
    streak = t.pnlUsd < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  const dr = days.map((d) => d.returnPct);
  const mean = dr.length ? dr.reduce((a, b) => a + b, 0) / dr.length : null;
  const sd = dr.length > 1 && mean !== null ? Math.sqrt(dr.reduce((s, x) => s + (x - mean) ** 2, 0) / (dr.length - 1)) : null;
  return {
    options: o, candidates: sorted.length, taken, skipped, finalEquity: equity,
    totalReturnPct: ((equity - o.startCapitalUsd) / o.startCapitalUsd) * 100,
    avgTradePct: taken.length ? taken.reduce((s, t) => s + t.pct, 0) / taken.length : null,
    winRate: taken.length ? wins.length / taken.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    maxDrawdownPct: dd(taken.map((t) => t.equityAfter)),
    maxDailyDrawdownPct: dd(days.map((d) => d.equityEnd)),
    longestLosingStreak: longest,
    bestTradePct: taken.length ? Math.max(...taken.map((t) => t.pct)) : null,
    worstTradePct: taken.length ? Math.min(...taken.map((t) => t.pct)) : null,
    days,
    positiveDayShare: days.length ? days.filter((d) => d.pnlUsd > 0).length / days.length : null,
    worstDay: days.length ? days.reduce((a, b) => (b.returnPct < a.returnPct ? b : a)) : null,
    bestDay: days.length ? days.reduce((a, b) => (b.returnPct > a.returnPct ? b : a)) : null,
    dailySharpe: mean !== null && sd && sd > 0 ? (mean / sd) * Math.sqrt(365) : null,
    candidatesPerOpportunity: opportunities ? inGroups / opportunities : null,
  };
}

export function runPortfolio(db: Db, o: PortfolioOptions): PortfolioResult {
  return simulatePortfolio(loadCandidates(db, o), o);
}

const f = (v: number | null, d = 2, suffix = "") => (v === null || !Number.isFinite(v) ? "-" : `${v.toFixed(d)}${suffix}`);
const usd = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;

export function portfolioMarkdown(r: PortfolioResult, opts: { calendarDays?: number } = {}): string {
  const o = r.options;
  const filt = (o.where ?? []).map((w) => `${w.key}${w.op}${w.value}`).join(", ");
  const out: string[] = [
    `**Settings:** mode \`${o.mode}\`${filt ? ` (${filt})` : ""}, start ${usd(o.startCapitalUsd)}, ${(o.sizeFraction * 100).toFixed(0)}% of the equity per trade${o.maxTradeUsd ? ` (max ${usd(o.maxTradeUsd)})` : ""}, daily stop ${o.dailyStopPct > 0 ? `${o.dailyStopPct}%` : "off"}, days in ${o.tz}, pick ${o.pick}${o.pick === "random" ? ` (seed ${o.seed})` : ""}, ${o.cleanOnly ? "clean positions only" : "all positions"}.`,
    "",
    `| candidates | trades taken | skipped: busy | not picked | daily stop | ruin | candidates per opportunity |\n|--:|--:|--:|--:|--:|--:|--:|`,
    `| ${r.candidates} | ${r.taken.length} | ${r.skipped.busy} | ${r.skipped.notPicked} | ${r.skipped.dailyStop} | ${r.skipped.ruin} | ${f(r.candidatesPerOpportunity, 1)} |`,
    "",
    "| final equity | total return | avg trade | win rate | profit factor | max drawdown (trades) | max drawdown (days) | longest losing streak | best / worst trade | positive days | daily Sharpe (x sqrt 365) |",
    "|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|",
    `| ${usd(r.finalEquity)} | ${f(r.totalReturnPct, 1, "%")} | ${f(r.avgTradePct, 3, "%")} | ${r.winRate === null ? "-" : (r.winRate * 100).toFixed(0) + "%"} | ${r.profitFactor === Infinity ? "inf" : f(r.profitFactor, 2)} | ${f(r.maxDrawdownPct, 1, "%")} | ${f(r.maxDailyDrawdownPct, 1, "%")} | ${r.longestLosingStreak} | ${f(r.bestTradePct, 2, "%")} / ${f(r.worstTradePct, 2, "%")} | ${r.positiveDayShare === null ? "-" : (r.positiveDayShare * 100).toFixed(0) + "%"} | ${f(r.dailySharpe, 2)} |`,
  ];
  if ((r.candidatesPerOpportunity ?? 1) > 1.5)
    out.push("", `Several positions open at the same time (${f(r.candidatesPerOpportunity, 1)} per opportunity): the result depends on the pick rule; compare \`--pick first\`, \`random\` and \`score\`.`);
  if (r.days.length) {
    const shown = opts.calendarDays ? r.days.slice(-opts.calendarDays) : r.days;
    out.push("", "| day | trades | PnL | day return | equity | note |", "|---|--:|--:|--:|--:|---|");
    for (const d of shown) out.push(`| ${d.day} | ${d.trades} | ${usd(d.pnlUsd)} | ${f(d.returnPct, 2, "%")} | ${usd(d.equityEnd)} | ${d.stopped ? "daily stop hit" : ""} |`);
  }
  out.push("", "Trade results are the stored net PnL % (costs included) at the simulator's trade size; a bigger compounded size would pay a larger price impact than is shown here (use `--max-trade`). A short history is not a calendar: judge by many days.");
  return out.join("\n");
}

export function equityCsv(r: PortfolioResult): string {
  const rows = ["opened_at,closed_at,pool,size_usd,pct,pnl_usd,equity_after", ...r.taken.map((t) => [new Date(t.openedAt).toISOString(), new Date(t.closedAt).toISOString(), t.pool, t.sizeUsd.toFixed(2), t.pct.toFixed(4), t.pnlUsd.toFixed(4), t.equityAfter.toFixed(2)].join(","))];
  return rows.join("\n") + "\n";
}

/** Session report section: the sequential account of the configured modes (clean positions of this session). */
export function portfolioReportMarkdown(db: Db, sessionId: string, c: { start_capital_usd: number; size_fraction: number; max_trade_usd: number | null; daily_stop_pct: number; tz: "WIB" | "UTC"; pick: "first" | "random" | "score"; window_seconds: number; report_modes: string[]; report_min_trades: number }): string {
  const out: string[] = [];
  for (const mode of c.report_modes) {
    const r = runPortfolio(db, {
      sessionIds: [sessionId], mode, startCapitalUsd: c.start_capital_usd, sizeFraction: c.size_fraction, maxTradeUsd: c.max_trade_usd, dailyStopPct: c.daily_stop_pct,
      tz: c.tz, pick: c.pick, seed: 1, windowSeconds: c.window_seconds, cleanOnly: true,
    });
    if (r.taken.length < c.report_min_trades) continue;
    out.push(`### ${mode}`, "", portfolioMarkdown(r, { calendarDays: 7 }), "");
  }
  return out.length ? out.join("\n") : `No mode with at least ${c.report_min_trades} sequential trades (${c.report_modes.join(", ")}). Run \`dlmm portfolio\` for any mode and combination over several sessions.`;
}
