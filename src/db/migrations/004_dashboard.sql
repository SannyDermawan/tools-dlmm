-- Phase 6: live heartbeat for dashboards, cross-process stop requests, stored reconciliation.
CREATE TABLE session_heartbeat (
  session_id TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,             -- last update
  pid        INTEGER,
  state      TEXT NOT NULL                 -- JSON: phase, time left, positions, pnl, data health
);

CREATE TABLE session_control (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,              -- '*' = any running session
  action       TEXT NOT NULL,              -- stop
  requested_at INTEGER NOT NULL,
  handled_at   INTEGER
);

CREATE TABLE reconcile_results (
  session_id   TEXT NOT NULL,              -- data session
  pool         TEXT NOT NULL,
  window_from  INTEGER NOT NULL,
  window_to    INTEGER NOT NULL,
  reference    TEXT NOT NULL,              -- api | census
  api_fee_usd  REAL,
  accum_fee_usd REAL,
  accum_diff_pct REAL,
  census_fee_usd REAL,
  census_diff_pct REAL,
  passed       INTEGER,
  detail       TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, pool, window_from, window_to, reference)
);
