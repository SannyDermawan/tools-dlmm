import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { PoolSimulator } from "../sim/engine.ts";
import { binsForRangePct, binsForUpPct } from "../sim/distribution.ts";
import { baseFeePct } from "../sim/friday.ts";
import { exitPolicyLabel, type ScalarExitPolicy } from "../sim/policies.ts";
import { estimateCycleTransactions, type EntryTrigger, type EntryVerdict, type ExitContext, type ModuleEnv, type PreviousCycle, type RangeContext, type RangePlan, type StrategyModule } from "./types.ts";

const presetSchema = z
  .object({
    screen: z
      .object({
        min_session_minutes: z.number().nonnegative(),
        min_token_age_hours: z.number().nonnegative(),
        categories: z.array(z.string()),
        min_token_volume_24h_usd: z.number().nonnegative().nullable(),
        min_tvl_usd: z.number().nonnegative().nullable(),
        fail_on_mint_authority: z.boolean(),
        fail_on_freeze_authority: z.boolean(),
        missing_security: z.enum(["skip", "ignore"]),
        missing_data: z.enum(["skip", "ignore"]),
      })
      .strict(),
    range: z.object({ shape: z.enum(["spot", "curve", "bidask"]), downside_pct: z.number().positive().max(99), upside_pct: z.number().positive() }).strict(),
    exit: z.object({ bounce_pct: z.number().positive(), require_profit: z.boolean(), time_cap_minutes: z.number().positive() }).strict(),
    reentry: z.object({ cooldown_minutes: z.number().nonnegative(), max_cycles_per_pool: z.number().int().positive() }).strict(),
  })
  .strict();

export type EvilPandaPreset = z.infer<typeof presetSchema>;

export function loadEvilPandaPreset(path: string, baseDir = process.cwd()): EvilPandaPreset {
  return presetSchema.parse(YAML.parse(readFileSync(resolve(baseDir, path), "utf8")));
}

export interface EvilPandaInputs {
  sessionMinutes: number;
  category: string;
  tokenAgeHours: number | null;
  volume24hUsd: number | null;
  tvlUsd: number | null;
  /** risk token authorities; null = no security row yet */
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
}

/** Coin selection: the failed checks (empty = pass); `:no_data` when an input was missing and the rule is set to skip. */
export function evaluateEvilPanda(pr: EvilPandaPreset, x: EvilPandaInputs): string[] {
  const s = pr.screen;
  const failed: string[] = [];
  if (x.sessionMinutes < s.min_session_minutes) failed.push("session_too_short");
  if (s.categories.length && !s.categories.includes(x.category)) failed.push("category");
  const need = (name: string, v: number | null, ok: (v: number) => boolean) => {
    if (v === null) {
      if (s.missing_data === "skip") failed.push(`${name}:no_data`);
    } else if (!ok(v)) failed.push(name);
  };
  need("token_age", x.tokenAgeHours, (v) => v >= s.min_token_age_hours);
  if (s.min_token_volume_24h_usd !== null) need("token_volume_24h", x.volume24hUsd, (v) => v >= s.min_token_volume_24h_usd!);
  if (s.min_tvl_usd !== null) need("tvl", x.tvlUsd, (v) => v >= s.min_tvl_usd!);
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

/** The risk token's % move off its low: the price of the risk token, whichever side of the pool it is on. */
export function bounceFromLowPct(riskIsBase: boolean, low: number, price: number): number {
  const p = riskIsBase ? price : 1 / price;
  return (p / low - 1) * 100;
}

/**
 * evil_panda (@EvilPanda playbook, from a summary): coin selection first (token at least 48 h old with
 * volume, no authorities), then a two-sided Bid-Ask 90 % below and 100 % above the price that sits for
 * up to 3 days; closed in profit when the token bounces off its low (or after the time cap). One position
 * per pool at a time. The bounce rule is a module exit; the time cap is the plan's exit policy.
 */
export function evilPandaModule(pr: EvilPandaPreset, env: ModuleEnv): StrategyModule {
  const exitPolicy: ScalarExitPolicy = { type: "time_stop", minutes: pr.exit.time_cap_minutes };
  /** lowest risk-token price seen since each position's open (the module is the only reader) */
  const lows = new Map<string, number>();
  return {
    id: "evil_panda",
    entryMode: "evil_panda",
    statsKey: "evilPanda",
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
      const fi = env.signals.fridayInputs?.(pool, ts) ?? null;
      if (!ti || !fi) return null;
      const failed = evaluateEvilPanda(pr, {
        sessionMinutes: env.sessionMinutes ?? env.c.session.duration_minutes, category: sim.meta.category,
        tokenAgeHours: ti.tokenAgeHours, volume24hUsd: ti.volume24hUsd ?? null, tvlUsd: fi.tvlUsd,
        mintAuthority: fi.mintAuthority, freezeAuthority: fi.freezeAuthority,
      });
      return { failed, missing: [] };
    },
    calculateRange(sim: PoolSimulator, _ts: number, ctx: RangeContext): RangePlan {
      const below = binsForRangePct(pr.range.downside_pct, sim.meta.binStep);
      const above = binsForUpPct(pr.range.upside_pct, sim.meta.binStep);
      return {
        strategy: pr.range.shape, sides: "two_sided", binsBelow: below, binsAbove: above, exitPolicy,
        combo: {
          strategy: pr.range.shape, bins_per_side: below, sides: "two_sided", range_pct: pr.range.downside_pct, up_pct: pr.range.upside_pct,
          exit_policy: `bounce${pr.exit.bounce_pct}%+${exitPolicyLabel(exitPolicy)}`, variant: "none", cycle_no: ctx.n, reentry: ctx.hasPrevious, at_cohort: ctx.trigger !== "reentry",
          base_fee_pct: baseFeePct(sim.meta), collect_fee_mode: sim.meta.collectFeeMode,
        },
      };
    },
    evaluateExit(x: ExitContext): string | null {
      const price = x.sim.priceUi;
      if (!price || price <= 0) return null;
      const riskIsBase = env.signals.tokenInfo?.(x.sim.meta.pool, x.ts)?.riskIsBase ?? true;
      const seen = riskIsBase ? price : 1 / price;
      const low = Math.min(lows.get(x.p.id) ?? seen, seen);
      lows.set(x.p.id, low);
      if (pr.exit.require_profit && x.netPct <= 0) return null;
      const bounce = bounceFromLowPct(riskIsBase, low, price);
      if (bounce < pr.exit.bounce_pct) return null;
      x.sim.logExitSignal(x.p.id, x.ts, { action: "KELUAR", reason: "evil_panda_bounce", bouncePct: bounce, pnlPct: x.netPct });
      lows.delete(x.p.id);
      return "evil_panda_bounce";
    },
    estimateTransactions: (plan) => estimateCycleTransactions(env.c, plan),
  };
}
