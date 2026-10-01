import type { Config } from "../config/schema.ts";

/**
 * Market regime of a pool at a moment (strategy-lab roadmap PHASE 6), from deterministic features
 * of one Meteora pool-discovery window: price velocity (price change over the window), volatility
 * (Meteora's unit), and liquidity change (LP net deposits as % of TVL). Three axes are kept apart
 * so each can be analysed on its own; the primary label picks one of the roadmap's eight:
 *
 *   UNSTABLE               |price move| >= unstable_move_pct, or LPs withdrew >= unstable_liquidity_pct of TVL
 *   MOMENTUM_UP / _DOWN    price change >= +momentum_pct / <= -momentum_pct
 *   HIGH_VOLATILITY        no trend, volatility >= vol_high (choppy)
 *   LIQUIDITY_CONTRACTION  no trend, net deposits <= -liquidity_pct of TVL
 *   LIQUIDITY_EXPANSION    no trend, net deposits >= +liquidity_pct of TVL
 *   LOW_VOLATILITY         no trend, volatility <= vol_low (parked)
 *   SIDEWAYS               none of the above
 *
 * The thresholds are starting hypotheses per window (config `regime.thresholds`); the regime is
 * journaled with every position so `dlmm scorecard` shows which strategy works in which regime.
 * Nothing here decides an entry or an exit.
 */

export const REGIME_LABELS = [
  "MOMENTUM_UP", "MOMENTUM_DOWN", "SIDEWAYS", "HIGH_VOLATILITY", "LOW_VOLATILITY", "LIQUIDITY_EXPANSION", "LIQUIDITY_CONTRACTION", "UNSTABLE",
] as const;
export type RegimeLabel = (typeof REGIME_LABELS)[number];

export type RegimeThresholds = Config["regime"]["thresholds"][string];

export interface RegimeInputs {
  timeframe: string;
  priceChangePct: number | null;
  volatility: number | null;
  netDepositsUsd: number | null;
  tvlUsd: number | null;
}

export interface Regime {
  label: RegimeLabel;
  timeframe: string;
  trend: "up" | "down" | "flat" | null;
  volatility: "high" | "normal" | "low" | null;
  liquidity: "expansion" | "stable" | "contraction" | null;
  /** LP net deposits as % of TVL over the window */
  liquidityPct: number | null;
  unstable: boolean;
}

/** null when neither the price change nor the volatility of the window is known. */
export function classifyRegime(x: RegimeInputs, th: RegimeThresholds): Regime | null {
  if (x.priceChangePct === null && x.volatility === null) return null;
  const pc = x.priceChangePct;
  const trend = pc === null ? null : pc >= th.momentum_pct ? "up" : pc <= -th.momentum_pct ? "down" : "flat";
  const v = x.volatility;
  const volatility = v === null ? null : v >= th.vol_high ? "high" : v <= th.vol_low ? "low" : "normal";
  const liquidityPct = x.netDepositsUsd !== null && x.tvlUsd !== null && x.tvlUsd > 0 ? (x.netDepositsUsd / x.tvlUsd) * 100 : null;
  const liquidity = liquidityPct === null ? null : liquidityPct >= th.liquidity_pct ? "expansion" : liquidityPct <= -th.liquidity_pct ? "contraction" : "stable";
  const unstable = (pc !== null && Math.abs(pc) >= th.unstable_move_pct) || (liquidityPct !== null && liquidityPct <= -th.unstable_liquidity_pct);
  const label: RegimeLabel = unstable ? "UNSTABLE"
    : trend === "up" ? "MOMENTUM_UP"
    : trend === "down" ? "MOMENTUM_DOWN"
    : volatility === "high" ? "HIGH_VOLATILITY"
    : liquidity === "contraction" ? "LIQUIDITY_CONTRACTION"
    : liquidity === "expansion" ? "LIQUIDITY_EXPANSION"
    : volatility === "low" ? "LOW_VOLATILITY"
    : "SIDEWAYS";
  return { label, timeframe: x.timeframe, trend, volatility, liquidity, liquidityPct, unstable };
}

/** Thresholds of a window, or null when the config has none for it. */
export function thresholdsFor(c: Config["regime"], timeframe: string): RegimeThresholds | null {
  return c.thresholds[timeframe] ?? null;
}
