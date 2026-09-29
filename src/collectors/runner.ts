import { endpoints, type AppContext } from "../app.ts";
import { JsonHttp, MeteoraApi } from "../api/meteora.ts";
import { RpcClient } from "../chain/rpc.ts";
import { UsageTracker } from "../chain/usage.ts";
import { ReconnectingWs } from "../chain/ws.ts";
import { createSession, finishSession, recoverUncleanSessions } from "../db/repo.ts";
import { every, setEveryErrorHandler, sleep } from "../util/async.ts";
import { EcosystemCollector, OhlcvCollector, PoolMetricsCollector } from "./apiCollectors.ts";
import { BinSnapshotCollector, PoolStateCollector } from "./chainState.ts";
import { discoverPools } from "./discovery.ts";
import { GapTracker } from "./gaps.ts";
import { SwapBudget, SwapStreamCollector, swapStreamEnabled } from "./swapStream.ts";
import { TokenSecurityCollector } from "./tokenSecurity.ts";
import { TokenAuditCollector } from "./tokenAudit.ts";
import { RealLpCollector } from "./realLp.ts";
import { AttentionCollector, MacroCollector, VenueCollector } from "./extraCollectors.ts";
import { MarketBus, type PoolMeta } from "./types.ts";

export interface CollectOptions {
  /**
   * No periodic console status lines (file logs, heartbeat and dashboard still work). Use when
   * stdout goes to a pipe that may stop reading: pipe writes are synchronous and would block the
   * whole process once the pipe buffer is full.
   */
  quiet?: boolean;
  /** session kind: plain data collection, or a full demo session (collection + simulator) */
  kind?: "collect" | "session";
  durationMinutes?: number;
  maxPools?: number;
  label?: string;
  /** external abort (tests / embedding) */
  signal?: AbortSignal;
  /** called once pools are known; lets a simulator subscribe to the bus */
  onReady?: (ctx: CollectionContext) => void;
}

export interface CollectionContext {
  sessionId: string;
  bus: MarketBus;
  pools: Map<string, PoolMeta>;
  gaps: GapTracker;
  usdPrices: Map<string, { usd: number; ts: number }>;
  ecosystem: EcosystemCollector | null;
  /** live data-health snapshot for dashboards */
  health: () => CollectionHealth;
}

export interface CollectionHealth {
  credits: number;
  swapCredits: number;
  quotaPct: number;
  budget: string;
  rpcRps: number;
  swapRps: number;
  wsConnected: boolean | null;
  wsReconnects: number;
  txQueue: number;
  swapsStored: number;
  openGaps: { source: string; pool: string | null; since: number; cause: string }[];
  httpCalls: number;
  httpErrors: number;
}

export interface CollectResult {
  sessionId: string;
  pools: number;
  status: "completed" | "aborted" | "failed";
}

export async function runCollection(app: AppContext, o: CollectOptions = {}): Promise<CollectResult> {
  const { lc, db, log } = app;
  const c = lc.config;
  if (o.maxPools) c.discovery.max_pools = o.maxPools;
  const ep = endpoints(lc);
  recoverUncleanSessions(db, log);
  const sessionId = createSession(db, { kind: o.kind ?? "collect", configVersion: app.configVersion, label: o.label ?? c.session.label });
  const slog = log.child({ session: sessionId });
  const ac = new AbortController();
  const signal = ac.signal;
  o.signal?.addEventListener("abort", () => ac.abort(), { once: true });

  let stopReason = "completed";
  const onSig = (name: string) => () => {
    if (signal.aborted) return;
    slog.warn({ signal: name }, "shutdown requested; stopping collectors");
    console.error(`\n${name} received — stopping collectors and saving state...`);
    stopReason = "aborted";
    ac.abort();
  };
  const sigint = onSig("SIGINT");
  const sigterm = onSig("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  // Last line of defence for long unattended runs: an error thrown from an event callback is
  // logged and collection continues; a storm of them (> 50 in 10 min) stops the session cleanly.
  const uncaught: number[] = [];
  const onUncaught = (e: unknown) => {
    const now = Date.now();
    uncaught.push(now);
    while (uncaught.length && uncaught[0] < now - 600_000) uncaught.shift();
    slog.error({ err: (e as Error)?.message, stack: (e as Error)?.stack, recent: uncaught.length }, "uncaught error (continuing)");
    if (uncaught.length > 50 && !ac.signal.aborted) {
      stopReason = "aborted";
      ac.abort();
    }
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);

  const usage = new UsageTracker(c.rpc.quota.method_credits, sessionId);
  setEveryErrorHandler((e) => slog.error({ err: (e as Error).message, stack: (e as Error).stack }, "periodic task failed (continuing)"));
  const rpc = new RpcClient({
    url: ep.httpUrl, maxRps: c.rpc.max_rps, maxConcurrency: c.rpc.max_concurrency, timeoutMs: c.rpc.request_timeout_ms,
    retry: c.rpc.retry, commitment: c.rpc.commitment, usage, log: slog, signal,
  });
  // Separate budget for the bursty getTransaction traffic of the swap stream.
  const swapRpc = new RpcClient({
    url: ep.httpUrl, maxRps: c.collectors.swap_stream.max_rps, maxConcurrency: c.collectors.swap_stream.max_concurrency,
    timeoutMs: c.rpc.request_timeout_ms, retry: c.rpc.retry, commitment: c.rpc.commitment, usage, log: slog, signal,
  });
  // Token security uses heavy methods (getTokenLargestAccounts) that public RPCs throttle hard;
  // keep their 429s away from the critical client.
  const secRpc = new RpcClient({
    url: ep.httpUrl, maxRps: Math.max(0.5, c.rpc.max_rps / 4), maxConcurrency: 1, timeoutMs: c.rpc.request_timeout_ms,
    retry: { ...c.rpc.retry, max_attempts: 3 }, commitment: c.rpc.commitment, usage, log: slog, signal,
  });
  const api = new MeteoraApi({
    baseUrl: c.api.meteora_base_url, maxRps: c.api.max_rps, timeoutMs: c.api.request_timeout_ms, retry: c.api.retry, usage, log: slog, signal,
  });
  const rugcheck = c.collectors.token_security.use_rugcheck
    ? new JsonHttp({ baseUrl: c.api.rugcheck_base_url, maxRps: c.api.rugcheck_max_rps, timeoutMs: c.api.request_timeout_ms, retry: { ...c.api.retry, max_attempts: 2 }, usage, log: slog, signal }, "rugcheck")
    : null;
  const gaps = new GapTracker(db, sessionId, c.gaps.stale_after_seconds, slog);
  const bus = new MarketBus();

  let pools: PoolMeta[] = [];
  let status: CollectResult["status"] = "completed";
  try {
    // Health check before anything else.
    const slot = await rpc.call<number>("getSlot", [{ commitment: c.rpc.commitment }]);
    slog.info({ slot }, "rpc healthy");
    pools = await discoverPools({ api, rpc, db, log: slog, config: c }, sessionId);
    if (!pools.length) throw new Error("discovery returned no pools (check filters)");
    db.run("UPDATE sessions SET pool_count = ? WHERE session_id = ?", pools.length, sessionId);
    const poolMap = new Map(pools.map((p) => [p.pool, p]));
    const activeIds = new Map<string, number>();
    const usdPrices = new Map<string, { usd: number; ts: number }>();
    console.log(`session ${sessionId}: collecting ${pools.length} pools`);
    for (const p of pools) console.log(`  ${p.pool}  ${p.name.padEnd(20)} bin_step=${p.binStep} ${p.category}`);

    const chainDeps = { rpc, db, log: slog, bus, gaps, config: c, sessionId, pools: poolMap, activeIds };
    const apiDeps = { api, rpc, db, log: slog, bus, gaps, config: c, sessionId, pools: poolMap, usdPrices };
    const cc = c.collectors;
    const ws = cc.swap_stream.enabled
      ? new ReconnectingWs({ url: ep.wsUrl, heartbeatSeconds: c.rpc.ws.heartbeat_seconds, reconnectBaseDelayMs: c.rpc.ws.reconnect_base_delay_ms, reconnectMaxDelayMs: c.rpc.ws.reconnect_max_delay_ms, log: slog, signal })
      : null;
    ws?.on("up", () => slog.info("ws connected"));
    ws?.on("down", (reason: string) => slog.warn({ reason }, "ws down (backfill polling continues)"));

    const poolState = new PoolStateCollector(chainDeps);
    const binSnap = new BinSnapshotCollector(chainDeps);
    const metrics = new PoolMetricsCollector(apiDeps);
    const ohlcv = new OhlcvCollector(apiDeps);
    const eco = cc.ecosystem.enabled ? new EcosystemCollector(apiDeps) : null;
    // Swap stream only for the configured pool subset, under a per-session credit budget.
    const swapPools = new Map([...poolMap].filter(([, m]) => swapStreamEnabled(m, cc.swap_stream)));
    for (const p of pools) {
      db.run(
        "UPDATE session_pools SET discovery_json = json_set(COALESCE(discovery_json,'{}'), '$.swap_stream', json(?)) WHERE session_id = ? AND pool = ?",
        swapPools.has(p.pool) ? "true" : "false", sessionId, p.pool,
      );
    }
    const budget = new SwapBudget({
      swapBudget: cc.swap_stream.credit_budget,
      sessionBudget: c.rpc.quota.session_credit_budget,
      startTs: Date.now(),
      durationMs: o.durationMinutes ? o.durationMinutes * 60_000 : null,
      pacing: cc.swap_stream.pacing,
      burstPct: cc.swap_stream.pacing_burst_pct,
      swapCredits: () => swapRpc.creditsUsed,
      sessionCredits: () => rpc.creditsUsed + swapRpc.creditsUsed + secRpc.creditsUsed,
    });
    console.log(`swap stream: ${swapPools.size}/${pools.length} pools (${cc.swap_stream.include_categories.join(",")}), budget ${cc.swap_stream.credit_budget} credits${cc.swap_stream.pacing && o.durationMinutes ? " paced over the session" : ""}`);
    const swaps = new SwapStreamCollector({
      rpc: swapRpc, ws, db, log: slog, bus, gaps, config: c, sessionId, pools: swapPools, shouldYield: () => rpc.throttled, budget,
    });
    const security = new TokenSecurityCollector({ rpc: secRpc, rugcheck, db, log: slog, gaps, config: c, sessionId, pools: poolMap });

    // pool_state first so the bin snapshot knows where the active bin is
    await poolState.tick();
    const health = (): CollectionHealth => {
      const credits = rpc.creditsUsed + swapRpc.creditsUsed + secRpc.creditsUsed;
      return {
        credits, swapCredits: swapRpc.creditsUsed,
        quotaPct: ((credits + c.rpc.quota.credits_used_before_session) / c.rpc.quota.credit_limit) * 100,
        budget: budget.state(), rpcRps: rpc.currentRps, swapRps: swapRpc.currentRps,
        wsConnected: ws?.connected ?? null, wsReconnects: ws?.reconnects ?? 0, txQueue: swaps.queueLength,
        swapsStored: swaps.stats.swapsStored, openGaps: gaps.openGaps(), httpCalls: usage.totalCalls, httpErrors: usage.totalErrors,
      };
    };
    o.onReady?.({ sessionId, bus, pools: poolMap, gaps, usdPrices, ecosystem: eco, health });

    const tasks: Promise<unknown>[] = [];
    const guard = (name: string, p: Promise<unknown>) =>
      p.catch((e) => {
        slog.error({ collector: name, err: (e as Error).message, stack: (e as Error).stack }, "collector crashed");
        gaps.down(name, null, `collector crashed: ${(e as Error).message}`);
      });
    if (cc.pool_state.enabled) tasks.push(guard("pool_state", poolState.run(signal)));
    if (cc.bin_snapshot.enabled) tasks.push(guard("bin_snapshot", binSnap.run(signal)));
    if (cc.pool_metrics.enabled) tasks.push(guard("pool_metrics", metrics.run(signal)));
    if (cc.ohlcv.enabled) tasks.push(guard("ohlcv", ohlcv.run(signal)));
    if (eco) tasks.push(guard("ecosystem", eco.run(signal)));
    if (cc.swap_stream.enabled) tasks.push(guard("swap_stream", swaps.run(signal)));
    if (cc.token_security.enabled) tasks.push(guard("token_security", security.run(signal)));
    // P1/P2 sources (phase 7): each can be switched off independently
    const extraDeps = { db, log: slog, gaps, config: c, sessionId, pools: poolMap, api, rpc: secRpc, usage, signal };
    if (cc.venues.enabled) tasks.push(guard("venues", new VenueCollector(extraDeps).run(signal)));
    if (cc.attention.enabled) tasks.push(guard("attention", new AttentionCollector(extraDeps).run(signal)));
    if (cc.macro.enabled) tasks.push(guard("macro", new MacroCollector(extraDeps).run(signal)));
    // phase 13.2: LLM token features (only while llm is enabled AND its activation condition holds)
    if (c.llm.enabled) {
      const { LlmLayer } = await import("../llm/layer.ts");
      const { providerFromConfig } = await import("../llm/client.ts");
      const { LlmFeatureCollector } = await import("../llm/collector.ts");
      const { publicHttp } = await import("./extraCollectors.ts");
      try {
        const layer = new LlmLayer(db, c.llm, providerFromConfig(c.llm), slog);
        const dex = publicHttp(c, c.api.dexscreener_base_url, "dexscreener", { usage, log: slog, signal });
        tasks.push(guard("llm", new LlmFeatureCollector(db, c, layer, poolMap, dex, slog, sessionId).run(signal)));
      } catch (e) {
        slog.warn({ err: (e as Error).message }, "llm layer not started");
      }
    }
    // phase 11: real LP positions of other wallets (on-chain scans + Meteora Data API)
    if (c.real_lp.enabled) tasks.push(guard("real_lp", new RealLpCollector({ db, rpc: secRpc, api: api.http, config: c, log: slog, pools: poolMap, signal }).run(signal)));
    // phase 10: Jupiter token audit (organic score, bot holders, launchpad, dev, PVP)
    if (cc.token_audit.enabled) tasks.push(guard("token_audit", new TokenAuditCollector({ db, log: slog, gaps, config: c, sessionId, pools: poolMap, usage, signal }).run(signal)));
    if (ws) tasks.push(guard("ws", ws.run()));
    tasks.push(every(c.gaps.watchdog_interval_seconds * 1000, signal, async () => gaps.check()));
    // stop requests from another process (`dlmm session stop`)
    tasks.push(
      every(5000, signal, async () => {
        const req = db.get<{ id: number }>(
          "SELECT id FROM session_control WHERE action = 'stop' AND handled_at IS NULL AND (session_id = ? OR session_id = '*') ORDER BY id LIMIT 1",
          sessionId,
        );
        if (!req) return;
        db.run("UPDATE session_control SET handled_at = ? WHERE id = ?", Date.now(), req.id);
        slog.warn({ request: req.id }, "stop requested via session_control");
        console.error("stop requested — stopping collectors and saving state...");
        stopReason = "aborted";
        ac.abort();
      }),
    );
    const startedAt = Date.now();
    tasks.push(
      every(c.app.status_interval_seconds * 1000, signal, async () => {
        usage.flush(db);
        const credits = usage.totalCredits + c.rpc.quota.credits_used_before_session;
        const pct = (credits / c.rpc.quota.credit_limit) * 100;
        const st = {
          elapsedMin: Math.round((Date.now() - startedAt) / 60000),
          rpcCalls: usage.totalCalls, rpcErrors: usage.totalErrors, quotaPct: Number(pct.toFixed(2)),
          swapRps: Number(swapRpc.currentRps.toFixed(2)), rpcRps: Number(rpc.currentRps.toFixed(2)),
          credits: rpc.creditsUsed + swapRpc.creditsUsed + secRpc.creditsUsed, swapCredits: swapRpc.creditsUsed,
          swapBudgetNow: Math.round(budget.allowedNow()), budget: budget.state(),
          wsConnected: ws?.connected ?? null, wsReconnects: ws?.reconnects ?? 0, txQueue: swaps.queueLength, ...swaps.stats,
          openGaps: gaps.openGaps().length,
        };
        slog.info(st, "status");
        if (!o.quiet) console.log(`[${new Date().toISOString()}] ${JSON.stringify(st)}`);
        if (pct >= c.rpc.quota.warn_at_pct) slog.warn({ quotaPct: pct }, "RPC quota warning threshold reached");
      }),
    );
    if (o.durationMinutes) {
      tasks.push(
        sleep(o.durationMinutes * 60_000, signal).then(() => {
          if (!signal.aborted) {
            slog.info("duration reached");
            ac.abort();
          }
        }),
      );
    }
    await Promise.all(tasks);
    swaps.recordUnprocessed(Date.now());
    status = stopReason === "aborted" ? "aborted" : "completed";
  } catch (e) {
    status = "failed";
    slog.error({ err: (e as Error).message, stack: (e as Error).stack }, "collection failed");
    console.error(`collection failed: ${(e as Error).message}`);
    ac.abort();
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
    gaps.closeAll();
    usage.flush(db);
    finishSession(db, sessionId, status, { poolCount: pools.length });
    slog.info({ credits: rpc.creditsUsed + swapRpc.creditsUsed + secRpc.creditsUsed, swapCredits: swapRpc.creditsUsed }, "session credits");
    slog.info({ status }, "session finished");
  }
  return { sessionId, pools: pools.length, status };
}
