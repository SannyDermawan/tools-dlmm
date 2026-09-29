import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import type { PositionResult } from "../sim/engine.ts";
import type { VirtualPosition } from "../sim/position.ts";
import type { MemoryView } from "./compute.ts";

/** Close reasons that mean "the price left the range" (a rebalance-not-worth exit counts too). */
export const OOR_REASONS = new Set(["exit_out_of_range", "max_rebalances", "exit_engine:rebalance_not_worth"]);
/** Close reasons that mean "the pool stopped paying". */
export const LOW_YIELD_REASONS = new Set(["low_yield", "exit_engine:low_fee_rate"]);
/** Forced closes say nothing about the pool. */
const NEUTRAL_REASONS = new Set(["session_end", "session_aborted"]);

interface StoredRow {
  kind: "pool" | "token";
  key: string;
  session_id: string;
  updated_at: number;
  positions: number;
  avg_net_pct: number | null;
  win_rate: number | null;
  cooldown_until: number | null;
  cooldown_reason: string | null;
}

interface Cooldown {
  from: number;
  until: number;
  reason: string;
}

/**
 * Pool / token memory across sessions (addendum 3.4). Look-ahead safe: a reader at time t sees
 * rows of sessions that ended at or before t, plus this session's closes with ts <= t.
 *
 * Cooldown rules (memory.cooldown), driven by closes of the configured entry modes:
 *  - a low-yield close -> the pool cools down for low_yield_hours;
 *  - oor_consecutive cohorts in a row whose first decisive close was out of range -> the pool and
 *    its risk token cool down for oor_hours. The grid opens many positions per pool and cohort,
 *    so the cohort (not the single position) is the unit: its first close that is not a forced
 *    session close decides whether the cohort counts as out of range; any other outcome breaks
 *    the row.
 * Pool history features (avg net %, win rate) come from clean baseline positions only: they
 * ignore the signal, so the history is not biased by our own selection.
 */
export class PoolMemory implements MemoryView {
  private rows: StoredRow[];
  private readonly baselineCloses = new Map<string, { ts: number; net: number }[]>();
  private readonly cooldowns = new Map<string, Cooldown[]>();
  private readonly oor = new Map<string, { consecutive: number; decided: Set<number> }>();
  readonly stats = { lowYieldCooldowns: 0, oorCooldowns: 0 };

  constructor(
    private readonly db: Db | null,
    private readonly c: Config,
    private readonly sessionId: string,
    /** risk token of a pool (null for bluechip-only pools) */
    private readonly riskToken: (pool: string) => string | null,
  ) {
    this.rows = db
      ? db.all<StoredRow>(
          `SELECT kind, key, session_id, updated_at, positions, avg_net_pct, win_rate, cooldown_until, cooldown_reason
           FROM pool_memory WHERE session_id != ?`,
          sessionId,
        )
      : [];
  }

  poolStats(pool: string, t: number): { positions: number; avgNetPct: number | null; winRate: number | null } | null {
    let n = 0, sumNet = 0, nNet = 0, wins = 0, nWin = 0;
    for (const r of this.rows) {
      if (r.kind !== "pool" || r.key !== pool || r.updated_at > t || r.positions <= 0) continue;
      n += r.positions;
      if (r.avg_net_pct !== null) (sumNet += r.avg_net_pct * r.positions), (nNet += r.positions);
      if (r.win_rate !== null) (wins += r.win_rate * r.positions), (nWin += r.positions);
    }
    for (const x of this.baselineCloses.get(pool) ?? []) {
      if (x.ts > t) continue;
      n++;
      sumNet += x.net;
      nNet++;
      if (x.net > 0) wins++;
      nWin++;
    }
    if (n === 0) return null;
    return { positions: n, avgNetPct: nNet ? sumNet / nNet : null, winRate: nWin ? wins / nWin : null };
  }

  cooldown(pool: string, token: string | null, t: number): { until: number; reason: string } | null {
    let best: { until: number; reason: string } | null = null;
    const consider = (until: number | null, reason: string | null) => {
      if (until !== null && until > t && (!best || until > best.until)) best = { until, reason: reason ?? "cooldown" };
    };
    for (const r of this.rows) {
      if (r.updated_at > t) continue;
      if ((r.kind === "pool" && r.key === pool) || (token && r.kind === "token" && r.key === token)) consider(r.cooldown_until, r.cooldown_reason);
    }
    for (const k of [`pool|${pool}`, token ? `token|${token}` : null]) {
      if (!k) continue;
      for (const cd of this.cooldowns.get(k) ?? []) if (cd.from <= t) consider(cd.until, cd.reason);
    }
    return best;
  }

  /** Cooldown of a pool or of its risk token at t. */
  poolCooldown(pool: string, t: number): { until: number; reason: string } | null {
    return this.cooldown(pool, this.riskToken(pool), t);
  }

  private addCooldown(key: string, from: number, hours: number, reason: string) {
    const list = this.cooldowns.get(key) ?? [];
    list.push({ from, until: from + hours * 3_600_000, reason });
    this.cooldowns.set(key, list);
  }

  /** Every closed position (simulator result hook). */
  onClose(p: VirtualPosition, r: PositionResult) {
    const ts = p.closedAt ?? 0;
    const reason = p.closeReason ?? "";
    if (p.spec.entryMode === "all_pools_baseline" && !p.gapTainted && !reason.startsWith("closed_before_active")) {
      const list = this.baselineCloses.get(p.pool) ?? [];
      list.push({ ts, net: r.netPnlPct });
      this.baselineCloses.set(p.pool, list);
    }
    const cd = this.c.memory.cooldown;
    if (!cd.modes.includes(p.spec.entryMode) || NEUTRAL_REASONS.has(reason)) return;
    if (LOW_YIELD_REASONS.has(reason)) {
      const cur = this.cooldown(p.pool, null, ts);
      if (!cur || cur.until < ts + cd.low_yield_hours * 3_600_000) {
        this.addCooldown(`pool|${p.pool}`, ts, cd.low_yield_hours, `low yield (${reason})`);
        this.stats.lowYieldCooldowns++;
      }
    }
    const cohort = p.spec.cohort ?? 0;
    const st = this.oor.get(p.pool) ?? { consecutive: 0, decided: new Set<number>() };
    this.oor.set(p.pool, st);
    if (st.decided.has(cohort)) return;
    st.decided.add(cohort);
    if (!OOR_REASONS.has(reason)) {
      st.consecutive = 0;
      return;
    }
    st.consecutive++;
    if (st.consecutive >= cd.oor_consecutive) {
      const why = `${st.consecutive} out-of-range cohorts in a row`;
      this.addCooldown(`pool|${p.pool}`, ts, cd.oor_hours, why);
      const tk = this.riskToken(p.pool);
      if (tk) this.addCooldown(`token|${tk}`, ts, cd.oor_hours, why);
      this.stats.oorCooldowns++;
      st.consecutive = 0;
    }
  }

  /**
   * Session end: one pool_memory row per pool and risk token of this session (clean baseline
   * stats, close reasons of every mode, the latest cooldown still running at the end).
   */
  persist(endTs: number, pools: string[]) {
    if (!this.db) return 0;
    const res = this.db.all<{ pool: string; entry_mode: string; close_reason: string | null; net: number | null; tainted: number }>(
      `SELECT p.pool, p.entry_mode, p.close_reason, r.net_pnl_pct net, p.gap_tainted tainted
       FROM sim_positions p LEFT JOIN sim_results r ON r.position_id = p.position_id
       WHERE p.session_id = ? AND p.status = 'closed'`,
      this.sessionId,
    );
    const agg = new Map<string, { kind: "pool" | "token"; key: string; nets: number[]; reasons: Record<string, number> }>();
    const bucket = (kind: "pool" | "token", key: string) => {
      const k = `${kind}|${key}`;
      let a = agg.get(k);
      if (!a) agg.set(k, (a = { kind, key, nets: [], reasons: {} }));
      return a;
    };
    for (const pool of pools) {
      bucket("pool", pool);
      const tk = this.riskToken(pool);
      if (tk) bucket("token", tk);
    }
    for (const r of res) {
      const targets = [bucket("pool", r.pool)];
      const tk = this.riskToken(r.pool);
      if (tk) targets.push(bucket("token", tk));
      for (const a of targets) {
        if (r.close_reason) a.reasons[r.close_reason] = (a.reasons[r.close_reason] ?? 0) + 1;
        if (r.entry_mode === "all_pools_baseline" && !r.tainted && r.net !== null) a.nets.push(r.net);
      }
    }
    let n = 0;
    for (const a of agg.values()) {
      const cd = this.cooldownAtEnd(a.kind, a.key, endTs);
      const nets = a.nets;
      this.db.insert(
        "pool_memory",
        {
          kind: a.kind, key: a.key, session_id: this.sessionId, updated_at: endTs, positions: nets.length,
          avg_net_pct: nets.length ? nets.reduce((s, x) => s + x, 0) / nets.length : null,
          win_rate: nets.length ? nets.filter((x) => x > 0).length / nets.length : null,
          close_reasons: JSON.stringify(a.reasons),
          cooldown_until: cd?.until ?? null, cooldown_reason: cd?.reason ?? null,
          consecutive_oor: a.kind === "pool" ? (this.oor.get(a.key)?.consecutive ?? 0) : 0,
        },
        "OR REPLACE",
      );
      n++;
    }
    return n;
  }

  private cooldownAtEnd(kind: "pool" | "token", key: string, t: number): Cooldown | null {
    let best: Cooldown | null = null;
    for (const cd of this.cooldowns.get(`${kind}|${key}`) ?? []) if (cd.from <= t && cd.until > t && (!best || cd.until > best.until)) best = cd;
    return best;
  }

  /** Reload stored rows (after another session persisted its memory). */
  reload() {
    if (this.db)
      this.rows = this.db.all<StoredRow>(
        `SELECT kind, key, session_id, updated_at, positions, avg_net_pct, win_rate, cooldown_until, cooldown_reason FROM pool_memory WHERE session_id != ?`,
        this.sessionId,
      );
  }
}
