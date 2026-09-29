import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import type { ApiPool } from "../src/api/meteora.ts";
import { selectFresh } from "../src/collectors/discovery.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { baseFeePct, evaluateFriday, loadFridayPreset, type FridayInputs } from "../src/sim/friday.ts";
import { flowConfirm, flowTriggers, FRIDAY_CONFIRM, FRIDAY_THRESHOLDS, type FlowSnapshot } from "../src/sim/flow.ts";
import { GridRunner, SessionClock } from "../src/sim/gridRunner.ts";
import { expandExitPolicies, exitPolicyLabel, newTrailing, oorRule, pnlDecision } from "../src/sim/policies.ts";
import { SignalBook } from "../src/signals/signalEngine.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const cfg = (): Config => structuredClone(loadConfig().config);

describe("exit policies from the Friday playbook", () => {
  it("time_stop and exit_out_of_range lists expand; 0 minutes is allowed", () => {
    const e = expandExitPolicies([{ type: "time_stop", minutes: [5, 15] }, { type: "exit_out_of_range", minutes: [0, 15] }]);
    expect(e.map(exitPolicyLabel)).toEqual(["time_stop:5m", "time_stop:15m", "exit_out_of_range:0m", "exit_out_of_range:15m"]);
    expect(oorRule(e[2])).toEqual({ minutes: 0, rebalance: false, maxRebalances: 0 });
  });
  it("time stop and the scalp combination", () => {
    const x = { t: 0, netPct: 2, feePct: 1, ageMinutes: 14.9, feePctPerHourWindow: null };
    expect(pnlDecision({ type: "time_stop", minutes: 15 }, x, newTrailing()).reason).toBeNull();
    expect(pnlDecision({ type: "time_stop", minutes: 15 }, { ...x, ageMinutes: 15 }, newTrailing()).reason).toBe("time_stop");
    const scalp = { type: "scalp" as const, time_stop_minutes: 15, oor_minutes: 0, sl_pct: 10 };
    expect(pnlDecision(scalp, { ...x, netPct: -10 }, newTrailing()).reason).toBe("stop_loss");
    expect(pnlDecision(scalp, { ...x, ageMinutes: 16 }, newTrailing()).reason).toBe("time_stop");
    expect(exitPolicyLabel(scalp)).toBe("scalp:ts15m:oor0m:sl10");
    expect(oorRule(scalp)?.minutes).toBe(0);
  });
  it("the default config validates with the new levels", () => {
    const labels = expandExitPolicies(cfg().grid.exit_policies).map(exitPolicyLabel);
    expect(labels).toEqual(expect.arrayContaining(["exit_out_of_range:0m", "time_stop:15m"]));
  });
});

// ---------------------------------------------------------------- discovery fresh lane
const api = (o: Partial<ApiPool> & { address: string; age: number; bs?: number; fee?: number; vol?: number; tvl?: number; x?: string }): ApiPool =>
  ({
    address: o.address, name: o.address,
    token_x: { address: o.x ?? `mint-${o.address}`, symbol: "MEME", decimals: 6 }, token_y: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
    created_at: NOW - o.age * MIN,
    pool_config: { bin_step: o.bs ?? 100, base_fee_pct: o.fee ?? 2, max_fee_pct: 10, protocol_fee_pct: 5, collect_fee_mode: 1 },
    tvl: o.tvl ?? 5000, volume: { "1h": o.vol ?? 10_000 }, is_blacklisted: false,
  }) as unknown as ApiPool;

describe("fresh lane selection", () => {
  it("keeps fresh memecoin pools with the listed bin step and a base fee in range, by 1 h volume", () => {
    const c = cfg();
    const pools = [
      api({ address: "old", age: 400 }), // older than 6 h
      api({ address: "baby", age: 1 }), // younger than 3 min
      api({ address: "bs80", age: 30, bs: 80 }),
      api({ address: "fee025", age: 30, fee: 0.25 }),
      api({ address: "thin", age: 30, tvl: 100 }),
      api({ address: "bluechip", age: 30, x: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }),
      api({ address: "taken", age: 30 }),
      api({ address: "a", age: 30, vol: 5_000 }),
      api({ address: "b", age: 60, vol: 50_000 }),
      api({ address: "c", age: 90, vol: 20_000 }),
    ];
    const out = selectFresh(pools, c, new Set(["taken"]), 2, NOW);
    expect(out.map((x) => x.api.address)).toEqual(["b", "c"]);
    expect(out.every((x) => x.reason === "fresh_lane" && x.category === "memecoin")).toBe(true);
    expect(selectFresh(pools, c, new Set(["taken"]), 10, NOW).map((x) => x.api.address)).toEqual(["b", "c", "a"]);
  });
});

// ---------------------------------------------------------------- Friday screen
const META = (o: Partial<PoolMeta> = {}): PoolMeta => ({
  pool: "POOL", name: "MEME-SOL", tokenX: "MEME", tokenY: "SOL", symbolX: "MEME", symbolY: "SOL", decimalsX: 6, decimalsY: 6,
  binStep: 100, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 1,
  fee: { binStep: 100, baseFactor: 20000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt: NOW - 30 * MIN, ...o,
});
const OK: FridayInputs = { tvlUsd: 20_000, mintAuthority: false, freezeAuthority: false };

describe("Friday preset screen", () => {
  const p = loadFridayPreset("presets/friday.yaml");
  it("loads the preset file", () => {
    expect(p.strategy).toEqual({ shape: "spot", sides: "two_sided", bins_per_side: 34 });
    expect(p.exit).toEqual({ time_stop_minutes: 15, oor_minutes: 0 });
  });
  it("base fee from the pool parameters: base_factor 20000 x bin step 100 = 2%", () => {
    expect(baseFeePct(META())).toBeCloseTo(2, 9);
  });
  it("passes bin step 100 / 2% / fresh / deep enough / no authorities, and names each failure", () => {
    expect(evaluateFriday(p, META(), OK, NOW)).toEqual([]);
    expect(evaluateFriday(p, META({ fee: { ...META().fee, baseFactor: 10000 } }), OK, NOW)).toEqual([]); // 1%: inside 1-3
    expect(evaluateFriday(p, META({ fee: { ...META().fee, baseFactor: 5000 } }), OK, NOW)).toEqual(["base_fee"]); // 0.5%
    expect(evaluateFriday(p, META({ fee: { ...META().fee, baseFactor: 40000 } }), OK, NOW)).toEqual(["base_fee"]); // 4%
    expect(evaluateFriday(p, META({ binStep: 80 }), OK, NOW)).toContain("bin_step");
    expect(evaluateFriday(p, META({ createdAt: NOW - 400 * MIN }), OK, NOW)).toEqual(["age"]);
    expect(evaluateFriday(p, META(), { ...OK, tvlUsd: null }, NOW)).toEqual(["tvl"]);
    expect(evaluateFriday(p, META(), { ...OK, mintAuthority: true }, NOW)).toEqual(["mint_authority"]);
    expect(evaluateFriday(p, META(), { ...OK, mintAuthority: null, freezeAuthority: null }, NOW)).toEqual(["security_missing"]);
    expect(evaluateFriday({ ...p, safety: { ...p.safety, missing_security: "allow" } }, META(), { ...OK, mintAuthority: null, freezeAuthority: null }, NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------- grid runner
const state = (ts: number, activeId: number): PoolStateUpdate => ({
  pool: "POOL", ts, slot: ts, activeId, priceUi: binUiPrice(activeId, 100, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: 0.02, feeRateLp: 0.019,
});
const snapshot = (ts: number, activeId: number): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  for (let id = activeId - 60; id <= activeId + 60; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= activeId ? 1_000_000_000n : 0n;
    const y = id <= activeId ? 1_000_000_000n : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: 0n, feeY: 0n, priceRaw: P });
  }
  return { pool: "POOL", ts, slot: ts, activeId, lower: activeId - 60, upper: activeId + 60, missingBinArrays: [], bins };
};

describe("friday_scalp entry mode", () => {
  const preset = loadFridayPreset("presets/friday.yaml");
  // stage 1 scenarios: pool screen, shape, time stop, out of range, re-entry (no flow data)
  const stage1 = { ...preset, entry_confirm: { ...preset.entry_confirm, enabled: false } };
  const setup = (inputs: FridayInputs = OK, flow?: (pool: string, t: number) => FlowSnapshot | null, friday = stage1) => {
    const c = cfg();
    c.grid.entry_modes = ["friday_scalp"];
    let n = 0;
    const sim = new PoolSimulator(META({ createdAt: NOW - 20 * MIN }), c, new MemorySink(), () => `f${++n}`);
    sim.onMarket({ quoteUsd: 150, solUsd: 150, priorityMicroLamports: 0 });
    const clock = new SessionClock(NOW, { durationMinutes: 120, warmupMinutes: 1, stopNewBeforeEndMinutes: 20, cohortIntervalMinutes: 60 });
    const runner = new GridRunner(c, new Map([["POOL", sim]]), clock, undefined, {
      book: new SignalBook(null, c, "S", "v"),
      fridayInputs: () => inputs,
      friday: flow ? friday : { ...friday, flow_exit: { ...friday.flow_exit } },
      flow,
    });
    const step = (m: number, active = 0) => {
      const ts = NOW + m * MIN;
      sim.onBins(snapshot(ts, active));
      sim.onState(state(ts, active));
      runner.onPoolState("POOL", ts);
      runner.onTick(ts);
    };
    return { sim, runner, step };
  };

  it("opens Spot 34+1+34 with the scalp exit, closes at the time stop, re-enters after 5 min", () => {
    const { sim, runner, step } = setup();
    step(0);
    step(1); // cohort 1
    step(1.1);
    const first = sim.list();
    expect(first).toHaveLength(1);
    expect(first[0].spec).toMatchObject({ strategy: "spot", sides: "two_sided", binsBelow: 34, binsAbove: 34, entryMode: "friday_scalp" });
    expect(first[0].spec.combo).toMatchObject({ exit_policy: "scalp:ts15m:oor0m:flow4", trade_no: 1 });
    for (let m = 2; m <= 16; m++) step(m);
    expect(first[0].status).toBe("active"); // opened at 1.1 min: 14.9 min old
    step(17);
    expect(first[0].closeReason).toBe("time_stop");
    step(19); // 2 min after the close: too early
    expect(sim.list()).toHaveLength(1);
    step(22.5); // > 5 min after the close: next scalp
    expect(sim.list()).toHaveLength(2);
    expect(sim.list()[1].spec.combo).toMatchObject({ trade_no: 2, reentry: true, at_cohort: false });
    expect(runner.stats.friday).toMatchObject({ opened: 2, reentries: 1 });
  });

  it("leaves the range -> exits on the first update out of range", () => {
    const { sim, step } = setup();
    step(0);
    step(1);
    step(1.1);
    step(3, 40); // 40 bins up: out of a 34-bin range
    expect(sim.list()[0].closeReason).toBe("exit_out_of_range");
  });

  it("a pool without data at the cohort (added during the session) enters once its data is complete", () => {
    const { sim, runner } = setup();
    runner.onTick(NOW + MIN); // cohort 1: pool has no data yet
    expect(sim.list()).toHaveLength(0);
    const ts = NOW + 7 * MIN;
    sim.onBins(snapshot(ts, 0));
    sim.onState(state(ts, 0)); // first data
    runner.onTick(ts);
    expect(sim.list()).toHaveLength(1);
    expect(sim.list()[0].spec.combo).toMatchObject({ cohort: 1, reentry: false, at_cohort: true, trade_no: 1 });
  });

  // ---- stage 2: flow confirmation at entry and the one-trigger flow exits
  const minutes = (vols: (number | null)[], netY: number) =>
    vols.map((v, i) => ({ end: 0, volumeUsd: v, netYInUsd: i === 0 ? netY : 0 }));
  const snapOf = (o: Partial<FlowSnapshot> = {}): FlowSnapshot => ({
    t: 0, minutes: minutes([3000, 2000, 1000, 500], 800), riskIsX: true, tvlUsd: 50_000,
    holders: { now: 1010, prev: 1000 }, bundlerPct: { now: 10, prev: 10.2 }, ...o,
  });

  it("enters as soon as the flow confirms (not only at cohorts), and not before", () => {
    let flow = snapOf({ minutes: minutes([1000, 2000, 3000, 0], 800) }); // volume falling
    const { sim, runner, step } = setup(OK, () => flow, preset);
    step(0);
    step(1); // cohort: no confirmation
    expect(sim.list()).toHaveLength(0);
    expect(runner.stats.friday.failed["confirm:volume_rising"]).toBeGreaterThan(0);
    flow = snapOf(); // rising volume, net buy > 0, holders up, bundlers stable
    step(3);
    expect(sim.list()).toHaveLength(1);
    expect(sim.list()[0].spec.combo).toMatchObject({ at_cohort: false, preset_partial: false, flow_at_entry: { netBuy: 800 } });
  });

  it("missing bundler data skips that check and flags the position partial", () => {
    const { sim, step } = setup(OK, () => snapOf({ bundlerPct: null }), preset);
    step(0);
    step(1);
    expect(sim.list()).toHaveLength(1);
    expect(sim.list()[0].spec.combo).toMatchObject({ preset_partial: true, preset_missing: ["bundler_stable"] });
  });

  it("exits on one flow trigger, immediately, one minute after the open at the earliest", () => {
    let flow = snapOf();
    const { sim, step } = setup(OK, () => flow, preset);
    step(0);
    step(1);
    step(1.1); // open
    const p = sim.list()[0];
    flow = snapOf({ holders: { now: 800, prev: 1000 } }); // holders -20%
    step(1.5); // younger than one minute: no flow check yet
    expect(p.status).toBe("active");
    step(2.5);
    expect(p.closeReason).toBe("flow_holders");
  });

  it("does not enter pools failing the screen and counts why", () => {
    const { sim, runner, step } = setup({ ...OK, freezeAuthority: true });
    step(0);
    step(1);
    expect(sim.list()).toHaveLength(0);
    expect(runner.stats.friday.failed).toEqual({ freeze_authority: 1 });
  });
});

describe("flow triggers and confirmation (pure)", () => {
  const m = (vols: (number | null)[], netY: number | null) => vols.map((v, i) => ({ end: 0, volumeUsd: v, netYInUsd: i === 0 ? netY : 0 }));
  const x = (o: Partial<FlowSnapshot> = {}): FlowSnapshot => ({
    t: 0, minutes: m([3000, 2000, 1000], 500), riskIsX: true, tvlUsd: 100_000,
    holders: { now: 1000, prev: 1000 }, bundlerPct: { now: 10, prev: 10 }, ...o,
  });
  const ALL = ["bundler", "net_buy", "net_buy_rel", "holders", "volume"] as const;

  it("each of Friday's triggers fires on its own threshold", () => {
    expect(flowTriggers(x(), ALL, FRIDAY_THRESHOLDS).fired).toEqual([]);
    expect(flowTriggers(x({ bundlerPct: { now: 8, prev: 10 } }), ALL, FRIDAY_THRESHOLDS).fired).toEqual(["bundler"]);
    expect(flowTriggers(x({ minutes: m([3000, 2000], -5000) }), ALL, FRIDAY_THRESHOLDS).fired).toEqual(["net_buy", "net_buy_rel"]);
    expect(flowTriggers(x({ holders: { now: 900, prev: 1000 } }), ALL, FRIDAY_THRESHOLDS).fired).toEqual(["holders"]);
    expect(flowTriggers(x({ minutes: m([1600, 2000], 0) }), ALL, FRIDAY_THRESHOLDS).fired).toEqual(["volume"]);
  });
  it("net buy is the risk token's side: when the risk token is Y a Y inflow is a sell", () => {
    expect(flowTriggers(x({ riskIsX: false, minutes: m([3000, 2000], 6000) }), ["net_buy"], FRIDAY_THRESHOLDS).fired).toEqual(["net_buy"]);
  });
  it("missing data never fires", () => {
    const r = flowTriggers(x({ holders: null, bundlerPct: null, minutes: m([null, 2000], null) }), ALL, FRIDAY_THRESHOLDS);
    expect(r.fired).toEqual([]);
    expect(r.missing).toEqual(["bundler", "net_buy", "net_buy_rel", "holders", "volume"]);
  });
  it("entry confirmation: rising volume and net buy are required; token checks can be skipped", () => {
    expect(flowConfirm(x({ holders: { now: 1010, prev: 1000 } }), FRIDAY_CONFIRM)).toEqual({ pass: true, failed: [], missing: [] });
    expect(flowConfirm(x({ minutes: m([3000, 3000, 1000], 500) }), FRIDAY_CONFIRM).failed).toContain("volume_rising");
    expect(flowConfirm(x({ minutes: m([3000, 2000, 1000], -1) }), FRIDAY_CONFIRM).failed).toContain("net_buy_positive");
    expect(flowConfirm(x({ minutes: m([3000, null, 1000], 1) }), FRIDAY_CONFIRM).failed).toContain("volume_rising:missing");
    expect(flowConfirm(x(), FRIDAY_CONFIRM).failed).toEqual(["holders_growing"]); // flat holders
    const s = flowConfirm(x({ holders: null, bundlerPct: { now: 13, prev: 10 } }), FRIDAY_CONFIRM);
    expect(s.missing).toEqual(["holders_growing"]);
    expect(s.failed).toEqual(["bundler_stable"]); // +3 points: not "stable or falling slowly"
  });
});

describe("pool flow per minute from the bin snapshots", () => {
  it("volume = LP fee / LP fee rate; net Y inflow from bins whose supply did not change", async () => {
    const { PoolTracker } = await import("../src/features/tracker.ts");
    const meta = META({ fee: { ...META().fee, protocolShare: 0 } });
    const tr = new PoolTracker(meta, 3_600_000, 5, 3);
    tr.onMetrics({ ts: 0, tvlUsd: 1e5, volume1h: null, volume24h: null, fee1h: null, feeTvl1h: null, xUsd: 1, yUsd: 1 });
    tr.onState({ ...state(0, 0), feeRateTotal: 0.02 });
    const mk = (ts: number, y1: bigint, feeY: bigint, supply2: bigint) => {
      const s = snapshot(ts, 0);
      const b1 = s.bins.get(1)!;
      s.bins.set(1, { ...b1, y: y1 }); // swap moved Y into bin 1 (supply unchanged)
      const b0 = s.bins.get(0)!;
      s.bins.set(0, { ...b0, feeY }); // fee paid in the active bin
      const b2 = s.bins.get(2)!;
      s.bins.set(2, { ...b2, y: 5_000_000_000n, supply: supply2 }); // an LP add: excluded
      return s;
    };
    const s0 = snapshot(0, 0);
    tr.onBins(s0);
    const supply0 = s0.bins.get(0)!.supply; // Q64-scaled
    const S = Number(supply0) / 2 ** 64;
    const feePerL = 20_000_000 / S; // 20 USD of Y fee (decimals 6) spread over the active bin
    const feeY = BigInt(Math.round(feePerL * 2 ** 64));
    tr.onBins(mk(30_000, 3_000_000n, feeY, s0.bins.get(2)!.supply * 2n));
    tr.onBins(mk(60_000, 3_000_000n, feeY, s0.bins.get(2)!.supply * 2n));
    const [cur] = tr.minuteFlow(60_000, 1);
    expect(cur.volumeUsd).toBeCloseTo(20 / 0.02, 3); // $20 fee at 2% -> $1,000 volume
    expect(cur.netYInUsd).toBeCloseTo(3, 6); // 3 Y units (1e6 raw each) into bin 1; the LP add in bin 2 excluded
  });
});

describe("noise-robust volume triggers", () => {
  const mm = (vols: (number | null)[]) => vols.map((v) => ({ end: 0, volumeUsd: v, netYInUsd: 0 }));
  const snap = (vols: (number | null)[]): FlowSnapshot => ({ t: 0, minutes: mm(vols), riskIsX: true, tvlUsd: 1e5, holders: null, bundlerPct: null });

  it("volume_avg3 compares the last minute with the mean of the 3 before", () => {
    // one quiet minute after a spike: Friday's trigger fires, the 3-minute mean does not
    expect(flowTriggers(snap([1500, 3000, 1000, 1000]), ["volume", "volume_avg3"], FRIDAY_THRESHOLDS).fired).toEqual(["volume"]);
    // a real fade: both fire
    expect(flowTriggers(snap([500, 1000, 1000, 1000]), ["volume", "volume_avg3"], FRIDAY_THRESHOLDS).fired).toEqual(["volume", "volume_avg3"]);
    expect(flowTriggers(snap([500, 1000, null, 1000]), ["volume_avg3"], FRIDAY_THRESHOLDS).missing).toEqual(["volume_avg3"]);
  });

  it("confirm 60 s: the drop must still hold a minute later", async () => {
    const { GridRunner, SessionClock } = await import("../src/sim/gridRunner.ts");
    const c = cfg();
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [5];
    c.grid.range_pct = [];
    c.grid.sides = ["two_sided"];
    c.grid.variants = ["none"];
    c.grid.entry_modes = ["all_pools_baseline"];
    c.grid.sampling.mode = "full";
    c.grid.exit_policies = [{ type: "flow_trigger", sets: ["volume"], ...FRIDAY_THRESHOLDS, confirm_seconds: 60 }];
    const sim = new PoolSimulator(META(), c, new MemorySink(), () => "v1");
    sim.onMarket({ quoteUsd: 150, solUsd: 150, priorityMicroLamports: 0 });
    let flow = snap([3000, 2000, 1000, 1000]);
    const runner = new GridRunner(c, new Map([["POOL", sim]]), new SessionClock(NOW, { durationMinutes: 60, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }), undefined, {
      book: new SignalBook(null, c, "S", "v"),
      flow: () => flow,
    });
    const step = (m: number) => {
      const ts = NOW + m * MIN;
      sim.onBins(snapshot(ts, 0));
      sim.onState(state(ts, 0));
      runner.onPoolState("POOL", ts);
      runner.onTick(ts);
    };
    step(0);
    step(1);
    step(1.1);
    const p = sim.list()[0];
    flow = snap([1000, 3000, 1000, 1000]); // drop
    step(2.5);
    flow = snap([2900, 3000, 1000, 1000]); // recovered within the minute: pending cancelled
    step(3);
    step(3.5);
    expect(p.status).toBe("active");
    flow = snap([1000, 3000, 1000, 1000]); // drops again and holds
    step(4);
    step(4.5);
    expect(p.status).toBe("active");
    step(5);
    expect(p.closeReason).toBe("flow_volume");
  });
});
