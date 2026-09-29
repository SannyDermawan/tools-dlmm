import { randomUUID } from "node:crypto";
import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import type { Action, ScoreResult } from "../features/scorer.ts";

/** Blueprint 11 — one signal per pool per decision time (skipped ones included). */
export interface Signal {
  signal_id: string;
  timestamp: string;
  ts: number;
  session_id: string;
  config_version: string;
  pool: string;
  pool_category: string;
  action: Action;
  safety_gate: { passed: boolean; reasons: string[]; filters?: string[] };
  /** every identified risk, veto or not (decision log, addendum 3.6) */
  risks?: string[];
  scores: Record<string, number | null>;
  context_multiplier: number;
  final_score: number | null;
  confidence: number;
  regime_label: string | null;
  recommendation: {
    strategy: string;
    sides: string;
    bins_below: number;
    bins_above: number;
    price_min: number;
    price_max: number;
    size_fraction: number;
  } | null;
  expectations: {
    net_return_per_hour_pct: number;
    fee_il_ratio: number | null;
    p_in_range: number;
    horizon_minutes: number;
  } | null;
  top_reasons: string[];
}

const round = (v: number | null, d = 2) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Recommended share of capital: base for MASUK, small for PANTAU, zero for LEWATI, scaled by
 * confidence and capped (blueprint 10.1: low confidence lowers the size).
 */
export function sizeFraction(action: Action, confidence: number, c: Config["signals"]["size"]): number {
  if (action === "LEWATI") return 0;
  const base = action === "MASUK" ? c.base_fraction : c.watch_fraction;
  return Math.min(c.max_fraction, base * Math.max(0, Math.min(1, confidence)));
}

export function buildSignal(r: ScoreResult, ctx: { sessionId: string; configVersion: string; config: Config; idGen?: () => string }): Signal {
  const rec = r.recommendation as Record<string, number | string> | null;
  const exp = r.expectations as Record<string, number | null> | null;
  return {
    signal_id: (ctx.idGen ?? randomUUID)(),
    timestamp: new Date(r.ts).toISOString(),
    ts: r.ts,
    session_id: ctx.sessionId,
    config_version: ctx.configVersion,
    pool: r.pool,
    pool_category: r.category,
    action: r.action,
    safety_gate: { passed: r.gate.passed, reasons: r.gate.reasons, filters: r.gate.filters ?? [] },
    risks: r.risks ?? [],
    scores: Object.fromEntries(Object.entries(r.modules).map(([k, v]) => [k, round(v, 1)])),
    context_multiplier: r.context.multiplier,
    final_score: round(r.finalScore, 1),
    confidence: round(r.confidence, 2) ?? 0,
    regime_label: r.regime,
    recommendation: rec
      ? {
          strategy: String(rec.strategy),
          sides: String(rec.sides),
          bins_below: Number(rec.bins_below),
          bins_above: Number(rec.bins_above),
          price_min: Number(rec.price_min),
          price_max: Number(rec.price_max),
          size_fraction: round(sizeFraction(r.action, r.confidence, ctx.config.signals.size), 4) ?? 0,
        }
      : null,
    expectations: exp
      ? {
          net_return_per_hour_pct: round(Number(exp.net_return_per_hour_pct), 3) ?? 0,
          fee_il_ratio: round(exp.fee_il_ratio as number | null, 2),
          p_in_range: round(Number(exp.p_in_range), 3) ?? 0,
          horizon_minutes: Number(exp.horizon_minutes),
        }
      : null,
    top_reasons: r.topReasons,
  };
}

/** LEWATI signals of one round with the main reason: first gate reason, else score / confidence. */
export function rejectedCandidates(signals: Signal[]): { pool: string; score: number | null; action: Action; reason: string }[] {
  return signals
    .filter((s) => s.action === "LEWATI")
    .map((s) => ({
      pool: s.pool, score: s.final_score, action: s.action,
      reason: !s.safety_gate.passed ? `gate: ${s.safety_gate.reasons[0] ?? "failed"}` : s.final_score === null ? "no score (missing data)" : "score / confidence below threshold",
    }));
}

/**
 * Signal Engine: turns every score into a signal, journals it (taken = 0 until a position uses
 * it) and keeps the latest signal per pool for entry decisions.
 */
export class SignalBook {
  private latest = new Map<string, Signal>();
  count = 0;

  constructor(
    private readonly db: Db | null,
    private readonly c: Config,
    private readonly sessionId: string,
    private readonly configVersion: string,
    private readonly idGen?: () => string,
  ) {}

  onScores(results: ScoreResult[]): Signal[] {
    const out = results.map((r) => buildSignal(r, { sessionId: this.sessionId, configVersion: this.configVersion, config: this.c, idGen: this.idGen }));
    for (const s of out) this.latest.set(s.pool, s);
    this.count += out.length;
    if (this.db && out.length) {
      // decision log: the pools skipped in this round (and why), kept with every MASUK / PANTAU
      const rejected = rejectedCandidates(out);
      this.db.insertMany(
        "signals",
        out.map((s) => ({
          signal_id: s.signal_id, session_id: s.session_id, pool: s.pool, ts: s.ts, action: s.action,
          recommendation: JSON.stringify(s.recommendation), expectations: JSON.stringify(s.expectations),
          top_reasons: JSON.stringify(s.top_reasons), taken: 0, config_version: s.config_version, payload: JSON.stringify(s),
          risks: JSON.stringify(s.risks),
          rejected_candidates: s.action === "LEWATI" ? null : JSON.stringify(rejected),
        })),
      );
    }
    return out;
  }

  /** Latest signal of a pool no older than max_signal_age_seconds at time t (and not from the future). */
  latestFor(pool: string, t: number): Signal | null {
    const s = this.latest.get(pool);
    if (!s || s.ts > t || t - s.ts > this.c.signals.max_signal_age_seconds * 1000) return null;
    return s;
  }

  markTaken(signalId: string) {
    this.db?.run("UPDATE signals SET taken = 1 WHERE signal_id = ?", signalId);
  }
}
