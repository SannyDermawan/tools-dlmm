import type { AppContext } from "../app.ts";
import type { Config } from "../config/schema.ts";
import { loadPoolMeta } from "../collectors/discovery.ts";
import { createSession, finishSession, getSession } from "../db/repo.ts";
import { PoolSimulator } from "./engine.ts";
import { GridRunner, scaleTiming, SessionClock, timingFromConfig, type SessionTiming } from "./gridRunner.ts";
import { loadReplay, type ReplayEvent } from "./replay.ts";
import { DbSimSink } from "./store.ts";
import { buildDecisionStack } from "../signals/stack.ts";
import { swapPoolsOf } from "../features/runner.ts";

export interface ReplayRunOptions {
  sourceSessionId: string;
  pools?: string[];
  feeAttribution?: Config["simulation"]["fee_attribution"];
  /** explicit timing; default: config timing scaled down to the collected span */
  timing?: Partial<SessionTiming>;
  /** run scoring + signals + exit engine (phase 4-5); false = baseline grid only */
  signals?: boolean;
}

export interface ReplayRunResult {
  sessionId: string;
  positions: number;
  closed: number;
  failed: number;
  timing: SessionTiming;
  grid: GridRunner["stats"];
  signals: number;
  exitEngine: { evaluated: number; exits: number; partials: number; byReason: Record<string, number> } | null;
}

/** Choose the priority fee sample matching the configured percentile. */
export function pickPriority(c: Config, e: { p50: number | null; p75: number | null; p90: number | null }) {
  const p = c.simulation.costs.priority_fee_percentile;
  return p >= 90 ? e.p90 : p >= 75 ? e.p75 : e.p50;
}

/** Dispatch one market event to the simulators and the grid runner (shared by replay and live). */
export function dispatch(e: ReplayEvent, sims: Map<string, PoolSimulator>, runner: GridRunner | null, c: Config, stable: Set<string>) {
  switch (e.kind) {
    case "eco":
      for (const s of sims.values()) s.onMarket({ solUsd: e.solUsd, priorityMicroLamports: pickPriority(c, e) });
      break;
    case "metrics": {
      const s = sims.get(e.pool);
      if (s) s.onMarket({ quoteUsd: e.tokenYUsd ?? (stable.has(s.meta.tokenY) ? 1 : null) });
      break;
    }
    case "gap":
      for (const s of sims.values()) if (!e.pool || e.pool === s.meta.pool) s.onGap(e);
      break;
    case "state": {
      const s = sims.get(e.u.pool);
      if (!s) break;
      s.onState(e.u);
      runner?.onPoolState(e.u.pool, e.ts);
      break;
    }
    case "bins":
      sims.get(e.s.pool)?.onBins(e.s);
      break;
    case "swap":
      sims.get(e.s.pool)?.onSwap(e.s);
      break;
    case "swapquote":
      sims.get(e.pool)?.onMarket({ swapCostPct: e.costPct, swapQuoteTs: e.ts });
      break;
  }
  runner?.onTick(e.ts);
}

export function runReplay(app: AppContext, o: ReplayRunOptions): ReplayRunResult {
  const { db, lc } = app;
  const cfg = structuredClone(lc.config);
  if (o.feeAttribution) cfg.simulation.fee_attribution = o.feeAttribution;
  const src = getSession(db, o.sourceSessionId);
  if (!src) throw new Error(`session ${o.sourceSessionId} not found`);
  const pools = o.pools?.length
    ? o.pools
    : db.all<{ pool: string }>("SELECT pool FROM session_pools WHERE session_id = ? ORDER BY rank", src.session_id).map((r) => r.pool);
  const metas = pools.map((p) => loadPoolMeta(db, p)!).filter(Boolean);
  const from = src.start_at;
  const to = src.end_at ?? Date.now();
  const timing = { ...scaleTiming(timingFromConfig(cfg), (to - from) / 60_000), ...o.timing };
  const clock = new SessionClock(from, timing);
  const sessionId = createSession(db, {
    kind: "sim_replay", configVersion: app.configVersion, label: `replay:${src.label ?? ""}`, sourceSessionId: src.session_id,
    notes: JSON.stringify({ fee_attribution: cfg.simulation.fee_attribution, timing }),
  });
  const sink = new DbSimSink(db, sessionId, app.configVersion);
  const sims = new Map(metas.map((m) => [m.pool, new PoolSimulator(m, cfg, sink)]));
  const stack = o.signals === false
    ? null
    : buildDecisionStack(db, cfg, app.configVersion, sessionId, metas, from, swapPoolsOf(db, src.session_id));
  const runner = new GridRunner(cfg, sims, clock, app.log, stack?.gridSignals);
  stack?.attach(runner);
  // in-session cooldowns follow the replayed closes; replays never persist memory (not new data)
  if (stack) sink.onResult = (p, r) => stack.memory.onClose(p, r);
  const events = loadReplay(db, {
    pools: metas.map((m) => m.pool), from, to,
    binSteps: new Map(metas.map((m) => [m.pool, m.binStep])),
    collectFeeModes: new Map(metas.map((m) => [m.pool, m.collectFeeMode])),
    sessionId: src.session_id,
  });
  const stable = new Set(cfg.categories.usd_stable_tokens);
  let lastTs = from;
  // batch mode: commit every ~250 ms so live sessions sharing the database are never blocked
  db.beginBatch();
  try {
    for (const e of events) {
      if (e.ts > clock.end) break;
      lastTs = e.ts;
      stack?.scoring.feed(e); // scores (-> signals -> exit engine) every decision time before e
      dispatch(e, sims, runner, cfg, stable);
      db.yieldBatch();
    }
    runner.finish(Math.min(clock.end, lastTs), "session_end");
    sink.flush();
  } finally {
    db.endBatch();
  }
  let positions = 0, closed = 0, failed = 0;
  for (const s of sims.values())
    for (const p of s.list()) {
      positions++;
      if (p.status === "closed") closed++;
      if (p.status === "failed") failed++;
    }
  finishSession(db, sessionId, "completed", { poolCount: metas.length });
  return { sessionId, positions, closed, failed, timing, grid: runner.stats, signals: stack?.book.count ?? 0, exitEngine: stack?.exitEngine.stats ?? null };
}
