import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";

/**
 * Strategy registry (roadmap PHASE 1) with the per-component decomposition of PHASE 2. The data lives
 * in registry/strategies.yaml; this module validates it and checks it against the grid's entry modes.
 *
 * Every strategy is split into the same nine components so they can be compared component by
 * component: entry, filter, side, range, position_size, exit, reentry, rebalance, transaction_policy.
 * Each component states the original rule, our implemented rule, the deviation and the reason.
 */

export const COMPONENTS = ["entry", "filter", "side", "range", "position_size", "exit", "reentry", "rebalance", "transaction_policy"] as const;
export type ComponentName = (typeof COMPONENTS)[number];

/** none: identical; minor: same logic, other value or data; major: a rule dropped, added or replaced; unknown: original silent (summaries only); n/a: nothing to compare. */
export const DEVIATIONS = ["none", "minor", "major", "unknown", "n/a"] as const;
export type Deviation = (typeof DEVIATIONS)[number];

const text = z.string().min(1);
const sourceSchema = z
  .object({
    name: text,
    url: z.string().url().nullable(),
    verified: z.enum(["source_code", "summary_only", "internal"]),
  })
  .strict();

const componentSchema = z
  .object({
    original: text,
    implemented: text,
    deviation: z.enum(DEVIATIONS),
    reason: z.string().default(""),
    /** where it lives in our config or code (implemented strategies) */
    where: z.string().optional(),
  })
  .strict();

const componentsSchema = z.object(Object.fromEntries(COMPONENTS.map((c) => [c, componentSchema])) as Record<ComponentName, typeof componentSchema>).strict();

const strategySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    name: text,
    kind: z.enum(["internal", "external"]),
    status: z.enum(["implemented", "candidate", "reference", "excluded"]),
    entry_mode: z.string().nullable(),
    source: sourceSchema,
    fidelity: z.enum(["faithful", "interpretation", "not_implemented", "n/a"]),
    components: componentsSchema,
    /** remarks that belong to the strategy as a whole */
    notes: z.array(text).default([]),
    transaction_profile: z.object({ churn: z.enum(["low", "medium", "high"]), notes: text }).strict(),
    capital_sensitivity: z.object({ fixed_cost_exposure: z.enum(["low", "medium", "high"]), notes: text }).strict(),
    evidence: z.array(text),
  })
  .strict();

const registrySchema = z
  .object({
    universe: z.object({ version: text, frozen: z.boolean(), updated: text, note: text }).strict(),
    sources: z
      .array(z.object({ id: text, url: z.string().url(), kind: text, relation: text, read: text, notes: text }).strict())
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
 *  - fidelity: implemented external strategies state one; not implemented ones say not_implemented; `faithful` needs
 *    a code source and no major or unknown deviation;
 *  - deviations: `n/a` exactly when there is nothing to compare (internal or not implemented); `unknown` only for a
 *    summary source; minor, major and unknown carry a reason.
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
    const comparable = s.status === "implemented" && s.kind === "external";
    for (const c of COMPONENTS) {
      const x = s.components[c];
      if (comparable && x.deviation === "n/a") problems.push(`${s.id}.${c}: implemented external strategy needs a deviation other than n/a`);
      if (!comparable && x.deviation !== "n/a") problems.push(`${s.id}.${c}: deviation ${x.deviation} but there is nothing to compare (internal or not implemented)`);
      if (x.deviation === "unknown" && s.source.verified !== "summary_only") problems.push(`${s.id}.${c}: unknown deviation for a source we read`);
      if ((x.deviation === "minor" || x.deviation === "major" || x.deviation === "unknown") && !x.reason.trim()) problems.push(`${s.id}.${c}: ${x.deviation} deviation without a reason`);
      if (s.fidelity === "faithful" && (x.deviation === "major" || x.deviation === "unknown")) problems.push(`${s.id}.${c}: faithful strategy with a ${x.deviation} deviation`);
    }
  }
  for (const m of gridEntryModes) {
    const n = r.strategies.filter((s) => s.entry_mode === m).length;
    if (n !== 1) problems.push(`grid entry mode ${m} is registered ${n} times (expected 1)`);
  }
  return problems;
}

const SYMBOL: Record<Deviation, string> = { none: "=", minor: "~", major: "X", unknown: "?", "n/a": "-" };

/** Strategy x component grid of deviations: the whole decomposition at a glance. */
export function registryComponentGrid(r: StrategyRegistry): string {
  const md: string[] = [];
  md.push(`# Component deviations, universe ${r.universe.version}`);
  md.push("");
  md.push(`Legend: \`=\` none, \`~\` minor, \`X\` major, \`?\` unknown (original silent), \`-\` nothing to compare.`);
  md.push("");
  md.push(`| strategy | status | ${COMPONENTS.join(" | ")} |`);
  md.push(`|---|---|${COMPONENTS.map(() => ":-:").join("|")}|`);
  for (const s of r.strategies) md.push(`| ${s.id} | ${s.status} | ${COMPONENTS.map((c) => SYMBOL[s.components[c].deviation]).join(" | ")} |`);
  return md.join("\n") + "\n";
}

/** One component across strategies: the original rule and ours side by side. */
export function registryComponentMarkdown(r: StrategyRegistry, component: ComponentName, filter: { status?: string } = {}): string {
  const md: string[] = [`# Component: ${component}`, ""];
  for (const s of r.strategies.filter((x) => !filter.status || x.status === filter.status)) {
    const c = s.components[component];
    md.push(`## ${s.id} (${s.status}, deviation ${c.deviation})`, "");
    md.push(`- original: ${c.original}`, `- implemented: ${c.implemented}`);
    if (c.reason) md.push(`- reason: ${c.reason}`);
    if (c.where) md.push(`- where: ${c.where}`);
    md.push("");
  }
  return md.join("\n");
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
      md.push("| component | deviation | original | implemented | reason |", "|---|:-:|---|---|---|");
      for (const c of COMPONENTS) {
        const x = s.components[c];
        md.push(`| ${c} | ${SYMBOL[x.deviation]} ${x.deviation} | ${x.original} | ${x.implemented} | ${x.reason || "-"} |`);
      }
      if (s.notes.length) md.push("", "Notes:", ...s.notes.map((x) => `- ${x}`));
      md.push("", `Transaction profile: ${s.transaction_profile.notes}`, `Capital sensitivity: ${s.capital_sensitivity.notes}`);
      if (s.evidence.length) md.push("", "Evidence:", ...s.evidence.map((x) => `- ${x}`));
    }
  }
  md.push("", `Sources: ${r.sources.map((x) => `${x.id} (${x.relation})`).join("; ")}`);
  return md.join("\n") + "\n";
}
