import type { Db } from "../db/index.ts";

const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(d));

export interface ModeComparison {
  cohorts: { cohort: number; baseline: { n: number; net: number | null }; modes: Record<string, { n: number; net: number | null; diff: number | null }> }[];
  overall: Record<string, { n: number; net: number | null; baselineNet: number | null; diff: number | null; cohortsWithEntries: number; betterCohorts: number }>;
}

/**
 * Blueprint 18.1 main measure: signal modes vs the all-pools baseline, compared cohort by cohort
 * (same moment, same grid) and overall. Only clean (not gap-tainted) closed positions count.
 */
export function signalVsBaseline(db: Db, sessionIds: string[]): ModeComparison {
  const ph = sessionIds.map(() => "?").join(",");
  const rows = db.all<{ sid: string; cohort: number; mode: string; n: number; net: number | null }>(
    `SELECT p.session_id sid, CAST(json_extract(p.grid_combo,'$.cohort') AS INT) cohort, p.entry_mode mode, COUNT(*) n, AVG(r.net_pnl_pct) net
     FROM sim_positions p JOIN sim_results r USING(position_id)
     WHERE p.session_id IN (${ph}) AND p.status = 'closed' AND p.gap_tainted = 0
     GROUP BY p.session_id, cohort, mode ORDER BY p.session_id, cohort`,
    ...sessionIds,
  );
  const byCohort = new Map<string, Map<string, { n: number; net: number | null }>>();
  for (const r of rows) {
    const k = `${r.sid}|${r.cohort}`;
    if (!byCohort.has(k)) byCohort.set(k, new Map());
    byCohort.get(k)!.set(r.mode, { n: r.n, net: r.net });
  }
  const cohorts: ModeComparison["cohorts"] = [];
  const acc: Record<string, { n: number; w: number; wb: number; cohorts: number; better: number }> = {};
  let idx = 0;
  for (const [, m] of byCohort) {
    idx++;
    const b = m.get("all_pools_baseline") ?? { n: 0, net: null };
    const modes: Record<string, { n: number; net: number | null; diff: number | null }> = {};
    for (const [mode, v] of m) {
      if (mode === "all_pools_baseline") continue;
      const diff = v.net !== null && b.net !== null ? v.net - b.net : null;
      modes[mode] = { ...v, diff };
      const a = (acc[mode] ??= { n: 0, w: 0, wb: 0, cohorts: 0, better: 0 });
      if (v.net !== null && b.net !== null) {
        a.n += v.n;
        a.w += v.net * v.n;
        a.wb += b.net * v.n; // baseline weighted like the mode, cohort by cohort
        a.cohorts++;
        if (diff! > 0) a.better++;
      }
    }
    cohorts.push({ cohort: idx, baseline: b, modes });
  }
  const overall: ModeComparison["overall"] = {};
  for (const [mode, a] of Object.entries(acc)) {
    const net = a.n ? a.w / a.n : null;
    const bnet = a.n ? a.wb / a.n : null;
    overall[mode] = { n: a.n, net, baselineNet: bnet, diff: net !== null && bnet !== null ? net - bnet : null, cohortsWithEntries: a.cohorts, betterCohorts: a.better };
  }
  return { cohorts, overall };
}

export interface CalibrationBucket {
  bucket: string;
  n: number;
  win: number | null;
  net: number | null;
}

const BUCKET = `CASE
  WHEN json_extract(p.grid_combo,'$.signal_score') IS NULL THEN 'no score'
  WHEN json_extract(p.grid_combo,'$.signal_score') < 60 THEN '<60'
  WHEN json_extract(p.grid_combo,'$.signal_score') < 70 THEN '60-70'
  WHEN json_extract(p.grid_combo,'$.signal_score') < 80 THEN '70-80'
  WHEN json_extract(p.grid_combo,'$.signal_score') < 90 THEN '80-90'
  ELSE '90-100' END`;

/**
 * Score calibration (blueprint 18.1): baseline positions grouped by the pool's final score at
 * entry. A meaningful score gives better results in higher buckets, consistently.
 */
export function scoreCalibration(db: Db, sessionIds: string[], minN = 20): { buckets: CalibrationBucket[]; monotonic: boolean | null } {
  const ph = sessionIds.map(() => "?").join(",");
  const buckets = db.all<CalibrationBucket>(
    `SELECT ${BUCKET} bucket, COUNT(*) n, AVG(r.net_pnl_usd > 0) win, AVG(r.net_pnl_pct) net
     FROM sim_positions p JOIN sim_results r USING(position_id)
     WHERE p.session_id IN (${ph}) AND p.entry_mode = 'all_pools_baseline' AND p.status = 'closed' AND p.gap_tainted = 0
     GROUP BY bucket`,
    ...sessionIds,
  );
  const order = ["<60", "60-70", "70-80", "80-90", "90-100", "no score"];
  buckets.sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
  const scored = buckets.filter((b) => b.bucket !== "no score" && b.n >= minN && b.net !== null);
  let monotonic: boolean | null = null;
  if (scored.length >= 2) {
    monotonic = true;
    for (let i = 1; i < scored.length; i++) if (scored[i].net! < scored[i - 1].net!) monotonic = false;
  }
  return { buckets, monotonic };
}

export function signalVsBaselineMarkdown(c: ModeComparison): string {
  const out: string[] = [];
  const modes = Object.keys(c.overall);
  if (!modes.length) {
    return "No signal-mode positions in this session (no pool reached the entry action at a cohort time). The baseline still records every pool's signal at entry — see *signal action at entry*.";
  }
  out.push("| entry mode | positions | avg net % | baseline avg net % (same cohorts) | difference | cohorts better / with entries |");
  out.push("|---|--:|--:|--:|--:|--:|");
  for (const m of modes) {
    const o = c.overall[m];
    out.push(`| ${m} | ${o.n} | ${f(o.net)}% | ${f(o.baselineNet)}% | **${o.diff !== null && o.diff >= 0 ? "+" : ""}${f(o.diff)}** pp | ${o.betterCohorts} / ${o.cohortsWithEntries} |`);
  }
  out.push("");
  out.push(`| cohort | baseline n | baseline net % | ${modes.map((m) => `${m} n | ${m} net % | diff pp`).join(" | ")} |`);
  out.push(`|--:|--:|--:|${modes.map(() => "--:|--:|--:").join("|")}|`);
  for (const r of c.cohorts) {
    out.push(`| ${r.cohort} | ${r.baseline.n} | ${f(r.baseline.net)} | ${modes.map((m) => { const x = r.modes[m]; return x ? `${x.n} | ${f(x.net)} | ${f(x.diff)}` : "- | - | -"; }).join(" | ")} |`);
  }
  return out.join("\n");
}

export function calibrationMarkdown(cal: { buckets: CalibrationBucket[]; monotonic: boolean | null }, minN = 20): string {
  const out = ["| final score at entry | baseline positions | win | avg net % |", "|---|--:|--:|--:|"];
  for (const b of cal.buckets) out.push(`| ${b.bucket} | ${b.n} | ${b.win === null ? "-" : (b.win * 100).toFixed(0) + "%"} | ${f(b.net)} |`);
  out.push("");
  out.push(
    cal.monotonic === null
      ? `Not enough scored buckets with n >= ${minN} to judge the calibration yet.`
      : cal.monotonic
        ? "Higher score buckets did better in this session (monotonic). Needs to hold across many sessions."
        : "**Not monotonic**: higher scores did not consistently do better here — the score is not (yet) meaningful; do not trust signals before calibration (blueprint 18.2).",
  );
  return out.join("\n");
}

export function reconciliationMarkdown(db: Db, dataSessionId: string): string {
  const rows = db.all<{ pool: string; name: string | null; reference: string; api_fee_usd: number | null; accum_fee_usd: number | null; accum_diff_pct: number | null; census_fee_usd: number | null; census_diff_pct: number | null; passed: number | null; window_from: number; window_to: number }>(
    `SELECT r.*, p.name FROM reconcile_results r LEFT JOIN pools p USING(pool) WHERE r.session_id = ? ORDER BY r.created_at DESC`,
    dataSessionId,
  );
  if (!rows.length) return "No reconciliation stored for this data session yet (run `dlmm reconcile -s <session> [--census]`).";
  const seen = new Set<string>();
  const latest = rows.filter((r) => (seen.has(r.pool + r.reference) ? false : (seen.add(r.pool + r.reference), true)));
  const passed = latest.filter((r) => r.passed === 1).length;
  const out = [
    `Window ${new Date(latest[0].window_from).toISOString()} → ${new Date(latest[0].window_to).toISOString()}. **${passed}/${latest.filter((r) => r.passed !== null).length} pools within tolerance.** API 5m buckets under-report on some pools; the on-chain census is the ground truth when present.`,
    "",
    "| pool | reference | API fee $ | simulator (accumulator) $ | diff vs ref | chain census $ | result |",
    "|---|---|--:|--:|--:|--:|---|",
  ];
  for (const r of latest) {
    const diff = r.reference === "census" ? r.census_diff_pct : r.accum_diff_pct;
    out.push(`| ${r.name ?? r.pool.slice(0, 8)} | ${r.reference} | ${f(r.api_fee_usd, 2)} | ${f(r.accum_fee_usd, 2)} | ${diff === null ? "-" : (diff >= 0 ? "+" : "") + diff.toFixed(2) + "%"} | ${f(r.census_fee_usd, 2)} | ${r.passed === null ? "n/a" : r.passed ? "PASS" : "FAIL"} |`);
  }
  return out.join("\n");
}

export interface GroupRow {
  group: string;
  /** closed positions incl. gap-tainted ones (the other columns use clean positions only) */
  nAll: number;
  n: number;
  pools: number;
  win: number | null;
  net: number | null;
  totalUsd: number | null;
  fee: number | null;
  cost: number | null;
  partial: number;
}

export interface SelectionRow {
  selector: string;
  /** baseline positions in the (pool, cohort) pairs the selector entered */
  selectedN: number;
  selectedNet: number | null;
  /** all baseline positions of the same cohorts */
  allN: number;
  allNet: number | null;
  diff: number | null;
}

/**
 * Addendum 2.4: the three groups side by side — all_pools_baseline, meridian_preset and our
 * signal modes — plus the pool-selection effect: baseline positions (identical grid) in the pools a
 * selector picked vs in all pools of the same cohorts, which separates pool choice from strategy.
 * Only clean (not gap-tainted) closed positions count.
 */
export function groupComparison(db: Db, sessionIds: string[]): { groups: GroupRow[]; selection: SelectionRow[] } {
  const ph = sessionIds.map(() => "?").join(",");
  const clean = (x: string) => `CASE WHEN p.gap_tainted = 0 THEN ${x} END`;
  const groups = db.all<GroupRow>(
    `SELECT p.entry_mode "group", COUNT(*) nAll, SUM(p.gap_tainted = 0) n, COUNT(DISTINCT ${clean("p.pool")}) pools,
       AVG(${clean("r.net_pnl_usd > 0")}) win, AVG(${clean("r.net_pnl_pct")}) net, SUM(${clean("r.net_pnl_usd")}) totalUsd,
       AVG(${clean("r.fee_usd")}) fee, AVG(${clean("r.cost_usd")}) cost,
       SUM(COALESCE(json_extract(p.grid_combo,'$.preset_partial'),0)) partial
     FROM sim_positions p JOIN sim_results r USING(position_id)
     WHERE p.session_id IN (${ph}) AND p.status = 'closed'
     GROUP BY p.entry_mode
     ORDER BY CASE p.entry_mode WHEN 'all_pools_baseline' THEN 0 WHEN 'meridian_preset' THEN 1 ELSE 2 END, p.entry_mode`,
    ...sessionIds,
  );
  const selection: SelectionRow[] = [];
  const cohortExpr = "CAST(json_extract(p.grid_combo,'$.cohort') AS INT)";
  for (const sel of groups.map((g) => g.group).filter((g) => g !== "all_pools_baseline")) {
    const r = db.get<{ sn: number; snet: number | null; an: number; anet: number | null }>(
      `WITH picked AS (SELECT DISTINCT p.session_id sid, p.pool, ${cohortExpr} cohort FROM sim_positions p
                       WHERE p.session_id IN (${ph}) AND p.entry_mode = ?),
            base AS (SELECT p.session_id sid, p.pool, ${cohortExpr} cohort, r.net_pnl_pct net FROM sim_positions p JOIN sim_results r USING(position_id)
                     WHERE p.session_id IN (${ph}) AND p.entry_mode = 'all_pools_baseline' AND p.status = 'closed' AND p.gap_tainted = 0)
       SELECT (SELECT COUNT(*) FROM base b JOIN picked k USING(sid, pool, cohort)) sn,
              (SELECT AVG(b.net) FROM base b JOIN picked k USING(sid, pool, cohort)) snet,
              (SELECT COUNT(*) FROM base b WHERE (b.sid, b.cohort) IN (SELECT sid, cohort FROM picked)) an,
              (SELECT AVG(b.net) FROM base b WHERE (b.sid, b.cohort) IN (SELECT sid, cohort FROM picked)) anet`,
      ...sessionIds, sel, ...sessionIds,
    )!;
    selection.push({
      selector: sel, selectedN: r.sn, selectedNet: r.snet, allN: r.an, allNet: r.anet,
      diff: r.snet !== null && r.anet !== null ? r.snet - r.anet : null,
    });
  }
  return { groups, selection };
}

export function groupComparisonMarkdown(g: { groups: GroupRow[]; selection: SelectionRow[] }): string {
  if (!g.groups.length) return "No closed positions.";
  const out: string[] = [];
  out.push("| group | closed (incl. tainted) | clean | pools | win | avg net % | total net $ | avg fee $ | avg cost $ | preset_parsial |\n|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const r of g.groups) {
    out.push(`| ${r.group} | ${r.nAll} | ${r.n} | ${r.pools} | ${r.win === null ? "-" : `${(r.win * 100).toFixed(0)}%`} | ${f(r.net)} | ${f(r.totalUsd, 2)} | ${f(r.fee, 2)} | ${f(r.cost, 2)} | ${r.group === "meridian_preset" ? r.partial : "-"} |`);
  }
  out.push("");
  out.push("Statistics use clean positions only (no data gap during the position).");
  out.push("");
  out.push("Each group uses its own strategies (meridian_preset: one fixed preset; baseline and signal modes: the grid sample), so the table above mixes pool choice and strategy. The pool-selection effect below compares **identical baseline grid positions** in the pools a group picked vs in all pools of the same cohorts:");
  out.push("");
  if (g.selection.length) {
    out.push("| selector | baseline positions in picked pools | avg net % | baseline positions (same cohorts) | avg net % | difference (pp) |\n|---|--:|--:|--:|--:|--:|");
    for (const s of g.selection) out.push(`| ${s.selector} | ${s.selectedN} | ${f(s.selectedNet)} | ${s.allN} | ${f(s.allNet)} | ${f(s.diff)} |`);
  } else out.push("No selector entries (meridian_preset / signal modes) in these sessions.");
  if (g.groups.some((r) => r.group === "meridian_preset" && r.partial > 0)) {
    out.push("");
    out.push("meridian_preset ran as **preset_parsial**: organic score and bot-holder filters need the Jupiter audit (phase 10) and were skipped.");
  }
  return out.join("\n");
}
