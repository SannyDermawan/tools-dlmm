import { BorshAccountsCoder, BorshEventCoder, utils } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { meteoraSdk as ns } from "./sdk.ts";
import type { RawTransaction } from "./rpc.ts";

export const IDL = ns.IDL as unknown as {
  address: string;
  metadata: { version: string };
  events: { name: string; discriminator: number[] }[];
};
export const DLMM_PROGRAM_ID = IDL.address; // LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
export const IDL_VERSION = IDL.metadata.version;
export const BINS_PER_ARRAY = 70; // MAX_BIN_PER_ARRAY
export const sdkNs = ns;

const accounts = new BorshAccountsCoder(ns.IDL as never);
const events = new BorshEventCoder(ns.IDL as never);

/** sha256("anchor:event")[0..8] — prefix of self-CPI event instruction data (emit_cpi!). */
export const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

const LB_PAIR_DISC = Buffer.from(accounts.accountDiscriminator("LbPair"));
const BIN_ARRAY_DISC = Buffer.from(accounts.accountDiscriminator("BinArray"));

const bnToBig = (b: BN): bigint => BigInt(b.toString());

export interface StaticParams {
  baseFactor: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: number;
  maxVolatilityAccumulator: number;
  minBinId: number;
  maxBinId: number;
  protocolShare: number;
  baseFeePowerFactor: number;
  functionType: number;
  collectFeeMode: number;
}

export interface VariableParams {
  volatilityAccumulator: number;
  volatilityReference: number;
  indexReference: number;
  lastUpdateTimestamp: number;
}

export interface LbPairState {
  activeId: number;
  binStep: number;
  status: number;
  tokenXMint: string;
  tokenYMint: string;
  reserveX: string;
  reserveY: string;
  tokenXProgramFlag: number;
  tokenYProgramFlag: number;
  s: StaticParams;
  v: VariableParams;
}

export function decodeLbPair(data: Buffer): LbPairState {
  if (!data.subarray(0, 8).equals(LB_PAIR_DISC)) throw new Error("not an LbPair account");
  const a = accounts.decode("LbPair", data) as Record<string, any>;
  const p = a.parameters;
  const v = a.v_parameters;
  return {
    activeId: a.active_id,
    binStep: a.bin_step,
    status: a.status,
    tokenXMint: a.token_x_mint.toBase58(),
    tokenYMint: a.token_y_mint.toBase58(),
    reserveX: a.reserve_x.toBase58(),
    reserveY: a.reserve_y.toBase58(),
    tokenXProgramFlag: a.token_mint_x_program_flag,
    tokenYProgramFlag: a.token_mint_y_program_flag,
    s: {
      baseFactor: p.base_factor,
      filterPeriod: p.filter_period,
      decayPeriod: p.decay_period,
      reductionFactor: p.reduction_factor,
      variableFeeControl: p.variable_fee_control,
      maxVolatilityAccumulator: p.max_volatility_accumulator,
      minBinId: p.min_bin_id,
      maxBinId: p.max_bin_id,
      protocolShare: p.protocol_share,
      baseFeePowerFactor: p.base_fee_power_factor,
      functionType: p.function_type,
      collectFeeMode: p.collect_fee_mode,
    },
    v: {
      volatilityAccumulator: v.volatility_accumulator,
      volatilityReference: v.volatility_reference,
      indexReference: v.index_reference,
      lastUpdateTimestamp: Number(v.last_update_timestamp.toString()),
    },
  };
}

export interface BinRaw {
  binId: number;
  amountX: bigint;
  amountY: bigint;
  /** Q64.64 price of 1 raw X in raw Y */
  priceQ64: bigint;
  liquiditySupply: bigint;
  feeXPerToken: bigint;
  feeYPerToken: bigint;
}

export interface BinArrayState {
  index: number;
  lbPair: string;
  bins: BinRaw[];
}

export function decodeBinArray(data: Buffer): BinArrayState {
  if (!data.subarray(0, 8).equals(BIN_ARRAY_DISC)) throw new Error("not a BinArray account");
  const a = accounts.decode("BinArray", data) as Record<string, any>;
  const index = Number(a.index.toString());
  const lower = index * BINS_PER_ARRAY;
  return {
    index,
    lbPair: a.lb_pair.toBase58(),
    bins: (a.bins as any[]).map((b, i) => ({
      binId: lower + i,
      amountX: bnToBig(b.amount_x),
      amountY: bnToBig(b.amount_y),
      priceQ64: bnToBig(b.price),
      liquiditySupply: bnToBig(b.liquidity_supply),
      feeXPerToken: bnToBig(b.fee_amount_x_per_token_stored),
      feeYPerToken: bnToBig(b.fee_amount_y_per_token_stored),
    })),
  };
}

/** Floor division: bin array index containing binId (matches SDK binIdToBinArrayIndex). */
export function binArrayIndex(binId: number): number {
  return Math.floor(binId / BINS_PER_ARRAY);
}

export function deriveBinArrayAddress(lbPair: string, index: number): string {
  const idx = Buffer.alloc(8);
  idx.writeBigInt64LE(BigInt(index));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bin_array"), new PublicKey(lbPair).toBuffer(), idx],
    new PublicKey(DLMM_PROGRAM_ID),
  );
  return pda.toBase58();
}

const binArrayAddrCache = new Map<string, string>();
export function binArrayAddress(lbPair: string, index: number): string {
  const k = `${lbPair}:${index}`;
  let a = binArrayAddrCache.get(k);
  if (!a) {
    a = deriveBinArrayAddress(lbPair, index);
    binArrayAddrCache.set(k, a);
  }
  return a;
}

// ---------------------------------------------------------------- events

export interface SwapEvent {
  eventType: "Swap" | "Swap2Evt";
  lbPair: string;
  from: string;
  startBinId: number;
  endBinId: number;
  amountIn: bigint;
  amountOut: bigint;
  amountLeft: bigint | null;
  swapForY: boolean;
  /** total fee incl. protocol (and limit-order) share */
  fee: bigint;
  protocolFee: bigint;
  /** LP (market-maker) share; legacy Swap: fee - protocolFee */
  mmFee: bigint;
  limitOrderFee: bigint;
  hostFee: bigint;
  feeBps: bigint;
  /** null for legacy Swap (derived from pool collect_fee_mode by the caller) */
  feesOnInput: boolean | null;
  feesOnTokenX: boolean | null;
}

export interface DecodedEvent {
  name: string;
  data: Record<string, any>;
  index: number;
}

/**
 * Extract Anchor self-CPI events from a transaction: inner instructions invoking the DLMM
 * program whose data starts with EVENT_IX_TAG.
 */
export function extractEvents(tx: RawTransaction): DecodedEvent[] {
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const out: DecodedEvent[] = [];
  const inner = [...(tx.meta?.innerInstructions ?? [])].sort((a, b) => a.index - b.index);
  let index = 0;
  for (const group of inner) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== DLMM_PROGRAM_ID) continue;
      const bytes = Buffer.from(utils.bytes.bs58.decode(ix.data));
      if (bytes.length < 16 || !bytes.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
      const ev = events.decode(bytes.subarray(8).toString("base64"));
      if (ev) out.push({ name: ev.name, data: ev.data as Record<string, any>, index: index++ });
    }
  }
  return out;
}

const big = (v: any): bigint => (v === undefined || v === null ? 0n : BigInt(v.toString()));

export function toSwapEvent(e: DecodedEvent): SwapEvent | null {
  const d = e.data;
  if (e.name === "Swap") {
    const fee = big(d.fee);
    const protocolFee = big(d.protocol_fee);
    return {
      eventType: "Swap",
      lbPair: d.lb_pair.toBase58(),
      from: d.from.toBase58(),
      startBinId: d.start_bin_id,
      endBinId: d.end_bin_id,
      amountIn: big(d.amount_in),
      amountOut: big(d.amount_out),
      amountLeft: null,
      swapForY: d.swap_for_y,
      fee,
      protocolFee,
      mmFee: fee - protocolFee,
      limitOrderFee: 0n,
      hostFee: big(d.host_fee),
      feeBps: big(d.fee_bps),
      feesOnInput: null,
      feesOnTokenX: null,
    };
  }
  if (e.name === "Swap2Evt") {
    const mmFee = big(d.mm_fee);
    const protocolFee = big(d.protocol_fee);
    const limitOrderFee = big(d.limit_order_fee);
    const hostFee = big(d.host_fee);
    return {
      eventType: "Swap2Evt",
      lbPair: d.lb_pair.toBase58(),
      from: d.from.toBase58(),
      startBinId: d.start_bin_id,
      endBinId: d.end_bin_id,
      amountIn: big(d.amount_in),
      amountOut: big(d.amount_out),
      amountLeft: big(d.amount_left),
      swapForY: d.swap_for_y,
      fee: mmFee + protocolFee + limitOrderFee + hostFee,
      protocolFee,
      mmFee,
      limitOrderFee,
      hostFee,
      feeBps: big(d.fee_bps),
      feesOnInput: d.fees_on_input,
      feesOnTokenX: d.fees_on_token_x,
    };
  }
  return null;
}

/**
 * All swaps of a transaction, one entry per swap. The program (lb_clmm 0.12) emits BOTH a legacy
 * `Swap` and a `Swap2Evt` for the same swap; the Swap2Evt (richer fee split) wins and its legacy
 * twin is dropped. Transactions from older program versions only carry `Swap`.
 * Note: `feeBps` is actually the total fee rate scaled by 1e9 (FEE_PRECISION), not basis points.
 */
export function extractSwaps(tx: RawTransaction): (SwapEvent & { eventIndex: number })[] {
  const evs = extractEvents(tx);
  const swaps = evs.map((e) => ({ e, s: toSwapEvent(e) })).filter((x) => x.s) as { e: DecodedEvent; s: SwapEvent }[];
  const key = (s: SwapEvent) => `${s.lbPair}|${s.startBinId}|${s.endBinId}|${s.amountIn}|${s.amountOut}|${s.swapForY}`;
  const v2 = new Map<string, number>();
  for (const { s } of swaps) if (s.eventType === "Swap2Evt") v2.set(key(s), (v2.get(key(s)) ?? 0) + 1);
  const out: (SwapEvent & { eventIndex: number })[] = [];
  for (const { e, s } of swaps) {
    if (s.eventType === "Swap") {
      const n = v2.get(key(s)) ?? 0;
      if (n > 0) {
        v2.set(key(s), n - 1);
        continue;
      }
    }
    out.push({ ...s, eventIndex: e.index });
  }
  return out;
}

/** Fee token for a swap: explicit on Swap2Evt; legacy Swap follows collect_fee_mode (0 = input only). */
export function feeOnTokenX(s: SwapEvent, collectFeeMode: number): boolean {
  if (s.feesOnTokenX !== null) return s.feesOnTokenX;
  return collectFeeMode === 1 ? false : s.swapForY;
}

export interface PositionAccount {
  lbPair: string;
  owner: string;
  lowerBinId: number;
  upperBinId: number;
  /** liquidity shares of the first min(70, width) bins (wider positions keep the rest in an extension) */
  shares: number[];
}

/** PositionV2 account (8 disc + lb_pair 32 + owner 32 + liquidity_shares u128[70] + ...). */
export const POSITION_OWNER_OFFSET = 40;
export const POSITION_LB_PAIR_OFFSET = 8;

export function decodePosition(data: Buffer): PositionAccount {
  const a = accounts.decode("PositionV2", data) as Record<string, any>;
  const width = a.upper_bin_id - a.lower_bin_id + 1;
  const shares = (a.liquidity_shares as BN[]).slice(0, Math.min(70, width)).map((x) => Number(x.toString()));
  return { lbPair: a.lb_pair.toBase58(), owner: a.owner.toBase58(), lowerBinId: a.lower_bin_id, upperBinId: a.upper_bin_id, shares };
}
