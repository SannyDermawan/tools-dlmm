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
export function buildDataset(db: Db, c: Config, source: "sim" | "real_lp" = "sim"): DatasetSummary {
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
  if (source === "real_lp") return realLpDataset(db, c, [...newest.values()].sort((a, b) => a.data_start - b.data_start), skipped);
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

/**
 * Addendum 4.3 (1) / closing step: real LP positions of other wallets as a separate labelled
 * dataset. A real position opened inside one of our data sessions is matched with our latest
 * signal for that pool at or before its open (never later: no look-ahead); positions of one pool
 * opened in the same hour are averaged into one observation. Net PnL % is clipped to
 * [-100, 300] so a few extreme wallets do not dominate the fit. Kept apart from simulator data.
 */
function realLpDataset(
  db: Db,
  c: Config,
  runs: { session_id: string; data_session: string; data_start: number }[],
  skipped: string[],
): DatasetSummary {
  const obs: Observation[] = [];
  const sessions: DatasetSummary["dataSessions"] = [];
  const maxAge = c.signals.max_signal_age_seconds * 1000;
  for (const s of runs) {
    const end = db.get<{ e: number | null }>("SELECT COALESCE(end_at, ?) e FROM sessions WHERE session_id = ?", Date.now(), s.data_session)?.e ?? Date.now();
    const rows = db.all<{ pool: string; opened_at: number; net: number; category: string }>(
      `SELECT r.pool, r.opened_at, r.net_pnl_pct net, pl.category FROM real_lp_positions r JOIN pools pl ON pl.pool = r.pool
       WHERE r.is_closed = 1 AND r.net_pnl_pct IS NOT NULL AND r.opened_at BETWEEN ? AND ?
         AND r.pool IN (SELECT pool FROM session_pools WHERE session_id = ?)`,
      s.data_start, end, s.data_session,
    );
    const groups = new Map<string, { pool: string; hour: number; category: string; nets: number[]; payload: string }>();
    for (const r of rows) {
      const sig = db.get<{ payload: string }>(
        "SELECT payload FROM signals WHERE session_id = ? AND pool = ? AND ts <= ? AND ts >= ? ORDER BY ts DESC LIMIT 1",
        s.session_id, r.pool, r.opened_at, r.opened_at - maxAge,
      );
      if (!sig) continue;
      const hour = Math.floor(r.opened_at / 3_600_000);
      const k = `${r.pool}|${hour}`;
      const g = groups.get(k) ?? { pool: r.pool, hour, category: r.category, nets: [], payload: sig.payload };
      g.nets.push(Math.max(-100, Math.min(300, r.net)));
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      const payload = JSON.parse(g.payload) as { scores: Record<string, number | null>; final_score: number | null };
      obs.push({
        dataSession: s.data_session, dataStart: s.data_start, simSession: s.session_id, pool: g.pool, cohort: g.hour,
        category: g.category as PoolCategory,
        scores: Object.fromEntries(MODULES.map((m) => [m, payload.scores?.[m] ?? null])) as Record<ModuleName, number | null>,
        finalScore: payload.final_score, y: g.nets.reduce((a, b) => a + b, 0) / g.nets.length,
        win: g.nets.filter((x) => x > 0).length / g.nets.length, positions: g.nets.length,
      });
    }
    sessions.push({ id: s.data_session, start: s.data_start, simSession: s.session_id, observations: groups.size });
  }
  return { observations: obs, dataSessions: sessions.filter((x) => x.observations > 0), skippedSimSessions: skipped };
}
