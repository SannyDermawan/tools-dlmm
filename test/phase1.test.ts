import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as sdk from "@meteora-ag/dlmm";
import BN from "bn.js";
import {
  binArrayAddress, binArrayIndex, decodeBinArray, decodeLbPair, DLMM_PROGRAM_ID, extractEvents, extractSwaps, feeOnTokenX, IDL_VERSION,
} from "../src/chain/dlmm.ts";
import { loadConfig } from "../src/config/load.ts";
import { Db, migrate } from "../src/db/index.ts";
import { createSession, registerConfigVersion } from "../src/db/repo.ts";
import { categorize, selectCandidates } from "../src/collectors/discovery.ts";
import { GapTracker } from "../src/collectors/gaps.ts";
import { LruSet, logsMayContainSwap } from "../src/collectors/swapStream.ts";
import { parseMintInfo, top10Pct } from "../src/collectors/tokenSecurity.ts";
import { BinSnapshotCollector } from "../src/collectors/chainState.ts";
import { binUiPrice, q64ToNumber } from "../src/math/bin.ts";
import type { ApiPool } from "../src/api/meteora.ts";

const fx = (f: string) => JSON.parse(readFileSync(`test/fixtures/${f}`, "utf8"));
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("on-chain codec (real mainnet fixtures)", () => {
  it("uses the verified program id and IDL", () => {
    expect(DLMM_PROGRAM_ID).toBe("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
    expect(IDL_VERSION).toMatch(/^0\.\d+\.\d+$/);
  });

  it("decodes an LbPair account", () => {
    const f = fx("lbpair_sol_usdc.json");
    const lb = decodeLbPair(Buffer.from(f.data, "base64"));
    expect(lb.tokenXMint).toBe(SOL);
    expect(lb.tokenYMint).toBe(USDC);
    expect(lb.binStep).toBe(4);
    expect(lb.s.baseFactor).toBeGreaterThan(0);
    expect(lb.s.protocolShare).toBeGreaterThanOrEqual(0);
    expect(lb.s.protocolShare).toBeLessThanOrEqual(2500); // MAX_PROTOCOL_SHARE
    const price = binUiPrice(lb.activeId, lb.binStep, 9, 6);
    expect(price).toBeGreaterThan(10);
    expect(price).toBeLessThan(10000);
  });

  it("decodes a BinArray; on-chain Q64 price matches the formula", () => {
    const f = fx("binarray_sol_usdc.json");
    const arr = decodeBinArray(Buffer.from(f.data, "base64"));
    expect(arr.index).toBe(f.index);
    expect(arr.lbPair).toBe("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
    expect(arr.bins).toHaveLength(70);
    expect(arr.bins[0].binId).toBe(f.index * 70);
    for (const b of arr.bins) {
      const onChain = q64ToNumber(b.priceQ64) * 1e3;
      expect(onChain / binUiPrice(b.binId, 4, 9, 6)).toBeCloseTo(1, 9);
    }
    expect(binArrayAddress(arr.lbPair, arr.index)).toBe(f.address);
  });

  it("binArrayIndex matches the SDK for negative and positive ids", () => {
    for (const id of [-141, -71, -70, -69, -1, 0, 1, 69, 70, 139, 140, -5306, 12345]) {
      expect(binArrayIndex(id)).toBe(sdk.binIdToBinArrayIndex(new BN(id)).toNumber());
    }
  });

  it("extracts self-CPI events and de-duplicates Swap/Swap2Evt twins", () => {
    for (const f of ["tx_swap_0.json", "tx_swap_1.json"]) {
      const tx = fx(f);
      const evs = extractEvents(tx);
      expect(evs.some((e) => e.name === "Swap")).toBe(true);
      expect(evs.some((e) => e.name === "Swap2Evt")).toBe(true);
      const swaps = extractSwaps(tx).filter((s) => s.lbPair === "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
      expect(swaps).toHaveLength(1);
      const s = swaps[0];
      expect(s.eventType).toBe("Swap2Evt");
      expect(s.mmFee + s.protocolFee + s.limitOrderFee + s.hostFee).toBe(s.fee);
      // the legacy twin agrees on the fee split
      const legacy = evs.find((e) => e.name === "Swap")!.data;
      expect(BigInt(legacy.fee.toString())).toBe(s.fee);
      expect(BigInt(legacy.protocol_fee.toString())).toBe(s.protocolFee);
      // fee_bps is fee rate * 1e9: fee / amount_in within rounding
      expect(Number(s.fee) / Number(s.amountIn)).toBeCloseTo(Number(s.feeBps) / 1e9, 5);
      expect(feeOnTokenX(s, 0)).toBe(s.swapForY); // collect_fee_mode 0: fee on input
    }
  });
});

describe("discovery", () => {
  const cfg = loadConfig().config;
  const pool = (o: Partial<ApiPool> & { address: string }): ApiPool =>
    ({
      name: "A-B", token_x: { address: "X", symbol: "X", decimals: 6, price: 1 }, token_y: { address: USDC, symbol: "USDC", decimals: 6, price: 1 },
      tvl: 50_000, volume: { "1h": 10_000 }, fees: {}, protocol_fees: {}, fee_tvl_ratio: {}, is_blacklisted: false,
      created_at: Date.now() - 86_400_000, pool_config: { bin_step: 10 }, ...o,
    }) as unknown as ApiPool;

  it("categorizes bluechip only when both tokens are bluechip", () => {
    expect(categorize(SOL, USDC, cfg.categories.bluechip_tokens)).toBe("bluechip");
    expect(categorize("Meme111", USDC, cfg.categories.bluechip_tokens)).toBe("memecoin");
  });

  it("applies TVL / volume / age / blacklist / deny filters and the cap", () => {
    const c = structuredClone(cfg);
    c.discovery.max_pools = 2;
    c.discovery.pool_denylist = ["deny"];
    const r = selectCandidates(
      [
        pool({ address: "ok1" }),
        pool({ address: "lowtvl", tvl: 10 }),
        pool({ address: "lowvol", volume: { "1h": 1 } }),
        pool({ address: "young", created_at: Date.now() - 60_000 }),
        pool({ address: "black", is_blacklisted: true }),
        pool({ address: "deny" }),
        pool({ address: "ok2" }),
        pool({ address: "ok3" }),
      ],
      c,
    );
    expect(r.map((x) => x.api.address)).toEqual(["ok1", "ok2"]);
  });

  it("allowlisted pools bypass filters and count toward the cap", () => {
    const c = structuredClone(cfg);
    c.discovery.max_pools = 2;
    c.discovery.pool_allowlist = ["tiny"];
    const r = selectCandidates([pool({ address: "tiny", tvl: 1 }), pool({ address: "a" }), pool({ address: "b" })], c);
    expect(r.map((x) => x.api.address)).toEqual(["tiny", "a"]);
  });
});

describe("gap tracking", () => {
  const setup = () => {
    const db = new Db(":memory:");
    migrate(db);
    const lc = loadConfig();
    const sid = createSession(db, { kind: "collect", configVersion: registerConfigVersion(db, lc) });
    let now = 1_000_000;
    const g = new GapTracker(db, sid, { pool_state: 30 }, undefined, () => now);
    return { db, g, set: (t: number) => (now = t) };
  };

  it("watchdog opens a gap after staleness (backdated to last success) and success closes it", () => {
    const { db, g, set } = setup();
    g.register("pool_state", "P");
    g.ok("pool_state", "P", 1_000_000);
    set(1_020_000);
    g.check();
    expect(g.openGaps()).toHaveLength(0);
    set(1_040_000);
    g.check();
    expect(g.isOpen("pool_state", "P")).toBe(true);
    set(1_100_000);
    g.ok("pool_state", "P");
    const row = db.get<{ start_at: number; end_at: number }>("SELECT * FROM data_gaps")!;
    expect(row.start_at).toBe(1_000_000);
    expect(row.end_at).toBe(1_100_000);
  });

  it("explicit down is idempotent; closeAll ends open gaps", () => {
    const { db, g, set } = setup();
    g.down("swap_stream", "P", "ws");
    g.down("swap_stream", "P", "ws");
    set(1_005_000);
    g.closeAll();
    const rows = db.all<{ end_at: number }>("SELECT * FROM data_gaps");
    expect(rows).toHaveLength(1);
    expect(rows[0].end_at).toBe(1_005_000);
  });
});

describe("swap stream helpers", () => {
  it("log pre-filter keeps swaps and truncated logs, drops others", () => {
    expect(logsMayContainSwap(["Program log: Instruction: Swap2"])).toBe(true);
    expect(logsMayContainSwap(["Program log: Instruction: SwapWithPriceImpact2"])).toBe(true);
    expect(logsMayContainSwap(["Program log: Instruction: AddLiquidityByStrategy2"])).toBe(false);
    expect(logsMayContainSwap(["Log truncated"])).toBe(true);
    expect(logsMayContainSwap(null)).toBe(true);
  });

  it("LRU set evicts oldest", () => {
    const s = new LruSet(2);
    s.add("a");
    s.add("b");
    s.add("c");
    expect(s.has("a")).toBe(false);
    expect(s.has("c")).toBe(true);
  });
});

describe("token security", () => {
  it("parses mint + token-2022 transfer fee", () => {
    const m = parseMintInfo({
      owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1tNmsWvXeGFiEH9Ar",
      data: { parsed: { info: { decimals: 6, supply: "1000", mintAuthority: null, freezeAuthority: "F",
        extensions: [{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 150 }, olderTransferFee: { transferFeeBasisPoints: 100 } } }] } } },
    });
    expect(m.mintAuthority).toBeNull();
    expect(m.freezeAuthority).toBe("F");
    expect(m.transferFeeBps).toBe(150);
  });

  it("top10 excludes pool reserves and burn owners", () => {
    const largest = [
      { address: "reserve", amount: "500" },
      { address: "burned", amount: "200" },
      ...Array.from({ length: 11 }, (_, i) => ({ address: `h${i}`, amount: "10" })),
    ];
    const owners = new Map<string, string | null>([["burned", "1nc1nerator11111111111111111111111111111111"]]);
    const r = top10Pct(largest, owners, 1000n, new Set(["reserve"]));
    expect(r.pct).toBeCloseTo(10); // 10 holders * 10 / 1000
    expect(r.excluded).toEqual(["reserve", "burned"]);
  });
});

describe("bin snapshot planning", () => {
  it("covers active +- n with whole bin arrays", () => {
    const idx = BinSnapshotCollector.arrayIndexes(-5306, 70);
    expect(idx[0]).toBe(binArrayIndex(-5376));
    expect(idx[idx.length - 1]).toBe(binArrayIndex(-5236));
    expect(idx.length).toBeGreaterThanOrEqual(3);
  });
});

import { SwapBudget, swapStreamEnabled } from "../src/collectors/swapStream.ts";
import type { PoolMeta } from "../src/collectors/types.ts";

describe("swap stream budget & pool selection", () => {
  const mk = (o: Partial<ConstructorParameters<typeof SwapBudget>[0]> & { used?: number; total?: number }) =>
    new SwapBudget({
      swapBudget: 1000, sessionBudget: 2000, startTs: 0, durationMs: 100_000, pacing: true, burstPct: 10,
      swapCredits: () => o.used ?? 0, sessionCredits: () => o.total ?? 0, ...o,
    });

  it("paces spending evenly over the session with a burst allowance", () => {
    expect(mk({ used: 50 }).state(0)).toBe("ok"); // 10% burst allowed at start
    expect(mk({ used: 150 }).state(0)).toBe("paced");
    expect(mk({ used: 150 }).state(50_000)).toBe("ok"); // 60% allowed at half time
    expect(mk({ used: 999 }).allowedNow(100_000)).toBe(1000);
  });

  it("is exhausted at the swap budget or the session-wide budget; no pacing without a duration", () => {
    expect(mk({ used: 1000 }).state(99_000)).toBe("exhausted");
    expect(mk({ used: 10, total: 2000 }).state(50_000)).toBe("exhausted");
    expect(mk({ used: 900, durationMs: null }).state(0)).toBe("ok");
    expect(mk({ used: 900, pacing: false }).state(0)).toBe("ok");
  });

  it("selects pools by category with include / exclude overrides", () => {
    const cfg = loadConfig().config.collectors.swap_stream;
    const meta = (pool: string, category: "memecoin" | "bluechip") => ({ pool, category }) as PoolMeta;
    const c = { ...cfg, include_categories: ["memecoin" as const], include_pools: ["B2"], exclude_pools: ["M2"] };
    expect(swapStreamEnabled(meta("M1", "memecoin"), c)).toBe(true);
    expect(swapStreamEnabled(meta("M2", "memecoin"), c)).toBe(false);
    expect(swapStreamEnabled(meta("B1", "bluechip"), c)).toBe(false);
    expect(swapStreamEnabled(meta("B2", "bluechip"), c)).toBe(true);
  });
});

import { SwapStreamCollector } from "../src/collectors/swapStream.ts";
import { MarketBus } from "../src/collectors/types.ts";
import pino from "pino";

describe("swap stream sampling", () => {
  const setup = () => {
    const db = new Db(":memory:");
    migrate(db);
    const lc = loadConfig();
    const sid = createSession(db, { kind: "collect", configVersion: registerConfigVersion(db, lc) });
    const c = structuredClone(lc.config);
    c.collectors.swap_stream.sample_per_minute = 10;
    const bus = new MarketBus();
    const acts: { candidates: number; sampled: number }[] = [];
    bus.on("activity", (a) => acts.push(a));
    const col = new SwapStreamCollector({
      rpc: {} as never, ws: null, db, log: pino({ level: "silent" }), bus,
      gaps: new GapTracker(db, sid, {}), config: c, sessionId: sid, pools: new Map([["P", { pool: "P" } as never]]),
    });
    const x = col as unknown as { candidate(sig: string, pool: string, now?: number): void; rollMinute(p: string, m: number): void; samp: Map<string, { ewma: number | null; sampled: number; candidates: number; minute: number }>; queueLength: number };
    return { db, x, acts, col };
  };

  it("first minute: queues up to the target, counts every candidate", () => {
    const { x } = setup();
    for (let i = 0; i < 100; i++) x.candidate(`s${i}`, "P");
    const st = x.samp.get("P")!;
    expect(st.candidates).toBe(100);
    expect(st.sampled).toBe(10);
    expect(x.queueLength).toBe(10);
  });

  it("later minutes sample with probability target / expected rate and persist activity", () => {
    const { x, db, acts } = setup();
    const st = () => x.samp.get("P")!;
    const t0 = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 1000; i++) x.candidate(`a${i}`, "P", t0);
    x.rollMinute("P", t0 + 60_000);
    expect(st().ewma).toBe(1000);
    let sampled = 0;
    for (let m = 0; m < 20; m++) {
      const t = t0 + (m + 1) * 60_000;
      for (let i = 0; i < 1000; i++) x.candidate(`b${m}-${i}`, "P", t + 1000);
      sampled += st().sampled;
      x.rollMinute("P", t + 60_000);
    }
    expect(sampled / 20).toBeGreaterThan(5);
    expect(sampled / 20).toBeLessThanOrEqual(20); // capped at 2x target
    expect(acts.length).toBe(21);
    const row = db.get<{ n: number; c: number }>("SELECT COUNT(*) n, SUM(candidates) c FROM swap_activity")!;
    expect(row.n).toBe(21);
    expect(row.c).toBe(21_000);
    x.candidate("b0-1", "P", t0 + 22 * 60_000); // duplicates are ignored
    expect(st().candidates).toBe(0);
  });
});
