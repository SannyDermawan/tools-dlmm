import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { canonicalJson, deepMerge, loadConfig, parseConfig, ConfigError } from "../src/config/load.ts";
import { Db, migrate } from "../src/db/index.ts";
import { createSession, finishSession, getSession, registerConfigVersion } from "../src/db/repo.ts";
import { backoffDelay, percentile, RateLimiter, withRetry } from "../src/util/async.ts";
import { redactUrl, scrub } from "../src/util/redact.ts";

const rawDefault = () => YAML.parse(readFileSync("config/default.yaml", "utf8"));

describe("config", () => {
  it("default config validates and has a versioned id", () => {
    const lc = loadConfig();
    expect(lc.configVersion).toMatch(/^v1.1.0+\+[0-9a-f]{10}$/);
  });

  it("hash ignores key order but changes with values", () => {
    const a = parseConfig(rawDefault());
    const reordered = Object.fromEntries(Object.entries(rawDefault()).reverse());
    expect(parseConfig(reordered).configVersion).toBe(a.configVersion);
    const changed = deepMerge(rawDefault(), { simulation: { entry_delay_seconds: 5 } });
    expect(parseConfig(changed).configVersion).not.toBe(a.configVersion);
  });

  it("rejects unknown keys (typos) and bad values", () => {
    expect(() => parseConfig(deepMerge(rawDefault(), { simulaton: {} }))).toThrow(ConfigError);
    expect(() => parseConfig(deepMerge(rawDefault(), { simulation: { virtual_capital_usd: -1 } }))).toThrow(
      /virtual_capital_usd/,
    );
    expect(() => parseConfig(deepMerge(rawDefault(), { grid: { strategies: ["zigzag"] } }))).toThrow(ConfigError);
  });

  it("cross-field check: bin window must cover the widest grid range", () => {
    const bad = deepMerge(rawDefault(), { collectors: { bin_snapshot: { bins_each_side: 10 } } });
    expect(() => parseConfig(bad)).toThrow(/bins_each_side/);
  });

  it("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
});

describe("database", () => {
  it("migrates idempotently and creates all blueprint tables", () => {
    const db = new Db(":memory:");
    expect(migrate(db).applied).toEqual(["001_init", "002_scoring", "003_swap_activity", "004_dashboard", "005_p1_modules", "006_grid_dimensions", "007_safety_memory", "008_real_lp", "009_telegram"]);
    expect(migrate(db).applied).toEqual([]);
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    for (const t of [
      "sessions", "config_versions", "pools", "pool_snapshots", "bin_snapshots", "swaps", "ohlcv",
      "token_security", "social_metrics", "ecosystem_metrics", "features", "scores", "signals",
      "sim_positions", "sim_position_events", "sim_results", "data_gaps", "macro_events",
    ]) expect(names).toContain(t);
    db.close();
  });

  it("records config version and session lifecycle", () => {
    const db = new Db(":memory:");
    migrate(db);
    const lc = loadConfig();
    const v = registerConfigVersion(db, lc);
    registerConfigVersion(db, lc); // no duplicate error
    const id = createSession(db, { kind: "collect", configVersion: v, label: "t" });
    finishSession(db, id, "completed", { poolCount: 3 });
    const s = getSession(db, id)!;
    expect(s.status).toBe("completed");
    expect(s.pool_count).toBe(3);
    expect(s.config_version).toBe(v);
    const stored = db.get<{ config_json: string }>("SELECT config_json FROM config_versions WHERE config_version=?", v)!;
    expect(JSON.parse(stored.config_json).config_label).toBe("v1.1.0");
    db.close();
  });

  it("insertMany respects OR IGNORE", () => {
    const db = new Db(":memory:");
    migrate(db);
    const row = { ts: 1, sol_usd: 100 };
    expect(db.insertMany("ecosystem_metrics", [row, row], "OR IGNORE")).toBe(1);
    db.close();
  });
});

describe("utilities", () => {
  it("redacts API keys from RPC URLs", () => {
    expect(redactUrl("https://mainnet.helius-rpc.com/?api-key=abcdef123456")).not.toContain("abcdef123456");
    expect(redactUrl("https://x.quiknode.pro/0123456789abcdef0123/")).not.toContain("0123456789abcdef0123");
    expect(scrub("fetch failed for https://h/?k=supersecretkey", ["supersecretkey"])).not.toContain("supersecret");
  });

  it("backoff grows and is capped", () => {
    const r = () => 1;
    expect(backoffDelay(1, 100, 10000, r)).toBe(100);
    expect(backoffDelay(3, 100, 10000, r)).toBe(400);
    expect(backoffDelay(20, 100, 10000, r)).toBe(10000);
  });

  it("withRetry retries then succeeds", async () => {
    let n = 0;
    const v = await withRetry(async () => {
      if (++n < 3) throw new Error("x");
      return 42;
    }, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 });
    expect(v).toBe(42);
    expect(n).toBe(3);
  });

  it("rate limiter bounds concurrency", async () => {
    const rl = new RateLimiter(1000, 2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        rl.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("percentile interpolates", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([0, 10], 75)).toBe(7.5);
    expect(percentile([], 50)).toBeNull();
  });
});
