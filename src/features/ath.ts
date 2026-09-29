import type { Db } from "../db/index.ts";

/**
 * All-time high of a pool's price (quote per base, the pool's own price) from our OHLCV, look-ahead
 * safe: only candles that had closed at t. Daily candles (24h, pulled back to the pool's start) give
 * the history; 1h and 5m candles cover the days that are not closed yet. Cached per pool and
 * 5-minute bucket, so a grid of hundreds of positions asks the database once per pool and round.
 *
 * "ATH" is the highest high we can see: for a pool younger than our lookback it is the true
 * all-time high, otherwise the high of the lookback window (a lower bound of the real ATH).
 */
export const ATH_TIMEFRAMES: [tf: string, ms: number][] = [["24h", 86_400_000], ["1h", 3_600_000], ["5m", 300_000]];

export class AthLookup {
  private cache = new Map<string, number | null>();
  constructor(private readonly db: Db) {}

  at(pool: string, t: number): number | null {
    const k = `${pool}|${Math.floor(t / 300_000)}`;
    if (this.cache.has(k)) return this.cache.get(k)!;
    const clause = ATH_TIMEFRAMES.map(() => "(timeframe = ? AND ts + ? <= ?)").join(" OR ");
    const args = ATH_TIMEFRAMES.flatMap(([tf, ms]) => [tf, ms, t]);
    const row = this.db.get<{ ath: number | null }>(`SELECT MAX(h) AS ath FROM ohlcv WHERE pool = ? AND h > 0 AND (${clause})`, pool, ...args);
    const ath = row?.ath ?? null;
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(k, ath);
    return ath;
  }
}

/** Drawdown of `price` from the high `ath` in %, 0 when the price is at or above it. */
export function athDrawdownPct(price: number, ath: number | null): number | null {
  if (ath === null || !(ath > 0) || !(price > 0)) return null;
  return Math.max(0, 100 * (1 - price / ath));
}

/**
 * Downside (%) of a range whose bottom sits `pct` % below the ATH, seen from the current price:
 * bottom = ath * (1 - pct/100), d = 1 - bottom / price. Null when the price is missing or the bottom
 * is not below the price (the pool already fell past that level).
 */
export function downsideFromAthAnchor(price: number, ath: number | null, pct: number): number | null {
  if (ath === null || !(ath > 0) || !(price > 0)) return null;
  const bottom = ath * (1 - pct / 100);
  if (bottom >= price) return null;
  return 100 * (1 - bottom / price);
}
