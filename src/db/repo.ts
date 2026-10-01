import { randomUUID } from "node:crypto";
import type { Db } from "./index.ts";
import type { LoadedConfig } from "../config/load.ts";

/** Store the config under its version if it's new. Returns the config_version. */
export function registerConfigVersion(db: Db, lc: LoadedConfig, notes?: string): string {
  db.insert(
    "config_versions",
    {
      config_version: lc.configVersion,
      config_json: JSON.stringify(lc.config),
      config_hash: lc.hash,
      created_at: Date.now(),
      notes: notes ?? null,
    },
    "OR IGNORE",
  );
  return lc.configVersion;
}

export type SessionKind = "collect" | "sim_replay" | "session" | "score_replay";

export function createSession(
  db: Db,
  p: { kind: SessionKind; configVersion: string; label?: string; notes?: string; sourceSessionId?: string; startAt?: number },
): string {
  const id = randomUUID();
  db.insert("sessions", {
    session_id: id,
    kind: p.kind,
    start_at: p.startAt ?? Date.now(),
    label: p.label ?? null,
    config_version: p.configVersion,
    status: "running",
    notes: p.notes ?? null,
    source_session_id: p.sourceSessionId ?? null,
  });
  return id;
}

export function finishSession(db: Db, id: string, status: "completed" | "aborted" | "failed", extra?: { poolCount?: number; notes?: string }) {
  db.run(
    "UPDATE sessions SET end_at = ?, status = ?, pool_count = COALESCE(?, pool_count), notes = COALESCE(?, notes) WHERE session_id = ?",
    Date.now(),
    status,
    extra?.poolCount ?? null,
    extra?.notes ?? null,
    id,
  );
}

export interface SessionRow {
  session_id: string;
  kind: string;
  start_at: number;
  end_at: number | null;
  label: string | null;
  config_version: string;
  pool_count: number | null;
  status: string;
  notes: string | null;
}

export function getSession(db: Db, id: string): SessionRow | undefined {
  return db.get<SessionRow>("SELECT * FROM sessions WHERE session_id = ?", id);
}

export function latestSession(db: Db, kind: SessionKind): SessionRow | undefined {
  return db.get<SessionRow>("SELECT * FROM sessions WHERE kind = ? ORDER BY start_at DESC LIMIT 1", kind);
}

/**
 * Sessions still "running" at startup were killed without a clean shutdown (power loss, kill -9).
 * Mark them aborted, end them at their last stored data point, and close their open gaps there.
 */
export function recoverUncleanSessions(db: Db, log?: { warn: (o: object, m: string) => void }, idleMs = 5 * 60_000): number {
  const rows = db.all<{ session_id: string; start_at: number }>("SELECT session_id, start_at FROM sessions WHERE status = 'running'");
  let n = 0;
  for (const r of rows) {
    const last =
      db.get<{ t: number | null }>(
        `SELECT MAX(t) t FROM (
           SELECT MAX(ts) t FROM pool_snapshots WHERE session_id = ?1
           UNION ALL SELECT MAX(ts) FROM bin_snapshot_meta WHERE session_id = ?1
           UNION ALL SELECT MAX(received_at) FROM swaps WHERE session_id = ?1)`,
        r.session_id,
      )?.t ?? r.start_at;
    // Still writing (another live process)? Leave it alone.
    if (Date.now() - Math.max(last, r.start_at) < idleMs) continue;
    n++;
    db.run("UPDATE data_gaps SET end_at = ? WHERE session_id = ? AND end_at IS NULL", last, r.session_id);
    db.run(
      "UPDATE sessions SET status = 'aborted', end_at = ?, notes = COALESCE(notes || '; ', '') || 'not closed cleanly (recovered at next start)' WHERE session_id = ?",
      last, r.session_id,
    );
    log?.warn({ session: r.session_id }, "recovered unclean session");
  }
  return n;
}
