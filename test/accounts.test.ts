import { describe, expect, it } from "vitest";
import { ENTRY_MODES } from "../src/config/schema.ts";
import { DEFAULT_PORTFOLIO, simulatePortfolio, type Candidate } from "../src/analysis/portfolio.ts";
import { accountsCsv, accountsMarkdown, concurrency, DEFAULT_ACCOUNTS, type AccountResult } from "../src/analysis/accounts.ts";

const MIN = 60_000;
const D0 = Date.UTC(2026, 9, 1, 0, 0);
const cand = (id: string, pool: string, openMin: number, durMin: number, pct: number, o: Partial<Candidate> = {}): Candidate => ({
  id, pool, openedAt: D0 + openMin * MIN, closedAt: D0 + (openMin + durMin) * MIN, pct, score: null, ...o,
});
const account = (name: string, cands: Candidate[]): AccountResult => ({
  def: { name, mode: name, where: [], pick: "first", note: `${name} note` },
  result: simulatePortfolio(cands, { ...DEFAULT_PORTFOLIO, sessionIds: ["S"], mode: name, startCapitalUsd: 45, maxTradeUsd: 45 }),
});

describe("preset accounts", () => {
  it("one account per entry mode except the baseline control, each with a profile that is a real mode", () => {
    expect(DEFAULT_ACCOUNTS.map((a) => a.mode).sort()).toEqual(ENTRY_MODES.filter((m) => m !== "all_pools_baseline").sort());
    expect(new Set(DEFAULT_ACCOUNTS.map((a) => a.name)).size).toBe(DEFAULT_ACCOUNTS.length);
    const yunus = DEFAULT_ACCOUNTS.find((a) => a.mode === "yunus_flip")!;
    expect(yunus.where.map((w) => `${w.key}${w.op}${w.value}`)).toEqual(["exit_policy~breakeven", "range_pct=50", "anchor=price", "flip_shape=bidask"]);
  });

  it("counts the accounts and the distinct pools open at the same moment, closing before opening at the same instant", () => {
    const rs = [
      account("a", [cand("a1", "P1", 0, 60, 1), cand("a2", "P3", 60, 30, 1)]),
      account("b", [cand("b1", "P2", 10, 30, 1)]),
      account("c", [cand("c1", "P1", 20, 10, 1)]), // same pool as a1: two accounts, one pool
    ];
    expect(concurrency(rs)).toEqual({ accounts: 3, pools: 2 });
    // a1 closes at 60 exactly when a2 opens: the account is never counted twice
    expect(concurrency([account("a", [cand("a1", "P1", 0, 60, 1), cand("a2", "P3", 60, 30, 1)])])).toEqual({ accounts: 1, pools: 1 });
  });

  it("the report lists every account, the accounts that did not trade, the total and the wallet", () => {
    const rs = [
      account("meridian", [cand("m1", "P1", 0, 30, 10, { rentUsd: 7 }), cand("m2", "P2", 40, 30, -10, { rentUsd: 9 })]),
      account("evil_panda", []),
    ];
    const md = accountsMarkdown(rs, { capitalUsd: 45, sessions: ["8fced048-aaaa"], reprice: true });
    expect(md).toContain("2 preset accounts of $45.00");
    expect(md).toContain("sessions 8fced048");
    expect(md).toMatch(/\| meridian \| meridian: all combinations \| 2 \| 2 \| 50% \| \$45\.00 \| 0\.0% \|/); // +10 % then -10 %, both at the $45 cap: +4.50 -4.50
    expect(md).toContain("No trade: evil_panda");
    expect(md).toContain("$90.00 -> $90.00");
    expect(md).toContain("$99.00"); // 2 x $45 + the largest rent of the accounts that traded (9)
    const csv = accountsCsv(rs).trim().split("\n");
    expect(csv[0]).toBe("account,opened_at,closed_at,pool,size_usd,pct,pnl_usd,equity_after,rent_usd");
    expect(csv).toHaveLength(3);
    expect(csv[1]).toMatch(/^meridian,.*,P1,45\.00,10\.0000,4\.5000,49\.50,7\.00$/);
  });
});
