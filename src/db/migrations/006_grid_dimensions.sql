-- Phase 9 (addendum v1.1): grid dimensions as columns. Additive only: older rows keep NULL
-- (their grid_combo JSON still holds entry mode / strategy / exit policy label).
ALTER TABLE sim_positions ADD COLUMN exit_policy_params TEXT;  -- JSON of the exit policy (list values expanded)
ALTER TABLE sim_positions ADD COLUMN strategy_params TEXT;     -- JSON {variant, ...variant parameters}
ALTER TABLE sim_positions ADD COLUMN cooldown_enabled INTEGER; -- phase 10 (pool cooldown dimension)
ALTER TABLE sim_positions ADD COLUMN entry_filter TEXT;        -- phase 13 (indicator entry filter dimension)
