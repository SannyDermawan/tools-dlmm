import { describe, expect, it } from "vitest";
import { Db, migrate } from "../src/db/index.ts";
import { addBlock } from "../src/features/safetyData.ts";
import { featuresAt, rugReport, rugReportMarkdown } from "../src/analysis/rugs.ts";

const MIN = 60_000;
const T = Date.parse("2026-09-30T00:00:00Z");

function audit(db: Db, token: string, ts: number, o: { mcap?: number; organic?: number; bot?: number; holders?: number; top?: number; created?: number }) {
  db.run(
    `INSERT INTO token_audit (token, ts, symbol, organic_score, holder_count, mcap_usd, token_created_at, top_holders_pct, bot_holders_pct, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tokens_v2')`,
    token, ts, token.toUpperCase(), o.organic ?? null, o.holders ?? null, o.mcap ?? null, o.created ?? null, o.top ?? null, o.bot ?? null,
  );
}

describe("rug post-mortem", () => {
  const setup = () => {
    const db = new Db(":memory:");
    migrate(db);
    // a rugged token: rows exist 30 min and 5 min before the rug; only the 30 min row may be used (lead 10)
    audit(db, "rug", T - 30 * MIN, { mcap: 900_000, organic: 76, bot: 31, holders: 5000, top: 23, created: T - 90 * MIN });
    audit(db, "rug", T - 5 * MIN, { mcap: 100_000, organic: 10, bot: 80, holders: 100, top: 90, created: T - 90 * MIN });
    addBlock(db, "token", "rug", "auto rug: price_and_lp", "auto_rug", T, { pool: "P", rule: "price_and_lp", priceDropPct: 83, lpWithdrawalPct: 50 });
    // a rugged token that was never audited: no features, left out of the screens
    addBlock(db, "token", "ghost", "auto rug: price_and_lp", "auto_rug", T);
    // others
    audit(db, "ok1", T - 60 * MIN, { mcap: 5_000_000, organic: 80, bot: 5, holders: 9000, top: 30, created: T - 48 * 60 * MIN });
    audit(db, "ok2", T - 60 * MIN, { mcap: 1_200_000, organic: 50, bot: 40, holders: 800, top: 70, created: T - 10 * 60 * MIN });
    return db;
  };

  it("reads features from before the lead time, not from the collapse", () => {
    const db = setup();
    const f = featuresAt(db, "rug", T - 10 * MIN)!;
    expect(f).toMatchObject({ mcapUsd: 900_000, organic: 76, botHoldersPct: 31, holders: 5000, top10Pct: 23 });
    expect(f.tokenAgeHours).toBeCloseTo(1 - 10 / 60 + 0.5, 5); // 90 min old at T, features at T-10
    expect(featuresAt(db, "nobody", T)).toBeNull();
  });

  it("counts what each screen blocks among rugs and among the others", () => {
    const db = setup();
    const r = rugReport(db, 10);
    expect(r.cases).toHaveLength(2);
    expect(r.cases.find((c) => c.token === "ghost")!.before).toBeNull();
    expect(r.otherTokens).toBe(2);
    const row = (name: string) => r.screens.find((s) => s.name.startsWith(name))!;
    // the rug looked fine on market cap / organic / holders / top-10 but not on bot holders
    expect(row("market cap $500k-2M")).toMatchObject({ rugs: 1, rugsBlocked: 0, others: 2, othersBlocked: 1 });
    expect(row("organic score")).toMatchObject({ rugsBlocked: 0, othersBlocked: 1 });
    expect(row("bot holders")).toMatchObject({ rugsBlocked: 1, othersBlocked: 1 });
    // no security row anywhere: authority screen cannot tell
    expect(row("no mint / freeze")).toMatchObject({ rugsBlocked: 0, rugsUnknown: 1, othersUnknown: 2 });
    const md = rugReportMarkdown(r);
    expect(md).toContain("price_and_lp");
    expect(md).toContain("bot holders <= 30%");
  });

  it("says so when nothing was flagged", () => {
    const db = new Db(":memory:");
    migrate(db);
    expect(rugReportMarkdown(rugReport(db))).toContain("No tokens flagged");
  });
});
