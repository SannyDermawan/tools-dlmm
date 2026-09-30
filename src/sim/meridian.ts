import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { ScalarExitPolicy } from "./policies.ts";

const num = z.number();
const optNum = z.number().min(0).nullable();
const presetSchema = z
  .object({
    pool_filter: z
      .object({
        min_fee_active_tvl_pct: num,
        fee_window: z.string().regex(/^\d+m$/),
        min_tvl_usd: num,
        max_tvl_usd: num,
        min_volume_usd: num,
        min_bin_step: num,
        max_bin_step: num,
        // Upstream Meridian (fciaf420/meridian, read 2026-09-30) also screens these; ours were
        // missing them. null = off (older presets keep working without setting them).
        max_volatility: optNum,       // config.js `maxVolatility` (unit: their volatility feature,
                                       // not necessarily ours -- see volatilityPct() below)
        max_price_change_pct: optNum, // config.js `maxPriceChangePct` over `fee_window`
        min_token_fees_sol: optNum,   // config.js `minTokenFeesSol`: total gas the token's traders have
                                       // paid, all-time (datapi `fees_sol`); low -> bundled/spam suspicion
        min_bin_utilization: optNum,  // share of bins in [lower,upper] with supply > 0 (Mantis
                                       // MIN_BIN_UTILIZATION); low -> liquidity clumped, IL model breaks
      })
      .strict(),
    token_filter: z
      .object({
        min_organic: num,
        min_holders: num,
        min_mcap_usd: num,
        max_mcap_usd: num,
        max_top10_pct: num,
        max_bot_holders_pct: num,
      })
      .strict(),
    strategy: z
      .object({
        shape: z.enum(["spot", "curve", "bidask"]),
        sides: z.enum(["two_sided", "quote_only", "base_only"]),
        bins_below: z.number().int().min(0),
        min_bins_below: z.number().int().min(0),
      })
      .strict(),
    exit: z
      .object({
        sl_pct: num.positive(),
        tp_fee_pct: num.positive(),
        trigger_pct: num.positive(),
        drop_pct: num.positive(),
        confirm_seconds: num.min(0),
        tolerance_pct: num.min(0),
        oor_minutes: num.positive(),
      })
      .strict(),
    ranking: z.object({ top_n: z.number().int().min(1) }).strict(),
  })
  .strict();

export type MeridianPreset = z.infer<typeof presetSchema>;

export function loadMeridianPreset(path: string, baseDir = process.cwd()): MeridianPreset {
  const raw = YAML.parse(readFileSync(resolve(baseDir, path), "utf8"));
  return presetSchema.parse(raw);
}

/** The preset's exit rules as one tp_sl_combo policy. */
export function meridianExitPolicy(p: MeridianPreset): ScalarExitPolicy {
  const e = p.exit;
  return {
    type: "tp_sl_combo", sl_pct: e.sl_pct, tp_fee_pct: e.tp_fee_pct, trigger_pct: e.trigger_pct, drop_pct: e.drop_pct,
    confirm_seconds: e.confirm_seconds, tolerance_pct: e.tolerance_pct, oor_minutes: e.oor_minutes,
  };
}

export const feeWindowMinutes = (p: MeridianPreset) => Number(p.pool_filter.fee_window.replace("m", ""));

/** What the preset looks at for one pool at one time; null = not available in our data (yet). */
export interface PresetInputs {
  feeActiveTvlPct: number | null; // fee over the fee window / liquidity near the active bin, %
  tvlUsd: number | null;
  volumeUsd: number | null; // over the fee window
  binStep: number;
  organic: number | null; // Jupiter organic score (phase 10)
  holders: number | null;
  mcapUsd: number | null;
  top10Pct: number | null;
  botHoldersPct: number | null; // Jupiter audit (phase 10)
  /** true for pools whose risk side is a bluechip / stable: token filters do not apply */
  bluechip: boolean;
  /** realized price volatility over the fee window (stddev of log returns, %; our own proxy --
   *  not a port of Meridian's internal `maxVolatility`, whose exact units are undocumented) */
  volatilityPct: number | null;
  /** |price change| over the fee window, % */
  priceChangePct: number | null;
  /** total gas the token's traders have paid, all-time (datapi, SOL; unverified unit) */
  tokenFeesSol: number | null;
  /** share of bins in [lower, upper] with supply > 0 at the latest snapshot */
  binUtilization: number | null;
}

export interface PresetEvaluation {
  pass: boolean;
  failed: string[];
  /** token filters that could not be checked: the result is 'preset_parsial' */
  missing: string[];
  score: number;
}

/**
 * Meridian default screen (addendum 2.3). Pool filters need data (missing -> fail); token filters
 * with missing data are skipped and reported in `missing` (-> preset_parsial). Ranking:
 * fee_tvl x 1000 + organic x 10 + volume / 100 + holders / 100 (missing parts count as 0).
 */
export function evaluateMeridian(p: MeridianPreset, x: PresetInputs): PresetEvaluation {
  const failed: string[] = [];
  const missing: string[] = [];
  const pf = p.pool_filter;
  const tf = p.token_filter;
  const need = (name: string, v: number | null, ok: (v: number) => boolean) => {
    if (v === null) failed.push(`${name}:missing`);
    else if (!ok(v)) failed.push(name);
  };
  const tok = (name: string, v: number | null, ok: (v: number) => boolean) => {
    if (x.bluechip) return;
    if (v === null) missing.push(name);
    else if (!ok(v)) failed.push(name);
  };
  need("fee_active_tvl", x.feeActiveTvlPct, (v) => v >= pf.min_fee_active_tvl_pct);
  need("tvl", x.tvlUsd, (v) => v >= pf.min_tvl_usd && v <= pf.max_tvl_usd);
  need("volume", x.volumeUsd, (v) => v >= pf.min_volume_usd);
  need("bin_step", x.binStep, (v) => v >= pf.min_bin_step && v <= pf.max_bin_step);
  // Optional pool-quality filters (null = off; presets before 2026-09-30 keep working unchanged).
  if (pf.max_volatility !== null) need("volatility", x.volatilityPct, (v) => v <= pf.max_volatility!);
  if (pf.max_price_change_pct !== null) need("price_change", x.priceChangePct, (v) => Math.abs(v) <= pf.max_price_change_pct!);
  if (pf.min_token_fees_sol !== null) need("token_fees_sol", x.tokenFeesSol, (v) => v >= pf.min_token_fees_sol!);
  if (pf.min_bin_utilization !== null) need("bin_utilization", x.binUtilization, (v) => v >= pf.min_bin_utilization!);
  tok("organic", x.organic, (v) => v >= tf.min_organic);
  tok("holders", x.holders, (v) => v >= tf.min_holders);
  tok("mcap", x.mcapUsd, (v) => v >= tf.min_mcap_usd && v <= tf.max_mcap_usd);
  tok("top10", x.top10Pct, (v) => v <= tf.max_top10_pct);
  tok("bot_holders", x.botHoldersPct, (v) => v <= tf.max_bot_holders_pct);
  const score = (x.feeActiveTvlPct ?? 0) * 1000 + (x.organic ?? 0) * 10 + (x.volumeUsd ?? 0) / 100 + (x.holders ?? 0) / 100;
  return { pass: failed.length === 0, failed, missing, score };
}
