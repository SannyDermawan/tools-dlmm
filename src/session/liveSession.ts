import type { AppContext } from "../app.ts";
import { runCollection, type CollectionContext } from "../collectors/runner.ts";
import type { ActivityUpdate, BinSnapshot, EcoUpdate, PoolMetrics, PoolStateUpdate, SwapRecord } from "../collectors/types.ts";
import { finishSession } from "../db/repo.ts";
import { PoolSimulator } from "../sim/engine.ts";
import { GridRunner, SessionClock, timingFromConfig, type SessionTiming } from "../sim/gridRunner.ts";
import { dispatch } from "../sim/replayRunner.ts";
import { DbSimSink } from "../sim/store.ts";
import { writeSessionReport, type ReportPaths } from "../report/sessionReport.ts";
import { buildHeartbeat, writeHeartbeat } from "./heartbeat.ts";
import type { CollectionHealth } from "../collectors/runner.ts";
import type { ScoringRunner } from "../features/runner.ts";
import { buildDecisionStack, type DecisionStack } from "../signals/stack.ts";
import { swapStreamEnabled } from "../collectors/swapStream.ts";
import type { ReplayEvent } from "../sim/replay.ts";

export interface LiveSessionOptions {
  /** see CollectOptions.quiet */
  quiet?: boolean;
  maxPools?: number;
  label?: string;
  timing?: Partial<SessionTiming>;
  signal?: AbortSignal;
}

export interface LiveSessionResult {
  sessionId: string;
  status: string;
  positions: number;
  report: ReportPaths | null;
  grid: GridRunner["stats"] | null;
}

/**
 * Session Manager (blueprint 14): one session = data collection + demo simulator running on the
 * live stream. Phases: warm-up (collect only) -> active (grid cohorts) -> closing (no new
 * positions) -> end (force close 'session_end', report). Ctrl+C force-closes with
 * 'session_aborted' and still writes the report.
 */
export async function runLiveSession(app: AppContext, o: LiveSessionOptions = {}): Promise<LiveSessionResult> {
  const cfg = app.lc.config;
  const timing: SessionTiming = { ...timingFromConfig(cfg), ...o.timing };
  let sims: Map<string, PoolSimulator> | null = null;
  let runner: GridRunner | null = null;
  let sink: DbSimSink | null = null;
  let ticker: NodeJS.Timeout | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let scoreTimer: NodeJS.Timeout | null = null;
  let scoring: ScoringRunner | null = null;
  let decision: DecisionStack | null = null;
  let sessionIdRef: string | null = null;
  let clockRef: SessionClock | null = null;
  let healthRef: (() => CollectionHealth) | null = null;
  const stable = new Set(cfg.categories.usd_stable_tokens);
  const log = app.log.child({ component: "session" });
  let errors = 0;

  const safe = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      // A simulator bug must never stop data collection.
      if (errors++ < 50) log.error({ what, err: (e as Error).message, stack: (e as Error).stack }, "simulator error");
    }
  };

  const onReady = (ctx: CollectionContext) => {
    const clock = new SessionClock(Date.now(), timing);
    sink = new DbSimSink(app.db, ctx.sessionId, app.configVersion, 500);
    const metas = [...ctx.pools.values()];
    sims = new Map(metas.map((m) => [m.pool, new PoolSimulator(m, cfg, sink!)]));
    const swapPoolSet = new Set(metas.filter((m) => swapStreamEnabled(m, cfg.collectors.swap_stream)).map((m) => m.pool));
    const stack = cfg.scoring.enabled ? buildDecisionStack(app.db, cfg, app.configVersion, ctx.sessionId, metas, Date.now(), swapPoolSet) : null;
    runner = new GridRunner(cfg, sims, clock, log, stack?.gridSignals);
    stack?.attach(runner);
    decision = stack;
    for (const [token, p] of ctx.usdPrices) for (const s of sims.values()) if (s.meta.tokenY === token) s.onMarket({ quoteUsd: p.usd });
    const s = sims;
    const r = runner;
    // Scoring engine (phase 4) on the same stream: ingest events, score at "now" every interval.
    scoring = stack?.scoring ?? null;
    const sr = scoring;
    const route = (e: ReplayEvent, withRunner = true) => {
      dispatch(e, s, withRunner ? r : null, cfg, stable);
      // clamp to local time: chain block times can be slightly ahead of the laptop clock
      if (sr) sr.ingest(e.ts > Date.now() ? ({ ...e, ts: Date.now() } as ReplayEvent) : e);
    };
    ctx.bus.on("poolState", (u: PoolStateUpdate) => safe("state", () => route({ kind: "state", ts: u.ts, u })));
    ctx.bus.on("binSnapshot", (b: BinSnapshot) => safe("bins", () => route({ kind: "bins", ts: b.ts, s: b })));
    ctx.bus.on("swap", (w: SwapRecord) => safe("swap", () => route({ kind: "swap", ts: Math.min(w.ts, Date.now()), s: { ...w, ts: Math.min(w.ts, Date.now()) } }, false)));
    ctx.bus.on("metrics", (m: PoolMetrics) =>
      safe("metrics", () =>
        route({ kind: "metrics", ts: m.ts, pool: m.pool, tokenXUsd: m.tokenXUsd, tokenYUsd: m.tokenYUsd, tvlUsd: m.tvlUsd, volume1h: m.volume1hUsd, volume24h: m.volume24hUsd ?? null, fee1h: m.fee1hUsd, feeTvl1h: m.feeTvl1h ?? null }),
      ),
    );
    ctx.bus.on("eco", (e: EcoUpdate) => safe("eco", () => route({ kind: "eco", ...e })));
    ctx.bus.on("activity", (a: ActivityUpdate) => safe("activity", () => route({ kind: "activity", ...a }, false)));
    ctx.gaps.listener = (g) => safe("gap", () => route({ kind: "gap", ts: Date.now(), source: g.source, pool: g.pool, start: g.start, end: g.end }));
    if (sr) {
      scoreTimer = setInterval(() => safe("score", () => {
        const t0 = Date.now();
        const res = sr.scoreAt(t0);
        const acts = res.reduce((m, x) => ((m[x.action] = (m[x.action] ?? 0) + 1), m), {} as Record<string, number>);
        log.debug({ ms: Date.now() - t0, ...acts }, "scored");
      }), cfg.scoring.interval_seconds * 1000);
    }
    ticker = setInterval(() => safe("tick", () => r.onTick(Date.now())), 5000);
    sessionIdRef = ctx.sessionId;
    clockRef = clock;
    healthRef = ctx.health;
    statusTimer = setInterval(() => {
      let active = 0, closed = 0, pending = 0, failed = 0;
      for (const sim of s.values())
        for (const p of sim.list()) {
          if (p.status === "active") active++;
          else if (p.status === "closed") closed++;
          else if (p.status === "pending") pending++;
          else failed++;
        }
      const phase = clock.phase(Date.now());
      const leftMin = Math.max(0, (clock.end - Date.now()) / 60000);
      log.info({ phase, leftMin: Math.round(leftMin), active, pending, closed, failed, ...r.stats }, "session status");
      safe("heartbeat", () => writeHeartbeat(app.db, ctx.sessionId, buildHeartbeat(s, r, clock, decision, ctx.health())));
      if (!o.quiet) console.log(`[${new Date().toISOString()}] session phase=${phase} left=${leftMin.toFixed(0)}m positions active=${active} closed=${closed} failed=${failed} cohorts=${r.stats.cohorts} rebalances=${r.stats.rebalances}`);
    }, cfg.app.status_interval_seconds * 1000);
    console.log(
      `session clock: warm-up until ${new Date(clock.warmupEnd).toISOString()}, new positions until ${new Date(clock.stopNewAt).toISOString()}, end ${new Date(clock.end).toISOString()}; ${runner.combos.length} combos/pool/cohort`,
    );
  };

  const res = await runCollection(app, {
    kind: "session",
    quiet: o.quiet,
    durationMinutes: timing.durationMinutes,
    maxPools: o.maxPools,
    label: o.label,
    signal: o.signal,
    onReady,
  });
  if (ticker) clearInterval(ticker);
  if (statusTimer) clearInterval(statusTimer);
  if (scoreTimer) clearInterval(scoreTimer);
  let report: ReportPaths | null = null;
  let positions = 0;
  if (sims && runner && sink) {
    const reason = res.status === "completed" ? "session_end" : "session_aborted";
    const s = sims as Map<string, PoolSimulator>;
    const r = runner as GridRunner;
    app.db.tx(() => {
      r.finish(Date.now(), reason);
      (sink as DbSimSink).flush();
    });
    for (const sim of s.values()) positions += sim.list().length;
    if (sessionIdRef && clockRef) {
      const h = healthRef as (() => CollectionHealth) | null;
      const hb = buildHeartbeat(s, r, clockRef as SessionClock, decision as DecisionStack | null, h ? h() : null);
      writeHeartbeat(app.db, sessionIdRef, { ...hb, phase: "ended", status: res.status });
    }
    // runCollection already closed the session row; record the simulator outcome in notes.
    const d = decision as DecisionStack | null;
    finishSession(app.db, res.sessionId, res.status, {
      notes: JSON.stringify({ timing, grid: r.stats, simErrors: errors, signals: d?.book.count ?? 0, exitEngine: d?.exitEngine.stats ?? null }),
    });
    // fee reconciliation vs the API for the session window (skipped silently when offline)
    try {
      const { MeteoraApi } = await import("../api/meteora.ts");
      const { reconcileSession } = await import("../analysis/reconcile.ts");
      const sess = app.db.get<{ start_at: number; end_at: number }>("SELECT start_at, end_at FROM sessions WHERE session_id = ?", res.sessionId);
      if (sess) {
        const api = new MeteoraApi({ baseUrl: cfg.api.meteora_base_url, maxRps: cfg.api.max_rps, timeoutMs: cfg.api.request_timeout_ms, retry: cfg.api.retry, log });
        const to = Math.min(sess.end_at ?? Date.now(), Date.now() - cfg.reconcile.api_lag_minutes * 60_000);
        if (to - sess.start_at > 15 * 60_000) await reconcileSession(app.db, api, res.sessionId, sess.start_at + 60_000, to, cfg.reconcile.tolerance_pct);
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "end-of-session reconciliation skipped");
    }
    try {
      report = writeSessionReport(app.db, res.sessionId);
    } catch (e) {
      log.error({ err: (e as Error).message }, "report failed");
    }
  }
  return { sessionId: res.sessionId, status: res.status, positions, report, grid: runner ? (runner as GridRunner).stats : null };
}
