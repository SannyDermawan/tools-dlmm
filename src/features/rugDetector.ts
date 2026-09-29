import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import { binRawPrice } from "../math/bin.ts";
import type { PoolTracker } from "./tracker.ts";
import { addBlock, auditAt, type AuditRow } from "./safetyData.ts";

export interface RugEvidence {
  pool: string;
  token: string;
  dev: string | null;
  t: number;
  priceDropPct: number | null;
  lpWithdrawalPct: number | null;
  devDumpPct: number | null;
  rule: "price_and_lp" | "dev_dump";
}

/**
 * Automatic blocklist (addendum 3.2, rug_detection): within `window_minutes`
 *  - the price falls >= price_drop_pct from the window high AND the liquidity within active +- k
 *    falls >= lp_withdrawal_pct (both, so a plain crash with LPs staying is not a rug), or
 *  - the dev wallet's balance (Jupiter audit, % of supply) falls >= dev_dump_pct relative to the
 *    audit before the window.
 * The token (and its dev, when known) is blocklisted with added_at = t, so decisions before t
 * are unchanged (replays stay reproducible). Only data with ts <= t is read.
 */
export function detectRug(
  tr: PoolTracker,
  token: string,
  t: number,
  c: Config["rug_detection"],
  audit: { now: AuditRow | null; before: AuditRow | null },
): RugEvidence | null {
  const W = c.window_minutes * 60_000;
  const win = tr.prices.filter((p) => p.ts > t - W && p.ts <= t);
  let priceDropPct: number | null = null;
  if (win.length >= 2) {
    const hi = Math.max(...win.map((p) => p.price));
    const last = win[win.length - 1].price;
    // the risk token may be Y (quote side): its price is 1/price
    const riskIsX = tr.meta.tokenX === token;
    const drop = riskIsX ? 1 - last / hi : 1 - Math.min(...win.map((p) => p.price)) / last;
    priceDropPct = hi > 0 ? drop * 100 : null;
  }
  // LP withdrawal: token reserves of the observed bins, both ends valued at the window-start
  // price. Swaps only convert X <-> Y at bin prices, so a crash alone does not lower this value
  // (sellers add X worth more at the start price than the Y they take); withdrawals do.
  const res = tr.reserves.filter((r) => r.ts > t - W && r.ts <= t);
  let lpWithdrawalPct: number | null = null;
  if (res.length >= 2 && win.length) {
    const p0 = binRawPrice(win[0].activeId, tr.meta.binStep);
    const v = (r: { x: number; y: number }) => r.x * p0 + r.y;
    const v0 = v(res[0]);
    lpWithdrawalPct = v0 > 0 ? Math.max(0, (1 - v(res[res.length - 1]) / v0) * 100) : null;
  }
  let devDumpPct: number | null = null;
  const a0 = audit.before?.dev_balance_pct ?? null;
  const a1 = audit.now?.dev_balance_pct ?? null;
  if (a0 !== null && a1 !== null && a0 > 0.5 && audit.before!.ts < audit.now!.ts) devDumpPct = Math.max(0, (1 - a1 / a0) * 100);
  const base = { pool: tr.meta.pool, token, dev: audit.now?.dev ?? audit.before?.dev ?? null, t, priceDropPct, lpWithdrawalPct, devDumpPct };
  if (priceDropPct !== null && lpWithdrawalPct !== null && priceDropPct >= c.price_drop_pct && lpWithdrawalPct >= c.lp_withdrawal_pct) return { ...base, rule: "price_and_lp" };
  if (devDumpPct !== null && devDumpPct >= c.dev_dump_pct) return { ...base, rule: "dev_dump" };
  return null;
}

/** Runs detectRug for every pool's risk tokens and writes blocklist entries (source auto_rug). */
export class RugDetector {
  readonly found: RugEvidence[] = [];
  private readonly flagged = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly c: Config,
    private readonly riskTokens: (pool: string) => string[],
    private readonly onBlocked?: () => void,
  ) {}

  check(trackers: Iterable<PoolTracker>, t: number): RugEvidence[] {
    const rc = this.c.rug_detection;
    if (!rc.enabled) return [];
    const out: RugEvidence[] = [];
    for (const tr of trackers) {
      for (const token of this.riskTokens(tr.meta.pool)) {
        if (this.flagged.has(token)) continue;
        const now = auditAt(this.db, token, t);
        const before = auditAt(this.db, token, t - rc.window_minutes * 60_000);
        const ev = detectRug(tr, token, t, rc, { now, before });
        if (!ev) continue;
        this.flagged.add(token);
        const detail = { pool: ev.pool, rule: ev.rule, priceDropPct: ev.priceDropPct, lpWithdrawalPct: ev.lpWithdrawalPct, devDumpPct: ev.devDumpPct };
        addBlock(this.db, "token", token, `auto rug: ${ev.rule}`, "auto_rug", t, detail);
        if (ev.dev) addBlock(this.db, "dev", ev.dev, `dev of rugged token ${token.slice(0, 6)}`, "auto_rug", t, detail);
        out.push(ev);
      }
    }
    if (out.length) {
      this.found.push(...out);
      this.onBlocked?.();
    }
    return out;
  }
}
