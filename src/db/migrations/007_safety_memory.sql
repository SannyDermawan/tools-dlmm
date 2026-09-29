-- Phase 10 (addendum v1.1): Jupiter token audit, blocklists, PVP rivals, pool memory / cooldown,
-- extended decision log. Additive only: old data stays readable.

CREATE TABLE token_audit (
  token          TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  session_id     TEXT,
  symbol         TEXT,
  name           TEXT,
  organic_score  REAL,                 -- Jupiter organic score 0-100
  organic_label  TEXT,                 -- high | medium | low
  holder_count   INTEGER,
  mcap_usd       REAL,
  fdv_usd        REAL,
  usd_price      REAL,
  liquidity_usd  REAL,
  launchpad      TEXT,                 -- e.g. pump.fun, met-dbc (null when unknown / none)
  dev            TEXT,                 -- creator wallet
  token_created_at INTEGER,            -- ms
  first_pool_at  INTEGER,              -- ms, first pool creation
  top_holders_pct REAL,
  dev_balance_pct REAL,
  dev_mints      INTEGER,
  dev_migrations INTEGER,
  bot_holders_pct REAL,                -- datapi only (unofficial); null otherwise
  bot_holders_count INTEGER,
  bundler_holding_pct REAL,            -- datapi bundlerStats.holdingPct x 100
  fees_sol       REAL,                 -- datapi `fees` (all-time token fees, SOL; unverified unit)
  is_sus         INTEGER,              -- 1 when audit.isSus is present
  is_verified    INTEGER,
  tags           TEXT,                 -- JSON
  volume_24h_usd REAL,
  pvp_rival_count INTEGER,             -- other mints with the same symbol / name, active in the last 24 h
  pvp_rivals     TEXT,                 -- JSON [{mint, symbol, name, volume_24h}]
  source         TEXT NOT NULL,        -- tokens_v2 | tokens_v2+datapi
  error          TEXT,
  PRIMARY KEY (token, ts)
);
CREATE INDEX token_audit_token_ts ON token_audit(token, ts);

CREATE TABLE blocklist_tokens (
  mint       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  source     TEXT NOT NULL,            -- manual | auto_rug
  added_at   INTEGER NOT NULL,
  removed_at INTEGER,                  -- soft delete keeps replays of older sessions reproducible
  detail     TEXT,
  PRIMARY KEY (mint, added_at)
);

CREATE TABLE blocklist_devs (
  wallet     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  source     TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  removed_at INTEGER,
  detail     TEXT,
  PRIMARY KEY (wallet, added_at)
);

-- Pool / token memory across sessions: one row per (key, session) so every reader can take only
-- sessions that ended before its decision time (look-ahead safe).
CREATE TABLE pool_memory (
  kind         TEXT NOT NULL,          -- pool | token
  key          TEXT NOT NULL,          -- pool address or token mint
  session_id   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  positions    INTEGER NOT NULL,
  avg_net_pct  REAL,
  win_rate     REAL,
  close_reasons TEXT,                  -- JSON {reason: count}
  cooldown_until INTEGER,
  cooldown_reason TEXT,
  consecutive_oor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, key, session_id)
);

ALTER TABLE signals ADD COLUMN risks TEXT;                 -- JSON list of identified risks
ALTER TABLE signals ADD COLUMN rejected_candidates TEXT;   -- JSON [{pool, name, score, action, reason}]
