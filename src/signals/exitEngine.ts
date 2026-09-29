import type { Config } from "../config/schema.ts";
import type { PoolTracker } from "../features/tracker.ts";
import type { PoolSimulator } from "../sim/engine.ts";
import type { VirtualPosition } from "../sim/position.ts";
import type { Signal } from "./signalEngine.ts";

export type ExitAction = "TAHAN" | "REBALANCE" | "KELUAR_SEBAGIAN" | "KELUAR";

export interface ExitDecision {
  action: ExitAction;
  reason: string;
  conditions: Record<string, unknown>;
  fraction?: number;
}

/** Everything a rule needs about one open position at time t (plain data -> unit-testable). */
export interface ExitInputs {
  t: number;
  ageMinutes: number;
  signal: Signal | null;
  /** liquidity (USD) within +-k bins now, and the maximum within the LP window before now */
  depthNow: number | null;
  depthMaxWindow: number | null;
  /** per-wallet sells of the risk token in the whale window, % of supply (largest) */
  largestSellPctSupply: number | null;
  /** position fee income over the fee window, % of capital per hour */
  feePctPerHourWindow: number | null;
  feeUsd: number;
  ilUsd: number;
  /** X value share of the position now */
  xShare: number;
}

const HOLD: ExitDecision = { action: "TAHAN", reason: "hold", conditions: {} };

/**
 * Exit engine rules (blueprint 15), evaluated in priority order; the first trigger wins.
 * Out-of-range rebalancing is handled by the grid runner (with the cost check below).
 */
export function evaluateExit(x: ExitInputs, c: Config["exit_engine"], regimeZ: number): ExitDecision {
  const s = x.signal;
  if (s && !s.safety_gate.passed) return { action: "KELUAR", reason: "gate_failed", conditions: { reasons: s.safety_gate.reasons } };
  if (x.largestSellPctSupply !== null && x.largestSellPctSupply > c.whale_sell_pct_supply) {
    return { action: "KELUAR", reason: "whale_sell", conditions: { pctSupply: x.largestSellPctSupply, windowMin: c.whale_window_minutes } };
  }
  if (x.depthNow !== null && x.depthMaxWindow && x.depthMaxWindow > 0) {
    const drop = (1 - x.depthNow / x.depthMaxWindow) * 100;
    if (drop > c.lp_withdrawal_pct) {
      const partial = c.lp_withdrawal_action === "partial";
      return {
        action: partial ? "KELUAR_SEBAGIAN" : "KELUAR",
        reason: "lp_withdrawal",
        fraction: partial ? c.partial_fraction : 1,
        conditions: { dropPct: drop, depthNow: x.depthNow, depthMax: x.depthMaxWindow, windowMin: c.lp_window_minutes },
      };
    }
  }
  if (c.regime_against && s?.regime_label === "trending_down" && x.xShare > c.regime_min_x_share) {
    return { action: "KELUAR", reason: "regime_against", conditions: { regime: s.regime_label, xShare: x.xShare, zThreshold: regimeZ } };
  }
  if (x.ageMinutes >= c.min_age_minutes) {
    if (x.ilUsd < 0 && -x.ilUsd >= c.il_min_usd && -x.ilUsd > x.feeUsd * c.il_fee_ratio) {
      return { action: "KELUAR", reason: "il_exceeds_fee", conditions: { ilUsd: x.ilUsd, feeUsd: x.feeUsd, ratio: c.il_fee_ratio } };
    }
    if (x.feePctPerHourWindow !== null && x.ageMinutes >= c.fee_window_minutes && x.feePctPerHourWindow < c.min_fee_pct_per_hour) {
      return { action: "KELUAR", reason: "low_fee_rate", conditions: { feePctPerHour: x.feePctPerHourWindow, min: c.min_fee_pct_per_hour } };
    }
  }
  return HOLD;
}

/** Gathers ExitInputs from the live objects and applies the decisions. */
export class ExitEngine {
  private feeHist = new Map<string, { ts: number; feeUsd: number }[]>();
  private lastPartial = new Map<string, number>();
  stats = { evaluated: 0, exits: 0, partials: 0, byReason: {} as Record<string, number> };

  constructor(
    private readonly c: Config,
    private readonly tracker: (pool: string) => PoolTracker | undefined,
    private readonly signal: (pool: string, t: number) => Signal | null,
    private readonly supplyUi: (pool: string, t: number) => { riskIsX: boolean; supply: number } | null,
  ) {}

  inputs(sim: PoolSimulator, p: VirtualPosition, t: number): ExitInputs {
    const e = this.c.exit_engine;
    const tr = this.tracker(p.pool);
    const v = sim.valuation(p);
    // fee rate over the window from our own history of this position
    let hist = this.feeHist.get(p.id);
    if (!hist) this.feeHist.set(p.id, (hist = []));
    hist.push({ ts: t, feeUsd: v.feeUsd });
    const cut = t - e.fee_window_minutes * 60_000;
    while (hist.length > 1 && hist[1].ts <= cut) hist.shift();
    const h0 = hist[0];
    const hours = (t - h0.ts) / 3_600_000;
    const feePct = hours >= (e.fee_window_minutes / 60) * 0.9 ? ((v.feeUsd - h0.feeUsd) / p.spec.capitalUsd / hours) * 100 : null;
    // LP depth within +-k now vs the max over the LP window
    let depthNow: number | null = null;
    let depthMax: number | null = null;
    if (tr?.snap) {
      const k = this.c.scoring.depth_bins;
      depthNow = 0;
      for (const [id, usd] of tr.depthUsd()) if (Math.abs(id - tr.snap.activeId) <= k) depthNow += usd;
      const from = t - e.lp_window_minutes * 60_000;
      for (const f of tr.fees) {
        if (f.ts < from || f.ts > t) continue;
        let d = 0;
        for (const [off, usd] of f.depthByOffset) if (Math.abs(off) <= k) d += usd;
        depthMax = Math.max(depthMax ?? 0, d);
      }
      if (depthMax !== null) depthMax = Math.max(depthMax, depthNow);
    }
    // largest single-wallet sell of the risk token within the whale window (sampled swaps)
    let largest: number | null = null;
    const sup = this.supplyUi(p.pool, t);
    const m = tr?.metrics;
    if (tr && sup && sup.supply > 0 && m) {
      const price = sup.riskIsX ? m.xUsd : m.yUsd;
      if (price) {
        const byWallet = new Map<string, number>();
        const from = t - e.whale_window_minutes * 60_000;
        for (const s of tr.swaps) {
          if (s.ts < from || s.ts > t) continue;
          const sellsRisk = sup.riskIsX ? !s.buy : s.buy;
          if (sellsRisk) byWallet.set(s.wallet, (byWallet.get(s.wallet) ?? 0) + s.usd / price);
        }
        largest = byWallet.size ? (Math.max(...byWallet.values()) / sup.supply) * 100 : 0;
      }
    }
    const st = sim.valuation(p);
    const priceUi = p.last?.priceUi ?? p.entryPriceUi;
    const xValue = (st.x / 10 ** sim.meta.decimalsX) * priceUi;
    const total = xValue + st.y / 10 ** sim.meta.decimalsY;
    return {
      t,
      ageMinutes: (t - (p.openedAt ?? t)) / 60_000,
      signal: this.signal(p.pool, t),
      depthNow,
      depthMaxWindow: depthMax,
      largestSellPctSupply: largest,
      feePctPerHourWindow: feePct,
      feeUsd: v.feeUsd,
      ilUsd: v.ilUsd,
      xShare: total > 0 ? xValue / total : 0,
    };
  }

  /** Evaluate every exit_engine position of a pool and apply the decisions. */
  run(sim: PoolSimulator, t: number) {
    if (sim.priceStale(t)) return; // price data in a gap: decide on fresh data only
    for (const p of sim.list()) {
      if (p.status !== "active" || p.spec.exitPolicy?.type !== "exit_engine") continue;
      this.stats.evaluated++;
      const d = evaluateExit(this.inputs(sim, p, t), this.c.exit_engine, this.c.scoring.regime.z_trend);
      if (d.action === "TAHAN") continue;
      // one liquidity drop must not trigger twice: wait a full LP window after a partial exit
      const lp = this.lastPartial.get(p.id);
      if (d.reason === "lp_withdrawal" && lp !== undefined && t - lp < this.c.exit_engine.lp_window_minutes * 60_000) continue;
      sim.logExitSignal(p.id, t, { action: d.action, reason: d.reason, conditions: d.conditions });
      this.stats.byReason[d.reason] = (this.stats.byReason[d.reason] ?? 0) + 1;
      if (d.action === "KELUAR") {
        sim.close(p.id, `exit_engine:${d.reason}`, t);
        this.stats.exits++;
        this.feeHist.delete(p.id);
      } else if (d.action === "KELUAR_SEBAGIAN") {
        // a second withdrawal signal on an already reduced position closes it
        if (p.partialExits >= 1) {
          sim.close(p.id, `exit_engine:${d.reason}`, t);
          this.stats.exits++;
        } else if (sim.partialClose(p.id, d.fraction ?? 0.5, `exit_engine:${d.reason}`, t)) {
          this.stats.partials++;
          this.lastPartial.set(p.id, t);
        }
      }
    }
  }
}
