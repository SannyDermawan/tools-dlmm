import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { PoolSimulator } from "../sim/engine.ts";
import { binsForRangePct } from "../sim/distribution.ts";
import { evaluateMeridian, feeWindowMinutes, meridianExitPolicy, type MeridianPreset } from "../sim/meridian.ts";
import { exitPolicyLabel, type ScalarExitPolicy } from "../sim/policies.ts";
import { baseFeePct } from "../sim/friday.ts";
import { macdHistSeries, pctBSeries, rsiSeries, supertrendSeries, type Candle } from "../features/indicators.ts";
import { estimateCycleTransactions, type EntryTrigger, type EntryVerdict, type ExitContext, type ModuleEnv, type PreviousCycle, type RangeContext, type RangePlan, type StrategyModule } from "./types.ts";

const presetSchema = z
  .object({
    screen: z
      .object({
        min_token_volume_24h_usd: z.number().nonnegative(),
        min_mcap_usd: z.number().nonnegative(),
        require_risk_token_base: z.boolean(),
        supertrend: z.object({ timeframe: z.enum(["5m", "15m", "30m", "1h"]), period: z.number().int().positive(), multiplier: z.number().positive() }).strict(),
        meridian_screen: z.boolean(),
        min_token_fees_sol: z.number().nonnegative().nullable(),
        max_top10_pct: z.number().positive().nullable(),
        missing_data: z.enum(["skip", "ignore"]),
      })
      .strict(),
    range: z.object({ shape: z.enum(["spot", "curve", "bidask"]), downside_pct: z.number().positive().max(99) }).strict(),
    exit: z
      .object({
        timeframe: z.enum(["5m", "15m", "30m", "1h"]),
        require_profit: z.boolean(),
        rsi_period: z.number().int().positive(),
        rsi_above: z.number().min(0).max(100),
        bb_period: z.number().int().positive(),
        bb_k: z.number().positive(),
        macd: z.object({ fast: z.number().int().positive(), slow: z.number().int().positive(), signal: z.number().int().positive() }).strict(),
        meridian_exits: z.boolean(),
      })
      .strict(),
    reentry: z.object({ cooldown_minutes: z.number().nonnegative(), max_cycles_per_pool: z.number().int().positive() }).strict(),
  })
  .strict();

export type RoyalmandPreset = z.infer<typeof presetSchema>;

export function loadRoyalmandPreset(path: string, baseDir = process.cwd()): RoyalmandPreset {
  return presetSchema.parse(YAML.parse(readFileSync(resolve(baseDir, path), "utf8")));
}

export interface RoyalmandInputs {
  volume24hUsd: number | null;
  mcapUsd: number | null;
  riskIsBase: boolean | null;
  tokenFeesSol: number | null;
  top10Pct: number | null;
  /** the Supertrend's candles of the screen timeframe, oldest first (complete candles only) */
  supertrendCandles: Candle[];
  /** failed checks of the Meridian screen (null = no Meridian inputs) */
  meridianFailed: string[] | null;
}

/** The entry screen: failed checks (empty = pass); `:no_data` when an input was missing and missing_data is skip. */
export function evaluateRoyalmand(pr: RoyalmandPreset, x: RoyalmandInputs): string[] {
  const s = pr.screen;
  const failed: string[] = [];
  const need = (name: string, v: number | null, ok: (v: number) => boolean) => {
    if (v === null) {
      if (s.missing_data === "skip") failed.push(`${name}:no_data`);
    } else if (!ok(v)) failed.push(name);
  };
  if (s.require_risk_token_base) {
    if (x.riskIsBase === null) failed.push("risk_token_base:no_data");
    else if (!x.riskIsBase) failed.push("risk_token_not_base");
  }
  need("token_volume_24h", x.volume24hUsd, (v) => v >= s.min_token_volume_24h_usd);
  need("mcap", x.mcapUsd, (v) => v >= s.min_mcap_usd);
  if (s.min_token_fees_sol !== null) need("token_fees", x.tokenFeesSol, (v) => v >= s.min_token_fees_sol!);
  if (s.max_top10_pct !== null) need("top10", x.top10Pct, (v) => v <= s.max_top10_pct!);
  // green Supertrend with the price above it: direction up on the last complete candle
  const st = supertrendSeries(x.supertrendCandles, s.supertrend.period, s.supertrend.multiplier);
  const dir = st.length ? st[st.length - 1] : null;
  if (dir === null) failed.push("supertrend:no_data");
  else if (dir !== 1) failed.push("supertrend_red");
  if (s.meridian_screen) {
    if (x.meridianFailed === null) failed.push("meridian:no_data");
    else for (const f of x.meridianFailed) failed.push(`meridian:${f}`);
  }
  return failed;
}

/**
 * The fork's exit confluence on complete candles: RSI(n) > rsi_above AND (the close above the
 * upper Bollinger band OR the MACD histogram turned green on the last bar). Null = not enough candles.
 */
export function royalmandExitSignal(pr: RoyalmandPreset, cs: Candle[]): { fire: boolean; rsi: number | null; aboveBand: boolean; macdTurnedGreen: boolean } | null {
  const e = pr.exit;
  const closes = cs.map((c) => c.c);
  if (closes.length < Math.max(e.bb_period, e.macd.slow + e.macd.signal, e.rsi_period + 1) + 1) return null;
  const rsi = rsiSeries(closes, e.rsi_period).at(-1) ?? null;
  const pb = pctBSeries(closes, e.bb_period, e.bb_k).at(-1) ?? null;
  const h = macdHistSeries(closes, e.macd.fast, e.macd.slow, e.macd.signal);
  const last = h.at(-1) ?? null;
  const prev = h.at(-2) ?? null;
  const aboveBand = pb !== null && pb > 1;
  const macdTurnedGreen = last !== null && prev !== null && last > 0 && prev <= 0;
  return { fire: rsi !== null && rsi > e.rsi_above && (aboveBand || macdTurnedGreen), rsi, aboveBand, macdTurnedGreen };
}

const BARS = 80; // enough for MACD(12, 26, 9), Bollinger(20), RSI and the Supertrend warm-up

/**
 * royalmand: the policy the Meridian fork calls `evil_panda` in its code (the fork author's own, not
 * the @EvilPanda playbook, which is entry mode evil_panda): single-sided SOL Spot 80 % below the price in a pool
 * whose token passes the screen; exits on the indicator confluence while in profit, plus Meridian's
 * exit policy. One position at a time per pool; a new one cooldown_minutes after the close.
 */
export function royalmandModule(pr: RoyalmandPreset, meridian: MeridianPreset | null, env: ModuleEnv): StrategyModule {
  const meridianExit: ScalarExitPolicy = pr.exit.meridian_exits && meridian ? meridianExitPolicy(meridian) : { type: "hold_to_session_end" };
  const win = meridian ? feeWindowMinutes(meridian) : 0;
  return {
    id: "royalmand",
    entryMode: "royalmand",
    statsKey: "royalmand",
    planKeys: () => ["main"],
    evaluateReentry(prev: PreviousCycle | null, ts: number, trigger: EntryTrigger) {
      if (!prev) return { ok: trigger !== "reentry", reentry: false };
      const p = prev.position;
      if (p && (p.status === "active" || p.status === "pending")) return { ok: false, reentry: true };
      if (prev.n >= pr.reentry.max_cycles_per_pool) return { ok: false, reentry: true };
      const since = p?.closedAt ?? p?.requestedAt ?? 0;
      return { ok: ts - since >= pr.reentry.cooldown_minutes * 60_000, reentry: true };
    },
    evaluateEntry(sim: PoolSimulator, ts: number): EntryVerdict | null {
      const pool = sim.meta.pool;
      const ti = env.signals.tokenInfo?.(pool, ts) ?? null;
      if (!ti) return null;
      let meridianFailed: string[] | null = null;
      if (pr.screen.meridian_screen && meridian) {
        const x = env.signals.presetInputs?.(pool, ts, sim, win) ?? null;
        if (x) {
          const ev = evaluateMeridian(meridian, x);
          meridianFailed = ev.pass ? [] : ev.failed;
        }
      }
      const failed = evaluateRoyalmand(pr, {
        volume24hUsd: ti.volume24hUsd ?? null, mcapUsd: ti.mcapUsd, riskIsBase: ti.riskIsBase ?? null, tokenFeesSol: ti.tokenFeesSol ?? null,
        top10Pct: ti.top10Pct ?? null, supertrendCandles: env.signals.candles?.(pool, ts, pr.screen.supertrend.timeframe, BARS) ?? [], meridianFailed,
      });
      return { failed, missing: [] };
    },
    calculateRange(sim: PoolSimulator, _ts: number, ctx: RangeContext): RangePlan {
      const bins = binsForRangePct(pr.range.downside_pct, sim.meta.binStep);
      return {
        strategy: pr.range.shape, sides: "quote_only", binsBelow: bins, binsAbove: 0, exitPolicy: meridianExit,
        combo: {
          strategy: pr.range.shape, bins_per_side: bins, sides: "quote_only", range_pct: pr.range.downside_pct,
          exit_policy: `royalmand_confluence+${exitPolicyLabel(meridianExit)}`, variant: "none", cycle_no: ctx.n, reentry: ctx.hasPrevious, at_cohort: ctx.trigger !== "reentry",
          base_fee_pct: baseFeePct(sim.meta), collect_fee_mode: sim.meta.collectFeeMode,
        },
      };
    },
    evaluateExit(x: ExitContext): string | null {
      if (pr.exit.require_profit && x.netPct <= 0) return null;
      const cs = env.signals.candles?.(x.sim.meta.pool, x.ts, pr.exit.timeframe, BARS) ?? [];
      const sig = royalmandExitSignal(pr, cs);
      if (!sig?.fire) return null;
      x.sim.logExitSignal(x.p.id, x.ts, { action: "KELUAR", reason: "royalmand_confluence", rsi: sig.rsi, aboveBand: sig.aboveBand, macdTurnedGreen: sig.macdTurnedGreen, pnlPct: x.netPct });
      return "royalmand_confluence";
    },
    estimateTransactions: (plan) => estimateCycleTransactions(env.c, plan),
  };
}
