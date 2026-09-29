import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import {
  eventCounts, parsePnlPosition, RealLpCollector, recomputeWallets, shapeFromShares, sidesFromDeposits, upsertRealPosition, type ApiPositionPnl,
} from "../src/collectors/realLp.ts";
import { SmartLpLookup } from "../src/features/smartLp.ts";
import { realSpec, type RealRow } from "../src/analysis/realism.ts";
import { distributeLiquidity } from "../src/sim/distribution.ts";
import { binRawPrice } from "../src/math/bin.ts";

const cfg = (): Config => structuredClone(loadConfig().config);
const newDb = () => {
  const db = new Db(":memory:");
  migrate(db);
  return db;
};
const HOUR = 3_600_000;
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const log = { warn() {}, info() {}, error() {}, debug() {} } as never;

const apiPos = (o: Partial<ApiPositionPnl> = {}): ApiPositionPnl => ({
  positionAddress: "POS1", lowerBinId: 90, upperBinId: 110, isClosed: true, createdAt: 1000, closedAt: 4600,
  pnlUsd: "12.5", pnlPctChange: "5",
  allTimeDeposits: { tokenX: { amount: "10", usd: "100" }, tokenY: { amount: "150", usd: "150" }, total: { usd: "250" } },
  allTimeWithdrawals: { total: { usd: "255" } }, allTimeFees: { total: { usd: "7.5" } }, unrealizedPnl: null, ...o,
});

describe("real LP parsing (addendum 4.2)", () => {
  it("maps the Data API position (seconds -> ms, sides, fees incl. unclaimed while open)", () => {
    const r = parsePnlPosition(apiPos(), "POOL", "W", 9_999_000);
    expect(r).toMatchObject({
      position: "POS1", wallet: "W", pool: "POOL", opened_at: 1_000_000, closed_at: 4_600_000, is_closed: 1, bins: 21, sides: "two_sided",
      deposit_usd: 250, deposit_x_usd: 100, deposit_y_usd: 150, withdraw_usd: 255, fee_usd: 7.5, net_pnl_usd: 12.5, net_pnl_pct: 5, duration_min: 60,
    });
    const open = parsePnlPosition(
      apiPos({ isClosed: false, closedAt: null, unrealizedPnl: { unclaimedFeeTokenX: { usd: "1" }, unclaimedFeeTokenY: { usd: "2" } } }), "POOL", "W", 1_000_000 + 30 * 60_000,
    );
    expect(open).toMatchObject({ closed_at: null, is_closed: 0, fee_usd: 10.5, duration_min: 30 });
  });
  it("sides from deposits", () => {
    expect(sidesFromDeposits(1, 1)).toBe("two_sided");
    expect(sidesFromDeposits(0, 5)).toBe("quote_only");
    expect(sidesFromDeposits(5, 0)).toBe("base_only");
    expect(sidesFromDeposits(0, 0)).toBeNull();
  });
  it("event counts: simple = one add and removes only at the close", () => {
    const ev = (t: string, s: number) => ({ eventType: t, blockTime: s * 1000, totalUsd: "1" });
    expect(eventCounts([ev("add", 0), ev("remove", 100), ev("claim_fee", 100)], 100_000, 60)).toEqual({ add: 1, remove: 1, claim: 1, rebalance: 0, simple: true });
    expect(eventCounts([ev("add", 0), ev("remove", 30), ev("remove", 100)], 100_000, 60).simple).toBe(false); // partial withdrawal
    expect(eventCounts([ev("add", 0), ev("add", 50), ev("remove", 100)], 100_000, 60)).toMatchObject({ rebalance: 1, simple: false });
  });
  it("upsert keeps event counts and shape across refetches", () => {
    const db = newDb();
    upsertRealPosition(db, parsePnlPosition(apiPos({ isClosed: false, closedAt: null }), "P", "W", 2_000_000));
    db.run("UPDATE real_lp_positions SET add_count = 1, shape = 'spot'");
    upsertRealPosition(db, parsePnlPosition(apiPos(), "P", "W", 5_000_000));
    expect(db.get("SELECT is_closed, add_count, shape, fetched_at FROM real_lp_positions")).toMatchObject({ is_closed: 1, add_count: 1, shape: "spot", fetched_at: 5_000_000 });
  });
});

describe("distribution shape from liquidity shares", () => {
  // shares = per-bin liquidity of the SDK distributions, so the classifier is checked against the
  // simulator's own shapes
  const shares = (strategy: "spot" | "curve" | "bidask", sides: "two_sided" | "quote_only", n: number) => {
    const range = { strategy, sides, binsBelow: n, binsAbove: sides === "two_sided" ? n : 0 };
    const d = distributeLiquidity(1000, 100, range, 10n ** 12n, 10n ** 12n).sort((a, b) => a.binId - b.binId);
    return d.map((b) => Number(b.x) * binRawPrice(b.binId, 100) + Number(b.y));
  };
  for (const sides of ["two_sided", "quote_only"] as const)
    for (const strategy of ["spot", "curve", "bidask"] as const)
      it(`${strategy} / ${sides}`, () => {
        const s = shares(strategy, sides, 20);
        const lower = 1000 - 20;
        expect(shapeFromShares(s, lower, 1000).shape).toBe(strategy);
      });
  it("too few bins -> unknown", () => expect(shapeFromShares([1, 0, 0], 0, 0).shape).toBeNull());
});

describe("smart LP wallets (addendum 4.3)", () => {
  const seed = (db: Db) => {
    // wallet A: 10 closed winners before t0; wallet B: 10 closed losers; A and B open in pool P at t0
    for (let i = 0; i < 10; i++) {
      for (const [w, pct] of [["A", 4], ["B", -3]] as const)
        upsertRealPosition(db, { position: `${w}${i}`, wallet: w, pool: "Q", opened_at: i * HOUR, closed_at: i * HOUR + 1000, is_closed: 1, net_pnl_usd: pct, net_pnl_pct: pct, source: "t", fetched_at: 0 });
    }
    upsertRealPosition(db, { position: "Aopen", wallet: "A", pool: "P", opened_at: 20 * HOUR, closed_at: 30 * HOUR, is_closed: 1, net_pnl_usd: 1, net_pnl_pct: 1, source: "t", fetched_at: 0 });
    upsertRealPosition(db, { position: "Bopen", wallet: "B", pool: "P", opened_at: 20 * HOUR, closed_at: null, is_closed: 0, source: "t", fetched_at: 0 });
  };
  it("lp_wallets flags consistent winners only", () => {
    const db = newDb();
    seed(db);
    recomputeWallets(db, cfg().real_lp.smart);
    const r = db.all<{ wallet: string; status_smart: number; closed_positions: number }>("SELECT wallet, status_smart, closed_positions FROM lp_wallets ORDER BY wallet");
    expect(r).toEqual([{ wallet: "A", status_smart: 1, closed_positions: 11 }, { wallet: "B", status_smart: 0, closed_positions: 10 }]);
  });
  it("presence at t is look-ahead safe (smart status from closes before t, open at t)", () => {
    const db = newDb();
    seed(db);
    const s = new SmartLpLookup(db, cfg().real_lp.smart, ["P"], 0);
    expect(s.at("P", 19 * HOUR)).toEqual({ count: 0, openPositions: 0 }); // nothing open yet
    expect(s.at("P", 25 * HOUR)).toEqual({ count: 1, openPositions: 2 }); // A smart and open, B open but not smart
    expect(s.at("P", 31 * HOUR)).toEqual({ count: 0, openPositions: 1 }); // A closed at 30 h
    expect(s.at("OTHER", 25 * HOUR)).toBeNull();
    // A is not smart before its 10th close
    const early = new SmartLpLookup(db, cfg().real_lp.smart, ["Q"], 0);
    expect(early.isSmart("A", 5 * HOUR)).toBe(false);
  });
});

describe("real LP collector (mocked chain + API)", () => {
  const mkMeta = (pool: string) => ({ pool } as never);
  it("scan diff: first scan is the baseline, later scans report appeared / gone positions", async () => {
    const db = newDb();
    let owners: [string, number][] = [["pos1", 1], ["pos2", 2]];
    const rpc = {
      commitment: "confirmed",
      call: async (m: string) => {
        expect(m).toBe("getProgramAccounts");
        return owners.map(([pubkey, n]) => ({ pubkey, account: { data: [Buffer.alloc(32, n).toString("base64"), "base64"] } }));
      },
      getMultipleAccounts: async () => ({ slot: 0, accounts: [] }),
    };
    const pages: Record<string, unknown> = {};
    const api = {
      get: async (path: string, q: Record<string, unknown>) => {
        if (path.includes("/pnl")) {
          pages[`${q.user}|${q.page}`] = true;
          return { positions: [apiPos({ positionAddress: `api-${q.user}-${q.page}` })], hasNext: q.page === 1 };
        }
        return { events: [] };
      },
    };
    const c = cfg();
    c.real_lp.max_pages_per_wallet = 2;
    const col = new RealLpCollector({ db, rpc: rpc as never, api: api as never, config: c, log, pools: new Map([["POOL", mkMeta("POOL")]]) });
    const a = await col.scanPool("POOL", 1000);
    expect(a).toEqual({ open: 2, appeared: [], gone: [] });
    owners = [["pos2", 2], ["pos3", 3]];
    const b = await col.scanPool("POOL", 2000);
    expect(b).toEqual({ open: 2, appeared: ["pos3"], gone: ["pos1"] });
    expect(db.get("SELECT wallet, new_in_scan FROM lp_position_sightings WHERE position = 'pos3'")).toEqual({ wallet: pk(3), new_in_scan: 1 });
    // queue: wallets of changed positions first
    const q = col.walletQueue(["pos3", "pos1"], 2000);
    expect(q.slice(0, 2).map((x) => x.wallet).sort()).toEqual([pk(1), pk(3)].sort());
    // paging: stops at hasNext = false or max pages
    expect(await col.fetchWallet(pk(3), "POOL", 2000)).toBe(2);
    expect(db.get("SELECT positions, error FROM lp_wallet_fetches WHERE wallet = ?", pk(3))).toEqual({ positions: 2, error: null });
  });
});

describe("realism spec (addendum 4.3)", () => {
  const row = (o: Partial<RealRow>): RealRow => ({
    position: "X", pool: "P", opened_at: 0, closed_at: HOUR, lower_bin: 90, upper_bin: 110, shape: null, sides: "two_sided",
    deposit_usd: 100, deposit_x_usd: 50, fee_usd: 1, net_pnl_usd: 1, open_active_bin: 100, ...o,
  });
  it("maps the absolute range to bins around the active bin at open", () => {
    expect(realSpec(row({}))).toMatchObject({ spec: { strategy: "spot", sides: "two_sided", binsBelow: 10, binsAbove: 10, capitalUsd: 100 } });
    expect(realSpec(row({ sides: "quote_only", lower_bin: 31, upper_bin: 99, shape: "bidask" }))).toMatchObject({ spec: { strategy: "bidask", binsBelow: 69, binsAbove: 0 } });
    expect(realSpec(row({ sides: "base_only", lower_bin: 100, upper_bin: 120 }))).toMatchObject({ spec: { binsBelow: 0, binsAbove: 20 } });
  });
  it("skips what cannot be replayed one-to-one", () => {
    expect(realSpec(row({ open_active_bin: null }))).toEqual({ skip: "no pool state at open" });
    expect(realSpec(row({ open_active_bin: 150 }))).toEqual({ skip: "active bin outside a two-sided range" });
    expect(realSpec(row({ sides: "quote_only", lower_bin: 40, upper_bin: 80 }))).toEqual({ skip: "quote-only range detached from the price" });
  });
});
