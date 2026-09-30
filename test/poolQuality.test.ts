import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { BinObs, BinSnapshot } from "../src/collectors/types.ts";
import type { PricePoint } from "../src/features/tracker.ts";
import { binUtilization, priceChangePct, realizedVolatilityPct, volumeAuthenticity } from "../src/features/poolQuality.ts";

const MIN = 60_000;
const pt = (ts: number, price: number): PricePoint => ({ ts, price, activeId: 0, feeRate: 0.01 });
const CFG = loadConfig().config.simulation.volume_authenticity;

describe("realizedVolatilityPct / priceChangePct", () => {
  it("null with fewer than 3 one-minute closes (2 returns needed)", () => {
    expect(realizedVolatilityPct([pt(0, 1), pt(MIN, 1.01)], 2 * MIN, 5 * MIN)).toBeNull();
    // many raw points inside two minutes are still only two closes
    const dense = Array.from({ length: 24 }, (_, i) => pt(i * 5_000, 1 + i * 0.001));
    expect(realizedVolatilityPct(dense, 2 * MIN - 1, 5 * MIN)).toBeNull();
  });

  it("0 for a flat price, > 0 once the price moves", () => {
    const flat = [pt(0, 1), pt(MIN, 1), pt(2 * MIN, 1), pt(3 * MIN, 1)];
    expect(realizedVolatilityPct(flat, 3 * MIN, 5 * MIN)).toBeCloseTo(0, 9);
    const moving = [pt(0, 1), pt(MIN, 1.1), pt(2 * MIN, 0.9), pt(3 * MIN, 1.05)];
    expect(realizedVolatilityPct(moving, 3 * MIN, 5 * MIN)!).toBeGreaterThan(0);
  });

  it("does not depend on the sampling rate: dense ticks inside each minute give the same figure", () => {
    const closes = [1, 1.1, 0.9, 1.05];
    const sparse = closes.map((p, i) => pt(i * MIN + 50_000, p));
    // same minute closes, but the feed also ticked every 5 s at the previous minute's price
    const dense: PricePoint[] = [];
    closes.forEach((p, i) => {
      for (let s = 0; s < 10; s++) dense.push(pt(i * MIN + s * 5_000, i === 0 ? p : closes[i - 1]));
      dense.push(pt(i * MIN + 50_000, p));
    });
    const a = realizedVolatilityPct(sparse, 4 * MIN, 5 * MIN)!;
    const b = realizedVolatilityPct(dense, 4 * MIN, 5 * MIN)!;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeCloseTo(a, 9);
  });

  it("only counts points inside (t - window, t]: older points are ignored (look-ahead and staleness safe)", () => {
    const prices = [pt(-100 * MIN, 5), pt(0, 1), pt(MIN, 1.01), pt(2 * MIN, 0.99)];
    const v = realizedVolatilityPct(prices, 2 * MIN, 5 * MIN);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(5); // the old 5.0 outlier would make it huge
  });

  it("priceChangePct is signed (not absolute), null with < 2 points", () => {
    expect(priceChangePct([pt(0, 1)], MIN, 5 * MIN)).toBeNull();
    expect(priceChangePct([pt(0, 1), pt(MIN, 1.2)], MIN, 5 * MIN)).toBeCloseTo(20, 9);
    expect(priceChangePct([pt(0, 1), pt(MIN, 0.5)], MIN, 5 * MIN)).toBeCloseTo(-50, 9);
  });
});

describe("binUtilization", () => {
  const snap = (binIds: number[], lower = 0, upper = 9): BinSnapshot => {
    const bins = new Map<number, BinObs>();
    for (const id of binIds) bins.set(id, { binId: id, x: 1n, y: 1n, supply: 1n, feeX: 0n, feeY: 0n, priceRaw: 1 });
    return { pool: "P", ts: 0, slot: 0, activeId: 0, lower, upper, missingBinArrays: [], bins };
  };

  it("null without a snapshot", () => {
    expect(binUtilization(null)).toBeNull();
  });

  it("share of the [lower, upper] window with supply > 0", () => {
    expect(binUtilization(snap([0, 1, 2], 0, 9))).toBeCloseTo(3 / 10, 9);
    expect(binUtilization(snap([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0, 9))).toBeCloseTo(1, 9);
  });
});

describe("volumeAuthenticity (prism-liquidity-agent's checkVolumeAuthenticity)", () => {
  const clean = { tvlUsd: 100_000, volume24hUsd: 100_000, fee1hUsd: 2, volume1hUsd: 1_000 }; // fee rate 0.2%

  it("null when TVL or 24 h volume is unknown (never a made-up 1)", () => {
    expect(volumeAuthenticity({ ...clean, tvlUsd: null }, CFG)).toBeNull();
    expect(volumeAuthenticity({ ...clean, volume24hUsd: null }, CFG)).toBeNull();
  });

  it("1 for a healthy pool; TVL of 0 scores 0", () => {
    expect(volumeAuthenticity(clean, CFG)).toEqual({ score: 1, flags: [] });
    expect(volumeAuthenticity({ ...clean, tvlUsd: 0 }, CFG)).toEqual({ score: 0, flags: ["zero-tvl"] });
  });

  it("subtracts 0.15 above 5x and 0.3 above 10x volume / TVL (Prism's constants)", () => {
    expect(volumeAuthenticity({ ...clean, volume24hUsd: 700_000 }, CFG)!.score).toBeCloseTo(0.85, 9); // 7x
    expect(volumeAuthenticity({ ...clean, volume24hUsd: 1_500_000 }, CFG)!.score).toBeCloseTo(0.7, 9); // 15x
    expect(volumeAuthenticity({ ...clean, volume24hUsd: 500_000 }, CFG)!.score).toBe(1); // exactly 5x is not elevated
  });

  it("subtracts 0.2 for a measured fee rate outside 0.02% .. 2%, and skips the check without measured fees", () => {
    expect(volumeAuthenticity({ ...clean, fee1hUsd: 50 }, CFG)!.score).toBeCloseTo(0.8, 9); // 5%
    expect(volumeAuthenticity({ ...clean, fee1hUsd: 0 }, CFG)!.score).toBeCloseTo(0.8, 9); // 0%
    expect(volumeAuthenticity({ ...clean, fee1hUsd: null }, CFG)!.score).toBe(1);
    expect(volumeAuthenticity({ ...clean, volume1hUsd: 0 }, CFG)!.score).toBe(1);
  });

  it("subtracts 0.5 for TVL under $5k with 24 h volume over $100k, and never goes below 0", () => {
    expect(volumeAuthenticity({ ...clean, tvlUsd: 4_000, volume24hUsd: 120_000 }, CFG)!.score).toBeCloseTo(1 - 0.3 - 0.5, 9); // 30x also trips the 10x rule
    const worst = volumeAuthenticity({ tvlUsd: 100, volume24hUsd: 1_000_000, fee1hUsd: 900, volume1hUsd: 1_000 }, CFG)!;
    expect(worst.score).toBe(0); // 1 - 0.3 - 0.2 - 0.5
    expect(worst.flags).toHaveLength(3);
  });
});
