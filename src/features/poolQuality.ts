import type { Config } from "../config/schema.ts";
import type { BinSnapshot } from "../collectors/types.ts";
import type { PricePoint } from "./tracker.ts";

/**
 * Realized price volatility over a window (Meridian preset `max_volatility`, addendum): stddev of
 * log returns between consecutive price points in (t - windowMs, t], as a percentage. This is our
 * own proxy, not a port of any upstream `maxVolatility` field (their exact units are undocumented).
 * null when fewer than 3 points fall in the window (2 returns).
 */
export function realizedVolatilityPct(prices: readonly PricePoint[], t: number, windowMs: number): number | null {
  const win = prices.filter((p) => p.ts > t - windowMs && p.ts <= t).map((p) => p.price);
  if (win.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < win.length; i++) if (win[i - 1] > 0 && win[i] > 0) rets.push(Math.log(win[i] / win[i - 1]));
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * 100;
}

/** |price change| over a window, % (Meridian preset `max_price_change_pct`). null with < 2 points. */
export function priceChangePct(prices: readonly PricePoint[], t: number, windowMs: number): number | null {
  const win = prices.filter((p) => p.ts > t - windowMs && p.ts <= t).map((p) => p.price);
  if (win.length < 2 || win[0] <= 0) return null;
  return ((win[win.length - 1] - win[0]) / win[0]) * 100;
}

/**
 * Share of bins in [lower, upper] holding non-zero supply at the latest snapshot (Mantis
 * MIN_BIN_UTILIZATION): low values mean liquidity clumped into a narrow band, which breaks the
 * uniform-distribution assumption a Spot/wide-range IL model relies on. null without a snapshot.
 */
export function binUtilization(snap: BinSnapshot | null): number | null {
  if (!snap || snap.upper < snap.lower) return null;
  return snap.bins.size / (snap.upper - snap.lower + 1);
}

export interface VolumeAuthenticityInputs {
  tvlUsd: number | null;
  volumeUsd: number | null; // over some recent window (e.g. 1h)
  feeRatePct: number | null; // pool fee rate, % (base + variable)
}

/**
 * Wash-trading score 0 (fabricated-looking) to 1 (looks organic) — prism-liquidity-agent /
 * DeltaLogicLabs Mantis's "volume authenticity": penalizes a volume/TVL ratio that is too high,
 * a fee rate outside a plausible band, and high volume on thin TVL. Missing inputs are treated as
 * neutral (that check does not penalize) so the score never fails closed on absent data alone.
 * 1.0 with everything missing (nothing to flag on) down to 0.0 with every check failing.
 */
export function volumeAuthenticity(x: VolumeAuthenticityInputs, c: Config["simulation"]["volume_authenticity"]): number {
  const checks: boolean[] = []; // true = passes that check
  if (x.tvlUsd !== null && x.volumeUsd !== null && x.tvlUsd > 0) {
    checks.push(x.volumeUsd / x.tvlUsd <= c.max_volume_tvl_ratio);
    if (x.tvlUsd < c.low_tvl_usd) checks.push(x.volumeUsd / x.tvlUsd <= c.low_tvl_volume_tvl_ratio);
  }
  if (x.feeRatePct !== null) checks.push(x.feeRatePct >= c.fee_rate_min_pct && x.feeRatePct <= c.fee_rate_max_pct);
  if (!checks.length) return 1;
  return checks.filter(Boolean).length / checks.length;
}
