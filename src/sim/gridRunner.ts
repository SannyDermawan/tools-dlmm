import type { Config } from "../config/schema.ts";
import type { Logger } from "../util/logger.ts";
import type { PoolSimulator } from "./engine.ts";
import type { PositionSpec, VirtualPosition } from "./position.ts";
import { evaluateMeridian, feeWindowMinutes, loadMeridianPreset, meridianExitPolicy, type MeridianPreset, type PresetEvaluation, type PresetInputs } from "./meridian.ts";
import { expandExitPolicies, exitPolicyLabel, isPnlPolicy, newTrailing, oorRule, pnlDecision, type TrailingState } from "./policies.ts";
import type { SignalBook } from "../signals/signalEngine.ts";
import type { ExitEngine } from "../signals/exitEngine.ts";
import { entryFilterPass, type EntryFilter, type TfSnapshot } from "../features/indicators.ts";

export type SessionPhase = "warmup" | "active" | "closing" | "ended";

export interface SessionTiming {
  durationMinutes: number;
  warmupMinutes: number;
  stopNewBeforeEndMinutes: number;
  cohortIntervalMinutes: number;
}

export function timingFromConfig(c: Config): SessionTiming {
  return {
    durationMinutes: c.session.duration_minutes,
    warmupMinutes: c.session.warmup_minutes,
    stopNewBeforeEndMinutes: c.session.stop_new_positions_before_end_minutes,
    cohortIntervalMinutes: c.grid.cohort_interval_minutes,
  };
}

/** Scale a session timing to a shorter span (replay of a short collection), keeping proportions. */
export function scaleTiming(t: SessionTiming, spanMinutes: number): SessionTiming {
  if (spanMinutes >= t.durationMinutes) return t;
  const k = spanMinutes / t.durationMinutes;
  return {
    durationMinutes: spanMinutes,
    warmupMinutes: t.warmupMinutes * k,
    stopNewBeforeEndMinutes: t.stopNewBeforeEndMinutes * k,
    cohortIntervalMinutes: t.cohortIntervalMinutes * k,
  };
}

/** Session life cycle (blueprint 14.1): warm-up -> active -> closing (no new positions) -> end. */
export class SessionClock {
  readonly warmupEnd: number;
  readonly stopNewAt: number;
  readonly end: number;
  constructor(readonly start: number, readonly t: SessionTiming) {
    this.warmupEnd = start + t.warmupMinutes * 60_000;
    this.end = start + t.durationMinutes * 60_000;
    this.stopNewAt = this.end - t.stopNewBeforeEndMinutes * 60_000;
  }
  phase(ts: number): SessionPhase {
    if (ts >= this.end) return "ended";
    if (ts < this.warmupEnd) return "warmup";
    if (ts < this.stopNewAt) return "active";
    return "closing";
  }
}

export { exitPolicyLabel };

/** Entry modes that need the decision stack (signals / preset inputs) — skipped without it. */
const SIGNAL_MODES = new Set(["signal_enter", "signal_watch", "meridian_preset"]);
/** Entry modes that run with and without the pool cooldown (grid.cooldown_enabled). */
const COOLDOWN_MODES = new Set(["signal_enter", "signal_watch"]);

/** Deterministic PRNG (mulberry32) for reproducible grid samples. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Balanced sample of index tuples over dimensions of the given sizes: every dimension gets a list
 * of `n` levels cycling through all its levels (each level appears floor or ceil of n/k times),
 * shuffled independently, then zipped. Duplicate tuples are dropped. When the full grid is not
 * larger than `n` it is returned whole.
 */
export function balancedSample(sizes: number[], n: number, seed: number): number[][] {
  const total = sizes.reduce((a, b) => a * b, 1);
  if (total <= n) {
    const out: number[][] = [];
    const rec = (d: number, acc: number[]) => {
      if (d === sizes.length) return void out.push(acc);
      for (let i = 0; i < sizes[d]; i++) rec(d + 1, [...acc, i]);
    };
    rec(0, []);
    return out;
  }
  const r = rng(seed);
  const cols = sizes.map((k) => {
    const col = Array.from({ length: n }, (_, i) => i % k);
    for (let i = col.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [col[i], col[j]] = [col[j], col[i]];
    }
    return col;
  });
  const seen = new Set<string>();
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = cols.map((c) => c[i]);
    const key = t.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Grid combinations (blueprint 13.1 + addendum 2): strategy x bins_per_side x sides x exit policy
 * (list parameters expanded) x variant. `grid.sampling.mode: balanced` draws a balanced sample of
 * at most `max_combos` of them; the same sample is used for every pool and entry mode so modes are
 * compared on identical combinations. wide_range uses its own shape and widths.
 * meridian_preset is not part of the grid (one fixed preset position per selected pool).
 */
export function gridCombos(c: Config, opts: { allowSignalModes?: boolean; sessionMinutes?: number } = {}): PositionSpec[] {
  const g = c.grid;
  const policies = expandExitPolicies(g.exit_policies);
  const filters = g.entry_filter;
  const dims = [g.strategies.length, g.bins_per_side.length, g.sides.length, policies.length, g.variants.length, filters.length];
  const sample = g.sampling.mode === "full" ? balancedSample(dims, Number.MAX_SAFE_INTEGER, 0) : balancedSample(dims, g.sampling.max_combos, g.sampling.seed);
  const wide = g.variant_params.wide_range;
  const modes = g.entry_modes.filter((m) => m !== "meridian_preset" && (opts.allowSignalModes || !SIGNAL_MODES.has(m)));
  // cooldowns (4-12 h) cannot trigger in a short session: run signal modes without the dimension
  const cooldownLevels = opts.sessionMinutes !== undefined && opts.sessionMinutes < g.cooldown_min_session_minutes ? [false] : g.cooldown_enabled;
  // the baseline may use only the first baseline_max_combos of the same sample (a subset, so
  // baseline vs signal comparisons stay on identical combinations)
  const baseN = g.sampling.mode === "balanced" && g.sampling.baseline_max_combos !== null ? g.sampling.baseline_max_combos : sample.length;
  const out: PositionSpec[] = [];
  for (const entryMode of modes)
    for (const cooldownEnabled of COOLDOWN_MODES.has(entryMode) ? cooldownLevels : [null])
    for (const [si, bi, di, pi, vi, fi] of entryMode === "all_pools_baseline" ? sample.slice(0, baseN) : sample) {
      const entryFilter = filters[fi];
      const variant = g.variants[vi];
      const isWide = variant === "wide_range";
      const strategy = isWide ? wide.strategy : g.strategies[si];
      const n = isWide ? wide.bins_per_side[bi % wide.bins_per_side.length] : g.bins_per_side[bi];
      const sides = g.sides[di];
      const exitPolicy = policies[pi];
      out.push({
        strategy, sides, exitPolicy, entryMode, variant, cooldownEnabled, entryFilter,
        binsBelow: sides === "base_only" ? 0 : n,
        binsAbove: sides === "quote_only" ? 0 : n,
        capitalUsd: c.simulation.virtual_capital_usd,
        combo: {
          entry_mode: entryMode, strategy, bins_per_side: n, sides, exit_policy: exitPolicyLabel(exitPolicy), variant,
          sampling: g.sampling.mode,
          entry_filter: entryFilter,
          ...(cooldownEnabled !== null ? { cooldown: cooldownEnabled } : {}),
          ...(variant !== "none" && variant !== "wide_range" ? { variant_params: g.variant_params[variant] } : {}),
        },
      });
    }
  return out;
}

export interface GridStats {
  cohorts: number;
  requested: number;
  skippedPools: number;
  rebalances: number;
  policyExits: number;
  rebalanceNotWorth: number;
  signalEntries: Record<string, number>;
  /** closes by PnL policy reason (take_profit, stop_loss, trailing_tp, low_yield, ...) */
  pnlExits: Record<string, number>;
  variantActions: { partial_harvest: number; fee_compounding: number; single_sided_reseed: number };
  preset: { evaluated: number; passed: number; opened: number; partial: number };
  /** signal-mode positions not opened because the pool was in cooldown (phase 10) */
  cooldownSkips: number;
  /** positions not opened because their indicator entry filter did not pass, by filter and reason (phase 13) */
  filterSkips: Record<string, number>;
  capped: boolean;
}

/** Optional decision-stack hooks: signals for entry modes, exit engine, expected fee, preset inputs. */
export interface GridSignals {
  book: SignalBook;
  exitEngine?: ExitEngine;
  /** expected fee (USD) over the edge horizon for `valueUsd` of liquidity in a pool, or null */
  expectedFeeUsd?: (pool: string, valueUsd: number, t: number) => number | null;
  /** Meridian preset screen inputs of a pool at t (entry mode meridian_preset) */
  presetInputs?: (pool: string, t: number, sim: PoolSimulator, windowMinutes: number) => PresetInputs | null;
  /** pool memory: cooldown of a pool (or its risk token) at t (phase 10) */
  memory?: { poolCooldown(pool: string, t: number): { until: number; reason: string } | null };
  /** chart indicators for the entry filters (phase 13) */
  indicators?: { at(pool: string, t: number): Record<string, TfSnapshot> | null };
  /** preset override (tests); default: loaded from config presets.meridian */
  preset?: MeridianPreset;
}

/** Per-position runtime state of the PnL policies and variants. */
interface PosRuntime {
  trailing: TrailingState;
  feeHist: { t: number; feeUsd: number }[];
  lastCompound: number;
}

/**
 * Grid Runner (blueprint 13, addendum 2): opens a cohort of the grid combinations at the start of
 * the active phase and then every cohort interval. Entry modes run in parallel at the same moment:
 *   all_pools_baseline -> every ready pool (control group)
 *   meridian_preset    -> top-N pools passing the Meridian default screen (second baseline)
 *   signal_enter       -> pools whose latest signal is signals.enter_action (MASUK)
 *   signal_watch       -> pools whose latest signal is signals.watch_action (PANTAU)
 * Every position records the pool's signal at entry (signal_id + action). Exit policies:
 * out-of-range rules on every pool state; PnL rules (TP / SL / trailing / low yield) and strategy
 * variants every simulation.pnl_eval_seconds; force-close at the end.
 */
export class GridRunner {
  private nextCohortAt: number;
  private cohort = 0;
  private lastEval = 0;
  private readonly rt = new Map<string, PosRuntime>();
  readonly combos: PositionSpec[];
  readonly preset: MeridianPreset | null = null;
  readonly stats: GridStats = {
    cohorts: 0, requested: 0, skippedPools: 0, rebalances: 0, policyExits: 0, rebalanceNotWorth: 0, signalEntries: {}, pnlExits: {},
    variantActions: { partial_harvest: 0, fee_compounding: 0, single_sided_reseed: 0 },
    preset: { evaluated: 0, passed: 0, opened: 0, partial: 0 }, cooldownSkips: 0, filterSkips: {}, capped: false,
  };

  constructor(
    private readonly c: Config,
    private readonly sims: Map<string, PoolSimulator>,
    readonly clock: SessionClock,
    private readonly log?: Logger,
    private readonly signals?: GridSignals,
  ) {
    this.combos = gridCombos(c, { allowSignalModes: !!signals, sessionMinutes: clock.t.durationMinutes });
    const skipped = signals ? [] : c.grid.entry_modes.filter((m) => SIGNAL_MODES.has(m));
    if (skipped.length) log?.warn({ skipped }, "entry modes need the decision stack; skipped (no signals wired)");
    if (signals && c.grid.entry_modes.includes("meridian_preset")) {
      try {
        this.preset = signals.preset ?? loadMeridianPreset(c.presets.meridian);
      } catch (e) {
        log?.error({ err: (e as Error).message, path: c.presets.meridian }, "meridian preset not loaded; entry mode skipped");
      }
    }
    this.nextCohortAt = clock.warmupEnd;
  }

  get phase() {
    return this.clock.phase(Date.now());
  }

  /** Call regularly (live: timer; replay: every event). */
  onTick(ts: number) {
    if (ts - this.lastEval >= this.c.simulation.pnl_eval_seconds * 1000) {
      this.lastEval = ts;
      this.evaluate(ts);
    }
    if (this.clock.phase(ts) !== "active" || ts < this.nextCohortAt) return;
    this.openCohort(ts);
    const iv = this.clock.t.cohortIntervalMinutes;
    this.nextCohortAt = iv > 0 ? this.nextCohortAt + iv * 60_000 : Number.POSITIVE_INFINITY;
    while (this.nextCohortAt <= ts) this.nextCohortAt += iv * 60_000; // skip missed cohorts
  }

  private admits(mode: string, action: string | null): boolean {
    if (mode === "signal_enter") return action === this.c.signals.enter_action;
    if (mode === "signal_watch") return action === this.c.signals.watch_action;
    return true;
  }

  private full(): boolean {
    if (this.stats.requested < this.c.grid.max_positions) return false;
    if (!this.stats.capped) this.log?.warn({ max: this.c.grid.max_positions }, "grid.max_positions reached; no more positions");
    this.stats.capped = true;
    return true;
  }

  private openCohort(ts: number) {
    this.cohort++;
    this.stats.cohorts++;
    let opened = this.openPreset(ts);
    for (const sim of this.sims.values()) {
      if (!sim.ready) {
        this.stats.skippedPools++;
        continue;
      }
      const sig = this.signals?.book.latestFor(sim.meta.pool, ts) ?? null;
      const rec = sig?.recommendation ?? null;
      const cooldown = this.signals?.memory?.poolCooldown(sim.meta.pool, ts) ?? null;
      const ind = this.signals?.indicators?.at(sim.meta.pool, ts) ?? null;
      const filterOk = new Map<string, boolean>();
      let taken = false;
      for (const spec of this.combos) {
        if (!this.admits(spec.entryMode, sig?.action ?? null)) continue;
        if (spec.cooldownEnabled && cooldown) {
          this.stats.cooldownSkips++;
          continue;
        }
        const ef = spec.entryFilter ?? "none";
        if (ef !== "none") {
          let ok = filterOk.get(ef);
          if (ok === undefined) {
            const r = entryFilterPass(ef as EntryFilter, ind, this.c.indicators);
            ok = r.pass;
            filterOk.set(ef, ok);
            if (!ok) {
              const k = `${ef}:${r.reason === "no_data" ? "no_data" : "not_passed"}`;
              this.stats.filterSkips[k] = (this.stats.filterSkips[k] ?? 0) + 1; // counted per pool and cohort
            }
          }
          if (!ok) continue;
        }
        if (this.full()) return;
        const matches = !!rec && rec.strategy === spec.strategy && rec.sides === spec.sides &&
          rec.bins_below === spec.binsBelow && rec.bins_above === spec.binsAbove;
        sim.request(
          {
            ...spec,
            cohort: this.cohort,
            signalId: sig?.signal_id ?? null,
            combo: {
              ...spec.combo, cohort: this.cohort, signal_action: sig?.action ?? null, signal_score: sig?.final_score ?? null,
              matches_recommendation: matches,
            },
          },
          ts,
        );
        if (spec.entryMode !== "all_pools_baseline") {
          taken = true;
          this.stats.signalEntries[spec.entryMode] = (this.stats.signalEntries[spec.entryMode] ?? 0) + 1;
        }
        this.stats.requested++;
        opened++;
      }
      if (taken && sig) this.signals!.book.markTaken(sig.signal_id);
    }
    this.log?.info({ cohort: this.cohort, opened, total: this.stats.requested }, "grid cohort opened");
  }

  /**
   * meridian_preset: screen every ready pool with the Meridian defaults, rank the passing ones and
   * open the preset position in the top N. Token filters without data -> preset_partial.
   */
  private openPreset(ts: number): number {
    const pr = this.preset;
    const inputs = this.signals?.presetInputs;
    if (!pr || !inputs) return 0;
    const win = feeWindowMinutes(pr);
    const passing: { sim: PoolSimulator; ev: PresetEvaluation }[] = [];
    for (const sim of this.sims.values()) {
      if (!sim.ready) continue;
      const x = inputs(sim.meta.pool, ts, sim, win);
      if (!x) continue;
      this.stats.preset.evaluated++;
      const ev = evaluateMeridian(pr, x);
      if (ev.pass) passing.push({ sim, ev });
    }
    this.stats.preset.passed += passing.length;
    passing.sort((a, b) => b.ev.score - a.ev.score);
    const exitPolicy = meridianExitPolicy(pr);
    const s = pr.strategy;
    let opened = 0;
    for (const [i, { sim, ev }] of passing.slice(0, pr.ranking.top_n).entries()) {
      if (this.full()) break;
      const sig = this.signals?.book.latestFor(sim.meta.pool, ts) ?? null;
      const binsBelow = s.sides === "base_only" ? 0 : s.bins_below;
      const binsAbove = s.sides === "two_sided" ? s.bins_below : 0;
      const partial = ev.missing.length > 0;
      sim.request(
        {
          strategy: s.shape, sides: s.sides, binsBelow, binsAbove, exitPolicy, variant: "none",
          entryMode: "meridian_preset", capitalUsd: this.c.simulation.virtual_capital_usd,
          cohort: this.cohort, signalId: sig?.signal_id ?? null,
          combo: {
            entry_mode: "meridian_preset", strategy: s.shape, bins_per_side: s.bins_below, sides: s.sides,
            exit_policy: exitPolicyLabel(exitPolicy), variant: "none", cohort: this.cohort,
            preset_partial: partial, preset_missing: ev.missing, preset_score: ev.score, preset_rank: i + 1,
            signal_action: sig?.action ?? null, signal_score: sig?.final_score ?? null,
          },
        },
        ts,
      );
      this.stats.requested++;
      this.stats.preset.opened++;
      if (partial) this.stats.preset.partial++;
      this.stats.signalEntries.meridian_preset = (this.stats.signalEntries.meridian_preset ?? 0) + 1;
      opened++;
    }
    return opened;
  }

  /** Out-of-range exit policies for one pool after its state update. */
  onPoolState(pool: string, ts: number) {
    const sim = this.sims.get(pool);
    if (!sim) return;
    for (const p of sim.list()) {
      if (p.status !== "active" || p.outOfRangeSince === null || !p.spec.exitPolicy) continue;
      const pol = p.spec.exitPolicy;
      const rule = oorRule(pol);
      if (!rule || ts - p.outOfRangeSince < rule.minutes * 60_000) continue;
      if (p.spec.variant === "single_sided_reseed" && this.tryReseed(sim, p, ts)) continue;
      if (!rule.rebalance) {
        sim.close(p.id, "exit_out_of_range", ts);
        this.stats.policyExits++;
        continue;
      }
      if (p.rebalanceCount >= rule.maxRebalances) {
        sim.close(p.id, "max_rebalances", ts);
        this.stats.policyExits++;
        continue;
      }
      if (pol.type === "exit_engine" && this.c.exit_engine.rebalance_cost_check && this.signals?.expectedFeeUsd) {
        // blueprint 15: do not rebalance when it costs more than the fee it is expected to earn
        const cost = sim.estimateRebalanceCostUsd(p.id);
        const value = sim.valuation(p).valueUsd;
        const fee = this.signals.expectedFeeUsd(pool, value, ts);
        if (cost !== null && fee !== null && cost >= fee) {
          sim.logExitSignal(p.id, ts, { action: "KELUAR", reason: "rebalance_not_worth", conditions: { costUsd: cost, expectedFeeUsd: fee } });
          sim.close(p.id, "exit_engine:rebalance_not_worth", ts);
          this.stats.rebalanceNotWorth++;
          continue;
        }
      }
      if (sim.rebalance(p.id, "out_of_range", ts)) this.stats.rebalances++;
    }
  }

  private tryReseed(sim: PoolSimulator, p: VirtualPosition, ts: number): boolean {
    if (p.reseeds >= this.c.grid.variant_params.single_sided_reseed.max_reseeds) return false;
    if (!sim.reseed(p.id, ts)) return false;
    this.stats.variantActions.single_sided_reseed++;
    return true;
  }

  private runtime(p: VirtualPosition): PosRuntime {
    let r = this.rt.get(p.id);
    if (!r) {
      r = { trailing: newTrailing(), feeHist: [], lastCompound: p.openedAt ?? 0 };
      this.rt.set(p.id, r);
    }
    return r;
  }

  /** PnL policies and strategy variants of every active position (every pnl_eval_seconds). */
  private evaluate(ts: number) {
    const vp = this.c.grid.variant_params;
    for (const sim of this.sims.values()) {
      for (const p of sim.list()) {
        if (p.status !== "active") {
          this.rt.delete(p.id);
          continue;
        }
        if (p.openedAt === null || ts < p.openedAt) continue;
        const r = this.runtime(p);
        const cap = p.spec.capitalUsd;
        // ---- variants (their costs land before the PnL check)
        const variant = p.spec.variant ?? "none";
        if (variant === "single_sided_reseed" && p.outOfRangeSince !== null) this.tryReseed(sim, p, ts);
        if (variant === "fee_compounding") {
          const fee = sim.valuation(p).feeUsd;
          if (fee > 0 && (fee >= vp.fee_compounding.min_fee_usd || ts - r.lastCompound >= vp.fee_compounding.every_minutes * 60_000)) {
            if (sim.compoundFees(p.id, ts)) this.stats.variantActions.fee_compounding++;
            r.lastCompound = ts;
          }
        }
        let v = sim.valuation(p);
        if (variant === "partial_harvest" && p.partialExits === 0 && (v.netPnlUsd / cap) * 100 >= vp.partial_harvest.trigger_return_pct) {
          if (sim.partialClose(p.id, vp.partial_harvest.fraction, "partial_harvest", ts)) {
            this.stats.variantActions.partial_harvest++;
            v = sim.valuation(p);
          }
        }
        // ---- PnL exit policies
        const pol = p.spec.exitPolicy;
        if (!pol || !isPnlPolicy(pol)) continue;
        const feeTotal = v.feeUsd + p.compoundedFeeUsd;
        let feeRate: number | null = null;
        if (pol.type === "low_yield_exit") {
          const winMs = pol.window_minutes * 60_000;
          r.feeHist.push({ t: ts, feeUsd: feeTotal });
          while (r.feeHist.length > 1 && r.feeHist[1].t <= ts - winMs) r.feeHist.shift();
          const first = r.feeHist[0];
          if (first.t <= ts - winMs) feeRate = (((feeTotal - first.feeUsd) / cap) * 100) / ((ts - first.t) / 3_600_000);
        }
        const netPct = (v.netPnlUsd / cap) * 100;
        const d = pnlDecision(pol, { t: ts, netPct, feePct: (feeTotal / cap) * 100, ageMinutes: (ts - p.openedAt) / 60_000, feePctPerHourWindow: feeRate }, r.trailing);
        r.trailing = d.trailing;
        if (d.event) sim.logExitSignal(p.id, ts, { action: d.event, pnlPct: netPct, peakPct: d.trailing.peak, policy: pol.type });
        if (d.reason) {
          sim.close(p.id, d.reason, ts);
          this.rt.delete(p.id);
          this.stats.policyExits++;
          this.stats.pnlExits[d.reason] = (this.stats.pnlExits[d.reason] ?? 0) + 1;
        }
      }
    }
  }

  /** After each scoring round: exit engine rules for exit_engine positions. */
  onScores(ts: number) {
    const ee = this.signals?.exitEngine;
    if (!ee) return;
    for (const sim of this.sims.values()) ee.run(sim, ts);
  }

  /** Force-close every open position (session end, or shutdown). */
  finish(ts: number, reason: "session_end" | "session_aborted") {
    for (const sim of this.sims.values()) sim.closeAll(reason, Math.max(ts, sim.now));
    this.rt.clear();
  }
}
