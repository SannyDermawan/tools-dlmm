import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { ConfigSchema, type Config } from "./schema.ts";

export const DEFAULT_CONFIG_PATH = "config/default.yaml";

export interface LoadedConfig {
  config: Config;
  /** "<config_label>+<first 10 hex of sha256(canonical json)>" */
  configVersion: string;
  hash: string;
  path: string;
}

export class ConfigError extends Error {}

/** JSON with object keys sorted recursively, so the hash ignores key order and formatting. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseConfig(raw: unknown, path = "<inline>"): LoadedConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Invalid config ${path}:\n${lines.join("\n")}`);
  }
  const config = result.data;
  const hash = createHash("sha256").update(canonicalJson(config)).digest("hex");
  return { config, hash, configVersion: `${config.config_label}+${hash.slice(0, 10)}`, path };
}

/** Deep-merge `override` onto `base` (objects merge, arrays/scalars replace). */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (
    base && override && typeof base === "object" && typeof override === "object" &&
    !Array.isArray(base) && !Array.isArray(override)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return override;
}

/**
 * Load a config file. A non-default file may contain only overrides — it is merged on top of
 * config/default.yaml when it sets `extends: default`.
 */
export function loadConfig(path = DEFAULT_CONFIG_PATH, overrides?: unknown): LoadedConfig {
  const abs = resolve(path);
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new ConfigError(`Cannot read config ${abs}: ${(e as Error).message}`);
  }
  if (raw && typeof raw === "object" && (raw as Record<string, unknown>).extends === "default") {
    const { extends: _ignored, ...rest } = raw as Record<string, unknown>;
    const base = YAML.parse(readFileSync(resolve(DEFAULT_CONFIG_PATH), "utf8"));
    raw = deepMerge(base, rest);
  }
  if (overrides) raw = deepMerge(raw, overrides);
  return parseConfig(raw, abs);
}
