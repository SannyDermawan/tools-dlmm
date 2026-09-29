import type { Config } from "../config/schema.ts";
import type { Db, Row } from "../db/index.ts";
import type { RpcClient } from "../chain/rpc.ts";
import { binArrayAddress, binArrayIndex, decodeBinArray, decodeLbPair, type LbPairState } from "../chain/dlmm.ts";
import { binRawPrice, binUiPrice, q64ToNumber, rawToUiPrice } from "../math/bin.ts";
import { feeRates } from "../math/fee.ts";
import { every } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { GapTracker } from "./gaps.ts";
import type { BinObs, BinSnapshot, MarketBus, PoolMeta, PoolStateUpdate } from "./types.ts";

export function stateFromLbPair(meta: PoolMeta, lb: LbPairState, ts: number, slot: number): PoolStateUpdate {
  const rates = feeRates(meta.fee, lb.v.volatilityAccumulator);
  return {
    pool: meta.pool,
    ts,
    slot,
    activeId: lb.activeId,
    priceUi: binUiPrice(lb.activeId, lb.binStep, meta.decimalsX, meta.decimalsY),
    v: lb.v,
    feeRateTotal: rates.total,
    feeRateLp: rates.lp,
  };
}

function stateRow(u: PoolStateUpdate, sessionId: string, meta: PoolMeta): Row {
  const r = feeRates(meta.fee, u.v.volatilityAccumulator);
  return {
    pool: u.pool,
    ts: u.ts,
    source: "chain",
    session_id: sessionId,
    slot: u.slot,
    active_bin: u.activeId,
    price: u.priceUi,
    volatility_accumulator: u.v.volatilityAccumulator,
    volatility_reference: u.v.volatilityReference,
    index_reference: u.v.indexReference,
    v_last_update_ts: u.v.lastUpdateTimestamp,
    base_fee_rate: r.base,
    variable_fee_rate: r.variable,
    total_fee_rate: r.total,
  };
}

/** Warn when on-chain static params change (fee parameter updates). */
function paramsChanged(meta: PoolMeta, lb: LbPairState): boolean {
  const s = meta.s;
  return (
    s.baseFactor !== lb.s.baseFactor || s.variableFeeControl !== lb.s.variableFeeControl ||
    s.protocolShare !== lb.s.protocolShare || s.baseFeePowerFactor !== lb.s.baseFeePowerFactor ||
    s.filterPeriod !== lb.s.filterPeriod || s.decayPeriod !== lb.s.decayPeriod || s.reductionFactor !== lb.s.reductionFactor
  );
}

export interface ChainDeps {
  rpc: RpcClient;
  db: Db;
  log: Logger;
  bus: MarketBus;
  gaps: GapTracker;
  config: Config;
  sessionId: string;
  pools: Map<string, PoolMeta>;
  /** latest active bin per pool, shared between collectors */
  activeIds: Map<string, number>;
}

/** lb_pair accounts of all pools in one getMultipleAccounts per tick. */
export class PoolStateCollector {
  static readonly SOURCE = "pool_state";
  constructor(private readonly d: ChainDeps) {}

  async tick(): Promise<void> {
    const { d } = this;
    const pools = [...d.pools.values()];
    if (!pools.length) return;
    let res;
    try {
      res = await d.rpc.getMultipleAccounts(pools.map((p) => p.pool));
    } catch (e) {
      d.log.error({ err: (e as Error).message }, "pool_state fetch failed");
      return; // watchdog opens the gap if this persists
    }
    const ts = Date.now();
    const rows: Row[] = [];
    pools.forEach((meta, i) => {
      const acc = res.accounts[i];
      if (!acc) return;
      const lb = decodeLbPair(acc.data);
      if (paramsChanged(meta, lb)) {
        d.log.warn({ pool: meta.pool, old: meta.s, new: lb.s }, "pool static params changed");
        meta.s = lb.s;
        meta.fee = { ...meta.fee, baseFactor: lb.s.baseFactor, baseFeePowerFactor: lb.s.baseFeePowerFactor, variableFeeControl: lb.s.variableFeeControl, protocolShare: lb.s.protocolShare };
      }
      const u = stateFromLbPair(meta, lb, ts, res.slot);
      d.activeIds.set(meta.pool, u.activeId);
      rows.push(stateRow(u, d.sessionId, meta));
      d.gaps.ok(PoolStateCollector.SOURCE, meta.pool, ts);
      d.bus.emitState(u);
    });
    d.db.insertMany("pool_snapshots", rows, "OR IGNORE");
  }

  run(signal: AbortSignal) {
    for (const p of this.d.pools.keys()) this.d.gaps.register(PoolStateCollector.SOURCE, p);
    return every(this.d.config.collectors.pool_state.interval_seconds * 1000, signal, () => this.tick());
  }
}

const sameBin = (a: BinObs, b: BinObs) =>
  a.x === b.x && a.y === b.y && a.supply === b.supply && a.feeX === b.feeX && a.feeY === b.feeY;

/**
 * Bin arrays around the active bin. The lb_pair accounts are fetched in the same request so the
 * window is centred on the active bin of the same slot. Storage is delta-encoded (see schema).
 */
export class BinSnapshotCollector {
  static readonly SOURCE = "bin_snapshot";
  private last = new Map<string, Map<number, BinObs>>();
  private count = new Map<string, number>();
  constructor(private readonly d: ChainDeps) {}

  /** Bin array indexes covering [active - n, active + n]. */
  static arrayIndexes(activeId: number, n: number): number[] {
    const lo = binArrayIndex(activeId - n);
    const hi = binArrayIndex(activeId + n);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }

  async tick(): Promise<void> {
    const { d } = this;
    const n = d.config.collectors.bin_snapshot.bins_each_side;
    const pools = [...d.pools.values()].filter((p) => d.activeIds.has(p.pool));
    if (!pools.length) return;
    // Fetch one extra array on each side so a small move of the active bin between the last
    // pool_state tick and this request is still covered.
    const plan = pools.map((p) => {
      const idx = BinSnapshotCollector.arrayIndexes(d.activeIds.get(p.pool)!, n + 35);
      return { p, idx, addrs: idx.map((i) => binArrayAddress(p.pool, i)) };
    });
    const keys = [...plan.map((x) => x.p.pool), ...plan.flatMap((x) => x.addrs)];
    let res;
    try {
      res = await d.rpc.getMultipleAccounts(keys);
    } catch (e) {
      d.log.error({ err: (e as Error).message }, "bin_snapshot fetch failed");
      return;
    }
    const ts = Date.now();
    let off = plan.length;
    const metaRows: Row[] = [];
    const binRows: Row[] = [];
    plan.forEach((pl, i) => {
      const lbAcc = res.accounts[i];
      const arrAccs = res.accounts.slice(off, off + pl.addrs.length);
      off += pl.addrs.length;
      if (!lbAcc) return;
      const lb = decodeLbPair(lbAcc.data);
      const meta = pl.p;
      d.activeIds.set(meta.pool, lb.activeId);
      const want = new Set(BinSnapshotCollector.arrayIndexes(lb.activeId, n));
      const missing: number[] = [];
      const bins = new Map<number, BinObs>();
      let lower = lb.activeId - n;
      let upper = lb.activeId + n;
      const fetched = new Set<number>();
      pl.idx.forEach((arrIdx, j) => {
        const acc = arrAccs[j];
        if (!acc) {
          if (want.has(arrIdx)) missing.push(arrIdx);
          return;
        }
        fetched.add(arrIdx);
        for (const b of decodeBinArray(acc.data).bins) {
          if (b.binId < lower || b.binId > upper || b.liquiditySupply === 0n) continue;
          bins.set(b.binId, {
            binId: b.binId, x: b.amountX, y: b.amountY, supply: b.liquiditySupply,
            feeX: b.feeXPerToken, feeY: b.feeYPerToken, priceRaw: q64ToNumber(b.priceQ64),
          });
        }
      });
      // If the active bin moved outside the fetched arrays, clip the window to what was fetched
      // (missing = not initialized on chain, which is a real "no liquidity" region, not a gap).
      for (const idx of want) {
        if (!fetched.has(idx) && !missing.includes(idx)) {
          d.log.warn({ pool: meta.pool, idx }, "bin array not in fetch plan; window clipped");
          if (idx * 70 > lb.activeId) upper = Math.min(upper, idx * 70 - 1);
          else lower = Math.max(lower, idx * 70 + 70);
        }
      }
      const snap: BinSnapshot = { pool: meta.pool, ts, slot: res.slot, activeId: lb.activeId, lower, upper, missingBinArrays: missing, bins };

      // delta encoding
      const k = (this.count.get(meta.pool) ?? 0) + 1;
      this.count.set(meta.pool, k);
      const full = k === 1 || k % d.config.collectors.bin_snapshot.keyframe_every === 0;
      const prev = this.last.get(meta.pool);
      let stored = 0;
      const pushRow = (b: BinObs) => {
        stored++;
        binRows.push({
          pool: meta.pool, ts, bin_id: b.binId,
          price: rawToUiPrice(b.priceRaw || binRawPrice(b.binId, meta.binStep), meta.decimalsX, meta.decimalsY),
          x_amount: b.x.toString(), y_amount: b.y.toString(), liquidity_supply: b.supply.toString(),
          fee_x_per_token: b.feeX.toString(), fee_y_per_token: b.feeY.toString(),
          value_quote_ui: (Number(b.x) * b.priceRaw + Number(b.y)) / 10 ** meta.decimalsY,
        });
      };
      for (const b of bins.values()) {
        const p = prev?.get(b.binId);
        if (full || !p || !sameBin(p, b)) pushRow(b);
      }
      if (!full && prev) {
        for (const [id, p] of prev) {
          if (id >= lower && id <= upper && !bins.has(id)) {
            pushRow({ ...p, x: 0n, y: 0n, supply: 0n }); // emptied bin
          }
        }
      }
      this.last.set(meta.pool, bins);
      metaRows.push({
        pool: meta.pool, ts, session_id: d.sessionId, slot: res.slot, active_bin: lb.activeId,
        lower_bin: lower, upper_bin: upper, missing_bin_arrays: JSON.stringify(missing),
        bin_count: bins.size, stored_count: stored, full: full ? 1 : 0,
      });
      d.gaps.ok(BinSnapshotCollector.SOURCE, meta.pool, ts);
      d.bus.emitBins(snap);
      // lb_pair of the same slot doubles as a pool_state observation
      d.bus.emitState(stateFromLbPair(meta, lb, ts, res.slot));
    });
    d.db.tx(() => {
      for (const r of metaRows) d.db.insert("bin_snapshot_meta", r, "OR IGNORE");
      for (const r of binRows) d.db.insert("bin_snapshots", r, "OR IGNORE");
    });
  }

  run(signal: AbortSignal) {
    for (const p of this.d.pools.keys()) this.d.gaps.register(BinSnapshotCollector.SOURCE, p);
    return every(this.d.config.collectors.bin_snapshot.interval_seconds * 1000, signal, () => this.tick());
  }
}
