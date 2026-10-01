import type { Db } from "../db/index.ts";
import type { CollectionHealth } from "../collectors/runner.ts";
import type { PoolSimulator } from "../sim/engine.ts";
import type { GridRunner, SessionClock } from "../sim/gridRunner.ts";
import type { DecisionStack } from "../signals/stack.ts";

interface Agg {
  n: number;
  active: number;
  netUsd: number;
  feeUsd: number;
  ilUsd: number;
  win: number;
}

/** Live session state for dashboards (written every status interval to session_heartbeat). */
export function buildHeartbeat(
  sims: Map<string, PoolSimulator>,
  runner: GridRunner,
  clock: SessionClock,
  decision: DecisionStack | null,
  health: CollectionHealth | null,
  now = Date.now(),
) {
  const counts = { pending: 0, active: 0, closed: 0, failed: 0 };
  const byMode: Record<string, Agg> = {};
  const byStrategy: Record<string, Agg> = {};
  const byExit: Record<string, Agg> = {};
  const add = (m: Record<string, Agg>, k: string, net: number, fee: number, il: number, active: boolean) => {
    const a = (m[k] ??= { n: 0, active: 0, netUsd: 0, feeUsd: 0, ilUsd: 0, win: 0 });
    a.n++;
    if (active) a.active++;
    a.netUsd += net;
    a.feeUsd += fee;
    a.ilUsd += il;
    if (net > 0) a.win++;
  };
  const pools: { pool: string; name: string; active: number; activeId: number | null; price: number | null }[] = [];
  for (const sim of sims.values()) {
    let poolActive = 0;
    for (const p of sim.list()) {
      counts[p.status]++;
      if (p.status === "active") poolActive++;
      if (!p.last || (p.status !== "active" && p.status !== "closed")) continue;
      // mark-to-market (active) or final (closed) values from the last valuation
      const net = p.last.valueUsd + p.last.feeUsd - p.spec.capitalUsd - p.sunkCostUsd();
      const il = p.last.ilUsd;
      const act = p.status === "active";
      add(byMode, p.spec.entryMode, net, p.last.feeUsd, il, act);
      add(byStrategy, p.spec.strategy, net, p.last.feeUsd, il, act);
      add(byExit, String(p.spec.combo.exit_policy ?? "-"), net, p.last.feeUsd, il, act);
    }
    const st = sim.list()[0]?.last;
    pools.push({ pool: sim.meta.pool, name: sim.meta.name, active: poolActive, activeId: null, price: st?.priceUi ?? null });
  }
  const signals = decision
    ? [...sims.keys()]
        .map((pool) => decision.book.latestFor(pool, now))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .sort((a, b) => (b.final_score ?? -1) - (a.final_score ?? -1))
        .map((s) => ({
          pool: s.pool, name: sims.get(s.pool)?.meta.name ?? s.pool, ts: s.ts, action: s.action, final_score: s.final_score,
          confidence: s.confidence, regime: s.regime_label, gate: s.safety_gate.passed, reasons: s.top_reasons.slice(0, 3),
          recommendation: s.recommendation,
        }))
    : [];
  return {
    ts: now,
    phase: clock.phase(now),
    start: clock.start,
    warmupEnd: clock.warmupEnd,
    stopNewAt: clock.stopNewAt,
    end: clock.end,
    leftMin: Math.max(0, (clock.end - now) / 60000),
    positions: counts,
    grid: runner.stats,
    exitEngine: decision?.exitEngine.stats ?? null,
    signalsTotal: decision?.book.count ?? 0,
    pnl: { byMode, byStrategy, byExit },
    signals,
    pools,
    health,
  };
}

export function writeHeartbeat(db: Db, sessionId: string, state: object) {
  db.run(
    "INSERT INTO session_heartbeat (session_id, ts, pid, state) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET ts=excluded.ts, pid=excluded.pid, state=excluded.state",
    sessionId, Date.now(), process.pid, JSON.stringify(state),
  );
}
