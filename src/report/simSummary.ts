import type { Db } from "../db/index.ts";

interface Row {
  strategy: string;
  sides: string;
  bins: number;
  n: number;
  win: number;
  avg_net_pct: number;
  avg_fee: number;
  avg_il: number;
  avg_cost: number;
  avg_in_range: number;
  tainted: number;
}

/** Per grid-dimension table for a sim session (a single session is NOT statistically significant). */
export function printSimSummary(db: Db, sessionId: string) {
  const tot = db.get<{ n: number; closed: number; failed: number; tainted: number }>(
    `SELECT COUNT(*) n, SUM(status='closed') closed, SUM(status='failed') failed, SUM(gap_tainted) tainted
     FROM sim_positions WHERE session_id = ?`, sessionId,
  )!;
  console.log(`\nsim session ${sessionId}: ${tot.n} positions, ${tot.closed} closed, ${tot.failed} failed, ${tot.tainted} gap-tainted`);
  const fails = db.all<{ close_reason: string; n: number }>(
    "SELECT close_reason, COUNT(*) n FROM sim_positions WHERE session_id = ? AND status='failed' GROUP BY close_reason", sessionId,
  );
  for (const f of fails) console.log(`  failed: ${f.close_reason} x${f.n}`);
  const q = (expr: string) =>
    db.all<Row>(
      `SELECT ${expr} AS k, COUNT(*) n, AVG(r.net_pnl_usd > 0) win, AVG(r.net_pnl_pct) avg_net_pct, AVG(r.fee_usd) avg_fee,
              AVG(r.il_usd) avg_il, AVG(r.cost_usd) avg_cost, AVG(r.time_in_range_pct) avg_in_range, SUM(p.gap_tainted) tainted
       FROM sim_positions p JOIN sim_results r USING(position_id)
       WHERE p.session_id = ? GROUP BY k ORDER BY avg_net_pct DESC`,
      sessionId,
    );
  const fmt = (r: Row, key: string) =>
    `  ${key.padEnd(24)} n=${String(r.n).padStart(4)} win=${(r.win * 100).toFixed(0).padStart(3)}% net=${r.avg_net_pct.toFixed(3).padStart(8)}% fee=$${r.avg_fee.toFixed(3).padStart(8)} il=$${r.avg_il.toFixed(3).padStart(9)} cost=$${r.avg_cost.toFixed(3).padStart(7)} inRange=${r.avg_in_range.toFixed(0).padStart(3)}%`;
  for (const [title, g] of [["strategy", "p.strategy"], ["sides", "p.sides"], ["bins_below+above", "p.bins_below + p.bins_above"]] as const) {
    console.log(`\n  by ${title}`);
    for (const r of q(g)) console.log(fmt(r, String((r as unknown as { k: unknown }).k)));
  }
  console.log(`\n  by pool`);
  for (const r of db.all<Row & { name: string }>(
    `SELECT pl.name, COUNT(*) n, AVG(r.net_pnl_usd > 0) win, AVG(r.net_pnl_pct) avg_net_pct, AVG(r.fee_usd) avg_fee, AVG(r.il_usd) avg_il,
            AVG(r.cost_usd) avg_cost, AVG(r.time_in_range_pct) avg_in_range, SUM(p.gap_tainted) tainted
     FROM sim_positions p JOIN sim_results r USING(position_id) JOIN pools pl ON pl.pool = p.pool
     WHERE p.session_id = ? GROUP BY p.pool ORDER BY avg_net_pct DESC`, sessionId,
  )) console.log(fmt(r, r.name.slice(0, 24)));
  console.log("\n  NOTE: one session proves nothing; judge strategies across many sessions (blueprint 13.4).");
}
