/**
 * DLMM fee rate, per Meteora "DLMM Formulas" and lb_clmm (FEE_PRECISION = 1e9):
 *   base_fee     = base_factor * bin_step * 10 * 10^base_fee_power_factor
 *   variable_fee = ceil( (volatility_accumulator * bin_step)^2 * variable_fee_control / 1e11 )
 *   total_fee    = min(base_fee + variable_fee, MAX_FEE_RATE = 1e8)
 * Rates below are returned as fractions (total / 1e9), e.g. 0.0025 = 0.25%.
 * Protocol takes protocol_share (bps) of the total fee; LPs get the rest.
 */
export const FEE_PRECISION = 1_000_000_000n;
export const MAX_FEE_RATE = 100_000_000n;

export interface FeeParams {
  binStep: number;
  baseFactor: number;
  baseFeePowerFactor: number;
  variableFeeControl: number;
  protocolShare: number; // bps
}

export function baseFeeNumerator(p: FeeParams): bigint {
  return BigInt(p.baseFactor) * BigInt(p.binStep) * 10n * 10n ** BigInt(p.baseFeePowerFactor);
}

export function variableFeeNumerator(p: FeeParams, volatilityAccumulator: number): bigint {
  if (p.variableFeeControl <= 0) return 0n;
  const sq = (BigInt(volatilityAccumulator) * BigInt(p.binStep)) ** 2n;
  return (BigInt(p.variableFeeControl) * sq + 99_999_999_999n) / 100_000_000_000n;
}

export function totalFeeNumerator(p: FeeParams, volatilityAccumulator: number): bigint {
  const t = baseFeeNumerator(p) + variableFeeNumerator(p, volatilityAccumulator);
  return t > MAX_FEE_RATE ? MAX_FEE_RATE : t;
}

export interface FeeRates {
  base: number;
  variable: number;
  total: number;
  /** LP share of the total rate (after protocol share) */
  lp: number;
}

export function feeRates(p: FeeParams, volatilityAccumulator: number): FeeRates {
  const base = Number(baseFeeNumerator(p)) / 1e9;
  const total = Number(totalFeeNumerator(p, volatilityAccumulator)) / 1e9;
  return { base, variable: total - base, total, lp: total * (1 - p.protocolShare / 10_000) };
}
