import type { Config } from "../config/schema.ts";
import { binArrayIndex } from "../chain/dlmm.ts";

export type Op = "open" | "close" | "rebalance" | "claim" | "add" | "swap";

export interface CostItem {
  type: string;
  usd: number;
  sol?: number;
  refundable: boolean;
  detail?: Record<string, unknown>;
}

export interface CostContext {
  solUsd: number;
  /** micro-lamports per compute unit at the configured percentile */
  priorityMicroLamports: number | null;
}

/**
 * Execution cost model (blueprint 12.5). All inputs configurable; defaults are slightly
 * pessimistic (failure rate, priority fee floor, slippage margin on top of the pool fee).
 */
export class CostModel {
  constructor(private readonly c: Config["simulation"]["costs"]) {}

  priorityFee(ctx: CostContext): number {
    return Math.max(this.c.priority_fee_floor_micro_lamports, ctx.priorityMicroLamports ?? 0);
  }

  /** Transactions one operation needs for a position of `bins` bins (wide ranges: several). */
  txCount(op: Op, bins = 0): number {
    return op === "swap" || bins <= 0 ? 1 : Math.max(1, Math.ceil(bins / this.c.bins_per_tx));
  }

  /**
   * Base + priority fee of one operation, grossed up for expected failed attempts. Positions wider
   * than `bins_per_tx` need several transactions per operation (addendum 2.2, wide_range).
   */
  txCost(op: Op, ctx: CostContext, bins = 0): CostItem {
    const n = this.txCount(op, bins);
    const sigs = this.c.signatures[op];
    const cu = this.c.compute_units[op];
    const pri = this.priorityFee(ctx);
    const lamports = (n * (sigs * this.c.base_fee_lamports_per_signature + (cu * pri) / 1e6)) / (1 - Math.min(0.9, this.c.tx_failure_rate));
    const sol = lamports / 1e9;
    return { type: `tx_${op}`, sol, usd: sol * ctx.solUsd, refundable: false, detail: { sigs, cu, microLamportsPerCu: pri, txs: n } };
  }

  /** Position account rent: base (70 bins) + 112 bytes per extra bin. Refunded on close (verify). */
  positionRent(bins: number, ctx: CostContext): CostItem {
    const extra = Math.max(0, bins - this.c.position_default_bins);
    const sol = this.c.position_base_rent_sol + (extra * this.c.position_extra_bin_bytes * this.c.rent_lamports_per_byte) / 1e9;
    return { type: "position_rent", sol, usd: sol * ctx.solUsd, refundable: this.c.position_rent_refundable, detail: { bins, extra } };
  }

  /** Bin arrays covering [lower, upper] that are not initialized yet must be created by us. */
  binArrayInit(lower: number, upper: number, missingArrays: number[], ctx: CostContext): CostItem | null {
    const need = new Set<number>();
    const miss = new Set(missingArrays);
    for (let i = binArrayIndex(lower); i <= binArrayIndex(upper); i++) if (miss.has(i)) need.add(i);
    if (!need.size) return null;
    const sol = need.size * this.c.bin_array_init_sol;
    return { type: "bin_array_init", sol, usd: sol * ctx.solUsd, refundable: this.c.bin_array_rent_refundable, detail: { arrays: [...need] } };
  }

  /** Swapping `notionalUsd` at `swapRate` (aggregator quote or pool fee, see PoolSimulator.swapRate) + slippage margin. */
  swapCost(notionalUsd: number, swapRate: number, label = "balancing_swap"): CostItem {
    const rate = swapRate + this.c.slippage_margin_pct / 100;
    return { type: label, usd: Math.abs(notionalUsd) * rate, refundable: false, detail: { notionalUsd, swapRate, slippagePct: this.c.slippage_margin_pct, model: this.c.swap_model } };
  }

  /**
   * Depositing into the active bin with a composition different from the bin's is charged a
   * composition fee (the program swaps the mismatch internally at the pool fee rate).
   */
  compositionFee(activeBinValueUsd: number, depositXFrac: number, binXFrac: number, poolFeeRate: number): CostItem | null {
    const mismatch = Math.abs(depositXFrac - binXFrac);
    if (activeBinValueUsd <= 0 || mismatch <= 0) return null;
    return { type: "composition_fee", usd: activeBinValueUsd * mismatch * poolFeeRate, refundable: false, detail: { mismatch } };
  }
}
