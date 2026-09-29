import type { Config } from "../config/schema.ts";
import type { Db, Row } from "../db/index.ts";
import type { PoolMeta } from "../collectors/types.ts";
import type { ReplayEvent } from "../sim/replay.ts";
import { pickPriority } from "../sim/replayRunner.ts";
import { FEATURE_SPECS } from "./compute.ts";
import { Scorer, securityLookup, type ScoreResult } from "./scorer.ts";
import { extraLookup } from "./extraLookup.ts";
import type { MemoryView } from "./compute.ts";
import { auditLookup, blocklistLookup, type BlocklistLookup } from "./safetyData.ts";
import { SmartLpLookup } from "./smartLp.ts";

/** Hour-of-day volume vs the pool's mean, from completed 1h candles before t (look-ahead safe). */
export function hourlyVolumeRatioFn(db: Db, minDays: number) {
  const cache = new Map<string, number | null>();
  return (pool: string, t: number): number | null => {
    const day = Math.floor(t / 86_400_000);
    const hour = new Date(t).getUTCHours();
    const k = `${pool}|${day}|${hour}`;
    if (cache.has(k)) return cache.get(k)!;
    const rows = db.all<{ ts: number; v: number }>(
      "SELECT ts, v FROM ohlcv WHERE pool = ? AND timeframe = '1h' AND ts + 3600000 <= ? ORDER BY ts DESC LIMIT ?",
      pool, t, Math.ceil(minDays * 24) + 24,
    );
    let r: number | null = null;
    if (rows.length >= minDays * 24) {
      const all = rows.reduce((s, x) => s + x.v, 0) / rows.length;
      const same = rows.filter((x) => new Date(x.ts).getUTCHours() === hour);
      const m = same.reduce((s, x) => s + x.v, 0) / Math.max(1, same.length);
      r = all > 0 ? m / all : null;
    }
    cache.set(k, r);
    return r;
  };
}

/**
 * Drives the Scorer from a time-ordered event stream and persists features + scores.
 * Decision times are on a fixed grid (start + k * interval); every event with ts <= t is fed
 * before scoring at t and nothing later is (blueprint 17.1).
 */
export class ScoringRunner {
  readonly scorer: Scorer;
  /** blocklist view (phase 10); invalidate() after an automatic addition */
  readonly blocklist: BlocklistLookup;
  private nextT: number;
  scored = 0;
  onScores: ((r: ScoreResult[]) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly c: Config,
    private readonly configVersion: string,
    private readonly sessionId: string,
    metas: PoolMeta[],
    startTs: number,
    private readonly persist = true,
    /** pools whose swap stream is collected (null = all) */
    swapPools: Set<string> | null = null,
    /** pool memory / cooldowns (phase 10, optional) */
    memory?: MemoryView,
  ) {
    this.blocklist = blocklistLookup(db);
    const macro = db.all<{ ts: number; name: string }>("SELECT ts, name FROM macro_events");
    this.scorer = new Scorer({
      config: c,
      metas,
      security: securityLookup(db, c.scoring.max_age_seconds.security * 1000),
      macroEvents: macro,
      hourlyVolumeRatio: hourlyVolumeRatioFn(db, c.scoring.context.low_volume_hour_min_days),
      extra: extraLookup(db, {
        venues: (c.scoring.max_age_seconds.venues ?? 1200) * 1000,
        attention: (c.scoring.max_age_seconds.attention ?? 1800) * 1000,
        macro: (c.scoring.max_age_seconds.macro ?? 1800) * 1000,
      }),
      audit: c.collectors.token_audit.enabled ? auditLookup(db, (c.scoring.max_age_seconds.audit ?? 2700) * 1000) : undefined,
      blocklist: this.blocklist,
      memory,
      smartLp: c.real_lp.enabled && c.scoring.features.smart_lp ? new SmartLpLookup(db, c.real_lp.smart, metas.map((m) => m.pool)) : undefined,
    });
    if (swapPools) for (const [pool, tr] of this.scorer.trackers) tr.swapsCollected = swapPools.has(pool);
    const iv = c.scoring.interval_seconds * 1000;
    this.nextT = Math.ceil(startTs / iv) * iv;
  }

  /** Replay: score every decision time strictly before the event, then ingest it. */
  feed(e: ReplayEvent) {
    this.advanceTo(e.ts - 1);
    this.ingest(e);
  }

  /** Route an event to the trackers without scoring (live mode scores on a timer at "now"). */
  ingest(e: ReplayEvent) {
    const s = this.scorer;
    switch (e.kind) {
      case "state":
        s.trackers.get(e.u.pool)?.onState(e.u);
        break;
      case "bins":
        s.trackers.get(e.s.pool)?.onBins(e.s);
        break;
      case "swap":
        s.trackers.get(e.s.pool)?.onSwap(e.s);
        break;
      case "metrics":
        s.trackers.get(e.pool)?.onMetrics({
          ts: e.ts, tvlUsd: e.tvlUsd ?? null, volume1h: e.volume1h ?? null, volume24h: e.volume24h ?? null,
          fee1h: e.fee1h ?? null, feeTvl1h: e.feeTvl1h ?? null, xUsd: e.tokenXUsd, yUsd: e.tokenYUsd,
        });
        break;
      case "eco":
        s.eco.onEco({ ts: e.ts, solUsd: e.solUsd, p75: pickPriority(this.c, e) });
        break;
      case "gap":
        for (const tr of s.trackers.values()) if (!e.pool || e.pool === tr.meta.pool) tr.onGap(e);
        break;
      case "activity":
        s.trackers.get(e.pool)?.onActivity(e);
        break;
    }
  }

  /** Score every pending decision time <= ts. */
  advanceTo(ts: number) {
    const iv = this.c.scoring.interval_seconds * 1000;
    while (this.nextT <= ts) {
      this.scoreAt(this.nextT);
      this.nextT += iv;
    }
  }

  scoreAt(t: number): ScoreResult[] {
    // Pools that have not produced any data yet are not scored.
    const results = this.scorer.scoreAll(t).filter((r) => this.scorer.trackers.get(r.pool)!.prices.length > 0);
    if (this.persist) this.store(results);
    this.scored += results.length;
    this.onScores?.(results);
    return results;
  }

  private store(results: ScoreResult[]) {
    const feats: Row[] = [];
    const scores: Row[] = [];
    for (const r of results) {
      for (const spec of FEATURE_SPECS) {
        const v = r.features.get(spec.name);
        feats.push({
          session_id: this.sessionId, pool: r.pool, ts: r.ts, name: spec.name,
          raw_value: v?.raw ?? null, norm_value: r.norm.get(spec.name) ?? null, freshness_s: v?.freshness ?? null,
        });
      }
      scores.push({
        session_id: this.sessionId, pool: r.pool, ts: r.ts, category: r.category,
        edge: r.modules.edge, regime: r.modules.regime, flow: r.modules.flow, attention: r.modules.attention,
        competition: r.modules.competition, safety: r.modules.safety,
        gate_passed: r.gate.passed ? 1 : 0, gate_reasons: JSON.stringify(r.gate.reasons),
        context_multiplier: r.context.multiplier, context_reasons: JSON.stringify(r.context.reasons),
        base_score: r.baseScore, final_score: r.finalScore, confidence: r.confidence, regime_label: r.regime,
        action: r.action, recommendation: JSON.stringify(r.recommendation), expectations: JSON.stringify(r.expectations),
        top_reasons: JSON.stringify(r.topReasons), weights_used: JSON.stringify(r.weights), config_version: this.configVersion,
      });
    }
    this.db.tx(() => {
      this.db.insertMany("features", feats, "OR REPLACE");
      this.db.insertMany("scores", scores, "OR REPLACE");
    });
  }
}

/** Pools with a collected swap stream in a data session (sessions before the flag: all pools). */
export function swapPoolsOf(db: Db, sessionId: string): Set<string> {
  const rows = db.all<{ pool: string; f: number | null }>(
    "SELECT pool, json_extract(discovery_json, '$.swap_stream') f FROM session_pools WHERE session_id = ?", sessionId,
  );
  return new Set(rows.filter((r) => r.f === null || r.f === 1).map((r) => r.pool));
}
