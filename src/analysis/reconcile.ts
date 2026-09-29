import type { Db } from "../db/index.ts";
import type { MeteoraApi } from "../api/meteora.ts";
import { loadPoolMeta } from "../collectors/discovery.ts";
import { loadBinSnapshots } from "../sim/replay.ts";
import { poolFeeFromAccumulators } from "../sim/feeAttribution.ts";
import type { RpcClient } from "../chain/rpc.ts";
import { chainSwapCensus } from "./swapAudit.ts";

const BUCKET_MS = 300_000;

/** Step-function USD price series from API pool snapshots (value at or before t). */
export class PriceSeries {
  private ts: number[] = [];
  private x: number[] = [];
  private y: number[] = [];
  constructor(rows: { ts: number; token_x_usd: number | null; token_y_usd: number | null }[]) {
    for (const r of rows) {
      if (r.token_x_usd == null || r.token_y_usd == null) continue;
      this.ts.push(r.ts);
      this.x.push(r.token_x_usd);
      this.y.push(r.token_y_usd);
    }
  }
  at(t: number): { x: number; y: number } | null {
    if (!this.ts.length) return null;
    let lo = 0;
    let hi = this.ts.length - 1;
    if (t <= this.ts[0]) return { x: this.x[0], y: this.y[0] };
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.ts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return { x: this.x[lo], y: this.y[lo] };
  }
}

export interface ReconcileResult {
  pool: string;
  name: string;
  from: string;
  to: string;
  minutes: number;
  api: { feesUsd: number; protocolFeesUsd: number; volumeUsd: number; buckets: number };
  accumulator: { lpFeeUsd: number; snapshots: number; coverageMinutes: number; scale: number; diffPct: number | null };
  swaps: { count: number; lpFeeUsd: number; totalFeeUsd: number; protocolFeeUsd: number; volumeUsd: number; lpDiffPct: number | null; volumeDiffPct: number | null; gapMinutes: number };
  /** on-chain ground truth (every transaction fetched), when requested */
  census: { swaps: number; txs: number; lpFeeUsd: number; truncated: boolean; accumDiffPct: number | null; apiDiffPct: number | null } | null;
  /** reference used for pass/fail: census when available, else API */
  reference: "census" | "api";
  passed: boolean | null;
  notes: string[];
}

const diff = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : null);

/**
 * Fee reconciliation (blueprint 12.7): LP fees implied by our data, as if we owned 100% of the
 * liquidity, vs the fees the Meteora Data API reports for the same 5-minute buckets.
 * API `fees` is the LP share (total minus protocol), verified: fees/protocol_fees = (1-s)/s.
 */
export async function reconcilePool(
  db: Db,
  api: MeteoraApi,
  pool: string,
  fromMs: number,
  toMs: number,
  tolerancePct: number,
  sessionId?: string,
  censusRpc?: RpcClient,
): Promise<ReconcileResult> {
  const meta = loadPoolMeta(db, pool);
  if (!meta) throw new Error(`unknown pool ${pool}`);
  const notes: string[] = [];
  const from = Math.ceil(fromMs / BUCKET_MS) * BUCKET_MS;
  const to = Math.floor(toMs / BUCKET_MS) * BUCKET_MS;
  if (to <= from) throw new Error("window shorter than one 5-minute bucket");

  // --- API buckets fully inside [from, to)
  const pts = await api.volumeHistory(pool, "5m", from / 1000, to / 1000 - 1);
  const inWin = pts.filter((p) => p.timestamp * 1000 >= from && p.timestamp * 1000 < to);
  const apiRes = {
    feesUsd: inWin.reduce((s, p) => s + p.fees, 0),
    protocolFeesUsd: inWin.reduce((s, p) => s + p.protocol_fees, 0),
    volumeUsd: inWin.reduce((s, p) => s + p.volume, 0),
    buckets: inWin.length,
  };
  if (inWin.length !== (to - from) / BUCKET_MS) notes.push(`API returned ${inWin.length} of ${(to - from) / BUCKET_MS} buckets`);

  const prices = new PriceSeries(
    db.all("SELECT ts, token_x_usd, token_y_usd FROM pool_snapshots WHERE pool = ? AND source = 'api' AND ts BETWEEN ? AND ? ORDER BY ts", pool, from - 900_000, to + 900_000),
  );
  const usd = (fxRaw: number, fyRaw: number, t: number) => {
    const p = prices.at(t);
    if (!p) return NaN;
    return (fxRaw / 10 ** meta.decimalsX) * p.x + (fyRaw / 10 ** meta.decimalsY) * p.y;
  };

  // --- accumulator method: snapshot pairs covering the window
  const snaps = loadBinSnapshots(db, pool, from - 60_000, to + 60_000, meta.binStep);
  const inside = snaps.filter((s) => s.ts >= from - 30_000 && s.ts <= to + 30_000);
  let acc = 0;
  let pairs = 0;
  let covered = 0;
  for (let i = 1; i < inside.length; i++) {
    const a = inside[i - 1];
    const b = inside[i];
    // clip the pair to the window
    const lo = Math.max(a.ts, from);
    const hi = Math.min(b.ts, to);
    if (hi <= lo) continue;
    const frac = (hi - lo) / (b.ts - a.ts);
    const f = poolFeeFromAccumulators(a.bins, b.bins);
    acc += usd(f.fx, f.fy, b.ts) * frac;
    covered += hi - lo;
    pairs++;
  }
  const scale = covered > 0 ? (to - from) / covered : 0;
  if (scale > 1.05) notes.push(`bin snapshots cover only ${((covered / (to - from)) * 100).toFixed(1)}% of the window (scaled)`);
  const accLp = acc * scale;

  // --- swap events
  const sw = db.all<{ ts: number; swap_for_y: number; amount_in: string; fee: string; protocol_fee: string; mm_fee: string; fees_on_token_x: number }>(
    "SELECT ts, swap_for_y, amount_in, fee, protocol_fee, mm_fee, fees_on_token_x FROM swaps WHERE pool = ? AND ts >= ? AND ts < ?", pool, from, to,
  );
  let lp = 0, tot = 0, prot = 0, vol = 0;
  for (const s of sw) {
    const onX = s.fees_on_token_x === 1;
    const f = (v: string) => (onX ? usd(Number(v), 0, s.ts) : usd(0, Number(v), s.ts));
    lp += f(s.mm_fee);
    tot += f(s.fee);
    prot += f(s.protocol_fee);
    vol += s.swap_for_y === 1 ? usd(Number(s.amount_in), 0, s.ts) : usd(0, Number(s.amount_in), s.ts);
  }
  let gapMinutes = 0;
  if (sessionId) {
    for (const g of db.all<{ start_at: number; end_at: number | null }>(
      "SELECT start_at, end_at FROM data_gaps WHERE session_id = ? AND source = 'swap_stream' AND (pool = ? OR pool IS NULL)", sessionId, pool,
    )) {
      const lo = Math.max(from, g.start_at);
      const hi = Math.min(to, g.end_at ?? to);
      if (hi > lo) gapMinutes += (hi - lo) / 60000;
    }
    if (gapMinutes > 0) notes.push(`swap stream has ${gapMinutes.toFixed(1)} gap minutes in the window; swap sums are incomplete`);
  }
  const accDiff = diff(accLp, apiRes.feesUsd);
  let census: ReconcileResult["census"] = null;
  if (censusRpc) {
    const c = await chainSwapCensus(db, censusRpc, pool, from, to);
    let cl = 0;
    for (const sw of c.swaps) {
      const onX = sw.feesOnTokenX ?? (meta.collectFeeMode === 1 ? false : sw.swapForY);
      cl += onX ? usd(Number(sw.mmFee), 0, sw.ts) : usd(0, Number(sw.mmFee), sw.ts);
    }
    census = { swaps: c.swaps.length, txs: c.successfulTxs, lpFeeUsd: cl, truncated: c.truncated, accumDiffPct: diff(accLp, cl), apiDiffPct: diff(apiRes.feesUsd, cl) };
    if (c.truncated) notes.push("census truncated (maxTx)");
  }
  const reference = census && !census.truncated ? "census" : "api";
  const refDiff = reference === "census" ? census!.accumDiffPct : accDiff;
  const passed = refDiff === null ? null : Math.abs(refDiff) <= tolerancePct;
  if (apiRes.feesUsd <= 0) notes.push("API reports zero fees in the window; cannot reconcile");
  return {
    pool,
    name: meta.name,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    minutes: (to - from) / 60000,
    api: apiRes,
    accumulator: { lpFeeUsd: accLp, snapshots: pairs + 1, coverageMinutes: covered / 60000, scale, diffPct: accDiff },
    census,
    reference,
    swaps: { count: sw.length, lpFeeUsd: lp, totalFeeUsd: tot, protocolFeeUsd: prot, volumeUsd: vol, lpDiffPct: diff(lp, apiRes.feesUsd), volumeDiffPct: diff(vol, apiRes.volumeUsd), gapMinutes },
    passed,
    notes,
  };
}

/** Store a reconciliation result so session reports can show it (reconcile_results). */
export function saveReconcile(db: Db, dataSessionId: string, r: ReconcileResult) {
  db.insert(
    "reconcile_results",
    {
      session_id: dataSessionId, pool: r.pool, window_from: Date.parse(r.from), window_to: Date.parse(r.to), reference: r.reference,
      api_fee_usd: r.api.feesUsd, accum_fee_usd: r.accumulator.lpFeeUsd, accum_diff_pct: r.accumulator.diffPct,
      census_fee_usd: r.census?.lpFeeUsd ?? null, census_diff_pct: r.census?.accumDiffPct ?? null,
      passed: r.passed === null ? null : r.passed ? 1 : 0, detail: JSON.stringify(r), created_at: Date.now(),
    },
    "OR REPLACE",
  );
}

/**
 * Reconcile every pool of a data session against the API (cheap: one API call per pool) and store
 * the results. The newest `api_lag_minutes` are excluded because the API buckets are still filling.
 */
export async function reconcileSession(db: Db, api: MeteoraApi, sessionId: string, fromMs: number, toMs: number, tolerancePct: number) {
  const pools = db.all<{ pool: string }>("SELECT pool FROM session_pools WHERE session_id = ? ORDER BY rank", sessionId).map((r) => r.pool);
  const out: ReconcileResult[] = [];
  for (const p of pools) {
    try {
      const r = await reconcilePool(db, api, p, fromMs, toMs, tolerancePct, sessionId);
      saveReconcile(db, sessionId, r);
      out.push(r);
    } catch {
      /* window too short or pool without data: skip */
    }
  }
  return out;
}
