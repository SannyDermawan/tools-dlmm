import type { Db } from "../db/index.ts";
import type { Extreme } from "../session/heartbeat.ts";

export interface DashboardSession {
  session_id: string;
  kind: string;
  label: string | null;
  status: string;
  start_at: number;
  end_at: number | null;
  pool_count: number | null;
  heartbeat: { ts: number; ageS: number; state: any } | null;
  db: {
    positions: { status: string; n: number }[];
    byMode: { k: string; n: number; closed: number; win: number | null; net: number | null; fee: number | null; il: number | null }[];
    byStrategy: { k: string; n: number; closed: number; win: number | null; net: number | null }[];
    /** biggest profit and loss among the closed positions of each entry mode */
    extremes: { k: string; best: Extreme | null; worst: Extreme | null }[];
    signals: { name: string; pool: string; ts: number; action: string; final: number | null; confidence: number | null; regime: string | null; reasons: string[] }[];
    signalCounts: { action: string; n: number }[];
    gapsOpen: { source: string; pool: string | null; start_at: number; cause: string }[];
    gapsTotal: { source: string; n: number; minutes: number }[];
    lastData: number | null;
    http: { endpoint: string; calls: number; errors: number; credits: number }[];
    swaps: number;
  };
}

/** Everything the dashboards show for one session (heartbeat when live, DB aggregates always). */
export function sessionView(db: Db, sessionId: string, now = Date.now()): DashboardSession | null {
  const s = db.get<Omit<DashboardSession, "heartbeat" | "db">>(
    "SELECT session_id, kind, label, status, start_at, end_at, pool_count FROM sessions WHERE session_id = ?", sessionId,
  );
  if (!s) return null;
  const hb = db.get<{ ts: number; state: string }>("SELECT ts, state FROM session_heartbeat WHERE session_id = ?", sessionId);
  const agg = (expr: string) =>
    db.all<{ k: string; n: number; closed: number; win: number | null; net: number | null; fee: number | null; il: number | null }>(
      `SELECT ${expr} k, COUNT(*) n, SUM(p.status='closed') closed, AVG(r.net_pnl_usd > 0) win, AVG(r.net_pnl_pct) net,
              AVG(r.fee_usd) fee, AVG(r.il_usd) il
       FROM sim_positions p LEFT JOIN sim_results r USING(position_id) WHERE p.session_id = ? GROUP BY k ORDER BY k`,
      sessionId,
    );
  const extremes = (mode: string, order: "DESC" | "ASC"): Extreme | null => {
    const r = db.get<{ usd: number; capital: number; name: string; pool: string }>(
      `SELECT r.net_pnl_usd usd, p.capital_usd capital, pl.name name, p.pool pool
       FROM sim_positions p JOIN sim_results r USING(position_id) JOIN pools pl ON pl.pool = p.pool
       WHERE p.session_id = ? AND p.entry_mode = ? AND p.status = 'closed' ORDER BY r.net_pnl_usd ${order} LIMIT 1`,
      sessionId, mode,
    );
    return r ? { usd: r.usd, pct: (r.usd / r.capital) * 100, pool: `${r.name} ${r.pool.slice(0, 4)}`, active: false } : null;
  };
  const latestTs = db.get<{ t: number | null }>("SELECT MAX(ts) t FROM signals WHERE session_id = ?", sessionId)?.t ?? null;
  const signals = latestTs
    ? db
        .all<{ name: string; pool: string; ts: number; action: string; payload: string }>(
          "SELECT pl.name, s.pool, s.ts, s.action, s.payload FROM signals s JOIN pools pl USING(pool) WHERE s.session_id = ? AND s.ts = ?",
          sessionId, latestTs,
        )
        .map((r) => {
          const p = JSON.parse(r.payload);
          return { name: r.name, pool: r.pool, ts: r.ts, action: r.action, final: p.final_score, confidence: p.confidence, regime: p.regime_label, reasons: p.top_reasons ?? [] };
        })
        .sort((a, b) => (b.final ?? -1) - (a.final ?? -1))
    : [];
  const lastData = db.get<{ t: number | null }>(
    "SELECT MAX(t) t FROM (SELECT MAX(ts) t FROM pool_snapshots WHERE session_id=?1 UNION ALL SELECT MAX(ts) FROM bin_snapshot_meta WHERE session_id=?1)",
    sessionId,
  )?.t ?? null;
  return {
    ...s,
    heartbeat: hb ? { ts: hb.ts, ageS: (now - hb.ts) / 1000, state: JSON.parse(hb.state) } : null,
    db: {
      positions: db.all("SELECT status, COUNT(*) n FROM sim_positions WHERE session_id = ? GROUP BY status", sessionId),
      byMode: agg("p.entry_mode"),
      byStrategy: agg("p.strategy"),
      extremes: agg("p.entry_mode").map((m) => ({ k: m.k, best: extremes(m.k, "DESC"), worst: extremes(m.k, "ASC") })),
      signals,
      signalCounts: db.all("SELECT action, COUNT(*) n FROM signals WHERE session_id = ? GROUP BY action", sessionId),
      gapsOpen: db.all("SELECT source, pool, start_at, cause FROM data_gaps WHERE session_id = ? AND end_at IS NULL", sessionId),
      gapsTotal: db.all(
        "SELECT source, COUNT(*) n, SUM(COALESCE(end_at, ?) - start_at)/60000.0 minutes FROM data_gaps WHERE session_id = ? GROUP BY source",
        now, sessionId,
      ),
      lastData,
      http: db.all("SELECT endpoint, SUM(calls) calls, SUM(errors) errors, SUM(credits) credits FROM rpc_usage WHERE session_id = ? GROUP BY endpoint", sessionId),
      swaps: db.get<{ n: number }>("SELECT COUNT(*) n FROM swaps WHERE session_id = ?", sessionId)?.n ?? 0,
    },
  };
}

/** Sessions to show: running ones first, then the most recent. */
export function listSessions(db: Db, limit = 10) {
  return db.all<{ session_id: string; kind: string; label: string | null; status: string; start_at: number; end_at: number | null }>(
    `SELECT session_id, kind, label, status, start_at, end_at FROM sessions
     WHERE kind IN ('session', 'collect', 'sim_replay')
     ORDER BY (status = 'running') DESC, start_at DESC LIMIT ?`,
    limit,
  );
}
