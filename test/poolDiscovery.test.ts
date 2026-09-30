import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import { hasCriticalWarning, parsePoolDiscovery, PoolDiscoveryCollector, poolDiscoveryLookup } from "../src/collectors/poolDiscovery.ts";
import { presetInputsOf } from "../src/signals/stack.ts";
import { PoolTracker } from "../src/features/tracker.ts";
import type { PoolMeta } from "../src/collectors/types.ts";

const cfg = (): Config => structuredClone(loadConfig().config);
const MIN = 60_000;

/** Shape of a live pool object (fields verified 2026-09-30), trimmed. */
const apiPool = (address: string, o: Record<string, unknown> = {}) => ({
  pool_address: address,
  name: "T-SOL",
  token_x: { address: "X", symbol: "T", warnings: [{ type: "NOT_VERIFIED", message: "m", severity: "info" }], organic_score: 71, top_holders_pct: 20.3, dev_balance_pct: 0.1 },
  token_y: { address: "Y", symbol: "SOL", warnings: [] },
  volatility: 4.22, correlation: 0, pool_price_change_pct: -5.8, min_price: 0.9, max_price: 1.1, price_trend: [1, 1, 1.01, 1.02, 1, 0.99, 0.98, 0.97, 0.96, 0.95],
  tvl: 42_104.5, tvl_change_pct: 55.1, active_tvl: 40_545.5, fee_active_tvl_ratio: 0.012, volume_active_tvl_ratio: 0.4, volume: 8585, fee: 26.7,
  swap_count: 69, unique_traders: 363, unique_lps: 81, net_deposits: 124_657.9, total_deposits: 724_307, total_withdraws: 599_649, total_lps: 114,
  open_positions: 280, active_positions: 40, active_positions_pct: 14.28, positions_created: 126, permanent_lock_liquidity_pct: 0,
  base_token_holders: 50_794, base_token_holders_change_pct: 0.31, base_token_market_cap_change_pct: -4.4,
  ...o,
});

describe("parsePoolDiscovery", () => {
  it("maps the API fields to table columns", () => {
    const r = parsePoolDiscovery(apiPool("P1"));
    expect(r).toMatchObject({
      volatility: 4.22, price_change_pct: -5.8, net_deposits: 124_657.9, unique_traders: 363, swap_count: 69, unique_lps: 81,
      active_positions_pct: 14.28, permanent_lock_pct: 0, base_holders: 50_794, base_holders_change_pct: 0.31, base_mcap_change_pct: -4.4,
      base_top_holders_pct: 20.3, base_dev_balance_pct: 0.1, base_organic_score: 71, fee_active_tvl_ratio: 0.012,
    });
    expect(JSON.parse(r.price_trend as string)).toHaveLength(10);
    expect(JSON.parse(r.warnings_x as string)).toEqual([{ type: "NOT_VERIFIED", severity: "info" }]);
    expect(JSON.parse(r.warnings_y as string)).toEqual([]);
  });

  it("missing or non-numeric fields become null, never 0", () => {
    const r = parsePoolDiscovery({ pool_address: "P", volatility: "abc", swap_count: null, token_x: {} });
    expect(r.volatility).toBeNull();
    expect(r.swap_count).toBeNull();
    expect(r.net_deposits).toBeNull();
    expect(r.warnings_x).toBeNull();
    expect(r.price_trend).toBeNull();
  });

  it("numeric strings are accepted, counts are rounded", () => {
    const r = parsePoolDiscovery({ volatility: "2.5", unique_traders: "12.0", swap_count: 7.4 });
    expect(r.volatility).toBe(2.5);
    expect(r.unique_traders).toBe(12);
    expect(r.swap_count).toBe(7);
  });
});

describe("hasCriticalWarning (Meridian's base / quote_token_has_critical_warnings)", () => {
  it("true when either token has a critical warning, false when warnings exist but none is critical, null without the field", () => {
    const w = (sev: string) => JSON.stringify([{ type: "T", severity: sev }]);
    expect(hasCriticalWarning({ warnings_x: w("critical"), warnings_y: "[]" })).toBe(true);
    expect(hasCriticalWarning({ warnings_x: "[]", warnings_y: w("critical") })).toBe(true);
    expect(hasCriticalWarning({ warnings_x: w("info"), warnings_y: "[]" })).toBe(false);
    expect(hasCriticalWarning({ warnings_x: null, warnings_y: null })).toBeNull();
    expect(hasCriticalWarning({ warnings_x: "not json", warnings_y: null })).toBe(false);
  });
});

describe("PoolDiscoveryCollector", () => {
  const setup = (respond: (params: Record<string, unknown>) => unknown, pools = ["P1", "P2", "P3"]) => {
    const db = new Db(":memory:");
    migrate(db);
    const c = cfg();
    c.collectors.pool_discovery.batch_size = 2;
    const calls: Record<string, unknown>[] = [];
    const http = {
      get: async (_path: string, params: Record<string, unknown>) => {
        calls.push(params);
        return respond(params);
      },
    };
    const poolMap = new Map(pools.map((p) => [p, {} as PoolMeta]));
    const log = { warn() {}, info() {}, debug() {}, error() {} } as never;
    const col = new PoolDiscoveryCollector({ db, log, config: c, sessionId: "S", pools: poolMap, http: http as never });
    return { db, col, calls, poolMap };
  };

  it("asks for the pools in batches with a pool_address filter and stores one row per pool and timeframe", async () => {
    const { db, col, calls } = setup((p) => ({ data: String(p.filter_by).match(/P\d/g)!.map((a) => apiPool(a)) }));
    const rows = await col.tick(1_000);
    expect(calls).toHaveLength(2); // 3 pools, batch_size 2, one timeframe
    expect(calls[0]).toMatchObject({ page_size: 2, timeframe: "5m", filter_by: "pool_address in [P1,P2]" });
    expect(calls[1]).toMatchObject({ page_size: 1, filter_by: "pool_address in [P3]" });
    expect(rows).toHaveLength(3);
    expect(db.all("SELECT pool, timeframe, ts, session_id FROM pool_discovery ORDER BY pool")).toEqual([
      { pool: "P1", timeframe: "5m", ts: 1_000, session_id: "S" },
      { pool: "P2", timeframe: "5m", ts: 1_000, session_id: "S" },
      { pool: "P3", timeframe: "5m", ts: 1_000, session_id: "S" },
    ]);
  });

  it("ignores pools we did not ask for, and a failed batch does not stop the others", async () => {
    let n = 0;
    const { db, col } = setup((p) => {
      if (n++ === 0) throw new Error("boom");
      return { data: [apiPool("P3"), apiPool("STRANGER")] };
    });
    const rows = await col.tick(2_000);
    expect(rows.map((r) => r.pool)).toEqual(["P3"]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM pool_discovery")!.n).toBe(1);
  });

  it("a pool added during the session is asked for at the next tick (the pool map is shared)", async () => {
    const { col, calls, poolMap } = setup(() => ({ data: [] }), ["P1"]);
    await col.tick(1);
    poolMap.set("P9", {} as PoolMeta);
    await col.tick(2);
    expect(calls[0].filter_by).toBe("pool_address in [P1]");
    expect(calls[1].filter_by).toBe("pool_address in [P1,P9]");
  });
});

describe("poolDiscoveryLookup", () => {
  const db = new Db(":memory:");
  migrate(db);
  const put = (ts: number, volatility: number, timeframe = "5m") =>
    db.insert("pool_discovery", { pool: "P1", ts, session_id: "S", timeframe, ...parsePoolDiscovery(apiPool("P1", { volatility })) });
  put(10 * MIN, 1);
  put(11 * MIN, 2);
  put(12 * MIN, 9, "1h");
  const look = poolDiscoveryLookup(db, 2 * MIN);

  it("returns the latest row at or before t, never a later one (look-ahead safe)", () => {
    expect(look("P1", "5m", 10 * MIN)!.volatility).toBe(1);
    expect(look("P1", "5m", 10.5 * MIN)!.volatility).toBe(1);
    expect(look("P1", "5m", 11 * MIN)!.volatility).toBe(2);
    expect(look("P1", "5m", 9 * MIN)).toBeNull();
  });

  it("a row older than maxAge counts as missing; another timeframe is another series; unknown pools are null", () => {
    expect(look("P1", "5m", 13.5 * MIN)).toBeNull(); // 2.5 minutes after the last 5m row
    expect(look("P1", "1h", 12 * MIN)!.volatility).toBe(9);
    expect(look("P1", "30m", 12 * MIN)).toBeNull();
    expect(look("P2", "5m", 11 * MIN)).toBeNull();
  });
});

describe("Meridian preset inputs from the pool-discovery API", () => {
  const meta = { pool: "P1", tokenX: "TKN", tokenY: "SOL", binStep: 100 } as unknown as PoolMeta;
  const tr = new PoolTracker(meta, 3_600_000, 5, 3);

  it("volatility, price change and critical warning come from the row of the fee window's timeframe", () => {
    const calls: string[] = [];
    const row = { pool: "P1", ts: 5 * MIN, timeframe: "5m", volatility: 6.5, price_change_pct: -12, net_deposits: 1, unique_traders: 2, swap_count: 3, unique_lps: 4, fee_active_tvl_ratio: 0.1, base_holders_change_pct: 0, warnings_x: JSON.stringify([{ type: "TRANSFER_FEE_CONFIGURED", severity: "critical" }]), warnings_y: "[]" };
    const x = presetInputsOf(tr, meta, 6 * MIN, 5, 20, 1, new Set(["SOL"]), () => null, null, (pool, tf) => (calls.push(`${pool}|${tf}`), row));
    expect(calls).toEqual(["P1|5m"]);
    expect(x).toMatchObject({ volatility: 6.5, priceChangePct: -12, criticalWarning: true });
  });

  it("without a row (not collected, stale) the inputs are null, not 0", () => {
    const x = presetInputsOf(tr, meta, 6 * MIN, 5, 20, 1, new Set(["SOL"]), () => null, null, () => null);
    expect(x).toMatchObject({ volatility: null, priceChangePct: null, criticalWarning: null });
    const y = presetInputsOf(tr, meta, 6 * MIN, 5, 20, 1, new Set(["SOL"]), () => null);
    expect(y.volatility).toBeNull();
  });
});
