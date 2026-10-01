import type { PoolSimulator } from "../sim/engine.ts";
import { baseFeePct, evaluateFriday, FRIDAY_NOT_YET, fridayExitPolicy, type FridayPreset } from "../sim/friday.ts";
import { flowConfirm, netBuyUsd, type FlowSnapshot } from "../sim/flow.ts";
import { exitPolicyLabel } from "../sim/policies.ts";
import { estimateCycleTransactions, type EntryTrigger, type EntryVerdict, type ModuleEnv, type PreviousCycle, type RangeContext, type RangePlan, type StrategyModule } from "./types.ts";

/** Compact flow values for the journal. */
export function flowDetail(x: FlowSnapshot) {
  const r = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
  return {
    volume: x.minutes.slice(0, 3).map((m) => r(m.volumeUsd)),
    netBuy: r(netBuyUsd(x.minutes[0], x.riskIsX)),
    holders: x.holders,
    bundlerPct: x.bundlerPct ? { now: r(x.bundlerPct.now), prev: r(x.bundlerPct.prev) } : null,
  };
}

/**
 * friday_scalp: one Spot two-sided position (34 + 1 + 34 bins) with the scalp exit (time stop, out
 * of range, flow triggers) in every pool passing Friday's screen and the one-minute flow
 * confirmation. At a cohort every passing pool without an open scalp gets one; between cohorts a
 * pool gets the next one reentry.minutes after its previous scalp closed, up to max_trades_per_pool.
 */
export function fridayModule(pr: FridayPreset, env: ModuleEnv): StrategyModule {
  const exitPolicy = fridayExitPolicy(pr);
  const s = pr.strategy;
  return {
    id: "friday_scalp",
    entryMode: "friday_scalp",
    statsKey: "friday",
    planKeys: () => ["main"],
    evaluateReentry(prev: PreviousCycle | null, ts: number, trigger: EntryTrigger) {
      const reentry = trigger === "reentry";
      if (prev) {
        const p = prev.position;
        if (p && (p.status === "active" || p.status === "pending")) return { ok: false, reentry }; // one scalp at a time
        if (prev.n >= pr.reentry.max_trades_per_pool) return { ok: false, reentry };
        const since = p?.closedAt ?? p?.requestedAt ?? 0;
        if (reentry && ts - since < pr.reentry.minutes * 60_000) return { ok: false, reentry };
      } else if (reentry && !pr.entry_confirm.enabled) return { ok: false, reentry }; // without a confirmation: first entries at cohorts
      return { ok: true, reentry };
    },
    evaluateEntry(sim: PoolSimulator, ts: number): EntryVerdict | null {
      const x = env.signals.fridayInputs?.(sim.meta.pool, ts) ?? null;
      if (!x) return null;
      const failed = evaluateFriday(pr, sim.meta, x, ts);
      // step 2 "confirm entry": volume rising, net buy > 0, holders growing, bundlers stable
      let confirm: ReturnType<typeof flowConfirm> | null = null;
      let snap: FlowSnapshot | null = null;
      if (!failed.length && pr.entry_confirm.enabled) {
        snap = env.signals.flow?.(sim.meta.pool, ts) ?? null;
        confirm = snap ? flowConfirm(snap, pr.entry_confirm) : { pass: false, failed: ["flow:missing"], missing: [] };
        for (const f of confirm.failed) failed.push(`confirm:${f}`);
      }
      return { failed, missing: [...FRIDAY_NOT_YET, ...(confirm?.missing ?? [])], journal: { flow_at_entry: snap ? flowDetail(snap) : null } };
    },
    calculateRange(sim: PoolSimulator, ts: number, ctx: RangeContext): RangePlan {
      return {
        strategy: s.shape, sides: s.sides, exitPolicy,
        binsBelow: s.sides === "base_only" ? 0 : s.bins_per_side, binsAbove: s.sides === "quote_only" ? 0 : s.bins_per_side,
        combo: {
          strategy: s.shape, bins_per_side: s.bins_per_side, sides: s.sides,
          exit_policy: exitPolicyLabel(exitPolicy), variant: "none", trade_no: ctx.n, reentry: ctx.hasPrevious, at_cohort: ctx.trigger !== "reentry",
          preset_partial: ctx.verdict.missing.length > 0, preset_missing: ctx.verdict.missing,
          ...ctx.verdict.journal,
          pool_age_minutes: sim.meta.createdAt ? (ts - sim.meta.createdAt) / 60_000 : null,
          base_fee_pct: baseFeePct(sim.meta), collect_fee_mode: sim.meta.collectFeeMode,
        },
      };
    },
    estimateTransactions: (plan) => estimateCycleTransactions(env.c, plan),
  };
}
