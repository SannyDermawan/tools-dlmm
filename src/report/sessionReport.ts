import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Db } from "../db/index.ts";
import { getSession } from "../db/repo.ts";
import { realismMarkdown } from "../analysis/realism.ts";
import { lpOutcomes, lpOutcomesMarkdown } from "../analysis/lpOutcomes.ts";
import { portfolioReportMarkdown } from "../analysis/portfolio.ts";
import { loadConfig } from "../config/load.ts";
import { calibrationMarkdown, groupComparison, groupComparisonMarkdown, reconciliationMarkdown, safetyMemoryMarkdown, breakEvenMarkdown, entryFilterMarkdown, scoreCalibration, signalVsBaseline, signalVsBaselineMarkdown } from "./analytics.ts";
import { markdownToHtml } from "./html.ts";

interface Agg {
  k: string;
  n: number;
  win: number;
  net_pct: number;
  net_usd: number;
  fee: number;
  il: number;
  cost: number;
  in_range: number;
  dur: number;
  tainted: number;
  fee_il: number | null;
  mdd: number | null;
  /** PnL before costs (what a tracker shows) and the break-even it must exceed, % of capital */
  tracker_pct: number | null;
  breakeven_pct: number | null;
}

/** Blueprint 18.1 metrics per group: net PnL ($, %), fee, IL, cost, fee/IL, in-range, drawdown, duration, win rate. */
const AGG = `COUNT(*) n, AVG(r.net_pnl_usd > 0) win, AVG(r.net_pnl_pct) net_pct, AVG(r.net_pnl_usd) net_usd, AVG(r.fee_usd) fee,
  AVG(r.il_usd) il, AVG(r.cost_usd) cost, AVG(r.time_in_range_pct) in_range, AVG(r.duration_min) dur, SUM(p.gap_tainted) tainted,
  SUM(r.fee_usd) / NULLIF(-SUM(MIN(r.il_usd, 0)), 0) fee_il, AVG(r.max_drawdown_pct) mdd,
  AVG((r.net_pnl_usd + r.cost_usd) / p.capital_usd * 100) tracker_pct, AVG(r.cost_usd / p.capital_usd * 100) breakeven_pct`;

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "-" : `${v.toFixed(d)}%`);
const usd = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "-" : `$${v.toFixed(d)}`);

function table(rows: Agg[], keyTitle: string): string {
  const head = `| ${keyTitle} | n | win | avg net % | tracker % | break-even % | avg net $ | avg fee $ | avg IL $ | avg cost $ | fee/IL | in range | max DD | avg min | tainted |\n|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|`;
  const body = rows
    .map((r) => `| ${r.k} | ${r.n} | ${(r.win * 100).toFixed(0)}% | ${pct(r.net_pct, 3)} | ${pct(r.tracker_pct, 3)} | ${pct(r.breakeven_pct, 3)} | ${usd(r.net_usd)} | ${usd(r.fee)} | ${usd(r.il)} | ${usd(r.cost)} | ${r.fee_il === null ? "-" : r.fee_il.toFixed(2)} | ${pct(r.in_range, 0)} | ${pct(r.mdd, 2)} | ${r.dur.toFixed(0)} | ${r.tainted} |`)
    .join("\n");
  return `${head}\n${body}`;
}

/** Portfolio defaults for the report: the config the session ran with is not stored in full, so use the current default config. */
function loadReportPortfolioConfig(_db: Db, _sessionId: string) {
  return loadConfig().config.portfolio;
}

export interface ReportPaths {
  dir: string;
  markdown: string;
  positionsCsv: string;
  dimensionsCsv: string;
  html: string;
  metricsJson: string;
}

/**
 * Basic session report (blueprint 18.3): summary, data health, performance per grid dimension
 * and entry mode, close reasons, top/bottom combinations (with a significance warning), CSVs.
 */
export function writeSessionReport(db: Db, simSessionId: string, outDir = "reports"): ReportPaths {
  const s = getSession(db, simSessionId);
  if (!s) throw new Error(`session ${simSessionId} not found`);
  const dataSession = (db.get<{ source_session_id: string | null }>("SELECT source_session_id FROM sessions WHERE session_id=?", simSessionId)?.source_session_id) ?? simSessionId;
  const ds = getSession(db, dataSession)!;
  const dir = resolve(outDir, simSessionId);
  mkdirSync(dir, { recursive: true });

  const tot = db.get<{ n: number; active: number; closed: number; failed: number; tainted: number }>(
    `SELECT COUNT(*) n, SUM(status='active') active, SUM(status='closed') closed, SUM(status='failed') failed, SUM(gap_tainted) tainted FROM sim_positions WHERE session_id=?`,
    simSessionId,
  )!;
  const all = db.get<Agg>(`SELECT 'all' k, ${AGG} FROM sim_positions p JOIN sim_results r USING(position_id) WHERE p.session_id=?`, simSessionId)!;
  const clean = db.get<Agg>(`SELECT 'clean' k, ${AGG} FROM sim_positions p JOIN sim_results r USING(position_id) WHERE p.session_id=? AND p.gap_tainted=0`, simSessionId)!;
  const by = (expr: string) =>
    db.all<Agg>(`SELECT ${expr} AS k, ${AGG} FROM sim_positions p JOIN sim_results r USING(position_id) WHERE p.session_id=? GROUP BY k ORDER BY net_pct DESC`, simSessionId);
  const dims: [string, string][] = [
    ["entry mode", "p.entry_mode"],
    ["strategy", "p.strategy"],
    ["bins per side", "CAST(json_extract(p.grid_combo,'$.bins_per_side') AS TEXT)"],
    ["range width (downside price %)", "CASE WHEN json_extract(p.grid_combo,'$.range_down_pct') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.range_down_pct') = 0 THEN 'none (base-only)' WHEN json_extract(p.grid_combo,'$.range_down_pct') < 15 THEN '< 15%' WHEN json_extract(p.grid_combo,'$.range_down_pct') < 30 THEN '15-30%' WHEN json_extract(p.grid_combo,'$.range_down_pct') < 50 THEN '30-50%' WHEN json_extract(p.grid_combo,'$.range_down_pct') < 70 THEN '50-70%' WHEN json_extract(p.grid_combo,'$.range_down_pct') < 85 THEN '70-85%' ELSE '>= 85%' END"],
    ["token age at entry", "CASE WHEN json_extract(p.grid_combo,'$.token_age_h') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.token_age_h') < 6 THEN '< 6 h' WHEN json_extract(p.grid_combo,'$.token_age_h') < 48 THEN '6-48 h' ELSE '>= 48 h' END"],
    ["market cap at entry", "CASE WHEN json_extract(p.grid_combo,'$.mcap_usd') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.mcap_usd') < 500000 THEN '1) < $500k' WHEN json_extract(p.grid_combo,'$.mcap_usd') < 1000000 THEN '2) $500k-1M' WHEN json_extract(p.grid_combo,'$.mcap_usd') < 2000000 THEN '3) $1-2M' WHEN json_extract(p.grid_combo,'$.mcap_usd') < 5000000 THEN '4) $2-5M' WHEN json_extract(p.grid_combo,'$.mcap_usd') < 20000000 THEN '5) $5-20M' ELSE '6) >= $20M' END"],
    ["top-10 holders at entry", "CASE WHEN json_extract(p.grid_combo,'$.top10_pct') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.top10_pct') < 20 THEN '< 20%' WHEN json_extract(p.grid_combo,'$.top10_pct') < 40 THEN '20-40%' WHEN json_extract(p.grid_combo,'$.top10_pct') < 60 THEN '40-60%' ELSE '>= 60%' END"],
    ["organic score at entry", "CASE WHEN json_extract(p.grid_combo,'$.organic') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.organic') < 30 THEN '< 30' WHEN json_extract(p.grid_combo,'$.organic') < 60 THEN '30-60' ELSE '>= 60' END"],
    ["holders at entry", "CASE WHEN json_extract(p.grid_combo,'$.holders') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.holders') < 500 THEN '< 500' WHEN json_extract(p.grid_combo,'$.holders') < 2000 THEN '500-2000' WHEN json_extract(p.grid_combo,'$.holders') < 10000 THEN '2000-10000' ELSE '>= 10000' END"],
    ["smart LPs with an open position at entry", "CASE WHEN json_extract(p.grid_combo,'$.smart_lp_open') IS NULL THEN 'unknown (no real-LP data)' WHEN json_extract(p.grid_combo,'$.smart_lp_open') = 0 THEN 'none' WHEN json_extract(p.grid_combo,'$.smart_lp_open') < 3 THEN '1-2' ELSE '>= 3' END"],
    ["bundler supply at entry", "CASE WHEN json_extract(p.grid_combo,'$.bundler_pct') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.bundler_pct') < 5 THEN '< 5%' WHEN json_extract(p.grid_combo,'$.bundler_pct') < 15 THEN '5-15%' ELSE '>= 15%' END"],
    ["drawdown from ATH at entry", "CASE WHEN json_extract(p.grid_combo,'$.ath_drawdown_pct') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.ath_drawdown_pct') < 10 THEN '< 10% (near ATH)' WHEN json_extract(p.grid_combo,'$.ath_drawdown_pct') < 30 THEN '10-30%' WHEN json_extract(p.grid_combo,'$.ath_drawdown_pct') < 50 THEN '30-50%' WHEN json_extract(p.grid_combo,'$.ath_drawdown_pct') < 70 THEN '50-70%' ELSE '>= 70%' END"],
    ["pool age at entry", "CASE WHEN json_extract(p.grid_combo,'$.pool_age_h') IS NULL THEN 'unknown' WHEN json_extract(p.grid_combo,'$.pool_age_h') < 6 THEN '< 6 h' WHEN json_extract(p.grid_combo,'$.pool_age_h') < 48 THEN '6-48 h' ELSE '>= 48 h' END"],
    ["sides", "p.sides"],
    ["exit policy", "json_extract(p.grid_combo,'$.exit_policy')"],
    ["exit policy type", "COALESCE(json_extract(p.exit_policy_params,'$.type'), substr(json_extract(p.grid_combo,'$.exit_policy'), 1, instr(json_extract(p.grid_combo,'$.exit_policy') || ':', ':') - 1))"],
    ["strategy variant", "COALESCE(json_extract(p.grid_combo,'$.variant'),'none')"],
    ["pool category", "(SELECT category FROM pools WHERE pool=p.pool)"],
    ["cohort", "CAST(json_extract(p.grid_combo,'$.cohort') AS TEXT)"],
    ["close reason", "p.close_reason"],
    ["regime at entry", "COALESCE((SELECT json_extract(sg.payload,'$.regime_label') FROM signals sg WHERE sg.signal_id = p.signal_id),'unknown')"],
    ["entry hour (WIB)", "printf('%02d:00', ((p.opened_at / 3600000) + 7) % 24)"],
    ["signal action at entry", "COALESCE(json_extract(p.grid_combo,'$.signal_action'),'none')"],
    ["entry mode x signal action", "p.entry_mode || ' / ' || COALESCE(json_extract(p.grid_combo,'$.signal_action'),'none')"],
    ["entry filter (indicators)", "COALESCE(p.entry_filter, 'none')"],
    ["entry trigger (signal modes)", "COALESCE(json_extract(p.grid_combo,'$.entry_trigger'), '-')"],
    ["size vs TVL at open", "CASE WHEN json_extract(r.detail,'$.sizePctTvl') IS NULL THEN 'unknown' WHEN json_extract(r.detail,'$.sizePctTvl') < 0.5 THEN '< 0.5%' WHEN json_extract(r.detail,'$.sizePctTvl') < 2 THEN '0.5-2%' WHEN json_extract(r.detail,'$.sizePctTvl') < 5 THEN '2-5%' ELSE '> 5%' END"],
    ["pool fee mode", "CASE (SELECT collect_fee_mode FROM pools WHERE pool = p.pool) WHEN 1 THEN 'quote only' WHEN 0 THEN 'input token' ELSE 'unknown' END"],
    ["pool cooldown (signal modes)", "CASE p.cooldown_enabled WHEN 1 THEN 'on' WHEN 0 THEN 'off' ELSE 'n/a' END"],
    ["matches recommendation", "CASE json_extract(p.grid_combo,'$.matches_recommendation') WHEN 1 THEN 'yes' ELSE 'no' END"],
  ];
  const byPool = db.all<Agg>(
    `SELECT pl.name || ' (' || substr(p.pool,1,6) || ')' AS k, ${AGG} FROM sim_positions p JOIN sim_results r USING(position_id) JOIN pools pl ON pl.pool=p.pool
     WHERE p.session_id=? GROUP BY p.pool ORDER BY net_pct DESC`, simSessionId,
  );
  const comboExpr = "p.strategy || '/' || json_extract(p.grid_combo,'$.bins_per_side') || '/' || p.sides || '/' || json_extract(p.grid_combo,'$.exit_policy') || COALESCE('/' || NULLIF(json_extract(p.grid_combo,'$.variant'),'none'),'')";
  const combos = db.all<Agg>(
    `SELECT ${comboExpr} AS k, ${AGG} FROM sim_positions p JOIN sim_results r USING(position_id) WHERE p.session_id=? AND p.gap_tainted=0 GROUP BY k HAVING n >= 3 ORDER BY net_pct DESC`,
    simSessionId,
  );
  const gaps = db.all<{ source: string; n: number; minutes: number }>(
    "SELECT source, COUNT(*) n, SUM(COALESCE(end_at, ?) - start_at)/60000.0 minutes FROM data_gaps WHERE session_id=? GROUP BY source",
    ds.end_at ?? Date.now(), dataSession,
  );
  const http = db.all<{ endpoint: string; calls: number; errors: number; credits: number }>(
    "SELECT endpoint, SUM(calls) calls, SUM(errors) errors, SUM(credits) credits FROM rpc_usage WHERE session_id=? GROUP BY endpoint", dataSession,
  );
  const pools = db.get<{ n: number }>("SELECT COUNT(*) n FROM session_pools WHERE session_id=?", dataSession)?.n ?? 0;
  const failures = db.all<{ close_reason: string; n: number }>(
    "SELECT close_reason, COUNT(*) n FROM sim_positions WHERE session_id=? AND status='failed' GROUP BY close_reason", simSessionId,
  );
  const events = db.get<{ reb: number; crossings: number }>(
    `SELECT SUM(type='rebalance') reb, SUM(type='cross') crossings FROM sim_position_events WHERE position_id IN (SELECT position_id FROM sim_positions WHERE session_id=?)`,
    simSessionId,
  )!;
  const iso = (t: number | null) => (t ? new Date(t).toISOString().replace(".000", "") : "-");

  const md: string[] = [];
  md.push(`# Session report — ${s.label ?? s.session_id}`);
  md.push("");
  md.push(`- simulation session: \`${s.session_id}\` (${s.kind}, ${s.status})`);
  md.push(`- data session: \`${ds.session_id}\` ${iso(ds.start_at)} → ${iso(ds.end_at)} (${(((ds.end_at ?? Date.now()) - ds.start_at) / 60000).toFixed(0)} min)`);
  md.push(`- config_version: \`${s.config_version}\``);
  if (s.notes) md.push(`- notes: ${s.notes}`);
  md.push("");
  md.push("> **Warning:** results of one session are not statistically significant. Judge strategies by their consistency across many sessions, days and market conditions (blueprint 13.4). Keep holdout sessions out of any selection.");
  md.push("");
  md.push("## Summary");
  md.push("");
  md.push(`| pools | positions | closed | failed | still open | gap-tainted | rebalances | range crossings |\n|--:|--:|--:|--:|--:|--:|--:|--:|\n| ${pools} | ${tot.n} | ${tot.closed ?? 0} | ${tot.failed ?? 0} | ${tot.active ?? 0} | ${tot.tainted ?? 0} | ${events.reb ?? 0} | ${events.crossings ?? 0} |`);
  md.push("");
  if (all?.n) {
    md.push(table([all, clean].filter((r) => r && r.n), "set"));
    md.push("");
    // blueprint 4.9: USD/IDR only for reporting profit in rupiah
    const fx = db.get<{ usd_idr: number | null }>(
      "SELECT usd_idr FROM macro_metrics WHERE usd_idr IS NOT NULL AND ts <= ? ORDER BY ts DESC LIMIT 1", ds.end_at ?? Date.now(),
    )?.usd_idr;
    const totalNet = all.net_usd * all.n;
    md.push(`Total net PnL of all positions: **$${totalNet.toFixed(2)}**` + (fx ? ` ≈ **Rp${Math.round(totalNet * fx).toLocaleString("id-ID")}** (USD/IDR ${fx.toFixed(0)})` : "") + ` over ${all.n} virtual positions of $${(db.get<{ c: number }>("SELECT AVG(capital_usd) c FROM sim_positions WHERE session_id=?", simSessionId)?.c ?? 0).toFixed(0)} each.`);
    md.push("");
  }
  if (failures.length) md.push(`Failed positions: ${failures.map((f) => `${f.close_reason} ×${f.n}`).join(", ")}\n`);
  const sigs = db.all<{ action: string; n: number; taken: number }>(
    "SELECT action, COUNT(*) n, SUM(taken) taken FROM signals WHERE session_id=? GROUP BY action ORDER BY action", simSessionId,
  );
  if (sigs.length) {
    md.push("## Signals");
    md.push("");
    md.push("| action | signals | used for a signal-mode entry |\n|---|--:|--:|\n" + sigs.map((x) => `| ${x.action} | ${x.n} | ${x.taken} |`).join("\n"));
    md.push("");
    try {
      const ev = (JSON.parse(s.notes ?? "{}").grid?.events ?? null) as { detected: number; opened: number; skipped: Record<string, number> } | null;
      if (ev && ev.detected > 0)
        md.push(`Event entries (grid.signal_entry): ${ev.detected} rising edges, ${ev.opened} entries${Object.keys(ev.skipped).length ? `; not entered: ${Object.entries(ev.skipped).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}. Compare cohort and event entries in the table *entry trigger (signal modes)*.\n`);
    } catch {
      /* notes are free text in old sessions */
    }
    md.push("The main measure of signal value is the **entry mode** table: `signal_enter` vs `all_pools_baseline` (blueprint 18.1). Baseline positions record the pool's signal at entry, so the table *signal action at entry* shows whether skipping LEWATI pools was right.");
    md.push("");
  }
  const cmp = signalVsBaseline(db, [simSessionId]);
  const cal = scoreCalibration(db, [simSessionId]);
  md.push("## Signal vs baseline (blueprint 18.1 — the main measure)");
  md.push("");
  md.push(signalVsBaselineMarkdown(cmp));
  md.push("");
  md.push("## Sequential account (one position at a time, compounding)");
  md.push("");
  md.push(portfolioReportMarkdown(db, simSessionId, loadReportPortfolioConfig(db, simSessionId)));
  md.push("");
  md.push("## Tracker PnL, break-even and where the cost comes from");
  md.push("");
  md.push(breakEvenMarkdown(db, simSessionId));
  md.push("");
  md.push("## Baseline vs Meridian preset vs signal (addendum 2.4)");
  md.push("");
  const groups = groupComparison(db, [simSessionId]);
  md.push(groupComparisonMarkdown(groups));
  md.push("");
  md.push("## Safety filters, blocklist and pool memory (addendum 3)");
  md.push("");
  md.push(safetyMemoryMarkdown(db, simSessionId, dataSession, ds.start_at, ds.end_at ?? Date.now()));
  md.push("");
  md.push("## Indicator entry filters (addendum 6.1)");
  md.push("");
  md.push(entryFilterMarkdown(db, simSessionId));
  md.push("");
  md.push("## Real LP positions and simulator realism (addendum 4)");
  md.push("");
  md.push(realismMarkdown(db, dataSession));
  md.push("");
  md.push("### Real positions that opened during the session, followed to closure");
  md.push("");
  md.push(lpOutcomesMarkdown(lpOutcomes(db, { since: ds.start_at, until: ds.end_at ?? Date.now(), minDepositUsd: 20 })));
  md.push("");
  md.push("## Score calibration");
  md.push("");
  md.push(calibrationMarkdown(cal));
  md.push("");
  md.push("## Fee reconciliation (simulator vs API / chain)");
  md.push("");
  md.push(reconciliationMarkdown(db, dataSession));
  md.push("");
  md.push("## Data health");
  md.push("");
  md.push(gaps.length ? `| source | gaps | gap minutes (pool-minutes) |\n|---|--:|--:|\n${gaps.map((g) => `| ${g.source} | ${g.n} | ${g.minutes.toFixed(1)} |`).join("\n")}` : "No data gaps recorded.");
  md.push("");
  if (http.length) md.push(`| endpoint | calls | errors | credits |\n|---|--:|--:|--:|\n${http.map((h) => `| ${h.endpoint} | ${h.calls} | ${h.errors} | ${h.credits} |`).join("\n")}\n`);
  md.push("Positions overlapping a gap of pool_state / bin_snapshot / pool_metrics (or swap_stream in swap_events mode) are tainted and must be excluded from calibration.");
  md.push("");
  md.push("## Performance by dimension");
  const dimRows: Record<string, unknown>[] = [];
  for (const [title, expr] of dims) {
    const rows = by(expr);
    md.push(`\n### ${title}\n`);
    md.push(table(rows, title));
    for (const r of rows) dimRows.push({ dimension: title, ...r });
  }
  md.push(`\n### pool\n`);
  md.push(table(byPool, "pool"));
  for (const r of byPool) dimRows.push({ dimension: "pool", ...r });
  md.push("\n## Top 10 / bottom 10 combinations (clean positions, n ≥ 3)\n");
  md.push("> Selected from many combinations: the best ones are partly luck (multiple testing).\n");
  md.push(table(combos.slice(0, 10), "strategy/bins/sides/exit/variant"));
  md.push("");
  md.push(table(combos.slice(-10).reverse(), "strategy/bins/sides/exit/variant"));
  md.push("\n## Simulator limitations (blueprint 12.6)\n");
  md.push("- Our virtual liquidity does not change Jupiter routing or other LPs' behaviour (fees may be overstated for large sizes relative to the pool).");
  md.push("- Transaction failures are modelled by an assumed failure rate and entry delay, not observed.");
  md.push("- Fees accrue only over data intervals fully inside a position's life (slightly pessimistic); the active-bin composition between snapshots is estimated.");
  md.push("- Good demo results must still be validated with small real capital later (outside v1).");
  md.push("- Fee reconciliation: run `dlmm reconcile -s <data session> [--census]`.");

  const positions = db.all<Record<string, unknown>>(
    `SELECT p.position_id, p.pool, pl.name AS pool_name, pl.category, p.entry_mode, p.strategy, p.sides, p.bins_below, p.bins_above,
            json_extract(p.grid_combo,'$.exit_policy') AS exit_policy, json_extract(p.grid_combo,'$.cohort') AS cohort,
            p.lower_bin, p.upper_bin, p.capital_usd, p.requested_at, p.opened_at, p.closed_at, p.close_reason, p.gap_tainted, p.status,
            r.fee_usd, r.il_usd, r.cost_usd, r.rent_locked_usd, r.net_pnl_usd, r.net_pnl_pct, r.time_in_range_pct, r.duration_min,
            r.max_drawdown_usd, r.max_drawdown_pct, r.final_value_usd, r.hodl_value_usd, r.entry_price, r.exit_price,
            json_extract(r.detail,'$.rebalances') AS rebalances, json_extract(r.detail,'$.pnlVsHodlUsd') AS pnl_vs_hodl_usd,
            p.config_version
     FROM sim_positions p LEFT JOIN sim_results r USING(position_id) LEFT JOIN pools pl ON pl.pool = p.pool
     WHERE p.session_id=? ORDER BY p.requested_at, p.pool`,
    simSessionId,
  );
  const paths: ReportPaths = {
    dir,
    markdown: join(dir, "report.md"),
    positionsCsv: join(dir, "positions.csv"),
    dimensionsCsv: join(dir, "by_dimension.csv"),
    html: join(dir, "report.html"),
    metricsJson: join(dir, "metrics.json"),
  };
  const mdText = md.join("\n") + "\n";
  writeFileSync(paths.markdown, mdText);
  writeFileSync(paths.html, markdownToHtml(mdText, `Session report — ${s.label ?? s.session_id}`));
  writeFileSync(paths.positionsCsv, toCsv(positions));
  writeFileSync(paths.dimensionsCsv, toCsv(dimRows));
  writeFileSync(
    paths.metricsJson,
    JSON.stringify({ session: s, dataSession: ds, totals: tot, all, clean, signalVsBaseline: cmp, groups, scoreCalibration: cal, gaps, http }, null, 2),
  );
  return paths;
}
