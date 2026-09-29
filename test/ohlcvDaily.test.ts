import { describe, expect, it } from "vitest";
import { OhlcvCollector, type ApiDeps } from "../src/collectors/apiCollectors.ts";
import { loadConfig } from "../src/config/load.ts";
import { Db, migrate } from "../src/db/index.ts";
import { AthLookup } from "../src/features/ath.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 29, 12, 0);

const setup = (o: { days?: number; createdAt?: number | null; fail?: () => boolean } = {}) => {
  const db = new Db(":memory:");
  migrate(db);
  const config = structuredClone(loadConfig().config);
  config.collectors.ohlcv.daily_lookback_days = o.days ?? 365;
  const calls: { tf: string; start: number; end: number }[] = [];
  const api = {
    ohlcv: async (_pool: string, tf: string, start: number, end: number) => {
      calls.push({ tf, start, end });
      if (o.fail?.()) throw new Error("boom");
      // one candle per day in the requested range, its high is the day index (so the ATH is the newest day)
      const out = [];
      for (let t = Math.ceil(start / 86400) * 86400; t < end; t += 86400) out.push({ timestamp: t, open: 1, high: t / 86400, low: 0.5, close: 1, volume: 10 });
      return out;
    },
  };
  const warned: string[] = [];
  const d = {
    api, db, config, log: { warn: (_o: unknown, m: string) => warned.push(m), error() {}, info() {} },
    gaps: { ok() {}, register() {} },
    pools: new Map([["P", { createdAt: o.createdAt ?? null }]]),
  } as unknown as ApiDeps;
  return { db, calls, warned, col: new OhlcvCollector(d) };
};

describe("daily OHLCV history (ATH base)", () => {
  it("first pull reaches back to the pool's start (a day before creation) in chunks of at most 72 candles", async () => {
    const { col, calls, db } = setup({ createdAt: NOW - 200 * DAY });
    await col.dailyHistory("P", NOW);
    expect(calls.every((c) => c.tf === "24h")).toBe(true);
    expect(Math.min(...calls.map((c) => c.start))).toBe(Math.floor((NOW - 201 * DAY) / 1000));
    expect(calls.length).toBe(Math.ceil(201 / 72));
    for (const c of calls) expect((c.end - c.start) / 86400).toBeLessThanOrEqual(72);
    const n = db.get<{ n: number }>("SELECT COUNT(*) n FROM ohlcv WHERE pool = 'P' AND timeframe = '24h'")!.n;
    expect(n).toBeGreaterThanOrEqual(200);
  });

  it("an old pool is bounded by daily_lookback_days; an unknown creation time uses the lookback", async () => {
    const a = setup({ createdAt: NOW - 900 * DAY, days: 100 });
    await a.col.dailyHistory("P", NOW);
    expect(Math.min(...a.calls.map((c) => c.start))).toBe(Math.floor((NOW - 100 * DAY) / 1000));
    const b = setup({ createdAt: null, days: 100 });
    await b.col.dailyHistory("P", NOW);
    expect(Math.min(...b.calls.map((c) => c.start))).toBe(Math.floor((NOW - 100 * DAY) / 1000));
  });

  it("later pulls: nothing within 6 hours, then only the last 3 days", async () => {
    const { col, calls } = setup({ createdAt: NOW - 30 * DAY });
    await col.dailyHistory("P", NOW);
    const first = calls.length;
    await col.dailyHistory("P", NOW + 5 * HOUR);
    expect(calls.length).toBe(first);
    await col.dailyHistory("P", NOW + 7 * HOUR);
    expect(calls.length).toBe(first + 1);
    expect(calls[first].start).toBe(Math.floor((NOW + 7 * HOUR - 3 * DAY) / 1000));
  });

  it("daily_lookback_days 0 switches it off; a failed pull is retried on the next tick", async () => {
    const off = setup({ days: 0 });
    await off.col.dailyHistory("P", NOW);
    expect(off.calls).toHaveLength(0);
    let failing = true;
    const t = setup({ createdAt: NOW - 10 * DAY, fail: () => failing });
    await t.col.dailyHistory("P", NOW);
    expect(t.warned.join()).toMatch(/daily ohlcv fetch failed/);
    const tried = t.calls.length;
    failing = false;
    await t.col.dailyHistory("P", NOW + 60_000); // no 6 h wait after a failure
    expect(t.calls.length).toBeGreaterThan(tried);
  });

  it("the stored daily candles are what AthLookup reads: the ATH of the pool's whole life", async () => {
    const { col, db } = setup({ createdAt: NOW - 20 * DAY });
    await col.dailyHistory("P", NOW);
    const ath = new AthLookup(db).at("P", NOW);
    // the newest closed day's high is its day index; today's candle has not closed yet
    expect(ath).toBe(Math.floor(NOW / DAY) - 1);
  });
});
