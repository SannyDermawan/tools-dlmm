import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig, deepMerge } from "../src/config/load.ts";
import { MODULES, type Config, type ModuleName } from "../src/config/schema.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { Scorer } from "../src/features/scorer.ts";
import { computeFeatures, markout } from "../src/features/compute.ts";
import type { ExtraLookup } from "../src/features/extraLookup.ts";
import { parseDexPairs, riskTokens } from "../src/collectors/extraCollectors.ts";
import type { BinObs, PoolMeta } from "../src/collectors/types.ts";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const cfg = (): Config => structuredClone(loadConfig().config);
const meta = (pool: string, tokenX: string): PoolMeta => ({
  pool, name: pool, tokenX, tokenY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbolX: tokenX, symbolY: "USDC", decimalsX: 6, decimalsY: 6,
  binStep: 20, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep: 20, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 }, s: {} as never, createdAt: null,
});
const T0 = Date.UTC(2026, 8, 1, 12);

/** A scorer fed 40 minutes of synthetic data for two pools, with all phase 7 sources present. */
function fedScorer(c: Config) {
  const metas = [meta("PA", "TA"), meta("PB", "TB")];
  const extra: ExtraLookup = {
    venues: (token, t) => ({ ts: t - 1000, pairs: 3, volume_h1_usd: 1000, pairs_json: JSON.stringify([{ pair: token === "TA" ? "PA" : "PB", volume_h1: token === "TA" ? 800 : 200 }, { pair: "other", volume_h1: 100 }]) }),
    attention: (token, t) => ({ ts: t - 1000, trending_rank: token === "TA" ? 2 : null, boosts_active: token === "TA" ? 1 : 0, socials: 2, websites: 1 }),
    macro: (t) => Array.from({ length: 6 }, (_, i) => ({ ts: t - (5 - i) * 600_000, btc_usd: 80000 + i * 10, btc_dominance: 58, fear_greed: 60, usd_idr: 16000, sol_dex_change_1d: -3, tps: 4000, launchpad_pools_1h: 5 })),
  };
  const scorer = new Scorer({
    config: c, metas, macroEvents: [], extra,
    security: (token, t) => ({ token, ts: t - 1000, mint_auth_active: 0, freeze_auth_active: 0, transfer_fee_bps: null, top10_pct: 20, cluster_pct: 2, dev_rug_count: 0, rugged: 0, rugcheck_score: 50, supply_ui: 1e9 }),
  });
  let fee = 0n;
  for (let t = T0; t <= T0 + 40 * 60_000; t += 5000) {
    const k = (t - T0) / 5000;
    for (const [i, m] of metas.entries()) {
      const tr = scorer.trackers.get(m.pool)!;
      const active = Math.round(Math.sin(k / 30 + i) * 3);
      tr.onState({ pool: m.pool, ts: t, slot: k, activeId: active, priceUi: binUiPrice(active, 20, 6, 6), v: {} as never, feeRateTotal: 0.002, feeRateLp: 0.0019 });
      if ((t - T0) % 60_000 === 0) tr.onMetrics({ ts: t, tvlUsd: 50_000, volume1h: 20_000, volume24h: 240_000, fee1h: 40, feeTvl1h: 0.08, xUsd: binUiPrice(active, 20, 6, 6), yUsd: 1 });
      if ((t - T0) % 30_000 === 0) {
        fee += Q64 / 100000n;
        const bins = new Map<number, BinObs>();
        for (let id = active - 20; id <= active + 20; id++) {
          const P = binRawPrice(id, 20);
          const x = id >= active ? 1_000_000_000n : 0n;
          const y = id <= active ? 1_000_000_000n : 0n;
          bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: Math.abs(id - active) <= 1 ? fee : 0n, feeY: 0n, priceRaw: P });
        }
        tr.onBins({ pool: m.pool, ts: t, slot: k, activeId: active, lower: active - 20, upper: active + 20, missingBinArrays: [], bins });
      }
      if (k % 6 === 0) {
        const buy = k % 12 === 0;
        tr.onSwap({ pool: m.pool, signature: `s${k}${i}`, eventIndex: 0, ts: t, slot: k, swapForY: !buy, startBin: 0, endBin: 0, amountIn: 1_000_000_000n, amountOut: 1n, fee: 1n, protocolFee: 0n, mmFee: 1n, feeOnX: true, wallet: `w${k % 7}` });
      }
    }
    scorer.eco.onEco({ ts: t, solUsd: 120 + Math.sin(k / 50), p75: 1000 });
  }
  return scorer;
}

describe("module toggles (phase 7 criterion)", () => {
  it("every module can be switched on / off without errors; weights follow the switches", () => {
    const t = T0 + 40 * 60_000;
    // all 2^6 on/off combinations of the scoring modules
    for (let mask = 0; mask < 1 << MODULES.length; mask++) {
      const c = cfg();
      MODULES.forEach((m, i) => (c.scoring.modules[m] = !!(mask & (1 << i))));
      c.scoring.weights.v1_default.memecoin.attention = 15;
      const res = fedScorer(c).scoreAll(t);
      expect(res).toHaveLength(2);
      for (const r of res) {
        for (const m of Object.keys(r.weights) as ModuleName[]) expect(c.scoring.modules[m]).toBe(true);
        const sum = Object.values(r.weights).reduce((s, w) => s + (w ?? 0), 0);
        if (Object.keys(r.weights).length) expect(sum).toBeCloseTo(100);
        expect(["MASUK", "PANTAU", "LEWATI"]).toContain(r.action);
      }
    }
  });

  it("attention enters the score only when enabled", () => {
    const t = T0 + 40 * 60_000;
    const on = cfg();
    on.scoring.modules.attention = true;
    const off = cfg();
    off.scoring.modules.attention = false;
    const a = fedScorer(on).scoreAll(t)[0];
    const b = fedScorer(off).scoreAll(t)[0];
    expect(a.modules.attention).not.toBeNull();
    expect(a.weights.attention).toBeGreaterThan(0);
    expect(b.weights.attention).toBeUndefined();
  });

  it("every P1/P2 collector can be disabled in the config", () => {
    const raw = YAML.parse(readFileSync("config/default.yaml", "utf8"));
    const off = deepMerge(raw, { collectors: { venues: { enabled: false }, attention: { enabled: false }, macro: { enabled: false }, swap_stream: { enabled: false }, token_security: { enabled: false } } });
    expect(() => parseConfig(off)).not.toThrow();
  });

  it("without phase 7 sources the new features are simply unavailable", () => {
    const c = cfg();
    const s = fedScorer(c);
    const tr = s.trackers.get("PA")!;
    const f = computeFeatures(tr, { config: c, t: T0 + 40 * 60_000, eco: s.eco, security: () => null, macroEvents: [], riskTokens: ["TA"] });
    for (const k of ["pool_volume_share", "trending_score", "btc_trend_er", "fear_greed", "launchpad_heat"]) expect(f.get(k)?.raw).toBeNull();
  });
});

describe("P1 / P2 features", () => {
  it("pool volume share, attention proxies, BTC trend and macro context", () => {
    const c = cfg();
    const s = fedScorer(c);
    const r = s.scoreAll(T0 + 40 * 60_000);
    const a = r.find((x) => x.pool === "PA")!.features;
    expect(a.get("pool_volume_share")!.raw).toBeCloseTo(0.8);
    expect(a.get("venue_count")!.raw).toBe(3);
    expect(a.get("trending_score")!.raw).toBe(14);
    expect(a.get("social_presence")!.raw).toBe(3);
    expect(a.get("btc_trend_er")!.raw).toBeCloseTo(1); // monotonic series
    expect(a.get("fear_greed")!.raw).toBe(60);
    expect(a.get("launchpad_heat")!.raw).toBe(5);
    const b = r.find((x) => x.pool === "PB")!.features;
    expect(b.get("trending_score")!.raw).toBe(0);
    // regime penalty for a trending BTC
    expect(r[0].modules.regime).not.toBeNull();
  });

  it("flow extensions: wash share, whale share, markouts", () => {
    const c = cfg();
    c.scoring.features.min_flow_samples = 5;
    c.scoring.features.whale_swap_usd = 1;
    const s = fedScorer(c);
    const f = s.scoreAll(T0 + 40 * 60_000).find((x) => x.pool === "PA")!.features;
    expect(f.get("wash_share")!.raw).toBeGreaterThan(0);
    expect(f.get("whale_share")!.raw).toBeCloseTo(1);
    expect(f.get("markout_30s")!.raw).not.toBeNull();
    expect(f.get("markout_300s")!.raw).not.toBeNull();
    expect(f.get("lp_net_flow_1h")).toBeDefined();
  });

  it("markout never uses prices after t", () => {
    const s = fedScorer(cfg());
    const tr = s.trackers.get("PA")!;
    const t = T0 + 10 * 60_000;
    const swaps = [{ ts: t - 10_000, buy: true }];
    expect(markout(tr, swaps, t, 60_000)).toBeNull(); // horizon not elapsed
  });

  it("DexScreener pairs parsing and risk tokens", () => {
    const p = parseDexPairs([
      { dexId: "meteora", labels: ["DLMM"], pairAddress: "A", quoteToken: { symbol: "USDC" }, volume: { h1: 10, h24: 100 }, liquidity: { usd: 5 }, boosts: { active: 2 }, info: { socials: [1, 2], websites: [1] } },
      { dexId: "orca", pairAddress: "B", volume: {}, liquidity: null },
    ]);
    expect(p.pairs).toHaveLength(2);
    expect(p.pairs[0]).toMatchObject({ dex: "meteora", volume_h1: 10, boosts: 2 });
    expect(p.pairs[1].volume_h1).toBe(0);
    expect(p.socials).toBe(2);
    const c = cfg();
    const rt = riskTokens([meta("P", "TA"), { ...meta("Q", "So11111111111111111111111111111111111111112"), category: "bluechip" }], c);
    expect([...rt.keys()]).toEqual(["TA"]);
  });
});


import { Db, migrate } from "../src/db/index.ts";
import { every, setEveryErrorHandler } from "../src/util/async.ts";

describe("robustness (found during phase 7)", () => {
  it("batch mode commits periodically instead of holding one long transaction", () => {
    const db = new Db(":memory:");
    migrate(db);
    db.beginBatch();
    db.insert("macro_events", { ts: 1, name: "a" });
    db.insertMany("macro_events", [{ ts: 2, name: "b" }]); // nested tx joins the batch
    db.yieldBatch(0); // commit + reopen
    db.insert("macro_events", { ts: 3, name: "c" });
    db.endBatch();
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM macro_events")!.n).toBe(3);
    db.tx(() => db.insert("macro_events", { ts: 4, name: "d" })); // normal transactions still work
    db.close();
  });

  it("a failing tick does not stop a periodic loop", async () => {
    const errors: unknown[] = [];
    setEveryErrorHandler((e) => errors.push(e));
    const ac = new AbortController();
    let runs = 0;
    const p = every(1, ac.signal, async () => {
      runs++;
      if (runs === 1) throw new Error("database is locked");
      if (runs >= 3) ac.abort();
    });
    await p;
    expect(runs).toBe(3);
    expect(errors).toHaveLength(1);
    setEveryErrorHandler(() => {});
  });
});
