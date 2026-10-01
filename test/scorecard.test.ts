import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Db, migrate } from "../src/db/index.ts";
import { addBlock } from "../src/features/safetyData.ts";
import { capitalComparisonMarkdown, costClass, loadScorecardPositions, projectCapital, scorecard, scorecardMarkdown, scorecardRow } from "../src/analysis/scorecard.ts";
import { loadConfig } from "../src/config/load.ts";

const H = 3_600_000;

interface PosOpts {
  session?: string; mode?: string; pool?: string; cap?: number; net: number; fee?: number;
  costs: { type: string; usd: number; refundable?: boolean }[]; dur?: number; opened?: number; closed?: number; regime?: string;
}

function pos(db: Db, id: string, o: PosOpts) {
  const cost = o.costs.filter((c) => !c.refundable).reduce((a, c) => a + c.usd, 0);
  db.run(
    `INSERT INTO sim_positions (position_id, session_id, pool, grid_combo, entry_mode, strategy, sides, bins_below, bins_above, capital_usd, requested_at, opened_at, closed_at, status, gap_tainted, config_version)
     VALUES (?, ?, ?, ?, ?, 'spot', 'two_sided', 10, 10, ?, ?, ?, ?, 'closed', 0, 'test')`,
    id, o.session ?? "S1", o.pool ?? "P1", JSON.stringify(o.regime ? { regime: o.regime } : {}), o.mode ?? "all_pools_baseline", o.cap ?? 1000,
    o.opened ?? 0, o.opened ?? 0, o.closed ?? H,
  );
  db.run(
    `INSERT INTO sim_results (position_id, fee_usd, il_usd, cost_usd, net_pnl_usd, net_pnl_pct, duration_min, max_drawdown_pct, detail) VALUES (?, ?, 0, ?, ?, ?, ?, 1, ?)`,
    id, o.fee ?? 0, cost, o.net, (o.net / (o.cap ?? 1000)) * 100, o.dur ?? 60,
    JSON.stringify({ costs: o.costs.map((c) => ({ ...c, refundable: !!c.refundable })) }),
  );
}

const setup = () => {
  const db = new Db(":memory:");
  migrate(db);
  for (const [pool, name, x] of [["P1", "A-SOL", "TOKA"], ["P2", "B-SOL", "TOKB"]])
    db.run(
      "INSERT INTO pools (pool, name, token_x, token_y, decimals_x, decimals_y, bin_step, category, first_seen_at, last_checked_at) VALUES (?, ?, ?, 'SOL', 6, 9, 20, 'memecoin', 0, 0)",
      pool, name, x,
    );
  return db;
};

describe("strategy scorecard (roadmap PHASE 5-8)", () => {
  it("classes costs: fixed = transactions + bin arrays, variable = swaps + tax + composition, rent apart", () => {
    expect(["tx_open", "tx_swap", "tx_rebalance"].map(costClass)).toEqual(["tx", "tx", "tx"]);
    expect(["balancing_swap", "exit_swap"].map(costClass)).toEqual(["swap", "swap"]);
    expect(costClass("transfer_tax")).toBe("tax");
    expect(costClass("composition_fee")).toBe("composition");
    expect(costClass("bin_array_init")).toBe("bin_array");
    expect(costClass("position_rent")).toBeNull();
  });

  it("splits each position's cost and finds rug exposure", () => {
    const db = setup();
    pos(db, "a", {
      net: 10, fee: 20,
      costs: [{ type: "tx_open", usd: 0.1 }, { type: "position_rent", usd: 7, refundable: true }, { type: "balancing_swap", usd: 5 }, { type: "bin_array_init", usd: 0.9 }, { type: "tx_close", usd: 0.1 }],
    });
    pos(db, "b", { pool: "P2", net: -30, costs: [{ type: "tx_open", usd: 0.1 }, { type: "transfer_tax", usd: 2 }], opened: 0, closed: 2 * H });
    addBlock(db, "token", "TOKB", "auto rug: price_and_lp", "auto_rug", H); // while b was open
    const ps = loadScorecardPositions(db, ["S1"]);
    const a = ps.find((p) => p.net === 10)!;
    expect(a).toMatchObject({ txOps: 2, rent: 7, rugged: false });
    expect(a.fixed).toBeCloseTo(1.1);
    expect(a.variable).toBeCloseTo(5);
    expect(ps.find((p) => p.net === -30)).toMatchObject({ tax: 2, rugged: true });
  });

  it("computes performance, efficiency and the projection to a smaller capital", () => {
    const db = setup();
    // two $1000 positions, one hour each: +$10 and -$30; fixed $1 each, variable $4 each
    pos(db, "w", { net: 10, fee: 20, costs: [{ type: "tx_open", usd: 1 }, { type: "exit_swap", usd: 4 }] });
    pos(db, "l", { net: -30, fee: 0, costs: [{ type: "tx_open", usd: 1 }, { type: "exit_swap", usd: 4 }] });
    const ps = loadScorecardPositions(db, ["S1"]);
    const r = scorecardRow("all_pools_baseline", ps);
    expect(r).toMatchObject({ n: 2, sessions: 1, pools: 1, winRate: 0.5, lossRate: 0.5 });
    expect(r.profitFactor).toBeCloseTo(10 / 30);
    expect(r.avgNetPct).toBeCloseTo(-1);
    expect(r.grossPct).toBeCloseTo(-0.5); // (10 + 5 - 30 + 5) / 2 / $1000
    expect(r.breakEvenPct).toBeCloseTo(0.5);
    expect(r.fixedPct).toBeCloseTo(0.1);
    expect(r.effPctPerHour).toBeCloseTo(-1); // -$20 over 2000 capital-hours
    // at $50 the $1 fixed cost is 2% of the position: net % = gross % - variable % - 2%
    const p = projectCapital(ps, 50);
    expect(p.fixedPct).toBeCloseTo(2);
    expect(p.netPct).toBeCloseTo(-0.5 - 0.4 - 2);
    expect(p.breakEvenPct).toBeCloseTo(0.4 + 2);
    // at the original size the projection gives back the stored result
    expect(projectCapital(ps, 1000).netPct).toBeCloseTo(-1);
  });

  it("markdown has the sample, cost, efficiency, capital and regime sections", () => {
    const db = setup();
    pos(db, "x", { net: 5, costs: [{ type: "tx_open", usd: 0.5 }], regime: "MOMENTUM_UP" });
    pos(db, "y", { mode: "yunus_flip", net: -5, costs: [{ type: "tx_open", usd: 0.5 }], regime: "SIDEWAYS" });
    const md = scorecardMarkdown(scorecard(db, ["S1"], { capitals: [45, 1000] }));
    for (const s of ["Sample and performance", "Cost per position", "Capital efficiency", "Projected to other capitals", "By market regime", "MOMENTUM_UP", "| yunus_flip |", "$45"])
      expect(md).toContain(s);
    const sc = scorecard(db, ["S1"], { capitals: [45] });
    const cmp = capitalComparisonMarkdown("S1xxxxxx", sc, [{ capital: 45, sc }]);
    expect(cmp).toContain("Replays of the session at each capital");
    expect(cmp).toContain("Projection from the live session");
  });
});

describe("config profiles extend each other (roadmap PHASE 7 capital profiles)", () => {
  it("every capital profile loads on top of the 2 h profile and changes only the size", () => {
    const base = loadConfig("config/session-2h.yaml").config;
    for (const c of [40, 45, 50, 100, 1000]) {
      const x = loadConfig(`config/capital/usd-${c}.yaml`).config;
      expect(x.simulation.virtual_capital_usd).toBe(c);
      expect(x.session.duration_minutes).toBe(base.session.duration_minutes);
      expect(x.grid.signal_entry.trigger).toBe(base.grid.signal_entry.trigger);
      expect(x.scoring.edge.capital_usd).toBe(base.scoring.edge.capital_usd);
    }
  });

  it("a chain that loops is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(dir, "a.yaml"), "extends: b\n");
    writeFileSync(join(dir, "b.yaml"), "extends: a\n");
    expect(() => loadConfig(join(dir, "a.yaml"))).toThrow(/extends itself/);
  });
});
