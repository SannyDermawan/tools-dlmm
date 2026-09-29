-- datapi bundlerStats.holdingPct is already a percentage (live values such as 4.32), not a
-- fraction: phase 10 stored it x 100. Correct the stored values (they fed no decision).
UPDATE token_audit SET bundler_holding_pct = bundler_holding_pct / 100 WHERE bundler_holding_pct IS NOT NULL;
