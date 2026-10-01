import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";

/** Chart indicators from our own OHLCV (addendum 6.1): RSI, Supertrend, Bollinger, Fibonacci. */

export interface Candle {
  ts: number; // bucket start
  o: number;
  h: number;
  l: number;
  c: number;
}

export const TF_MS: Record<string, number> = { "5m": 5 * 60_000, "15m": 15 * 60_000, "30m": 30 * 60_000, "1h": 60 * 60_000 };

/** Wilder RSI per bar (null until `n` changes are available). */
export function rsiSeries(closes: number[], n: number): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = val();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(0, d)) / n;
    loss = (loss * (n - 1) + Math.max(0, -d)) / n;
    out[i] = val();
  }
  return out;
}

/** Bollinger %B per bar: (close - lower) / (upper - lower); 0.5 = middle band. */
export function pctBSeries(closes: number[], n: number, k: number): (number | null)[] {
  return closes.map((c, i) => {
    if (i < n - 1) return null;
    const w = closes.slice(i - n + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    if (sd === 0) return 0.5;
    const lo = m - k * sd, hi = m + k * sd;
    return (c - lo) / (hi - lo);
  });
}

/** Exponential moving average per bar, seeded with the simple mean of the first n values (null before). */
export function emaSeries(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = v.map(() => null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) {
    e = v[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** MACD histogram per bar: (EMA fast - EMA slow) - EMA signal of that line (null during warm-up). */
export function macdHistSeries(closes: number[], fast: number, slow: number, signal: number): (number | null)[] {
  const f = emaSeries(closes, fast);
  const s = emaSeries(closes, slow);
  const line = closes.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null));
  const start = line.findIndex((x) => x !== null);
  const out: (number | null)[] = closes.map(() => null);
  if (start < 0) return out;
  const sig = emaSeries(line.slice(start) as number[], signal);
  sig.forEach((x, j) => {
    if (x !== null) out[start + j] = line[start + j]! - x;
  });
  return out;
}

/** Supertrend direction per bar (+1 up, -1 down; null during warm-up), ATR by Wilder smoothing. */
export function supertrendSeries(cs: Candle[], n: number, mult: number): (1 | -1 | null)[] {
  const out: (1 | -1 | null)[] = cs.map(() => null);
  if (cs.length <= n) return out;
  const tr = cs.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - cs[i - 1].c), Math.abs(x.l - cs[i - 1].c))));
  let atr = tr.slice(1, n + 1).reduce((a, b) => a + b, 0) / n;
  let upper = 0, lower = 0;
  let dir: 1 | -1 = 1;
  for (let i = n; i < cs.length; i++) {
    if (i > n) atr = (atr * (n - 1) + tr[i]) / n;
    const mid = (cs[i].h + cs[i].l) / 2;
    const bu = mid + mult * atr;
    const bl = mid - mult * atr;
    const prevC = cs[i - 1].c;
    upper = i === n || bu < upper || prevC > upper ? bu : upper;
    lower = i === n || bl > lower || prevC < lower ? bl : lower;
    if (i === n) dir = cs[i].c >= mid ? 1 : -1;
    else if (dir === 1 && cs[i].c < lower) dir = -1;
    else if (dir === -1 && cs[i].c > upper) dir = 1;
    out[i] = dir;
  }
  return out;
}

/** Position of the last close inside the swing of the last `lookback` bars: 0 = swing low, 1 = high. */
export function fibPosition(cs: Candle[], lookback: number): { pos: number; nearest: number; swingUp: boolean } | null {
  const w = cs.slice(-lookback);
  if (w.length < 5) return null;
  let hi = -Infinity, lo = Infinity, iHi = 0, iLo = 0;
  w.forEach((x, i) => {
    if (x.h > hi) (hi = x.h), (iHi = i);
    if (x.l < lo) (lo = x.l), (iLo = i);
  });
  if (hi <= lo) return null;
  const pos = (w[w.length - 1].c - lo) / (hi - lo);
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const nearest = levels.reduce((b, l) => (Math.abs(l - pos) < Math.abs(b - pos) ? l : b), 0);
  return { pos, nearest, swingUp: iLo < iHi };
}

/** Complete higher-timeframe candles from 5m candles (aligned to the bucket; incomplete groups dropped). */
export function aggregate(cs: Candle[], fromMs: number, toMs: number): Candle[] {
  const k = toMs / fromMs;
  const groups = new Map<number, Candle[]>();
  for (const x of cs) {
    const b = Math.floor(x.ts / toMs) * toMs;
    (groups.get(b) ?? groups.set(b, []).get(b)!).push(x);
  }
  const out: Candle[] = [];
  for (const [ts, g] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (g.length < k) continue;
    g.sort((a, b) => a.ts - b.ts);
    out.push({ ts, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[g.length - 1].c });
  }
  return out;
}

export interface TfSnapshot {
  bars: number;
  rsi: number | null;
  rsiRecent: (number | null)[]; // last filter_lookback_bars + 1 values, oldest first
  pctB: number | null;
  pctBRecent: (number | null)[];
  stDir: 1 | -1 | null;
  /** bars since the Supertrend direction last changed (0 = flipped on the last bar; a lower bound when no flip is in the data) */
  stBarsSinceFlip: number | null;
  fib: ReturnType<typeof fibPosition>;
}

export function snapshotOf(cs: Candle[], ic: Config["indicators"]): TfSnapshot {
  const closes = cs.map((x) => x.c);
  const rsi = rsiSeries(closes, ic.rsi_period);
  const pb = pctBSeries(closes, ic.bb_period, ic.bb_k);
  const st = supertrendSeries(cs, ic.st_period, ic.st_mult);
  const L = ic.filter_lookback_bars + 1;
  let flip: number | null = null;
  const last = st[st.length - 1];
  if (last !== null && last !== undefined) {
    flip = 0;
    // bars in the current direction; when it never flipped within the data this is a lower bound
    // (every bar since the warm-up), which is still "no recent break" for the entry filter
    for (let i = st.length - 2; i >= 0 && st[i] === last; i--) flip++;
  }
  return {
    bars: cs.length,
    rsi: rsi[rsi.length - 1] ?? null,
    rsiRecent: rsi.slice(-L),
    pctB: pb[pb.length - 1] ?? null,
    pctBRecent: pb.slice(-L),
    stDir: last ?? null,
    stBarsSinceFlip: flip,
    fib: fibPosition(cs, ic.fib_lookback),
  };
}

/**
 * Indicator snapshots of a pool at t, look-ahead safe: only candles whose bucket ended at or before
 * t (ts + timeframe <= t). 5m candles come from the API OHLCV we store; 15m / 30m are aggregated
 * from them. Cached per pool and 5-minute bucket. Revisions of a candle by the API after t are a
 * small known leak (the collector refreshes its last 30 min).
 */
export class IndicatorLookup {
  private cache = new Map<string, Record<string, TfSnapshot> | null>();
  constructor(private readonly db: Db, private readonly ic: Config["indicators"]) {}

  /** The last `bars` complete candles of a timeframe at t (5m stored, others aggregated), oldest first. */
  candles(pool: string, t: number, timeframe: string, bars: number): Candle[] {
    const tf = TF_MS[timeframe];
    if (!tf) return [];
    const k = `c|${pool}|${timeframe}|${bars}|${Math.floor(t / TF_MS["5m"])}`;
    const hit = this.candleCache.get(k);
    if (hit) return hit;
    const rows = this.db.all<Candle>(
      "SELECT ts, o, h, l, c FROM ohlcv WHERE pool = ? AND timeframe = '5m' AND ts >= ? AND ts + 300000 <= ? ORDER BY ts", pool, t - (bars + 2) * tf, t,
    ).filter((r) => r.c !== null && r.h !== null && r.l !== null);
    const out = (timeframe === "5m" ? rows : aggregate(rows, TF_MS["5m"], tf).filter((x) => x.ts + tf <= t)).slice(-bars);
    if (this.candleCache.size > 20_000) this.candleCache.clear();
    this.candleCache.set(k, out);
    return out;
  }

  private candleCache = new Map<string, Candle[]>();

  at(pool: string, t: number): Record<string, TfSnapshot> | null {
    const b = Math.floor(t / TF_MS["5m"]);
    const k = `${pool}|${b}`;
    if (this.cache.has(k)) return this.cache.get(k)!;
    const maxTf = Math.max(...this.ic.timeframes.map((x) => TF_MS[x]));
    const need = Math.max(this.ic.rsi_period * 3, this.ic.bb_period, this.ic.st_period * 3, this.ic.fib_lookback) + this.ic.filter_lookback_bars + 2;
    const from = t - (need + 2) * maxTf;
    const rows = this.db.all<Candle>(
      "SELECT ts, o, h, l, c FROM ohlcv WHERE pool = ? AND timeframe = '5m' AND ts >= ? AND ts + 300000 <= ? ORDER BY ts", pool, from, t,
    ).filter((r) => r.c !== null && r.h !== null && r.l !== null);
    let out: Record<string, TfSnapshot> | null = null;
    if (rows.length) {
      out = {};
      for (const tf of this.ic.timeframes) {
        const cs = tf === "5m" ? rows : aggregate(rows, TF_MS["5m"], TF_MS[tf]).filter((x) => x.ts + TF_MS[tf] <= t);
        out[tf] = snapshotOf(cs, this.ic);
      }
    }
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(k, out);
    return out;
  }
}

export type EntryFilter = "none" | "supertrend_break" | "rsi_reversal" | "bollinger_reversion";

/**
 * Entry filter presets (grid dimension entry_filter) on the filter timeframe:
 *  - supertrend_break: Supertrend turned up within the last filter_lookback_bars bars;
 *  - rsi_reversal: RSI left an extreme (< rsi_low or > rsi_high) within the lookback and is back
 *    inside the band now (a range LP wants the move to fade);
 *  - bollinger_reversion: price closed outside the bands within the lookback and is back inside.
 * No indicator data -> not passed ("no_data"): the filter cannot be judged.
 */
export function entryFilterPass(f: EntryFilter, snaps: Record<string, TfSnapshot> | null, ic: Config["indicators"]): { pass: boolean; reason: string } {
  if (f === "none") return { pass: true, reason: "none" };
  const s = snaps?.[ic.filter_timeframe];
  if (!s) return { pass: false, reason: "no_data" };
  const L = ic.filter_lookback_bars;
  if (f === "supertrend_break") {
    if (s.stDir === null || s.stBarsSinceFlip === null) return { pass: false, reason: "no_data" };
    return s.stDir === 1 && s.stBarsSinceFlip < L ? { pass: true, reason: "supertrend turned up" } : { pass: false, reason: "no fresh supertrend up-break" };
  }
  if (f === "rsi_reversal") {
    const r = s.rsiRecent;
    if (r.some((x) => x === null) || r.length < L + 1) return { pass: false, reason: "no_data" };
    const now = r[r.length - 1]!;
    const prev = r.slice(0, -1) as number[];
    const wasExtreme = prev.some((x) => x < ic.rsi_low || x > ic.rsi_high);
    return wasExtreme && now >= ic.rsi_low && now <= ic.rsi_high ? { pass: true, reason: "RSI back from an extreme" } : { pass: false, reason: "no RSI reversal" };
  }
  const b = s.pctBRecent;
  if (b.some((x) => x === null) || b.length < L + 1) return { pass: false, reason: "no_data" };
  const now = b[b.length - 1]!;
  const prev = b.slice(0, -1) as number[];
  return prev.some((x) => x < 0 || x > 1) && now >= 0 && now <= 1 ? { pass: true, reason: "back inside the Bollinger bands" } : { pass: false, reason: "no band reversion" };
}
