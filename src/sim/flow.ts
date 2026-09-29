import type { MinuteFlow } from "../features/tracker.ts";

/**
 * Friday playbook, stage 2: one-minute flow of a pool at decision time t.
 *  - pool volume and net buy per minute come from our bin snapshots (exact, every swap);
 *  - holders and bundler holding % come from Jupiter once a minute (token level, all venues;
 *    bundlers from the unofficial datapi).
 */
export interface FlowSnapshot {
  t: number;
  /** newest first: the minute ending at t, the one before, ... */
  minutes: MinuteFlow[];
  /** true when the risk token is X (a net Y inflow = the risk token is bought) */
  riskIsX: boolean;
  tvlUsd: number | null;
  holders: { now: number; prev: number } | null;
  bundlerPct: { now: number; prev: number } | null;
}

export const FLOW_TRIGGERS = ["bundler", "net_buy", "net_buy_rel", "holders", "volume", "volume_avg3"] as const;
export type FlowTrigger = (typeof FLOW_TRIGGERS)[number];

export interface FlowThresholds {
  /** bundler holding % falls by at least this many points within a minute (Friday: 2) */
  bundler_drop_pp: number;
  /** net sell of the pool in the last minute at least this many USD (Friday: 5,000) */
  net_buy_usd: number;
  /** relative variant: net sell >= this % of the pool TVL in the last minute */
  net_buy_tvl_pct: number;
  /** holder count falls by at least this % vs a minute earlier (Friday: 10) */
  holders_drop_pct: number;
  /**
   * pool volume of the last minute at least this % below the minute before (Friday: 20);
   * volume_avg3 compares with the mean of the 3 minutes before instead (less noise)
   */
  volume_drop_pct: number;
  /** the volume trigger needs at least this much volume in the previous minute (noise guard) */
  min_prev_volume_usd: number;
}

export const FRIDAY_THRESHOLDS: FlowThresholds = {
  bundler_drop_pp: 2, net_buy_usd: 5000, net_buy_tvl_pct: 5, holders_drop_pct: 10, volume_drop_pct: 20, min_prev_volume_usd: 0,
};

/** Net buy (USD) of the risk token in a minute: Y inflow when the risk token is X, else Y outflow. */
export const netBuyUsd = (m: MinuteFlow | undefined, riskIsX: boolean): number | null =>
  !m || m.netYInUsd === null ? null : riskIsX ? m.netYInUsd : -m.netYInUsd;

/**
 * Friday's one-trigger exits. Returns the triggers that fired and those that could not be checked
 * (missing data never fires a trigger).
 */
export function flowTriggers(x: FlowSnapshot, triggers: readonly FlowTrigger[], p: FlowThresholds): { fired: FlowTrigger[]; missing: FlowTrigger[] } {
  const fired: FlowTrigger[] = [];
  const missing: FlowTrigger[] = [];
  const [cur, prev] = x.minutes;
  const nb = netBuyUsd(cur, x.riskIsX);
  for (const t of triggers) {
    switch (t) {
      case "bundler":
        if (!x.bundlerPct) missing.push(t);
        else if (x.bundlerPct.now - x.bundlerPct.prev <= -p.bundler_drop_pp) fired.push(t);
        break;
      case "net_buy":
        if (nb === null) missing.push(t);
        else if (nb <= -p.net_buy_usd) fired.push(t);
        break;
      case "net_buy_rel":
        if (nb === null || !x.tvlUsd) missing.push(t);
        else if (nb <= -(x.tvlUsd * p.net_buy_tvl_pct) / 100) fired.push(t);
        break;
      case "holders":
        if (!x.holders || x.holders.prev <= 0) missing.push(t);
        else if ((x.holders.now - x.holders.prev) / x.holders.prev <= -p.holders_drop_pct / 100) fired.push(t);
        break;
      case "volume":
        if (!cur || !prev || cur.volumeUsd === null || prev.volumeUsd === null) missing.push(t);
        else if (prev.volumeUsd > p.min_prev_volume_usd && cur.volumeUsd <= prev.volumeUsd * (1 - p.volume_drop_pct / 100)) fired.push(t);
        break;
      case "volume_avg3": {
        // noise-robust variant: the last minute vs the mean of the three minutes before it
        const before = x.minutes.slice(1, 4).map((m) => m.volumeUsd);
        if (!cur || cur.volumeUsd === null || before.length < 3 || before.some((v) => v === null)) missing.push(t);
        else {
          const avg = (before as number[]).reduce((a, b) => a + b, 0) / 3;
          if (avg > p.min_prev_volume_usd && cur.volumeUsd <= avg * (1 - p.volume_drop_pct / 100)) fired.push(t);
        }
        break;
      }
    }
  }
  return { fired, missing };
}

export interface ConfirmParams {
  /** volume rose in each of the last N minutes (Friday: "rising for 2-3 candles") */
  volume_rising_minutes: number;
  require_net_buy_positive: boolean;
  require_holders_growing: boolean;
  /** bundler % "stable or falling slowly": change within [-max_fall, +max_rise] points */
  bundler_max_rise_pp: number;
  bundler_max_fall_pp: number;
  /** a check without data: skip it (entry flagged partial) or fail the entry */
  missing: "skip" | "fail";
}

export const FRIDAY_CONFIRM: ConfirmParams = {
  volume_rising_minutes: 2, require_net_buy_positive: true, require_holders_growing: true,
  bundler_max_rise_pp: 0.5, bundler_max_fall_pp: 2, missing: "skip",
};

/** Friday's entry confirmation. Pool-level volume and net buy must be known; token data may be skipped. */
export function flowConfirm(x: FlowSnapshot, p: ConfirmParams): { pass: boolean; failed: string[]; missing: string[] } {
  const failed: string[] = [];
  const missing: string[] = [];
  const need = (name: string, ok: boolean | null, poolLevel = false) => {
    if (ok === null) {
      if (poolLevel || p.missing === "fail") failed.push(`${name}:missing`);
      else missing.push(name);
    } else if (!ok) failed.push(name);
  };
  const vols = x.minutes.slice(0, p.volume_rising_minutes + 1).map((m) => m.volumeUsd);
  const volOk = vols.length < p.volume_rising_minutes + 1 || vols.some((v) => v === null)
    ? null
    : vols.every((v, i) => i === vols.length - 1 || (v as number) > (vols[i + 1] as number));
  need("volume_rising", volOk, true);
  if (p.require_net_buy_positive) {
    const nb = netBuyUsd(x.minutes[0], x.riskIsX);
    need("net_buy_positive", nb === null ? null : nb > 0, true);
  }
  if (p.require_holders_growing) need("holders_growing", x.holders ? x.holders.now > x.holders.prev : null);
  const d = x.bundlerPct ? x.bundlerPct.now - x.bundlerPct.prev : null;
  need("bundler_stable", d === null ? null : d <= p.bundler_max_rise_pp && d >= -p.bundler_max_fall_pp);
  return { pass: failed.length === 0, failed, missing };
}
