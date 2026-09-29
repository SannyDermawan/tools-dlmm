-- Phase 7 (P1/P2 modules): other venues, attention proxies, macro context, ecosystem extras.
CREATE TABLE token_venues (
  token        TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  session_id   TEXT,
  pairs        INTEGER,                  -- number of pairs (all DEXes)
  volume_h1_usd REAL,                    -- all pairs of the token
  volume_h24_usd REAL,
  liquidity_usd REAL,
  pairs_json   TEXT,                     -- [{dex, labels, pair, quote, volume_h1, liquidity}]
  source       TEXT NOT NULL,
  PRIMARY KEY (token, ts)
);

CREATE TABLE attention_metrics (
  token        TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  session_id   TEXT,
  trending_rank INTEGER,                 -- CoinGecko trending rank (1 = top), NULL = not trending
  boosts_active INTEGER,                 -- DexScreener paid boosts on the token's pairs
  socials      INTEGER,                  -- number of social links in the token profile
  websites     INTEGER,
  source       TEXT NOT NULL,
  PRIMARY KEY (token, ts)
);

CREATE TABLE macro_metrics (
  ts           INTEGER NOT NULL PRIMARY KEY,
  session_id   TEXT,
  btc_usd      REAL,
  btc_dominance REAL,
  fear_greed   INTEGER,
  usd_idr      REAL,
  sol_dex_volume_24h REAL,               -- DefiLlama, all Solana DEXes
  sol_dex_change_1d REAL,                -- %
  sol_stablecoins_usd REAL,
  tps          REAL,                     -- recent performance samples
  new_pools_1h INTEGER,                  -- DLMM pools created in the last hour (Meteora API)
  launchpad_pools_1h INTEGER             -- ... of which from a launchpad
);
