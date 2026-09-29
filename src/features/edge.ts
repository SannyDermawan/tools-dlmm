import type { Config, Sides, Strategy } from "../config/schema.ts";
import { binRawPrice, rawToUiPrice } from "../math/bin.ts";
import { CostModel } from "../sim/costs.ts";
import { distributeFull, xValueFraction, type RangeSpec } from "../sim/distribution.ts";

/** Deterministic PRNG (mulberry32) so a score can be reproduced exactly. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface EdgeInputs {
  binStep: number;
  decimalsX: number;
  decimalsY: number;
  activeId: number;
  priceUi: number;
  quoteUsd: number;
  solUsd: number;
  priorityMicroLamports: number | null;
  feeRateTotal: number;
  /** stdev of 1-minute log returns */
  sigma1m: number;
  /**
   * Measured LP fee yield, USD per USD of liquidity per minute, by |offset| from the active bin
   * (index 0 = active bin, 1..n = neighbours). Volume through a bin scales with its liquidity, so
   * the blueprint's E[volume_bin] * rate * L/(S+L) reduces to yield * L.
   */
  feeYield: number[];
  seed: number;
}

export interface EdgeCandidate {
  strategy: Strategy;
  sides: Sides;
  binsPerSide: number;
}

export interface EdgeResult extends EdgeCandidate {
  feeUsd: number;
  ilUsd: number;
  costUsd: number;
  netUsd: number;
  /** net edge per hour, % of capital */
  edgePerHourPct: number;
  pInRange: number;
  feeIlRatio: number | null;
  binsBelow: number;
  binsAbove: number;
}

const rangeOf = (c: EdgeCandidate): RangeSpec => ({
  strategy: c.strategy, sides: c.sides,
  binsBelow: c.sides === "base_only" ? 0 : c.binsPerSide,
  binsAbove: c.sides === "quote_only" ? 0 : c.binsPerSide,
});

/**
 * Expected net edge of candidate positions over the horizon (blueprint 9.2):
 *   E[fee]  = sum over paths/steps of yield(|bin - active|) * L_v(bin)
 *   E[IL]   = E[value_T - HODL_T]        (GBM paths in bin space, sigma = realized vol)
 *   net     = E[fee] + E[IL] - costs     (open + close, balancing swap, composition fee)
 */
export function estimateEdge(inp: EdgeInputs, candidates: EdgeCandidate[], c: Config): EdgeResult[] {
  const e = c.scoring.edge;
  const steps = Math.max(1, Math.round(e.horizon_minutes));
  const binLog = Math.log(1 + inp.binStep / 10_000);
  const mu = (e.drift_per_hour / 60) - (inp.sigma1m * inp.sigma1m) / 2;
  const rnd = mulberry32(inp.seed);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  // common random numbers: one set of paths (active-bin offsets per step) for all candidates
  const paths: Int32Array[] = [];
  for (let p = 0; p < e.paths; p++) {
    const a = new Int32Array(steps);
    let lp = 0;
    for (let s = 0; s < steps; s++) {
      lp += mu + inp.sigma1m * gauss();
      a[s] = Math.round(lp / binLog);
    }
    paths.push(a);
  }
  const yieldBy = inp.feeYield;
  const maxOff = yieldBy.length - 1;
  const costs = new CostModel(c.simulation.costs);
  const ctx = { solUsd: inp.solUsd, priorityMicroLamports: inp.priorityMicroLamports };
  const cap = e.capital_usd;
  const out: EdgeResult[] = [];

  for (const cand of candidates) {
    const r = rangeOf(cand);
    const xFrac = xValueFraction(r, c.simulation.two_sided_x_value_fraction);
    const xRaw = BigInt(Math.max(0, Math.floor(((cap * xFrac) / (inp.priceUi * inp.quoteUsd)) * 10 ** inp.decimalsX)));
    const yRaw = BigInt(Math.max(0, Math.floor(((cap * (1 - xFrac)) / inp.quoteUsd) * 10 ** inp.decimalsY)));
    const dist = distributeFull(inp.activeId, inp.binStep, r, xRaw, yRaw);
    // our liquidity per absolute bin: value in quote UI units at the bin price, and in USD
    const Lq = new Map<number, number>();
    for (const b of dist) {
      const v = (Number(b.x) * binRawPrice(b.binId, inp.binStep) + Number(b.y)) / 10 ** inp.decimalsY;
      if (v > 0) Lq.set(b.binId, v);
    }
    const lower = Math.min(...Lq.keys());
    const upper = Math.max(...Lq.keys());
    const x0 = Number(xRaw) / 10 ** inp.decimalsX;
    const y0 = Number(yRaw) / 10 ** inp.decimalsY;
    let feeSum = 0;
    let ilSum = 0;
    let inRange = 0;
    for (const path of paths) {
      for (let s = 0; s < steps; s++) {
        const act = inp.activeId + path[s];
        if (act >= lower && act <= upper) inRange++;
        for (let off = -maxOff; off <= maxOff; off++) {
          const l = Lq.get(act + off);
          if (!l) continue;
          feeSum += yieldBy[Math.abs(off)] * l * inp.quoteUsd;
        }
      }
      const aT = inp.activeId + path[steps - 1];
      const pT = rawToUiPrice(binRawPrice(aT, inp.binStep), inp.decimalsX, inp.decimalsY);
      let value = 0;
      for (const [b, l] of Lq) {
        const pb = rawToUiPrice(binRawPrice(b, inp.binStep), inp.decimalsX, inp.decimalsY);
        if (b < aT) value += l; // converted to Y
        else if (b > aT) value += (l / pb) * pT; // still X, valued at the final price
        else value += 0.5 * l + ((0.5 * l) / pb) * pT;
      }
      ilSum += (value - (x0 * pT + y0)) * inp.quoteUsd;
    }
    const N = paths.length;
    const feeUsd = feeSum / N;
    const ilUsd = ilSum / N;
    let costUsd = costs.txCost("open", ctx).usd + costs.txCost("close", ctx).usd;
    if (c.simulation.starting_asset === "quote" && xFrac > 0) costUsd += costs.txCost("swap", ctx).usd + costs.swapCost(cap * xFrac, inp.feeRateTotal).usd;
    if (c.simulation.exit_to === "quote") costUsd += costs.swapCost(cap * 0.5, inp.feeRateTotal).usd;
    const netUsd = feeUsd + ilUsd - costUsd;
    out.push({
      ...cand, binsBelow: r.binsBelow, binsAbove: r.binsAbove,
      feeUsd, ilUsd, costUsd, netUsd,
      edgePerHourPct: (netUsd / cap / (steps / 60)) * 100,
      pInRange: inRange / (N * steps),
      feeIlRatio: ilUsd < 0 ? feeUsd / -ilUsd : null,
    });
  }
  return out;
}
