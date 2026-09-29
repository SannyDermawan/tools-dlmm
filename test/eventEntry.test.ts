import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { GridRunner, SessionClock } from "../src/sim/gridRunner.ts";
import type { FlowSnapshot } from "../src/sim/flow.ts";
import { SignalBook } from "../src/signals/signalEngine.ts";
import type { ScoreResult } from "../src/features/scorer.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const MIN = 60_000;
const META: PoolMeta = {
  pool: "POOL", name: "T-USD", tokenX: "T", tokenY: "USD", symbolX: "T", symbolY: "USD", decimalsX: 6, decimalsY: 6,
  binStep: 100, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep: 100, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt: null,
};
const state = (ts: number, pool: string): PoolStateUpdate => ({
  pool, ts, slot: ts, activeId: 0, priceUi: binUiPrice(0, 100, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: 0.01, feeRateLp: 0.0095,
});
const snapshot = (ts: number, pool: string): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  for (let id = -30; id <= 30; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= 0 ? 1_000_000_000n : 0n;
    const y = id <= 0 ? 1_000_000_000n : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: 0n, feeY: 0n, priceRaw: P });
  }
  return { pool, ts, slot: ts, activeId: 0, lower: -30, upper: 30, missingBinArrays: [], bins };
};
const score = (pool: string, ts: number, action: "MASUK" | "PANTAU" | "LEWATI"): ScoreResult => ({
  pool, ts, category: "memecoin", features: new Map(), norm: new Map(),
  modules: { edge: 80, regime: 70, flow: null, attention: null, competition: 60, safety: 90 },
  gate: { passed: true, reasons: [], missingData: false }, context: { multiplier: 1, reasons: [] }, weights: {},
  baseScore: 80, finalScore: 70, confidence: 0.8, regime: "sideways", action, edge: null, edgeCandidates: [],
  recommendation: null, expectations: null, topReasons: [], risks: [],
}) as ScoreResult;

const setup = (o: { trigger: "cohort" | "event" | "both"; mut?: (c: Config) => void; flow?: (pool: string, t: number) => FlowSnapshot | null; pools?: string[] }) => {
  const c = structuredClone(loadConfig().config);
  c.grid.strategies = ["spot"];
  c.grid.bins_per_side = [2];
  c.grid.sides = ["two_sided"];
  c.grid.exit_policies = [{ type: "hold_to_session_end" }];
  c.grid.variants = ["none"];
  c.grid.entry_filter = ["none"];
  c.grid.cooldown_enabled = [false];
  c.grid.sampling.mode = "full";
  c.grid.entry_modes = ["all_pools_baseline", "signal_enter", "signal_watch"];
  c.grid.signal_entry.trigger = o.trigger;
  c.grid.signal_entry.min_gap_minutes = 15;
  o.mut?.(c);
  const sims = new Map<string, PoolSimulator>();
  let n = 0;
  for (const pool of o.pools ?? ["A"]) {
    const s = new PoolSimulator({ ...META, pool }, c, new MemorySink(), () => `${pool}-${++n}`);
    s.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
    s.onState(state(0, pool));
    s.onBins(snapshot(0, pool));
    sims.set(pool, s);
  }
  const book = new SignalBook(null, c, "S", "v");
  const runner = new GridRunner(c, sims, new SessionClock(0, { durationMinutes: 600, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }), undefined, { book, flow: o.flow });
  /** one scoring round: signals at t, then the runner's per-round hook (as the stack does) */
  const round = (t: number, actions: Record<string, "MASUK" | "PANTAU" | "LEWATI">) => {
    for (const s of sims.values()) s.onState(state(t, s.meta.pool));
    book.onScores(Object.entries(actions).map(([p, a]) => score(p, t, a)));
    runner.onScores(t);
  };
  const positions = () => [...sims.values()].flatMap((s) => s.list());
  const by = (mode: string, trigger?: string) => positions().filter((p) => p.spec.entryMode === mode && (!trigger || p.spec.combo.entry_trigger === trigger));
  return { c, sims, runner, book, round, by, positions };
};

describe("event entries for the signal modes (stage 4)", () => {
  it("cohort (default): signal modes open at the cohort only; no events", () => {
    const t = setup({ trigger: "cohort" });
    t.round(30_000, { A: "LEWATI" });
    t.runner.onTick(MIN); // the cohort
    t.round(2 * MIN, { A: "MASUK" });
    expect(t.by("signal_enter")).toHaveLength(0); // MASUK came after the cohort
    expect(t.runner.stats.events.detected).toBe(0);
  });

  it("event: a rising edge to MASUK opens signal_enter right away; cohorts skip the signal modes but not the baseline", () => {
    const t = setup({ trigger: "event" });
    t.round(30_000, { A: "LEWATI" });
    t.runner.onTick(MIN); // cohort: baseline yes, signal modes wait
    expect(t.by("all_pools_baseline")).toHaveLength(1);
    expect(t.by("signal_enter")).toHaveLength(0);
    t.round(2 * MIN, { A: "MASUK" });
    expect(t.by("signal_enter")).toHaveLength(1);
    const p = t.by("signal_enter")[0];
    expect(p.requestedAt).toBe(2 * MIN);
    expect(p.spec.combo).toMatchObject({ entry_trigger: "event", signal_action: "MASUK", cohort: 1 });
    expect(t.by("signal_watch")).toHaveLength(0); // MASUK is not signal_watch's action
    expect(t.runner.stats.events).toMatchObject({ detected: 1, opened: 1 });
    // still MASUK next round: not an edge, no second entry
    t.round(3 * MIN, { A: "MASUK" });
    expect(t.by("signal_enter")).toHaveLength(1);
  });

  it("PANTAU feeds signal_watch; each mode has its own edge", () => {
    const t = setup({ trigger: "event" });
    t.runner.onTick(MIN);
    t.round(2 * MIN, { A: "PANTAU" });
    expect(t.by("signal_watch")).toHaveLength(1);
    expect(t.by("signal_enter")).toHaveLength(0);
  });

  it("both: cohort entries and event entries coexist and are tagged", () => {
    const t = setup({ trigger: "both" });
    t.round(30_000, { A: "MASUK" });
    t.runner.onTick(MIN); // cohort entry at MASUK
    expect(t.by("signal_enter", "cohort")).toHaveLength(1);
    // the edge at the very first round is inside min_gap of the cohort entry -> no duplicate
    t.round(90_000, { A: "MASUK" });
    expect(t.by("signal_enter", "event")).toHaveLength(0);
    // after the gap, LEWATI then MASUK again is a new event
    t.round(20 * MIN, { A: "LEWATI" });
    t.round(21 * MIN, { A: "MASUK" });
    expect(t.by("signal_enter", "event")).toHaveLength(1);
  });

  it("min gap between entries of a pool, and max_per_pool events per session", () => {
    const t = setup({ trigger: "event", mut: (c) => (c.grid.signal_entry.max_per_pool = 2) });
    t.runner.onTick(MIN);
    let time = 2 * MIN;
    const flip = (up: boolean) => t.round((time += MIN), { A: up ? "MASUK" : "LEWATI" });
    flip(true); // event 1
    flip(false);
    flip(true); // 2 min later: inside the 15 min gap
    expect(t.by("signal_enter")).toHaveLength(1);
    expect(t.runner.stats.events.skipped.min_gap).toBe(1);
    time += 20 * MIN;
    flip(false);
    flip(true); // event 2, after the gap
    expect(t.by("signal_enter")).toHaveLength(2);
    time += 20 * MIN;
    flip(false);
    flip(true); // a third: over the cap
    expect(t.by("signal_enter")).toHaveLength(2);
    expect(t.runner.stats.events.skipped.max_per_pool).toBe(1);
  });

  it("needs fresh data: an edge on a stale pool is picked up on the next round", () => {
    const t = setup({ trigger: "event" });
    t.runner.onTick(MIN);
    const sim = t.sims.get("A")!;
    sim.onGap({ source: "pool_state", start: 2 * MIN, end: null });
    t.round(3 * MIN, { A: "MASUK" });
    expect(t.by("signal_enter")).toHaveLength(0); // price data in a gap
    sim.onGap({ source: "pool_state", start: 2 * MIN, end: 3 * MIN + 1000 });
    t.round(4 * MIN, { A: "MASUK" });
    expect(t.by("signal_enter")).toHaveLength(1);
  });

  it("flow confirmation: the event waits for it, enters when it passes, drops on timeout or when the signal goes", () => {
    let confirmed = false;
    const flow = (): FlowSnapshot => ({
      t: 0, riskIsX: true, tvlUsd: 50_000,
      // newest first; volume rising over the last 2 minutes, net buy positive, holders growing, bundlers stable
      minutes: confirmed
        ? ([{ volumeUsd: 400, netYInUsd: 50 }, { volumeUsd: 200, netYInUsd: 20 }, { volumeUsd: 100, netYInUsd: 10 }] as unknown as FlowSnapshot["minutes"])
        : [],
      holders: confirmed ? { now: 120, prev: 110 } : null,
      bundlerPct: confirmed ? { now: 5, prev: 5 } : null,
    });
    const t = setup({ trigger: "event", flow, mut: (c) => (c.grid.signal_entry.require_flow_confirm = true) });
    t.runner.onTick(MIN);
    t.round(2 * MIN, { A: "MASUK" });
    expect(t.by("signal_enter")).toHaveLength(0);
    expect(t.runner.stats.events.detected).toBe(1);
    // not confirmed within flow_wait_minutes -> dropped
    t.round(2 * MIN + 11 * MIN, { A: "MASUK" });
    expect(t.runner.stats.events.skipped.flow_confirm_timeout).toBe(1);
    expect(t.by("signal_enter")).toHaveLength(0);
    // a new edge, now the flow confirms -> enters
    t.round(40 * MIN, { A: "LEWATI" });
    confirmed = true;
    t.round(41 * MIN, { A: "MASUK" });
    expect(t.by("signal_enter")).toHaveLength(1);
  });
});
