import type { Db } from "../db/index.ts";
import { DEFAULT_PORTFOLIO, loadCandidates, simulatePortfolio, type PortfolioResult, type TakenTrade } from "./portfolio.ts";

/**
 * Preset accounts: every entry mode is treated as its own small account (default $45) that holds ONE position in ONE
 * pool at a time, so that a session with several presets is read as several accounts with a pool open each, instead
 * of a preset spreading hundreds of positions over many tokens at once. It is the sequential portfolio
 * (`portfolio.ts`) of each mode with one fixed profile (the combination of the grid the account uses), priced at the
 * account's size (fixed costs in dollars at $45, see `reprice`) and with the refundable rent the wallet has to hold.
 * Like the portfolio it is an analysis of the positions the grid stored (opened at cohort and event instants), not a
 * second simulation: it costs the live session nothing.
 */
export interface AccountDef {
  name: string;
  mode: string;
  /** grid_combo filters that pick the account's profile: key, "=" or "~" (prefix), value */
  where: { key: string; op: "=" | "~"; value: string }[];
  /** which position the account takes when several open together */
  pick: "first" | "score" | "random";
  /** why this profile */
  note: string;
}

export const DEFAULT_ACCOUNTS: AccountDef[] = [
  { name: "meridian", mode: "meridian_preset", where: [], pick: "first", note: "the preset's own recipe (bid-ask quote-only, TP on fees / SL / trailing)" },
  { name: "friday", mode: "friday_scalp", where: [{ key: "exit_policy", op: "~", value: "scalp" }], pick: "first", note: "the scalp (spot two-sided, 15 min stop, flow exits)" },
  {
    name: "yunus", mode: "yunus_flip", pick: "first", note: "bid-ask 50 % below the price, flip bid-ask, breakeven exit (the control `time_stop` did worse)",
    where: [{ key: "exit_policy", op: "~", value: "breakeven" }, { key: "range_pct", op: "=", value: "50" }, { key: "anchor", op: "=", value: "price" }, { key: "flip_shape", op: "=", value: "bidask" }],
  },
  { name: "royalmand", mode: "royalmand", where: [], pick: "first", note: "the fork's policy (single-sided SOL spot 80 %, confluence exit)" },
  { name: "evil_panda", mode: "evil_panda", where: [], pick: "first", note: "multi-day playbook: opens only in sessions of 12 h or more" },
  { name: "signal_enter", mode: "signal_enter", where: [{ key: "matches_recommendation", op: "=", value: "1" }], pick: "score", note: "the strategy the signal itself recommends, best score first" },
  { name: "signal_watch", mode: "signal_watch", where: [{ key: "matches_recommendation", op: "=", value: "1" }], pick: "score", note: "the strategy the signal itself recommends, best score first" },
];

export interface AccountResult {
  def: AccountDef;
  result: PortfolioResult;
}

export interface AccountsOptions {
  capitalUsd: number;
  reprice: boolean;
  windowSeconds: number;
  tz: "WIB" | "UTC";
  defs?: AccountDef[];
}

export function runAccounts(db: Db, sessionIds: string[], o: AccountsOptions): AccountResult[] {
  return (o.defs ?? DEFAULT_ACCOUNTS).map((def) => {
    const opts = {
      ...DEFAULT_PORTFOLIO, sessionIds, mode: def.mode, where: def.where, startCapitalUsd: o.capitalUsd, sizeFraction: 1, maxTradeUsd: o.capitalUsd,
      pick: def.pick, windowSeconds: o.windowSeconds, tz: o.tz, reprice: o.reprice, cleanOnly: true,
    };
    return { def, result: simulatePortfolio(loadCandidates(db, opts), opts) };
  });
}

/** Most accounts with a position open at the same moment, and most distinct pools open at the same moment. */
export function concurrency(rs: AccountResult[]): { accounts: number; pools: number } {
  const ev: { t: number; d: 1 | -1; pool: string }[] = [];
  for (const { result } of rs) for (const t of result.taken) ev.push({ t: t.openedAt, d: 1, pool: t.pool }, { t: t.closedAt, d: -1, pool: t.pool });
  ev.sort((a, b) => a.t - b.t || a.d - b.d); // closes before opens at the same instant
  const open = new Map<string, number>();
  let n = 0;
  let maxN = 0;
  let maxPools = 0;
  for (const e of ev) {
    n += e.d;
    const k = (open.get(e.pool) ?? 0) + e.d;
    if (k === 0) open.delete(e.pool);
    else open.set(e.pool, k);
    maxN = Math.max(maxN, n);
    maxPools = Math.max(maxPools, open.size);
  }
  return { accounts: maxN, pools: maxPools };
}

const f = (v: number | null, d = 2, suffix = "") => (v === null || !Number.isFinite(v) ? "-" : `${v.toFixed(d)}${suffix}`);
const usd = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;

export function accountsMarkdown(rs: AccountResult[], o: { capitalUsd: number; sessions: string[]; reprice: boolean }): string {
  const out: string[] = [
    `**${rs.length} preset accounts of ${usd(o.capitalUsd)}, one position in one pool at a time**, sessions ${o.sessions.map((s) => s.slice(0, 8)).join(", ")}${o.reprice ? ", re-priced to the account's size" : ""}.`,
    "",
    "| account | profile | candidates | trades | win | final equity | return | best / worst trade | rent locked avg / max | pools used |",
    "|---|---|--:|--:|--:|--:|--:|--:|--:|--:|",
  ];
  let start = 0;
  let end = 0;
  for (const { def, result: r } of rs) {
    const filt = def.where.map((w) => `${w.key}${w.op}${w.value}`).join(" ") || "all combinations";
    const pools = new Set(r.taken.map((t) => t.pool)).size;
    start += o.capitalUsd;
    end += r.finalEquity;
    out.push(
      `| ${def.name} | ${def.mode}: ${filt} | ${r.candidates} | ${r.taken.length} | ${r.winRate === null ? "-" : (r.winRate * 100).toFixed(0) + "%"} | ${usd(r.finalEquity)} | ${f(r.totalReturnPct, 1, "%")} | ${f(r.bestTradePct, 2, "%")} / ${f(r.worstTradePct, 2, "%")} | ${r.avgRentUsd === null ? "-" : `${usd(r.avgRentUsd)} / ${usd(r.maxRentUsd!)}`} | ${pools} |`,
    );
  }
  const idle = rs.filter((x) => !x.result.taken.length).map((x) => x.def.name);
  const wallet = rs.reduce((sum, x) => sum + o.capitalUsd + (x.result.maxRentUsd ?? 0), 0); // each account at its own largest rent
  const cc = concurrency(rs);
  out.push(
    "",
    `All accounts together: ${usd(start)} -> ${usd(end)} (${f(((end - start) / start) * 100, 1, "%")}). At most ${cc.accounts} account(s) had a position open at the same moment, in at most ${cc.pools} distinct pool(s).${idle.length ? ` No trade: ${idle.join(", ")} (the preset opened nothing that fit its profile in these sessions).` : ""}`,
    `Wallet: every account needs its ${usd(o.capitalUsd)} plus the refundable position rent while its position is open; with each account at its own largest rent here, all ${rs.length} open together would need about ${usd(wallet)} (the rent comes back when the positions close).`,
    "",
    "Profiles: " + rs.map((x) => `${x.def.name} = ${x.def.note}`).join("; ") + ".",
    "",
    "Each account takes, from the positions the grid opened at its cohort and event instants, the profile's position when it is free (positions opening while it is busy are skipped), and compounds its result. Sessions of 2 h close what is still open at the end, so slow presets (yunus holds up to 24 h) show only their first two hours. A handful of trades is a feel for the account, not evidence.",
  );
  return out.join("\n");
}

export function accountsCsv(rs: AccountResult[]): string {
  const row = (name: string, t: TakenTrade) =>
    [name, new Date(t.openedAt).toISOString(), new Date(t.closedAt).toISOString(), t.pool, t.sizeUsd.toFixed(2), t.pct.toFixed(4), t.pnlUsd.toFixed(4), t.equityAfter.toFixed(2), (t.rentUsd ?? 0).toFixed(2)].join(",");
  return ["account,opened_at,closed_at,pool,size_usd,pct,pnl_usd,equity_after,rent_usd", ...rs.flatMap((x) => x.result.taken.map((t) => row(x.def.name, t)))].join("\n") + "\n";
}
