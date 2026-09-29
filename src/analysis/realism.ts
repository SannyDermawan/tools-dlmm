import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import { loadPoolMeta } from "../collectors/discovery.ts";
import { transferFeeLookup } from "../features/safetyData.ts";
import { MemorySink, PoolSimulator } from "../sim/engine.ts";
import type { PositionSpec } from "../sim/position.ts";
import { loadReplay } from "../sim/replay.ts";
import { dispatch } from "../sim/replayRunner.ts";
import type { Sides, Strategy } from "../config/schema.ts";

/** Bins between a one-sided range and the price still counted as "at the price" (price moves between our snapshot and the open). */
const DETACH_TOLERANCE = 3;

export interface RealRow {
  position: string;
  pool: string;
  opened_at: number;
  closed_at: number;
  lower_bin: number;
  upper_bin: number;
  shape: Strategy | null;
  sides: Sides | null;
  deposit_usd: number;
  deposit_x_usd: number | null;
  fee_usd: number;
  net_pnl_usd: number;
  open_active_bin: number | null;
}

/**
 * Simulator spec for a real position: the range relative to the active bin at open (our data),
 * its shape (spot when unknown), sides from the deposits, capital = deposit. Returns a reason
 * string when the position cannot be replayed one-to-one.
 */
export function realSpec(r: RealRow): { spec: PositionSpec } | { skip: string } {
  const a = r.open_active_bin;
  if (a === null) return { skip: "no pool state at open" };
  if (!r.sides) return { skip: "unknown sides" };
  if (!(r.deposit_usd > 0)) return { skip: "no deposit" };
  let binsBelow: number, binsAbove: number;
  if (r.sides === "two_sided") {
    if (a < r.lower_bin || a > r.upper_bin) return { skip: "active bin outside a two-sided range" };
    binsBelow = a - r.lower_bin;
    binsAbove = r.upper_bin - a;
  } else if (r.sides === "quote_only") {
    // quote can only sit at or below the price: bins of the range above it stay empty, so a range
    // reaching past the price is replayed as [lower, active]. A range ending more than
    // DETACH_TOLERANCE bins below the price (a limit-order-like deposit) is not replayable 1:1.
    if (r.upper_bin < a - DETACH_TOLERANCE) return { skip: "quote-only range detached from the price" };
    binsBelow = a - r.lower_bin;
    binsAbove = 0;
    if (binsBelow < 0) return { skip: "quote-only range above the price" };
  } else {
    if (r.lower_bin > a + DETACH_TOLERANCE) return { skip: "base-only range detached from the price" };
    binsBelow = 0;
    binsAbove = r.upper_bin - a;
    if (binsAbove < 0) return { skip: "base-only range below the price" };
  }
  return {
    spec: {
      strategy: r.shape ?? "spot", sides: r.sides, binsBelow, binsAbove, capitalUsd: r.deposit_usd,
      entryMode: "realism_check", exitPolicy: { type: "hold_to_session_end" } as never, combo: { real_position: r.position, shape_known: r.shape !== null },
    },
  };
}

export interface RealismResult {
  checked: number;
  skipped: number;
  byReason: Record<string, number>;
  feeDiffMedianPct: number | null;
  feeDiffMeanAbsPct: number | null;
  pnlDiffMeanAbsPp: number | null;
  pnlDiffMeanPp: number | null;
}

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

/**
 * A relative fee difference is only meaningful when the real fee is material: a position that
 * earned $0.0001 turns a $0.02 simulator fee into +20,000%. Below this share of the deposit the
 * check still counts in the percentage-point columns, which never blow up.
 */
export const MATERIAL_FEE_SHARE = 0.0001; // 0.01% of the deposit
export const MATERIAL_FEE_MIN_USD = 0.01;

/**
 * Addendum 4.3 (2): replay real, simple positions (one add, removed only at the close) whose whole
 * life lies inside one of our data sessions, with the same range, shape, sides and capital, and
 * compare fee and PnL. Simulator PnL is taken before costs (the Meteora PnL ignores tx fees and
 * rent). Positions already checked are skipped unless `recheck`.
 */
export function runRealismChecks(db: Db, c: Config, o: { dataSessionId?: string; recheck?: boolean; now?: number } = {}): RealismResult {
  const now = o.now ?? Date.now();
  const rc = c.real_lp.realism;
  const sessions = db.all<{ session_id: string; start_at: number; end_at: number }>(
    `SELECT session_id, start_at, COALESCE(end_at, ?) end_at FROM sessions WHERE kind IN ('collect', 'session') ${o.dataSessionId ? "AND session_id = ?" : ""}`,
    now, ...(o.dataSessionId ? [o.dataSessionId] : []),
  );
  const res: RealismResult = { checked: 0, skipped: 0, byReason: {}, feeDiffMedianPct: null, feeDiffMeanAbsPct: null, pnlDiffMeanAbsPp: null, pnlDiffMeanPp: null };
  const skip = (r: RealRow, sid: string, reason: string) => {
    res.skipped++;
    res.byReason[reason] = (res.byReason[reason] ?? 0) + 1;
    db.insert("sim_realism_checks", { ts: now, real_position: r.position, pool: r.pool, data_session_id: sid, status: "skipped", reason });
  };
  for (const s of sessions) {
    const rows = db.all<RealRow>(
      `SELECT r.position, r.pool, r.opened_at, r.closed_at, r.lower_bin, r.upper_bin, r.shape, r.sides, r.deposit_usd, r.deposit_x_usd,
              r.fee_usd, r.net_pnl_usd, r.open_active_bin
       FROM real_lp_positions r JOIN session_pools sp ON sp.pool = r.pool AND sp.session_id = ?
       WHERE r.is_closed = 1 AND r.simple = 1 AND r.opened_at >= ? AND r.closed_at <= ?
         AND r.closed_at - r.opened_at >= ?
         ${o.recheck ? "" : "AND NOT EXISTS (SELECT 1 FROM sim_realism_checks k WHERE k.real_position = r.position)"}
       ORDER BY r.closed_at LIMIT ?`,
      s.session_id, s.start_at + 60_000, s.end_at, rc.min_duration_minutes * 60_000, rc.max_checks,
    );
    for (const r of rows) {
      const gap = db.get(
        `SELECT 1 x FROM data_gaps WHERE session_id = ? AND (pool = ? OR pool IS NULL) AND source IN ('pool_state', 'bin_snapshot')
           AND start_at < ? AND COALESCE(end_at, ?) > ? LIMIT 1`,
        s.session_id, r.pool, r.closed_at, now, r.opened_at,
      );
      if (gap) {
        skip(r, s.session_id, "data gap in the window");
        continue;
      }
      const sp = realSpec(r);
      if ("skip" in sp) {
        skip(r, s.session_id, sp.skip);
        continue;
      }
      const meta = loadPoolMeta(db, r.pool);
      if (!meta) {
        skip(r, s.session_id, "pool meta missing");
        continue;
      }
      const cfg = structuredClone(c);
      cfg.simulation.entry_delay_seconds = 0;
      cfg.simulation.exit_to = "none";
      // real LPs deposit the tokens they hold: no balancing swap in the replay
      cfg.simulation.starting_asset = "as_needed";
      // same token split as the real deposit when it is known
      if (r.sides === "two_sided" && r.deposit_x_usd !== null && r.deposit_usd > 0) cfg.simulation.two_sided_x_value_fraction = Math.min(1, Math.max(0, r.deposit_x_usd / r.deposit_usd));
      const sink = new MemorySink();
      const sim = new PoolSimulator(meta, cfg, sink, () => `real-${r.position}`);
      const feeOf = transferFeeLookup(db);
      sim.transferFeeBps = (token) => feeOf(token, r.opened_at);
      const sims = new Map([[r.pool, sim]]);
      const events = loadReplay(db, {
        pools: [r.pool], from: s.start_at, to: r.closed_at,
        binSteps: new Map([[r.pool, meta.binStep]]), collectFeeModes: new Map([[r.pool, meta.collectFeeMode]]), sessionId: s.session_id,
      });
      const stable = new Set(cfg.categories.usd_stable_tokens);
      let requested = false;
      for (const e of events) {
        if (!requested && e.ts >= r.opened_at) {
          sim.request(sp.spec, r.opened_at);
          requested = true;
        }
        dispatch(e, sims, null, cfg, stable);
      }
      const p = sim.list()[0];
      if (!p || p.status !== "active") {
        skip(r, s.session_id, p ? `simulator position ${p.status}${p.failReason ? `: ${p.failReason}` : ""}` : "no data after the open");
        continue;
      }
      const out = sim.close(p.id, "realism_check", r.closed_at)!;
      const simPnl = out.netPnlUsd + out.costUsd; // before costs
      // after costs: the real position paid the same open / close transactions (same bins, same
      // priority fee); rent is refunded on both sides. Composition fees are only known for the sim.
      const txUsd = p.costs.filter((x) => x.type === "tx_open" || x.type === "tx_close").reduce((s2, x) => s2 + x.usd, 0);
      const realAfter = r.net_pnl_usd - txUsd;
      const simAfter = out.netPnlUsd;
      const feeDiff = r.fee_usd > 0 ? ((out.feeUsd - r.fee_usd) / r.fee_usd) * 100 : null;
      const pnlDiffPp = ((simPnl - r.net_pnl_usd) / r.deposit_usd) * 100;
      db.insert("sim_realism_checks", {
        ts: now, real_position: r.position, pool: r.pool, data_session_id: s.session_id, spec: JSON.stringify(sp.spec),
        real_fee_usd: r.fee_usd, sim_fee_usd: out.feeUsd, fee_diff_pct: feeDiff, real_pnl_usd: r.net_pnl_usd, sim_pnl_usd: simPnl,
        pnl_diff_pct: pnlDiffPp, status: "ok", reason: null,
        sim_pnl_after_costs_usd: simAfter, real_pnl_after_costs_usd: realAfter, pnl_after_costs_diff_pct: ((simAfter - realAfter) / r.deposit_usd) * 100,
      });
      res.checked++;
    }
  }
  Object.assign(res, realismSummary(db));
  return res;
}

/**
 * Aggregate of the stored checks (latest per real position). `shapeKnown`: true = only positions
 * whose distribution shape was read on chain (the headline), false = shape unknown (replayed as
 * spot, which misprices one-sided bid-ask deposits badly), undefined = all.
 */
export function realismSummary(db: Db, dataSessionId?: string, shapeKnown?: boolean) {
  const shapeCond = shapeKnown === undefined ? "" : `AND json_extract(k.spec, '$.combo.shape_known') = ${shapeKnown ? 1 : 0}`;
  const rows = db.all<{ fee: number | null; pnl: number | null; after: number | null; real_fee: number | null; sim_fee: number | null; deposit: number | null }>(
    `SELECT fee_diff_pct fee, pnl_diff_pct pnl, pnl_after_costs_diff_pct after, real_fee_usd real_fee, sim_fee_usd sim_fee,
            json_extract(k.spec, '$.capitalUsd') deposit
     FROM sim_realism_checks k
     WHERE status = 'ok' ${shapeCond} ${dataSessionId ? "AND data_session_id = ?" : ""}
       AND id = (SELECT MAX(id) FROM sim_realism_checks k2 WHERE k2.real_position = k.real_position AND k2.status = 'ok')`,
    ...(dataSessionId ? [dataSessionId] : []),
  );
  const material = (r: (typeof rows)[number]) =>
    r.real_fee !== null && r.deposit !== null && r.real_fee >= Math.max(MATERIAL_FEE_MIN_USD, r.deposit * MATERIAL_FEE_SHARE);
  const fee = rows.filter(material).map((r) => r.fee).filter((x): x is number => x !== null);
  // fee difference in percentage points of the deposit: robust for tiny real fees
  const feePp = rows
    .filter((r) => r.real_fee !== null && r.sim_fee !== null && r.deposit)
    .map((r) => ((r.sim_fee! - r.real_fee!) / r.deposit!) * 100);
  const pnl = rows.map((r) => r.pnl).filter((x): x is number => x !== null);
  const after = rows.map((r) => r.after).filter((x): x is number => x !== null);
  return {
    n: rows.length,
    feeMaterialN: fee.length,
    feeDiffMedianPct: median(fee),
    feeDiffMeanAbsPct: mean(fee.map(Math.abs)),
    feeDiffMeanAbsPp: mean(feePp.map(Math.abs)),
    pnlDiffMeanAbsPp: mean(pnl.map(Math.abs)),
    pnlDiffMeanPp: mean(pnl),
    afterCostsDiffMeanPp: mean(after),
    afterCostsDiffMeanAbsPp: mean(after.map(Math.abs)),
  };
}

export function realismMarkdown(db: Db, dataSessionId?: string): string {
  const all = realismSummary(db, dataSessionId);
  const real = db.get<{ n: number; closed: number; simple: number }>(
    `SELECT COUNT(*) n, SUM(is_closed) closed, SUM(simple = 1) simple FROM real_lp_positions r
     ${dataSessionId ? "WHERE r.pool IN (SELECT pool FROM session_pools WHERE session_id = ?)" : ""}`,
    ...(dataSessionId ? [dataSessionId] : []),
  )!;
  const smart = db.get<{ n: number; smart: number }>("SELECT COUNT(*) n, SUM(status_smart) smart FROM lp_wallets")!;
  const f = (v: number | null, d = 1) => (v === null ? "-" : v.toFixed(d));
  const out = [
    `Real LP positions stored${dataSessionId ? " (pools of this session)" : ""}: ${real.n} (${real.closed ?? 0} closed, ${real.simple ?? 0} simple). Wallets: ${smart.n} (${smart.smart ?? 0} smart LP).`,
    "",
  ];
  if (!all.n) out.push("No realism check yet (needs simple real positions whose whole life lies inside our data; run `dlmm lp realism`).");
  else {
    out.push("| positions | checks | fee diff median (%) | fee diff mean abs (%) | fee diff mean abs (pp) | PnL diff before costs (pp) | mean abs (pp) | PnL diff after costs (pp) | mean abs (pp) |\n|---|--:|--:|--:|--:|--:|--:|--:|--:|");
    for (const [label, s] of [["shape known (headline)", realismSummary(db, dataSessionId, true)], ["shape unknown (run as spot)", realismSummary(db, dataSessionId, false)]] as const) {
      if (!s.n) continue;
      out.push(`| ${label} | ${s.n} | ${f(s.feeDiffMedianPct)}% (n=${s.feeMaterialN}) | ${f(s.feeDiffMeanAbsPct)}% | ${f(s.feeDiffMeanAbsPp, 3)} | ${f(s.pnlDiffMeanPp, 2)} | ${f(s.pnlDiffMeanAbsPp, 2)} | ${f(s.afterCostsDiffMeanPp, 2)} | ${f(s.afterCostsDiffMeanAbsPp, 2)} |`);
    }
    out.push("");
    out.push(`Fee % columns use only checks whose real fee is at least ${MATERIAL_FEE_SHARE * 100}% of the deposit (and $${MATERIAL_FEE_MIN_USD}); smaller fees make relative differences meaningless. The pp columns use every check.`);
    out.push("");
    out.push("Diff = simulator minus real, in percentage points of the deposit. Before costs: the Meteora PnL has no tx fees or rent. After costs: both sides pay the same open / close transactions, the simulator also its composition fee; no balancing swap (real LPs deposit what they hold). Positions with an unknown shape run as spot.");
  }
  return out.join("\n");
}
