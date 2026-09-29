-- All timestamps are UTC epoch milliseconds (INTEGER) unless the column name says otherwise.
-- u64/u128 on-chain integers are stored as decimal TEXT to stay exact; *_ui / *_usd columns are
-- REAL convenience values for analysis.

CREATE TABLE config_versions (
  config_version TEXT PRIMARY KEY,
  config_json    TEXT NOT NULL,
  config_hash    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  notes          TEXT
);

CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,              -- collect | sim_replay | session
  start_at       INTEGER NOT NULL,
  end_at         INTEGER,
  label          TEXT,
  config_version TEXT NOT NULL REFERENCES config_versions(config_version),
  pool_count     INTEGER,
  status         TEXT NOT NULL,              -- running | completed | aborted | failed
  notes          TEXT,
  source_session_id TEXT                     -- for sim_replay: the collect session replayed
);

CREATE TABLE pools (
  pool            TEXT PRIMARY KEY,
  name            TEXT,
  token_x         TEXT NOT NULL,
  token_y         TEXT NOT NULL,
  symbol_x        TEXT,
  symbol_y        TEXT,
  decimals_x      INTEGER NOT NULL,
  decimals_y      INTEGER NOT NULL,
  bin_step        INTEGER NOT NULL,
  base_factor     INTEGER,
  base_fee_power_factor INTEGER,
  filter_period   INTEGER,
  decay_period    INTEGER,
  reduction_factor INTEGER,
  variable_fee_control INTEGER,
  max_volatility_accumulator INTEGER,
  protocol_share  INTEGER,                   -- bps of total fee
  collect_fee_mode INTEGER,
  function_type   INTEGER,
  token_x_program TEXT,
  token_y_program TEXT,
  reserve_x       TEXT,
  reserve_y       TEXT,
  category        TEXT NOT NULL,             -- memecoin | bluechip
  pool_created_at INTEGER,
  first_seen_at   INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL,
  params_json     TEXT
);

CREATE TABLE session_pools (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  pool       TEXT NOT NULL REFERENCES pools(pool),
  added_at   INTEGER NOT NULL,
  rank       INTEGER,
  discovery_json TEXT,
  PRIMARY KEY (session_id, pool)
);

-- source=chain: from the lb_pair account (active bin, volatility, fee rate)
-- source=api:   from the Meteora Data API (tvl, volume, fees, USD prices)
CREATE TABLE pool_snapshots (
  pool       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  source     TEXT NOT NULL,
  session_id TEXT,
  slot       INTEGER,
  active_bin INTEGER,
  price      REAL,                           -- UI price of X in Y
  volatility_accumulator INTEGER,
  volatility_reference   INTEGER,
  index_reference        INTEGER,
  v_last_update_ts       INTEGER,
  base_fee_rate          REAL,               -- fraction (0.0025 = 0.25%)
  variable_fee_rate      REAL,
  total_fee_rate         REAL,
  tvl_usd       REAL,
  volume_5m_usd REAL, volume_1h_usd REAL, volume_24h_usd REAL,
  fee_5m_usd    REAL, fee_1h_usd    REAL, fee_24h_usd    REAL,
  protocol_fee_1h_usd REAL,
  fee_tvl_1h    REAL,
  token_x_usd   REAL,
  token_y_usd   REAL,
  reserve_x_ui  REAL,
  reserve_y_ui  REAL,
  PRIMARY KEY (pool, ts, source)
);

CREATE TABLE bin_snapshot_meta (
  pool       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  session_id TEXT,
  slot       INTEGER,
  active_bin INTEGER NOT NULL,
  lower_bin  INTEGER NOT NULL,               -- observed window (inclusive)
  upper_bin  INTEGER NOT NULL,
  missing_bin_arrays TEXT,                   -- JSON array of bin array indexes not initialized
  bin_count  INTEGER NOT NULL,              -- bins with supply>0 in the window
  stored_count INTEGER NOT NULL,             -- rows written to bin_snapshots for this ts
  full       INTEGER NOT NULL,               -- 1: keyframe (all bins stored); 0: only changed bins
  PRIMARY KEY (pool, ts)
);

-- Delta-encoded: a keyframe stores every bin with supply > 0 in the window; other snapshots store
-- only bins that changed since the previous snapshot (a bin that emptied is written with supply 0).
-- State at time t = latest row per bin with ts <= t, restricted to that snapshot's window.
CREATE TABLE bin_snapshots (
  pool       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  bin_id     INTEGER NOT NULL,
  price      REAL,                           -- UI price
  x_amount   TEXT NOT NULL,                  -- raw u64
  y_amount   TEXT NOT NULL,
  liquidity_supply TEXT NOT NULL,            -- raw u128 (Q64 liquidity shares)
  fee_x_per_token  TEXT NOT NULL,            -- raw u128 Q64.64 cumulative
  fee_y_per_token  TEXT NOT NULL,
  value_quote_ui REAL,                       -- x*price + y in UI units of Y
  PRIMARY KEY (pool, ts, bin_id)
);

CREATE TABLE swaps (
  signature   TEXT NOT NULL,
  event_index INTEGER NOT NULL,              -- order of the event inside the transaction
  pool        TEXT NOT NULL,
  ts          INTEGER,                       -- block time (ms)
  slot        INTEGER,
  session_id  TEXT,
  event_type  TEXT NOT NULL,                 -- Swap | Swap2Evt
  wallet      TEXT,
  start_bin   INTEGER,
  end_bin     INTEGER,
  amount_in   TEXT, amount_out TEXT, amount_left TEXT,
  swap_for_y  INTEGER,                       -- 1: X in, Y out (price down)
  fee         TEXT,                          -- total fee incl. protocol (raw, fee token)
  protocol_fee TEXT,
  mm_fee      TEXT,                          -- LP (market maker) share
  limit_order_fee TEXT,
  host_fee    TEXT,
  fee_bps     TEXT,
  fees_on_input INTEGER,
  fees_on_token_x INTEGER,
  amount_in_ui REAL, amount_out_ui REAL, fee_ui REAL, mm_fee_ui REAL, protocol_fee_ui REAL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX swaps_pool_ts ON swaps(pool, ts);

CREATE TABLE ohlcv (
  pool      TEXT NOT NULL,                   -- pool address (or token mint for token-level series)
  timeframe TEXT NOT NULL,
  ts        INTEGER NOT NULL,                -- bucket start
  o REAL, h REAL, l REAL, c REAL, v REAL,
  source    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (pool, timeframe, ts, source)
);

CREATE TABLE token_security (
  token        TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  session_id   TEXT,
  token_program TEXT,
  decimals     INTEGER,
  supply_ui    REAL,
  mint_auth    TEXT,                         -- null when revoked
  freeze_auth  TEXT,
  mint_auth_active   INTEGER,
  freeze_auth_active INTEGER,
  transfer_fee_bps   INTEGER,                -- token-2022 transfer fee (null when none)
  extensions   TEXT,                         -- JSON list of token-2022 extension names
  top10_pct    REAL,                         -- excluding known pool reserves / burn
  top10_excluded TEXT,                       -- JSON: accounts excluded from top10
  cluster_pct  REAL,                         -- P1 (null until implemented)
  dev_history  TEXT,                         -- P1
  rugcheck_score REAL,
  rugcheck_risks TEXT,
  source       TEXT NOT NULL,
  error        TEXT,
  PRIMARY KEY (token, ts)
);

CREATE TABLE social_metrics (
  token TEXT NOT NULL, ts INTEGER NOT NULL,
  mentions INTEGER, mention_velocity REAL, quality_score REAL, sentiment REAL, source TEXT,
  PRIMARY KEY (token, ts, source)
);

CREATE TABLE ecosystem_metrics (
  ts INTEGER NOT NULL PRIMARY KEY,
  session_id TEXT,
  sol_usd REAL,
  launchpad_graduates INTEGER,
  priority_fee_p50 REAL,                     -- micro-lamports per CU
  priority_fee_p75 REAL,
  priority_fee_p90 REAL,
  priority_fee_nonzero_p75 REAL,
  dex_volume_usd REAL
);

CREATE TABLE features (
  pool TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL,
  raw_value REAL, norm_value REAL, freshness_s REAL,
  PRIMARY KEY (pool, ts, name)
);

CREATE TABLE scores (
  pool TEXT NOT NULL, ts INTEGER NOT NULL, session_id TEXT,
  edge REAL, regime REAL, flow REAL, attention REAL, competition REAL, safety REAL,
  gate_passed INTEGER, gate_reasons TEXT, context_multiplier REAL,
  final_score REAL, confidence REAL, regime_label TEXT, config_version TEXT,
  PRIMARY KEY (pool, ts)
);

CREATE TABLE signals (
  signal_id TEXT PRIMARY KEY,
  session_id TEXT, pool TEXT NOT NULL, ts INTEGER NOT NULL,
  action TEXT NOT NULL, recommendation TEXT, expectations TEXT, top_reasons TEXT,
  taken INTEGER NOT NULL DEFAULT 0, config_version TEXT, payload TEXT
);

CREATE TABLE sim_positions (
  position_id  TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  signal_id    TEXT,
  pool         TEXT NOT NULL,
  grid_combo   TEXT NOT NULL,                -- JSON
  entry_mode   TEXT NOT NULL,
  strategy     TEXT NOT NULL,
  sides        TEXT NOT NULL,
  bins_below   INTEGER NOT NULL,
  bins_above   INTEGER NOT NULL,
  lower_bin    INTEGER,
  upper_bin    INTEGER,
  capital_usd  REAL NOT NULL,
  requested_at INTEGER NOT NULL,             -- signal / order time
  opened_at    INTEGER,                      -- after entry delay
  closed_at    INTEGER,
  close_reason TEXT,                         -- session_end | exit_signal | out_of_range | ...
  gap_tainted  INTEGER NOT NULL DEFAULT 0,
  config_version TEXT NOT NULL,
  status       TEXT NOT NULL                 -- pending | active | closed | failed
);
CREATE INDEX sim_positions_session ON sim_positions(session_id);

CREATE TABLE sim_position_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  type        TEXT NOT NULL,                 -- open | fee | cross | rebalance | exit | gap
  detail      TEXT
);
CREATE INDEX sim_position_events_pos ON sim_position_events(position_id, ts);

CREATE TABLE sim_results (
  position_id  TEXT PRIMARY KEY,
  fee_usd      REAL, fee_x_ui REAL, fee_y_ui REAL,
  il_usd       REAL,
  cost_usd     REAL,                         -- sunk costs only
  rent_locked_usd REAL,                      -- refundable rent (not in net PnL)
  net_pnl_usd  REAL,
  net_pnl_pct  REAL,
  time_in_range_pct REAL,
  duration_min REAL,
  max_drawdown_usd REAL,
  max_drawdown_pct REAL,
  final_value_usd REAL,
  hodl_value_usd  REAL,
  entry_price  REAL,
  exit_price   REAL,
  detail       TEXT
);

CREATE TABLE data_gaps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  source     TEXT NOT NULL,
  pool       TEXT,
  start_at   INTEGER NOT NULL,
  end_at     INTEGER,                        -- null while the gap is open
  cause      TEXT
);
CREATE INDEX data_gaps_session ON data_gaps(session_id, source);

CREATE TABLE macro_events (
  ts INTEGER NOT NULL, name TEXT NOT NULL, impact TEXT,
  PRIMARY KEY (ts, name)
);

CREATE TABLE rpc_usage (
  session_id TEXT NOT NULL,
  minute     INTEGER NOT NULL,               -- epoch ms truncated to the minute
  endpoint   TEXT NOT NULL,                  -- rpc | api | rugcheck
  method     TEXT NOT NULL,
  calls      INTEGER NOT NULL,
  errors     INTEGER NOT NULL,
  credits    REAL NOT NULL,
  PRIMARY KEY (session_id, minute, endpoint, method)
);
