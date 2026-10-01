import type { PoolSimulator } from "../sim/engine.ts";
import { evaluateMeridian, feeWindowMinutes, meridianExitPolicy, type MeridianPreset } from "../sim/meridian.ts";
import { exitPolicyLabel } from "../sim/policies.ts";
import { estimateCycleTransactions, type EntryTrigger, type EntryVerdict, type ModuleEnv, type RangeContext, type RangePlan, type StrategyModule } from "./types.ts";

/**
 * meridian_preset: the Meridian default screen on every ready pool at a cohort; the passing pools
 * are ranked and the preset position opens in the top N. No re-entry between cohorts, none for a
 * pool whose cohort entry waited for data. Token filters without data -> partial.
 */
export function meridianModule(pr: MeridianPreset, env: ModuleEnv): StrategyModule {
  const win = feeWindowMinutes(pr);
  const exitPolicy = meridianExitPolicy(pr);
  const s = pr.strategy;
  return {
    id: "meridian_preset",
    entryMode: "meridian_preset",
    statsKey: "preset",
    rankTopN: pr.ranking.top_n,
    planKeys: () => ["main"],
    evaluateReentry: (_prev, _ts, trigger: EntryTrigger) => ({ ok: trigger === "cohort", reentry: false }),
    evaluateEntry(sim: PoolSimulator, ts: number): EntryVerdict | null {
      const x = env.signals.presetInputs?.(sim.meta.pool, ts, sim, win) ?? null;
      if (!x) return null;
      const ev = evaluateMeridian(pr, x);
      return { failed: ev.pass ? [] : ev.failed, missing: ev.missing, score: ev.score };
    },
    calculateRange(_sim, _ts, ctx: RangeContext): RangePlan {
      const binsBelow = s.sides === "base_only" ? 0 : s.bins_below;
      const binsAbove = s.sides === "two_sided" ? s.bins_below : 0;
      return {
        strategy: s.shape, sides: s.sides, binsBelow, binsAbove, exitPolicy,
        combo: {
          strategy: s.shape, bins_per_side: s.bins_below, sides: s.sides, exit_policy: exitPolicyLabel(exitPolicy), variant: "none",
          preset_partial: ctx.verdict.missing.length > 0, preset_missing: ctx.verdict.missing, preset_score: ctx.verdict.score ?? null, preset_rank: ctx.rank,
        },
      };
    },
    estimateTransactions: (plan) => estimateCycleTransactions(env.c, plan),
  };
}
