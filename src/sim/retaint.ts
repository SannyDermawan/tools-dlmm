import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import { gapTaint, taintSource, type GapInterval, type GapTaintConfig } from "./taint.ts";

export interface RetaintSummary {
  positions: number;
  before: number;
  after: number;
  reasons: Record<string, number>;
  /** clean share at a few thresholds, to see how sensitive the rule is */
  sensitivity: { max_fraction: number; max_single_gap_minutes: number; clean: number }[];
}

const ACTIONS = ["open", "rebalance", "partial_exit", "compound", "exit"];

/**
 * Re-evaluate the gap taint of every position of a simulation session from the journal
 * (position life + action events) and the data session's data_gaps, without re-running the
 * simulation. Updates sim_positions.gap_tainted and adds gap fields to sim_results.detail.
 */
export function retaintSession(db: Db, c: Config, simSessionId: string, o: { dryRun?: boolean; taint?: GapTaintConfig } = {}): RetaintSummary {
  const cfg = o.taint ?? c.simulation.gap_taint;
  const s = db.get<{ source_session_id: string | null; end_at: number | null }>("SELECT source_session_id, end_at FROM sessions WHERE session_id = ?", simSessionId);
  if (!s) throw new Error(`session ${simSessionId} not found`);
  const dataSession = s.source_session_id ?? simSessionId;
  const gapRows = db.all<{ source: string; pool: string | null; start_at: number; end_at: number | null }>(
    "SELECT source, pool, start_at, end_at FROM data_gaps WHERE session_id = ?", dataSession,
  ).filter((g) => taintSource(g.source, c.simulation.fee_attribution));
  const gapsFor = (pool: string): GapInterval[] =>
    gapRows.filter((g) => g.pool === null || g.pool === pool).map((g) => ({ source: g.source, start: g.start_at, end: g.end_at }));
  const byPool = new Map<string, GapInterval[]>();
  const positions = db.all<{ position_id: string; pool: string; opened_at: number | null; requested_at: number; closed_at: number | null; gap_tainted: number; status: string }>(
    "SELECT position_id, pool, opened_at, requested_at, closed_at, gap_tainted, status FROM sim_positions WHERE session_id = ? AND status IN ('active','closed')",
    simSessionId,
  );
  const actions = new Map<string, number[]>();
  for (const e of db.all<{ position_id: string; ts: number }>(
    `SELECT e.position_id, e.ts FROM sim_position_events e JOIN sim_positions p USING(position_id)
     WHERE p.session_id = ? AND e.type IN (${ACTIONS.map(() => "?").join(",")})`,
    simSessionId, ...ACTIONS,
  )) {
    const a = actions.get(e.position_id) ?? [];
    a.push(e.ts);
    actions.set(e.position_id, a);
  }
  const end = s.end_at ?? Date.now();
  const sum: RetaintSummary = { positions: positions.length, before: 0, after: 0, reasons: {}, sensitivity: [] };
  const grid = [
    { max_fraction: 0.1, max_single_gap_minutes: 3 },
    { max_fraction: 0.15, max_single_gap_minutes: 5 },
    { max_fraction: 0.25, max_single_gap_minutes: 10 },
  ].map((x) => ({ ...x, clean: 0 }));
  const upd: { id: string; tainted: number; detail: string }[] = [];
  for (const p of positions) {
    if (!byPool.has(p.pool)) byPool.set(p.pool, gapsFor(p.pool));
    const gaps = byPool.get(p.pool)!;
    const from = p.opened_at ?? p.requested_at;
    const to = p.closed_at ?? end;
    const acts = actions.get(p.position_id) ?? [];
    const v = gapTaint(gaps, acts, from, to, cfg);
    for (const g of grid) if (!gapTaint(gaps, acts, from, to, { mode: "proportional", ...g }).tainted) g.clean++;
    if (p.gap_tainted) sum.before++;
    if (v.tainted) {
      sum.after++;
      sum.reasons[v.reason!] = (sum.reasons[v.reason!] ?? 0) + 1;
    }
    upd.push({
      id: p.position_id, tainted: v.tainted ? 1 : 0,
      detail: JSON.stringify({ gapMinutes: v.gapMs / 60_000, gapFraction: v.fraction, taintReason: v.reason, gapTainted: v.tainted }),
    });
  }
  sum.sensitivity = grid;
  if (!o.dryRun) {
    db.tx(() => {
      for (const u of upd) {
        db.run("UPDATE sim_positions SET gap_tainted = ? WHERE position_id = ?", u.tainted, u.id);
        db.run(
          `UPDATE sim_results SET detail = json_patch(COALESCE(detail, '{}'), ?) WHERE position_id = ?`,
          u.detail, u.id,
        );
      }
    });
  }
  return sum;
}
