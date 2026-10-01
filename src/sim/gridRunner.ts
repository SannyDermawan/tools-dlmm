import type { Config } from "../config/schema.ts";
import type { Logger } from "../util/logger.ts";
import type { PoolSimulator } from "./engine.ts";
import type { PositionSpec, VirtualPosition } from "./position.ts";
import { loadFridayPreset, type FridayInputs, type FridayPreset } from "./friday.ts";
import { loadMeridianPreset, type MeridianPreset, type PresetInputs } from "./meridian.ts";
import { FRIDAY_CONFIRM, flowConfirm, flowTriggers, type FlowSnapshot } from "./flow.ts";
import { expandExitPolicies, exitPolicyLabel, flowExitOf, isPnlPolicy, newTrailing, oorRule, pnlDecision, type TrailingState } from "./policies.ts";
import type { SignalBook } from "../signals/signalEngine.ts";
import type { ExitEngine } from "../signals/exitEngine.ts";
import { binsForRangePct, binsForUpPct, downsidePct, upsidePct } from "./distribution.ts";
import { entryFilterPass, type EntryFilter, type TfSnapshot } from "../features/indicators.ts";
import { athDrawdownPct } from "../features/ath.ts";
import { loadYunusPreset, type YunusCombo, type YunusPreset } from "./yunus.ts";
import type { EntryTrigger, EntryVerdict, ModeStats, PreviousCycle, ReentryVerdict, StrategyModule } from "../strategies/types.ts";
import { meridianModule } from "../strategies/meridian.ts";
import { flowDetail, fridayModule } from "../strategies/friday.ts";
import { yunusModule } from "../strategies/yunus.ts";
import { royalmandModule, loadRoyalmandPreset, type RoyalmandPreset } from "../strategies/royalmand.ts";
import { evilPandaModule, loadEvilPandaPreset, type EvilPandaPreset } from "../strategies/evilPanda.ts";
import type { Candle } from "../features/indicators.ts";
import type { Regime } from "../features/regime.ts";

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
const SIGNAL_MODES = new Set(["signal_enter", "signal_watch", "meridian_preset", "friday_scalp", "yunus_flip", "royalmand", "evil_panda"]);
/** Entry modes that open their own fixed preset position instead of the grid combinations. */
const PRESET_MODES = new Set(["meridian_preset", "friday_scalp", "yunus_flip", "royalmand", "evil_panda"]);
/** Entry modes that run with and without the pool cooldown (grid.cooldown_enabled). */
const COOLDOWN_MODES = new Set(["signal_enter", "signal_watch"]);

/** Deterministic PRNG (mulberry32) for reproducible grid samples. */
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

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
  // width levels: fixed bin counts, then price-% levels (resolved to bins per pool at the open)
  const widths: { bins?: number; pct?: number }[] = [...g.bins_per_side.map((bins) => ({ bins })), ...g.range_pct.map((pct) => ({ pct }))];
  const dims = [g.strategies.length, widths.length, g.sides.length, policies.length, g.variants.length, filters.length];
  const sample = g.sampling.mode === "full" ? balancedSample(dims, Number.MAX_SAFE_INTEGER, 0) : balancedSample(dims, g.sampling.max_combos, g.sampling.seed);
  const wide = g.variant_params.wide_range;
  const modes = g.entry_modes.filter((m) => !PRESET_MODES.has(m) && (opts.allowSignalModes || !SIGNAL_MODES.has(m)));
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
      const w: { bins?: number; pct?: number } = isWide
        ? wide.range_pct.length ? { pct: wide.range_pct[bi % wide.range_pct.length] } : { bins: wide.bins_per_side[bi % wide.bins_per_side.length] }
        : widths[bi];
      const n = w.bins ?? 0; // price-% widths get their bins per pool when the position is requested
      const sides = g.sides[di];
      const exitPolicy = policies[pi];
      out.push({
        strategy, sides, exitPolicy, entryMode, variant, cooldownEnabled, entryFilter,
        ...(w.pct !== undefined ? { rangePct: w.pct } : {}),
        binsBelow: sides === "base_only" ? 0 : n,
        binsAbove: sides === "quote_only" ? 0 : n,
        capitalUsd: c.simulation.virtual_capital_usd,
        combo: {
          entry_mode: entryMode, strategy, ...(w.pct !== undefined ? { range_pct: w.pct } : { bins_per_side: n }), sides, exit_policy: exitPolicyLabel(exitPolicy), variant,
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
  preset: { evaluated: number; passed: number; opened: number; partial: number; failed: Record<string, number> };
  /** Friday playbook entries: pools screened, positions opened (first + re-entries), screen failures */
  friday: { evaluated: number; opened: number; reentries: number; failed: Record<string, number> };
  /** Yunus flip entries: combinations screened, cycles opened (first + re-entries), flips done, cycles completed, screen failures */
  yunus: { evaluated: number; opened: number; reentries: number; flips: number; cycles: number; failed: Record<string, number> };
  /** royalmand entries (Meridian fork): pools screened, positions opened (first + re-entries), screen failures */
  royalmand: { evaluated: number; opened: number; reentries: number; failed: Record<string, number> };
  /** Evil Panda entries (@EvilPanda playbook): pools screened, positions opened (first + re-entries), screen failures */
  evilPanda: { evaluated: number; opened: number; reentries: number; failed: Record<string, number> };
  /** signal-mode positions not opened because the pool was in cooldown (phase 10) */
  cooldownSkips: number;
  /** pool entries that waited for fresh price data (cohort time fell into a data gap) */
  deferredEntries: number;
  /** positions not opened because their indicator entry filter did not pass, by filter and reason (phase 13) */
  filterSkips: Record<string, number>;
  /** grid positions not opened because a price-% width needed more bins than a position holds in that pool */
  widthSkips: number;
  /** event entries of the signal modes (grid.signal_entry): rising edges seen, entries made, what stopped the rest */
  events: { detected: number; opened: number; skipped: Record<string, number> };
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
  /** risk token facts at t for the journal (coin selection dimensions in the report) */
  /** smart LP wallets with an open position in the pool, and all open real positions there (null = no real-LP data for the pool) */
  smartLp?: (pool: string, t: number) => { smart: number; openPositions: number } | null;
  tokenInfo?: (pool: string, t: number) => { tokenAgeHours: number | null; mcapUsd: number | null; /** the risk token is the base token X */ riskIsBase?: boolean;
    /** token context at entry, journaled with every position (null = unknown) */
    top10Pct?: number | null; holders?: number | null; organic?: number | null; botHoldersPct?: number | null; bundlerPct?: number | null;
    /** pool-quality context at entry (5-minute window; see src/features/poolQuality.ts) */
    volatilityPct?: number | null; priceChangePct?: number | null; binUtilization?: number | null; tokenFeesSol?: number | null;
    volumeAuthScore?: number | null;
    /** Meteora pool-discovery API at entry (window pdTimeframe): its volatility, price change, LP net deposits (USD), unique traders, swaps */
    pdTimeframe?: string | null; pdVolatility?: number | null; pdPriceChangePct?: number | null; pdNetDepositsUsd?: number | null;
    pdUniqueTraders?: number | null; pdSwapCount?: number | null; pdCriticalWarning?: boolean | null;
    /** market regime at entry (roadmap PHASE 6, src/features/regime.ts) and its context features */
    regime?: Regime | null; regime5m?: Regime | null; volumeAccel?: number | null; holdersChangePct?: number | null; feeActiveTvlPct?: number | null;
    /** the risk token's 24 h volume across venues (Jupiter audit) */
    volume24hUsd?: number | null } | null;
  /** highest price (pool quote units) seen up to t, only for pools whose risk token is the base (ath_drawdown_pct) */
  ath?: (pool: string, t: number) => number | null;
  /** one-minute flow of a pool at t (flow exits, Friday entry confirmation) */
  flow?: (pool: string, t: number) => FlowSnapshot | null;
  /** Friday screen inputs of a pool at t (entry mode friday_scalp) */
  fridayInputs?: (pool: string, t: number) => FridayInputs | null;
  /** preset override (tests); default: loaded from config presets.friday */
  friday?: FridayPreset;
  /** preset override (tests); default: loaded from config presets.yunus */
  yunus?: YunusPreset;
  /** preset override (tests); default: loaded from config presets.royalmand */
  royalmand?: RoyalmandPreset;
  /** preset override (tests); default: loaded from config presets.evil_panda */
  evilPanda?: EvilPandaPreset;
  /** the last `bars` complete candles of a pool at t (look-ahead safe; royalmand's Supertrend and exit indicators) */
  candles?: (pool: string, t: number, timeframe: string, bars: number) => Candle[];
}

/** The module's transaction estimate of a cycle, journaled so the report can hold it against the operations it paid. */
const txEstimateJournal = (e: { min: number; max: number; txPerOperation: number }) => ({ tx_est_min: e.min, tx_est_max: e.max, tx_per_operation: e.txPerOperation });

/** A plan of a strategy module that may open now, with its previous cycle. */
interface Due {
  key: string;
  prev: PreviousCycle | null;
  rv: ReentryVerdict;
}

/** Per-position runtime state of the PnL policies and variants. */
interface PosRuntime {
  trailing: TrailingState;
  /** first time a flow trigger fired (confirm_seconds > 0) */
  flowPending: number | null;
  feeHist: { t: number; feeUsd: number }[];
  lastCompound: number;
  /** lowest net PnL % seen since the open (breakeven_exit) */
  worstPct: number;
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
  /** pools whose cohort entry waits for fresh price data: pool -> cohort number */
  private readonly deferred = new Map<string, number>();
  private readonly rt = new Map<string, PosRuntime>();
  readonly combos: PositionSpec[];
  readonly preset: MeridianPreset | null = null;
  readonly friday: FridayPreset | null = null;
  readonly yunus: YunusPreset | null = null;
  readonly yunusCombos: YunusCombo[] = [];
  readonly royalmand: RoyalmandPreset | null = null;
  readonly evilPanda: EvilPandaPreset | null = null;
  /** preset entry modes as standard strategy modules (roadmap PHASE 3), run by openModule in this order */
  readonly modules: StrategyModule[] = [];
  private readonly moduleByMode = new Map<string, StrategyModule>();
  /** cycles per entry mode, pool and plan key: count and the latest position */
  private readonly cycles = new Map<string, { n: number; positionId: string }>();
  readonly stats: GridStats = {
    cohorts: 0, requested: 0, skippedPools: 0, rebalances: 0, policyExits: 0, rebalanceNotWorth: 0, signalEntries: {}, pnlExits: {},
    variantActions: { partial_harvest: 0, fee_compounding: 0, single_sided_reseed: 0 },
    preset: { evaluated: 0, passed: 0, opened: 0, partial: 0, failed: {} }, friday: { evaluated: 0, opened: 0, reentries: 0, failed: {} }, yunus: { evaluated: 0, opened: 0, reentries: 0, flips: 0, cycles: 0, failed: {} }, royalmand: { evaluated: 0, opened: 0, reentries: 0, failed: {} }, evilPanda: { evaluated: 0, opened: 0, reentries: 0, failed: {} }, cooldownSkips: 0, filterSkips: {}, deferredEntries: 0, widthSkips: 0, events: { detected: 0, opened: 0, skipped: {} }, capped: false,
  };
  /** latest signal action per pool at the previous scoring round (rising-edge detection) */
  private readonly lastAction = new Map<string, string | null>();
  /** last entry time and event-entry count per pool and signal mode */
  private readonly lastEntry = new Map<string, number>();
  private readonly eventCount = new Map<string, number>();
  /** events waiting for the flow confirmation: key pool|mode -> first seen */
  private readonly pendingEvents = new Map<string, number>();

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
    if (signals && c.grid.entry_modes.includes("friday_scalp")) {
      try {
        this.friday = signals.friday ?? loadFridayPreset(c.presets.friday);
      } catch (e) {
        log?.error({ err: (e as Error).message, path: c.presets.friday }, "friday preset not loaded; entry mode skipped");
      }
    }
    if (signals && c.grid.entry_modes.includes("yunus_flip")) {
      try {
        this.yunus = signals.yunus ?? loadYunusPreset(c.presets.yunus);
      } catch (e) {
        log?.error({ err: (e as Error).message, path: c.presets.yunus }, "yunus preset not loaded; entry mode skipped");
      }
    }
    if (signals && c.grid.entry_modes.includes("royalmand")) {
      try {
        this.royalmand = signals.royalmand ?? loadRoyalmandPreset(c.presets.royalmand);
      } catch (e) {
        log?.error({ err: (e as Error).message, path: c.presets.royalmand }, "royalmand preset not loaded; entry mode skipped");
      }
    }
    if (signals && c.grid.entry_modes.includes("evil_panda")) {
      try {
        this.evilPanda = signals.evilPanda ?? loadEvilPandaPreset(c.presets.evil_panda);
      } catch (e) {
        log?.error({ err: (e as Error).message, path: c.presets.evil_panda }, "evil_panda preset not loaded; entry mode skipped");
      }
    }
    if (signals) {
      const env = { c, signals, sessionMinutes: clock.t.durationMinutes };
      if (this.preset) this.modules.push(meridianModule(this.preset, env));
      if (this.friday) this.modules.push(fridayModule(this.friday, env));
      if (this.yunus) {
        const y = yunusModule(this.yunus, env);
        this.yunusCombos = y.combos;
        if (y.combos.length) this.modules.push(y);
      }
      if (this.royalmand) {
        // the Meridian screen and exits of the fork: the loaded Meridian preset, or the file when that mode is off
        let mer = this.preset;
        if (!mer && this.royalmand.screen.meridian_screen) {
          try {
            mer = signals.preset ?? loadMeridianPreset(c.presets.meridian);
          } catch {
            mer = null;
          }
        }
        this.modules.push(royalmandModule(this.royalmand, mer, env));
      }
      if (this.evilPanda) this.modules.push(evilPandaModule(this.evilPanda, env));
      for (const m of this.modules) this.moduleByMode.set(m.entryMode, m);
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
      this.retryPendingEvents(ts);
      // strategy modules between cohorts: Friday's next scalp, Yunus' next cycle (each module's re-entry rule)
      if (this.cohort > 0 && this.clock.phase(ts) === "active") for (const m of this.modules) this.openModule(m, ts, this.cohort, "reentry");
    }
    this.openDeferred(ts);
    if (this.clock.phase(ts) !== "active" || ts < this.nextCohortAt) return;
    // every pool's price data in a gap (network outage): open the cohort on the first fresh tick
    const ready = [...this.sims.values()].filter((s) => s.ready);
    if (ready.length && ready.every((s) => s.priceStale(ts))) return;
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
    let opened = 0;
    for (const m of this.modules) opened += this.openModule(m, ts, this.cohort, "cohort");
    for (const sim of this.sims.values()) {
      if (!sim.ready) {
        // no data yet (e.g. a pool added during the session): enter once its data is complete
        this.stats.skippedPools++;
        this.deferred.set(sim.meta.pool, this.cohort);
        continue;
      }
      if (sim.priceStale(ts)) {
        // price data in a gap: enter on the first fresh update instead (as a real bot would)
        this.deferred.set(sim.meta.pool, this.cohort);
        this.stats.deferredEntries++;
        continue;
      }
      if (this.openPool(sim, ts, this.cohort)) return;
      opened += this.lastOpened;
    }
    this.log?.info({ cohort: this.cohort, opened, total: this.stats.requested }, "grid cohort opened");
  }

  private lastOpened = 0;

  /** Entries of deferred pools once their price data is fresh again (active phase only). */
  private openDeferred(ts: number) {
    if (!this.deferred.size) return;
    if (this.clock.phase(ts) !== "active") {
      this.deferred.clear();
      return;
    }
    for (const [pool, cohort] of this.deferred) {
      const sim = this.sims.get(pool);
      if (!sim || !sim.ready || sim.priceStale(ts)) continue;
      this.deferred.delete(pool);
      if (this.openPool(sim, ts, cohort)) return;
      for (const m of this.modules) this.openModule(m, ts, cohort, "deferred", pool);
    }
  }

  /**
   * A pool joined during the session (fresh lane): its entries of the current cohort happen as
   * soon as its data is complete instead of waiting for the next cohort.
   */
  onPoolAdded(pool: string) {
    if (this.cohort > 0 && !this.deferred.has(pool)) this.deferred.set(pool, this.cohort);
  }

  /**
   * Bins of a price-% width for this pool (grid range_pct): n = ln(1-pct) / ln(1/(1+step)); null when
   * that needs more bins than one position holds. Fixed-bin widths pass through unchanged.
   */
  private resolveWidth(sim: PoolSimulator, spec: PositionSpec): PositionSpec | null {
    if (spec.rangePct === undefined) return spec;
    const n = binsForRangePct(spec.rangePct, sim.meta.binStep);
    const below = spec.sides === "base_only" ? 0 : n;
    const above = spec.sides === "quote_only" ? 0 : n;
    if (below + above + 1 > this.c.simulation.max_bins_per_position) return null;
    return { ...spec, binsBelow: below, binsAbove: above, combo: { ...spec.combo, bins_per_side: n } };
  }

  /**
   * Every position goes through here: journals what the report slices by (width in price %, token
   * age, market cap, pool age at the entry) and requests it from the pool's simulator.
   */
  private requestPos(sim: PoolSimulator, spec: PositionSpec, ts: number) {
    const m = sim.meta;
    const ti = this.signals?.tokenInfo?.(m.pool, ts) ?? null;
    const px = sim.priceUi;
    const dd = px ? athDrawdownPct(px, this.signals?.ath?.(m.pool, ts) ?? null) : null;
    const lp = this.signals?.smartLp?.(m.pool, ts) ?? null;
    const combo = {
      ...spec.combo,
      ath_drawdown_pct: dd === null ? null : round(dd, 1),
      range_down_pct: round(downsidePct(spec.binsBelow, m.binStep), 2),
      range_up_pct: round(upsidePct(spec.binsAbove, m.binStep), 2),
      pool_age_h: m.createdAt ? round((ts - m.createdAt) / 3_600_000, 2) : null,
      token_age_h: ti?.tokenAgeHours != null ? round(ti.tokenAgeHours, 2) : null,
      mcap_usd: ti?.mcapUsd != null ? Math.round(ti.mcapUsd) : null,
      top10_pct: ti?.top10Pct != null ? round(ti.top10Pct, 1) : null,
      holders: ti?.holders ?? null,
      organic: ti?.organic != null ? round(ti.organic, 1) : null,
      bot_holders_pct: ti?.botHoldersPct != null ? round(ti.botHoldersPct, 1) : null,
      bundler_pct: ti?.bundlerPct != null ? round(ti.bundlerPct, 1) : null,
      smart_lp_open: lp ? lp.smart : null,
      lp_positions_open: lp ? lp.openPositions : null,
      volatility_pct: ti?.volatilityPct != null ? round(ti.volatilityPct, 3) : null,
      price_change_pct: ti?.priceChangePct != null ? round(ti.priceChangePct, 2) : null,
      bin_utilization: ti?.binUtilization != null ? round(ti.binUtilization, 3) : null,
      token_fees_sol: ti?.tokenFeesSol != null ? round(ti.tokenFeesSol, 2) : null,
      volume_auth_score: ti?.volumeAuthScore != null ? round(ti.volumeAuthScore, 2) : null,
      pd_timeframe: ti?.pdTimeframe ?? null,
      pd_volatility: ti?.pdVolatility != null ? round(ti.pdVolatility, 3) : null,
      pd_price_change_pct: ti?.pdPriceChangePct != null ? round(ti.pdPriceChangePct, 2) : null,
      pd_net_deposits_usd: ti?.pdNetDepositsUsd != null ? Math.round(ti.pdNetDepositsUsd) : null,
      pd_unique_traders: ti?.pdUniqueTraders ?? null,
      pd_swap_count: ti?.pdSwapCount ?? null,
      pd_critical_warning: ti?.pdCriticalWarning == null ? null : ti.pdCriticalWarning ? 1 : 0,
      regime: ti?.regime?.label ?? null,
      regime_tf: ti?.regime?.timeframe ?? null,
      regime_trend: ti?.regime?.trend ?? null,
      regime_vol: ti?.regime?.volatility ?? null,
      regime_liquidity: ti?.regime?.liquidity ?? null,
      regime_liq_pct: ti?.regime?.liquidityPct != null ? round(ti.regime.liquidityPct, 3) : null,
      regime_5m: ti?.regime5m?.label ?? null,
      volume_accel: ti?.volumeAccel != null ? round(ti.volumeAccel, 2) : null,
      holders_change_pct: ti?.holdersChangePct != null ? round(ti.holdersChangePct, 2) : null,
      fee_active_tvl_pct: ti?.feeActiveTvlPct != null ? round(ti.feeActiveTvlPct, 4) : null,
    };
    return sim.request({ ...spec, combo }, ts);
  }

  /** Open the grid of one pool for a cohort. Returns true when grid.max_positions was reached. */
  private openPool(sim: PoolSimulator, ts: number, cohortNo: number, event?: { modes: Set<string> }): boolean {
    this.lastOpened = 0;
    let opened = 0;
    const trigger = event ? "event" : "cohort";
    const sigEntry = this.c.grid.signal_entry;
    {
      const sig = this.signals?.book.latestFor(sim.meta.pool, ts) ?? null;
      const rec = sig?.recommendation ?? null;
      const cooldown = this.signals?.memory?.poolCooldown(sim.meta.pool, ts) ?? null;
      const ind = this.signals?.indicators?.at(sim.meta.pool, ts) ?? null;
      const filterOk = new Map<string, boolean>();
      let taken = false;
      for (const spec of this.combos) {
        const signalMode = COOLDOWN_MODES.has(spec.entryMode);
        if (event && !event.modes.has(spec.entryMode)) continue; // an event opens only the mode it belongs to
        if (!event && signalMode && sigEntry.trigger === "event") continue; // signal modes wait for their events
        if (!this.admits(spec.entryMode, sig?.action ?? null)) continue;
        if (spec.cooldownEnabled && cooldown) {
          this.stats.cooldownSkips++;
          continue;
        }
        const ef = spec.entryFilter ?? "none";
        if (ef !== "none") {
          let ok = filterOk.get(ef);
          if (ok === undefined) {
            // flow_confirm: Friday's entry confirmation (stage 2) on the grid combinations
            const snap = ef === "flow_confirm" ? this.signals?.flow?.(sim.meta.pool, ts) ?? null : null;
            const fc = ef === "flow_confirm" && snap ? flowConfirm(snap, FRIDAY_CONFIRM) : null;
            const r = ef === "flow_confirm"
              ? { pass: !!fc?.pass, reason: fc ? fc.failed[0] ?? "ok" : "no_data" }
              : entryFilterPass(ef as EntryFilter, ind, this.c.indicators);
            ok = r.pass;
            filterOk.set(ef, ok);
            if (!ok) {
              const k = `${ef}:${r.reason === "no_data" ? "no_data" : "not_passed"}`;
              this.stats.filterSkips[k] = (this.stats.filterSkips[k] ?? 0) + 1; // counted per pool and cohort
            }
          }
          if (!ok) continue;
        }
        if (this.full()) {
          this.lastOpened = opened;
          return true;
        }
        const resolved = this.resolveWidth(sim, spec);
        if (!resolved) {
          this.stats.widthSkips++; // a price-% width that needs more bins than one position can hold in this pool
          continue;
        }
        const matches = !!rec && rec.strategy === resolved.strategy && rec.sides === resolved.sides &&
          rec.bins_below === resolved.binsBelow && rec.bins_above === resolved.binsAbove;
        this.requestPos(
          sim,
          {
            ...resolved,
            cohort: cohortNo,
            signalId: sig?.signal_id ?? null,
            combo: {
              ...resolved.combo, cohort: cohortNo, signal_action: sig?.action ?? null, signal_score: sig?.final_score ?? null,
              matches_recommendation: matches, ...(signalMode ? { entry_trigger: trigger } : {}),
            },
          },
          ts,
        );
        if (spec.entryMode !== "all_pools_baseline") {
          taken = true;
          this.stats.signalEntries[spec.entryMode] = (this.stats.signalEntries[spec.entryMode] ?? 0) + 1;
        }
        if (signalMode) this.lastEntry.set(`${sim.meta.pool}|${spec.entryMode}`, ts);
        this.stats.requested++;
        opened++;
      }
      if (taken && sig) this.signals!.book.markTaken(sig.signal_id);
    }
    this.lastOpened = opened;
    return false;
  }

  /**
   * One strategy module (roadmap PHASE 3) over the ready pools: its re-entry rule picks the plans
   * that may open now, its screen decides the pool, its range gives each plan's position; ranked
   * modules (Meridian) open only their top N passing pools. The runner only books the result:
   * stats per check, width and position caps, the journal and the cycle count per plan.
   */
  private openModule(mod: StrategyModule, ts: number, cohortNo: number, trigger: EntryTrigger, only?: string): number {
    const st = this.stats[mod.statsKey] as ModeStats;
    const ranked: { sim: PoolSimulator; verdict: EntryVerdict; due: Due[] }[] = [];
    let opened = 0;
    for (const sim of this.sims.values()) {
      if (only && sim.meta.pool !== only) continue;
      if (!sim.ready || sim.priceStale(ts)) continue;
      const due: Due[] = [];
      for (const key of mod.planKeys(sim)) {
        const c = this.cycles.get(`${mod.entryMode}|${sim.meta.pool}|${key}`);
        const prev: PreviousCycle | null = c ? { n: c.n, position: sim.get(c.positionId) } : null;
        const rv = mod.evaluateReentry(prev, ts, trigger);
        if (rv.ok) due.push({ key, prev, rv });
      }
      if (!due.length) continue;
      const verdict = mod.evaluateEntry(sim, ts, trigger);
      if (!verdict) continue;
      st.evaluated++;
      if (verdict.failed.length) {
        for (const f of verdict.failed) st.failed[f] = (st.failed[f] ?? 0) + 1;
        continue;
      }
      if (mod.rankTopN !== undefined) {
        ranked.push({ sim, verdict, due });
        continue;
      }
      const r = this.openPlans(mod, st, sim, ts, cohortNo, trigger, verdict, due, null);
      opened += r.opened;
      if (r.full) return opened;
    }
    if (mod.rankTopN !== undefined) {
      if (st.passed !== undefined) st.passed += ranked.length;
      ranked.sort((a, b) => (b.verdict.score ?? 0) - (a.verdict.score ?? 0));
      for (const [i, x] of ranked.slice(0, mod.rankTopN).entries()) {
        const r = this.openPlans(mod, st, x.sim, ts, cohortNo, trigger, x.verdict, x.due, i + 1);
        opened += r.opened;
        if (r.full) break;
      }
    }
    return opened;
  }

  private openPlans(
    mod: StrategyModule, st: ModeStats, sim: PoolSimulator, ts: number, cohortNo: number, trigger: EntryTrigger,
    verdict: EntryVerdict, due: Due[], rank: number | null,
  ): { opened: number; full: boolean } {
    const sig = this.signals?.book.latestFor(sim.meta.pool, ts) ?? null;
    let opened = 0;
    for (const d of due) {
      const n = (d.prev?.n ?? 0) + 1;
      const plan = mod.calculateRange(sim, ts, { key: d.key, n, hasPrevious: !!d.prev, trigger, verdict, rank });
      if ("skip" in plan) {
        st.failed[plan.skip] = (st.failed[plan.skip] ?? 0) + 1;
        continue;
      }
      if (plan.binsBelow + plan.binsAbove + 1 > this.c.simulation.max_bins_per_position) {
        this.stats.widthSkips++;
        continue;
      }
      if (this.full()) return { opened, full: true };
      const p = this.requestPos(
        sim,
        {
          strategy: plan.strategy, sides: plan.sides, binsBelow: plan.binsBelow, binsAbove: plan.binsAbove, exitPolicy: plan.exitPolicy, variant: "none",
          ...(plan.flip ? { flip: plan.flip } : {}),
          entryMode: mod.entryMode, capitalUsd: this.c.simulation.virtual_capital_usd, cohort: cohortNo, signalId: sig?.signal_id ?? null,
          combo: {
            entry_mode: mod.entryMode, ...plan.combo, cohort: cohortNo, signal_action: sig?.action ?? null, signal_score: sig?.final_score ?? null,
            ...txEstimateJournal(mod.estimateTransactions(plan)),
          },
        },
        ts,
      );
      this.cycles.set(`${mod.entryMode}|${sim.meta.pool}|${d.key}`, { n, positionId: p.id });
      this.stats.requested++;
      st.opened++;
      if (d.rv.reentry && st.reentries !== undefined) st.reentries++;
      if (verdict.missing.length && st.partial !== undefined) st.partial++;
      this.stats.signalEntries[mod.entryMode] = (this.stats.signalEntries[mod.entryMode] ?? 0) + 1;
      opened++;
    }
    return { opened, full: false };
  }

  /**
   * Yunus flip: once the price fell through the whole range and the position is (almost) all token,
   * redeploy it base-only above the new price (optionally as a shape mix), up to max_flips times.
   */
  private tryFlip(sim: PoolSimulator, p: VirtualPosition, ts: number): boolean {
    const f = p.spec.flip;
    if (!f || p.reseeds >= f.maxFlips) return false;
    const above = binsForUpPct(f.upPct, sim.meta.binStep);
    if (!sim.reseed(p.id, ts, 0.99, { binsAbove: above, strategy: f.shape, blend: f.blend ?? undefined, reason: "yunus_flip" })) return false;
    this.stats.yunus.flips++;
    return true;
  }

  /** Out-of-range exit policies for one pool after its state update. */
  onPoolState(pool: string, ts: number) {
    const sim = this.sims.get(pool);
    if (!sim || sim.priceStale(ts)) return;
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
      // blueprint 15 (exit_engine) / prism-liquidity-agent's gas-aware rebalance (rebalance_out_of_range):
      // do not rebalance when it costs more than the fee it is expected to earn -- a fixed-dollar tx +
      // rent cost paid again for every out-of-range flip is exactly what makes small capital worse off.
      const costCheckOn =
        (pol.type === "exit_engine" && this.c.exit_engine.rebalance_cost_check) ||
        (pol.type === "rebalance_out_of_range" && this.c.simulation.gas_aware_rebalance);
      if (costCheckOn && this.signals?.expectedFeeUsd) {
        const cost = sim.estimateRebalanceCostUsd(p.id);
        const value = sim.valuation(p).valueUsd;
        let fee = this.signals.expectedFeeUsd(pool, value, ts);
        // expectedFeeUsd covers the edge horizon; rebalance_out_of_range may ask for a longer one
        if (fee !== null && pol.type === "rebalance_out_of_range") fee *= (this.c.simulation.gas_aware_horizon_hours * 60) / this.c.scoring.edge.horizon_minutes;
        if (cost !== null && fee !== null && cost >= fee) {
          sim.logExitSignal(p.id, ts, { action: "KELUAR", reason: "rebalance_not_worth", conditions: { costUsd: cost, expectedFeeUsd: fee } });
          sim.close(p.id, `${pol.type}:rebalance_not_worth`, ts);
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
      r = { trailing: newTrailing(), flowPending: null, feeHist: [], lastCompound: p.openedAt ?? 0, worstPct: 0 };
      this.rt.set(p.id, r);
    }
    return r;
  }

  /** PnL policies and strategy variants of every active position (every pnl_eval_seconds). */
  private evaluate(ts: number) {
    const vp = this.c.grid.variant_params;
    for (const sim of this.sims.values()) {
      if (sim.priceStale(ts)) continue; // price data in a gap: act on the first fresh update
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
        if (p.spec.flip) {
          if (p.outOfRangeSince !== null) this.tryFlip(sim, p, ts);
          // after a flip the position sells the token on the way up; fully back in quote = cycle complete
          if (p.reseeds > 0 && p.status === "active") {
            const share = sim.xShare(p.id);
            if (share !== null && share <= 0.01) {
              sim.close(p.id, "cycle_complete", ts);
              this.rt.delete(p.id);
              this.stats.yunus.cycles++;
              this.stats.pnlExits.cycle_complete = (this.stats.pnlExits.cycle_complete ?? 0) + 1;
              continue;
            }
          }
        }
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
        // ---- the strategy module's own exit rule (PHASE 3 evaluateExit), before the shared exit policies
        const own = this.moduleByMode.get(p.spec.entryMode);
        if (own?.evaluateExit) {
          const why = own.evaluateExit({ sim, p, ts, netPct: (v.netPnlUsd / cap) * 100 });
          if (why) {
            sim.close(p.id, why, ts);
            this.rt.delete(p.id);
            this.stats.policyExits++;
            this.stats.pnlExits[why] = (this.stats.pnlExits[why] ?? 0) + 1;
            continue;
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
        r.worstPct = Math.min(r.worstPct, netPct);
        const d = pnlDecision(pol, { t: ts, netPct, feePct: (feeTotal / cap) * 100, ageMinutes: (ts - p.openedAt) / 60_000, feePctPerHourWindow: feeRate, worstPct: r.worstPct }, r.trailing);
        r.trailing = d.trailing;
        if (d.event) sim.logExitSignal(p.id, ts, { action: d.event, pnlPct: netPct, peakPct: d.trailing.peak, policy: pol.type });
        let reason = d.reason;
        // Friday stage 2: one-minute flow triggers (first check one minute after the open)
        const fx = flowExitOf(pol);
        if (!reason && fx && ts - p.openedAt >= 60_000 && this.signals?.flow) {
          const snap = this.signals.flow(sim.meta.pool, ts);
          const f = snap ? flowTriggers(snap, fx.triggers, fx) : null;
          if (f && f.fired.length) {
            if (fx.confirm_seconds <= 0 || (r.flowPending !== null && ts - r.flowPending >= fx.confirm_seconds * 1000)) {
              reason = `flow_${f.fired[0]}`;
              sim.logExitSignal(p.id, ts, { action: "KELUAR", reason, fired: f.fired, flow: flowDetail(snap!) });
            } else if (r.flowPending === null) r.flowPending = ts;
          } else r.flowPending = null;
        }
        if (reason) {
          sim.close(p.id, reason, ts);
          this.rt.delete(p.id);
          this.stats.policyExits++;
          this.stats.pnlExits[reason] = (this.stats.pnlExits[reason] ?? 0) + 1;
        }
      }
    }
  }

  /** After each scoring round: exit engine rules for exit_engine positions. */
  onScores(ts: number) {
    this.detectEvents(ts);
    const ee = this.signals?.exitEngine;
    if (!ee) return;
    for (const sim of this.sims.values()) ee.run(sim, ts);
  }

  /**
   * Event entries of the signal modes (grid.signal_entry.trigger event | both): a pool's signal
   * turning admitted (a rising edge) opens that mode's grid in the pool right away instead of at
   * the next cohort. Limits: min_gap_minutes between entries of a pool and mode (cohort entries
   * count), max_per_pool events per session; optionally Friday's flow confirmation must pass
   * (waiting up to flow_wait_minutes while the signal stays admitted). The pool's data must be
   * fresh; otherwise the edge is seen again on the next round.
   */
  private detectEvents(ts: number) {
    const se = this.c.grid.signal_entry;
    if (!this.signals || se.trigger === "cohort" || this.cohort === 0 || this.clock.phase(ts) !== "active") return;
    const modes = [...new Set(this.combos.map((s) => s.entryMode))].filter((m) => COOLDOWN_MODES.has(m));
    if (!modes.length) return;
    const skip = (why: string) => (this.stats.events.skipped[why] = (this.stats.events.skipped[why] ?? 0) + 1);
    for (const sim of this.sims.values()) {
      if (!sim.ready || sim.priceStale(ts)) continue;
      const pool = sim.meta.pool;
      const sig = this.signals.book.latestFor(pool, ts);
      const prev = this.lastAction.get(pool) ?? null;
      const now = sig?.action ?? null;
      if (sig) this.lastAction.set(pool, now);
      for (const mode of modes) {
        const key = `${pool}|${mode}`;
        const edge = this.admits(mode, now) && !this.admits(mode, prev) && !!sig;
        if (edge) {
          this.stats.events.detected++;
          if (se.require_flow_confirm) this.pendingEvents.set(key, ts);
        }
        const pending = this.pendingEvents.has(key);
        if (!edge && !pending) continue;
        if (pending && (!this.admits(mode, now) || ts - this.pendingEvents.get(key)! > se.flow_wait_minutes * 60_000)) {
          this.pendingEvents.delete(key);
          skip(this.admits(mode, now) ? "flow_confirm_timeout" : "signal_gone");
          continue;
        }
        if (se.require_flow_confirm) {
          const snap = this.signals.flow?.(pool, ts) ?? null;
          const fc = snap ? flowConfirm(snap, FRIDAY_CONFIRM) : null;
          if (!fc?.pass) continue; // keep waiting (pending); no flow data behaves like "not confirmed"
        }
        this.pendingEvents.delete(key);
        const last = this.lastEntry.get(key);
        if (last !== undefined && ts - last < se.min_gap_minutes * 60_000) {
          skip("min_gap");
          continue;
        }
        const n = this.eventCount.get(key) ?? 0;
        if (n >= se.max_per_pool) {
          skip("max_per_pool");
          continue;
        }
        this.eventCount.set(key, n + 1);
        const before = this.stats.requested;
        this.openPool(sim, ts, this.cohort, { modes: new Set([mode]) });
        if (this.stats.requested > before) this.stats.events.opened++;
        else skip("nothing_opened"); // cooldown / filters / cap
      }
    }
  }

  /** Waiting events (flow confirmation) are re-checked between scoring rounds too. */
  private retryPendingEvents(ts: number) {
    if (this.pendingEvents.size) this.detectEvents(ts);
  }

  /** Force-close every open position (session end, or shutdown). */
  finish(ts: number, reason: "session_end" | "session_aborted") {
    for (const sim of this.sims.values()) sim.closeAll(reason, Math.max(ts, sim.now));
    this.rt.clear();
  }
}
