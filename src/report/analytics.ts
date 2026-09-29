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
     ORDER BY CASE p.entry_mode WHEN 'all_pools_baseline' THEN 0 WHEN 'meridian_preset' THEN 1 WHEN 'friday_scalp' THEN 2 WHEN 'yunus_flip' THEN 3 ELSE 4 END, p.entry_mode`,
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
    out.push(`| ${r.group} | ${r.nAll} | ${r.n} | ${r.pools} | ${r.win === null ? "-" : `${(r.win * 100).toFixed(0)}%`} | ${f(r.net)} | ${f(r.totalUsd, 2)} | ${f(r.fee, 2)} | ${f(r.cost, 2)} | ${r.group === "meridian_preset" || r.group === "friday_scalp" ? r.partial : "-"} |`);
  }
  out.push("");
  out.push("Statistics use clean positions only (no data gap during the position).");
  out.push("");
  out.push("Each group uses its own strategies (meridian_preset / friday_scalp / yunus_flip: one fixed preset each; baseline and signal modes: the grid sample), so the table above mixes pool choice and strategy. The pool-selection effect below compares **identical baseline grid positions** in the pools a group picked vs in all pools of the same cohorts:");
  out.push("");
  if (g.selection.length) {
    out.push("| selector | baseline positions in picked pools | avg net % | baseline positions (same cohorts) | avg net % | difference (pp) |\n|---|--:|--:|--:|--:|--:|");
    for (const s of g.selection) out.push(`| ${s.selector} | ${s.selectedN} | ${f(s.selectedNet)} | ${s.allN} | ${f(s.allNet)} | ${f(s.diff)} |`);
  } else out.push("No selector entries (meridian_preset / friday_scalp / yunus_flip / signal modes) in these sessions.");
  if (g.groups.some((r) => r.group === "meridian_preset" && r.partial > 0)) {
    out.push("");
    out.push("Some meridian_preset positions ran as **preset_parsial**: a filter had no data (organic score / bot holders need the Jupiter audit, phase 10) and was skipped.");
  }
  if (g.groups.some((r) => r.group === "friday_scalp")) {
    out.push("");
    out.push("friday_scalp runs the whole playbook: pool screen, 1-minute flow confirmation at entry, Spot 69 bins, and exits on one flow trigger / time stop / out of range. Positions are flagged **preset_parsial** only when a token flow input (holders, bundlers) was missing at entry.");
  }
  if (g.groups.some((r) => r.group === "yunus_flip")) {
    out.push("");
    out.push("yunus_flip runs the Yunus / EvilPanda flip cycle: a bid-ask quote-only position below the price, held until it is fully converted to the token, then redeployed base-only above. Cycles that were still open at the session end are closed there (censored): read the close reasons and the Yunus section, not only this average.");
  }
  return out.join("\n");
}

/**
 * Phase 10 section (addendum 3): pools removed per safety filter (from the journaled signals),
 * signal modes with vs without the pool cooldown, automatic blocklist entries in the data window,
 * and Jupiter audit coverage.
 */
export function safetyMemoryMarkdown(db: Db, simSessionId: string, dataSessionId: string, from: number, to: number): string {
  const out: string[] = [];
  const f = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "-" : v.toFixed(d));
  const filters = db.all<{ filter: string; pools: number; signals: number }>(
    `SELECT j.value filter, COUNT(DISTINCT s.pool) pools, COUNT(*) signals
     FROM signals s, json_each(json_extract(s.payload, '$.safety_gate.filters')) j
     WHERE s.session_id = ? GROUP BY j.value ORDER BY pools DESC`,
    simSessionId,
  );
  const totalPools = db.get<{ n: number }>("SELECT COUNT(DISTINCT pool) n FROM signals WHERE session_id = ?", simSessionId)?.n ?? 0;
  out.push(`**Pools removed per safety filter** (a pool counts once per filter; one pool can fail several; ${totalPools} pools scored):`);
  out.push("");
  if (filters.length) {
    out.push("| filter | pools | signals vetoed |\n|---|--:|--:|");
    for (const r of filters) out.push(`| ${r.filter} | ${r.pools} | ${r.signals} |`);
  } else out.push("No pool was vetoed by a safety filter (or the session has no signals).");
  out.push("");
  const cd = db.all<{ mode: string; cooldown: number; n: number; win: number | null; net: number | null; total: number | null }>(
    `SELECT p.entry_mode mode, p.cooldown_enabled cooldown, COUNT(*) n, AVG(r.net_pnl_usd > 0) win, AVG(r.net_pnl_pct) net, SUM(r.net_pnl_usd) total
     FROM sim_positions p JOIN sim_results r USING(position_id)
     WHERE p.session_id = ? AND p.status = 'closed' AND p.gap_tainted = 0 AND p.cooldown_enabled IS NOT NULL
     GROUP BY p.entry_mode, p.cooldown_enabled ORDER BY p.entry_mode, p.cooldown_enabled DESC`,
    simSessionId,
  );
  out.push("**Pool cooldown** (signal modes run with and without it on identical combinations; clean positions):");
  out.push("");
  if (cd.length) {
    out.push("| entry mode | cooldown | positions | win | avg net % | total net $ |\n|---|---|--:|--:|--:|--:|");
    for (const r of cd) out.push(`| ${r.mode} | ${r.cooldown ? "on" : "off"} | ${r.n} | ${r.win === null ? "-" : (r.win * 100).toFixed(0) + "%"} | ${f(r.net)} | ${f(r.total)} |`);
  } else out.push("No signal-mode positions in this session.");
  out.push("");
  const rugs = db.all<{ kind: string; key: string; reason: string; added_at: number }>(
    `SELECT 'token' kind, mint key, reason, added_at FROM blocklist_tokens WHERE source = 'auto_rug' AND added_at BETWEEN ? AND ?
     UNION ALL SELECT 'dev', wallet, reason, added_at FROM blocklist_devs WHERE source = 'auto_rug' AND added_at BETWEEN ? AND ?
     ORDER BY added_at`,
    from, to, from, to,
  );
  out.push(`**Automatic blocklist** (rug detection) in the data window: ${rugs.length} entr${rugs.length === 1 ? "y" : "ies"}.`);
  for (const r of rugs) out.push(`- ${new Date(r.added_at).toISOString().slice(0, 16)} ${r.kind} \`${r.key}\` — ${r.reason}`);
  out.push("");
  const au = db.get<{ tokens: number; ok: number; bot: number; organic: number }>(
    `SELECT COUNT(DISTINCT token) tokens, COUNT(DISTINCT CASE WHEN error IS NULL THEN token END) ok,
       COUNT(DISTINCT CASE WHEN bot_holders_pct IS NOT NULL THEN token END) bot, COUNT(DISTINCT CASE WHEN organic_score IS NOT NULL THEN token END) organic
     FROM token_audit WHERE session_id = ?`,
    dataSessionId,
  );
  out.push(au && au.tokens
    ? `Jupiter audit: ${au.ok}/${au.tokens} risk tokens audited, organic score for ${au.organic}, bot holders for ${au.bot} (datapi, unofficial).`
    : "Jupiter audit: no data in this data session (collected from phase 10 sessions on).");
  return out.join("\n");
}

/**
 * Phase 13: indicator entry filters vs no filter, per entry mode (clean closed positions). The
 * filter dimension is part of the balanced grid sample, so each filter level covers comparable
 * combinations; "diff" is the filter's mean net % minus the same mode's "none" mean.
 */
export function entryFilterMarkdown(db: Db, simSessionId: string): string {
  const rows = db.all<{ mode: string; filter: string; n: number; win: number | null; net: number | null }>(
    `SELECT p.entry_mode mode, COALESCE(p.entry_filter, 'none') filter, COUNT(*) n, AVG(r.net_pnl_usd > 0) win, AVG(r.net_pnl_pct) net
     FROM sim_positions p JOIN sim_results r USING(position_id)
     WHERE p.session_id = ? AND p.status = 'closed' AND p.gap_tainted = 0 AND p.entry_mode NOT IN ('meridian_preset', 'friday_scalp', 'yunus_flip')
     GROUP BY p.entry_mode, filter ORDER BY p.entry_mode, filter != 'none', filter`,
    simSessionId,
  );
  if (!rows.some((r) => r.filter !== "none")) return "No indicator entry filter ran in this session (grid.entry_filter).";
  const f = (v: number | null, d = 3) => (v === null ? "-" : v.toFixed(d));
  const out = ["| entry mode | entry filter | positions | win | avg net % | diff vs none (pp) |", "|---|---|--:|--:|--:|--:|"];
  for (const r of rows) {
    const none = rows.find((x) => x.mode === r.mode && x.filter === "none")?.net ?? null;
    out.push(`| ${r.mode} | ${r.filter} | ${r.n} | ${r.win === null ? "-" : (r.win * 100).toFixed(0) + "%"} | ${f(r.net)} | ${r.filter === "none" || none === null || r.net === null ? "-" : f(r.net - none)} |`);
  }
  const notes = db.get<{ notes: string | null }>("SELECT notes FROM sessions WHERE session_id = ?", simSessionId)?.notes;
  try {
    const skips = notes ? (JSON.parse(notes).grid?.filterSkips as Record<string, number> | undefined) : undefined;
    if (skips && Object.keys(skips).length)
      out.push("", `Pool entries skipped by a filter (per pool and cohort): ${Object.entries(skips).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  } catch {
    /* notes without JSON */
  }
  out.push("", "A filter keeps weight only if it beats `none` consistently across sessions (addendum 6.1); one session proves nothing.");
  return out.join("\n");
}

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Tracker PnL vs break-even (Friday's cost guide): the tracker PnL is what the Meteora / LP tracker
 * shows (value + fees - deposit, no transaction or swap costs); the break-even is the cost of the
 * trade in % of capital, so the tracker PnL must beat it for the trade to pay. Per entry mode and
 * per exit policy type (clean closed positions), with the cost split (rent is refunded and is not
 * a cost). `swap` = balancing + exit swaps incl. their price impact; `tax` = token-2022 transfer fee.
 */
export function breakEvenMarkdown(db: Db, simSessionId: string): string {
  const rows = db.all<{ mode: string; exit: string; cap: number; net: number; cost: number; detail: string }>(
    `SELECT p.entry_mode mode, COALESCE(json_extract(p.exit_policy_params,'$.type'), 'hold_to_session_end') exit, p.capital_usd cap,
            r.net_pnl_usd net, r.cost_usd cost, r.detail
     FROM sim_positions p JOIN sim_results r USING(position_id)
     WHERE p.session_id = ? AND p.status = 'closed' AND p.gap_tainted = 0`,
    simSessionId,
  );
  if (!rows.length) return "No closed clean positions.";
  const f = (v: number | null, d = 2) => (v === null ? "-" : v.toFixed(d));
  const groupBy = (key: (r: (typeof rows)[number]) => string, title: string) => {
    const g = new Map<string, typeof rows>();
    for (const r of rows) (g.get(key(r)) ?? g.set(key(r), []).get(key(r))!).push(r);
    const out = [`| ${title} | n | tracker % avg | tracker % median | break-even % avg | break-even % median | tracker > break-even | swap | tx | tax | composition | bin array |`, "|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|"];
    for (const [k, rs] of [...g.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const tracker = rs.map((r) => ((r.net + r.cost) / r.cap) * 100);
      const be = rs.map((r) => (r.cost / r.cap) * 100);
      const parts: Record<string, number> = { swap: 0, tx: 0, tax: 0, composition: 0, bin_array: 0 };
      for (const r of rs)
        for (const c of (JSON.parse(r.detail).costs ?? []) as { type: string; usd: number; refundable: boolean }[]) {
          if (c.refundable) continue;
          const t = c.type.endsWith("swap") && !c.type.startsWith("tx_") ? "swap" : c.type.startsWith("tx_") ? "tx" : c.type === "transfer_tax" ? "tax" : c.type === "composition_fee" ? "composition" : c.type === "bin_array_init" ? "bin_array" : null;
          if (t) parts[t] += c.usd;
        }
      const totalCost = Object.values(parts).reduce((a, b) => a + b, 0) || 1;
      const share = (x: number) => `${((x / totalCost) * 100).toFixed(0)}%`;
      const above = tracker.filter((x, i) => x > be[i]).length / rs.length;
      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
      out.push(`| ${k} | ${rs.length} | ${f(mean(tracker), 3)} | ${f(median(tracker), 3)} | ${f(mean(be), 3)} | ${f(median(be), 3)} | ${(above * 100).toFixed(0)}% | ${share(parts.swap)} | ${share(parts.tx)} | ${share(parts.tax)} | ${share(parts.composition)} | ${share(parts.bin_array)} |`);
    }
    return out.join("\n");
  };
  return [
    groupBy((r) => r.mode, "entry mode"),
    "",
    groupBy((r) => r.exit, "exit policy type"),
    "",
    "The tracker PnL excludes every cost the tracker does not show; a strategy that looks positive on a tracker but below its break-even loses money. Cost shares add up to 100% of the non-refundable cost (position rent is refunded on close).",
  ].join("\n");
}
