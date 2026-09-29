-- Friday playbook, stage 2: per-minute token flow from Jupiter (holders, bundlers, 5-minute buy /
-- sell stats). Additive only.
CREATE TABLE token_flow (
  token           TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  session_id      TEXT,
  holder_count    INTEGER,
  bundler_pct     REAL,          -- datapi audit.bundlerStats.holdingPct, already in % (unofficial source)
  buy_volume_5m   REAL,          -- Jupiter stats5m (all venues), rolling 5 minutes
  sell_volume_5m  REAL,
  num_buys_5m     INTEGER,
  num_sells_5m    INTEGER,
  liquidity_usd   REAL,
  usd_price       REAL,
  source          TEXT NOT NULL, -- tokens_v2 | tokens_v2+datapi
  PRIMARY KEY (token, ts)
);
CREATE INDEX token_flow_token_ts ON token_flow(token, ts);
