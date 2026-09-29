import { EventEmitter } from "node:events";
import type { FeeParams } from "../math/fee.ts";
import type { PoolCategory } from "../config/schema.ts";
import type { StaticParams, VariableParams } from "../chain/dlmm.ts";

export interface PoolMeta {
  pool: string;
  name: string;
  tokenX: string;
  tokenY: string;
  symbolX: string;
  symbolY: string;
  decimalsX: number;
  decimalsY: number;
  binStep: number;
  category: PoolCategory;
  reserveX: string;
  reserveY: string;
  collectFeeMode: number;
  fee: FeeParams;
  s: StaticParams;
  createdAt: number | null;
}

/** One observation of a bin (raw on-chain integers kept exact). */
export interface BinObs {
  binId: number;
  x: bigint;
  y: bigint;
  supply: bigint;
  feeX: bigint; // cumulative fee per token, Q64.64
  feeY: bigint;
  priceRaw: number; // raw Y lamports per X lamport
}

export interface PoolStateUpdate {
  pool: string;
  ts: number;
  slot: number;
  activeId: number;
  priceUi: number;
  v: VariableParams;
  feeRateTotal: number;
  feeRateLp: number;
}

export interface BinSnapshot {
  pool: string;
  ts: number;
  slot: number;
  activeId: number;
  lower: number; // observed window, inclusive
  upper: number;
  missingBinArrays: number[];
  /** bins with supply > 0 inside [lower, upper] */
  bins: Map<number, BinObs>;
}

export interface PoolMetrics {
  pool: string;
  ts: number;
  tvlUsd: number;
  tokenXUsd: number;
  tokenYUsd: number;
  volume1hUsd: number;
  fee1hUsd: number;
  volume24hUsd?: number | null;
  feeTvl1h?: number | null;
}

export interface SwapRecord {
  pool: string;
  signature: string;
  eventIndex: number;
  ts: number;
  slot: number;
  swapForY: boolean;
  startBin: number;
  endBin: number;
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  protocolFee: bigint;
  mmFee: bigint;
  feeOnX: boolean;
  wallet: string;
}

export interface GapNotice {
  source: string;
  pool: string | null;
  start: number;
  end: number | null;
}

export interface EcoUpdate {
  ts: number;
  solUsd: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

export interface ActivityUpdate {
  pool: string;
  /** end of the minute */
  ts: number;
  candidates: number;
  sampled: number;
}

/** In-process fan-out of market data (collectors -> simulator / features). */
export class MarketBus extends EventEmitter {
  emitState(u: PoolStateUpdate) { this.emit("poolState", u); }
  emitBins(s: BinSnapshot) { this.emit("binSnapshot", s); }
  emitMetrics(m: PoolMetrics) { this.emit("metrics", m); }
  emitSwap(s: SwapRecord) { this.emit("swap", s); }
  emitGap(g: GapNotice) { this.emit("gap", g); }
  emitEco(e: EcoUpdate) { this.emit("eco", e); }
  emitActivity(a: ActivityUpdate) { this.emit("activity", a); }
}
