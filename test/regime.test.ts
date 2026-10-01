import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config/load.ts";
import { classifyRegime, REGIME_LABELS, thresholdsFor } from "../src/features/regime.ts";
import { Db, migrate } from "../src/db/index.ts";
import { loadScorecardPositions } from "../src/analysis/scorecard.ts";

const cfg = () => structuredClone(loadConfig().config);
const th = { momentum_pct: 2, vol_high: 5, vol_low: 0.1, liquidity_pct: 1, unstable_move_pct: 10, unstable_liquidity_pct: 5 };
const x = (o: { pc?: number | null; vol?: number | null; nd?: number | null; tvl?: number | null }) => ({
  timeframe: "5m", priceChangePct: o.pc ?? null, volatility: o.vol ?? null, netDepositsUsd: o.nd ?? null, tvlUsd: o.tvl ?? null,
});

describe("market regime (roadmap PHASE 6)", () => {
  it("labels each of the eight regimes", () => {
    const label = (o: Parameters<typeof x>[0]) => classifyRegime(x(o), th)?.label;
    expect(label({ pc: 3, vol: 1 })).toBe("MOMENTUM_UP");
    expect(label({ pc: -3, vol: 1 })).toBe("MOMENTUM_DOWN");
    expect(label({ pc: 0.5, vol: 1, nd: 0, tvl: 1e5 })).toBe("SIDEWAYS");
    expect(label({ pc: 0.5, vol: 7 })).toBe("HIGH_VOLATILITY");
    expect(label({ pc: 0, vol: 0 })).toBe("LOW_VOLATILITY");
    expect(label({ pc: 0, vol: 1, nd: 2_000, tvl: 1e5 })).toBe("LIQUIDITY_EXPANSION");
    expect(label({ pc: 0, vol: 1, nd: -2_000, tvl: 1e5 })).toBe("LIQUIDITY_CONTRACTION");
    expect(label({ pc: -12, vol: 1 })).toBe("UNSTABLE");
    expect(label({ pc: 0, vol: 1, nd: -6_000, tvl: 1e5 })).toBe("UNSTABLE"); // LPs pulling 6% of TVL in 5 minutes
    expect(REGIME_LABELS).toHaveLength(8);
  });

  it("keeps the three axes apart and says when nothing is known", () => {
    const r = classifyRegime(x({ pc: 3, vol: 7, nd: 2_000, tvl: 1e5 }), th)!;
    expect(r).toMatchObject({ label: "MOMENTUM_UP", trend: "up", volatility: "high", liquidity: "expansion", unstable: false });
    expect(r.liquidityPct).toBeCloseTo(2);
    expect(classifyRegime(x({ pc: 1 }), th)).toMatchObject({ trend: "flat", volatility: null, liquidity: null, label: "SIDEWAYS" });
    expect(classifyRegime(x({ nd: 5 }), th)).toBeNull();
  });

  it("the default config has thresholds for its windows, collects them, and refuses a window without thresholds", () => {
    const c = cfg();
    expect(thresholdsFor(c.regime, c.regime.timeframe)).not.toBeNull();
    expect(thresholdsFor(c.regime, c.regime.fallback_timeframe!)).not.toBeNull();
    expect(c.collectors.pool_discovery.timeframes).toEqual(expect.arrayContaining([c.regime.timeframe, c.regime.fallback_timeframe]));
    const bad = cfg() as unknown as { regime: { timeframe: string } };
    bad.regime.timeframe = "4h";
    expect(() => parseConfig(bad)).toThrow(/regime.thresholds/);
  });

  it("the scorecard labels older positions from their journaled 5-minute fields", () => {
    const db = new Db(":memory:");
    migrate(db);
    db.run("INSERT INTO pools (pool, name, token_x, token_y, decimals_x, decimals_y, bin_step, category, first_seen_at, last_checked_at) VALUES ('P', 'A-SOL', 'A', 'SOL', 6, 9, 20, 'memecoin', 0, 0)");
    db.run("INSERT INTO pool_discovery (pool, ts, timeframe, tvl) VALUES ('P', 50000, '5m', 100000)");
    const add = (id: string, combo: Record<string, unknown>) => {
      db.run(
        `INSERT INTO sim_positions (position_id, session_id, pool, grid_combo, entry_mode, strategy, sides, bins_below, bins_above, capital_usd, requested_at, opened_at, closed_at, status, gap_tainted, config_version)
         VALUES (?, 'S', 'P', ?, 'all_pools_baseline', 'spot', 'two_sided', 5, 5, 1000, 60000, 60000, 120000, 'closed', 0, 'v')`,
        id, JSON.stringify(combo),
      );
      db.run("INSERT INTO sim_results (position_id, net_pnl_usd, cost_usd, fee_usd, duration_min, detail) VALUES (?, 1, 0, 0, 1, '{}')", id);
    };
    add("journaled", { regime: "MOMENTUM_UP", regime_5m: "SIDEWAYS" });
    add("old", { pd_price_change_pct: 0.2, pd_volatility: 1, pd_net_deposits_usd: -2_000 }); // -2% of the stored $100k TVL
    add("none", {});
    const ps = loadScorecardPositions(db, ["S"], undefined, cfg().regime);
    const by = (net: string) => ps.find((p) => p.regime === net);
    expect(by("MOMENTUM_UP")).toBeDefined();
    expect(by("LIQUIDITY_CONTRACTION")).toBeDefined();
    expect(ps.filter((p) => p.regime === null)).toHaveLength(1);
  });
});
