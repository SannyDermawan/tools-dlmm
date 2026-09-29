-- Phase 11 (addendum v1.1 §4): real LP positions of other wallets (public on-chain data, labelled
-- with real money), smart LP wallets, simulator realism checks. Additive only.

-- One row per real position (Meteora Data API /positions/{pool}/pnl, + events, + our own data).
CREATE TABLE real_lp_positions (
  position        TEXT PRIMARY KEY,
  wallet          TEXT NOT NULL,
  pool            TEXT NOT NULL,
  opened_at       INTEGER,               -- ms
  closed_at       INTEGER,               -- ms, null while open
  is_closed       INTEGER NOT NULL,
  lower_bin       INTEGER,
  upper_bin       INTEGER,
  bins            INTEGER,
  shape           TEXT,                  -- spot | curve | bidask (from on-chain liquidity shares), null = unknown
  sides           TEXT,                  -- two_sided | quote_only | base_only (from deposits)
  deposit_usd     REAL,
  deposit_x       REAL,                  -- display units
  deposit_y       REAL,
  deposit_x_usd   REAL,
  deposit_y_usd   REAL,
  withdraw_usd    REAL,
  fee_usd         REAL,                  -- claimed fees + rewards (closed); + unclaimed while open
  net_pnl_usd     REAL,                  -- API pnlUsd (realized + unrealized)
  net_pnl_pct     REAL,
  duration_min    REAL,
  add_count       INTEGER,               -- from the event history (null = not fetched)
  remove_count    INTEGER,
  claim_count     INTEGER,
  rebalance_count INTEGER,               -- adds after the first one
  simple          INTEGER,               -- 1 = one add, removes only at the close (replayable 1:1)
  open_active_bin INTEGER,               -- our pool_snapshots at opened_at (null = not covered)
  open_state      TEXT,                  -- JSON: price, fee rate, our score / action at open
  source          TEXT NOT NULL,         -- meteora_api
  fetched_at      INTEGER NOT NULL
);
CREATE INDEX real_lp_pool ON real_lp_positions(pool, opened_at);
CREATE INDEX real_lp_wallet ON real_lp_positions(wallet);

-- Open position accounts seen by the on-chain scans (getProgramAccounts by lb_pair).
CREATE TABLE lp_position_sightings (
  position      TEXT PRIMARY KEY,
  pool          TEXT NOT NULL,
  wallet        TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  gone_at       INTEGER,                 -- first scan that no longer saw it (closed)
  new_in_scan   INTEGER NOT NULL DEFAULT 0,  -- 1 = not present in the pool's first scan (opened while watched)
  shape         TEXT,
  shape_detail  TEXT
);
CREATE INDEX lp_sightings_pool ON lp_position_sightings(pool, last_seen_at);

CREATE TABLE lp_wallet_fetches (
  wallet     TEXT NOT NULL,
  pool       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  positions  INTEGER NOT NULL,
  error      TEXT,
  PRIMARY KEY (wallet, pool)
);

CREATE TABLE lp_wallets (
  wallet           TEXT PRIMARY KEY,
  positions        INTEGER NOT NULL,
  closed_positions INTEGER NOT NULL,
  win_rate         REAL,
  avg_pnl_pct      REAL,
  total_pnl_usd    REAL,
  last_active_at   INTEGER,
  status_smart     INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE sim_realism_checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  real_position   TEXT NOT NULL,
  pool            TEXT NOT NULL,
  data_session_id TEXT NOT NULL,
  spec            TEXT,                  -- JSON spec used in the simulator
  real_fee_usd    REAL,
  sim_fee_usd     REAL,
  fee_diff_pct    REAL,                  -- (sim - real) / real x 100
  real_pnl_usd    REAL,
  sim_pnl_usd     REAL,                  -- simulator PnL before costs (Meteora PnL ignores tx fees)
  pnl_diff_pct    REAL,                  -- (sim - real) / deposit x 100 (percentage points of capital)
  status          TEXT NOT NULL,         -- ok | skipped
  reason          TEXT
);
CREATE INDEX realism_pos ON sim_realism_checks(real_position);
