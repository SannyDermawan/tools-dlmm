-- Phase 4: features / scores keyed by session (the same data can be scored by several runs,
-- e.g. live and a later re-score with a new config_version). Both tables were unused before.
DROP TABLE IF EXISTS features;
DROP TABLE IF EXISTS scores;

CREATE TABLE features (
  session_id  TEXT NOT NULL,
  pool        TEXT NOT NULL,
  ts          INTEGER NOT NULL,              -- decision time; only data with ts <= this was used
  name        TEXT NOT NULL,
  raw_value   REAL,                          -- NULL = unavailable
  norm_value  REAL,                          -- 0-100, direction applied (100 = good)
  freshness_s REAL,                          -- age of the newest input at decision time
  PRIMARY KEY (session_id, pool, ts, name)
);

CREATE TABLE scores (
  session_id   TEXT NOT NULL,
  pool         TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  category     TEXT,
  edge REAL, regime REAL, flow REAL, attention REAL, competition REAL, safety REAL,
  gate_passed  INTEGER NOT NULL,
  gate_reasons TEXT,                         -- JSON array
  context_multiplier REAL,
  context_reasons TEXT,                      -- JSON array
  base_score   REAL,
  final_score  REAL,
  confidence   REAL,
  regime_label TEXT,
  action       TEXT NOT NULL,                -- MASUK | PANTAU | LEWATI
  recommendation TEXT,                       -- JSON: strategy, sides, bins, prices
  expectations TEXT,                         -- JSON: net return/h, fee/IL, P(in range), horizon
  top_reasons  TEXT,                         -- JSON array
  weights_used TEXT,                         -- JSON: effective weights after redistribution
  config_version TEXT NOT NULL,
  PRIMARY KEY (session_id, pool, ts)
);
CREATE INDEX scores_pool_ts ON scores(pool, ts);

ALTER TABLE token_security ADD COLUMN dev_rug_count INTEGER;
ALTER TABLE token_security ADD COLUMN rugged INTEGER;
ALTER TABLE token_security ADD COLUMN total_holders INTEGER;
