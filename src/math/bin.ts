/**
 * DLMM bin price math.
 *   raw price (Y lamports per X lamport) of bin i = (1 + bin_step / 10_000) ^ i
 *   UI price (Y per X, whole tokens)            = raw * 10^(decimals_x - decimals_y)
 */
export const BASIS_POINT_MAX = 10_000;
export const Q64 = 2n ** 64n;
export const Q64_NUM = 2 ** 64;

export function binRawPrice(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / BASIS_POINT_MAX, binId);
}

export function rawToUiPrice(raw: number, decimalsX: number, decimalsY: number): number {
  return raw * Math.pow(10, decimalsX - decimalsY);
}

export function uiToRawPrice(ui: number, decimalsX: number, decimalsY: number): number {
  return ui * Math.pow(10, decimalsY - decimalsX);
}

export function binUiPrice(binId: number, binStep: number, decimalsX: number, decimalsY: number): number {
  return rawToUiPrice(binRawPrice(binId, binStep), decimalsX, decimalsY);
}

/** Bin containing a UI price. `round` = floor gives the bin whose price is <= the target. */
export function binIdFromUiPrice(
  price: number,
  binStep: number,
  decimalsX: number,
  decimalsY: number,
  round: "floor" | "ceil" | "nearest" = "floor",
): number {
  const raw = uiToRawPrice(price, decimalsX, decimalsY);
  const id = Math.log(raw) / Math.log(1 + binStep / BASIS_POINT_MAX);
  const eps = 1e-9; // absorb float error when price is exactly a bin price
  if (round === "floor") return Math.floor(id + eps);
  if (round === "ceil") return Math.ceil(id - eps);
  return Math.round(id);
}

/** Q64.64 fixed point (bigint) -> float. */
export function q64ToNumber(q: bigint): number {
  const int = q >> 64n;
  const frac = q & (Q64 - 1n);
  return Number(int) + Number(frac) / Q64_NUM;
}

/** Liquidity of a bin in raw quote units: L = P_raw * x + y (constant within the bin). */
export function binLiquidityRaw(xRaw: number, yRaw: number, rawPrice: number): number {
  return rawPrice * xRaw + yRaw;
}
