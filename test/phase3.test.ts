import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import { createSession, registerConfigVersion } from "../src/db/repo.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { gridCombos, GridRunner, scaleTiming, SessionClock, timingFromConfig } from "../src/sim/gridRunner.ts";
import { expandExitPolicies } from "../src/sim/policies.ts";
import { DbSimSink } from "../src/sim/store.ts";
import { toCsv, writeSessionReport } from "../src/report/sessionReport.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = (): Config => structuredClone(loadConfig().config);
const META: PoolMeta = {
  pool: "POOL", name: "T-USD", tokenX: "T", tokenY: "USD", symbolX: "T", symbolY: "USD", decimalsX: 6, decimalsY: 6,
  binStep: 100, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep: 100, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt: null,
};
const state = (ts: number, activeId: number): PoolStateUpdate => ({
  pool: "POOL", ts, slot: ts, activeId, priceUi: binUiPrice(activeId, 100, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: 0.01, feeRateLp: 0.0095,
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

describe("grid", () => {
  it("builds the full cartesian grid for runnable entry modes (signal modes wait for phase 5)", () => {
    const c = cfg();
    c.grid.sampling.mode = "full";
    c.grid.variants = ["none"];
    const combos = gridCombos(c);
    const g = c.grid;
    expect(combos).toHaveLength(g.strategies.length * g.bins_per_side.length * g.sides.length * expandExitPolicies(g.exit_policies).length);
    expect(new Set(combos.map((x) => x.entryMode))).toEqual(new Set(["all_pools_baseline"]));
    // signal modes join with the decision stack; meridian_preset is not a grid mode
    expect(gridCombos(c, { allowSignalModes: true })).toHaveLength(combos.length * 3);
    const one = combos.find((x) => x.sides === "quote_only")!;
    expect(one.binsAbove).toBe(0);
    expect(combos.find((x) => x.sides === "base_only")!.binsBelow).toBe(0);
  });

  it("session clock phases and scaling", () => {
    const t = { durationMinutes: 300, warmupMinutes: 15, stopNewBeforeEndMinutes: 60, cohortIntervalMinutes: 60 };
    const c = new SessionClock(0, t);
    expect(c.phase(0)).toBe("warmup");
    expect(c.phase(15 * 60_000)).toBe("active");
    expect(c.phase(240 * 60_000)).toBe("closing");
    expect(c.phase(300 * 60_000)).toBe("ended");
    const s = scaleTiming(t, 60);
    expect(s.durationMinutes).toBe(60);
    expect(s.warmupMinutes).toBeCloseTo(3);
    expect(scaleTiming(t, 400)).toBe(t);
    expect(timingFromConfig(cfg()).durationMinutes).toBe(300);
  });
});

describe("GridRunner", () => {
  const setup = (mut?: (c: Config) => void) => {
    const c = cfg();
    c.grid.strategies = ["spot"];
    c.grid.bins_per_side = [2];
    c.grid.sides = ["two_sided"];
    c.grid.variants = ["none"];
    c.grid.sampling.mode = "full";
    // phase 3 policies only (the PnL policies of phase 9 are tested in phase9.test.ts)
    c.grid.exit_policies = c.grid.exit_policies.filter((p) => ["hold_to_session_end", "exit_out_of_range", "rebalance_out_of_range", "exit_engine"].includes(p.type));
    mut?.(c);
    const sink = new MemorySink();
    let n = 0;
    const sim = new PoolSimulator(META, c, sink, () => `p${++n}`);
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 10_000 });
    const clock = new SessionClock(0, { durationMinutes: 100, warmupMinutes: 10, stopNewBeforeEndMinutes: 20, cohortIntervalMinutes: 30 });
    const runner = new GridRunner(c, new Map([["POOL", sim]]), clock);
    const step = (ts: number, active: number) => {
      sim.onState(state(ts, active));
      runner.onPoolState("POOL", ts);
      runner.onTick(ts);
    };
    return { c, sim, sink, runner, step };
  };

  it("no positions during warm-up; cohorts every interval in the active phase; none while closing", () => {
    const { sim, runner, step } = setup();
    sim.onBins(snapshot(0, 0));
    step(0, 0);
    step(5 * 60_000, 0);
    expect(sim.list()).toHaveLength(0);
    step(10 * 60_000, 0); // warm-up over -> cohort 1
    expect(runner.stats.cohorts).toBe(1);
    const per = runner.combos.length;
    expect(sim.list()).toHaveLength(per);
    step(39 * 60_000, 0);
    expect(runner.stats.cohorts).toBe(1);
    step(40 * 60_000, 0); // cohort 2
    step(70 * 60_000, 0); // cohort 3
    step(85 * 60_000, 0); // closing phase: nothing new
    step(99 * 60_000, 0);
    expect(runner.stats.cohorts).toBe(3);
    expect(sim.list()).toHaveLength(3 * per);
    runner.finish(100 * 60_000, "session_end");
    expect(sim.list().every((p) => p.status === "closed" && p.closeReason === "session_end")).toBe(true);
  });

  it("exit_out_of_range closes after the configured minutes; hold keeps the position", () => {
    const { sim, step } = setup();
    sim.onBins(snapshot(0, 0));
    step(10 * 60_000, 0);
    step(10 * 60_000 + 3000, 0); // activation after entry delay
    step(11 * 60_000, 20); // price leaves the range (width 2)
    step(25 * 60_000, 20); // 14 min out of range
    const byPolicy = (t: string) => sim.list().find((p) => p.spec.exitPolicy!.type === t)!;
    expect(byPolicy("exit_out_of_range").status).toBe("active");
    step(26 * 60_000 + 1, 20); // > 15 min
    expect(byPolicy("exit_out_of_range").status).toBe("closed");
    expect(byPolicy("exit_out_of_range").closeReason).toBe("exit_out_of_range");
    expect(byPolicy("hold_to_session_end").status).toBe("active");
  });

  it("rebalance_out_of_range recentres with full cost, then exits after max rebalances", () => {
    const { sim, sink, step } = setup((c) => (c.grid.exit_policies = [{ type: "rebalance_out_of_range", minutes: 1, max_rebalances: 2 }]));
    sim.onBins(snapshot(0, 0));
    step(10 * 60_000, 0);
    step(10 * 60_000 + 3000, 0);
    const p = sim.list()[0];
    const costsBefore = p.costs.length;
    let t = 11 * 60_000;
    let active = 0;
    for (let i = 0; i < 3; i++) {
      active += 10;
      sim.onBins(snapshot(t, active));
      step(t, active); // leaves range
      t += 61_000;
      step(t, active); // > 1 min out of range -> rebalance (or exit on the 3rd)
      t += 1000;
    }
    const reb = sink.events.filter((e) => e.type === "rebalance");
    expect(reb).toHaveLength(2);
    expect(p.rebalanceCount).toBe(2);
    expect(p.costs.length).toBeGreaterThan(costsBefore);
    expect(reb[0].detail.to).toEqual({ lower: 8, upper: 12 });
    expect(p.status).toBe("closed");
    expect(p.closeReason).toBe("max_rebalances");
  });

  it("respects grid.max_positions", () => {
    const { sim, runner, step } = setup((c) => (c.grid.max_positions = 2));
    sim.onBins(snapshot(0, 0));
    step(10 * 60_000, 0);
    expect(sim.list()).toHaveLength(2);
    expect(runner.stats.capped).toBe(true);
  });

  it("skips pools that are not ready (no data yet)", () => {
    const { sim, runner, step } = setup();
    step(10 * 60_000, 0); // no bin snapshot yet
    expect(sim.list()).toHaveLength(0);
    expect(runner.stats.skippedPools).toBe(1);
  });
});

describe("session report", () => {
  it("writes markdown + CSVs from journaled positions", () => {
    const db = new Db(":memory:");
    migrate(db);
    const lc = loadConfig();
    const v = registerConfigVersion(db, lc);
    const sid = createSession(db, { kind: "session", configVersion: v, label: "t" });
    db.insert("pools", { pool: "POOL", name: "T-USD", token_x: "T", token_y: "USD", decimals_x: 6, decimals_y: 6, bin_step: 100, category: "memecoin", first_seen_at: 0, last_checked_at: 0 });
    const c = cfg();
    c.grid.strategies = ["spot", "curve"];
    c.grid.bins_per_side = [2];
    const sink = new DbSimSink(db, sid, v);
    const sim = new PoolSimulator(META, c, sink);
    sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
    const runner = new GridRunner(c, new Map([["POOL", sim]]), new SessionClock(0, { durationMinutes: 60, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }));
    sim.onBins(snapshot(0, 0));
    for (const ts of [60_000, 63_000, 30 * 60_000]) {
      sim.onState(state(ts, 0));
      runner.onTick(ts);
    }
    runner.finish(60 * 60_000, "session_end");
    sink.flush();
    const dir = mkdtempSync(join(tmpdir(), "dlmm-report-"));
    try {
      const r = writeSessionReport(db, sid, dir);
      const md = readFileSync(r.markdown, "utf8");
      expect(md).toContain("## Performance by dimension");
      expect(md).toContain("not statistically significant");
      expect(md).toContain("session_end");
      const csv = readFileSync(r.positionsCsv, "utf8").trim().split("\n");
      expect(csv).toHaveLength(1 + sim.list().length);
      expect(csv[0]).toContain("net_pnl_usd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });

  it("csv escapes quotes, commas and newlines", () => {
    expect(toCsv([{ a: 'x,"y"', b: 1, c: null }])).toBe('a,b,c\n"x,""y""",1,\n');
  });
});
