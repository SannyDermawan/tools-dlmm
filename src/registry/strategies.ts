import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";

/**
 * Strategy registry (roadmap PHASE 1): what each strategy is, where it comes from, how well we know
 * the original, and what it costs a small account. The data lives in registry/strategies.yaml; this
 * module validates it and checks it against the grid's entry modes.
 */

const text = z.string().min(1);
const sourceSchema = z
  .object({
    name: text,
    url: z.string().url().nullable(),
    verified: z.enum(["source_code", "summary_only", "internal"]),
  })
  .strict();

const rulesSchema = z
  .object({ entry: text, filters: text, side: text, range: text, exits: text, rebalance: text, reentry: text })
  .strict();

const strategySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    name: text,
    kind: z.enum(["internal", "external"]),
    status: z.enum(["implemented", "candidate", "reference", "excluded"]),
    entry_mode: z.string().nullable(),
    source: sourceSchema,
    fidelity: z.enum(["faithful", "interpretation", "not_implemented", "n/a"]),
    rules: rulesSchema,
    /** original vs implemented, one line per deviation (PHASE 2 will make this one row per component) */
    original_vs_implemented: z.array(text).default([]),
    transaction_profile: z.object({ churn: z.enum(["low", "medium", "high"]), notes: text }).strict(),
    capital_sensitivity: z.object({ fixed_cost_exposure: z.enum(["low", "medium", "high"]), notes: text }).strict(),
    evidence: z.array(text),
  })
  .strict();

const registrySchema = z
  .object({
    universe: z.object({ version: text, frozen: z.boolean(), updated: text, note: text }).strict(),
    sources: z
      .array(
        z
          .object({ id: text, url: z.string().url(), kind: text, relation: text, read: text, notes: text })
          .strict(),
      )
      .min(1),
    strategies: z.array(strategySchema).min(1),
  })
  .strict();

export type StrategyRegistry = z.infer<typeof registrySchema>;
export type RegistryStrategy = z.infer<typeof strategySchema>;

export function loadRegistry(path = "registry/strategies.yaml", baseDir = process.cwd()): StrategyRegistry {
  return registrySchema.parse(YAML.parse(readFileSync(resolve(baseDir, path), "utf8")));
}

/**
 * Consistency problems (empty = consistent):
 *  - ids are unique;
 *  - an implemented strategy names a grid entry mode, every grid entry mode has exactly one implemented strategy;
 *  - only implemented strategies carry an entry mode;
 *  - an external strategy has a source URL (unless its source is a summary: a tweet or an image), an internal one has none;
 *  - an implemented external strategy states its fidelity; a not-implemented one says not_implemented;
 *  - an implemented external strategy built from a summary says so (it cannot claim `faithful`).
 */
export function checkRegistry(r: StrategyRegistry, gridEntryModes: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of r.strategies) {
    if (seen.has(s.id)) problems.push(`duplicate id ${s.id}`);
    seen.add(s.id);
    if (s.status === "implemented" && !s.entry_mode) problems.push(`${s.id}: implemented without entry_mode`);
    if (s.status !== "implemented" && s.entry_mode) problems.push(`${s.id}: entry_mode on a strategy that is not implemented`);
    if (s.entry_mode && !gridEntryModes.includes(s.entry_mode)) problems.push(`${s.id}: entry_mode ${s.entry_mode} is not a grid entry mode`);
    if (s.kind === "external" && !s.source.url && s.source.verified !== "summary_only") problems.push(`${s.id}: external strategy without a source URL`);
    if (s.kind === "internal" && s.source.verified !== "internal") problems.push(`${s.id}: internal strategy with an outside source`);
    if (s.kind === "external" && s.status === "implemented" && s.fidelity === "n/a") problems.push(`${s.id}: implemented external strategy without fidelity`);
    if (s.status !== "implemented" && s.fidelity === "faithful") problems.push(`${s.id}: fidelity faithful but not implemented`);
    if (s.fidelity === "faithful" && s.source.verified === "summary_only") problems.push(`${s.id}: cannot be faithful to a summary`);
  }
  for (const m of gridEntryModes) {
    const n = r.strategies.filter((s) => s.entry_mode === m).length;
    if (n !== 1) problems.push(`grid entry mode ${m} is registered ${n} times (expected 1)`);
  }
  return problems;
}

export function registryMarkdown(r: StrategyRegistry, filter: { status?: string; id?: string } = {}): string {
  const rows = r.strategies.filter((s) => (!filter.status || s.status === filter.status) && (!filter.id || s.id === filter.id));
  const md: string[] = [];
  md.push(`# Strategy registry, universe ${r.universe.version} (${r.universe.frozen ? "frozen" : "not frozen"}, ${r.universe.updated})`);
  md.push("");
  md.push("| id | status | entry mode | source | verified | fidelity | churn | fixed-cost exposure |");
  md.push("|---|---|---|---|---|---|---|---|");
  for (const s of rows)
    md.push(`| ${s.id} | ${s.status} | ${s.entry_mode ?? "-"} | ${s.source.name} | ${s.source.verified} | ${s.fidelity} | ${s.transaction_profile.churn} | ${s.capital_sensitivity.fixed_cost_exposure} |`);
  if (filter.id) {
    for (const s of rows) {
      md.push("", `## ${s.name} (${s.id})`, "");
      for (const [k, v] of Object.entries(s.rules)) md.push(`- **${k}**: ${v}`);
      if (s.original_vs_implemented.length) md.push("", "Original vs implemented:", ...s.original_vs_implemented.map((x) => `- ${x}`));
      md.push("", `Transaction profile: ${s.transaction_profile.notes}`, `Capital sensitivity: ${s.capital_sensitivity.notes}`);
      if (s.evidence.length) md.push("", "Evidence:", ...s.evidence.map((x) => `- ${x}`));
    }
  }
  md.push("", `Sources: ${r.sources.map((x) => `${x.id} (${x.relation})`).join("; ")}`);
  return md.join("\n") + "\n";
}
