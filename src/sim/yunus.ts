import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { exitPolicySchema, STRATEGIES, type ExitPolicy, type Strategy } from "../config/schema.ts";
import type { FlipSpec } from "./position.ts";
import { expandExitPolicies, type ScalarExitPolicy } from "./policies.ts";
import { downsideFromAthAnchor } from "../features/ath.ts";

const optNum = z.number().min(0).nullable();
const shape = z.enum(STRATEGIES);

const presetSchema = z
  .object({
    screen: z
      .object({
        min_tvl_usd: optNum,
        min_mcap_usd: optNum,
        min_token_age_hours: optNum,
        max_token_age_hours: optNum,
        min_ath_drawdown_pct: optNum,
        max_ath_drawdown_pct: optNum,
        fail_on_mint_authority: z.boolean(),
        fail_on_freeze_authority: z.boolean(),
        missing_security: z.enum(["skip", "allow"]),
      })
      .strict(),
    entry: z
      .object({
        shape,
        range_pct: z.array(z.number().gt(0).lt(100)).min(1),
        anchor: z.array(z.enum(["price", "ath"])).min(1),
        min_downside_pct: z.number().min(0),
      })
      .strict(),
    flip: z
      .object({
        up_pct: z.number().gt(0),
        max_flips: z.number().int().min(1),
        shapes: z
          .array(
            z
              .object({
                name: z.string().min(1),
                shape,
                blend: z.object({ strategy: shape, share: z.number().gt(0).lt(1) }).strict().optional(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    exit: z.object({ policies: z.array(exitPolicySchema).min(1) }).strict(),
    reentry: z.object({ cooldown_minutes: z.number().min(0), max_cycles_per_pool: z.number().int().min(1) }).strict(),
  })
  .strict();

export type YunusPreset = z.infer<typeof presetSchema>;

export function loadYunusPreset(path: string, baseDir = process.cwd()): YunusPreset {
  return presetSchema.parse(YAML.parse(readFileSync(resolve(baseDir, path), "utf8")));
}

/** One grid level of the mode: initial width, anchor, flip shape and exit policy. */
export interface YunusCombo {
  key: string;
  widthPct: number;
  anchor: "price" | "ath";
  flipName: string;
  flip: FlipSpec;
  exit: ScalarExitPolicy;
  exitLabel: string;
}

export function yunusCombos(pr: YunusPreset, exitLabel: (e: ScalarExitPolicy) => string): YunusCombo[] {
  const exits = expandExitPolicies(pr.exit.policies as ExitPolicy[]);
  const out: YunusCombo[] = [];
  for (const widthPct of pr.entry.range_pct)
    for (const anchor of pr.entry.anchor)
      for (const f of pr.flip.shapes)
        for (const exit of exits) {
          const label = exitLabel(exit);
          out.push({
            key: `${widthPct}|${anchor}|${f.name}|${label}`,
            widthPct, anchor, flipName: f.name, exit, exitLabel: label,
            flip: { shape: f.shape as Strategy, blend: f.blend ? { strategy: f.blend.strategy as Strategy, share: f.blend.share } : null, upPct: pr.flip.up_pct, maxFlips: pr.flip.max_flips },
          });
        }
  return out;
}

export interface YunusInputs {
  tvlUsd: number | null;
  /** risk token authorities; null = no security row yet */
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  mcapUsd: number | null;
  tokenAgeHours: number | null;
  /** % below the highest price we can see, null without OHLCV history */
  athDrawdownPct: number | null;
}

/** Pool / token screen: the failed rules (empty = passed). A rule with a null threshold is not applied. */
export function evaluateYunus(pr: YunusPreset, x: YunusInputs): string[] {
  const s = pr.screen;
  const failed: string[] = [];
  const need = (name: string, v: number | null, ok: (v: number) => boolean) => {
    if (v === null) failed.push(`${name}:no_data`);
    else if (!ok(v)) failed.push(name);
  };
  if (s.min_tvl_usd !== null) need("tvl", x.tvlUsd, (v) => v >= s.min_tvl_usd!);
  if (s.min_mcap_usd !== null) need("mcap", x.mcapUsd, (v) => v >= s.min_mcap_usd!);
  if (s.min_token_age_hours !== null) need("token_age_min", x.tokenAgeHours, (v) => v >= s.min_token_age_hours!);
  if (s.max_token_age_hours !== null) need("token_age_max", x.tokenAgeHours, (v) => v <= s.max_token_age_hours!);
  if (s.min_ath_drawdown_pct !== null) need("ath_drawdown_min", x.athDrawdownPct, (v) => v >= s.min_ath_drawdown_pct!);
  if (s.max_ath_drawdown_pct !== null) need("ath_drawdown_max", x.athDrawdownPct, (v) => v <= s.max_ath_drawdown_pct!);
  for (const [name, on, v] of [
    ["mint_authority", s.fail_on_mint_authority, x.mintAuthority],
    ["freeze_authority", s.fail_on_freeze_authority, x.freezeAuthority],
  ] as const) {
    if (!on) continue;
    if (v === null) {
      if (s.missing_security === "skip") failed.push(`${name}:no_data`);
    } else if (v) failed.push(name);
  }
  return failed;
}

/**
 * Downside (%) of the initial range for a combo: from the price itself, or from the ATH (bottom =
 * ATH x (1 - pct)). Null with the reason when the combo cannot be placed here.
 */
export function yunusDownside(pr: YunusPreset, c: YunusCombo, price: number | null, ath: number | null): { pct: number } | { skip: string } {
  if (c.anchor === "price") return { pct: c.widthPct };
  if (price === null || ath === null) return { skip: "ath:no_data" };
  const d = downsideFromAthAnchor(price, ath, c.widthPct);
  if (d === null) return { skip: "ath:price_below_anchor" };
  if (d < pr.entry.min_downside_pct) return { skip: "ath:thin_range" };
  return { pct: d };
}
