import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { Db, migrate } from "../src/db/index.ts";
import { AthLookup, athDrawdownPct, downsideFromAthAnchor } from "../src/features/ath.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { binsForUpPct, distributeFull, type RangeSpec } from "../src/sim/distribution.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import { GridRunner, SessionClock } from "../src/sim/gridRunner.ts";
import { exitPolicyLabel, expandExitPolicies, isPnlPolicy, newTrailing, pnlDecision } from "../src/sim/policies.ts";
import { evaluateYunus, loadYunusPreset, yunusCombos, yunusDownside, type YunusInputs, type YunusPreset } from "../src/sim/yunus.ts";
import { SignalBook } from "../src/signals/signalEngine.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const MIN = 60_000;
const DAY = 86_400_000;

describe("breakeven exit (playbook point 4)", () => {
  const pol = expandExitPolicies([{ type: "breakeven_exit", min_underwater_pct: 5, target_pct: 0, time_cap_minutes: 1440 }])[0];
  const at = (netPct: number, worstPct: number, ageMinutes = 10) =>
    pnlDecision(pol, { t: 0, netPct, feePct: 0, ageMinutes, feePctPerHourWindow: null, worstPct }, newTrailing()).reason;

  it("never under water: holds (no break-even exit at a profit); the time cap closes it", () => {
    expect(at(2, 0)).toBeNull();
    expect(at(-3, -3)).toBeNull(); // dipped, but not deep enough to count as under water
    expect(at(1, 0, 1440)).toBe("time_cap");
  });

  it("was under water by min_underwater_pct: closes as soon as net PnL is back at the target", () => {
    expect(at(-6, -6)).toBeNull(); // still under water
    expect(at(-0.1, -6)).toBeNull(); // not there yet
    expect(at(0, -6)).toBe("breakeven");
    expect(at(1.5, -20)).toBe("breakeven");
  });

  it("optional stop loss and take profit; a target above zero waits for a profit", () => {
    const sl = expandExitPolicies([{ type: "breakeven_exit", min_underwater_pct: 5, target_pct: 0, time_cap_minutes: 1440, sl_pct: 30 }])[0];
    const r = (netPct: number, worst: number) => pnlDecision(sl, { t: 0, netPct, feePct: 0, ageMinutes: 5, feePctPerHourWindow: null, worstPct: worst }, newTrailing()).reason;
    expect(r(-31, -31)).toBe("stop_loss");
    expect(r(-29, -29)).toBeNull();
    const tp = expandExitPolicies([{ type: "breakeven_exit", min_underwater_pct: 5, target_pct: 2, time_cap_minutes: 1440, tp_pct: 10 }])[0];
    const q = (netPct: number, worst: number) => pnlDecision(tp, { t: 0, netPct, feePct: 0, ageMinutes: 5, feePctPerHourWindow: null, worstPct: worst }, newTrailing()).reason;
    expect(q(1, -8)).toBeNull(); // break-even is +2 here
    expect(q(2, -8)).toBe("breakeven");
    expect(q(10, 0)).toBe("take_profit");
  });

  it("list parameters expand into grid levels; labels are distinct; it is a PnL policy", () => {
    const xs = expandExitPolicies([{ type: "breakeven_exit", min_underwater_pct: [3, 8], target_pct: 0, time_cap_minutes: [720, 1440] }]);
    expect(xs).toHaveLength(4);
    expect(new Set(xs.map(exitPolicyLabel)).size).toBe(4);
    expect(isPnlPolicy(xs[0])).toBe(true);
    expect(exitPolicyLabel(xs[0])).toBe("breakeven:uw3%:cap720m");
  });
});

describe("ATH (playbook point 5)", () => {
  const seed = () => {
    const db = new Db(":memory:");
    migrate(db);
    const put = (pool: string, tf: string, ts: number, h: number) =>
      db.insert("ohlcv", { pool, timeframe: tf, ts, o: h / 2, h, l: h / 3, c: h / 2, v: 1, source: "meteora_api", fetched_at: 0 });
    return { db, put };
  };

  it("highest high over closed daily, hourly and 5m candles; a candle that has not closed at t is not seen", () => {
    const { db, put } = seed();
    put("P", "24h", 0, 0.5); // day 0
    put("P", "24h", DAY, 2.0); // day 1 (the ATH day)
    put("P", "1h", 2 * DAY, 1.2);
    put("P", "5m", 2 * DAY + 60 * MIN, 1.4);
    put("Q", "24h", 0, 99); // another pool
    const t = 2 * DAY + 2 * 60 * MIN;
    expect(new AthLookup(db).at("P", t)).toBe(2.0);
    // the ATH day only closes at 2 * DAY: at t = 1.5 days it is invisible
    expect(new AthLookup(db).at("P", DAY + DAY / 2)).toBe(0.5);
    // 5m candle at 2d+60m closes at 2d+65m
    expect(new AthLookup(db).at("P", 2 * DAY + 64 * MIN)).toBe(2.0);
    put("P", "5m", 2 * DAY + 90 * MIN, 3.0);
    expect(new AthLookup(db).at("P", t + 10 * MIN)).toBe(3.0);
    expect(new AthLookup(db).at("nope", t)).toBeNull();
  });

  it("caches per pool and 5-minute bucket", () => {
    const { db, put } = seed();
    put("P", "24h", 0, 1);
    const l = new AthLookup(db);
    expect(l.at("P", 2 * DAY)).toBe(1);
    put("P", "24h", DAY, 5);
    expect(l.at("P", 2 * DAY + 60_000)).toBe(1); // same bucket: cached
    expect(l.at("P", 2 * DAY + 6 * MIN)).toBe(5); // next bucket: fresh
  });

  it("drawdown and the ATH-anchored downside", () => {
    expect(athDrawdownPct(0.5, 1)).toBe(50);
    expect(athDrawdownPct(1.2, 1)).toBe(0); // above the recorded high: no drawdown
    expect(athDrawdownPct(1, null)).toBeNull();
    // ATH 1.0, price 0.8, range bottom at -50% of ATH = 0.5: the downside seen from 0.8 is 37.5%
    expect(downsideFromAthAnchor(0.8, 1, 50)).toBeCloseTo(37.5, 9);
    expect(downsideFromAthAnchor(0.4, 1, 50)).toBeNull(); // the price is already below the anchor
    expect(downsideFromAthAnchor(1, 1, 50)).toBeCloseTo(50, 9); // at the ATH the two anchors agree
  });
});

describe("yunus preset and screen (playbook point 3)", () => {
  const preset = (mut?: (p: YunusPreset) => void) => {
    const p = loadYunusPreset("presets/yunus.yaml");
    mut?.(p);
    return p;
  };
  const inputs = (o: Partial<YunusInputs> = {}): YunusInputs => ({ tvlUsd: 50_000, category: "memecoin", riskIsBase: true, mintAuthority: false, freezeAuthority: false, mcapUsd: 8e6, tokenAgeHours: 100, athDrawdownPct: 40, ...o });

  it("the shipped preset loads; combos are widths x anchors x flip shapes x exits", () => {
    const p = preset();
    const cs = yunusCombos(p, exitPolicyLabel);
    expect(cs).toHaveLength(p.entry.range_pct.length * p.entry.anchor.length * p.flip.shapes.length * 2);
    expect(new Set(cs.map((c) => c.key)).size).toBe(cs.length);
    const mix = cs.find((c) => c.flipName === "mix_70_30")!;
    expect(mix.flip.blend).toEqual({ strategy: "spot", share: 0.3 });
    expect(mix.flip.shape).toBe("bidask");
    expect(cs.find((c) => c.flipName === "bidask")!.flip.blend).toBeNull();
  });

  it("the screen: thresholds that are null are not applied; no data fails a rule that is set", () => {
    const p = preset();
    expect(evaluateYunus(p, inputs())).toEqual([]);
    expect(evaluateYunus(p, inputs({ tvlUsd: 5_000 }))).toEqual(["tvl"]);
    expect(evaluateYunus(p, inputs({ category: "bluechip" }))).toEqual(["category"]);
    expect(evaluateYunus(p, inputs({ riskIsBase: false }))).toEqual(["risk_token_not_base"]);
    expect(evaluateYunus(p, inputs({ riskIsBase: null }))).toEqual(["risk_token_base:no_data"]);
    expect(evaluateYunus(preset((x) => { x.screen.categories = []; x.screen.require_risk_token_base = false; }), inputs({ category: "bluechip", riskIsBase: false }))).toEqual([]);
    expect(evaluateYunus(p, inputs({ mintAuthority: true, freezeAuthority: true }))).toEqual(["mint_authority", "freeze_authority"]);
    expect(evaluateYunus(p, inputs({ mintAuthority: null }))).toEqual(["mint_authority:no_data"]);
    expect(evaluateYunus(preset((x) => (x.screen.missing_security = "allow")), inputs({ mintAuthority: null }))).toEqual([]);
    const strict = preset((x) => {
      x.screen.min_mcap_usd = 5e6;
      x.screen.min_token_age_hours = 24;
      x.screen.max_token_age_hours = 200;
      x.screen.min_ath_drawdown_pct = 30;
    });
    expect(evaluateYunus(strict, inputs())).toEqual([]);
    expect(evaluateYunus(strict, inputs({ mcapUsd: 1e6, tokenAgeHours: 500, athDrawdownPct: 10 }))).toEqual(["mcap", "token_age_max", "ath_drawdown_min"]);
    expect(evaluateYunus(strict, inputs({ mcapUsd: null }))).toEqual(["mcap:no_data"]);
  });

  it("initial downside: from the price as given, from the ATH with the remaining range, or skipped with the reason", () => {
    const p = preset();
    const [byPrice, byAth] = [
      yunusCombos(preset((x) => (x.entry.anchor = ["price"])), exitPolicyLabel)[0],
      yunusCombos(preset((x) => (x.entry.anchor = ["ath"])), exitPolicyLabel)[0],
    ];
    expect(yunusDownside(p, byPrice, 0.8, 1)).toEqual({ pct: byPrice.widthPct });
    const w = byAth.widthPct; // 50
    expect((yunusDownside(p, byAth, 0.8, 1) as { pct: number }).pct).toBeCloseTo(100 * (1 - (1 * (1 - w / 100)) / 0.8), 9);
    expect(yunusDownside(p, byAth, 0.8, null)).toEqual({ skip: "ath:no_data" });
    expect(yunusDownside(p, byAth, 0.4, 1)).toEqual({ skip: "ath:price_below_anchor" });
    expect(yunusDownside(p, byAth, 0.52, 1)).toEqual({ skip: "ath:thin_range" }); // 3.8% left, min is 10
  });
});

describe("70:30 bid-ask : spot mix on the flip range", () => {
  const A = 0; // active bin
  const r = (blend?: RangeSpec["blend"]): RangeSpec => ({ strategy: "bidask", sides: "base_only", binsBelow: 0, binsAbove: 40, ...(blend ? { blend } : {}) });
  const X = 1_000_000_000_000n;

  it("deploys the whole amount and lies between the pure shapes: less at the far end than bid-ask, more near the price", () => {
    const pure = distributeFull(A, 100, r(), X, 0n);
    const spot = distributeFull(A, 100, { ...r(), strategy: "spot" }, X, 0n);
    const mix = distributeFull(A, 100, r({ strategy: "spot", share: 0.3 }), X, 0n);
    const total = (b: { x: bigint }[]) => b.reduce((s, v) => s + v.x, 0n);
    expect(Number(total(mix)) / Number(X)).toBeGreaterThan(0.99);
    expect(total(mix)).toBeLessThanOrEqual(X);
    const at = (b: { binId: number; x: bigint }[], id: number) => Number(b.find((v) => v.binId === id)?.x ?? 0n);
    expect(mix.map((b) => b.binId)).toEqual(pure.map((b) => b.binId));
    expect(at(mix, 40)).toBeLessThan(at(pure, 40));
    expect(at(mix, 40)).toBeGreaterThan(at(spot, 40));
    expect(at(mix, 1)).toBeGreaterThan(at(pure, 1));
  });

  it("share 0 and 1 are the pure shapes; upside bins for +100% at step 100", () => {
    const pure = distributeFull(A, 100, r(), X, 0n);
    const s0 = distributeFull(A, 100, r({ strategy: "spot", share: 0.0001 }), X, 0n);
    expect(Number(s0[10].x) / Number(pure[10].x)).toBeCloseTo(1, 3);
    expect(binsForUpPct(100, 100)).toBe(70);
    expect(binsForUpPct(100, 10)).toBe(693);
  });
});

// ---------------------------------------------------------------- runner: the whole cycle
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
const snapshot = (ts: number): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  for (let id = -240; id <= 240; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= 0 ? 1_000_000_000n : 0n;
    const y = id <= 0 ? 1_000_000_000n : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX: 0n, feeY: 0n, priceRaw: P });
  }
  return { pool: "POOL", ts, slot: ts, activeId: 0, lower: -240, upper: 240, missingBinArrays: [], bins };
};

const runnerFor = (mut: (p: YunusPreset) => void, o: { ath?: number | null; riskIsBase?: boolean } = {}) => {
  const c = structuredClone(loadConfig().config);
  c.grid.entry_modes = ["yunus_flip"];
  c.grid.max_positions = 1000;
  const preset = loadYunusPreset("presets/yunus.yaml");
  mut(preset);
  let n = 0;
  const sim = new PoolSimulator(META, c, new MemorySink(), () => `P${++n}`);
  sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 0 });
  sim.onState(state(0, 0));
  sim.onBins(snapshot(0));
  const book = new SignalBook(null, c, "S", "v");
  const runner = new GridRunner(
    c, new Map([["POOL", sim]]),
    new SessionClock(0, { durationMinutes: 6000, warmupMinutes: 1, stopNewBeforeEndMinutes: 10, cohortIntervalMinutes: 0 }),
    undefined,
    { book, yunus: preset, ath: () => o.ath ?? null, tokenInfo: () => ({ tokenAgeHours: 100, mcapUsd: 8e6, riskIsBase: o.riskIsBase ?? true }), fridayInputs: () => ({ tvlUsd: 50_000, mintAuthority: false, freezeAuthority: false }) },
  );
  return { c, sim, runner };
};
/** first cohort at 1 min, then a pool update after the entry delay activates the position */
const openAt = (r: ReturnType<typeof runnerFor>) => {
  r.runner.onTick(MIN);
  r.sim.onState(state(MIN + 5_000, 0));
};
const simple = (p: YunusPreset) => {
  p.entry.range_pct = [50];
  p.entry.anchor = ["price"];
  p.flip.shapes = [{ name: "mix", shape: "bidask", blend: { strategy: "spot", share: 0.3 } }];
  p.exit.policies = [{ type: "time_stop", minutes: 1440 }];
};

describe("yunus_flip in the grid runner", () => {
  it("opens a bid-ask quote-only position below the price with the flip spec; journals width, anchor, flip shape", () => {
    const { sim, runner } = runnerFor(simple);
    runner.onTick(MIN);
    const ps = sim.list();
    expect(ps).toHaveLength(1);
    const p = ps[0];
    expect(p.spec).toMatchObject({ entryMode: "yunus_flip", strategy: "bidask", sides: "quote_only", binsBelow: 70, binsAbove: 0 });
    expect(p.spec.flip).toMatchObject({ shape: "bidask", upPct: 100, blend: { strategy: "spot", share: 0.3 } });
    expect(p.spec.combo).toMatchObject({ range_pct: 50, anchor: "price", flip_shape: "mix", cycle_no: 1, exit_policy: "time_stop:1440m" });
    expect(p.spec.combo.range_down_pct).toBeCloseTo(50, 0);
    expect(runner.stats.yunus).toMatchObject({ opened: 1 });
  });

  it("the whole cycle: price falls through the range, flip base-only above, price recovers, cycle_complete", () => {
    const r = runnerFor(simple);
    const { sim, runner } = r;
    openAt(r);
    const p = sim.list()[0];
    expect(p.status).toBe("active");
    expect(p.lower).toBe(-70);
    // price still inside the range: nothing happens
    sim.onState(state(2 * MIN, -30));
    runner.onTick(3 * MIN);
    expect(p.reseeds).toBe(0);
    // through the bottom: fully converted to the token -> flip above the new active bin
    sim.onState(state(4 * MIN, -80));
    runner.onTick(5 * MIN);
    expect(p.reseeds).toBe(1);
    expect(p.status).toBe("active");
    expect(p.lower).toBe(-80);
    expect(p.upper).toBe(-80 + 70);
    expect(runner.stats.yunus.flips).toBe(1);
    const ev = sim.list().length; // still one position: flips are in place
    expect(ev).toBe(1);
    // recovery above the flip range: everything sold back to quote
    sim.onState(state(6 * MIN, 10));
    runner.onTick(7 * MIN);
    expect(p.status).toBe("closed");
    expect(p.closeReason).toBe("cycle_complete");
    expect(runner.stats.yunus.cycles).toBe(1);
  });

  it("no flip before the position is fully converted (price inside the range), and max_flips caps the re-flips", () => {
    const r = runnerFor((p) => {
      simple(p);
      p.flip.max_flips = 1;
    });
    const { sim, runner } = r;
    openAt(r);
    const p = sim.list()[0];
    sim.onState(state(2 * MIN, -80));
    runner.onTick(3 * MIN);
    expect(p.reseeds).toBe(1);
    sim.onState(state(4 * MIN, -170)); // falls through the flip range as well
    runner.onTick(5 * MIN);
    expect(p.reseeds).toBe(1); // max_flips 1
    expect(p.status).toBe("active"); // no stop loss: it just sits in the token
    expect(p.lower).toBe(-80);
  });

  it("re-entry: a new cycle after the cooldown, capped by max_cycles_per_pool", () => {
    const r = runnerFor((p) => {
      simple(p);
      p.reentry = { cooldown_minutes: 30, max_cycles_per_pool: 2 };
    });
    const { sim, runner } = r;
    openAt(r);
    sim.onState(state(2 * MIN, -80));
    runner.onTick(3 * MIN);
    sim.onState(state(4 * MIN, 10));
    runner.onTick(5 * MIN); // cycle 1 complete at ~5 min
    expect(sim.list().filter((x) => x.status === "closed")).toHaveLength(1);
    sim.onState(state(20 * MIN, 0));
    runner.onTick(21 * MIN); // inside the cooldown
    expect(sim.list()).toHaveLength(1);
    sim.onState(state(40 * MIN, 0));
    runner.onTick(41 * MIN);
    expect(sim.list()).toHaveLength(2);
    expect(sim.list()[1].spec.combo).toMatchObject({ cycle_no: 2, reentry: true });
    expect(runner.stats.yunus.reentries).toBe(1);
  });

  it("ath anchor: the range bottom sits at ATH x (1 - pct); no ATH data means no entry, counted", () => {
    const anchored = (p: YunusPreset) => {
      simple(p);
      p.entry.anchor = ["ath"];
    };
    // price at bin 0 = 1.0 (raw), ATH is 1.25x higher -> the bottom (-50% of ATH) is 0.625 = 37.5% below the price
    const price = binUiPrice(0, 100, 6, 6);
    const { sim, runner } = runnerFor(anchored, { ath: price * 1.25 });
    runner.onTick(MIN);
    const p = sim.list()[0];
    expect(p.spec.combo.range_down_pct).toBeCloseTo(37.5, 0);
    expect(p.spec.combo.ath_drawdown_pct).toBeCloseTo(20, 0);
    const none = runnerFor(anchored, { ath: null });
    none.runner.onTick(MIN);
    expect(none.sim.list()).toHaveLength(0);
    expect(none.runner.stats.yunus.failed["ath:no_data"]).toBe(1);
  });

  it("a pool whose risk token is the quote side is not entered (nothing to flip)", () => {
    const { sim, runner } = runnerFor(simple, { riskIsBase: false });
    runner.onTick(MIN);
    expect(sim.list()).toHaveLength(0);
    expect(runner.stats.yunus.failed.risk_token_not_base).toBe(1);
  });

  it("the screen keeps a pool out, with the reason counted", () => {
    const { sim, runner } = runnerFor((p) => {
      simple(p);
      p.screen.min_tvl_usd = 1e9;
    });
    runner.onTick(MIN);
    expect(sim.list()).toHaveLength(0);
    expect(runner.stats.yunus.failed.tvl).toBe(1);
  });
});
