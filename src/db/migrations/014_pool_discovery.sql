-- Meteora pool-discovery API (keyless), one row per pool, timeframe and poll: volatility, price trend,
-- LP net deposits, unique traders / LPs, swap counts, holder and market-cap change, token warnings.
-- Meridian screens on this API (`volatility`, `pool_price_change_pct`), and it carries the LP-inflow /
-- buy-pressure style features of the strategy-lab roadmap (phase 8). Additive only.
CREATE TABLE pool_discovery (
  pool                     TEXT NOT NULL,
  ts                       INTEGER NOT NULL,        -- our fetch time (ms): rows are look-ahead safe by it
  session_id               TEXT,
  timeframe                TEXT NOT NULL,           -- 5m | 30m | 1h | 2h | 4h | 12h | 24h (window of every rate below)
  volatility               REAL,                    -- Meteora's own unit (about 0 for a parked pool, 3-5 for a moving one at 5m)
  correlation              REAL,
  price_change_pct         REAL,                    -- pool price change over the window, %
  min_price                REAL,
  max_price                REAL,
  price_trend              TEXT,                    -- JSON: 10 prices over the window (-1 = no data)
  tvl                      REAL,
  tvl_change_pct           REAL,
  active_tvl               REAL,
  fee_active_tvl_ratio     REAL,                    -- Meridian's screening ratio as the API reports it (%)
  volume_active_tvl_ratio  REAL,
  volume                   REAL,                    -- USD over the window
  fee                      REAL,                    -- USD over the window
  swap_count               INTEGER,
  unique_traders           INTEGER,
  unique_lps               INTEGER,
  net_deposits             REAL,                    -- USD: deposits - withdrawals over the window (LP flow)
  total_deposits           REAL,
  total_withdraws          REAL,
  total_lps                INTEGER,
  open_positions           INTEGER,
  active_positions         INTEGER,
  active_positions_pct     REAL,
  positions_created        INTEGER,
  permanent_lock_pct       REAL,                    -- share of liquidity locked for good
  base_holders             INTEGER,
  base_holders_change_pct  REAL,
  base_mcap_change_pct     REAL,
  base_top_holders_pct     REAL,
  base_dev_balance_pct     REAL,
  base_organic_score       REAL,
  warnings_x               TEXT,                    -- JSON [{type, severity}] of token X (the base token)
  warnings_y               TEXT,
  PRIMARY KEY (pool, timeframe, ts)
);
CREATE INDEX pool_discovery_lookup ON pool_discovery(pool, timeframe, ts);
