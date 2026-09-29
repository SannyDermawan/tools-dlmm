import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { PoolMeta } from "../collectors/types.ts";
import { baseFeeNumerator } from "../math/fee.ts";
import type { ScalarExitPolicy } from "./policies.ts";
import { FLOW_TRIGGERS } from "./flow.ts";

const presetSchema = z
  .object({
    pool_filter: z
      .object({
        bin_steps: z.array(z.number().int().min(1)).min(1),
        base_fee_pct: z.array(z.number().positive()).min(1),
        max_age_minutes: z.number().positive(),
        min_tvl_usd: z.number().min(0),
      })
      .strict(),
    safety: z
      .object({
        fail_on_mint_authority: z.boolean(),
        fail_on_freeze_authority: z.boolean(),
        missing_security: z.enum(["skip", "allow"]),
      })
      .strict(),
    strategy: z
      .object({
        shape: z.enum(["spot", "curve", "bidask"]),
        sides: z.enum(["two_sided", "quote_only", "base_only"]),
        bins_per_side: z.number().int().min(1),
      })
      .strict(),
    exit: z.object({ time_stop_minutes: z.number().positive(), oor_minutes: z.number().min(0) }).strict(),
    flow_exit: z
      .object({
        triggers: z.array(z.enum(FLOW_TRIGGERS)).min(1),
        bundler_drop_pp: z.number().min(0),
        net_buy_usd: z.number().min(0),
        net_buy_tvl_pct: z.number().min(0),
        holders_drop_pct: z.number().min(0),
        volume_drop_pct: z.number().min(0),
        min_prev_volume_usd: z.number().min(0),
        confirm_seconds: z.number().min(0),
      })
      .strict(),
    entry_confirm: z
      .object({
        enabled: z.boolean(),
        volume_rising_minutes: z.number().int().min(1),
        require_net_buy_positive: z.boolean(),
        require_holders_growing: z.boolean(),
        bundler_max_rise_pp: z.number().min(0),
        bundler_max_fall_pp: z.number().min(0),
        missing: z.enum(["skip", "fail"]),
      })
      .strict(),
    reentry: z.object({ minutes: z.number().min(0), max_trades_per_pool: z.number().int().min(1) }).strict(),
  })
  .strict();

export type FridayPreset = z.infer<typeof presetSchema>;

export function loadFridayPreset(path: string, baseDir = process.cwd()): FridayPreset {
  return presetSchema.parse(YAML.parse(readFileSync(resolve(baseDir, path), "utf8")));
}

export const fridayExitPolicy = (p: FridayPreset): ScalarExitPolicy => ({
  type: "scalp", time_stop_minutes: p.exit.time_stop_minutes, oor_minutes: p.exit.oor_minutes, flow: p.flow_exit,
});

/** Base fee of a pool in % (base_factor x bin_step x 10 x 10^power / 1e9). */
export const baseFeePct = (m: PoolMeta) => (Number(baseFeeNumerator(m.fee)) / 1e9) * 100;

export interface FridayInputs {
  tvlUsd: number | null;
  /** risk token authorities; null = no security row yet */
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
}

/**
 * Parts of the playbook not simulated: none since stage 2. A position is still preset_partial when
 * a flow input was missing at entry (e.g. bundlers without the datapi).
 */
export const FRIDAY_NOT_YET: string[] = [];

/**
 * Friday's pool screen: bin step and base fee from the pool, age from the pool's creation time,
 * LP depth (TVL) and the risk token's authorities. Returns the failed checks (empty = pass).
 */
export function evaluateFriday(p: FridayPreset, m: PoolMeta, x: FridayInputs, t: number): string[] {
  const f = p.pool_filter;
  const failed: string[] = [];
  if (m.category !== "memecoin") failed.push("category");
  if (!f.bin_steps.includes(m.binStep)) failed.push("bin_step");
  const fee = baseFeePct(m);
  if (!f.base_fee_pct.some((v) => Math.abs(v - fee) < 1e-6)) failed.push("base_fee");
  if (!m.createdAt || t - m.createdAt > f.max_age_minutes * 60_000 || t < m.createdAt) failed.push("age");
  if (x.tvlUsd === null || x.tvlUsd < f.min_tvl_usd) failed.push("tvl");
  const s = p.safety;
  if (x.mintAuthority === null || x.freezeAuthority === null) {
    if (s.missing_security === "skip") failed.push("security_missing");
  } else {
    if (s.fail_on_mint_authority && x.mintAuthority) failed.push("mint_authority");
    if (s.fail_on_freeze_authority && x.freezeAuthority) failed.push("freeze_authority");
  }
  return failed;
}
