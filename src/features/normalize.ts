import type { Config } from "../config/schema.ts";
import { FEATURE_SPECS, type RawFeatures } from "./compute.ts";

/** Value at percentile p (0-100) of a sorted array, linear interpolation. */
function quantile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Percentile rank of `v` in `sample` (0-100; ties count half). The reference sample is
 * winsorized at the given percentiles so its outliers collapse into ties at the edges; the
 * evaluated value itself is not clipped (a new extreme still ranks at the top).
 */
export function percentileRank(v: number, sample: number[], winsor: [number, number] = [1, 99]): number {
  if (sample.length === 0) return 50;
  const s = [...sample].sort((a, b) => a - b);
  const lo = quantile(s, winsor[0]);
  const hi = quantile(s, winsor[1]);
  const clip = (x: number) => Math.min(hi, Math.max(lo, x));
  const x = v;
  let less = 0;
  let equal = 0;
  for (const raw of s) {
    const y = clip(raw);
    if (y < x) less++;
    else if (y === x) equal++;
  }
  return ((less + 0.5 * equal) / s.length) * 100;
}

export type NormFeatures = Map<string, number | null>;

const SPEC = new Map(FEATURE_SPECS.map((f) => [f.name, f]));

/**
 * Cross-sectional (vs all monitored pools now) + time-series (vs the pool's own history)
 * percentile ranks, 0-100 with direction applied (100 = good). History only ever contains values
 * of earlier decision times.
 */
export class Normalizer {
  private history = new Map<string, number[]>(); // `${pool}|${feature}` -> raw values

  constructor(private readonly c: Config["scoring"]["normalization"]) {}

  normalize(byPool: Map<string, RawFeatures>): Map<string, NormFeatures> {
    const out = new Map<string, NormFeatures>();
    const cross = new Map<string, number[]>();
    for (const feats of byPool.values())
      for (const [name, v] of feats) {
        if (v.raw === null || !SPEC.get(name)?.direction) continue;
        let a = cross.get(name);
        if (!a) cross.set(name, (a = []));
        a.push(v.raw);
      }
    for (const [pool, feats] of byPool) {
      const n: NormFeatures = new Map();
      for (const [name, v] of feats) {
        const spec = SPEC.get(name);
        if (!spec || spec.direction === 0 || v.raw === null) {
          n.set(name, null);
          continue;
        }
        const cs = percentileRank(v.raw, cross.get(name) ?? [v.raw], this.c.winsor_pct);
        const hist = this.history.get(`${pool}|${name}`) ?? [];
        let val = cs;
        if (hist.length >= this.c.min_history_points) {
          const ts = percentileRank(v.raw, hist, this.c.winsor_pct);
          val = this.c.cross_weight * cs + (1 - this.c.cross_weight) * ts;
        }
        n.set(name, spec.direction === -1 ? 100 - val : val);
      }
      out.set(pool, n);
    }
    // record history after normalizing (a value never ranks against itself)
    for (const [pool, feats] of byPool)
      for (const [name, v] of feats) {
        if (v.raw === null) continue;
        const k = `${pool}|${name}`;
        let h = this.history.get(k);
        if (!h) this.history.set(k, (h = []));
        h.push(v.raw);
        if (h.length > this.c.history_points) h.shift();
      }
    return out;
  }
}
