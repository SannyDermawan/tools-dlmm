import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { checkRegistry, loadRegistry, registryMarkdown, type StrategyRegistry } from "../src/registry/strategies.ts";

const modes = loadConfig().config.grid.entry_modes;

describe("strategy registry (roadmap PHASE 1)", () => {
  const reg = loadRegistry();

  it("the shipped registry parses and agrees with grid.entry_modes in both directions", () => {
    expect(checkRegistry(reg, modes)).toEqual([]);
    const implemented = reg.strategies.filter((s) => s.status === "implemented").map((s) => s.entry_mode);
    expect([...implemented].sort()).toEqual([...modes].sort());
  });

  it("records forks and siblings instead of treating one repository as one strategy", () => {
    const ids = reg.sources.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["yunus-0x/meridian", "fciaf420/meridian", "irfndi/prism-liquidity-agent", "DeltaLogicLabs/Mantis", "hummingbot/hummingbot"]));
    expect(reg.sources.find((s) => s.id === "fciaf420/meridian")!.relation).toContain("fork");
    // evil_panda exists only in the fork, and is not our yunus_flip
    const ep = reg.strategies.find((s) => s.id === "evil_panda")!;
    expect(ep.source.url).toContain("fciaf420/meridian");
    expect(ep.status).toBe("candidate");
    expect(reg.strategies.find((s) => s.id === "yunus_flip")!.original_vs_implemented.join(" ")).toMatch(/NOT Meridian's evil_panda/);
  });

  it("is honest about what is not verified: summary-only sources are never `faithful`, the universe is not frozen", () => {
    expect(reg.universe.frozen).toBe(false);
    for (const s of reg.strategies) if (s.source.verified === "summary_only") expect(s.fidelity).not.toBe("faithful");
  });

  it("every strategy has a transaction profile and a capital sensitivity", () => {
    for (const s of reg.strategies) {
      expect(["low", "medium", "high"]).toContain(s.transaction_profile.churn);
      expect(["low", "medium", "high"]).toContain(s.capital_sensitivity.fixed_cost_exposure);
    }
  });

  describe("checkRegistry finds inconsistencies", () => {
    const clone = (): StrategyRegistry => structuredClone(reg);
    const first = (r: StrategyRegistry, id: string) => r.strategies.find((s) => s.id === id)!;

    it("duplicate ids", () => {
      const r = clone();
      r.strategies.push(structuredClone(r.strategies[0]));
      expect(checkRegistry(r, modes).join("|")).toContain("duplicate id all_pools_baseline");
    });

    it("an implemented strategy without an entry mode, and a mode that is not in the grid", () => {
      const r = clone();
      first(r, "meridian_preset").entry_mode = null;
      expect(checkRegistry(r, modes).join("|")).toContain("meridian_preset: implemented without entry_mode");
      const r2 = clone();
      first(r2, "friday_scalp").entry_mode = "no_such_mode";
      const p = checkRegistry(r2, modes).join("|");
      expect(p).toContain("no_such_mode is not a grid entry mode");
      expect(p).toContain("grid entry mode friday_scalp is registered 0 times");
    });

    it("a grid entry mode nobody registered", () => {
      expect(checkRegistry(clone(), [...modes, "brand_new_mode"]).join("|")).toContain("brand_new_mode is registered 0 times");
    });

    it("an entry mode on a strategy that is only a candidate", () => {
      const r = clone();
      first(r, "evil_panda").entry_mode = "yunus_flip";
      expect(checkRegistry(r, modes).join("|")).toContain("evil_panda: entry_mode on a strategy that is not implemented");
    });

    it("an external strategy read from code needs a URL, one built from a summary does not", () => {
      const r = clone();
      first(r, "meridian_preset").source.url = null;
      expect(checkRegistry(r, modes).join("|")).toContain("meridian_preset: external strategy without a source URL");
      expect(first(clone(), "friday_scalp").source.url).toBeNull(); // allowed: summary_only
    });

    it("`faithful` to a summary, or `faithful` without being implemented", () => {
      const r = clone();
      first(r, "yunus_flip").fidelity = "faithful";
      expect(checkRegistry(r, modes).join("|")).toContain("yunus_flip: cannot be faithful to a summary");
      const r2 = clone();
      first(r2, "evil_panda").fidelity = "faithful";
      expect(checkRegistry(r2, modes).join("|")).toContain("evil_panda: fidelity faithful but not implemented");
    });
  });

  it("markdown lists every strategy, filters by status and shows one in full", () => {
    const all = registryMarkdown(reg);
    for (const s of reg.strategies) expect(all).toContain(`| ${s.id} |`);
    const cand = registryMarkdown(reg, { status: "candidate" });
    expect(cand).toContain("| evil_panda |");
    expect(cand).not.toContain("| all_pools_baseline |");
    const one = registryMarkdown(reg, { id: "yunus_flip" });
    expect(one).toContain("Original vs implemented:");
    expect(one).toContain("**exits**");
  });
});
