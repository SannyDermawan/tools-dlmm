import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import { registerConfigVersion } from "../src/db/repo.ts";
import { binRawPrice, binUiPrice, Q64 } from "../src/math/bin.ts";
import { feeOnTokenX } from "../src/chain/dlmm.ts";
import { MemorySink, PoolSimulator } from "../src/sim/engine.ts";
import type { PositionSpec } from "../src/sim/position.ts";
import { breakEvenMarkdown } from "../src/report/analytics.ts";
import { transferFeeLookup } from "../src/features/safetyData.ts";
import type { BinObs, BinSnapshot, PoolMeta, PoolStateUpdate } from "../src/collectors/types.ts";

const cfg = (): Config => structuredClone(loadConfig().config);
const META: PoolMeta = {
  pool: "POOL", name: "T-USD", tokenX: "T", tokenY: "USD", symbolX: "T", symbolY: "USD", decimalsX: 6, decimalsY: 6,
  binStep: 100, category: "memecoin", reserveX: "rx", reserveY: "ry", collectFeeMode: 0,
  fee: { binStep: 100, baseFactor: 10000, baseFeePowerFactor: 0, variableFeeControl: 0, protocolShare: 500 },
  s: {} as never, createdAt: null,
};
const state = (ts: number, activeId: number, fee = 0.05): PoolStateUpdate => ({
  pool: "POOL", ts, slot: ts, activeId, priceUi: binUiPrice(activeId, 100, 6, 6),
  v: { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 },
  feeRateTotal: fee, feeRateLp: fee * 0.95,
});
const snapshot = (ts: number, activeId: number, feeX = 0n, feeY = 0n): BinSnapshot => {
  const bins = new Map<number, BinObs>();
  for (let id = activeId - 30; id <= activeId + 30; id++) {
    const P = binRawPrice(id, 100);
    const x = id >= activeId ? 1_000_000_000n : 0n;
    const y = id <= activeId ? 1_000_000_000n : 0n;
    bins.set(id, { binId: id, x, y, supply: BigInt(Math.floor(P * Number(x) + Number(y))) * Q64, feeX, feeY, priceRaw: P });
  }
  return { pool: "POOL", ts, slot: ts, activeId, lower: activeId - 30, upper: activeId + 30, missingBinArrays: [], bins };
};
const spec = (o: Partial<PositionSpec> = {}): PositionSpec => ({
  strategy: "spot", sides: "two_sided", binsBelow: 5, binsAbove: 5, capitalUsd: 1000, entryMode: "all_pools_baseline", combo: {}, ...o,
});
const setup = (mut?: (c: Config) => void) => {
  const c = cfg();
  mut?.(c);
  let n = 0;
  const sim = new PoolSimulator(META, c, new MemorySink(), () => `p${++n}`);
  sim.onMarket({ quoteUsd: 1, solUsd: 100, priorityMicroLamports: 10_000 });
  return { sim, c };
};
const open = (sim: PoolSimulator, o: Partial<PositionSpec> = {}, tvl: number | null = null) => {
  if (tvl !== null) sim.onMarket({ tvlUsd: tvl });
  sim.onState(state(0, 0));
  sim.onBins(snapshot(0, 0));
  const p = sim.request(spec(o), 0);
  sim.onState(state(3000, 0));
  return p;
};
const costOf = (p: { costs: { type: string; usd: number }[] }, type: string) => p.costs.filter((c) => c.type === type).reduce((s, c) => s + c.usd, 0);

describe("price impact by size (stage 3)", () => {
  it("only the part above the quoted trade is added, from the TVL of that moment; capped; switchable", () => {
    const { sim, c } = setup();
    const q = c.simulation.costs.aggregator.quote_notional_usd; // 500
    expect(sim.sizeImpact(1000)).toBe(0); // no TVL known
    sim.onMarket({ tvlUsd: 20_000 });
    expect(sim.sizeImpact(q)).toBe(0); // the quote already covers this size
    expect(sim.sizeImpact(100)).toBe(0);
    expect(sim.sizeImpact(2500)).toBeCloseTo((2500 - q) / (2 * 20_000), 12);
    sim.onMarket({ tvlUsd: 8_000 }); // thin pool: a bigger extra for the same trade
    expect(sim.sizeImpact(2500)).toBeCloseTo((2500 - q) / (2 * 8_000), 12);
    sim.onMarket({ tvlUsd: 100 });
    expect(sim.sizeImpact(1_000_000)).toBeCloseTo(c.simulation.costs.size_impact.max_pct / 100, 12);
    const off = setup((x) => (x.simulation.costs.size_impact.enabled = false));
    off.sim.onMarket({ tvlUsd: 100 });
    expect(off.sim.sizeImpact(5000)).toBe(0);
  });

  it("the exit swap is priced at the TVL of the exit: a pool emptied by a dump costs more to leave", () => {
    const exitCost = (tvlAtExit: number) => {
      const { sim } = setup((c) => (c.simulation.exit_to = "quote"));
      const p = open(sim, { sides: "base_only", binsBelow: 0, binsAbove: 10, capitalUsd: 3000 }, 60_000);
      sim.onMarket({ tvlUsd: tvlAtExit });
      sim.onState(state(60_000, 0));
      sim.close(p.id, "test", 60_000);
      return costOf(p, "exit_swap");
    };
    const healthy = exitCost(60_000);
    const dumped = exitCost(4_000);
    expect(dumped).toBeGreaterThan(healthy * 2);
  });
});

describe("token-2022 transfer tax (stage 3)", () => {
  const taxed = (bps: number | null, mut?: (c: Config) => void) => {
    const s = setup((c) => {
      c.simulation.exit_to = "quote";
      mut?.(c);
    });
    s.sim.transferFeeBps = (t) => (t === "T" ? bps : null);
    return s;
  };
  it("no tax without a transfer fee, or when the switch is off", () => {
    const a = taxed(null);
    expect(costOf(open(a.sim, { sides: "base_only", binsBelow: 0, binsAbove: 10 }), "transfer_tax")).toBe(0);
    const b = taxed(300, (c) => (c.simulation.costs.transfer_tax = false));
    expect(costOf(open(b.sim, { sides: "base_only", binsBelow: 0, binsAbove: 10 }), "transfer_tax")).toBe(0);
  });
  it("open: the X part is received from the swap and deposited (two transfers); Y untaxed", () => {
    const { sim } = taxed(300);
    const p = open(sim, { sides: "base_only", binsBelow: 0, binsAbove: 10 });
    expect(costOf(p, "transfer_tax")).toBeCloseTo(1000 * 2 * 0.03, 6);
  });
  it("close: withdrawal (+ claimed X fee) and the swap leg", () => {
    const { sim } = taxed(100);
    const p = open(sim, { sides: "base_only", binsBelow: 0, binsAbove: 10 });
    const before = costOf(p, "transfer_tax");
    sim.onState(state(60_000, 0));
    sim.close(p.id, "test", 60_000);
    const closeTax = costOf(p, "transfer_tax") - before;
    // ~ all value is X (the active bin counts half as Y): withdrawn once and sold once, 1% each
    expect(closeTax).toBeGreaterThan(18);
    expect(closeTax).toBeLessThan(20.1);
  });
  it("PnL falls by the tax (paid at open and close) compared with an untaxed token", () => {
    const run = (bps: number | null) => {
      const { sim } = taxed(bps);
      const p = open(sim, { sides: "base_only", binsBelow: 0, binsAbove: 10 });
      sim.onState(state(60_000, 0));
      return sim.close(p.id, "test", 60_000)!.netPnlUsd;
    };
    expect(run(null) - run(200)).toBeGreaterThan(30); // ~ 2% x (2 legs open + 2 legs close) of $1000 = $80
  });
  it("lookup: latest row at or before t, 0 when no extension, null when never checked", () => {
    const db = new Db(":memory:");
    migrate(db);
    db.insert("token_security", { token: "A", ts: 1000, transfer_fee_bps: 250, mint_auth_active: 0, source: "test" });
    db.insert("token_security", { token: "B", ts: 1000, transfer_fee_bps: null, mint_auth_active: 0, source: "test" });
    const f = transferFeeLookup(db);
    expect(f("A", 999)).toBeNull();
    expect(f("A", 4_000_000)).toBe(250);
    expect(f("B", 4_000_000)).toBe(0);
    expect(f("C", 4_000_000)).toBeNull();
  });
});

describe("position size vs liquidity (stage 3)", () => {
  it("flag (default): journals the size as % of TVL and opens as requested", () => {
    const { sim } = setup();
    const p = open(sim, {}, 20_000); // $1000 of $20k = 5%
    expect(p.status).toBe("active");
    expect(p.sizePctTvl).toBeCloseTo(5, 9);
    expect(p.spec.capitalUsd).toBe(1000);
  });
  it("cap: shrinks the position to max_pct_of_tvl; skip: refuses it", () => {
    const capped = setup((c) => (c.simulation.size_limit.mode = "cap"));
    const p = open(capped.sim, {}, 20_000); // limit 2% = $400
    expect(p.status).toBe("active");
    expect(p.spec.capitalUsd).toBeCloseTo(400, 6);
    expect(p.cappedFromUsd).toBe(1000);
    const skipped = setup((c) => (c.simulation.size_limit.mode = "skip"));
    const q = open(skipped.sim, {}, 20_000);
    expect(q.status).toBe("failed");
    expect(q.failReason).toBe("oversized_vs_tvl");
    const fine = setup((c) => (c.simulation.size_limit.mode = "skip"));
    expect(open(fine.sim, {}, 1_000_000).status).toBe("active"); // 0.1% of the pool
  });
  it("unknown TVL: no limit, size unknown", () => {
    const { sim } = setup((c) => (c.simulation.size_limit.mode = "skip"));
    const p = open(sim, {});
    expect(p.status).toBe("active");
    expect(p.sizePctTvl).toBeNull();
  });
});

describe("collect fee mode (stage 3): the accumulators already carry the mode", () => {
  it("quote-only pool: fee accrues in Y only, so no fee in the risky token", () => {
    const run = (mode: 0 | 1) => {
      const { sim } = setup();
      void mode;
      sim.onState(state(0, 0));
      sim.onBins(snapshot(0, 0));
      const p = sim.request(spec(), 0);
      sim.onState(state(3000, 0));
      sim.onBins(snapshot(4000, 0)); // fees accrue over intervals that start after the open
      // one minute later every bin's accumulator grew: mode 1 in Y only, mode 0 in both tokens
      const grown = snapshot(60_000, 0, mode === 0 ? Q64 / 1000n : 0n, Q64 / 1000n);
      sim.onState(state(60_000, 0));
      sim.onBins(grown);
      return p;
    };
    const quoteOnly = run(1);
    const both = run(0);
    expect(quoteOnly.feeX).toBe(0);
    expect(quoteOnly.feeY).toBeGreaterThan(0);
    expect(both.feeX).toBeGreaterThan(0);
    expect(both.feeY).toBeGreaterThan(0);
  });
  it("swap-event attribution follows the mode: legacy swaps pay on the input token, or on Y in quote-only pools", () => {
    const ev = { swapForY: true, feesOnTokenX: null } as never;
    expect(feeOnTokenX(ev, 0)).toBe(true);
    expect(feeOnTokenX(ev, 1)).toBe(false);
  });
});

describe("tracker PnL and break-even (stage 3 report)", () => {
  it("break-even is the trade's cost in % of capital; tracker PnL is net + cost; cost shares exclude refundable rent", () => {
    const db = new Db(":memory:");
    migrate(db);
    const cv = registerConfigVersion(db, loadConfig());
    db.insert("sessions", { session_id: "S", kind: "session", start_at: 0, status: "completed", config_version: cv });
    db.insert("pools", { pool: "P", token_x: "T", token_y: "USD", decimals_x: 6, decimals_y: 6, bin_step: 100, category: "memecoin", first_seen_at: 0, last_checked_at: 0 });
    const add = (id: string, net: number, costs: { type: string; usd: number; refundable: boolean }[]) => {
      db.insert("sim_positions", {
        position_id: id, session_id: "S", pool: "P", grid_combo: "{}", entry_mode: "all_pools_baseline", strategy: "spot", sides: "two_sided", bins_below: 1, bins_above: 1,
        capital_usd: 1000, requested_at: 0, gap_tainted: 0, config_version: cv, status: "closed",
        exit_policy_params: JSON.stringify({ type: "time_stop" }),
      });
      db.insert("sim_results", { position_id: id, net_pnl_usd: net, net_pnl_pct: net / 10, cost_usd: costs.filter((c) => !c.refundable).reduce((s, c) => s + c.usd, 0), detail: JSON.stringify({ costs }) });
    };
    // A: tracker +5.0% ($50), cost $10 (swap 6, tx 1, tax 3) -> net +4.0%; B: tracker +0.5%, cost $20 (swap 20) -> net -1.5%
    add("A", 40, [{ type: "balancing_swap", usd: 6, refundable: false }, { type: "tx_open", usd: 1, refundable: false }, { type: "transfer_tax", usd: 3, refundable: false }, { type: "position_rent", usd: 9, refundable: true }]);
    add("B", -15, [{ type: "exit_swap", usd: 20, refundable: false }]);
    const md = breakEvenMarkdown(db, "S");
    const line = md.split("\n").find((l) => l.startsWith("| all_pools_baseline"))!;
    const cells = line.split("|").map((x) => x.trim());
    expect(cells[2]).toBe("2"); // n
    expect(cells[3]).toBe("2.750"); // tracker avg: (5.0 + 0.5) / 2
    expect(cells[5]).toBe("1.500"); // break-even avg: (1.0 + 2.0) / 2
    expect(cells[7]).toBe("50%"); // only A beats its break-even
    expect(cells[8]).toBe("87%"); // swap: (6 + 20) / 30
    expect(cells[10]).toBe("10%"); // tax: 3 / 30
    expect(md).toMatch(/\| time_stop \| 2 \|/);
  });
});
