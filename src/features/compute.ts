import type { Config, ModuleName } from "../config/schema.ts";
import type { AuditRow } from "./safetyData.ts";
import type { EcoTracker, PoolTracker } from "./tracker.ts";
import type { ExtraLookup } from "./extraLookup.ts";

export interface SecurityRow {
  token: string;
  ts: number;
  mint_auth_active: number | null;
  freeze_auth_active: number | null;
  transfer_fee_bps: number | null;
  top10_pct: number | null;
  cluster_pct: number | null;
  dev_rug_count: number | null;
  rugged: number | null;
  rugcheck_score: number | null;
  supply_ui?: number | null;
  total_holders?: number | null;
}

export interface FeatureSpec {
  name: string;
  module: ModuleName | "context";
  /** +1: higher is better, -1: higher is worse (inverted), 0: not normalized (used raw) */
  direction: 1 | -1 | 0;
  description: string;
}

/** Blueprint 8.2 — the core feature set (P0/P1 features without a data source are null). */
export const FEATURE_SPECS: FeatureSpec[] = [
  { name: "vol_trend_1h", module: "edge", direction: 1, description: "volume 1h / mean hourly volume 24h" },
  { name: "fee_tvl_1h", module: "edge", direction: 1, description: "LP fee per hour / TVL (%), from bin fee accumulators (API fallback)" },
  { name: "active_liq_depth", module: "edge", direction: 0, description: "USD liquidity in active bin +- k" },
  { name: "est_share", module: "edge", direction: 1, description: "reference capital / (existing + capital) in active +- k" },
  { name: "dyn_fee_rate", module: "edge", direction: 1, description: "current total fee rate (base + variable)" },
  { name: "realized_vol", module: "regime", direction: 0, description: "stdev of 1m log returns, per sqrt hour" },
  { name: "efficiency_ratio", module: "regime", direction: 0, description: "|net change| / sum |changes| over N minutes" },
  { name: "trend_z", module: "regime", direction: 0, description: "ln return N / (sigma_1m * sqrt N)" },
  { name: "sol_trend_er", module: "regime", direction: 0, description: "efficiency ratio of SOL/USD" },
  { name: "sol_return_1h", module: "regime", direction: 0, description: "SOL/USD log return over the window" },
  { name: "btc_trend_er", module: "regime", direction: 0, description: "efficiency ratio of BTC/USD over the window (P1)" },
  { name: "btc_return_1h", module: "regime", direction: 0, description: "BTC/USD log return over the window (P1)" },
  { name: "trader_diversity", module: "flow", direction: 1, description: "distinct wallets / sampled swaps in the window (organic flow)" },
  { name: "swap_tx_rate_1h", module: "flow", direction: 0, description: "swap-like transactions per hour seen by the socket (complete count)" },
  { name: "top5_wallet_share", module: "flow", direction: -1, description: "volume share of the 5 largest wallets (wash indication)" },
  { name: "markout_60s", module: "flow", direction: -1, description: "mean price move 60 s after swaps in swap direction (bps; toxic flow)" },
  { name: "buy_sell_balance", module: "flow", direction: 1, description: "1 - |buy - sell| / (buy + sell)" },
  { name: "markout_30s", module: "flow", direction: -1, description: "markout 30 s after swaps (bps; toxic flow, P1)" },
  { name: "markout_300s", module: "flow", direction: -1, description: "markout 5 min after swaps (bps; toxic flow, P1)" },
  { name: "wash_share", module: "flow", direction: -1, description: "volume share of wallets that both bought and sold in the window (wash indication, P1)" },
  { name: "whale_share", module: "flow", direction: -1, description: "volume share of swaps >= whale_swap_usd (P1)" },
  { name: "lp_net_flow_1h", module: "flow", direction: 0, description: "change of liquidity within active +- k over the window (LP adds/removes, P1)" },
  { name: "lp_crowding", module: "competition", direction: -1, description: "share of observed liquidity within active +- k" },
  { name: "bot_rebalance_freq", module: "competition", direction: -1, description: "LP add/remove events near the active bin per hour" },
  { name: "pool_volume_share", module: "competition", direction: 1, description: "share of this pool in the token's 1h volume across all DEX pairs (DexScreener)" },
  { name: "venue_count", module: "competition", direction: 0, description: "number of pairs of the token across DEXes" },
  { name: "trending_score", module: "attention", direction: 1, description: "CoinGecko trending: 16 - rank when trending, else 0 (symbol match, proxy)" },
  { name: "boosts_active", module: "attention", direction: 1, description: "DexScreener paid boosts on the token (attention, can be promotion)" },
  { name: "social_presence", module: "attention", direction: 1, description: "social links + websites in the token profile" },
  { name: "launchpad_heat", module: "attention", direction: 1, description: "new launchpad DLMM pools in the last hour (market-wide)" },
  { name: "holder_top10", module: "safety", direction: -1, description: "top-10 holder % of supply excl. pools/burn/lockers" },
  { name: "cluster_share", module: "safety", direction: -1, description: "largest same-funder cluster % of supply" },
  { name: "dev_rug_history", module: "safety", direction: -1, description: "creator tokens now worthless (proxy for rugs)" },
  // ---- phase 10 (addendum v1.1): Jupiter audit, PVP, pool memory, bin arrays
  { name: "organic_score", module: "safety", direction: 1, description: "Jupiter organic score (lowest risk token)" },
  { name: "bot_holders_pct", module: "safety", direction: -1, description: "Jupiter bot holders % (datapi; highest risk token)" },
  { name: "pvp_rival_count", module: "safety", direction: -1, description: "other mints with the same symbol / name traded in the last 24 h" },
  { name: "token_age_hours", module: "context", direction: 0, description: "hours since the token's first pool (Jupiter)" },
  { name: "pool_hist_net_pct", module: "edge", direction: 0, description: "pool memory: mean net PnL % of past baseline positions" },
  { name: "pool_hist_win_rate", module: "edge", direction: 0, description: "pool memory: win rate of past baseline positions" },
  { name: "requires_bin_array_init", module: "context", direction: 0, description: "1 when a bin array near the price is not initialized (opening costs rent)" },
  { name: "priority_fee_p75", module: "context", direction: 0, description: "priority fee p75 (micro-lamports/CU)" },
  { name: "macro_event_window", module: "context", direction: 0, description: "1 inside +-X min of a scheduled macro event" },
  { name: "hour_of_week", module: "context", direction: 0, description: "hour of week (UTC)" },
  { name: "fear_greed", module: "context", direction: 0, description: "Crypto Fear & Greed index (P2)" },
  { name: "sol_dex_change_1d", module: "context", direction: 0, description: "Solana DEX volume change 1d, % (DefiLlama, P1)" },
  { name: "network_tps", module: "context", direction: 0, description: "Solana transactions per second (P1)" },
];

export interface FeatureValue {
  raw: number | null;
  /** age (s) of the newest input at decision time; null when unavailable */
  freshness: number | null;
}

export type RawFeatures = Map<string, FeatureValue>;

const std = (a: number[]) => {
  if (a.length < 2) return null;
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

export function efficiencyRatio(prices: number[]): number | null {
  if (prices.length < 3) return null;
  let path = 0;
  for (let i = 1; i < prices.length; i++) path += Math.abs(prices[i] - prices[i - 1]);
  if (path === 0) return 0;
  return Math.abs(prices[prices.length - 1] - prices[0]) / path;
}

export function logReturns(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) if (prices[i] > 0 && prices[i - 1] > 0) r.push(Math.log(prices[i] / prices[i - 1]));
  return r;
}

/** sigma of 1-minute log returns (null if too few minutes). */
export function sigma1m(tr: PoolTracker, t: number, windowMin: number, minMinutes: number): number | null {
  const closes = tr.minuteCloses(t).filter((c) => c.ts > t - windowMin * 60_000);
  if (closes.length < minMinutes) return null;
  return std(logReturns(closes.map((c) => c.price)));
}

export interface ComputeContext {
  config: Config;
  t: number;
  eco: EcoTracker;
  security: (token: string, t: number) => SecurityRow | null;
  macroEvents: { ts: number; name: string }[];
  /** tokens whose security matters for this pool (non-bluechip ones) */
  riskTokens: string[];
  /** phase 7 sources (venues, attention, macro); optional */
  extra?: ExtraLookup;
  /** phase 10: Jupiter audit and pool memory; optional */
  audit?: (token: string, t: number) => AuditRow | null;
  memory?: MemoryView;
}

/** Look-ahead-safe view of the pool memory (phase 10). */
export interface MemoryView {
  poolStats(pool: string, t: number): { positions: number; avgNetPct: number | null; winRate: number | null } | null;
  cooldown(pool: string, token: string | null, t: number): { until: number; reason: string } | null;
}

/** Raw features of one pool at decision time t (inputs with ts <= t only). */
export function computeFeatures(tr: PoolTracker, cx: ComputeContext): RawFeatures {
  const { config: c, t } = cx;
  const sc = c.scoring;
  const f: RawFeatures = new Map();
  const W = sc.window_minutes * 60_000;
  const age = (ts: number | null | undefined, src: string) => {
    if (ts == null) return null;
    const a = (t - ts) / 1000;
    return a <= (sc.max_age_seconds[src] ?? Infinity) ? a : null; // stale -> missing
  };
  const set = (name: string, raw: number | null | undefined, freshness: number | null) =>
    f.set(name, { raw: raw === undefined || raw === null || !Number.isFinite(raw) || freshness === null ? null : raw, freshness });

  const m = tr.metrics;
  const mAge = age(m?.ts, "pool_metrics");
  const lastPrice = tr.prices[tr.prices.length - 1];
  const sAge = age(lastPrice?.ts, "pool_state");
  const snap = tr.snap;
  const bAge = age(snap?.ts, "bin_snapshot");

  // ---- edge
  set("vol_trend_1h", m?.volume1h != null && m.volume24h ? m.volume1h / (m.volume24h / 24) : null, mAge);
  const feeWin = tr.fees.filter((x) => x.ts > t - W && x.ts <= t);
  const feeMs = feeWin.reduce((s, x) => s + x.dtMs, 0);
  const tvl = m?.tvlUsd ?? null;
  let feeTvl: number | null = null;
  if (feeMs >= 10 * 60_000 && tvl) feeTvl = ((feeWin.reduce((s, x) => s + x.usd, 0) * (3_600_000 / feeMs)) / tvl) * 100;
  else if (m?.feeTvl1h != null) feeTvl = m.feeTvl1h; // API value is already in %
  set("fee_tvl_1h", feeTvl, feeMs >= 10 * 60_000 ? bAge : mAge);
  const depth = tr.depthUsd();
  let depthK = 0;
  let depthAll = 0;
  if (snap) {
    for (const [id, v] of depth) {
      depthAll += v;
      if (Math.abs(id - snap.activeId) <= sc.depth_bins) depthK += v;
    }
  }
  set("active_liq_depth", snap ? depthK : null, bAge);
  set("est_share", snap ? sc.edge.capital_usd / (depthK + sc.edge.capital_usd) : null, bAge);
  set("dyn_fee_rate", lastPrice?.feeRate ?? null, sAge);

  // ---- regime
  const sig = sigma1m(tr, t, sc.window_minutes, sc.features.min_price_minutes);
  set("realized_vol", sig !== null ? sig * Math.sqrt(60) : null, sAge);
  const erCloses = tr.minuteCloses(t).filter((x) => x.ts > t - sc.features.er_minutes * 60_000).map((x) => x.price);
  const enough = erCloses.length >= Math.min(sc.features.min_price_minutes, sc.features.er_minutes);
  set("efficiency_ratio", enough ? efficiencyRatio(erCloses) : null, sAge);
  const n = erCloses.length - 1;
  set("trend_z", enough && sig && sig > 0 && n > 0 ? Math.log(erCloses[n] / erCloses[0]) / (sig * Math.sqrt(n)) : sig === 0 ? 0 : null, sAge);
  const sol = cx.eco.sol.filter((x) => x.ts > t - W && x.ts <= t).map((x) => x.price);
  const solAge = age(cx.eco.sol[cx.eco.sol.length - 1]?.ts, "ecosystem");
  set("sol_trend_er", sol.length >= 10 ? efficiencyRatio(sol) : null, solAge);
  set("sol_return_1h", sol.length >= 10 ? Math.log(sol[sol.length - 1] / sol[0]) : null, solAge);

  // ---- flow (needs a mostly gap-free swap stream in the window)
  const cov = tr.coverage("swap_stream", Math.max(t - W, tr.firstEventTs || t - W), t);
  const sw = tr.swaps.filter((x) => x.ts > t - W && x.ts <= t);
  const act = tr.activity.filter((x) => x.ts > t - W && x.ts <= t);
  set("swap_tx_rate_1h", tr.swapsCollected && act.length >= 10 ? (act.reduce((s2, x) => s2 + x.candidates, 0) * 60) / act.length : null, act.length ? age(act[act.length - 1].ts, "swaps") : null);
  // Flow statistics are ratios, so a uniform sample of swaps is enough (swap stream: mode sample).
  const flowOk =
    tr.swapsCollected && cov >= sc.features.min_swap_coverage && sw.length >= sc.features.min_flow_samples &&
    t - (tr.firstEventTs || t) >= 10 * 60_000;
  const swAge = flowOk ? age(sw[sw.length - 1]?.ts ?? t, "swaps") : null;
  if (flowOk) {
    const byWallet = new Map<string, number>();
    let buy = 0;
    let sell = 0;
    for (const s of sw) {
      byWallet.set(s.wallet, (byWallet.get(s.wallet) ?? 0) + s.usd);
      if (s.buy) buy += s.usd;
      else sell += s.usd;
    }
    const vols = [...byWallet.values()].sort((a, b) => b - a);
    const total = vols.reduce((s, v) => s + v, 0);
    set("trader_diversity", byWallet.size / sw.length, swAge);
    set("top5_wallet_share", total > 0 ? vols.slice(0, 5).reduce((s, v) => s + v, 0) / total : null, swAge);
    set("buy_sell_balance", buy + sell > 0 ? 1 - Math.abs(buy - sell) / (buy + sell) : null, swAge);
    const horizon = sc.features.markout_seconds * 1000;
    const marks: number[] = [];
    for (const s of sw) {
      if (s.ts + horizon > t) continue; // the future price must be known at t (no look-ahead)
      const p0 = tr.priceAt(s.ts);
      const p1 = tr.priceAt(s.ts + horizon);
      if (p0 && p1) marks.push((s.buy ? 1 : -1) * ((p1 - p0) / p0) * 10_000);
    }
    set("markout_60s", marks.length >= 5 ? marks.reduce((a, b) => a + b, 0) / marks.length : null, swAge);
    set("markout_30s", markout(tr, sw, t, 30_000), swAge);
    set("markout_300s", markout(tr, sw, t, 300_000), swAge);
    const buyers = new Set(sw.filter((x) => x.buy).map((x) => x.wallet));
    const sellers = new Set(sw.filter((x) => !x.buy).map((x) => x.wallet));
    const washVol = sw.filter((x) => buyers.has(x.wallet) && sellers.has(x.wallet)).reduce((a, x) => a + x.usd, 0);
    set("wash_share", total > 0 ? washVol / total : null, swAge);
    const whaleVol = sw.filter((x) => x.usd >= sc.features.whale_swap_usd).reduce((a, x) => a + x.usd, 0);
    set("whale_share", total > 0 ? whaleVol / total : null, swAge);
  } else {
    for (const k of ["trader_diversity", "top5_wallet_share", "buy_sell_balance", "markout_60s", "markout_30s", "markout_300s", "wash_share", "whale_share"]) set(k, null, null);
  }
  // LP adds / removes near the active bin: depth now vs the start of the window
  const firstFee = feeWin[0];
  let depthThen = 0;
  if (firstFee) for (const [off, usd] of firstFee.depthByOffset) if (Math.abs(off) <= sc.depth_bins) depthThen += usd;
  set("lp_net_flow_1h", snap && firstFee && depthThen > 0 && feeMs >= 10 * 60_000 ? (depthK - depthThen) / depthThen : null, bAge);

  // ---- competition
  set("lp_crowding", snap && depthAll > 0 ? depthK / depthAll : null, bAge);
  set("bot_rebalance_freq", feeMs >= 10 * 60_000 ? feeWin.reduce((s, x) => s + x.supplyChanges, 0) * (3_600_000 / feeMs) : null, bAge);
  // other venues of the risk token (DexScreener)
  const risk = cx.riskTokens[0];
  const ven = risk && cx.extra ? cx.extra.venues(risk, t) : null;
  if (ven) {
    const pairs = JSON.parse(ven.pairs_json) as { pair: string; volume_h1: number }[];
    const own = pairs.find((p) => p.pair === tr.meta.pool)?.volume_h1 ?? null;
    const vAge = age(ven.ts, "venues");
    set("pool_volume_share", own !== null && ven.volume_h1_usd > 0 ? own / ven.volume_h1_usd : null, vAge);
    set("venue_count", ven.pairs, vAge);
  } else {
    set("pool_volume_share", null, null);
    set("venue_count", null, null);
  }
  const att = risk && cx.extra ? cx.extra.attention(risk, t) : null;
  const aAge = att ? age(att.ts, "attention") : null;
  set("trending_score", att ? (att.trending_rank ? Math.max(0, 16 - att.trending_rank) : 0) : null, aAge);
  set("boosts_active", att?.boosts_active ?? null, aAge);
  set("social_presence", att && att.socials !== null ? att.socials + (att.websites ?? 0) : null, aAge);

  // ---- safety (worst of the pool's risk tokens)
  const rows = cx.riskTokens.map((tk) => cx.security(tk, t)).filter((r): r is SecurityRow => !!r);
  const secAge = rows.length ? age(Math.min(...rows.map((r) => r.ts)), "security") : null;
  const worst = (k: keyof SecurityRow) => {
    const v = rows.map((r) => r[k] as number | null).filter((x): x is number => x !== null && x !== undefined);
    return v.length ? Math.max(...v) : null;
  };
  // pools made only of bluechip tokens have no risk token: not applicable (kept out of rankings)
  set("holder_top10", cx.riskTokens.length ? worst("top10_pct") : null, cx.riskTokens.length ? secAge : null);
  set("cluster_share", cx.riskTokens.length ? worst("cluster_pct") : null, cx.riskTokens.length ? secAge : null);
  set("dev_rug_history", cx.riskTokens.length ? worst("dev_rug_count") : null, cx.riskTokens.length ? secAge : null);

  // ---- phase 10: Jupiter audit (worst risk token), pool memory, bin arrays
  const audits = cx.audit ? cx.riskTokens.map((tk) => cx.audit!(tk, t)).filter((r): r is AuditRow => !!r) : [];
  const auAge = audits.length ? age(Math.min(...audits.map((r) => r.ts)), "audit") : null;
  const pick = (k: keyof AuditRow, agg: (v: number[]) => number) => {
    const v = audits.map((r) => r[k] as number | null).filter((x): x is number => x !== null && x !== undefined);
    return v.length ? agg(v) : null;
  };
  set("organic_score", pick("organic_score", (v) => Math.min(...v)), auAge);
  set("bot_holders_pct", pick("bot_holders_pct", (v) => Math.max(...v)), auAge);
  set("pvp_rival_count", pick("pvp_rival_count", (v) => Math.max(...v)), auAge);
  const born = audits.map((r) => r.first_pool_at ?? r.token_created_at).filter((x): x is number => x !== null);
  set("token_age_hours", born.length ? (t - Math.max(...born)) / 3_600_000 : null, auAge);
  const mem = cx.memory?.poolStats(tr.meta.pool, t) ?? null;
  const memOk = mem && mem.positions >= c.memory.min_positions_for_features;
  set("pool_hist_net_pct", memOk ? mem!.avgNetPct : null, 0);
  set("pool_hist_win_rate", memOk ? mem!.winRate : null, 0);
  set("requires_bin_array_init", tr.snap ? (tr.snap.missingBinArrays.length ? 1 : 0) : null, age(tr.snap?.ts, "bin_snapshot"));

  // ---- context
  const pr = cx.eco.priority;
  set("priority_fee_p75", pr?.p75 ?? null, age(pr?.ts, "ecosystem"));
  const win = sc.context.macro_window_minutes * 60_000;
  set("macro_event_window", cx.macroEvents.some((e) => Math.abs(e.ts - t) <= win) ? 1 : 0, 0);
  const d = new Date(t);
  set("hour_of_week", d.getUTCDay() * 24 + d.getUTCHours(), 0);
  // macro / ecosystem context (phase 7)
  const macro = cx.extra ? cx.extra.macro(t, W) : [];
  const last = macro[macro.length - 1];
  const mAge2 = last ? age(last.ts, "macro") : null;
  const btc = macro.map((x) => x.btc_usd).filter((x): x is number => x !== null);
  set("btc_trend_er", btc.length >= 4 ? efficiencyRatio(btc) : null, mAge2);
  set("btc_return_1h", btc.length >= 2 ? Math.log(btc[btc.length - 1] / btc[0]) : null, mAge2);
  set("fear_greed", last?.fear_greed ?? null, mAge2);
  set("sol_dex_change_1d", last?.sol_dex_change_1d ?? null, mAge2);
  set("network_tps", last?.tps ?? null, mAge2);
  set("launchpad_heat", last?.launchpad_pools_1h ?? null, mAge2);
  return f;
}

/** Mean price move `horizonMs` after sampled swaps, in the swap direction (bps); only swaps whose
 * horizon has fully elapsed by t are used (no look-ahead). */
export function markout(tr: PoolTracker, swaps: { ts: number; buy: boolean }[], t: number, horizonMs: number): number | null {
  const marks: number[] = [];
  for (const s of swaps) {
    if (s.ts + horizonMs > t) continue;
    const p0 = tr.priceAt(s.ts);
    const p1 = tr.priceAt(s.ts + horizonMs);
    if (p0 && p1) marks.push((s.buy ? 1 : -1) * ((p1 - p0) / p0) * 10_000);
  }
  return marks.length >= 5 ? marks.reduce((a, b) => a + b, 0) / marks.length : null;
}
