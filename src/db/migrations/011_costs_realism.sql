-- Aggregator swap cost per pool (Jupiter round-trip quotes), used by the simulator for balancing /
-- exit swaps instead of the DLMM pool fee. Additive only.
CREATE TABLE swap_quotes (
  pool             TEXT NOT NULL,
  ts               INTEGER NOT NULL,
  session_id       TEXT,
  notional_usd     REAL NOT NULL,
  one_way_cost_pct REAL,               -- 1 - sqrt(returned / sent), in %; fees + price impact
  in_amount        TEXT,
  back_amount      TEXT,
  route            TEXT,               -- AMM labels of the two legs
  error            TEXT,
  PRIMARY KEY (pool, ts)
);

-- Realism after costs: the simulator runs without the balancing swap (real LPs deposit what they
-- hold) and both sides carry the same open / close transaction costs.
ALTER TABLE sim_realism_checks ADD COLUMN sim_pnl_after_costs_usd REAL;
ALTER TABLE sim_realism_checks ADD COLUMN real_pnl_after_costs_usd REAL;
ALTER TABLE sim_realism_checks ADD COLUMN pnl_after_costs_diff_pct REAL;  -- pp of capital
