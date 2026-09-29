import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";

interface Pos {
  wallet: string;
  pool: string;
  opened: number;
  closed: number | null;
  net: number | null;
  pct: number | null;
}

/**
 * Smart LP presence at decision time t (addendum 4.3, look-ahead safe):
 *  - a wallet is smart at t if its positions closed before t meet real_lp.smart (count, win rate,
 *    mean PnL %) — later results never count;
 *  - it is present in a pool at t if it has a position there opened at or before t and not closed
 *    by t (observable on chain at t).
 * Positions are reloaded from the database at most every `reloadMs` (the live collector adds rows).
 */
export class SmartLpLookup {
  private byPool = new Map<string, Pos[]>();
  private byWallet = new Map<string, Pos[]>();
  private loadedAt = -Infinity;
  private readonly smartCache = new Map<string, boolean>();

  constructor(
    private readonly db: Db,
    private readonly c: Config["real_lp"]["smart"],
    private readonly pools: string[],
    private readonly reloadMs = 10 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  private load() {
    const now = this.clock();
    if (now - this.loadedAt < this.reloadMs) return;
    this.loadedAt = now;
    this.smartCache.clear();
    this.byPool.clear();
    this.byWallet.clear();
    if (!this.pools.length) return;
    const ph = this.pools.map(() => "?").join(",");
    // every position of the wallets active in our pools (their record spans all pools)
    const rows = this.db.all<{ wallet: string; pool: string; opened_at: number | null; closed_at: number | null; net_pnl_usd: number | null; net_pnl_pct: number | null }>(
      `SELECT wallet, pool, opened_at, closed_at, net_pnl_usd, net_pnl_pct FROM real_lp_positions
       WHERE wallet IN (SELECT DISTINCT wallet FROM real_lp_positions WHERE pool IN (${ph})) AND opened_at IS NOT NULL`,
      ...this.pools,
    );
    for (const r of rows) {
      const p: Pos = { wallet: r.wallet, pool: r.pool, opened: r.opened_at!, closed: r.closed_at, net: r.net_pnl_usd, pct: r.net_pnl_pct };
      (this.byPool.get(p.pool) ?? this.byPool.set(p.pool, []).get(p.pool)!).push(p);
      (this.byWallet.get(p.wallet) ?? this.byWallet.set(p.wallet, []).get(p.wallet)!).push(p);
    }
  }

  isSmart(wallet: string, t: number): boolean {
    const k = `${wallet}|${Math.floor(t / 3_600_000)}`; // hourly granularity is enough, still <= t
    const hit = this.smartCache.get(k);
    if (hit !== undefined) return hit;
    const hour = Math.floor(t / 3_600_000) * 3_600_000;
    const closed = (this.byWallet.get(wallet) ?? []).filter((p) => p.closed !== null && p.closed < hour);
    let smart = false;
    if (closed.length >= this.c.min_closed_positions) {
      const win = closed.filter((p) => (p.net ?? 0) > 0).length / closed.length;
      const pcts = closed.map((p) => p.pct).filter((x): x is number => x !== null);
      const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : -Infinity;
      smart = win >= this.c.min_win_rate && avg >= this.c.min_avg_pnl_pct;
    }
    this.smartCache.set(k, smart);
    return smart;
  }

  /** Smart wallets with an open position in the pool at t; null when we hold no real LP data for it. */
  at(pool: string, t: number): { count: number; openPositions: number } | null {
    this.load();
    const list = this.byPool.get(pool);
    if (!list?.length) return null;
    const open = list.filter((p) => p.opened <= t && (p.closed === null || p.closed > t));
    const smart = new Set(open.filter((p) => this.isSmart(p.wallet, t)).map((p) => p.wallet));
    return { count: smart.size, openPositions: open.length };
  }
}
