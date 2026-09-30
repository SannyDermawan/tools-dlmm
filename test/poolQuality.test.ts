import { describe, expect, it } from "vitest";
import type { BinObs, BinSnapshot } from "../src/collectors/types.ts";
import type { PricePoint } from "../src/features/tracker.ts";
import { binUtilization, priceChangePct, realizedVolatilityPct, volumeAuthenticity } from "../src/features/poolQuality.ts";

const MIN = 60_000;
const pt = (ts: number, price: number): PricePoint => ({ ts, price, activeId: 0, feeRate: 0.01 });

const AUTH_CFG = { max_volume_tvl_ratio: 10, fee_rate_min_pct: 0.02, fee_rate_max_pct: 2, low_tvl_usd: 10_000, low_tvl_volume_tvl_ratio: 5 };

describe("realizedVolatilityPct / priceChangePct", () => {
  it("null with fewer than 3 points in the window (2 returns needed)", () => {
    expect(realizedVolatilityPct([pt(0, 1), pt(MIN, 1.01)], 2 * MIN, 5 * MIN)).toBeNull();
  });

  it("0 for a flat price, > 0 once the price moves", () => {
    const flat = [pt(0, 1), pt(MIN, 1), pt(2 * MIN, 1), pt(3 * MIN, 1)];
    expect(realizedVolatilityPct(flat, 3 * MIN, 5 * MIN)).toBeCloseTo(0, 9);
    const moving = [pt(0, 1), pt(MIN, 1.1), pt(2 * MIN, 0.9), pt(3 * MIN, 1.05)];
    expect(realizedVolatilityPct(moving, 3 * MIN, 5 * MIN)!).toBeGreaterThan(0);
  });

  it("only counts points inside (t - window, t]: older points are ignored (look-ahead safe)", () => {
    const prices = [pt(-100 * MIN, 5), pt(0, 1), pt(MIN, 1.01), pt(2 * MIN, 0.99)]; // the -100 min spike is out of window
    const v = realizedVolatilityPct(prices, 2 * MIN, 5 * MIN);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(50); // would be huge if the old outlier were included
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

  it("share of the [lower, upper] window with supply > 0 (Mantis MIN_BIN_UTILIZATION)", () => {
    expect(binUtilization(snap([0, 1, 2], 0, 9))).toBeCloseTo(3 / 10, 9); // 10 bins, 3 populated
    expect(binUtilization(snap([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0, 9))).toBeCloseTo(1, 9);
  });
});

describe("volumeAuthenticity", () => {
  it("1 (clean) when nothing can be checked (missing data never fails closed)", () => {
    expect(volumeAuthenticity({ tvlUsd: null, volumeUsd: null, feeRatePct: null }, AUTH_CFG)).toBe(1);
  });

  it("penalizes a volume/TVL ratio that is too high (wash-trading shape)", () => {
    expect(volumeAuthenticity({ tvlUsd: 100_000, volumeUsd: 200_000, feeRatePct: null }, AUTH_CFG)).toBe(1); // 2x: fine
    expect(volumeAuthenticity({ tvlUsd: 100_000, volumeUsd: 2_000_000, feeRatePct: null }, AUTH_CFG)).toBe(0); // 20x: fails the one check
  });

  it("penalizes a fee rate outside the plausible band", () => {
    expect(volumeAuthenticity({ tvlUsd: null, volumeUsd: null, feeRatePct: 1 }, AUTH_CFG)).toBe(1);
    expect(volumeAuthenticity({ tvlUsd: null, volumeUsd: null, feeRatePct: 5 }, AUTH_CFG)).toBe(0);
  });

  it("an extra, stricter volume/TVL check kicks in on low-TVL pools", () => {
    // ratio 7x: passes the general 10x check but fails the low-TVL 5x check -> half the checks fail
    expect(volumeAuthenticity({ tvlUsd: 5_000, volumeUsd: 35_000, feeRatePct: null }, AUTH_CFG)).toBeCloseTo(0.5, 9);
  });

  it("combines checks: score is the fraction that pass, not a single hard fail", () => {
    // volume/TVL fine (1 check passes), fee rate bad (1 check fails) -> 0.5
    expect(volumeAuthenticity({ tvlUsd: 100_000, volumeUsd: 100_000, feeRatePct: 5 }, AUTH_CFG)).toBeCloseTo(0.5, 9);
  });
});
