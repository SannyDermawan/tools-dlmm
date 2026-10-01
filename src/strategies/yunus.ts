import type { PoolSimulator } from "../sim/engine.ts";
import { athDrawdownPct } from "../features/ath.ts";
import { binsForRangePct } from "../sim/distribution.ts";
import { baseFeePct } from "../sim/friday.ts";
import { exitPolicyLabel } from "../sim/policies.ts";
import { evaluateYunus, yunusCombos, yunusDownside, type YunusCombo, type YunusPreset } from "../sim/yunus.ts";
import { estimateCycleTransactions, type EntryTrigger, type EntryVerdict, type ModuleEnv, type PreviousCycle, type RangeContext, type RangePlan, type StrategyModule } from "./types.ts";

/**
 * yunus_flip: per pool and combination one bid-ask quote-only position below the price (width in
 * price %, from the price or from the ATH), which flips base-only above once it is fully in the
 * token (GridRunner.tryFlip, driven by the plan's flip spec) and ends by its exit policy or when it
 * is back in quote. A new cycle opens reentry.cooldown_minutes after the previous one closed, up to
 * reentry.max_cycles_per_pool.
 */
export function yunusModule(pr: YunusPreset, env: ModuleEnv): StrategyModule & { combos: YunusCombo[] } {
  const combos = yunusCombos(pr, exitPolicyLabel);
  const byKey = new Map(combos.map((c) => [c.key, c]));
  return {
    id: "yunus_flip",
    entryMode: "yunus_flip",
    statsKey: "yunus",
    combos,
    planKeys: () => combos.map((c) => c.key),
    evaluateReentry(prev: PreviousCycle | null, ts: number, trigger: EntryTrigger) {
      if (!prev) return { ok: trigger !== "reentry", reentry: false };
      const p = prev.position;
      if (p && (p.status === "active" || p.status === "pending")) return { ok: false, reentry: true }; // one cycle at a time
      if (prev.n >= pr.reentry.max_cycles_per_pool) return { ok: false, reentry: true };
      const since = p?.closedAt ?? p?.requestedAt ?? 0;
      return { ok: ts - since >= pr.reentry.cooldown_minutes * 60_000, reentry: true };
    },
    evaluateEntry(sim: PoolSimulator, ts: number): EntryVerdict | null {
      const pool = sim.meta.pool;
      const px = sim.priceUi;
      const ath = env.signals.ath?.(pool, ts) ?? null;
      const ti = env.signals.tokenInfo?.(pool, ts) ?? null;
      const fi = env.signals.fridayInputs?.(pool, ts) ?? null;
      if (!fi) return null;
      const failed = evaluateYunus(pr, {
        tvlUsd: fi.tvlUsd, category: sim.meta.category, riskIsBase: ti?.riskIsBase ?? null,
        mintAuthority: fi.mintAuthority, freezeAuthority: fi.freezeAuthority,
        mcapUsd: ti?.mcapUsd ?? null, tokenAgeHours: ti?.tokenAgeHours ?? null, athDrawdownPct: px ? athDrawdownPct(px, ath) : null,
      });
      return { failed, missing: [] };
    },
    calculateRange(sim: PoolSimulator, ts: number, ctx: RangeContext): RangePlan | { skip: string } {
      const c = byKey.get(ctx.key)!;
      const d = yunusDownside(pr, c, sim.priceUi, env.signals.ath?.(sim.meta.pool, ts) ?? null);
      if ("skip" in d) return d;
      const bins = binsForRangePct(d.pct, sim.meta.binStep);
      return {
        strategy: pr.entry.shape, sides: "quote_only", binsBelow: bins, binsAbove: 0, exitPolicy: c.exit, flip: c.flip,
        combo: {
          strategy: pr.entry.shape, bins_per_side: bins, sides: "quote_only", range_pct: c.widthPct, anchor: c.anchor,
          flip_shape: c.flipName, exit_policy: c.exitLabel, variant: "none", cycle_no: ctx.n, reentry: ctx.hasPrevious, at_cohort: ctx.trigger !== "reentry",
          base_fee_pct: baseFeePct(sim.meta), collect_fee_mode: sim.meta.collectFeeMode,
        },
      };
    },
    estimateTransactions: (plan) => estimateCycleTransactions(env.c, plan),
  };
}
