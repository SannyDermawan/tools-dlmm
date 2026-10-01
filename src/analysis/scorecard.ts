import type { Db } from "../db/index.ts";

/**
 * Strategy profiling and scorecard (strategy-lab roadmap PHASE 5, 7, 8 and the scorecard section):
 * per entry mode over a set of simulation sessions -- sample size, performance, cost (fixed vs
 * variable), capital efficiency, rug exposure, and the net result projected to other capitals.
 *
 * Cost classes (roadmap PHASE 7):
 *  - variable (scale with the position): swaps incl. price impact and the exit swap, token-2022
 *    transfer tax, composition fee;
 *  - fixed (the same dollars for $40 or $1000): transaction fees (base + priority, every open,
 *    close, rebalance, swap), bin-array creation;
 *  - position rent is refunded on close: not a cost, but capital locked while the position is open.
 *
 * Projection to another capital C (per position): net%(C) = gross% - variable% - fixed$ / C. It
 * keeps the decisions and the price path, and assumes the fee share per dollar does not change
 * (a smaller position takes a slightly larger share per dollar, so the projection is a little
 * pessimistic). `dlmm capital` replays the session at each capital to check it.
 */

export interface ScorecardPosition {
  session: string;
  mode: string;
  pool: string;
  cap: number;
  net: number;
  fee: number;
  cost: number;
  durMin: number;
  mddPct: number | null;
  /** non-refundable cost split (USD) */
  fixed: number;
  variable: number;
  tx: number;
  txOps: number;
  swap: number;
  tax: number;
  composition: number;
  binArray: number;
  /** refundable position rent locked while open (USD) */
  rent: number;
  /** the pool's token was flagged by the rug detector while the position was open */
  rugged: boolean;
  /** regime label at entry (PHASE 6), null when not journaled */
  regime: string | null;
}

export interface ScorecardRow {
  mode: string;
  sessions: number;
  pools: number;
  n: number;
  totalNetUsd: number;
  avgNetPct: number;
  medianNetPct: number;
  grossPct: number;
  winRate: number;
  lossRate: number;
  profitFactor: number | null;
  avgTradeUsd: number;
  medianTradeUsd: number;
  avgMddPct: number | null;
  worstPct: number;
  breakEvenPct: number;
  fixedPct: number;
  variablePct: number;
  fixedUsd: number;
  txOps: number;
  txUsd: number;
  swapUsd: number;
  taxUsd: number;
  compositionUsd: number;
  binArrayUsd: number;
  rentUsd: number;
  avgMinutes: number;
  /** net % of capital per hour in a position (time-weighted), and the same with the locked rent added to the capital */
  effPctPerHour: number;
  effWithRentPctPerHour: number;
  feePctPerHour: number;
  rugExposure: number;
  rugNetPct: number | null;
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Cost item type -> class (null = refundable rent or unknown, counted apart). */
export function costClass(type: string): "tx" | "swap" | "tax" | "composition" | "bin_array" | null {
  if (type.startsWith("tx_")) return "tx";
  if (type.endsWith("swap")) return "swap";
  if (type === "transfer_tax") return "tax";
  if (type === "composition_fee") return "composition";
  if (type === "bin_array_init") return "bin_array";
  return null;
}

/** Closed, clean positions of the sessions with their cost split. */
export function loadScorecardPositions(db: Db, sessionIds: string[], modes?: string[]): ScorecardPosition[] {
  if (!sessionIds.length) return [];
  const ph = sessionIds.map(() => "?").join(",");
  const rows = db.all<{
    session: string; mode: string; pool: string; cap: number; net: number; fee: number; cost: number; dur: number | null; mdd: number | null;
    detail: string | null; opened: number | null; closed: number | null; tx: string | null; ty: string | null; regime: string | null;
  }>(
    `SELECT p.session_id session, p.entry_mode mode, p.pool, p.capital_usd cap, r.net_pnl_usd net, r.fee_usd fee, r.cost_usd cost,
            r.duration_min dur, r.max_drawdown_pct mdd, r.detail, p.opened_at opened, p.closed_at closed, pl.token_x tx, pl.token_y ty,
            json_extract(p.grid_combo,'$.regime') regime
     FROM sim_positions p JOIN sim_results r USING(position_id) LEFT JOIN pools pl ON pl.pool = p.pool
     WHERE p.session_id IN (${ph}) AND p.status = 'closed' AND p.gap_tainted = 0 AND p.capital_usd > 0`,
    ...sessionIds,
  );
  const rugs = new Map<string, number>();
  for (const b of db.all<{ mint: string; added_at: number }>("SELECT mint, added_at FROM blocklist_tokens WHERE source = 'auto_rug' AND removed_at IS NULL"))
    rugs.set(b.mint, Math.min(rugs.get(b.mint) ?? Infinity, b.added_at));
  const out: ScorecardPosition[] = [];
  for (const r of rows) {
    if (modes?.length && !modes.includes(r.mode)) continue;
    const parts = { tx: 0, swap: 0, tax: 0, composition: 0, bin_array: 0 };
    let txOps = 0;
    let rent = 0;
    let costs: { type: string; usd: number; refundable: boolean }[] = [];
    try {
      costs = (JSON.parse(r.detail ?? "{}").costs ?? []) as typeof costs;
    } catch {
      /* old rows without a detail */
    }
    for (const c of costs) {
      if (c.type === "position_rent") {
        if (c.refundable) rent = Math.max(rent, c.usd); // locked once per position (a rebalance re-locks the same rent)
        continue;
      }
      if (c.refundable) continue;
      const k = costClass(c.type);
      if (!k) continue;
      parts[k] += c.usd;
      if (k === "tx") txOps++;
    }
    const rugAt = [r.tx, r.ty].map((m) => (m ? rugs.get(m) : undefined)).find((t) => t !== undefined);
    const rugged = rugAt !== undefined && r.opened !== null && rugAt >= r.opened && rugAt <= (r.closed ?? Infinity);
    out.push({
      session: r.session, mode: r.mode, pool: r.pool, cap: r.cap, net: r.net, fee: r.fee ?? 0, cost: r.cost ?? 0, durMin: r.dur ?? 0, mddPct: r.mdd,
      fixed: parts.tx + parts.bin_array, variable: parts.swap + parts.tax + parts.composition,
      tx: parts.tx, txOps, swap: parts.swap, tax: parts.tax, composition: parts.composition, binArray: parts.bin_array, rent, rugged,
      regime: r.regime,
    });
  }
  return out;
}

export function scorecardRow(mode: string, ps: ScorecardPosition[]): ScorecardRow {
  const pct = (x: number, p: ScorecardPosition) => (x / p.cap) * 100;
  const net = ps.map((p) => pct(p.net, p));
  const wins = ps.filter((p) => p.net > 0).reduce((a, p) => a + p.net, 0);
  const losses = -ps.filter((p) => p.net < 0).reduce((a, p) => a + p.net, 0);
  const capHours = ps.reduce((a, p) => a + p.cap * (p.durMin / 60), 0);
  const capRentHours = ps.reduce((a, p) => a + (p.cap + p.rent) * (p.durMin / 60), 0);
  const totalNet = ps.reduce((a, p) => a + p.net, 0);
  const rugged = ps.filter((p) => p.rugged);
  const mdd = ps.map((p) => p.mddPct).filter((x): x is number => x !== null);
  return {
    mode,
    sessions: new Set(ps.map((p) => p.session)).size,
    pools: new Set(ps.map((p) => p.pool)).size,
    n: ps.length,
    totalNetUsd: totalNet,
    avgNetPct: mean(net),
    medianNetPct: median(net),
    grossPct: mean(ps.map((p) => pct(p.net + p.cost, p))),
    winRate: ps.length ? ps.filter((p) => p.net > 0).length / ps.length : 0,
    lossRate: ps.length ? ps.filter((p) => p.net < 0).length / ps.length : 0,
    profitFactor: losses > 0 ? wins / losses : null,
    avgTradeUsd: mean(ps.map((p) => p.net)),
    medianTradeUsd: median(ps.map((p) => p.net)),
    avgMddPct: mdd.length ? mean(mdd) : null,
    worstPct: net.length ? Math.min(...net) : 0,
    breakEvenPct: mean(ps.map((p) => pct(p.cost, p))),
    fixedPct: mean(ps.map((p) => pct(p.fixed, p))),
    variablePct: mean(ps.map((p) => pct(p.variable, p))),
    fixedUsd: mean(ps.map((p) => p.fixed)),
    txOps: mean(ps.map((p) => p.txOps)),
    txUsd: mean(ps.map((p) => p.tx)),
    swapUsd: mean(ps.map((p) => p.swap)),
    taxUsd: mean(ps.map((p) => p.tax)),
    compositionUsd: mean(ps.map((p) => p.composition)),
    binArrayUsd: mean(ps.map((p) => p.binArray)),
    rentUsd: mean(ps.map((p) => p.rent)),
    avgMinutes: mean(ps.map((p) => p.durMin)),
    effPctPerHour: capHours > 0 ? (totalNet / capHours) * 100 : 0,
    effWithRentPctPerHour: capRentHours > 0 ? (totalNet / capRentHours) * 100 : 0,
    feePctPerHour: capHours > 0 ? (ps.reduce((a, p) => a + p.fee, 0) / capHours) * 100 : 0,
    rugExposure: ps.length ? rugged.length / ps.length : 0,
    rugNetPct: rugged.length ? mean(rugged.map((p) => pct(p.net, p))) : null,
  };
}

export interface CapitalProjection {
  capital: number;
  netPct: number;
  breakEvenPct: number;
  fixedPct: number;
  rentPct: number;
  /** share of positions whose projected net is positive */
  winRate: number;
  netUsd: number;
}

/** Net and break-even of the same positions at another position size (see the header). */
export function projectCapital(ps: ScorecardPosition[], capital: number): CapitalProjection {
  const net = ps.map((p) => ((p.net + p.fixed) / p.cap) * 100 - (p.fixed / capital) * 100);
  return {
    capital,
    netPct: mean(net),
    breakEvenPct: mean(ps.map((p) => ((p.cost - p.fixed) / p.cap) * 100 + (p.fixed / capital) * 100)),
    fixedPct: mean(ps.map((p) => (p.fixed / capital) * 100)),
    rentPct: mean(ps.map((p) => (p.rent / capital) * 100)),
    winRate: ps.length ? net.filter((x) => x > 0).length / ps.length : 0,
    netUsd: mean(net) * capital / 100,
  };
}

export interface Scorecard {
  sessions: string[];
  rows: ScorecardRow[];
  capitals: number[];
  projections: Map<string, CapitalProjection[]>;
  regimes: Map<string, { regime: string; n: number; avgNetPct: number; winRate: number }[]>;
}

export function scorecard(db: Db, sessionIds: string[], opts: { modes?: string[]; capitals?: number[] } = {}): Scorecard {
  const ps = loadScorecardPositions(db, sessionIds, opts.modes);
  const byMode = new Map<string, ScorecardPosition[]>();
  for (const p of ps) (byMode.get(p.mode) ?? byMode.set(p.mode, []).get(p.mode)!).push(p);
  const capitals = opts.capitals ?? [40, 45, 50, 100, 1000];
  const rows = [...byMode.entries()].map(([m, v]) => scorecardRow(m, v)).sort((a, b) => b.n - a.n);
  const projections = new Map([...byMode.entries()].map(([m, v]) => [m, capitals.map((c) => projectCapital(v, c))]));
  const regimes = new Map<string, { regime: string; n: number; avgNetPct: number; winRate: number }[]>();
  for (const [m, v] of byMode) {
    const g = new Map<string, ScorecardPosition[]>();
    for (const p of v) {
      const k = p.regime ?? "unknown";
      (g.get(k) ?? g.set(k, []).get(k)!).push(p);
    }
    regimes.set(m, [...g.entries()].map(([regime, x]) => ({
      regime, n: x.length, avgNetPct: mean(x.map((p) => (p.net / p.cap) * 100)), winRate: x.filter((p) => p.net > 0).length / x.length,
    })).sort((a, b) => b.n - a.n));
  }
  return { sessions: sessionIds, rows, capitals, projections, regimes };
}

const f = (v: number | null, d = 2) => (v === null || !Number.isFinite(v) ? "-" : v.toFixed(d));
const p0 = (v: number) => `${(v * 100).toFixed(0)}%`;

export function scorecardMarkdown(sc: Scorecard, opts: { title?: boolean } = {}): string {
  const md: string[] = [];
  if (opts.title !== false) md.push(`# Strategy scorecard (${sc.sessions.length} session(s))\n`);
  if (!sc.rows.length) return md.concat("No closed clean positions.").join("\n") + "\n";
  md.push("Closed positions without a data gap. One session proves nothing: read the sample columns first.\n");
  md.push("**Sample and performance**\n");
  md.push("| entry mode | sessions | pools | positions | total net $ | avg net % | median net % | gross % | win | loss | profit factor | avg trade $ | median trade $ | avg max DD % | worst % |");
  md.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const r of sc.rows)
    md.push(`| ${r.mode} | ${r.sessions} | ${r.pools} | ${r.n} | ${f(r.totalNetUsd)} | ${f(r.avgNetPct, 3)} | ${f(r.medianNetPct, 3)} | ${f(r.grossPct, 3)} | ${p0(r.winRate)} | ${p0(r.lossRate)} | ${f(r.profitFactor)} | ${f(r.avgTradeUsd)} | ${f(r.medianTradeUsd)} | ${f(r.avgMddPct)} | ${f(r.worstPct)} |`);
  md.push("");
  md.push("**Cost per position** (break-even % = all non-refundable cost / capital; fixed = transaction fees + bin-array creation, the same dollars at any size; variable = swaps incl. price impact, token tax, composition fee)\n");
  md.push("| entry mode | break-even % | fixed % | variable % | tx operations | tx $ | swap $ | token tax $ | composition $ | bin array $ | rent locked $ (refunded) | minutes in position |");
  md.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const r of sc.rows)
    md.push(`| ${r.mode} | ${f(r.breakEvenPct, 3)} | ${f(r.fixedPct, 3)} | ${f(r.variablePct, 3)} | ${f(r.txOps, 1)} | ${f(r.txUsd, 3)} | ${f(r.swapUsd, 3)} | ${f(r.taxUsd, 3)} | ${f(r.compositionUsd, 3)} | ${f(r.binArrayUsd, 3)} | ${f(r.rentUsd)} | ${f(r.avgMinutes, 0)} |`);
  md.push("");
  md.push("**Capital efficiency and risk** (net % per hour = total net / (capital x hours in position); *with rent* adds the locked rent to the capital; rug exposure = positions open when the rug detector flagged their token)\n");
  md.push("| entry mode | net %/h | net %/h with rent | fee %/h | rug exposure | net % of rug-exposed |");
  md.push("|---|--:|--:|--:|--:|--:|");
  for (const r of sc.rows)
    md.push(`| ${r.mode} | ${f(r.effPctPerHour, 3)} | ${f(r.effWithRentPctPerHour, 3)} | ${f(r.feePctPerHour, 3)} | ${(r.rugExposure * 100).toFixed(1)}% | ${f(r.rugNetPct)} |`);
  md.push("");
  md.push(`**Projected to other capitals** (same positions; fixed dollars spread over a smaller size; avg net % / break-even % / win)\n`);
  md.push(`| entry mode | ${sc.capitals.map((c) => `$${c}`).join(" | ")} |`);
  md.push(`|---|${sc.capitals.map(() => "--:").join("|")}|`);
  for (const r of sc.rows) {
    const pr = sc.projections.get(r.mode)!;
    md.push(`| ${r.mode} | ${pr.map((x) => `${f(x.netPct)} / ${f(x.breakEvenPct)} / ${p0(x.winRate)}`).join(" | ")} |`);
  }
  md.push("");
  md.push(`Locked rent as a share of the position: ${sc.capitals.map((c) => `$${c}: ${f(sc.rows.length ? mean(sc.rows.map((r) => sc.projections.get(r.mode)!.find((x) => x.capital === c)!.rentPct)) : 0, 1)}%`).join(", ")} (refunded on close, but the wallet must hold it).`);
  md.push("");
  const known = [...sc.regimes.values()].some((v) => v.some((x) => x.regime !== "unknown"));
  if (known) {
    md.push("**By market regime at entry** (avg net % / positions)\n");
    const labels = [...new Set([...sc.regimes.values()].flatMap((v) => v.map((x) => x.regime)))].sort();
    md.push(`| entry mode | ${labels.join(" | ")} |`);
    md.push(`|---|${labels.map(() => "--:").join("|")}|`);
    for (const r of sc.rows) {
      const g = sc.regimes.get(r.mode)!;
      md.push(`| ${r.mode} | ${labels.map((l) => {
        const x = g.find((y) => y.regime === l);
        return x ? `${f(x.avgNetPct)} / ${x.n}` : "-";
      }).join(" | ")} |`);
    }
    md.push("");
  }
  return md.join("\n") + "\n";
}

/**
 * `dlmm capital`: the live session projected to every capital, next to replays of the same data
 * at each capital (exact: the simulator re-runs with that position size). A replay is not the live
 * run (no network delays, rounding of the feed), so compare the replays with each other.
 */
export function capitalComparisonMarkdown(sessionId: string, base: Scorecard, replays: { capital: number; sc: Scorecard }[]): string {
  const md: string[] = [`# Capital-aware simulation — session \`${sessionId.slice(0, 8)}\`\n`];
  md.push("Fixed costs (transaction fees, bin-array creation) are the same dollars at any size; variable costs (swaps incl. price impact, token tax, composition fee) scale with it. Cells: avg net % / break-even % (fixed part %).\n");
  const modes = base.rows.map((r) => r.mode);
  if (replays.length) {
    md.push("**Replays of the session at each capital** (exact)\n");
    md.push(`| entry mode | ${replays.map((r) => `$${r.capital}`).join(" | ")} |`);
    md.push(`|---|${replays.map(() => "--:").join("|")}|`);
    for (const m of modes)
      md.push(`| ${m} | ${replays.map((r) => {
        const x = r.sc.rows.find((y) => y.mode === m);
        return x ? `${f(x.avgNetPct)} / ${f(x.breakEvenPct)} (${f(x.fixedPct)}) n=${x.n}` : "-";
      }).join(" | ")} |`);
    md.push("");
    const big = [...replays].sort((a, b) => b.capital - a.capital)[0];
    md.push(`**Projection from the $${big.capital} replay vs the replay at each capital** (avg net %: projected -> replayed; the projection keeps the fee share per dollar, so a gap shows how much a smaller position gains from a larger share)\n`);
    md.push(`| entry mode | ${replays.map((r) => `$${r.capital}`).join(" | ")} |`);
    md.push(`|---|${replays.map(() => "--:").join("|")}|`);
    for (const m of modes)
      md.push(`| ${m} | ${replays.map((r) => {
        const bp = big.sc.rows.find((y) => y.mode === m);
        const x = r.sc.rows.find((y) => y.mode === m);
        if (!bp || !x) return "-";
        // every position of one replay has the same size, so this equals the mean of projectCapital
        const projected = bp.grossPct - bp.variablePct - (bp.fixedUsd / r.capital) * 100;
        return `${f(projected)} -> ${f(x.avgNetPct)}`;
      }).join(" | ")} |`);
    md.push("");
  }
  md.push("**Projection from the live session** (no replay needed)\n");
  const lines = scorecardMarkdown(base, { title: false }).split("\n");
  const at = lines.findIndex((l) => l.startsWith("**Projected to other capitals**"));
  const end = lines.findIndex((l, i) => i > at && l.startsWith("Locked rent"));
  md.push(at >= 0 ? lines.slice(at, end >= 0 ? end + 1 : undefined).join("\n") : "No closed clean positions.");
  return md.join("\n") + "\n";
}
