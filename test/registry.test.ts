import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import {
  checkRegistry, COMPONENTS, loadRegistry, registryComponentGrid, registryComponentMarkdown, registryMarkdown, type StrategyRegistry,
} from "../src/registry/strategies.ts";

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
    // evil_panda exists only in the fork, and is not our yunus_flip: it runs as its own entry mode
    const ep = reg.strategies.find((s) => s.id === "evil_panda")!;
    expect(ep.source.url).toContain("fciaf420/meridian");
    expect(ep).toMatchObject({ status: "implemented", entry_mode: "evil_panda" });
    expect(reg.strategies.find((s) => s.id === "yunus_flip")!.notes.join(" ")).toMatch(/NOT Meridian's evil_panda/);
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
      first(r, "prism_fallen_angel").entry_mode = "yunus_flip";
      expect(checkRegistry(r, modes).join("|")).toContain("prism_fallen_angel: entry_mode on a strategy that is not implemented");
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
      first(r2, "prism_fallen_angel").fidelity = "faithful";
      expect(checkRegistry(r2, modes).join("|")).toContain("prism_fallen_angel: fidelity faithful but not implemented");
    });
  });
});

describe("strategy decomposition (roadmap PHASE 2)", () => {
  const reg = loadRegistry();
  const clone = (): StrategyRegistry => structuredClone(reg);
  const first = (r: StrategyRegistry, id: string) => r.strategies.find((s) => s.id === id)!;

  it("every strategy is split into the same nine components, each with an original and an implemented rule", () => {
    expect(COMPONENTS).toEqual(["entry", "filter", "side", "range", "position_size", "exit", "reentry", "rebalance", "transaction_policy"]);
    for (const s of reg.strategies)
      for (const c of COMPONENTS) {
        expect(s.components[c].original.length, `${s.id}.${c}`).toBeGreaterThan(0);
        expect(s.components[c].implemented.length, `${s.id}.${c}`).toBeGreaterThan(0);
      }
  });

  it("deviations are comparable only for implemented external strategies; everything else is n/a", () => {
    for (const s of reg.strategies) {
      const comparable = s.status === "implemented" && s.kind === "external";
      for (const c of COMPONENTS) expect(s.components[c].deviation === "n/a", `${s.id}.${c}`).toBe(!comparable);
    }
  });

  it("every minor, major or unknown deviation says why", () => {
    for (const s of reg.strategies)
      for (const c of COMPONENTS) {
        const x = s.components[c];
        if (["minor", "major", "unknown"].includes(x.deviation)) expect(x.reason.trim().length, `${s.id}.${c}`).toBeGreaterThan(0);
      }
  });

  it("records the known deviations of the three external strategies", () => {
    const dev = (id: string, c: (typeof COMPONENTS)[number]) => first(reg, id).components[c].deviation;
    // the re-entry rules of all three are ours, not the sources'
    expect(dev("meridian_preset", "reentry")).toBe("major");
    expect(dev("friday_scalp", "reentry")).toBe("major");
    expect(dev("yunus_flip", "reentry")).toBe("major");
    // Friday's shape and side are his words
    expect(dev("friday_scalp", "side")).toBe("none");
    expect(dev("friday_scalp", "range")).toBe("none");
    // the LLM pick and narrative steps were replaced in Meridian's entry and filter
    expect(dev("meridian_preset", "entry")).toBe("major");
    expect(dev("meridian_preset", "filter")).toBe("major");
    // summaries do not state a size: unknown, not none
    expect(dev("friday_scalp", "position_size")).toBe("unknown");
    expect(dev("yunus_flip", "position_size")).toBe("unknown");
    // Meridian's source was read, so nothing there is unknown
    for (const c of COMPONENTS) expect(dev("meridian_preset", c)).not.toBe("unknown");
    // Evil Panda: side, range and rebalance as in the fork's code; sizing and re-entry are ours
    expect(dev("evil_panda", "side")).toBe("none");
    expect(dev("evil_panda", "range")).toBe("none");
    expect(dev("evil_panda", "position_size")).toBe("major");
    expect(dev("evil_panda", "reentry")).toBe("major");
    for (const c of COMPONENTS) expect(dev("evil_panda", c)).not.toBe("unknown");
  });

  describe("checkRegistry enforces the decomposition rules", () => {
    it("n/a where a comparison exists, and a real deviation where there is nothing to compare", () => {
      const r = clone();
      first(r, "meridian_preset").components.exit.deviation = "n/a";
      expect(checkRegistry(r, modes).join("|")).toContain("meridian_preset.exit: implemented external strategy needs a deviation other than n/a");
      const r2 = clone();
      first(r2, "prism_fallen_angel").components.exit.deviation = "minor";
      expect(checkRegistry(r2, modes).join("|")).toContain("prism_fallen_angel.exit: deviation minor but there is nothing to compare");
      const r3 = clone();
      first(r3, "all_pools_baseline").components.entry.deviation = "none";
      expect(checkRegistry(r3, modes).join("|")).toContain("all_pools_baseline.entry: deviation none but there is nothing to compare");
    });

    it("`unknown` is only allowed when the source is a summary", () => {
      const r = clone();
      first(r, "meridian_preset").components.exit.deviation = "unknown";
      first(r, "meridian_preset").components.exit.reason = "we did not look";
      expect(checkRegistry(r, modes).join("|")).toContain("meridian_preset.exit: unknown deviation for a source we read");
    });

    it("a deviation without a reason", () => {
      const r = clone();
      first(r, "friday_scalp").components.exit.reason = "  ";
      expect(checkRegistry(r, modes).join("|")).toContain("friday_scalp.exit: minor deviation without a reason");
    });

    it("`faithful` cannot carry a major deviation", () => {
      const r = clone();
      first(r, "meridian_preset").fidelity = "faithful";
      expect(checkRegistry(r, modes).join("|")).toContain("meridian_preset.entry: faithful strategy with a major deviation");
    });
  });

  it("the grid shows every strategy with one symbol per component", () => {
    const g = registryComponentGrid(reg);
    for (const c of COMPONENTS) expect(g).toContain(c);
    const row = g.split("\n").find((l) => l.startsWith("| friday_scalp |"))!;
    // entry ~, filter ~, side =, range =, position_size ?, exit ~, reentry X, rebalance =, transaction_policy ?
    expect(row.split("|").slice(3, 12).map((x) => x.trim())).toEqual(["~", "~", "=", "=", "?", "~", "X", "=", "?"]);
    const base = g.split("\n").find((l) => l.startsWith("| all_pools_baseline |"))!;
    expect(base.split("|").slice(3, 12).every((x) => x.trim() === "-")).toBe(true);
  });

  it("one component across strategies shows original and implemented side by side, filtered by status", () => {
    const md = registryComponentMarkdown(reg, "exit");
    expect(md).toContain("## prism_fallen_angel (candidate, deviation n/a)");
    expect(md).toContain("## evil_panda (implemented, deviation minor)");
    expect(md).toContain("RSI(2) > 90");
    expect(md).toContain("## meridian_preset (implemented, deviation minor)");
    const only = registryComponentMarkdown(reg, "exit", { status: "implemented" });
    expect(only).not.toContain("## prism_fallen_angel");
    expect(only).toContain("## evil_panda");
    expect(only).toContain("## friday_scalp");
  });

  it("markdown lists every strategy, filters by status and shows one in full with its component table", () => {
    const all = registryMarkdown(reg);
    for (const s of reg.strategies) expect(all).toContain(`| ${s.id} |`);
    const cand = registryMarkdown(reg, { status: "candidate" });
    expect(cand).toContain("| prism_fallen_angel |");
    expect(cand).not.toContain("| evil_panda |");
    expect(cand).not.toContain("| all_pools_baseline |");
    const one = registryMarkdown(reg, { id: "yunus_flip" });
    expect(one).toContain("| component | deviation | original | implemented | reason |");
    expect(one).toContain("| reentry | X major |");
    expect(one).toContain("Notes:");
  });
});
