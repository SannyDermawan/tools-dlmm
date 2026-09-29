import { describe, expect, it } from "vitest";
import pino from "pino";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import { createSession, registerConfigVersion } from "../src/db/repo.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { efficiencyRatio, logReturns, type SecurityRow } from "../src/features/compute.ts";
import { estimateEdge, hashSeed, mulberry32 } from "../src/features/edge.ts";
import { Normalizer, percentileRank } from "../src/features/normalize.ts";
import { decideAction, effectiveWeights, regimeLabel, safetyGate } from "../src/features/scorer.ts";
import { LookaheadError, PoolTracker } from "../src/features/tracker.ts";
import { runScoreReplay } from "../src/features/scoreReplay.ts";
import type { AppContext } from "../src/app.ts";
import type { PoolMeta } from "../src/collectors/types.ts";

const cfg = (): Config => structuredClone(loadConfig().config);
const fv = (raw: number | null) => ({ raw, freshness: raw === null ? null : 0 });

describe("normalization", () => {
  it("percentile rank handles ties and winsorizes outliers", () => {
    expect(percentileRank(5, [1, 2, 3, 4, 5, 6, 7, 8, 9])).toBeCloseTo(50);
    expect(percentileRank(3, [3, 3, 3])).toBe(50);
    expect(percentileRank(1e9, [1, 2, 3, 4], [0, 100])).toBe(100);
    // a reference outlier is clipped: 3 now beats everything in [1, 2, 2.5, 2.5]
    expect(percentileRank(3, [1, 2, 3, 1e9], [0, 50])).toBe(100);
    expect(percentileRank(1, [])).toBe(50);
  });

  it("inverts 'higher is worse' features and blends own history once available", () => {
    const n = new Normalizer({ cross_weight: 0.5, min_history_points: 3, history_points: 100, winsor_pct: [0, 100] });
    const mk = (a: number, b: number) =>
      new Map([
        ["A", new Map([["fee_tvl_1h", fv(a)], ["top5_wallet_share", fv(a)]])],
        ["B", new Map([["fee_tvl_1h", fv(b)], ["top5_wallet_share", fv(b)]])],
      ]);
    const r = n.normalize(mk(2, 1));
    expect(r.get("A")!.get("fee_tvl_1h")).toBeGreaterThan(r.get("B")!.get("fee_tvl_1h")!);
    expect(r.get("A")!.get("top5_wallet_share")).toBeLessThan(r.get("B")!.get("top5_wallet_share")!); // inverted
    for (let i = 0; i < 3; i++) n.normalize(mk(1, 1));
    const later = n.normalize(mk(5, 5)); // cross ties (50) but far above own history (100)
    expect(later.get("A")!.get("fee_tvl_1h")).toBeCloseTo(75);
  });
});

describe("regime, gate, weights, action", () => {
  const c = cfg().scoring;
  const f = (vol: number, er: number, z: number) => new Map([["realized_vol", fv(vol)], ["efficiency_ratio", fv(er)], ["trend_z", fv(z)]]);
  it("labels regimes from ER / trend_z / volatility", () => {
    expect(regimeLabel(f(0.01, 0.1, 0.5), c.regime)).toBe("sideways");
    expect(regimeLabel(f(0.05, 0.2, 0.5), c.regime)).toBe("volatile_no_direction");
    expect(regimeLabel(f(0.05, 0.8, 3), c.regime)).toBe("trending_up");
    expect(regimeLabel(f(0.05, 0.8, -3), c.regime)).toBe("trending_down");
    expect(regimeLabel(f(0.5, 0.1, 0), c.regime)).toBe("chaos");
    expect(regimeLabel(new Map([["realized_vol", fv(null)]]), c.regime)).toBeNull();
  });

  it("safety gate vetoes per blueprint 9.1 and handles missing data by category", () => {
    const ok: SecurityRow = { token: "T", ts: 0, mint_auth_active: 0, freeze_auth_active: 0, transfer_fee_bps: null, top10_pct: 20, cluster_pct: 5, dev_rug_count: 0, rugged: 0, rugcheck_score: 1 };
    expect(safetyGate("memecoin", [ok], 50_000, c.safety_gate).passed).toBe(true);
    const cases: [Partial<SecurityRow>, RegExp][] = [
      [{ mint_auth_active: 1 }, /mint authority/],
      [{ freeze_auth_active: 1 }, /freeze authority/],
      [{ top10_pct: 41 }, /top10/],
      [{ cluster_pct: 21 }, /cluster/],
      [{ dev_rug_count: 2 }, /dev history/],
      [{ transfer_fee_bps: 150 }, /transfer fee/],
      [{ rugged: 1 }, /rugged/],
    ];
    for (const [patch, re] of cases) {
      const g = safetyGate("memecoin", [{ ...ok, ...patch }], 50_000, c.safety_gate);
      expect(g.passed).toBe(false);
      expect(g.reasons.join(";")).toMatch(re);
    }
    expect(safetyGate("memecoin", [ok], 5_000, c.safety_gate).reasons.join()).toMatch(/TVL/);
    expect(safetyGate("memecoin", [null], 50_000, c.safety_gate).passed).toBe(false);
    const blue = safetyGate("bluechip", [null], 50_000, c.safety_gate);
    expect(blue.passed).toBe(true);
    expect(blue.missingData).toBe(true);
  });

  it("redistributes weights of unavailable / disabled modules proportionally", () => {
    const base = c.weights.v1_default.memecoin;
    const w = effectiveWeights(base, { edge: 50, regime: 50, flow: null, attention: 50, competition: 50, safety: 50 }, c.modules);
    expect(w.flow).toBeUndefined();
    expect(w.attention).toBeUndefined(); // disabled in config
    const sum = Object.values(w).reduce((s, x) => s + (x ?? 0), 0);
    expect(sum).toBeCloseTo(100);
    expect(w.edge! / w.regime!).toBeCloseTo(35 / 20);
  });

  it("maps final score to MASUK / PANTAU / LEWATI with gate and confidence", () => {
    expect(decideAction(80, true, 0.9, c)).toBe("MASUK");
    expect(decideAction(80, true, 0.2, c)).toBe("PANTAU");
    expect(decideAction(65, true, 0.9, c)).toBe("PANTAU");
    expect(decideAction(59, true, 0.9, c)).toBe("LEWATI");
    expect(decideAction(99, false, 1, c)).toBe("LEWATI");
    expect(decideAction(null, true, 1, c)).toBe("LEWATI");
  });
});

describe("feature helpers", () => {
  it("efficiency ratio: 1 for a straight line, ~0 for back and forth", () => {
    expect(efficiencyRatio([1, 2, 3, 4])).toBeCloseTo(1);
    expect(efficiencyRatio([1, 2, 1, 2, 1])).toBeCloseTo(0);
    expect(logReturns([1, Math.E])).toEqual([1]);
  });
  it("PRNG is deterministic per seed", () => {
    const a = mulberry32(hashSeed(1, "p", 2));
    const b = mulberry32(hashSeed(1, "p", 2));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(hashSeed(1, "p", 2)).not.toBe(hashSeed(1, "p", 3));
  });
});

describe("edge (Monte Carlo)", () => {
  const base = {
    binStep: 20, decimalsX: 6, decimalsY: 6, activeId: 0, priceUi: 1, quoteUsd: 1, solUsd: 100, priorityMicroLamports: 10_000,
    feeRateTotal: 0.002, sigma1m: 0.001, feeYield: [0.0005, 0.0001, 0.0001], seed: 7,
  };
  const cands = [5, 20].map((n) => ({ strategy: "spot" as const, sides: "two_sided" as const, binsPerSide: n }));
  it("more fee flow -> more edge; zero volatility -> no IL and full time in range", () => {
    const c = cfg();
    const lo = estimateEdge({ ...base, feeYield: [0.0001, 0.00002, 0.00002] }, cands, c);
    const hi = estimateEdge({ ...base, feeYield: [0.001, 0.0002, 0.0002] }, cands, c);
    expect(hi[0].feeUsd).toBeCloseTo(lo[0].feeUsd * 10, 6); // linear in yield
    const still = estimateEdge({ ...base, sigma1m: 0 }, cands, c);
    expect(still[0].pInRange).toBe(1);
    expect(Math.abs(still[0].ilUsd)).toBeLessThan(1e-3); // only undeployed dust
    // a narrow range holds more of our liquidity near the active bin -> more fee
    expect(still[0].feeUsd).toBeGreaterThan(still[1].feeUsd);
    // exact at zero volatility: yield(active) * L(active) + yield(1) * (L(-1) + L(+1)), 120 steps
  });
  it("higher volatility -> lower time in range and more IL for narrow ranges", () => {
    const c = cfg();
    const calm = estimateEdge({ ...base, sigma1m: 0.0005 }, cands, c)[0];
    const wild = estimateEdge({ ...base, sigma1m: 0.01 }, cands, c)[0];
    expect(wild.pInRange).toBeLessThan(calm.pInRange);
    expect(wild.ilUsd).toBeLessThan(calm.ilUsd);
    expect(estimateEdge(base, cands, c)).toEqual(estimateEdge(base, cands, c)); // reproducible
  });
});

// ------------------------------------------------------------------ look-ahead (blueprint 17.1)
const META: PoolMeta = {
  pool: "POOLA", name: "T-USD", tokenX: "TOKA", tokenY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbolX: "T", symbolY: "USDC",
  decimalsX: 6, decimalsY: 6, binStep: 20, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep: 20, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: { baseFactor: 10000, filterPeriod: 30, decayPeriod: 600, reductionFactor: 5000, variableFeeControl: 0, maxVolatilityAccumulator: 0, minBinId: -1000, maxBinId: 1000, protocolShare: 500, baseFeePowerFactor: 0, functionType: 0, collectFeeMode: 0 },
  createdAt: null,
};

/** Synthetic 60-minute data session for two pools. */
function syntheticSession(db: Db, lcVersion: string): { sessionId: string; start: number } {
  const start = Date.UTC(2026, 8, 1, 12, 0, 0);
  const sid = createSession(db, { kind: "collect", configVersion: lcVersion, label: "synthetic" });
  db.run("UPDATE sessions SET start_at=?, end_at=?, status='completed' WHERE session_id=?", start, start + 60 * 60_000, sid);
  const rnd = mulberry32(99);
  for (const [k, pool] of ["POOLA", "POOLB"].entries()) {
    db.insert("pools", {
      pool, name: `P${k}`, token_x: `TOK${k}`, token_y: META.tokenY, decimals_x: 6, decimals_y: 6, bin_step: 20, base_factor: 10000,
      base_fee_power_factor: 0, variable_fee_control: 0, protocol_share: 500, collect_fee_mode: 0, category: "memecoin",
      first_seen_at: start, last_checked_at: start, params_json: JSON.stringify({ s: META.s }),
    });
    db.insert("session_pools", { session_id: sid, pool, added_at: start, rank: k + 1 });
    db.insert("token_security", { token: `TOK${k}`, ts: start - 1000, session_id: sid, mint_auth_active: 0, freeze_auth_active: 0, top10_pct: 25 + k * 30, cluster_pct: 3, dev_rug_count: 0, rugged: 0, source: "test" });
    let active = 0;
    let fee = 0n;
    for (let t = start; t <= start + 60 * 60_000; t += 5000) {
      active += Math.round((rnd() - 0.5) * 2);
      db.insert("pool_snapshots", { pool, ts: t, source: "chain", session_id: sid, slot: t, active_bin: active, price: binUiPrice(active, 20, 6, 6), total_fee_rate: 0.002 });
      if ((t - start) % 60_000 === 0) {
        db.insert("pool_snapshots", { pool, ts: t + 1, source: "api", session_id: sid, tvl_usd: 50_000 + k * 1000, volume_1h_usd: 20_000, volume_24h_usd: 240_000, fee_1h_usd: 40, fee_tvl_1h: 0.08, token_x_usd: binUiPrice(active, 20, 6, 6), token_y_usd: 1 });
        if (k === 0) db.insert("ecosystem_metrics", { ts: t + 2, session_id: sid, sol_usd: 100 + rnd(), priority_fee_p50: 1000, priority_fee_p75: 5000, priority_fee_p90: 9000 });
      }
      if ((t - start) % 30_000 === 0) {
        fee += Q64 / 100000n;
        db.insert("bin_snapshot_meta", { pool, ts: t, session_id: sid, slot: t, active_bin: active, lower_bin: active - 20, upper_bin: active + 20, missing_bin_arrays: "[]", bin_count: 41, stored_count: 41, full: 1 });
        for (let id = active - 20; id <= active + 20; id++) {
          const P = binRawPrice(id, 20);
          const x = id >= active ? 1_000_000_000n : 0n;
          const y = id <= active ? 1_000_000_000n : 0n;
          db.insert("bin_snapshots", {
            pool, ts: t, bin_id: id, x_amount: x.toString(), y_amount: y.toString(),
            liquidity_supply: (BigInt(Math.floor(P * Number(x) + Number(y))) * Q64).toString(),
            fee_x_per_token: (Math.abs(id - active) <= 1 ? fee : 0n).toString(), fee_y_per_token: (Math.abs(id - active) <= 1 ? fee : 0n).toString(),
          });
        }
      }
    }
  }
  return { sessionId: sid, start };
}

describe("look-ahead guard", () => {
  it("a tracker refuses to score before data it already holds", () => {
    const tr = new PoolTracker(META, 3_600_000, 5, 10);
    tr.onState({ pool: "POOLA", ts: 2000, slot: 1, activeId: 0, priceUi: 1, v: {} as never, feeRateTotal: 0.01, feeRateLp: 0.01 });
    expect(() => tr.assertNotAfter(1999)).toThrow(LookaheadError);
    expect(() => tr.assertNotAfter(2000)).not.toThrow();
  });

  it("scores at t are identical with and without data after t (full pipeline, stored)", () => {
    const db = new Db(":memory:");
    migrate(db);
    const lc = loadConfig();
    const v = registerConfigVersion(db, lc);
    const { sessionId, start } = syntheticSession(db, v);
    const app = { db, lc, configVersion: v, log: pino({ level: "silent" }) } as unknown as AppContext;
    const cut = start + 40 * 60_000;
    const full = runScoreReplay(app, sessionId);
    const trunc = runScoreReplay(app, sessionId, { untilTs: cut });
    const q = (sid: string) =>
      db.all<Record<string, unknown>>(
        "SELECT pool, ts, edge, regime, flow, competition, safety, gate_passed, context_multiplier, final_score, confidence, action, recommendation FROM scores WHERE session_id=? AND ts<=? ORDER BY pool, ts",
        sid, cut,
      );
    const a = q(full.sessionId);
    const b = q(trunc.sessionId);
    expect(a.length).toBeGreaterThan(60);
    expect(b).toEqual(a);
    const fa = db.all("SELECT pool, ts, name, raw_value, norm_value FROM features WHERE session_id=? AND ts<=? ORDER BY pool, ts, name", full.sessionId, cut);
    const fb = db.all("SELECT pool, ts, name, raw_value, norm_value FROM features WHERE session_id=? AND ts<=? ORDER BY pool, ts, name", trunc.sessionId, cut);
    expect(fb).toEqual(fa);
    // scores exist on the fixed interval grid
    const ts = [...new Set(a.map((r) => r.ts as number))];
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBe(lc.config.scoring.interval_seconds * 1000);
    // a pool with top10 above the threshold is vetoed, the other passes once data is fresh
    const gates = db.all<{ pool: string; g: number }>("SELECT pool, MAX(gate_passed) g FROM scores WHERE session_id=? GROUP BY pool", full.sessionId);
    expect(gates.find((x) => x.pool === "POOLA")!.g).toBe(1);
    expect(gates.find((x) => x.pool === "POOLB")!.g).toBe(0);
    db.close();
  });
});

import { parseRugcheckReport } from "../src/collectors/tokenSecurity.ts";

describe("RugCheck report parsing", () => {
  it("top10 excludes AMM/locker/burn/reserves; cluster and dev history derived", () => {
    const now = Date.UTC(2026, 8, 29);
    const rep = {
      token: { supply: 1000 },
      creator: "DEV",
      topHolders: [
        { address: "amm1", owner: "poolOwner", pct: 30 },
        { address: "lock1", owner: "lockOwner", pct: 20 },
        { address: "burnAcc", owner: "1nc1nerator11111111111111111111111111111111", pct: 5 },
        { address: "ourReserve", owner: "x", pct: 4 },
        ...Array.from({ length: 12 }, (_, i) => ({ address: `h${i}`, owner: `o${i}`, pct: 2 })),
      ],
      knownAccounts: { poolOwner: { type: "AMM" }, lock1: { type: "LOCKER" } },
      insiderNetworks: [{ currentHolding: 150 }, { currentHolding: 50 }],
      creatorTokens: [
        { mint: "MINT", marketCap: 1, createdAt: "2026-01-01T00:00:00Z" }, // itself: ignored
        { mint: "a", marketCap: 100, createdAt: "2026-01-01T00:00:00Z" }, // dead
        { mint: "b", marketCap: 1e6, createdAt: "2026-01-01T00:00:00Z" }, // alive
        { mint: "c", marketCap: 10, createdAt: "2026-09-28T00:00:00Z" }, // too young to judge
      ],
      mintAuthority: null, freezeAuthority: "F", score_normalised: 40, rugged: false, transferFee: { pct: 0 },
    };
    const d = parseRugcheckReport(rep, "MINT", new Set(["ourReserve"]), 5000, now);
    expect(d.top10Pct).toBeCloseTo(20);
    expect(d.top10Excluded).toEqual(["amm1", "lock1", "burnAcc", "ourReserve"]);
    expect(d.clusterPct).toBeCloseTo(15);
    expect(d.devRugCount).toBe(1);
    expect(d.freezeAuthority).toBe("F");
    // a whole-graph "network" (huge, above supply) is not a cluster
    const huge = parseRugcheckReport({ ...rep, insiderNetworks: [{ size: 128794, currentHolding: 3300 }, { size: 4, currentHolding: 20 }] }, "MINT", new Set(), 5000, now);
    expect(huge.clusterPct).toBeCloseTo(2);
    const bad = parseRugcheckReport({ ...rep, insiderNetworks: [{ size: 5, currentHolding: 3300 }] }, "MINT", new Set(), 5000, now);
    expect(bad.clusterPct).toBeNull();
  });
});
