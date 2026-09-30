import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import type { PoolMeta } from "../collectors/types.ts";
import { ScoringRunner } from "../features/runner.ts";
import { securityLookup, type ScoreResult } from "../features/scorer.ts";
import type { SecurityRow } from "../features/compute.ts";
import type { PoolTracker } from "../features/tracker.ts";
import type { PresetInputs } from "../sim/meridian.ts";
import type { GridRunner, GridSignals } from "../sim/gridRunner.ts";
import { ExitEngine } from "./exitEngine.ts";
import { tokenFlowLookup } from "../collectors/tokenFlow.ts";
import { SignalBook } from "./signalEngine.ts";
import { PoolMemory } from "../features/memory.ts";
import { AthLookup } from "../features/ath.ts";
import { RugDetector } from "../features/rugDetector.ts";
import { SmartLpLookup } from "../features/smartLp.ts";
import { auditLookup, type AuditRow } from "../features/safetyData.ts";

export interface DecisionStack {
  scoring: ScoringRunner;
  book: SignalBook;
  exitEngine: ExitEngine;
  gridSignals: GridSignals;
  latestScore: Map<string, ScoreResult>;
  /** pool memory / cooldowns (phase 10) */
  memory: PoolMemory;
  /** automatic rug detection -> blocklist (phase 10) */
  rugs: RugDetector;
  /** connect to a grid runner: every scoring round -> signals -> exit engine */
  attach(runner: GridRunner): void;
  /** a pool added during the session (fresh lane) */
  addPool(m: PoolMeta, swapsCollected: boolean): void;
}

/**
 * Scoring (phase 4) + Signal Engine + Exit Engine (phase 5) on one event stream; used by both the
 * live session and replay so both behave identically.
 */
export function buildDecisionStack(
  db: Db,
  c: Config,
  configVersion: string,
  sessionId: string,
  metas: PoolMeta[],
  startTs: number,
  swapPools: Set<string> | null,
): DecisionStack {
  const bluechip = new Set(c.categories.bluechip_tokens);
  const metaOf = new Map(metas.map((m) => [m.pool, m]));
  const riskTokensOf = (pool: string) => {
    const m = metaOf.get(pool);
    return m ? [m.tokenX, m.tokenY].filter((t) => !bluechip.has(t)) : [];
  };
  const memory = new PoolMemory(db, c, sessionId, (pool) => riskTokensOf(pool)[0] ?? null);
  const scoring = new ScoringRunner(db, c, configVersion, sessionId, metas, startTs, true, swapPools, memory);
  const rugs = new RugDetector(db, c, riskTokensOf, () => scoring.blocklist.invalidate());
  const book = new SignalBook(db, c, sessionId, configVersion);
  const latestScore = new Map<string, ScoreResult>();
  const audit = c.collectors.token_audit.enabled ? auditLookup(db, (c.scoring.max_age_seconds.audit ?? 2700) * 1000) : null;
  const security = securityLookup(db, c.scoring.max_age_seconds.security * 1000);
  const tokenFlow = c.collectors.token_flow.enabled ? tokenFlowLookup(db, c.collectors.token_flow.max_age_seconds * 1000) : null;
  const exitEngine = new ExitEngine(
    c,
    (pool) => scoring.scorer.trackers.get(pool),
    (pool, t) => book.latestFor(pool, t),
    (pool, t) => {
      const m = metaOf.get(pool);
      if (!m) return null;
      const riskIsX = !bluechip.has(m.tokenX);
      const token = riskIsX ? m.tokenX : bluechip.has(m.tokenY) ? null : m.tokenY;
      if (!token) return null;
      const r = security(token, t);
      return r?.supply_ui ? { riskIsX, supply: r.supply_ui } : null;
    },
  );
  const athLookup = new AthLookup(db);
  // smart LPs present in a pool at entry (journaled with every position; look-ahead safe, see SmartLpLookup)
  const lpPools = [...metaOf.keys()]; // grows with pools added during a session (reloaded every 10 min)
  const smartLp = c.real_lp.enabled ? new SmartLpLookup(db, c.real_lp.smart, lpPools) : null;
  const gridSignals: GridSignals = {
    book,
    ath: (pool, t) => {
      const m = metaOf.get(pool);
      return m && !bluechip.has(m.tokenX) ? athLookup.at(pool, t) : null; // the pool price is that of the base token only when it is the risk token
    },
    exitEngine,
    memory,
    indicators: scoring.indicators ?? undefined,
    smartLp: smartLp ? (pool, t) => { const r = smartLp.at(pool, t); return r ? { smart: r.count, openPositions: r.openPositions } : null; } : undefined,
    tokenInfo: (pool, t) => {
      const m = metaOf.get(pool);
      const token = m ? (bluechip.has(m.tokenX) ? (bluechip.has(m.tokenY) ? null : m.tokenY) : m.tokenX) : null;
      const a = token && audit ? audit(token, t) : null;
      const born = a ? (a.token_created_at ?? a.first_pool_at) : null;
      const sec = token ? security(token, t) : null;
      return {
        tokenAgeHours: born !== null && born !== undefined ? Math.max(0, (t - born) / 3_600_000) : null, mcapUsd: a?.mcap_usd ?? null,
        riskIsBase: m ? !bluechip.has(m.tokenX) : undefined,
        top10Pct: sec?.top10_pct ?? a?.top_holders_pct ?? null, holders: sec?.total_holders ?? a?.holder_count ?? null,
        organic: a?.organic_score ?? null, botHoldersPct: a?.bot_holders_pct ?? null, bundlerPct: a?.bundler_holding_pct ?? null,
      };
    },
    expectedFeeUsd: (pool, valueUsd) => {
      const e = latestScore.get(pool)?.edge;
      if (!e) return null;
      return (e.feeUsd * valueUsd) / c.scoring.edge.capital_usd;
    },
    flow: (pool, t) => {
      const tr = scoring.scorer.trackers.get(pool);
      const m = metaOf.get(pool);
      if (!tr || !m) return null;
      const riskIsX = !bluechip.has(m.tokenX);
      const token = riskIsX ? m.tokenX : !bluechip.has(m.tokenY) ? m.tokenY : null;
      const tf = token && tokenFlow ? tokenFlow(token, t) : null;
      const pair = (k: "holder_count" | "bundler_pct") =>
        tf?.prev && tf.now[k] !== null && tf.prev[k] !== null ? { now: tf.now[k] as number, prev: tf.prev[k] as number } : null;
      return {
        t, minutes: tr.minuteFlow(t, 4), riskIsX, tvlUsd: tr.metrics?.tvlUsd ?? null,
        holders: pair("holder_count"), bundlerPct: pair("bundler_pct"),
      };
    },
    fridayInputs: (pool, t) => {
      const tr = scoring.scorer.trackers.get(pool);
      const m = metaOf.get(pool);
      if (!tr || !m) return null;
      const token = !bluechip.has(m.tokenX) ? m.tokenX : !bluechip.has(m.tokenY) ? m.tokenY : null;
      const sec = token ? security(token, t) : null;
      const auth = (v: number | null | undefined) => (v === null || v === undefined ? null : v === 1);
      return {
        tvlUsd: tr.metrics?.tvlUsd ?? null,
        mintAuthority: token ? auth(sec?.mint_auth_active) : false,
        freezeAuthority: token ? auth(sec?.freeze_auth_active) : false,
      };
    },
    presetInputs: (pool, t, sim, windowMinutes) => {
      const tr = scoring.scorer.trackers.get(pool);
      const m = metaOf.get(pool);
      if (!tr || !m) return null;
      return presetInputsOf(tr, m, t, windowMinutes, c.scoring.depth_bins, sim.market.quoteUsd, bluechip, security, audit);
    },
  };
  let runnerRef: GridRunner | null = null;
  scoring.onScores = (results) => {
    for (const r of results) latestScore.set(r.pool, r);
    // blocks found now take effect from the next scoring round (added_at = t)
    if (results.length) rugs.check(scoring.scorer.trackers.values(), results[0].ts);
    book.onScores(results);
    if (results.length) runnerRef?.onScores(results[0].ts);
  };
  const addPool = (m: PoolMeta, swapsCollected: boolean) => {
    metaOf.set(m.pool, m);
    if (!lpPools.includes(m.pool)) lpPools.push(m.pool);
    scoring.addPool(m, swapsCollected);
  };
  return { scoring, book, exitEngine, gridSignals, latestScore, memory, rugs, attach: (r) => (runnerRef = r), addPool };
}

/**
 * Meridian preset screen inputs from the look-ahead-free tracker (addendum 2.3):
 *  - fee / active TVL: LP fee over the window (bin fee accumulators) / liquidity within active +- k,
 *    falling back to the API hourly fee/TVL scaled to the window when accumulators do not cover it;
 *  - volume over the window: API 1h volume scaled to the window (we keep no 5-minute volume);
 *  - market cap: supply x token USD price (FDV proxy); holders / top-10 from token security;
 *  - organic score and bot holders from the Jupiter audit (phase 10); null without it -> preset_parsial.
 */
export function presetInputsOf(
  tr: PoolTracker,
  m: PoolMeta,
  t: number,
  windowMinutes: number,
  depthBins: number,
  quoteUsd: number | null,
  bluechip: Set<string>,
  security: (token: string, t: number) => SecurityRow | null,
  audit: ((token: string, t: number) => AuditRow | null) | null = null,
): PresetInputs {
  const winMs = windowMinutes * 60_000;
  const met = tr.metrics;
  let feeWin = 0;
  let covered = 0;
  for (const f of tr.fees) {
    if (f.ts <= t - winMs || f.ts > t) continue;
    feeWin += f.usd;
    covered += f.dtMs;
  }
  let activeTvl = 0;
  const snap = tr.snap;
  if (snap) for (const [id, v] of tr.depthUsd()) if (Math.abs(id - snap.activeId) <= depthBins) activeTvl += v;
  let feeActiveTvlPct: number | null = null;
  if (covered >= winMs * 0.8 && activeTvl > 0) feeActiveTvlPct = ((feeWin * (winMs / covered)) / activeTvl) * 100;
  else if (met?.feeTvl1h != null) feeActiveTvlPct = (met.feeTvl1h * windowMinutes) / 60;
  const riskIsX = !bluechip.has(m.tokenX);
  const token = riskIsX ? m.tokenX : bluechip.has(m.tokenY) ? null : m.tokenY;
  const sec = token ? security(token, t) : null;
  const au = token && audit ? audit(token, t) : null;
  const price = tr.prices.length ? tr.prices[tr.prices.length - 1].price : null;
  const tokenUsd = quoteUsd === null ? null : riskIsX ? (price === null ? null : price * quoteUsd) : quoteUsd;
  return {
    feeActiveTvlPct,
    tvlUsd: met?.tvlUsd ?? null,
    volumeUsd: met?.volume1h != null ? (met.volume1h * windowMinutes) / 60 : null,
    binStep: m.binStep,
    organic: au?.organic_score ?? null,
    holders: sec?.total_holders ?? au?.holder_count ?? null,
    mcapUsd: sec?.supply_ui && tokenUsd !== null ? sec.supply_ui * tokenUsd : (au?.mcap_usd ?? null),
    top10Pct: sec?.top10_pct ?? au?.top_holders_pct ?? null,
    botHoldersPct: au?.bot_holders_pct ?? null,
    bluechip: token === null,
  };
}
