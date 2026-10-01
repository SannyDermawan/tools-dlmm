import type { Config, Sides, Strategy } from "../config/schema.ts";
import type { PoolSimulator } from "../sim/engine.ts";
import type { FlipSpec, VirtualPosition } from "../sim/position.ts";
import type { ScalarExitPolicy } from "../sim/policies.ts";
import type { GridSignals } from "../sim/gridRunner.ts";

/**
 * Standard strategy interface (strategy-lab roadmap PHASE 3). Every preset entry mode (Meridian,
 * Friday, Yunus, fork_panda, Evil Panda) is a StrategyModule; GridRunner runs them all through one loop and
 * knows nothing about their rules. The components map onto the PHASE 2 decomposition:
 *
 *   evaluateReentry      -> re-entry (and "one position at a time")
 *   evaluateEntry        -> entry + filter (the pool / token screen)
 *   calculateRange       -> side + range (+ the exit policy and flip of the plan)
 *   evaluateExit         -> exit, when the module has its own rule; otherwise the shared exit-policy
 *                           engine (src/sim/policies.ts) runs the plan's exit policy
 *   estimateTransactions -> transaction policy (operations one cycle needs)
 *
 * A module never sizes a position (the session's virtual capital) and never trades.
 */

/** Why the module is asked: a cohort, a re-entry tick between cohorts, or a pool whose cohort entry waited for data. */
export type EntryTrigger = "cohort" | "reentry" | "deferred";

export interface ModuleEnv {
  c: Config;
  signals: GridSignals;
  /** length of this session in minutes (the clock's, which `-d` changes); modules for multi-day holds stay out of short sessions */
  sessionMinutes?: number;
}

/** The previous cycle of a pool and plan key, and that position now (undefined when the simulator dropped it). */
export interface PreviousCycle {
  n: number;
  position: VirtualPosition | undefined;
}

export interface ReentryVerdict {
  ok: boolean;
  /** counted as a re-entry in the mode's stats */
  reentry: boolean;
}

export interface EntryVerdict {
  /** failed checks (empty = pass); each is counted in the mode's stats */
  failed: string[];
  /** inputs that were missing; the position is journaled as partial */
  missing: string[];
  /** ranking across pools (modules with rankTopN) */
  score?: number;
  /** extra fields journaled with the position */
  journal?: Record<string, unknown>;
}

export interface RangePlan {
  strategy: Strategy;
  sides: Sides;
  binsBelow: number;
  binsAbove: number;
  flip?: FlipSpec;
  exitPolicy: ScalarExitPolicy;
  /** mode-specific fields journaled with the position */
  combo: Record<string, unknown>;
}

export interface RangeContext {
  key: string;
  /** cycle number of this pool and key (1 = first) */
  n: number;
  /** a previous cycle exists */
  hasPrevious: boolean;
  trigger: EntryTrigger;
  verdict: EntryVerdict;
  /** 1-based rank among the passing pools (modules with rankTopN), else null */
  rank: number | null;
}

export interface ExitContext {
  sim: PoolSimulator;
  p: VirtualPosition;
  ts: number;
  /** net PnL % of the capital (costs included) */
  netPct: number;
}

export interface TxEstimate {
  /** operations of one cycle (open, close, swaps, rebalances, flips), fewest and most */
  min: number;
  max: number;
  /** transactions per open / close (a wide range needs several) */
  txPerOperation: number;
  detail: string[];
}

export type ModeStats = {
  evaluated: number;
  opened: number;
  failed: Record<string, number>;
  passed?: number;
  partial?: number;
  reentries?: number;
};

export interface StrategyModule {
  /** registry id (registry/strategies.yaml) */
  readonly id: string;
  readonly entryMode: string;
  /** key of GridRunner.stats for this mode */
  readonly statsKey: "preset" | "friday" | "yunus" | "forkPanda" | "evilPanda";
  /** open only the N best-scoring passing pools per cohort (Meridian's ranking); undefined = every passing pool */
  readonly rankTopN?: number;
  /** independent plans per pool (Yunus: one per grid combination); each keeps its own cycles */
  planKeys(sim: PoolSimulator): string[];
  evaluateReentry(prev: PreviousCycle | null, ts: number, trigger: EntryTrigger): ReentryVerdict;
  /** null = the inputs are not available: the pool is not evaluated (and not counted) */
  evaluateEntry(sim: PoolSimulator, ts: number, trigger: EntryTrigger): EntryVerdict | null;
  calculateRange(sim: PoolSimulator, ts: number, ctx: RangeContext): RangePlan | { skip: string };
  /** a close reason, or null to keep the position; absent = the plan's exit policy alone decides */
  evaluateExit?(x: ExitContext): string | null;
  estimateTransactions(plan: Pick<RangePlan, "sides" | "binsBelow" | "binsAbove" | "exitPolicy" | "flip">): TxEstimate;
}

/**
 * Operations one cycle of a plan needs, from its shape alone: open (+ a balancing swap unless the
 * deposit is the quote token), close (+ the exit swap back to quote), rebalances the exit policy
 * allows, and flips. Wide ranges need ceil(bins / bins_per_tx) transactions per open / close.
 */
export function estimateCycleTransactions(c: Config, plan: Pick<RangePlan, "sides" | "binsBelow" | "binsAbove" | "exitPolicy" | "flip">): TxEstimate {
  const bins = plan.binsBelow + plan.binsAbove + 1;
  const txPerOperation = Math.max(1, Math.ceil(bins / c.simulation.costs.bins_per_tx));
  const detail = ["open", "close"];
  let min = 2;
  let max = 2;
  if (plan.sides !== "quote_only") {
    min++;
    max++;
    detail.push("balancing swap at the open");
  }
  max++; // exit swap of whatever base token is left (none when the price stayed above a quote-only range)
  detail.push("exit swap (0-1)");
  const pol = plan.exitPolicy;
  if (pol.type === "rebalance_out_of_range" || pol.type === "exit_engine") {
    max += 2 * pol.max_rebalances;
    detail.push(`rebalances (0-${pol.max_rebalances}, each with a swap)`);
  }
  if (plan.flip) {
    max += plan.flip.maxFlips;
    detail.push(`flips (0-${plan.flip.maxFlips})`);
  }
  return { min, max, txPerOperation, detail };
}
