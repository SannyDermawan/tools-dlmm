import { PublicKey } from "@solana/web3.js";
import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import type { JsonHttp } from "../api/meteora.ts";
import { decodePosition, DLMM_PROGRAM_ID, POSITION_LB_PAIR_OFFSET, POSITION_OWNER_OFFSET } from "../chain/dlmm.ts";
import type { RpcClient } from "../chain/rpc.ts";
import { every } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { PoolMeta } from "./types.ts";

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Meteora Data API PositionPnLData (verified against /api-docs/openapi.json and live responses, 2026-09-29). */
export interface ApiPositionPnl {
  positionAddress: string;
  lowerBinId: number;
  upperBinId: number;
  isClosed: boolean;
  createdAt: number | null; // seconds
  closedAt: number | null; // seconds
  pnlUsd: string;
  pnlPctChange: string;
  allTimeDeposits: { tokenX: { amount: string; usd: string }; tokenY: { amount: string; usd: string }; total: { usd: string } };
  allTimeWithdrawals: { total: { usd: string } };
  allTimeFees: { total: { usd: string } };
  unrealizedPnl?: { unclaimedFeeTokenX?: { usd: string }; unclaimedFeeTokenY?: { usd: string } } | null;
}

export interface ApiPositionEvent {
  eventType: string; // add | remove | claim_fee | claim_reward
  blockTime: number; // ms
  totalUsd: string;
}

export type Sides = "two_sided" | "quote_only" | "base_only";

/** Sides from the deposits: both tokens -> two_sided; only Y (quote) -> quote_only; only X -> base_only. */
export function sidesFromDeposits(x: number | null, y: number | null): Sides | null {
  const hx = (x ?? 0) > 0;
  const hy = (y ?? 0) > 0;
  if (hx && hy) return "two_sided";
  if (hy) return "quote_only";
  if (hx) return "base_only";
  return null;
}

/** API position -> real_lp_positions row (without event counts, shape and open state). */
export function parsePnlPosition(p: ApiPositionPnl, pool: string, wallet: string, now: number): Record<string, unknown> {
  const dx = num(p.allTimeDeposits?.tokenX?.amount);
  const dy = num(p.allTimeDeposits?.tokenY?.amount);
  const opened = p.createdAt ? p.createdAt * 1000 : null;
  const closed = p.isClosed && p.closedAt ? p.closedAt * 1000 : null;
  const unclaimed = p.isClosed ? 0 : (num(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) ?? 0) + (num(p.unrealizedPnl?.unclaimedFeeTokenY?.usd) ?? 0);
  return {
    position: p.positionAddress, wallet, pool,
    opened_at: opened, closed_at: closed, is_closed: p.isClosed ? 1 : 0,
    lower_bin: p.lowerBinId, upper_bin: p.upperBinId, bins: p.upperBinId - p.lowerBinId + 1,
    sides: sidesFromDeposits(dx, dy),
    deposit_usd: num(p.allTimeDeposits?.total?.usd), deposit_x: dx, deposit_y: dy,
    deposit_x_usd: num(p.allTimeDeposits?.tokenX?.usd), deposit_y_usd: num(p.allTimeDeposits?.tokenY?.usd),
    withdraw_usd: num(p.allTimeWithdrawals?.total?.usd),
    fee_usd: (num(p.allTimeFees?.total?.usd) ?? 0) + unclaimed,
    net_pnl_usd: num(p.pnlUsd), net_pnl_pct: num(p.pnlPctChange),
    duration_min: opened ? ((closed ?? now) - opened) / 60_000 : null,
    source: "meteora_api", fetched_at: now,
  };
}

/**
 * Event counts of a position. "simple" = exactly one add, and every remove within `gapSec` of the
 * close: such positions can be replayed in the simulator one-to-one (realism check).
 */
export function eventCounts(events: ApiPositionEvent[], closedAt: number | null, gapSec: number) {
  const adds = events.filter((e) => e.eventType === "add");
  const removes = events.filter((e) => e.eventType === "remove");
  const claims = events.filter((e) => e.eventType.startsWith("claim"));
  const simple = adds.length === 1 && closedAt !== null && removes.every((e) => Math.abs(closedAt - e.blockTime) <= gapSec * 1000);
  return { add: adds.length, remove: removes.length, claim: claims.length, rebalance: Math.max(0, adds.length - 1), simple };
}

/**
 * Distribution shape from the per-bin liquidity shares: correlation of the normalized shares with
 * the distance from the bin nearest to the price at open (anchor). Rising away from the price ->
 * bidask, falling -> curve, flat -> spot. Needs >= 3 bins with liquidity.
 */
export function shapeFromShares(shares: number[], lower: number, anchor: number | null): { shape: "spot" | "curve" | "bidask" | null; corr: number | null } {
  const idx = shares.map((s, i) => ({ s, id: lower + i })).filter((x) => x.s > 0);
  if (idx.length < 3) return { shape: null, corr: null };
  const lo = idx[0].id, hi = idx[idx.length - 1].id;
  const a = anchor === null ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, anchor));
  // normalize each side of the anchor by its own mean: the X and Y halves of a two-sided deposit
  // rarely hold the same value, which would otherwise hide the shape within each half
  const sideMean = (f: (id: number) => boolean) => {
    const v = idx.filter((x) => f(x.id)).map((x) => x.s);
    return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null;
  };
  const below = sideMean((id) => id < a);
  const above = sideMean((id) => id > a);
  const mid = below !== null && above !== null ? (below + above) / 2 : (below ?? above ?? 1);
  const scale = (id: number) => (id < a ? below : id > a ? above : mid) ?? mid;
  const xs = idx.map((x) => Math.abs(x.id - a));
  const ys = idx.map((x) => x.s / scale(x.id));
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  // flat within 5% relative spread -> spot
  if (syy === 0 || Math.sqrt(syy / ys.length) / my < 0.05) return { shape: "spot", corr: 0 };
  if (sxx === 0) return { shape: "spot", corr: 0 };
  const corr = sxy / Math.sqrt(sxx * syy);
  return { shape: corr >= 0.5 ? "bidask" : corr <= -0.5 ? "curve" : "spot", corr };
}

/**
 * Anchor bin for the shape of a range: the price-side edge for one-sided deposits (quote sits below
 * the price, base above it), the active bin at open for two-sided ones (range midpoint when
 * unknown). Anchoring on the price at scan time misreads one-sided shapes once the price moved.
 */
export function shapeAnchor(lower: number, upper: number, sides: Sides | null, activeAtOpen: number | null): number | null {
  if (sides === "quote_only") return upper;
  if (sides === "base_only") return lower;
  if (activeAtOpen !== null && activeAtOpen >= lower && activeAtOpen <= upper) return activeAtOpen;
  return null;
}

/** lp_wallets from closed real positions (only closed ones have a final result). */
export function recomputeWallets(db: Db, c: Config["real_lp"]["smart"], now = Date.now()): number {
  const rows = db.all<{ wallet: string; n: number; closed: number; win: number | null; avg: number | null; total: number | null; last: number | null }>(
    `SELECT wallet, COUNT(*) n, SUM(is_closed) closed,
       AVG(CASE WHEN is_closed = 1 THEN net_pnl_usd > 0 END) win,
       AVG(CASE WHEN is_closed = 1 THEN net_pnl_pct END) avg,
       SUM(CASE WHEN is_closed = 1 THEN net_pnl_usd END) total,
       MAX(COALESCE(closed_at, opened_at)) last
     FROM real_lp_positions GROUP BY wallet`,
  );
  for (const r of rows) {
    const smart = r.closed >= c.min_closed_positions && (r.win ?? 0) >= c.min_win_rate && (r.avg ?? -Infinity) >= c.min_avg_pnl_pct;
    db.insert(
      "lp_wallets",
      { wallet: r.wallet, positions: r.n, closed_positions: r.closed, win_rate: r.win, avg_pnl_pct: r.avg, total_pnl_usd: r.total, last_active_at: r.last, status_smart: smart ? 1 : 0, updated_at: now },
      "OR REPLACE",
    );
  }
  return rows.length;
}

const UPSERT_COLS = [
  "position", "wallet", "pool", "opened_at", "closed_at", "is_closed", "lower_bin", "upper_bin", "bins", "sides",
  "deposit_usd", "deposit_x", "deposit_y", "deposit_x_usd", "deposit_y_usd", "withdraw_usd", "fee_usd", "net_pnl_usd", "net_pnl_pct", "duration_min", "source", "fetched_at",
];
const UPSERT_SQL = `INSERT INTO real_lp_positions (${UPSERT_COLS.join(", ")}) VALUES (${UPSERT_COLS.map(() => "?").join(", ")})
  ON CONFLICT(position) DO UPDATE SET ${UPSERT_COLS.filter((c) => c !== "position").map((c) => `${c} = excluded.${c}`).join(", ")}`;

export function upsertRealPosition(db: Db, row: Record<string, unknown>) {
  db.run(UPSERT_SQL, ...(UPSERT_COLS.map((c) => (row[c] ?? null) as never)));
}

export interface RealLpDeps {
  db: Db;
  rpc: RpcClient;
  api: Pick<JsonHttp, "get">;
  config: Config;
  log: Logger;
  pools: Map<string, PoolMeta>;
  signal?: AbortSignal;
}

export interface ScanStats {
  pools: number;
  openPositions: number;
  appeared: number;
  gone: number;
  walletQueries: number;
  positionsStored: number;
  eventFetches: number;
  shapes: number;
  errors: number;
}

/**
 * Phase 11 collector (addendum 4): every scan_minutes
 *  1. on-chain scan of the open position accounts of each pool (owner only, dataSlice) -> sightings;
 *     positions appearing / disappearing between scans were active in our data window;
 *  2. shape of newly opened positions from their liquidity shares (full account, batched);
 *  3. Meteora Data API: per (wallet, pool) all positions with PnL (closed ones included), wallets
 *     of appeared / disappeared positions first, then never-fetched ones, then stale ones;
 *  4. event history of closed positions inside our data coverage (add / remove / claim counts);
 *  5. pool state at open from our own snapshots, lp_wallets recomputed.
 */
export class RealLpCollector {
  constructor(private readonly d: RealLpDeps) {}

  async scanPool(pool: string, now: number): Promise<{ open: number; appeared: string[]; gone: string[] }> {
    const { db, rpc } = this.d;
    const res = await rpc.call<{ pubkey: string; account: { data: [string, string] } }[]>("getProgramAccounts", [
      DLMM_PROGRAM_ID,
      { encoding: "base64", commitment: rpc.commitment, dataSlice: { offset: POSITION_OWNER_OFFSET, length: 32 }, filters: [{ memcmp: { offset: POSITION_LB_PAIR_OFFSET, bytes: pool } }] },
    ]);
    const seen = new Map<string, string>();
    for (const r of res ?? []) seen.set(r.pubkey, new PublicKey(Buffer.from(r.account.data[0], "base64")).toBase58());
    const hadScan = !!db.get("SELECT 1 x FROM lp_position_sightings WHERE pool = ? LIMIT 1", pool);
    const known = new Map(db.all<{ position: string; gone_at: number | null }>("SELECT position, gone_at FROM lp_position_sightings WHERE pool = ?", pool).map((r) => [r.position, r.gone_at]));
    const appeared: string[] = [];
    const gone: string[] = [];
    db.tx(() => {
      for (const [position, wallet] of seen) {
        if (!known.has(position)) {
          db.insert("lp_position_sightings", { position, pool, wallet, first_seen_at: now, last_seen_at: now, new_in_scan: hadScan ? 1 : 0 });
          if (hadScan) appeared.push(position);
        } else db.run("UPDATE lp_position_sightings SET last_seen_at = ?, gone_at = NULL WHERE position = ?", now, position);
      }
      for (const [position, goneAt] of known) {
        if (seen.has(position) || goneAt !== null) continue;
        db.run("UPDATE lp_position_sightings SET gone_at = ? WHERE position = ?", now, position);
        gone.push(position);
      }
    });
    return { open: seen.size, appeared, gone };
  }

  /** Shapes of positions opened while we watched (their liquidity shares are the deposit shape). */
  async shapes(positions: string[]): Promise<number> {
    const { db, rpc } = this.d;
    let n = 0;
    for (let i = 0; i < positions.length; i += 100) {
      const keys = positions.slice(i, i + 100);
      const { accounts } = await rpc.getMultipleAccounts(keys);
      for (const [k, acc] of accounts.entries()) {
        if (!acc) continue;
        try {
          const p = decodePosition(acc.data);
          // provisional: sides are not known yet; a range fully below / above the current price is
          // one-sided on that side. Re-classified once the deposits (sides) and the open are known.
          const active = db.get<{ a: number }>(
            "SELECT active_bin a FROM pool_snapshots WHERE pool = ? AND source = 'chain' ORDER BY ts DESC LIMIT 1", p.lbPair,
          )?.a ?? null;
          const side: Sides | null = active === null ? null : p.upperBinId < active ? "quote_only" : p.lowerBinId > active ? "base_only" : "two_sided";
          const s = shapeFromShares(p.shares, p.lowerBinId, shapeAnchor(p.lowerBinId, p.upperBinId, side, active));
          db.run(
            "UPDATE lp_position_sightings SET shape = ?, shape_detail = ? WHERE position = ?",
            s.shape, JSON.stringify({ corr: s.corr, lower: p.lowerBinId, upper: p.upperBinId, shares: p.shares }), keys[k],
          );
          if (s.shape) n++;
        } catch (e) {
          this.d.log.debug({ position: keys[k], err: (e as Error).message }, "position decode failed");
        }
      }
    }
    return n;
  }

  async fetchWallet(wallet: string, pool: string, now: number): Promise<number> {
    const { db, api, config } = this.d;
    let stored = 0;
    let err: string | null = null;
    try {
      for (let page = 1; page <= config.real_lp.max_pages_per_wallet; page++) {
        const r = await api.get<{ positions: ApiPositionPnl[]; hasNext: boolean }>(
          `/positions/${pool}/pnl`, { user: wallet, status: "all", page, page_size: 100 }, "/positions/{pool}/pnl",
        );
        db.tx(() => {
          for (const p of r.positions ?? []) {
            upsertRealPosition(db, parsePnlPosition(p, pool, wallet, now));
            stored++;
          }
        });
        if (!r.hasNext) break;
      }
    } catch (e) {
      err = (e as Error).message.slice(0, 200);
    }
    db.insert("lp_wallet_fetches", { wallet, pool, fetched_at: now, positions: stored, error: err }, "OR REPLACE");
    return stored;
  }

  async fetchEvents(position: string, closedAt: number | null): Promise<boolean> {
    const { db, api, config } = this.d;
    try {
      const r = await api.get<{ events: ApiPositionEvent[] }>(`/positions/${position}/historical`, { order_direction: "asc" }, "/positions/{address}/historical");
      const c = eventCounts(r.events ?? [], closedAt, config.real_lp.realism.max_single_add_gap_seconds);
      db.run(
        "UPDATE real_lp_positions SET add_count = ?, remove_count = ?, claim_count = ?, rebalance_count = ?, simple = ? WHERE position = ?",
        c.add, c.remove, c.claim, c.rebalance, c.simple ? 1 : 0, position,
      );
      return true;
    } catch (e) {
      this.d.log.debug({ position, err: (e as Error).message }, "position events failed");
      return false;
    }
  }

  /** Final shape of each position with scanned shares: anchored by its sides and the price at open. */
  classifyShapes(): number {
    const { db } = this.d;
    const rows = db.all<{ position: string; sides: Sides | null; open_active_bin: number | null; detail: string }>(
      `SELECT r.position, r.sides, r.open_active_bin, s.shape_detail detail FROM real_lp_positions r
       JOIN lp_position_sightings s ON s.position = r.position WHERE s.shape_detail IS NOT NULL`,
    );
    let n = 0;
    for (const r of rows) {
      const d = JSON.parse(r.detail) as { lower?: number; upper?: number; shares?: number[] };
      if (!d.shares || d.lower === undefined || d.upper === undefined) {
        // labelled by an older scan without the raw shares: the anchor may have been wrong -> unknown
        db.run("UPDATE real_lp_positions SET shape = NULL WHERE position = ?", r.position);
        continue;
      }
      const s = shapeFromShares(d.shares, d.lower, shapeAnchor(d.lower, d.upper, r.sides, r.open_active_bin));
      db.run("UPDATE real_lp_positions SET shape = ? WHERE position = ?", s.shape, r.position);
      n++;
    }
    return n;
  }

  /** Pool state at open from our own data (snapshot <= 60 s before the open) and our score then. */
  fillOpenState(): number {
    const { db } = this.d;
    const rows = db.all<{ position: string; pool: string; opened_at: number }>(
      `SELECT r.position, r.pool, r.opened_at FROM real_lp_positions r
       WHERE r.open_active_bin IS NULL AND r.opened_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM pool_snapshots s WHERE s.pool = r.pool AND s.source = 'chain' AND s.ts BETWEEN r.opened_at - 60000 AND r.opened_at)`,
    );
    for (const r of rows) {
      const s = db.get<{ active_bin: number; price: number; total_fee_rate: number }>(
        "SELECT active_bin, price, total_fee_rate FROM pool_snapshots WHERE pool = ? AND source = 'chain' AND ts <= ? ORDER BY ts DESC LIMIT 1", r.pool, r.opened_at,
      );
      const sc = db.get<{ final_score: number | null; action: string; regime_label: string | null }>(
        "SELECT final_score, action, regime_label FROM scores WHERE pool = ? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 1", r.pool, r.opened_at - 180_000, r.opened_at,
      );
      if (!s) continue;
      db.run(
        "UPDATE real_lp_positions SET open_active_bin = ?, open_state = ? WHERE position = ?",
        s.active_bin, JSON.stringify({ price: s.price, fee_rate: s.total_fee_rate, score: sc?.final_score ?? null, action: sc?.action ?? null, regime: sc?.regime_label ?? null }), r.position,
      );
    }
    return rows.length;
  }

  /** Wallet queue: appeared / gone first, then never fetched, then stale (smart wallets first). */
  walletQueue(appearedOrGone: string[], now: number): { wallet: string; pool: string }[] {
    const { db, config } = this.d;
    const max = config.real_lp.max_wallet_queries_per_scan;
    const out: { wallet: string; pool: string }[] = [];
    const key = new Set<string>();
    const push = (wallet: string, pool: string) => {
      const k = `${wallet}|${pool}`;
      if (key.has(k) || out.length >= max) return;
      key.add(k);
      out.push({ wallet, pool });
    };
    const ph = appearedOrGone.map(() => "?").join(",");
    if (appearedOrGone.length)
      for (const r of db.all<{ wallet: string; pool: string }>(`SELECT wallet, pool FROM lp_position_sightings WHERE position IN (${ph})`, ...appearedOrGone)) push(r.wallet, r.pool);
    const pools = [...this.d.pools.keys()];
    const pp = pools.map(() => "?").join(",");
    if (pools.length) {
      for (const r of db.all<{ wallet: string; pool: string }>(
        `SELECT DISTINCT s.wallet, s.pool FROM lp_position_sightings s
         WHERE s.pool IN (${pp}) AND s.gone_at IS NULL AND NOT EXISTS (SELECT 1 FROM lp_wallet_fetches f WHERE f.wallet = s.wallet AND f.pool = s.pool)
         ORDER BY random() LIMIT ?`,
        ...pools, max,
      )) push(r.wallet, r.pool);
      for (const r of db.all<{ wallet: string; pool: string }>(
        `SELECT f.wallet, f.pool FROM lp_wallet_fetches f LEFT JOIN lp_wallets w ON w.wallet = f.wallet
         WHERE f.pool IN (${pp}) AND f.fetched_at < ? ORDER BY COALESCE(w.status_smart, 0) DESC, f.fetched_at LIMIT ?`,
        ...pools, now - config.real_lp.refetch_hours * 3_600_000, max,
      )) push(r.wallet, r.pool);
    }
    return out;
  }

  async tick(now = Date.now()): Promise<ScanStats> {
    const { db, config, log } = this.d;
    const st: ScanStats = { pools: 0, openPositions: 0, appeared: 0, gone: 0, walletQueries: 0, positionsStored: 0, eventFetches: 0, shapes: 0, errors: 0 };
    const changed: string[] = [];
    const appeared: string[] = [];
    for (const pool of this.d.pools.keys()) {
      if (this.d.signal?.aborted) return st;
      try {
        const r = await this.scanPool(pool, now);
        st.pools++;
        st.openPositions += r.open;
        st.appeared += r.appeared.length;
        st.gone += r.gone.length;
        changed.push(...r.appeared, ...r.gone);
        appeared.push(...r.appeared);
      } catch (e) {
        st.errors++;
        log.warn({ pool, err: (e as Error).message }, "real LP scan failed");
      }
    }
    if (config.real_lp.shape_for_new_positions && appeared.length) {
      try {
        st.shapes = await this.shapes(appeared);
      } catch (e) {
        st.errors++;
        log.warn({ err: (e as Error).message }, "position shapes failed");
      }
    }
    for (const q of this.walletQueue(changed, now)) {
      if (this.d.signal?.aborted) return st;
      st.walletQueries++;
      st.positionsStored += await this.fetchWallet(q.wallet, q.pool, now);
    }
    if (config.real_lp.fetch_events) {
      // closed positions whose whole life falls inside our own data (realism candidates) first
      const cands = db.all<{ position: string; closed_at: number | null }>(
        `SELECT r.position, r.closed_at FROM real_lp_positions r
         WHERE r.is_closed = 1 AND r.add_count IS NULL
           AND EXISTS (SELECT 1 FROM pool_snapshots s WHERE s.pool = r.pool AND s.source = 'chain' AND s.ts BETWEEN r.opened_at - 60000 AND r.opened_at)
         ORDER BY r.closed_at DESC LIMIT ?`,
        config.real_lp.max_event_fetches_per_scan,
      );
      for (const c of cands) if (await this.fetchEvents(c.position, c.closed_at)) st.eventFetches++;
    }
    this.fillOpenState();
    this.classifyShapes();
    recomputeWallets(db, config.real_lp.smart, now);
    log.info(st, "real LP scan");
    return st;
  }

  run(signal: AbortSignal) {
    return every(this.d.config.real_lp.scan_minutes * 60_000, signal, async () => {
      await this.tick();
    });
  }
}
