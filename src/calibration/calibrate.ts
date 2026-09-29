import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { LoadedConfig } from "../config/load.ts";
import { loadConfig } from "../config/load.ts";
import { MODULES, type ModuleName, type PoolCategory } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import { registerConfigVersion } from "../db/repo.ts";
import { markdownToHtml } from "../report/html.ts";
import { buildDataset, type Observation } from "./dataset.ts";
import { evaluate, fitWeights, type Evaluation, type Weights } from "./fit.ts";

export interface CategoryResult {
  category: PoolCategory;
  observations: number;
  trainSessions: number;
  holdoutSessions: number;
  current: Weights;
  candidate: Weights;
  folds: { testSession: string; n: number; current: Evaluation; candidate: Evaluation }[];
  walkForward: { folds: number; meanSpearmanGain: number | null; meanUpliftGain: number | null; foldsWon: number };
  holdout: { current: Evaluation; candidate: Evaluation } | null;
  accepted: boolean;
  reasons: string[];
}

export interface CalibrationResult {
  status: "insufficient_data" | "evaluated";
  dataSessions: number;
  observations: number;
  categories: CategoryResult[];
  accepted: boolean;
  newConfigPath: string | null;
  newConfigVersion: string | null;
  reportPath: string;
  notes: string[];
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(d));
const wstr = (w: Weights) => (Object.entries(w) as [string, number][]).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(", ") || "-";

function currentWeights(lc: LoadedConfig, cat: PoolCategory): Weights {
  const c = lc.config;
  const base = c.scoring.weights[c.weights_profile][cat];
  const w: Weights = {};
  for (const m of MODULES) if (c.scoring.modules[m] && base[m] > 0) w[m] = base[m];
  return w;
}

/**
 * Weight calibration with walk-forward validation and a holdout (blueprint 18.2). A new
 * config_version is written only when the candidate beats the current weights in walk-forward
 * and on the holdout, and its selected pools still beat the average pool (baseline).
 */
export function calibrate(db: Db, lc: LoadedConfig, o: { force?: boolean; write?: boolean; outDir?: string; now?: number; source?: "sim" | "real_lp" } = {}): CalibrationResult {
  const c = lc.config;
  const k = c.calibration;
  const ds = buildDataset(db, c, o.source ?? "sim");
  const sessions = ds.dataSessions.map((s) => s.id);
  const holdoutIds = new Set(k.holdout_sessions > 0 ? sessions.slice(-k.holdout_sessions) : []);
  const trainIds = sessions.filter((s) => !holdoutIds.has(s));
  const notes: string[] = [];
  if (ds.skippedSimSessions.length) notes.push(`${ds.skippedSimSessions.length} older simulation run(s) over the same data ignored (same evidence).`);
  const insufficient = sessions.length < k.min_sessions;
  if (insufficient) notes.push(`Only ${sessions.length} distinct data sessions (need ${k.min_sessions}).`);

  const categories: CategoryResult[] = [];
  for (const cat of ["memecoin", "bluechip"] as PoolCategory[]) {
    const obs = ds.observations.filter((x) => x.category === cat);
    const current = currentWeights(lc, cat);
    const modules = MODULES.filter((m) => c.scoring.modules[m] && obs.some((x) => x.scores[m] !== null)) as ModuleName[];
    const reasons: string[] = [];
    const byS = (ids: string[]) => obs.filter((x) => ids.includes(x.dataSession));
    const trainObs = byS(trainIds);
    const holdObs = obs.filter((x) => holdoutIds.has(x.dataSession));
    if (obs.length < k.min_observations) reasons.push(`${obs.length} observations (need ${k.min_observations})`);
    if (!modules.length) reasons.push("no module scores in the data");
    // walk-forward over the training sessions
    const folds: CategoryResult["folds"] = [];
    for (let i = Math.max(1, k.min_train_sessions); i < trainIds.length; i++) {
      const fitObs = byS(trainIds.slice(0, i));
      const testObs = byS([trainIds[i]]);
      if (fitObs.length < 5 || testObs.length < 3 || !modules.length) continue;
      const cand = fitWeights(fitObs, modules, k.ridge_lambda, k.missing_score).weights;
      folds.push({
        testSession: trainIds[i], n: testObs.length,
        current: evaluate(testObs, current, k.selection_top_pct, k.missing_score),
        candidate: evaluate(testObs, cand, k.selection_top_pct, k.missing_score),
      });
    }
    const sg = folds.map((x) => (x.candidate.spearman ?? 0) - (x.current.spearman ?? 0));
    const ug = folds.map((x) => (x.candidate.uplift ?? 0) - (x.current.uplift ?? 0));
    const walkForward = { folds: folds.length, meanSpearmanGain: mean(sg), meanUpliftGain: mean(ug), foldsWon: sg.filter((x) => x > 0).length };
    const candidate = modules.length && trainObs.length >= 5 ? fitWeights(trainObs, modules, k.ridge_lambda, k.missing_score).weights : {};
    const holdout = holdObs.length
      ? { current: evaluate(holdObs, current, k.selection_top_pct, k.missing_score), candidate: evaluate(holdObs, candidate, k.selection_top_pct, k.missing_score) }
      : null;
    if (!folds.length) reasons.push("no walk-forward fold (need more training sessions)");
    else if ((walkForward.meanSpearmanGain ?? -1) < k.min_spearman_gain) reasons.push(`walk-forward: candidate not better (mean Spearman gain ${f(walkForward.meanSpearmanGain)})`);
    if (!holdout) reasons.push("no holdout data");
    else {
      if ((holdout.candidate.spearman ?? -1) < (holdout.current.spearman ?? -1) + k.min_spearman_gain) reasons.push(`holdout: Spearman ${f(holdout.candidate.spearman)} not above current ${f(holdout.current.spearman)}`);
      if ((holdout.candidate.uplift ?? -1) <= 0) reasons.push(`holdout: selected pools do not beat the average pool (uplift ${f(holdout.candidate.uplift)} pp)`);
      if ((holdout.candidate.uplift ?? -1) < (holdout.current.uplift ?? -1)) reasons.push("holdout: uplift below the current weights");
    }
    if (insufficient && !o.force) reasons.push("insufficient sessions");
    categories.push({
      category: cat, observations: obs.length, trainSessions: trainIds.length, holdoutSessions: holdoutIds.size, current, candidate,
      folds, walkForward, holdout, accepted: reasons.length === 0, reasons,
    });
  }

  const accepted = categories.some((x) => x.accepted);
  let newConfigPath: string | null = null;
  let newConfigVersion: string | null = null;
  const now = o.now ?? Date.now();
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  // never write weights learned from too few sessions, even when the evaluation was forced
  if (accepted && o.write && !insufficient) {
    const src = o.source ?? "sim";
    const profile = src === "real_lp" ? `cal_real_${stamp}` : `cal_${stamp}`;
    const full = (w: Weights, fallback: Weights) => {
      const src = Object.keys(w).length ? w : fallback;
      return Object.fromEntries(MODULES.map((m) => [m, Math.round((src[m] ?? 0) * 10) / 10]));
    };
    const weights: Record<string, Record<string, number>> = {};
    for (const r of categories) weights[r.category] = full(r.accepted ? r.candidate : r.current, r.current);
    const doc = {
      extends: "default",
      config_label: `${c.config_label}-cal${stamp}`,
      weights_profile: profile,
      scoring: { weights: { [profile]: weights } },
    };
    const dir = resolve("config", "calibrated");
    mkdirSync(dir, { recursive: true });
    newConfigPath = join(dir, `${profile}.yaml`);
    writeFileSync(newConfigPath, `# Calibrated weights (dlmm calibrate, ${new Date(now).toISOString()}).\n# Use with: npm run dlmm -- -c ${newConfigPath.replace(/\\/g, "/")} session start\n` + YAML.stringify(doc));
    const nc = loadConfig(newConfigPath);
    newConfigVersion = registerConfigVersion(db, nc, `calibrated (${src}) from ${sessions.length} data sessions; accepted: ${categories.filter((x) => x.accepted).map((x) => x.category).join(", ")}`);
  }

  // report
  const md: string[] = [`# Calibration report`, "", `Generated ${new Date(now).toISOString()} with config \`${lc.configVersion}\`.`, ""];
  md.push(`- data sessions: ${sessions.length} (training ${trainIds.length}, holdout ${holdoutIds.size}); observations (pool x cohort): ${ds.observations.length}`);
  md.push(`- learning from entry modes: ${k.entry_modes.join(", ")}; gap-tainted positions excluded`);
  for (const n of notes) md.push(`- ${n}`);
  md.push("");
  md.push("| session | start | observations | set |", "|---|---|--:|---|");
  for (const s of ds.dataSessions) md.push(`| \`${s.id.slice(0, 8)}\` | ${new Date(s.start).toISOString().slice(0, 16)} | ${s.observations} | ${holdoutIds.has(s.id) ? "holdout" : "training"} |`);
  for (const r of categories) {
    md.push("", `## ${r.category}`, "");
    md.push(`- observations ${r.observations}; current weights: ${wstr(r.current)}`);
    md.push(`- candidate weights (fitted on all training sessions): ${wstr(r.candidate)}`);
    md.push(`- walk-forward: ${r.walkForward.folds} fold(s), mean Spearman gain ${f(r.walkForward.meanSpearmanGain)}, mean uplift gain ${f(r.walkForward.meanUpliftGain)} pp, candidate better in ${r.walkForward.foldsWon}/${r.walkForward.folds}`);
    if (r.folds.length) {
      md.push("", "| test session | n | current Spearman | candidate Spearman | current uplift pp | candidate uplift pp |", "|---|--:|--:|--:|--:|--:|");
      for (const x of r.folds) md.push(`| \`${x.testSession.slice(0, 8)}\` | ${x.n} | ${f(x.current.spearman)} | ${f(x.candidate.spearman)} | ${f(x.current.uplift)} | ${f(x.candidate.uplift)} |`);
    }
    if (r.holdout) {
      md.push("", "| holdout | n | Spearman | top-" + k.selection_top_pct + "% mean net % | all mean net % | uplift pp |", "|---|--:|--:|--:|--:|--:|");
      for (const [name, e] of [["current", r.holdout.current], ["candidate", r.holdout.candidate]] as const) md.push(`| ${name} | ${e.n} | ${f(e.spearman)} | ${f(e.topMean)} | ${f(e.allMean)} | ${f(e.uplift)} |`);
    }
    md.push("", r.accepted ? "**Accepted** — candidate beats the current weights in walk-forward and on the holdout, and its selection beats the average pool." : `**Not accepted:** ${r.reasons.join("; ")}.`);
  }
  if (accepted && insufficient) md.push("", "Evaluation forced with too few sessions: nothing is written.");
  md.push("", accepted && newConfigPath ? `New config written: \`${newConfigPath}\` (config_version \`${newConfigVersion}\`).` : accepted ? "Accepted, but not written (run with --write)." : "No new config_version: the current weights stay.");
  md.push("", "> Calibration repeats periodically (e.g. monthly); markets change. Keep the holdout honest: never pick weights by looking at it.");
  const dir = resolve(o.outDir ?? "reports");
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `calibration-${stamp}.md`);
  const text = md.join("\n") + "\n";
  writeFileSync(reportPath, text);
  writeFileSync(reportPath.replace(/\.md$/, ".html"), markdownToHtml(text, "Calibration report"));
  return {
    status: insufficient ? "insufficient_data" : "evaluated", dataSessions: sessions.length, observations: ds.observations.length,
    categories, accepted, newConfigPath, newConfigVersion, reportPath, notes,
  };
}

export type { Observation };
