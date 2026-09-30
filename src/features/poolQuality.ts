import type { Config } from "../config/schema.ts";
import type { BinSnapshot } from "../collectors/types.ts";
import type { PricePoint } from "./tracker.ts";

const MIN_MS = 60_000;

/**
 * Last price of every 1-minute bucket in (t - windowMs, t], oldest first. The state feed runs every
 * few seconds, so returns between raw points would change with the sampling rate; one close per
 * minute makes the volatility below a per-minute figure that does not depend on it.
 */
function minuteCloses(prices: readonly PricePoint[], t: number, windowMs: number): number[] {
  const byMinute = new Map<number, number>();
  for (const p of prices) if (p.ts > t - windowMs && p.ts <= t && p.price > 0) byMinute.set(Math.floor(p.ts / MIN_MS), p.price);
  return [...byMinute].sort((a, b) => a[0] - b[0]).map(([, price]) => price);
}

/**
 * Realized price volatility over a window: stddev of 1-minute log returns, as a percentage per
 * minute. Our own measure. Meridian's `maxVolatility` is the `volatility` field of Meteora's
 * pool-discovery API (a different, undocumented unit: 0 for a parked pool, about 4 for a moving
 * one at timeframe 5m), so the two numbers are not comparable. null with fewer than 3 minute
 * closes (2 returns).
 */
export function realizedVolatilityPct(prices: readonly PricePoint[], t: number, windowMs: number): number | null {
  const closes = minuteCloses(prices, t, windowMs);
  if (closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * 100;
}

/** Signed price change over a window, % (first to last point in (t - windowMs, t]). null with < 2 points. */
export function priceChangePct(prices: readonly PricePoint[], t: number, windowMs: number): number | null {
  const win = prices.filter((p) => p.ts > t - windowMs && p.ts <= t).map((p) => p.price);
  if (win.length < 2 || win[0] <= 0) return null;
  return ((win[win.length - 1] - win[0]) / win[0]) * 100;
}

/**
 * Share of bins in [lower, upper] holding non-zero supply at the latest snapshot (Mantis and Prism
 * `MIN_BIN_UTILIZATION`): low values mean liquidity clumped into a narrow band, which breaks the
 * uniform-distribution assumption of a wide-range IL model. null without a snapshot.
 */
export function binUtilization(snap: BinSnapshot | null): number | null {
  if (!snap || snap.upper < snap.lower) return null;
  return snap.bins.size / (snap.upper - snap.lower + 1);
}

export interface VolumeAuthenticityInputs {
  tvlUsd: number | null;
  volume24hUsd: number | null;
  /** fee and volume of the SAME recent window (here 1 h); both needed for the fee-rate check */
  fee1hUsd: number | null;
  volume1hUsd: number | null;
}

export interface VolumeAuthenticity {
  score: number;
  flags: string[];
}

/**
 * Wash-trading score, 1 (looks organic) down to 0, as in irfndi/prism-liquidity-agent's
 * `checkVolumeAuthenticity` (engine/strategy-service.ts; Mantis has the older copy): start at 1 and
 * subtract for a 24 h volume / TVL above 5x (elevated) or 10x (suspicious), for a measured
 * fees / volume outside the plausible band, and for near-empty TVL with large volume. TVL of 0
 * scores 0. Unknown TVL or volume gives null, never a made-up 1 (Prism reports such metrics as
 * explicitly unknown and blocks entry on them). The fee-rate check needs measured fees, which we
 * have from the pool's own fee accumulators / API windows, unlike a modeled fee.
 */
export function volumeAuthenticity(x: VolumeAuthenticityInputs, c: Config["simulation"]["volume_authenticity"]): VolumeAuthenticity | null {
  if (x.tvlUsd === null || x.volume24hUsd === null) return null;
  if (x.tvlUsd === 0) return { score: 0, flags: ["zero-tvl"] };
  const flags: string[] = [];
  let score = 1;
  const ratio = x.volume24hUsd / x.tvlUsd;
  if (ratio > c.suspicious_volume_tvl) {
    score -= c.suspicious_penalty;
    flags.push(`vol/tvl=${ratio.toFixed(1)}x (suspicious)`);
  } else if (ratio > c.elevated_volume_tvl) {
    score -= c.elevated_penalty;
    flags.push(`vol/tvl=${ratio.toFixed(1)}x (elevated)`);
  }
  if (x.fee1hUsd !== null && x.volume1hUsd !== null && x.volume1hUsd > 0) {
    const feeRate = x.fee1hUsd / x.volume1hUsd;
    if (feeRate < c.fee_rate_min || feeRate > c.fee_rate_max) {
      score -= c.fee_rate_penalty;
      flags.push(`fee-rate=${(feeRate * 100).toFixed(4)}% (outlier)`);
    }
  }
  if (x.tvlUsd < c.wash_tvl_usd && x.volume24hUsd > c.wash_volume_usd) {
    score -= c.wash_penalty;
    flags.push("low-tvl high-volume (possible wash)");
  }
  return { score: Math.max(0, score), flags };
}
