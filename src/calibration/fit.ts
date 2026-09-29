import type { ModuleName } from "../config/schema.ts";
import type { Observation } from "./dataset.ts";

export type Weights = Partial<Record<ModuleName, number>>;

/** Solve A x = b (small dense system, Gaussian elimination with partial pivoting). */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

export interface FitResult {
  weights: Weights; // sum 100 over the fitted modules
  coef: Record<string, number>; // standardized coefficients before clipping
  modules: ModuleName[];
  n: number;
}

/**
 * Candidate weights (blueprint 18.2): ridge regression of the net PnL % on the standardized
 * module scores, with non-negativity (a module whose effect is negative is dropped and the model
 * refit), then rescaled to sum to 100. Weights are proportional to each module's contribution per
 * score point.
 */
export function fitWeights(obs: Observation[], modules: ModuleName[], lambda: number, missing: number): FitResult {
  let active = [...modules];
  let coef: Record<string, number> = {};
  const y = obs.map((o) => o.y);
  const ym = y.reduce((s, v) => s + v, 0) / Math.max(1, y.length);
  for (let iter = 0; iter < modules.length; iter++) {
    if (!active.length) break;
    const X = obs.map((o) => active.map((m) => o.scores[m] ?? missing));
    const mu = active.map((_, j) => X.reduce((s, r) => s + r[j], 0) / X.length);
    const sd = active.map((_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mu[j]) ** 2, 0) / Math.max(1, X.length - 1)) || 1);
    const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
    const k = active.length;
    const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? lambda : 0)));
    const b = Array.from({ length: k }, (_, i) => Z.reduce((s, r, n) => s + r[i] * (y[n] - ym), 0));
    const beta = solve(A, b);
    // back to "per score point" to compare modules on the same 0-100 scale
    coef = Object.fromEntries(active.map((m, j) => [m, beta[j] / sd[j]]));
    const neg = active.filter((m) => coef[m] <= 0);
    if (!neg.length) break;
    active = active.filter((m) => coef[m] > 0);
  }
  const pos = active.filter((m) => (coef[m] ?? 0) > 0);
  const sum = pos.reduce((s, m) => s + coef[m], 0);
  const weights: Weights = {};
  for (const m of pos) weights[m] = sum > 0 ? (coef[m] / sum) * 100 : 0;
  return { weights, coef, modules: pos, n: obs.length };
}

/** Score of an observation under a weight set (same formula as the scorer: weighted mean of the modules present). */
export function scoreWith(o: Observation, w: Weights, missing: number): number {
  let s = 0;
  let tw = 0;
  for (const [m, wt] of Object.entries(w) as [ModuleName, number][]) {
    if (!wt) continue;
    s += wt * (o.scores[m] ?? missing);
    tw += wt;
  }
  return tw > 0 ? s / tw : missing;
}

export function spearman(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(n);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

export interface Evaluation {
  n: number;
  spearman: number | null;
  /** mean y of the top X% by score minus mean y of all (the "signal beats baseline" measure) */
  uplift: number | null;
  topMean: number | null;
  allMean: number | null;
}

export function evaluate(obs: Observation[], w: Weights, topPct: number, missing: number): Evaluation {
  if (!obs.length) return { n: 0, spearman: null, uplift: null, topMean: null, allMean: null };
  const scored = obs.map((o) => ({ s: scoreWith(o, w, missing), y: o.y }));
  const all = scored.reduce((a, x) => a + x.y, 0) / scored.length;
  const k = Math.max(1, Math.round((scored.length * topPct) / 100));
  const top = [...scored].sort((a, b) => b.s - a.s).slice(0, k);
  const topMean = top.reduce((a, x) => a + x.y, 0) / top.length;
  return { n: obs.length, spearman: spearman(scored.map((x) => x.s), scored.map((x) => x.y)), uplift: topMean - all, topMean, allMean: all };
}
