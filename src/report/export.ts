import { createWriteStream, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Db } from "../db/index.ts";

/** Tables exportable per session and the query that selects the session's rows. */
export const EXPORTS: Record<string, string> = {
  positions: `SELECT p.*, r.fee_usd, r.fee_x_ui, r.fee_y_ui, r.il_usd, r.cost_usd, r.rent_locked_usd, r.net_pnl_usd, r.net_pnl_pct,
                     r.time_in_range_pct, r.duration_min, r.max_drawdown_usd, r.max_drawdown_pct, r.final_value_usd, r.hodl_value_usd,
                     r.entry_price, r.exit_price, r.detail AS result_detail, pl.name AS pool_name, pl.category
              FROM sim_positions p LEFT JOIN sim_results r USING(position_id) LEFT JOIN pools pl ON pl.pool = p.pool WHERE p.session_id = ?1`,
  position_events: `SELECT e.* FROM sim_position_events e JOIN sim_positions p USING(position_id) WHERE p.session_id = ?1`,
  signals: `SELECT * FROM signals WHERE session_id = ?1`,
  scores: `SELECT * FROM scores WHERE session_id = ?1`,
  features: `SELECT * FROM features WHERE session_id = ?1`,
  swaps: `SELECT * FROM swaps WHERE session_id = ?1`,
  swap_activity: `SELECT * FROM swap_activity WHERE session_id = ?1`,
  pool_snapshots: `SELECT * FROM pool_snapshots WHERE session_id = ?1`,
  bin_snapshot_meta: `SELECT * FROM bin_snapshot_meta WHERE session_id = ?1`,
  bin_snapshots: `SELECT b.* FROM bin_snapshots b JOIN bin_snapshot_meta m ON m.pool = b.pool AND m.ts = b.ts WHERE m.session_id = ?1`,
  ohlcv: `SELECT o.* FROM ohlcv o WHERE o.pool IN (SELECT pool FROM session_pools WHERE session_id = ?1)`,
  token_security: `SELECT * FROM token_security WHERE session_id = ?1`,
  ecosystem_metrics: `SELECT * FROM ecosystem_metrics WHERE session_id = ?1`,
  data_gaps: `SELECT * FROM data_gaps WHERE session_id = ?1`,
  rpc_usage: `SELECT * FROM rpc_usage WHERE session_id = ?1`,
  pools: `SELECT pl.* FROM pools pl JOIN session_pools sp USING(pool) WHERE sp.session_id = ?1`,
};

const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "bigint" ? v.toString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Stream one table of a session to CSV or JSONL (for pandas / DuckDB). Data sessions and
 * simulation sessions share the same session_id namespace; a sim_replay's market data lives
 * under its source session.
 */
export async function exportTable(db: Db, table: string, sessionId: string, dir: string, format: "csv" | "jsonl"): Promise<{ path: string; rows: number }> {
  const sql = EXPORTS[table];
  if (!sql) throw new Error(`unknown table ${table}; one of: ${Object.keys(EXPORTS).join(", ")}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${table}.${format}`);
  const out = createWriteStream(path);
  let rows = 0;
  let cols: string[] | null = null;
  const write = (s: string) => (out.write(s) ? Promise.resolve() : new Promise<void>((r) => out.once("drain", () => r())));
  for (const r of db.raw.prepare(sql).iterate(sessionId) as Iterable<Record<string, unknown>>) {
    if (format === "jsonl") await write(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
    else {
      if (!cols) {
        cols = Object.keys(r);
        await write(cols.join(",") + "\n");
      }
      await write(cols.map((c) => cell(r[c])).join(",") + "\n");
    }
    rows++;
  }
  await new Promise<void>((r) => out.end(() => r()));
  return { path, rows };
}

export async function exportSession(db: Db, sessionId: string, tables: string[], outDir: string, format: "csv" | "jsonl") {
  const dir = resolve(outDir, sessionId);
  const res: { table: string; path: string; rows: number }[] = [];
  for (const t of tables) res.push({ table: t, ...(await exportTable(db, t, sessionId, dir, format)) });
  return res;
}
