import type { ExitPolicy } from "../config/schema.ts";
import type { FlowThresholds, FlowTrigger } from "./flow.ts";

/** Flow exit of a policy (triggers + thresholds + confirmation), see flow.ts. */
export type FlowExit = FlowThresholds & { triggers: FlowTrigger[]; confirm_seconds: number };
/** Friday's four triggers (the "all" set); net_buy_rel is our relative variant. */
export const FRIDAY_FOUR: FlowTrigger[] = ["bundler", "net_buy", "holders", "volume"];

/** An exit policy with every list parameter resolved to one value (one grid level). */
export type ScalarExitPolicy =
  | { type: "hold_to_session_end" }
  | { type: "exit_out_of_range"; minutes: number }
  | { type: "rebalance_out_of_range"; minutes: number; max_rebalances: number }
  | { type: "exit_engine"; minutes: number; max_rebalances: number }
  | { type: "take_profit"; pct: number; basis: "net" | "fee" }
  | { type: "stop_loss"; pct: number }
  | { type: "trailing_tp"; trigger_pct: number; drop_pct: number; confirm_seconds: number; tolerance_pct: number }
  | {
      type: "tp_sl_combo";
      tp_pct?: number;
      tp_fee_pct?: number;
      sl_pct: number;
      trigger_pct?: number;
      drop_pct?: number;
      confirm_seconds: number;
      tolerance_pct: number;
      oor_minutes?: number;
    }
  | { type: "low_yield_exit"; min_fee_pct_per_hour: number; window_minutes: number; min_age_minutes: number }
  | { type: "time_stop"; minutes: number }
  | { type: "breakeven_exit"; min_underwater_pct: number; target_pct: number; time_cap_minutes: number; tp_pct?: number; sl_pct?: number }
  | { type: "scalp"; time_stop_minutes: number; oor_minutes: number; sl_pct?: number; flow?: FlowExit }
  | ({ type: "flow_trigger"; set: string; time_stop_minutes?: number } & FlowExit);

const list = (v: number | number[]) => (Array.isArray(v) ? v : [v]);

/**
 * Expand config policies into grid levels: `pct: [3, 5, 10]` gives three policies; for
 * trailing_tp the trigger and drop lists are paired element by element (2/1, 3/1.5, 5/3).
 */
export function expandExitPolicies(policies: ExitPolicy[]): ScalarExitPolicy[] {
  const out: ScalarExitPolicy[] = [];
  for (const p of policies) {
    switch (p.type) {
      case "take_profit":
        for (const pct of list(p.pct)) out.push({ type: "take_profit", pct, basis: p.basis ?? "net" });
        break;
      case "stop_loss":
        for (const pct of list(p.pct)) out.push({ type: "stop_loss", pct });
        break;
      case "exit_out_of_range":
        for (const minutes of list(p.minutes)) out.push({ type: "exit_out_of_range", minutes });
        break;
      case "time_stop":
        for (const minutes of list(p.minutes)) out.push({ type: "time_stop", minutes });
        break;
      case "breakeven_exit":
        for (const uw of list(p.min_underwater_pct))
          for (const cap of list(p.time_cap_minutes))
            out.push({ type: "breakeven_exit", min_underwater_pct: uw, target_pct: p.target_pct, time_cap_minutes: cap, ...(p.tp_pct ? { tp_pct: p.tp_pct } : {}), ...(p.sl_pct ? { sl_pct: p.sl_pct } : {}) });
        break;
      case "flow_trigger": {
        const { sets, type: _t, ...rest } = p;
        for (const set of sets) out.push({ type: "flow_trigger", set, triggers: set === "all" ? FRIDAY_FOUR : [set], ...rest });
        break;
      }
      case "trailing_tp": {
        const t = list(p.trigger_pct);
        const d = list(p.drop_pct);
        const n = Math.max(t.length, d.length);
        for (let i = 0; i < n; i++) {
          out.push({
            type: "trailing_tp", trigger_pct: t[Math.min(i, t.length - 1)], drop_pct: d[Math.min(i, d.length - 1)],
            confirm_seconds: p.confirm_seconds ?? 15, tolerance_pct: p.tolerance_pct ?? 1,
          });
        }
        break;
      }
      default:
        out.push(p as ScalarExitPolicy);
    }
  }
  return out;
}

export function exitPolicyLabel(e: ScalarExitPolicy): string {
  switch (e.type) {
    case "hold_to_session_end":
      return e.type;
    case "exit_out_of_range":
      return `${e.type}:${e.minutes}m`;
    case "rebalance_out_of_range":
    case "exit_engine":
      return `${e.type}:${e.minutes}m:max${e.max_rebalances}`;
    case "take_profit":
      return `take_profit:${e.pct}%${e.basis === "fee" ? ":fee" : ""}`;
    case "stop_loss":
      return `stop_loss:${e.pct}%`;
    case "trailing_tp":
      return `trailing_tp:${e.trigger_pct}/${e.drop_pct}`;
    case "tp_sl_combo":
      return `tp_sl_combo:tp${e.tp_pct ?? "-"}${e.tp_fee_pct ? `/fee${e.tp_fee_pct}` : ""}:sl${e.sl_pct}:tr${e.trigger_pct ?? "-"}/${e.drop_pct ?? "-"}${e.oor_minutes ? `:oor${e.oor_minutes}m` : ""}`;
    case "low_yield_exit":
      return `low_yield_exit:${e.min_fee_pct_per_hour}%/h:${e.window_minutes}m`;
    case "time_stop":
      return `time_stop:${e.minutes}m`;
    case "breakeven_exit":
      return `breakeven:uw${e.min_underwater_pct}%:cap${e.time_cap_minutes}m${e.target_pct ? `:t${e.target_pct}%` : ""}${e.tp_pct ? `:tp${e.tp_pct}` : ""}${e.sl_pct ? `:sl${e.sl_pct}` : ""}`;
    case "scalp":
      return `scalp:ts${e.time_stop_minutes}m:oor${e.oor_minutes}m${e.sl_pct ? `:sl${e.sl_pct}` : ""}${e.flow ? `:flow${e.flow.triggers.length === 4 ? "4" : `(${e.flow.triggers.join("+")})`}` : ""}`;
    case "flow_trigger":
      return `flow:${e.set}${e.confirm_seconds ? `:c${e.confirm_seconds}s` : ""}${e.time_stop_minutes ? `:ts${e.time_stop_minutes}m` : ""}`;
  }
}

/** Out-of-range handling of a policy, if any. */
export function oorRule(e: ScalarExitPolicy): { minutes: number; rebalance: boolean; maxRebalances: number } | null {
  switch (e.type) {
    case "exit_out_of_range":
      return { minutes: e.minutes, rebalance: false, maxRebalances: 0 };
    case "rebalance_out_of_range":
    case "exit_engine":
      return { minutes: e.minutes, rebalance: true, maxRebalances: e.max_rebalances };
    case "tp_sl_combo":
      return e.oor_minutes ? { minutes: e.oor_minutes, rebalance: false, maxRebalances: 0 } : null;
    case "scalp":
      return { minutes: e.oor_minutes, rebalance: false, maxRebalances: 0 };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ trailing take profit

export interface TrailingState {
  armed: boolean;
  peak: number;
  pendingPeak: { value: number; since: number } | null;
  pendingExit: { since: number; pnl: number } | null;
}

export const newTrailing = (): TrailingState => ({ armed: false, peak: -Infinity, pendingPeak: null, pendingExit: null });

/**
 * Trailing take profit with two-stage confirmation (addendum 2.1):
 *  - arms once PnL >= trigger; the peak only rises after a new high has held for confirm_seconds
 *    (a spike that fades does not lift the peak);
 *  - a drop >= drop_pct from the peak becomes pending; after confirm_seconds it exits if the drop
 *    still holds within tolerance (drop >= drop_pct x (1 - tolerance%)), else the pending exit is cancelled.
 * PnL values are % of capital.
 */
export function trailingStep(
  s: TrailingState,
  pnl: number,
  t: number,
  p: { trigger_pct: number; drop_pct: number; confirm_seconds: number; tolerance_pct: number },
): { state: TrailingState; exit: boolean; event?: string } {
  const st: TrailingState = { ...s };
  const confirmMs = p.confirm_seconds * 1000;
  const minDrop = p.drop_pct * (1 - p.tolerance_pct / 100);
  if (!st.armed) {
    if (pnl >= p.trigger_pct) {
      st.armed = true;
      st.peak = pnl;
      return { state: st, exit: false, event: "armed" };
    }
    return { state: st, exit: false };
  }
  // confirm new peaks
  if (pnl > st.peak) {
    if (!st.pendingPeak) st.pendingPeak = { value: pnl, since: t };
    else if (t - st.pendingPeak.since >= confirmMs) {
      if (pnl >= st.pendingPeak.value - (st.pendingPeak.value - st.peak) * (p.tolerance_pct / 100)) st.peak = Math.min(pnl, st.pendingPeak.value);
      st.pendingPeak = pnl > st.peak ? { value: pnl, since: t } : null;
    } else if (pnl > st.pendingPeak.value) st.pendingPeak = { value: pnl, since: st.pendingPeak.since };
  } else if (st.pendingPeak && t - st.pendingPeak.since >= confirmMs) st.pendingPeak = null; // the spike faded
  // drops from the confirmed peak
  const drop = st.peak - pnl;
  if (!st.pendingExit) {
    if (drop >= p.drop_pct) {
      st.pendingExit = { since: t, pnl };
      return { state: st, exit: false, event: "pending_trailing_exit" };
    }
    return { state: st, exit: false };
  }
  if (t - st.pendingExit.since < confirmMs) return { state: st, exit: false };
  if (drop >= minDrop) return { state: st, exit: true, event: "trailing_exit" };
  st.pendingExit = null;
  return { state: st, exit: false, event: "trailing_exit_cancelled" };
}

// ------------------------------------------------------------------ PnL-based decisions

export interface PnlSnapshot {
  t: number;
  netPct: number; // net PnL % of capital (value + fees - capital - costs)
  feePct: number; // fees earned, % of capital
  ageMinutes: number;
  /** fee % of capital earned per hour over the low-yield window, when the window is covered */
  feePctPerHourWindow: number | null;
  /** lowest net PnL % seen since the open (breakeven_exit: "was under water") */
  worstPct?: number;
}

/**
 * PnL policies (take profit, stop loss, trailing, combo, low yield). Returns the close reason, or
 * null to hold. `trailing` is the position's trailing state (mutated copy returned).
 */
export function pnlDecision(
  e: ScalarExitPolicy,
  x: PnlSnapshot,
  trailing: TrailingState,
): { reason: string | null; trailing: TrailingState; event?: string } {
  switch (e.type) {
    case "take_profit": {
      const v = e.basis === "fee" ? x.feePct : x.netPct;
      return { reason: v >= e.pct ? `take_profit` : null, trailing };
    }
    case "stop_loss":
      return { reason: x.netPct <= -e.pct ? "stop_loss" : null, trailing };
    case "trailing_tp": {
      const r = trailingStep(trailing, x.netPct, x.t, e);
      return { reason: r.exit ? "trailing_tp" : null, trailing: r.state, event: r.event };
    }
    case "tp_sl_combo": {
      if (x.netPct <= -e.sl_pct) return { reason: "stop_loss", trailing };
      if (e.tp_pct !== undefined && x.netPct >= e.tp_pct) return { reason: "take_profit", trailing };
      if (e.tp_fee_pct !== undefined && x.feePct >= e.tp_fee_pct) return { reason: "take_profit_fee", trailing };
      if (e.trigger_pct !== undefined && e.drop_pct !== undefined) {
        const r = trailingStep(trailing, x.netPct, x.t, { trigger_pct: e.trigger_pct, drop_pct: e.drop_pct, confirm_seconds: e.confirm_seconds, tolerance_pct: e.tolerance_pct });
        return { reason: r.exit ? "trailing_tp" : null, trailing: r.state, event: r.event };
      }
      return { reason: null, trailing };
    }
    case "time_stop":
      return { reason: x.ageMinutes >= e.minutes ? "time_stop" : null, trailing };
    case "breakeven_exit": {
      // The playbook exit: sit through the drawdown, leave when the position is back at break-even.
      // Optional TP / SL; the time cap closes whatever is left.
      if (e.sl_pct !== undefined && x.netPct <= -e.sl_pct) return { reason: "stop_loss", trailing };
      if (e.tp_pct !== undefined && x.netPct >= e.tp_pct) return { reason: "take_profit", trailing };
      if ((x.worstPct ?? x.netPct) <= -e.min_underwater_pct && x.netPct >= e.target_pct) return { reason: "breakeven", trailing };
      return { reason: x.ageMinutes >= e.time_cap_minutes ? "time_cap" : null, trailing };
    }
    case "scalp":
      if (e.sl_pct !== undefined && x.netPct <= -e.sl_pct) return { reason: "stop_loss", trailing };
      return { reason: x.ageMinutes >= e.time_stop_minutes ? "time_stop" : null, trailing };
    case "flow_trigger": // the flow part is evaluated by the grid runner (needs the flow snapshot)
      return { reason: e.time_stop_minutes !== undefined && x.ageMinutes >= e.time_stop_minutes ? "time_stop" : null, trailing };
    case "low_yield_exit":
      return {
        reason: x.ageMinutes >= e.min_age_minutes && x.feePctPerHourWindow !== null && x.feePctPerHourWindow < e.min_fee_pct_per_hour ? "low_yield" : null,
        trailing,
      };
    default:
      return { reason: null, trailing };
  }
}

export const isPnlPolicy = (e: ScalarExitPolicy) =>
  ["take_profit", "stop_loss", "trailing_tp", "tp_sl_combo", "low_yield_exit", "time_stop", "breakeven_exit", "scalp", "flow_trigger"].includes(e.type);

/** Flow exit of a policy, if any. */
export const flowExitOf = (e: ScalarExitPolicy): FlowExit | null =>
  e.type === "flow_trigger" ? e : e.type === "scalp" ? e.flow ?? null : null;
