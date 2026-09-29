-- Swap stream in sampling mode: per pool and minute, how many swap-like transactions the
-- WebSocket saw (free, complete) and how many were sampled / fetched / contained a swap.
CREATE TABLE swap_activity (
  session_id TEXT NOT NULL,
  pool       TEXT NOT NULL,
  minute     INTEGER NOT NULL,          -- epoch ms, start of the minute
  candidates INTEGER NOT NULL,          -- successful txs mentioning the pool with swap logs
  sampled    INTEGER NOT NULL,          -- queued for getTransaction
  PRIMARY KEY (session_id, pool, minute)
);
