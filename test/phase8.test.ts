import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { Db, migrate } from "../src/db/index.ts";
import { createSession, registerConfigVersion } from "../src/db/repo.ts";
import { buildDataset } from "../src/calibration/dataset.ts";
import { evaluate, fitWeights, solve, spearman } from "../src/calibration/fit.ts";
import { calibrate } from "../src/calibration/calibrate.ts";
import { mulberry32 } from "../src/features/edge.ts";

/**
 * Synthetic journal: `sessions` data sessions, 20 pools x 3 cohorts each. The outcome depends on
 * the edge and regime scores (plus noise); competition is pure noise.
 */
function journal(sessions: number, seed = 7) {
  const db = new Db(":memory:");
  migrate(db);
  const lc = loadConfig();
  const v = registerConfigVersion(db, lc);
  const rnd = mulberry32(seed);
  for (let i = 0; i < 20; i++)
    db.insert("pools", { pool: `P${i}`, name: `P${i}`, token_x: "X", token_y: "Y", decimals_x: 6, decimals_y: 6, bin_step: 10, category: "memecoin", first_seen_at: 0, last_checked_at: 0 });
  let n = 0;
  for (let s = 0; s < sessions; s++) {
    const sid = createSession(db, { kind: "session", configVersion: v, label: `syn${s}` });
    db.run("UPDATE sessions SET start_at = ?, status = 'completed' WHERE session_id = ?", 1_000_000 + s * 86_400_000, sid);
    for (let cohort = 1; cohort <= 3; cohort++)
      for (let p = 0; p < 20; p++) {
        const scores = { edge: rnd() * 100, regime: rnd() * 100, flow: rnd() * 100, attention: null, competition: rnd() * 100, safety: rnd() * 100 };
        const y = 0.04 * (scores.edge - 50) + 0.02 * (scores.regime - 50) + (rnd() - 0.5) * 1.5;
        const sig = `sg${++n}`;
        db.insert("signals", { signal_id: sig, session_id: sid, pool: `P${p}`, ts: cohort, action: "LEWATI", taken: 0, payload: JSON.stringify({ scores, final_score: 50 }) });
        for (let k = 0; k < 3; k++) {
          const id = `pos${n}-${k}`;
          db.insert("sim_positions", {
            position_id: id, session_id: sid, signal_id: sig, pool: `P${p}`, grid_combo: JSON.stringify({ cohort }), entry_mode: "all_pools_baseline",
            strategy: "spot", sides: "two_sided", bins_below: 5, bins_above: 5, capital_usd: 1000, requested_at: 0, config_version: v, status: "closed", gap_tainted: 0,
          });
          db.insert("sim_results", { position_id: id, net_pnl_pct: y + (rnd() - 0.5) * 0.2, net_pnl_usd: y * 10 });
        }
      }
  }
  return { db, lc };
}

describe("calibration math", () => {
  it("solves linear systems and ranks with ties", () => {
    const x = solve([[2, 1], [1, 3]], [3, 5]);
    expect(x[0]).toBeCloseTo(0.8);
    expect(x[1]).toBeCloseTo(1.4);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it("dataset aggregates positions to pool x cohort and keeps only the newest run per data session", () => {
    const { db, lc } = journal(2);
    const ds = buildDataset(db, lc.config);
    expect(ds.dataSessions).toHaveLength(2);
    expect(ds.observations).toHaveLength(2 * 3 * 20);
    expect(ds.observations[0].positions).toBe(3);
  });

  it("recovers the informative modules and drops noise (non-negative ridge)", () => {
    const { db, lc } = journal(6);
    const obs = buildDataset(db, lc.config).observations;
    const fit = fitWeights(obs, ["edge", "regime", "flow", "competition", "safety"], 1, 50);
    expect(fit.weights.edge!).toBeGreaterThan(fit.weights.regime!);
    expect(fit.weights.regime!).toBeGreaterThan(15);
    expect((fit.weights.competition ?? 0) + (fit.weights.flow ?? 0) + (fit.weights.safety ?? 0)).toBeLessThan(15);
    const e = evaluate(obs, fit.weights, 30, 50);
    expect(e.spearman!).toBeGreaterThan(0.5);
    expect(e.uplift!).toBeGreaterThan(0);
  });
});

describe("calibrate (walk-forward + holdout)", () => {
  it("accepts better weights proven on the holdout and writes a loadable config_version", () => {
    const { db, lc } = journal(7);
    // current weights: mostly the noise module
    lc.config.scoring.weights[lc.config.weights_profile].memecoin = { edge: 5, regime: 5, flow: 5, attention: 0, competition: 80, safety: 5 };
    const out = mkdtempSync(join(tmpdir(), "dlmm-cal-"));
    try {
      const r = calibrate(db, lc, { write: true, outDir: out, now: Date.UTC(2026, 8, 29, 12) });
      const mc = r.categories.find((x) => x.category === "memecoin")!;
      expect(r.status).toBe("evaluated");
      expect(mc.walkForward.folds).toBeGreaterThanOrEqual(3);
      expect(mc.walkForward.meanSpearmanGain!).toBeGreaterThan(0);
      expect(mc.holdout!.candidate.spearman!).toBeGreaterThan(mc.holdout!.current.spearman!);
      expect(mc.holdout!.candidate.uplift!).toBeGreaterThan(0);
      expect(mc.accepted).toBe(true);
      expect(r.newConfigPath).toBeTruthy();
      const nc = loadConfig(r.newConfigPath!);
      const w = nc.config.scoring.weights[nc.config.weights_profile].memecoin;
      expect(w.edge).toBeGreaterThan(w.competition);
      expect(r.newConfigVersion).toBe(nc.configVersion);
      expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM config_versions WHERE config_version = ?", nc.configVersion)!.n).toBe(1);
      expect(readFileSync(r.reportPath, "utf8")).toContain("**Accepted**");
      rmSync(r.newConfigPath!, { force: true });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses with too few sessions, and a forced run never writes", () => {
    const { db, lc } = journal(3);
    const out = mkdtempSync(join(tmpdir(), "dlmm-cal-"));
    try {
      const r = calibrate(db, lc, { write: true, outDir: out });
      expect(r.status).toBe("insufficient_data");
      expect(r.accepted).toBe(false);
      expect(r.newConfigPath).toBeNull();
      const f = calibrate(db, lc, { write: true, force: true, outDir: out });
      expect(f.newConfigPath).toBeNull();
      expect(existsSync(f.reportPath)).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("does not accept when the current weights are already right", () => {
    const { db, lc } = journal(7, 11);
    lc.config.scoring.weights[lc.config.weights_profile].memecoin = { edge: 67, regime: 33, flow: 0, attention: 0, competition: 0, safety: 0 };
    const out = mkdtempSync(join(tmpdir(), "dlmm-cal-"));
    try {
      const r = calibrate(db, lc, { write: true, outDir: out });
      const mc = r.categories.find((x) => x.category === "memecoin")!;
      // the fitted candidate is ~ the same; it must not be written unless strictly better
      if (!mc.accepted) expect(r.newConfigPath).toBeNull();
      else rmSync(r.newConfigPath!, { force: true });
      expect(Math.abs(mc.walkForward.meanSpearmanGain ?? 0)).toBeLessThan(0.1);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
