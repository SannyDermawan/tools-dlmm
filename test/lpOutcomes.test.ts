import { describe, expect, it } from "vitest";
import { Db, migrate } from "../src/db/index.ts";
import {
  downsideOf, groupOutcomes, holdBucket, kaplanMeier, loadCohort, lpOutcomes, lpOutcomesMarkdown, medianClose, survivalAt, widthBucket, type CohortRow,
} from "../src/analysis/lpOutcomes.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 29, 0, 0);

describe("Kaplan-Meier time to close", () => {
  const km = kaplanMeier([
    { t: 10, event: true },
    { t: 20, event: false }, // still open when we stopped watching
    { t: 30, event: true },
    { t: 40, event: true },
  ]);

  it("handles censoring: the censored position leaves the risk set without counting as a close", () => {
    expect(km.map((k) => [k.t, k.s, k.atRisk])).toEqual([[10, 0.75, 4], [30, 0.375, 2], [40, 0, 1]]);
    expect(survivalAt(km, 5, 40)).toBe(1);
    expect(survivalAt(km, 25, 40)).toBe(0.75);
    expect(survivalAt(km, 30, 40)).toBe(0.375);
    expect(medianClose(km)).toBe(30);
  });

  it("beyond the longest observation there is no information (null), not an extrapolation", () => {
    expect(survivalAt(km, 41, 40)).toBeNull();
    expect(survivalAt([], 10, 5)).toBeNull();
  });

  it("all still open: survival stays 1 and the median is not reached (a naive closed-only view would say otherwise)", () => {
    const open = kaplanMeier([{ t: 5, event: false }, { t: 50, event: false }]);
    expect(open).toEqual([]);
    expect(survivalAt(open, 30, 50)).toBe(1);
    expect(medianClose(open)).toBeNull();
    // one quick close among many long-open positions: the estimate reflects the long ones too
    const mixed = kaplanMeier([{ t: 5, event: true }, ...Array.from({ length: 9 }, () => ({ t: 600, event: false }))]);
    expect(survivalAt(mixed, 60, 600)).toBeCloseTo(0.9, 9); // naive "closed positions lasted 5 min" ignores the 9 others
  });
});

describe("range width of a real position", () => {
  it("quote-only: all bins below the active bin; base-only: none; two-sided: from the active bin at open, else symmetric", () => {
    const at = (o: Partial<Parameters<typeof downsideOf>[0]>) => downsideOf({ sides: "quote_only", bins: 70, lower_bin: -69, open_active_bin: null, ...o }, 100);
    expect(at({})!).toBeCloseTo(50, 0); // 69 bins below at step 100
    expect(at({ sides: "base_only" })).toBe(0);
    expect(at({ sides: "two_sided", lower_bin: -34, open_active_bin: 0, bins: 69 })!).toBeCloseTo(100 * (1 - 1.01 ** -34), 9);
    expect(at({ sides: "two_sided", bins: 69, lower_bin: null })!).toBeCloseTo(100 * (1 - 1.01 ** -34), 9); // symmetric fallback
    expect(at({ bins: null })).toBeNull();
  });

  it("buckets", () => {
    const r = (o: Partial<CohortRow>): CohortRow => ({
      position: "x", pool: "P", wallet: "W", minutes: 30, closed: true, pnlPct: 1, pnlUsd: 1, depositUsd: 100, feeUsd: 1, sides: "quote_only", shape: "bidask", bins: 70, downsidePct: 50, ...o,
    });
    expect(widthBucket(r({ downsidePct: 50 }))).toBe("4) 50-70%");
    expect(widthBucket(r({ downsidePct: 92 }))).toBe("6) >= 85%");
    expect(widthBucket(r({ downsidePct: null }))).toBe("unknown");
    expect(widthBucket(r({ sides: "base_only", downsidePct: 0 }))).toBe("0) none (base-only)");
    expect(holdBucket(r({ minutes: 59 }))).toBe("1) < 1 h");
    expect(holdBucket(r({ minutes: 2000, closed: false }))).toBe("4) 1-3 d (still open)");
  });
});

describe("cohort from the database", () => {
  const setup = () => {
    const db = new Db(":memory:");
    migrate(db);
    db.insert("pools", { pool: "P", token_x: "T", token_y: "USD", decimals_x: 6, decimals_y: 6, bin_step: 100, category: "memecoin", first_seen_at: 0, last_checked_at: 0 });
    const sight = (position: string, o: { first: number; last: number; gone?: number | null; isNew?: number; wallet?: string; shape?: string | null }) =>
      db.insert("lp_position_sightings", {
        position, pool: "P", wallet: o.wallet ?? "W1", first_seen_at: o.first, last_seen_at: o.last, gone_at: o.gone ?? null, new_in_scan: o.isNew ?? 1, shape: o.shape ?? null,
      });
    const pnl = (position: string, o: { pct: number; dep?: number; closed?: boolean; sides?: string; bins?: number; shape?: string | null; openedAt?: number; closedAt?: number | null }) =>
      db.insert("real_lp_positions", {
        position, wallet: "W1", pool: "P", opened_at: o.openedAt ?? null, closed_at: o.closedAt ?? null, is_closed: o.closed ? 1 : 0, bins: o.bins ?? 70, lower_bin: -69,
        sides: o.sides ?? "quote_only", shape: o.shape ?? "bidask", deposit_usd: o.dep ?? 100, net_pnl_usd: (o.pct * (o.dep ?? 100)) / 100, net_pnl_pct: o.pct, source: "meteora_api", fetched_at: 0,
      });
    return { db, sight, pnl };
  };

  it("only positions that opened while watched; closed by disappearance or by the API; open ones censored at the last sighting", () => {
    const { db, sight, pnl } = setup();
    sight("a", { first: T0, last: T0 + 30 * MIN, gone: T0 + 35 * MIN }); // closed after 35 min (from the scans alone)
    sight("b", { first: T0, last: T0 + 5 * HOUR }); // still open, seen for 5 h
    sight("c", { first: T0, last: T0 + HOUR, isNew: 0 }); // was already there at our first scan: not in the cohort
    sight("d", { first: T0 + 10 * MIN, last: T0 + 20 * MIN });
    pnl("a", { pct: -3 });
    pnl("b", { pct: 8 });
    pnl("d", { pct: 2, closed: true, openedAt: T0 + 9 * MIN, closedAt: T0 + 40 * MIN }); // the API says closed (we had not noticed yet)
    const { rows, sightings } = loadCohort(db);
    expect(sightings).toBe(3);
    const by = (p: string) => rows.find((r) => r.position === p)!;
    expect(by("a")).toMatchObject({ closed: true, minutes: 35 });
    expect(by("b")).toMatchObject({ closed: false, minutes: 300 });
    expect(by("d")).toMatchObject({ closed: true, minutes: 31 }); // API open / close times when known
    expect(rows.find((r) => r.position === "c")).toBeUndefined();
  });

  it("PnL only where a wallet fetch reached the position and the deposit is large enough; the width comes from the range", () => {
    const { db, sight, pnl } = setup();
    sight("a", { first: T0, last: T0 + HOUR, gone: T0 + HOUR });
    sight("b", { first: T0, last: T0 + HOUR });
    sight("c", { first: T0, last: T0 + HOUR });
    pnl("a", { pct: 5 });
    pnl("c", { pct: 50, dep: 5 }); // dust deposit
    const { rows } = loadCohort(db, { minDepositUsd: 20 });
    const by = (p: string) => rows.find((r) => r.position === p)!;
    expect(by("a").pnlPct).toBe(5);
    expect(by("b").pnlPct).toBeNull(); // no PnL row yet
    expect(by("c").pnlPct).toBeNull(); // below the minimum deposit
    expect(by("a").downsidePct).toBeCloseTo(50, 0);
  });

  it("filters: pools and first-seen time", () => {
    const { db, sight } = setup();
    db.insert("pools", { pool: "Q", token_x: "T2", token_y: "USD", decimals_x: 6, decimals_y: 6, bin_step: 80, category: "memecoin", first_seen_at: 0, last_checked_at: 0 });
    sight("a", { first: T0, last: T0 + HOUR });
    sight("b", { first: T0 + 3 * HOUR, last: T0 + 4 * HOUR });
    db.insert("lp_position_sightings", { position: "q1", pool: "Q", wallet: "W2", first_seen_at: T0, last_seen_at: T0 + HOUR, new_in_scan: 1 });
    expect(loadCohort(db, { pools: ["P"] }).rows.map((r) => r.position).sort()).toEqual(["a", "b"]);
    expect(loadCohort(db, { since: T0 + 2 * HOUR }).rows.map((r) => r.position)).toEqual(["b"]);
  });
});

describe("outcome tables and report", () => {
  const row = (o: Partial<CohortRow>): CohortRow => ({
    position: Math.random().toString(), pool: "P", wallet: "W", minutes: 60, closed: true, pnlPct: 0, pnlUsd: 0, depositUsd: 100, feeUsd: 0, sides: "quote_only", shape: "bidask", bins: 70, downsidePct: 50, ...o,
  });

  it("all vs closed-only: open positions enter at their mark and are counted; closed-only stays separate", () => {
    const rows = [
      row({ pnlPct: 4, closed: true, wallet: "A" }),
      row({ pnlPct: -2, closed: true, wallet: "B" }),
      row({ pnlPct: -30, closed: false, minutes: 3000, wallet: "C" }), // long hold still under water: invisible in closed-only
      row({ pnlPct: null, closed: false, wallet: "D" }), // no PnL: counted in n, not in the statistics
    ];
    const [g] = groupOutcomes(rows, () => "g");
    expect(g).toMatchObject({ n: 4, withPnl: 3, closed: 2, open: 2, wallets: 4 });
    expect(g.meanClosed).toBeCloseTo(1, 9);
    expect(g.meanAll).toBeCloseTo((4 - 2 - 30) / 3, 9);
    expect(g.winAll).toBeCloseTo(1 / 3, 9);
    expect(g.winClosed).toBeCloseTo(0.5, 9);
    expect(g.medianAll).toBe(-2);
  });

  it("report: coverage, survival horizons and tables; an empty database says what to run", () => {
    const db = new Db(":memory:");
    migrate(db);
    expect(lpOutcomesMarkdown(lpOutcomes(db))).toMatch(/No real LP position was seen opening/);
    db.insert("pools", { pool: "P", token_x: "T", token_y: "USD", decimals_x: 6, decimals_y: 6, bin_step: 100, category: "memecoin", first_seen_at: 0, last_checked_at: 0 });
    for (let i = 0; i < 6; i++) {
      db.insert("lp_position_sightings", { position: `p${i}`, pool: "P", wallet: `W${i}`, first_seen_at: T0, last_seen_at: T0 + (i + 1) * HOUR, gone_at: i < 3 ? T0 + (i + 1) * HOUR : null, new_in_scan: 1 });
      db.insert("real_lp_positions", {
        position: `p${i}`, wallet: `W${i}`, pool: "P", opened_at: T0, is_closed: i < 3 ? 1 : 0, bins: 70, lower_bin: -69, sides: "quote_only", shape: "bidask", deposit_usd: 100,
        net_pnl_usd: i - 2, net_pnl_pct: i - 2, source: "meteora_api", fetched_at: 0,
      });
    }
    const r = lpOutcomes(db, { minDepositUsd: 20 });
    expect(r.cohort).toMatchObject({ sightings: 6, closed: 3, open: 3, withPnl: 6, wallets: 6, pools: 1 });
    expect(r.survival.find((s) => s.hours === 1)!.surv).toBeCloseTo(5 / 6, 9); // 1 of 6 closed within 1 h
    expect(r.survival.find((s) => s.hours === 72)!.surv).toBeNull(); // nobody was observed that long
    const md = lpOutcomesMarkdown(r);
    expect(md).toMatch(/\*\*6\*\* positions that opened while we watched/);
    expect(md).toMatch(/By range width/);
    expect(md).toMatch(/72 h: no data/);
    expect(md).toMatch(/still open/);
  });
});
