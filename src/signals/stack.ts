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
import { SignalBook } from "./signalEngine.ts";

export interface DecisionStack {
  scoring: ScoringRunner;
  book: SignalBook;
  exitEngine: ExitEngine;
  gridSignals: GridSignals;
  latestScore: Map<string, ScoreResult>;
  /** connect to a grid runner: every scoring round -> signals -> exit engine */
  attach(runner: GridRunner): void;
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
  const scoring = new ScoringRunner(db, c, configVersion, sessionId, metas, startTs, true, swapPools);
  const book = new SignalBook(db, c, sessionId, configVersion);
  const latestScore = new Map<string, ScoreResult>();
  const bluechip = new Set(c.categories.bluechip_tokens);
  const metaOf = new Map(metas.map((m) => [m.pool, m]));
  const security = securityLookup(db, c.scoring.max_age_seconds.security * 1000);
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
  const gridSignals: GridSignals = {
    book,
    exitEngine,
    expectedFeeUsd: (pool, valueUsd) => {
      const e = latestScore.get(pool)?.edge;
      if (!e) return null;
      return (e.feeUsd * valueUsd) / c.scoring.edge.capital_usd;
    },
    presetInputs: (pool, t, sim, windowMinutes) => {
      const tr = scoring.scorer.trackers.get(pool);
      const m = metaOf.get(pool);
      if (!tr || !m) return null;
      return presetInputsOf(tr, m, t, windowMinutes, c.scoring.depth_bins, sim.market.quoteUsd, bluechip, security);
    },
  };
  let runnerRef: GridRunner | null = null;
  scoring.onScores = (results) => {
    for (const r of results) latestScore.set(r.pool, r);
    book.onScores(results);
    if (results.length) runnerRef?.onScores(results[0].ts);
  };
  return { scoring, book, exitEngine, gridSignals, latestScore, attach: (r) => (runnerRef = r) };
}

/**
 * Meridian preset screen inputs from the look-ahead-free tracker (addendum 2.3):
 *  - fee / active TVL: LP fee over the window (bin fee accumulators) / liquidity within active +- k,
 *    falling back to the API hourly fee/TVL scaled to the window when accumulators do not cover it;
 *  - volume over the window: API 1h volume scaled to the window (we keep no 5-minute volume);
 *  - market cap: supply x token USD price (FDV proxy); holders / top-10 from token security;
 *  - organic score and bot holders need the Jupiter audit (phase 10): null -> preset_parsial.
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
  const price = tr.prices.length ? tr.prices[tr.prices.length - 1].price : null;
  const tokenUsd = quoteUsd === null ? null : riskIsX ? (price === null ? null : price * quoteUsd) : quoteUsd;
  return {
    feeActiveTvlPct,
    tvlUsd: met?.tvlUsd ?? null,
    volumeUsd: met?.volume1h != null ? (met.volume1h * windowMinutes) / 60 : null,
    binStep: m.binStep,
    organic: null,
    holders: sec?.total_holders ?? null,
    mcapUsd: sec?.supply_ui && tokenUsd !== null ? sec.supply_ui * tokenUsd : null,
    top10Pct: sec?.top10_pct ?? null,
    botHoldersPct: null,
    bluechip: token === null,
  };
}
