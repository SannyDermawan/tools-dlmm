import type { Config, ModuleName, PoolCategory, RegimeLabel } from "../config/schema.ts";
import { MODULES } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import type { PoolMeta } from "../collectors/types.ts";
import { binUiPrice } from "../math/bin.ts";
import { computeFeatures, FEATURE_SPECS, sigma1m, type RawFeatures, type SecurityRow } from "./compute.ts";
import { estimateEdge, hashSeed, type EdgeResult } from "./edge.ts";
import { Normalizer, percentileRank, type NormFeatures } from "./normalize.ts";
import { EcoTracker, PoolTracker } from "./tracker.ts";
import type { ExtraLookup } from "./extraLookup.ts";
import { auditGate } from "./auditGate.ts";
import type { AuditRow, BlockHit, BlocklistLookup } from "./safetyData.ts";
import type { MemoryView } from "./compute.ts";

export type Action = "MASUK" | "PANTAU" | "LEWATI";

export interface GateResult {
  passed: boolean;
  reasons: string[];
  missingData: boolean;
  /** filters that vetoed the pool (phase 10 report: pools removed per filter) */
  filters?: string[];
}

export interface ScoreResult {
  pool: string;
  ts: number;
  category: PoolCategory;
  features: RawFeatures;
  norm: NormFeatures;
  modules: Record<ModuleName, number | null>;
  gate: GateResult;
  context: { multiplier: number; reasons: string[] };
  weights: Partial<Record<ModuleName, number>>;
  baseScore: number | null;
  finalScore: number | null;
  confidence: number;
  regime: RegimeLabel | null;
  action: Action;
  edge: EdgeResult | null;
  edgeCandidates: EdgeResult[];
  recommendation: Record<string, unknown> | null;
  expectations: Record<string, unknown> | null;
  topReasons: string[];
  /** identified risks (decision log, addendum 3.6) */
  risks: string[];
}

const SPEC = new Map(FEATURE_SPECS.map((f) => [f.name, f]));
/** Blueprint features without a data source yet (P1/P2); not counted against confidence. */
const NO_SOURCE_YET = new Set<string>();
/** Phase 10 features that are optional sources (Jupiter audit, pool memory): never lower confidence. */
const OPTIONAL_FEATURES = new Set(["organic_score", "bot_holders_pct", "pvp_rival_count", "token_age_hours", "pool_hist_net_pct", "pool_hist_win_rate", "requires_bin_array_init"]);
/** Flow features (blueprint 8.2 core + P1 extensions). */
export const FLOW_FEATURES = ["trader_diversity", "top5_wallet_share", "markout_60s", "buy_sell_balance", "markout_30s", "markout_300s", "wash_share", "whale_share"];
const val = (f: RawFeatures, k: string) => f.get(k)?.raw ?? null;

export function regimeLabel(f: RawFeatures, c: Config["scoring"]["regime"]): RegimeLabel | null {
  const vol = val(f, "realized_vol");
  const er = val(f, "efficiency_ratio");
  const z = val(f, "trend_z");
  if (vol === null || er === null || z === null) return null;
  if (vol >= c.vol_extreme_per_hour) return "chaos";
  if (er >= c.er_trend && Math.abs(z) >= c.z_trend) return z > 0 ? "trending_up" : "trending_down";
  if (vol >= c.vol_high_per_hour) return "volatile_no_direction";
  return "sideways";
}

/** Safety gate (blueprint 9.1): veto before any score is combined. */
export function safetyGate(
  category: PoolCategory,
  rows: (SecurityRow | null)[],
  tvlUsd: number | null,
  c: Config["scoring"]["safety_gate"],
): GateResult {
  const reasons: string[] = [];
  let missing = false;
  for (const r of rows) {
    if (!r) {
      missing = true;
      continue;
    }
    if (c.fail_on_mint_authority && r.mint_auth_active) reasons.push(`mint authority active (${r.token.slice(0, 6)})`);
    if (c.fail_on_freeze_authority && r.freeze_auth_active) reasons.push(`freeze authority active (${r.token.slice(0, 6)})`);
    if (r.transfer_fee_bps !== null && r.transfer_fee_bps / 100 > c.max_transfer_fee_pct) reasons.push(`transfer fee ${(r.transfer_fee_bps / 100).toFixed(2)}%`);
    if (r.rugged) reasons.push("flagged rugged");
    if (r.top10_pct === null) missing = true;
    else if (r.top10_pct > c.max_top10_pct) reasons.push(`top10 holders ${r.top10_pct.toFixed(1)}% > ${c.max_top10_pct}%`);
    if (r.cluster_pct !== null && r.cluster_pct > c.max_cluster_pct) reasons.push(`wallet cluster ${r.cluster_pct.toFixed(1)}% > ${c.max_cluster_pct}%`);
    if (r.dev_rug_count !== null && r.dev_rug_count >= c.max_dev_rugs) reasons.push(`dev history: ${r.dev_rug_count} dead tokens`);
  }
  if (tvlUsd === null) missing = true;
  else if (tvlUsd < c.min_tvl_usd) reasons.push(`TVL $${tvlUsd.toFixed(0)} < $${c.min_tvl_usd}`);
  if (missing && c.missing_data[category] === "fail") reasons.push("security data unavailable");
  return { passed: reasons.length === 0, reasons, missingData: missing };
}

/** Effective weights: enabled modules with a score, rescaled to sum 100 (blueprint 10). */
export function effectiveWeights(
  base: Record<ModuleName, number>,
  available: Record<ModuleName, number | null>,
  enabled: Record<ModuleName, boolean>,
): Partial<Record<ModuleName, number>> {
  const act = MODULES.filter((m) => enabled[m] && available[m] !== null && base[m] > 0);
  const sum = act.reduce((s, m) => s + base[m], 0);
  const out: Partial<Record<ModuleName, number>> = {};
  if (sum <= 0) return out;
  for (const m of act) out[m] = (base[m] / sum) * 100;
  return out;
}

export function decideAction(finalScore: number | null, gatePassed: boolean, confidence: number, c: Config["scoring"]): Action {
  if (!gatePassed || finalScore === null) return "LEWATI";
  if (finalScore >= c.thresholds.enter) return confidence >= c.confidence.min_for_enter ? "MASUK" : "PANTAU";
  if (finalScore >= c.thresholds.watch) return "PANTAU";
  return "LEWATI";
}

const mean = (a: (number | null | undefined)[], min = 1): number | null => {
  const v = a.filter((x): x is number => x !== null && x !== undefined);
  return v.length >= min ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

export interface ScorerDeps {
  config: Config;
  metas: PoolMeta[];
  security: (token: string, t: number) => SecurityRow | null;
  macroEvents: { ts: number; name: string }[];
  hourlyVolumeRatio?: (pool: string, t: number) => number | null;
  /** phase 7 sources (optional) */
  extra?: ExtraLookup;
  /** phase 10 (optional): Jupiter audit, blocklist, pool memory */
  audit?: (token: string, t: number) => AuditRow | null;
  blocklist?: BlocklistLookup;
  memory?: MemoryView;
}

/**
 * Scoring Engine (blueprint 7 steps 2-5). Holds a PoolTracker per pool (fed in time order) and
 * scores all pools at decision time t from data with ts <= t only.
 */
export class Scorer {
  readonly trackers = new Map<string, PoolTracker>();
  readonly eco: EcoTracker;
  private readonly normalizer: Normalizer;
  private readonly bluechip: Set<string>;

  constructor(private readonly d: ScorerDeps) {
    const sc = d.config.scoring;
    const keep = Math.max(sc.window_minutes, sc.features.er_minutes, 90) * 60_000;
    for (const m of d.metas) this.trackers.set(m.pool, new PoolTracker(m, keep, sc.depth_bins, sc.edge.fee_offsets));
    this.eco = new EcoTracker(keep);
    this.normalizer = new Normalizer(sc.normalization);
    this.bluechip = new Set(d.config.categories.bluechip_tokens);
  }

  riskTokens(m: PoolMeta): string[] {
    return [m.tokenX, m.tokenY].filter((t) => !this.bluechip.has(t));
  }

  scoreAll(t: number): ScoreResult[] {
    const c = this.d.config;
    const sc = c.scoring;
    this.eco.assertNotAfter(t);
    const raw = new Map<string, RawFeatures>();
    // blocklist first (addendum 3.2): blocked pools skip the expensive feature computation
    const blockedPools = new Map<string, BlockHit[]>();
    for (const [pool, tr] of this.trackers) {
      const hits = this.blockHits(tr.meta, t);
      if (hits.length && sc.safety_gate.blocklist) blockedPools.set(pool, hits);
    }
    for (const [pool, tr] of this.trackers) {
      tr.assertNotAfter(t); // explicit look-ahead check
      if (blockedPools.has(pool)) continue;
      raw.set(pool, computeFeatures(tr, {
        config: c, t, eco: this.eco, security: this.d.security, macroEvents: this.d.macroEvents, riskTokens: this.riskTokens(tr.meta),
        extra: this.d.extra, audit: this.d.audit, memory: this.d.memory,
      }));
    }
    const norm = this.normalizer.normalize(raw);

    // edge candidates per pool (needs regime for the strategy choice)
    const edges = new Map<string, { best: EdgeResult | null; all: EdgeResult[]; regime: RegimeLabel | null }>();
    for (const [pool, tr] of this.trackers) {
      if (blockedPools.has(pool)) continue;
      const f = raw.get(pool)!;
      const regime = regimeLabel(f, sc.regime);
      edges.set(pool, { ...this.edgeFor(tr, f, regime, t), regime });
    }
    const edgeVals = [...edges.values()].map((e) => e.best?.edgePerHourPct).filter((x): x is number => x !== undefined);

    const out: ScoreResult[] = [];
    for (const [pool, tr] of this.trackers) {
      const m = tr.meta;
      const hits = blockedPools.get(pool);
      if (hits) {
        out.push(this.blockedResult(pool, m.category, t, hits));
        continue;
      }
      const f = raw.get(pool)!;
      const n = norm.get(pool)!;
      const e = edges.get(pool)!;
      const modules: Record<ModuleName, number | null> = { edge: null, regime: null, flow: null, attention: null, competition: null, safety: null };
      if (e.best) {
        let s = percentileRank(e.best.edgePerHourPct, edgeVals, sc.normalization.winsor_pct);
        if (e.best.netUsd <= 0) s = Math.min(s, sc.edge.max_score_if_nonpositive);
        modules.edge = s;
      }
      if (e.regime) {
        let s = sc.regime.scores[e.regime];
        const solEr = val(f, "sol_trend_er");
        if (solEr !== null && solEr >= sc.regime.er_trend) s = Math.max(0, s - sc.regime.sol_trend_penalty);
        const btcEr = val(f, "btc_trend_er");
        if (btcEr !== null && btcEr >= sc.regime.er_trend) s = Math.max(0, s - sc.regime.btc_trend_penalty);
        modules.regime = s;
      }
      modules.flow = mean(FLOW_FEATURES.map((k) => n.get(k)), 2);
      modules.competition = mean(["lp_crowding", "bot_rebalance_freq", "pool_volume_share"].map((k) => n.get(k)), 1);
      // attention proxies (P1-P2): only weighted when scoring.modules.attention is on
      modules.attention = mean(["trending_score", "boosts_active", "social_presence", "launchpad_heat"].map((k) => n.get(k)), 2);
      const secRows = this.riskTokens(m).map((tk) => this.d.security(tk, t));
      const g = sc.safety_gate;
      if (m.category === "bluechip") modules.safety = 100;
      else {
        const margins = [
          val(f, "holder_top10") !== null ? 100 * (1 - val(f, "holder_top10")! / g.max_top10_pct) : null,
          val(f, "cluster_share") !== null ? 100 * (1 - val(f, "cluster_share")! / g.max_cluster_pct) : null,
          val(f, "dev_rug_history") !== null ? 100 * (1 - val(f, "dev_rug_history")! / g.max_dev_rugs) : null,
        ].map((x) => (x === null ? null : Math.max(0, Math.min(100, x))));
        const bot = val(f, "bot_holders_pct");
        if (bot !== null) margins.push(Math.max(0, Math.min(100, 100 * (1 - bot / g.max_bot_holders_pct))));
        modules.safety = mean(margins, 1);
      }
      const gate = safetyGate(m.category, secRows, tr.metrics?.tvlUsd ?? null, g);
      gate.filters = gate.passed ? [] : ["blueprint_gate"];
      // phase 10: Jupiter audit, PVP, launchpad, token age (addendum 3.1 / 3.3)
      const audits = this.d.audit ? this.riskTokens(m).map((tk) => this.d.audit!(tk, t)) : [];
      const ag = this.d.audit ? auditGate(m.category, audits, [], t, g) : null;
      if (ag) {
        if (ag.reasons.length) {
          gate.reasons.push(...ag.reasons);
          gate.passed = false;
          gate.filters.push(...ag.filters);
        }
        if (modules.safety !== null && ag.penalty > 0) modules.safety = Math.max(0, modules.safety - ag.penalty);
      }

      // context multiplier (blueprint 9.7)
      const cx = sc.context;
      const reasons: string[] = [];
      let mult = 1;
      let blocked = false;
      for (const src of cx.blocking_gap_sources) if (tr.openGap(src, t)) (blocked = true), reasons.push(`data gap active: ${src}`);
      for (const [k, src] of [["dyn_fee_rate", "pool_state"], ["active_liq_depth", "bin_snapshot"], ["vol_trend_1h", "pool_metrics"]] as const) {
        if (f.get(k)?.freshness === null) (blocked = true), reasons.push(`stale/missing ${src}`);
      }
      if (val(f, "macro_event_window") === 1) (mult *= cx.macro_multiplier), reasons.push("macro event window");
      const p75 = val(f, "priority_fee_p75");
      if (p75 !== null && p75 > cx.priority_fee_p75_threshold) (mult *= cx.congestion_multiplier), reasons.push("network congested");
      const hv = this.d.hourlyVolumeRatio?.(pool, t) ?? null;
      if (hv !== null && hv < cx.low_volume_hour_ratio) (mult *= cx.low_volume_hour_multiplier), reasons.push("historically quiet hour");
      mult = blocked ? 0 : Math.max(cx.floor, mult);

      const baseW = sc.weights[c.weights_profile][m.category];
      const weights = effectiveWeights(baseW, modules, sc.modules);
      const wsum = Object.values(weights).reduce((s, w) => s + (w ?? 0), 0);
      const baseScore = wsum > 0 ? Object.entries(weights).reduce((s, [k, w]) => s + (w ?? 0) * (modules[k as ModuleName] ?? 0), 0) / wsum : null;
      const finalScore = baseScore === null ? null : baseScore * mult;

      // confidence (blueprint 10.1): completeness x module coverage x (bluechip missing-data penalty)
      // features that apply to this pool: enabled module with weight > 0 for its category, and
      // no flow features when the pool has no swap stream by configuration
      const specs = FEATURE_SPECS.filter((s) => {
        if (s.module === "context" || NO_SOURCE_YET.has(s.name) || OPTIONAL_FEATURES.has(s.name)) return false;
        const mod = s.module as ModuleName;
        if (!sc.modules[mod] || baseW[mod] <= 0) return false;
        if (mod === "flow" && !tr.swapsCollected) return false;
        return s.direction !== 0 || mod === "regime"; // regime uses raw ER / trend / vol
      });
      const completeness = specs.filter((s) => f.get(s.name)?.raw !== null && f.get(s.name) !== undefined).length / specs.length;
      const origSum = MODULES.reduce((s, k) => s + (sc.modules[k] ? baseW[k] : 0), 0);
      const activeOrig = Object.keys(weights).reduce((s, k) => s + baseW[k as ModuleName], 0);
      let confidence = Math.sqrt(completeness) * (origSum > 0 ? activeOrig / origSum : 0);
      if (gate.missingData && g.missing_data[m.category] === "lower_confidence") confidence *= 0.8;
      confidence = Math.max(0, Math.min(1, confidence));
      const action = decideAction(finalScore, gate.passed, confidence, sc);

      const best = e.best;
      const lastState = tr.prices[tr.prices.length - 1];
      const recommendation = best && lastState
        ? {
            strategy: best.strategy, sides: best.sides, bins_below: best.binsBelow, bins_above: best.binsAbove,
            price_min: binUiPrice(lastState.activeId - best.binsBelow, m.binStep, m.decimalsX, m.decimalsY),
            price_max: binUiPrice(lastState.activeId + best.binsAbove, m.binStep, m.decimalsX, m.decimalsY),
          }
        : null;
      const expectations = best
        ? {
            net_return_per_hour_pct: best.edgePerHourPct, fee_il_ratio: best.feeIlRatio, p_in_range: best.pInRange,
            horizon_minutes: sc.edge.horizon_minutes, e_fee_usd: best.feeUsd, e_il_usd: best.ilUsd, cost_usd: best.costUsd,
          }
        : null;
      out.push({
        pool, ts: t, category: m.category, features: f, norm: n, modules, gate, context: { multiplier: mult, reasons },
        weights, baseScore, finalScore, confidence, regime: e.regime, action, edge: best, edgeCandidates: e.all,
        recommendation, expectations, topReasons: topReasons(f, n, e.regime, gate, mult, reasons),
        risks: this.risks(m, gate, reasons, f, ag?.warnings ?? [], ag?.auditMissing ?? false, t),
      });
    }
    return out;
  }

  /** Blocklist hits of a pool: its risk tokens and their devs (from the Jupiter audit). */
  private blockHits(m: PoolMeta, t: number): BlockHit[] {
    const bl = this.d.blocklist;
    if (!bl) return [];
    const out: BlockHit[] = [];
    for (const tk of this.riskTokens(m)) {
      const h = bl.token(tk, t);
      if (h) out.push(h);
      const dev = this.d.audit?.(tk, t)?.dev;
      const hd = bl.dev(dev, t);
      if (hd) out.push(hd);
    }
    return out;
  }

  private blockedResult(pool: string, category: PoolCategory, t: number, hits: BlockHit[]): ScoreResult {
    const g = auditGate(category, [], hits, t, this.d.config.scoring.safety_gate);
    const gate: GateResult = { passed: false, reasons: g.reasons, missingData: false, filters: g.filters };
    return {
      pool, ts: t, category, features: new Map(), norm: new Map(),
      modules: { edge: null, regime: null, flow: null, attention: null, competition: null, safety: 0 },
      gate, context: { multiplier: 0, reasons: [] }, weights: {}, baseScore: null, finalScore: null, confidence: 0, regime: null,
      action: "LEWATI", edge: null, edgeCandidates: [], recommendation: null, expectations: null,
      topReasons: g.reasons.map((r) => `gate: ${r}`), risks: g.reasons,
    };
  }

  /** Decision log (addendum 3.6): every identified risk, veto or not. */
  private risks(m: PoolMeta, gate: GateResult, ctx: string[], f: RawFeatures, warnings: string[], auditMissing: boolean, t: number): string[] {
    const out = [...gate.reasons, ...ctx, ...warnings];
    if (auditMissing && m.category !== "bluechip") out.push("Jupiter audit unavailable");
    if (val(f, "requires_bin_array_init") === 1) out.push("bin array not initialized near the price (extra rent)");
    const cd = this.d.memory?.cooldown(m.pool, this.riskTokens(m)[0] ?? null, t);
    if (cd) out.push(`pool in cooldown until ${new Date(cd.until).toISOString().slice(11, 16)} UTC (${cd.reason})`);
    return [...new Set(out)];
  }

  private edgeFor(tr: PoolTracker, f: RawFeatures, regime: RegimeLabel | null, t: number): { best: EdgeResult | null; all: EdgeResult[] } {
    const c = this.d.config;
    const sc = c.scoring;
    const last = tr.prices[tr.prices.length - 1];
    const m = tr.metrics;
    const sig = sigma1m(tr, t, sc.window_minutes, sc.features.min_price_minutes);
    if (!sc.modules.edge || !last || !tr.snap || !m?.yUsd || sig === null || f.get("dyn_fee_rate")?.freshness === null) return { best: null, all: [] };
    const W = sc.window_minutes * 60_000;
    const fees = tr.fees.filter((x) => x.ts > t - W && x.ts <= t);
    const ms = fees.reduce((s, x) => s + x.dtMs, 0);
    // fee yield per USD of liquidity per minute: active bin, and the neighbours pooled together
    // (pooling keeps thin bins from producing noisy, huge yields)
    let feeYield: number[] | null = null;
    if (ms >= 10 * 60_000) {
      let fA = 0, dA = 0, fN = 0, dN = 0;
      for (const x of fees) {
        const minutes = x.dtMs / 60_000;
        for (const [o, v] of x.byOffset) if (o === 0) fA += v; else fN += v;
        for (const [o, v] of x.depthByOffset) if (o === 0) dA += v * minutes; else dN += v * minutes;
      }
      const yA = dA > 0 ? fA / dA : 0;
      const yN = dN > 0 ? fN / dN : 0;
      feeYield = [yA, ...Array.from({ length: sc.edge.fee_offsets }, () => yN)];
    } else if (m.fee1h != null && m.tvlUsd) {
      // API fallback: pool-wide yield (under-reports on some pools and ignores concentration)
      const y = m.fee1h / 60 / m.tvlUsd;
      feeYield = [y, ...Array.from({ length: sc.edge.fee_offsets }, () => y)];
    }
    if (feeYield === null) return { best: null, all: [] };
    const choice = sc.regime.strategy_map[regime ?? "sideways"];
    const cands = c.grid.bins_per_side.map((n) => ({ strategy: choice.strategy, sides: choice.sides, binsPerSide: n }));
    const all = estimateEdge(
      {
        binStep: tr.meta.binStep, decimalsX: tr.meta.decimalsX, decimalsY: tr.meta.decimalsY, activeId: last.activeId, priceUi: last.price,
        quoteUsd: m.yUsd, solUsd: this.eco.sol[this.eco.sol.length - 1]?.price ?? 0, priorityMicroLamports: this.eco.priority?.p75 ?? null,
        feeRateTotal: last.feeRate, sigma1m: sig, feeYield,
        seed: hashSeed(sc.edge.seed, tr.meta.pool, t),
      },
      cands,
      c,
    );
    const best = all.reduce<EdgeResult | null>((b, x) => (!b || x.edgePerHourPct > b.edgePerHourPct ? x : b), null);
    return { best, all };
  }
}

function topReasons(f: RawFeatures, n: NormFeatures, regime: RegimeLabel | null, gate: GateResult, mult: number, ctx: string[]): string[] {
  const out: string[] = [];
  if (!gate.passed) out.push(...gate.reasons.map((r) => `gate: ${r}`));
  if (regime) out.push(`regime ${regime}`);
  const ranked = [...n.entries()].filter(([, v]) => v !== null).sort((a, b) => Math.abs((b[1] as number) - 50) - Math.abs((a[1] as number) - 50));
  for (const [k, v] of ranked.slice(0, 3)) {
    const good = (v as number) >= 50;
    out.push(`${k} persentil ${Math.round(v as number)} (${good ? "+" : "-"})`);
  }
  if (mult < 1) out.push(`context x${mult.toFixed(2)}: ${ctx.join(", ")}`);
  void f;
  return out.slice(0, 6);
}

/** Latest token_security row at or before t (look-ahead safe), cached per (token, t). */
export function securityLookup(db: Db, maxAgeMs: number) {
  const cache = new Map<string, SecurityRow | null>();
  return (token: string, t: number): SecurityRow | null => {
    const k = `${token}|${t}`;
    if (cache.has(k)) return cache.get(k)!;
    const r = db.get<SecurityRow>(
      `SELECT token, ts, mint_auth_active, freeze_auth_active, transfer_fee_bps, top10_pct, cluster_pct, dev_rug_count, rugged, rugcheck_score, supply_ui, total_holders
       FROM token_security WHERE token = ? AND ts <= ? AND (error IS NULL OR mint_auth_active IS NOT NULL) ORDER BY ts DESC LIMIT 1`,
      token, t,
    );
    const v = r && t - r.ts <= maxAgeMs ? r : null;
    if (cache.size > 5000) cache.clear();
    cache.set(k, v);
    return v;
  };
}

void SPEC;
