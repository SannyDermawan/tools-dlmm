import { Q64_NUM } from "../math/bin.ts";
import type { BinObs } from "../collectors/types.ts";

/**
 * Method A — fee accumulators (default).
 * Each bin stores cumulative LP fee per unit of liquidity, fee_amount_{x,y}_per_token_stored
 * (Q64.64; token raw units per raw quote unit of liquidity share >> 64, as used by the SDK:
 * fee = (share >> 64) * Δfpt >> 64). Between two snapshots, the LP fee paid in a bin is
 *   pool_fee_x = S * Δfpt_x / 2^64            (S = liquidity_supply >> 64, raw quote units)
 * and a virtual position with liquidity L in that bin would have earned
 *   fee_x = L * Δfpt_x / 2^64 * S / (S + L)   (our own dilution included, blueprint 12.3)
 * This is exact for every swap that happened, even if the swap stream missed it.
 */
export function binFeeDelta(prev: BinObs | undefined, curr: BinObs | undefined): { dx: number; dy: number; supply: number } | null {
  if (!prev || !curr) return null;
  const dxb = curr.feeX - prev.feeX;
  const dyb = curr.feeY - prev.feeY;
  if (dxb < 0n || dyb < 0n) return null; // re-initialized bin; skip
  return { dx: Number(dxb) / Q64_NUM, dy: Number(dyb) / Q64_NUM, supply: Number(prev.supply) / Q64_NUM };
}

/** Fee earned by liquidity L (raw quote units) in a bin between two observations. */
export function accumulatorFee(prev: BinObs | undefined, curr: BinObs | undefined, L: number): { fx: number; fy: number } {
  const d = binFeeDelta(prev, curr);
  if (!d || L <= 0) return { fx: 0, fy: 0 };
  const dilution = d.supply > 0 ? d.supply / (d.supply + L) : 0;
  return { fx: L * d.dx * dilution, fy: L * d.dy * dilution };
}

/** Total LP fee paid in all bins between two snapshots (for reconciliation, 100% share). */
export function poolFeeFromAccumulators(prev: Map<number, BinObs>, curr: Map<number, BinObs>): { fx: number; fy: number; bins: number } {
  let fx = 0;
  let fy = 0;
  let bins = 0;
  for (const [id, c] of curr) {
    const d = binFeeDelta(prev.get(id), c);
    if (!d) continue;
    if (d.dx > 0 || d.dy > 0) bins++;
    fx += d.supply * d.dx;
    fy += d.supply * d.dy;
  }
  return { fx, fy, bins };
}

/**
 * Method B — swap events (blueprint 12.3).
 * Spread one swap across the bins it crossed using the latest bin snapshot: every bin between the
 * start and end bin is consumed fully (its output-side reserve), the end bin takes the remainder.
 * Returns the share of the swap's input handled by each bin (sums to 1).
 */
export function allocateSwapAcrossBins(
  swap: { startBin: number; endBin: number; swapForY: boolean; amountIn: number },
  bins: Map<number, BinObs>,
): Map<number, number> {
  const out = new Map<number, number>();
  if (swap.startBin === swap.endBin) {
    out.set(swap.startBin, 1);
    return out;
  }
  const step = swap.swapForY ? -1 : 1; // X in pushes the price down
  const caps: [number, number][] = [];
  let consumed = 0;
  for (let id = swap.startBin; id !== swap.endBin; id += step) {
    const b = bins.get(id);
    if (!b || b.supply === 0n) continue; // empty bins are skipped by the program
    // capacity in input-token units: X in consumes the bin's Y (y / P); Y in consumes X (x * P)
    const cap = swap.swapForY ? Number(b.y) / b.priceRaw : Number(b.x) * b.priceRaw;
    if (cap > 0) {
      caps.push([id, cap]);
      consumed += cap;
    }
  }
  let rest = swap.amountIn - consumed;
  if (rest <= 0) {
    // stale snapshot: crossed bins held more than the swap; scale them and give the end bin
    // an equal share of one average bin
    rest = caps.length ? consumed / caps.length : swap.amountIn;
  }
  const total = consumed + rest;
  for (const [id, cap] of caps) out.set(id, cap / total);
  out.set(swap.endBin, (out.get(swap.endBin) ?? 0) + rest / total);
  return out;
}

/** Virtual share of an LP fee paid in one bin: fee * L / (S_bin + L). */
export function dilutedShare(fee: number, L: number, binSupply: number): number {
  if (L <= 0) return 0;
  return (fee * L) / (binSupply + L);
}
