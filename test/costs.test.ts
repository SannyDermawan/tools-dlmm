import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import { oneWayCostPct, SwapQuoteCollector } from "../src/collectors/swapQuotes.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { gridCombos } from "../src/sim/gridRunner.ts";
import type { PoolMeta } from "../src/collectors/types.ts";

const cfg = (): Config => structuredClone(loadConfig().config);
const meta = { pool: "P", name: "T-SOL", tokenX: "T", tokenY: "SOL", decimalsX: 6, decimalsY: 9, binStep: 100 } as PoolMeta;

describe("aggregator swap cost (revision 1)", () => {
  it("one-way cost from a round trip", () => {
    expect(oneWayCostPct(1_000_000n, 980_100n)).toBeCloseTo(1, 6); // 0.99^2
    expect(oneWayCostPct(1_000_000n, 1_000_500n)).toBe(0); // rounding gain -> 0
    expect(oneWayCostPct(1_000_000n, 1_100_000n)).toBeNull(); // profitable round trip: broken quote
    expect(oneWayCostPct(0n, 5n)).toBeNull();
  });

  it("collector quotes quote -> base -> quote for the configured notional and stores the cost", async () => {
    const db = new Db(":memory:");
    migrate(db);
    const calls: Record<string, string>[] = [];
    const http = {
      get: async (_p: string, q: Record<string, string>) => {
        calls.push(q);
        return q.inputMint === "SOL" ? { inAmount: q.amount, outAmount: "1000000", routePlan: [{ swapInfo: { label: "Pump.fun Amm" } }] } : { inAmount: q.amount, outAmount: "4900000000" };
      },
    };
    const events: unknown[] = [];
    const col = new SwapQuoteCollector({
      db, log: { warn() {}, info() {}, debug() {}, error() {} } as never, config: cfg(), sessionId: "S", pools: new Map([["P", meta]]),
      usdPrices: new Map([["SOL", { usd: 100, ts: 0 }]]), bus: { emit: (_n: string, e: unknown) => events.push(e) } as never, http: http as never,
    });
    const c = await col.quotePool(meta, 1000);
    expect(calls[0]).toMatchObject({ inputMint: "SOL", outputMint: "T", amount: "5000000000" }); // $500 of SOL at $100
    expect(calls[1]).toMatchObject({ inputMint: "T", outputMint: "SOL", amount: "1000000" });
    expect(c).toBeCloseTo((1 - Math.sqrt(0.98)) * 100, 6);
    expect(db.get("SELECT one_way_cost_pct IS NOT NULL ok, route FROM swap_quotes")).toEqual({ ok: 1, route: '["Pump.fun Amm"]' });
    expect(events).toEqual([{ pool: "P", ts: 1000, costPct: c }]);
  });

  it("simulator swap rate: fresh quote, capped by the pool fee; fallback when stale; pool model", () => {
    const c = cfg();
    const sim = new PoolSimulator({ ...meta, fee: { binStep: 100, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 } } as PoolMeta, c, new MemorySink());
    expect(sim.swapRate(0.02)).toBeCloseTo(c.simulation.costs.aggregator.fallback_cost_pct / 100); // no quote yet
    expect(sim.swapRate(0.001)).toBeCloseTo(0.001); // never above the pool fee
    sim.onMarket({ swapCostPct: 0.4, swapQuoteTs: sim.now });
    expect(sim.swapRate(0.02)).toBeCloseTo(0.004);
    c.simulation.costs.swap_model = "pool";
    const pool = new PoolSimulator(meta, c, new MemorySink());
    pool.onMarket({ swapCostPct: 0.4, swapQuoteTs: pool.now });
    expect(pool.swapRate(0.02)).toBe(0.02);
  });
});

describe("grid load (revisions 4, 5)", () => {
  it("short sessions run signal modes without the cooldown dimension; the baseline uses a subset of the sample", () => {
    const c = cfg();
    const n = (mins: number, mode: string) => gridCombos(c, { allowSignalModes: true, sessionMinutes: mins }).filter((x) => x.entryMode === mode).length;
    expect(n(60, "signal_enter")).toBe(n(60, "signal_watch"));
    expect(n(120, "signal_enter")).toBe(2 * n(60, "signal_enter")); // with and without cooldown from 120 min
    expect(n(120, "all_pools_baseline")).toBe(c.grid.sampling.baseline_max_combos);
  });
});
