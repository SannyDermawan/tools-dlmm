import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import { registerConfigVersion } from "../src/db/repo.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { parseJupiterToken, pvpRivals, TokenAuditCollector } from "../src/collectors/tokenAudit.ts";
import { auditGate } from "../src/features/auditGate.ts";
import { addBlock, auditLookup, blocklistLookup, removeBlock, type AuditRow } from "../src/features/safetyData.ts";
import { PoolMemory } from "../src/features/memory.ts";
import { detectRug, RugDetector } from "../src/features/rugDetector.ts";
import { Scorer } from "../src/features/scorer.ts";
import { PoolTracker } from "../src/features/tracker.ts";
import { MemorySink, PoolSimulator, type PositionResult } from "../src/sim/engine.ts";
import { GridRunner, SessionClock } from "../src/sim/gridRunner.ts";
import type { VirtualPosition } from "../src/sim/position.ts";
import { SignalBook } from "../src/signals/signalEngine.ts";
import { presetInputsOf } from "../src/signals/stack.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const cfg = (): Config => structuredClone(loadConfig().config);
const MIN = 60_000;
const HOUR = 60 * MIN;
const meta = (pool = "POOL"): PoolMeta => ({
  pool, name: "T-USD", tokenX: `T-${pool}`, tokenY: "USD", symbolX: "T", symbolY: "USD", decimalsX: 6, decimalsY: 6,
  binStep: 100, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep: 100, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt: null,
});
const state = (ts: number, activeId: number, pool = "POOL"): PoolStateUpdate => ({
  pool, ts, slot: ts, activeId, priceUi: binUiPrice(activeId, 100, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: 0.01, feeRateLp: 0.0095,
});
/** Bin snapshot with `scale` x the default liquidity per bin. */
const snapshot = (ts: number, activeId: number, pool = "POOL", scale = 1): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  const unit = BigInt(Math.round(1_000_000_000 * scale));
  for (let id = activeId - 40; id <= activeId + 40; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= activeId ? unit : 0n;
    const y = id <= activeId ? unit : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: 0n, feeY: 0n, priceRaw: P });
  }
  return { pool, ts, slot: ts, activeId, lower: activeId - 40, upper: activeId + 40, missingBinArrays: [], bins };
};
const audit = (o: Partial<AuditRow> = {}): AuditRow => ({
  token: "TOKEN1", ts: 0, symbol: "TKN", organic_score: 80, holder_count: 5000, mcap_usd: 1e6, launchpad: null, dev: "DEV1",
  token_created_at: null, first_pool_at: null, top_holders_pct: 20, dev_balance_pct: 2, bot_holders_pct: 5, is_sus: 0, pvp_rival_count: 0, ...o,
});
const newDb = () => {
  const db = new Db(":memory:");
  migrate(db);
  return db;
};

describe("Jupiter token audit (addendum 3.1)", () => {
  it("parses Tokens API V2 + datapi fields", () => {
    const r = parseJupiterToken(
      {
        id: "M", symbol: "TKN", name: "Token", organicScore: 42.5, organicScoreLabel: "medium", holderCount: 1234, mcap: 5e5, fdv: 6e5,
        usdPrice: 0.01, liquidity: 1e5, launchpad: "pump.fun", dev: "DEV", createdAt: "2026-09-01T00:00:00Z", firstPool: { createdAt: "2026-09-02T00:00:00Z" },
        audit: { topHoldersPercentage: 31.5, devBalancePercentage: 1.2, devMints: 3, isSus: true }, isVerified: false, tags: ["x"],
        stats24h: { buyVolume: 1000, sellVolume: 500 },
      },
      // holdingPct is already a percentage (live values up to 4.3), stored as is
      { audit: { botHoldersPercentage: 12.5, botHoldersCount: 40, bundlerStats: { holdingPct: 5 } }, fees: 3.2 },
    );
    expect(r).toMatchObject({
      organic_score: 42.5, holder_count: 1234, launchpad: "pump.fun", dev: "DEV", top_holders_pct: 31.5, bot_holders_pct: 12.5,
      bundler_holding_pct: 5, is_sus: 1, is_verified: 0, volume_24h_usd: 1500, fees_sol: 3.2,
    });
    expect(r.token_created_at).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(r.first_pool_at).toBe(Date.parse("2026-09-02T00:00:00Z"));
    // isSus absent -> not suspicious
    expect(parseJupiterToken({ id: "M", audit: {} }).is_sus).toBe(0);
  });

  it("PVP rivals: same symbol or name, other mint, enough volume", () => {
    const res = [
      { id: "SELF", symbol: "TKN", stats24h: { buyVolume: 1e6, sellVolume: 0 } },
      { id: "A", symbol: "tkn", stats24h: { buyVolume: 20_000, sellVolume: 0 } },
      { id: "B", name: "Token", symbol: "OTHER", stats24h: { buyVolume: 50_000, sellVolume: 0 } },
      { id: "C", symbol: "TKN", stats24h: { buyVolume: 100, sellVolume: 0 } },
      { id: "D", symbol: "NOPE", stats24h: { buyVolume: 1e6, sellVolume: 0 } },
    ];
    const r = pvpRivals({ mint: "SELF", symbol: "TKN", name: "Token" }, res, 10_000);
    expect(r.map((x) => x.mint)).toEqual(["B", "A"]);
  });

  it("collector writes one row per mint, errors for unknown mints, PVP counts", async () => {
    const db = newDb();
    const c = cfg();
    const queries: string[] = [];
    const tokens = {
      get: async (_p: string, q: { query: string }) => {
        queries.push(q.query);
        return q.query.includes("MINT1")
          ? [{ id: "MINT1", symbol: "AAA", organicScore: 70, audit: {} }]
          : q.query === "AAA" ? [{ id: "MINT1", symbol: "AAA" }, { id: "RIVAL", symbol: "AAA", stats24h: { buyVolume: 50_000, sellVolume: 0 } }] : [];
      },
    };
    const datapi = { get: async () => [{ id: "MINT1", audit: { botHoldersPercentage: 9 } }] };
    const col = new TokenAuditCollector({
      db, log: { warn() {}, info() {}, error() {}, debug() {} } as never, gaps: { ok() {} } as never, config: c, sessionId: "S",
      pools: new Map(), tokensHttp: tokens as never, datapiHttp: datapi as never,
    });
    await col.auditBatch(["MINT1", "MINT2"], 1000);
    const rows = db.all<{ token: string; organic_score: number | null; bot_holders_pct: number | null; pvp_rival_count: number | null; error: string | null; source: string }>(
      "SELECT token, organic_score, bot_holders_pct, pvp_rival_count, error, source FROM token_audit ORDER BY token",
    );
    expect(rows[0]).toMatchObject({ token: "MINT1", organic_score: 70, bot_holders_pct: 9, pvp_rival_count: 1, error: null, source: "tokens_v2+datapi" });
    expect(queries).toEqual(["MINT1,MINT2", "AAA"]); // mints batched, symbols one by one
    expect(rows[1].token).toBe("MINT2");
    expect(rows[1].error).toMatch(/not found/);
    // readers skip error rows and stale rows
    const look = auditLookup(db, 10 * MIN);
    expect(look("MINT1", 1000)?.organic_score).toBe(70);
    expect(look("MINT2", 1000)).toBeNull();
    expect(look("MINT1", 999)).toBeNull(); // no look-ahead
    expect(look("MINT1", 1000 + 11 * MIN)).toBeNull(); // stale
  });
});

describe("audit gate (addendum 3.1-3.3)", () => {
  const g = () => cfg().scoring.safety_gate;
  it("passes a clean token", () => {
    const r = auditGate("memecoin", [audit()], [], 0, g());
    expect(r.reasons).toEqual([]);
    expect(r.penalty).toBe(0);
  });
  it("vetoes bot holders, sus, blocked launchpad, token age; blocklist first", () => {
    const x = g();
    x.launchpad.block = ["pump.fun"];
    x.token_age_hours.min = 24;
    const t = 10 * HOUR;
    const r = auditGate("memecoin", [audit({ bot_holders_pct: 45, is_sus: 1, launchpad: "Pump.fun", first_pool_at: t - 2 * HOUR })], [{ kind: "dev", key: "DEV1", reason: "rug", source: "manual" }], t, x);
    expect(r.filters).toEqual(["blocklist", "bot_holders", "sus", "launchpad", "token_age"]);
  });
  it("launchpad allow list, PVP modes and organic penalty", () => {
    const x = g();
    x.launchpad.allow = ["met-dbc"];
    expect(auditGate("memecoin", [audit({ launchpad: null })], [], 0, x).filters).toEqual(["launchpad"]);
    const y = g();
    const pen = auditGate("memecoin", [audit({ pvp_rival_count: 2, organic_score: 10 })], [], 0, y);
    expect(pen.reasons).toEqual([]);
    expect(pen.penalty).toBe(y.pvp.penalty + y.organic.penalty);
    y.pvp.mode = "fail";
    expect(auditGate("memecoin", [audit({ pvp_rival_count: 2 })], [], 0, y).filters).toEqual(["pvp"]);
    y.pvp.mode = "ignore";
    expect(auditGate("memecoin", [audit({ pvp_rival_count: 2 })], [], 0, y).penalty).toBe(0);
  });
  it("missing audit never vetoes; bluechip only checks the blocklist", () => {
    const r = auditGate("memecoin", [null], [], 0, g());
    expect(r.reasons).toEqual([]);
    expect(r.auditMissing).toBe(true);
    expect(auditGate("bluechip", [audit({ bot_holders_pct: 90 })], [], 0, g()).reasons).toEqual([]);
  });
});

describe("blocklist (addendum 3.2)", () => {
  it("is time-aware: later additions / removals do not change earlier decisions", () => {
    const db = newDb();
    expect(addBlock(db, "token", "MINT", "scam", "manual", 1000)).toBe(true);
    expect(addBlock(db, "token", "MINT", "again", "manual", 1500)).toBe(false); // already active
    const bl = blocklistLookup(db);
    expect(bl.token("MINT", 999)).toBeNull();
    expect(bl.token("MINT", 1000)?.reason).toBe("scam");
    expect(removeBlock(db, "token", "MINT", 5 * MIN)).toBe(1);
    bl.invalidate();
    expect(bl.token("MINT", 4 * MIN)?.reason).toBe("scam"); // still blocked before the removal
    expect(bl.token("MINT", 6 * MIN)).toBeNull();
    expect(bl.dev(null, 1000)).toBeNull();
  });

  it("a blocked pool is LEWATI with the blocklist filter, before any feature is computed", () => {
    const db = newDb();
    const c = cfg();
    const m = meta("P1");
    addBlock(db, "token", m.tokenX, "scam", "manual", 0);
    const s = new Scorer({ config: c, metas: [m, meta("P2")], security: () => null, macroEvents: [], blocklist: blocklistLookup(db) });
    const res = s.scoreAll(MIN);
    const r = res.find((x) => x.pool === "P1")!;
    expect(r.action).toBe("LEWATI");
    expect(r.gate.filters).toEqual(["blocklist"]);
    expect(r.features.size).toBe(0);
    expect(r.risks[0]).toMatch(/blocklisted token/);
    expect(res.find((x) => x.pool === "P2")!.gate.filters).not.toContain("blocklist");
  });
});

/** Minimal closed position for PoolMemory.onClose. */
const closed = (pool: string, entryMode: string, reason: string, ts: number, cohort: number, net = 0): [VirtualPosition, PositionResult] => [
  { pool, closedAt: ts, closeReason: reason, gapTainted: false, spec: { entryMode, cohort } } as unknown as VirtualPosition,
  { netPnlPct: net } as PositionResult,
];

describe("pool memory and cooldown (addendum 3.4)", () => {
  const tokenOf = (pool: string) => `T-${pool}`;
  it("low-yield close -> pool cooldown for low_yield_hours, visible only from the close on", () => {
    const c = cfg();
    const mem = new PoolMemory(null, c, "S", tokenOf);
    mem.onClose(...closed("P", "signal_enter", "low_yield", 10 * MIN, 1));
    expect(mem.poolCooldown("P", 9 * MIN)).toBeNull(); // no look-ahead
    expect(mem.poolCooldown("P", 11 * MIN)?.reason).toMatch(/low yield/);
    expect(mem.poolCooldown("P", 10 * MIN + c.memory.cooldown.low_yield_hours * HOUR)).toBeNull();
    // modes not listed in memory.cooldown.modes do not drive cooldowns
    const m2 = new PoolMemory(null, c, "S", tokenOf);
    m2.onClose(...closed("P", "all_pools_baseline", "low_yield", 10 * MIN, 1));
    expect(m2.poolCooldown("P", 11 * MIN)).toBeNull();
  });

  it("N out-of-range cohorts in a row -> pool and token cooldown; other outcomes break the row", () => {
    const c = cfg();
    const n = c.memory.cooldown.oor_consecutive;
    const mem = new PoolMemory(null, c, "S", tokenOf);
    let t = 0;
    for (let k = 1; k < n; k++) mem.onClose(...closed("P", "signal_enter", "exit_out_of_range", (t += MIN), k));
    mem.onClose(...closed("P", "signal_enter", "exit_out_of_range", (t += MIN), 1)); // same cohort: counted once
    mem.onClose(...closed("P", "signal_enter", "take_profit", (t += MIN), n)); // breaks the row
    expect(mem.poolCooldown("P", t + 1)).toBeNull();
    for (let k = n + 1; k <= 2 * n; k++) mem.onClose(...closed("P", "signal_enter", "max_rebalances", (t += MIN), k));
    mem.onClose(...closed("P", "signal_enter", "session_end", (t += MIN), 99)); // neutral
    expect(mem.poolCooldown("P", t)?.reason).toMatch(/out-of-range/);
    // the token cools down too: another pool of the same token is blocked
    expect(mem.cooldown("OTHER", "T-P", t)).not.toBeNull();
    expect(mem.stats.oorCooldowns).toBe(1);
  });

  it("persists per session; later sessions read it only after that session ended", () => {
    const db = newDb();
    const c = cfg();
    const cv = registerConfigVersion(db, loadConfig());
    db.insert("sessions", { session_id: "S1", kind: "session", start_at: 0, status: "completed", config_version: cv });
    db.insert("pools", { pool: "P", token_x: "T-P", token_y: "USD", decimals_x: 6, decimals_y: 6, bin_step: 100, category: "memecoin", first_seen_at: 0, last_checked_at: 0 });
    const base = (id: string, net: number, reason = "session_end") => {
      db.insert("sim_positions", {
        position_id: id, session_id: "S1", pool: "P", grid_combo: "{}", entry_mode: "all_pools_baseline", strategy: "spot", sides: "two_sided",
        bins_below: 1, bins_above: 1, capital_usd: 1000, requested_at: 0, close_reason: reason, gap_tainted: 0, config_version: cv, status: "closed",
      });
      db.insert("sim_results", { position_id: id, net_pnl_usd: net * 10, net_pnl_pct: net });
    };
    base("a", 2);
    base("b", -1);
    base("c", 3, "exit_out_of_range");
    const m1 = new PoolMemory(db, c, "S1", tokenOf);
    m1.onClose(...closed("P", "signal_enter", "low_yield", HOUR, 1));
    expect(m1.persist(2 * HOUR, ["P"])).toBe(2); // pool + token rows
    const row = db.get<{ positions: number; avg_net_pct: number; win_rate: number; cooldown_until: number; close_reasons: string }>(
      "SELECT positions, avg_net_pct, win_rate, cooldown_until, close_reasons FROM pool_memory WHERE kind='pool' AND key='P'",
    )!;
    expect(row).toMatchObject({ positions: 3, avg_net_pct: 4 / 3, win_rate: 2 / 3, cooldown_until: HOUR + c.memory.cooldown.low_yield_hours * HOUR });
    expect(JSON.parse(row.close_reasons)).toEqual({ session_end: 2, exit_out_of_range: 1 });
    const m2 = new PoolMemory(db, c, "S2", tokenOf);
    expect(m2.poolStats("P", 2 * HOUR - 1)).toBeNull(); // S1 not ended yet at that time
    expect(m2.poolStats("P", 2 * HOUR)).toMatchObject({ positions: 3 });
    expect(m2.poolCooldown("P", 3 * HOUR)?.reason).toMatch(/low yield/);
  });
});

describe("grid: pool cooldown dimension", () => {
  it("signal modes with cooldown skip a pool in cooldown, without cooldown they enter", () => {
    const c = cfg();
    c.grid.entry_modes = ["all_pools_baseline", "signal_watch"];
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [2];
    c.grid.range_pct = [];
    c.grid.sides = ["two_sided"];
    c.grid.exit_policies = [{ type: "hold_to_session_end" }] as never;
    c.grid.variants = ["none"];
    c.grid.cooldown_enabled = [true, false];
    c.grid.entry_filter = ["none"];
    c.grid.cooldown_min_session_minutes = 0; // the test session is 60 min
    const sink = new MemorySink();
    let n = 0;
    const sim = new PoolSimulator(meta("P"), c, sink, () => `P-${++n}`);
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 10_000 });
    sim.onState(state(0, 1000, "P"));
    sim.onBins(snapshot(0, 1000, "P"));
    const book = new SignalBook(null, c, "S", "v", () => `sig${++n}`);
    const t0 = 0;
    book.onScores([{
      pool: "P", ts: t0, category: "memecoin", features: new Map(), norm: new Map(),
      modules: { edge: 60, regime: 60, flow: null, attention: null, competition: 60, safety: 90 },
      gate: { passed: true, reasons: [], missingData: false }, context: { multiplier: 1, reasons: [] }, weights: {},
      baseScore: 65, finalScore: 65, confidence: 0.8, regime: "sideways", action: "PANTAU", edge: null, edgeCandidates: [],
      recommendation: null, expectations: null, topReasons: [], risks: [],
    }]);
    const mem = new PoolMemory(null, c, "S", () => "T-P");
    mem.onClose(...closed("P", "signal_enter", "low_yield", t0, 1));
    const clock = new SessionClock(t0, { durationMinutes: 60, warmupMinutes: 0, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 });
    const runner = new GridRunner(c, new Map([["P", sim]]), clock, undefined, { book, memory: mem });
    runner.onTick(t0 + 1000);
    const modes = sim.list().map((p) => `${p.spec.entryMode}:${p.spec.cooldownEnabled}`);
    expect(modes.sort()).toEqual(["all_pools_baseline:null", "signal_watch:false"]);
    expect(runner.stats.cooldownSkips).toBe(1);
  });
});

describe("automatic rug detection (addendum 3.2)", () => {
  const c = () => cfg().rug_detection;
  const trackerWith = (drop: boolean, withdraw: boolean) => {
    const tr = new PoolTracker(meta("P"), 2 * HOUR, 5, 3);
    tr.onMetrics({ ts: 0, tvlUsd: 1e5, volume1h: 1e4, volume24h: 1e5, fee1h: 10, feeTvl1h: 0.01, xUsd: 1, yUsd: 1 });
    for (let k = 0; k <= 15; k++) {
      const t = k * MIN;
      const id = drop && k >= 10 ? 1000 - 80 : 1000; // 1.01^-80 ≈ -55%
      tr.onState(state(t, id, "P"));
      tr.onBins(snapshot(t, id, "P", withdraw && k >= 10 ? 0.2 : 1));
    }
    return tr;
  };
  it("price crash + liquidity withdrawn -> rug; crash with LPs staying -> not a rug", () => {
    const t = 15 * MIN;
    const ev = detectRug(trackerWith(true, true), "T-P", t, c(), { now: null, before: null });
    expect(ev?.rule).toBe("price_and_lp");
    expect(ev!.priceDropPct!).toBeGreaterThan(50);
    expect(ev!.lpWithdrawalPct!).toBeGreaterThan(50);
    expect(detectRug(trackerWith(true, false), "T-P", t, c(), { now: null, before: null })).toBeNull();
    expect(detectRug(trackerWith(false, false), "T-P", t, c(), { now: null, before: null })).toBeNull();
  });
  it("dev dump -> rug; detector blocklists token and dev at t once", () => {
    const tr = trackerWith(false, false);
    const ev = detectRug(tr, "T-P", 15 * MIN, c(), { now: audit({ ts: 14 * MIN, dev_balance_pct: 1 }), before: audit({ ts: 0, dev_balance_pct: 10 }) });
    expect(ev?.rule).toBe("dev_dump");
    const db = newDb();
    db.insert("token_audit", { token: "T-P", ts: 0, dev: "DEVX", dev_balance_pct: 10, source: "tokens_v2" });
    db.insert("token_audit", { token: "T-P", ts: 14 * MIN, dev: "DEVX", dev_balance_pct: 1, source: "tokens_v2" });
    let invalidated = 0;
    const det = new RugDetector(db, cfg(), () => ["T-P"], () => invalidated++);
    expect(det.check([tr], 15 * MIN)).toHaveLength(1);
    expect(det.check([tr], 16 * MIN)).toHaveLength(0); // flagged once
    expect(invalidated).toBe(1);
    const bl = blocklistLookup(db);
    expect(bl.token("T-P", 15 * MIN - 1)).toBeNull();
    expect(bl.token("T-P", 15 * MIN)?.source).toBe("auto_rug");
    expect(bl.dev("DEVX", 15 * MIN)?.source).toBe("auto_rug");
  });
});

describe("decision log and Meridian inputs", () => {
  it("signals journal risks and the rejected candidates of the round", () => {
    const db = newDb();
    const c = cfg();
    const base = {
      ts: 0, category: "memecoin" as const, features: new Map(), norm: new Map(),
      modules: { edge: 60, regime: 60, flow: null, attention: null, competition: 60, safety: 90 },
      context: { multiplier: 1, reasons: [] }, weights: {}, baseScore: 80, confidence: 0.9, regime: "sideways" as const,
      edge: null, edgeCandidates: [], recommendation: null, expectations: null, topReasons: [],
    };
    const book = new SignalBook(db, c, "S", "v");
    book.onScores([
      { ...base, pool: "A", finalScore: 85, action: "MASUK", gate: { passed: true, reasons: [], missingData: false, filters: [] }, risks: ["2 PVP rival token(s) (T)"] },
      { ...base, pool: "B", finalScore: null, action: "LEWATI", gate: { passed: false, reasons: ["bot holders 45.0% > 30%"], missingData: false, filters: ["bot_holders"] }, risks: ["bot holders 45.0% > 30%"] },
    ]);
    const a = db.get<{ risks: string; rejected_candidates: string }>("SELECT risks, rejected_candidates FROM signals WHERE pool='A'")!;
    expect(JSON.parse(a.risks)).toEqual(["2 PVP rival token(s) (T)"]);
    expect(JSON.parse(a.rejected_candidates)).toEqual([{ pool: "B", score: null, action: "LEWATI", reason: "gate: bot holders 45.0% > 30%" }]);
    expect(db.get<{ r: string | null }>("SELECT rejected_candidates r FROM signals WHERE pool='B'")!.r).toBeNull();
  });

  it("Meridian preset gets organic score and bot holders from the audit", () => {
    const tr = new PoolTracker(meta("P"), HOUR, 5, 3);
    tr.onState(state(0, 1000, "P"));
    const x = presetInputsOf(tr, meta("P"), MIN, 5, 5, 1, new Set(["USD"]), () => null, (tk) => (tk === "T-P" ? audit({ token: "T-P", organic_score: 66, bot_holders_pct: 7 }) : null));
    expect(x).toMatchObject({ organic: 66, botHoldersPct: 7, holders: 5000, top10Pct: 20 });
    const y = presetInputsOf(tr, meta("P"), MIN, 5, 5, 1, new Set(["USD"]), () => null);
    expect(y).toMatchObject({ organic: null, botHoldersPct: null });
  });
});

describe("bin array initialization (addendum 3.5)", () => {
  const run = (avoid: boolean, entryMode: string) => {
    const c = cfg();
    c.simulation.avoid_bin_array_init = avoid;
    const sink = new MemorySink();
    const sim = new PoolSimulator(meta("P"), c, sink, () => "p1");
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 10_000 });
    const snap = snapshot(0, 1000, "P");
    snap.missingBinArrays = [Math.floor(1003 / 70)]; // the array holding bins 980..1049
    sim.onState(state(0, 1000, "P"));
    sim.onBins(snap);
    sim.request({ strategy: "spot", sides: "two_sided", binsBelow: 3, binsAbove: 3, capitalUsd: 1000, entryMode, combo: {} }, 0);
    sim.onState(state(10_000, 1000, "P"));
    return sim.list()[0];
  };
  it("charges the init cost by default (feature requires_bin_array_init comes from the same snapshot)", () => {
    const p = run(false, "signal_enter");
    expect(p.status).toBe("active");
    expect(p.costs.some((x) => x.type === "bin_array_init" && !x.refundable)).toBe(true);
  });
  it("avoid_bin_array_init: signal modes skip the range, the baseline still opens and pays", () => {
    expect(run(true, "signal_enter")).toMatchObject({ status: "failed", failReason: "bin_array_init_avoided" });
    expect(run(true, "all_pools_baseline").status).toBe("active");
  });
});
