import type { Config, ModuleName, PoolCategory } from "../config/schema.ts";
import { MODULES } from "../config/schema.ts";
import type { Db } from "../db/index.ts";

/** One learning example: a pool at one cohort of one data session (blueprint 18.2). */
export interface Observation {
  dataSession: string;
  dataStart: number;
  simSession: string;
  pool: string;
  cohort: number;
  category: PoolCategory;
  /** module scores at entry (0-100); null when the module had no score */
  scores: Record<ModuleName, number | null>;
  finalScore: number | null;
  /** mean net PnL % of the pool's clean baseline positions in that cohort */
  y: number;
  win: number;
  positions: number;
}

export interface DatasetSummary {
  observations: Observation[];
  dataSessions: { id: string; start: number; simSession: string; observations: number }[];
  skippedSimSessions: string[];
}

/**
 * Build the calibration dataset. Positions of one pool in one cohort share the same signal and the
 * same market path, so they are averaged into a single observation (no pseudo-replication).
 * Several simulation runs over the same collected data are the same evidence: only the newest
 * run per data session is used.
 */
export function buildDataset(db: Db, c: Config): DatasetSummary {
  const sims = db.all<{ session_id: string; kind: string; start_at: number; data_session: string; data_start: number }>(
    `SELECT s.session_id, s.kind, s.start_at, COALESCE(s.source_session_id, s.session_id) data_session,
            COALESCE((SELECT start_at FROM sessions d WHERE d.session_id = s.source_session_id), s.start_at) data_start
     FROM sessions s
     WHERE s.kind IN ('session', 'sim_replay')
       AND EXISTS (SELECT 1 FROM sim_positions p WHERE p.session_id = s.session_id AND p.signal_id IS NOT NULL AND p.status = 'closed')
     ORDER BY s.start_at`,
  );
  const newest = new Map<string, (typeof sims)[number]>();
  const skipped: string[] = [];
  for (const s of sims) {
    const prev = newest.get(s.data_session);
    if (prev) skipped.push(prev.session_id);
    newest.set(s.data_session, s);
  }
  const modes = c.calibration.entry_modes;
  const obs: Observation[] = [];
  const sessions: DatasetSummary["dataSessions"] = [];
  for (const s of [...newest.values()].sort((a, b) => a.data_start - b.data_start)) {
    const rows = db.all<{ pool: string; cohort: number; category: string; payload: string; y: number; win: number; n: number }>(
      `SELECT p.pool, CAST(json_extract(p.grid_combo,'$.cohort') AS INT) cohort, pl.category, sg.payload,
              AVG(r.net_pnl_pct) y, AVG(r.net_pnl_usd > 0) win, COUNT(*) n
       FROM sim_positions p
       JOIN sim_results r USING(position_id)
       JOIN signals sg ON sg.signal_id = p.signal_id
       JOIN pools pl ON pl.pool = p.pool
       WHERE p.session_id = ? AND p.status = 'closed' AND p.gap_tainted = 0
         AND p.entry_mode IN (${modes.map(() => "?").join(",")})
       GROUP BY p.pool, cohort`,
      s.session_id, ...modes,
    );
    for (const r of rows) {
      const payload = JSON.parse(r.payload) as { scores: Record<string, number | null>; final_score: number | null };
      const scores = Object.fromEntries(MODULES.map((m) => [m, payload.scores?.[m] ?? null])) as Record<ModuleName, number | null>;
      obs.push({
        dataSession: s.data_session, dataStart: s.data_start, simSession: s.session_id, pool: r.pool, cohort: r.cohort,
        category: r.category as PoolCategory, scores, finalScore: payload.final_score, y: r.y, win: r.win, positions: r.n,
      });
    }
    sessions.push({ id: s.data_session, start: s.data_start, simSession: s.session_id, observations: rows.length });
  }
  return { observations: obs, dataSessions: sessions, skippedSimSessions: skipped };
}
