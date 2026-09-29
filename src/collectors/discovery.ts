import type { Config, PoolCategory } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import type { MeteoraApi, ApiPool } from "../api/meteora.ts";
import type { RpcClient } from "../chain/rpc.ts";
import { decodeLbPair, type LbPairState } from "../chain/dlmm.ts";
import type { Logger } from "../util/logger.ts";
import type { PoolMeta } from "./types.ts";

export function categorize(tokenX: string, tokenY: string, bluechip: string[]): PoolCategory {
  const set = new Set(bluechip);
  return set.has(tokenX) && set.has(tokenY) ? "bluechip" : "memecoin";
}

export interface DiscoveryCandidate {
  api: ApiPool;
  category: PoolCategory;
  rank: number;
  reason: string;
}

/** Pure filter step (unit-tested): apply age / category / deny rules and cap the list. */
export function selectCandidates(pools: ApiPool[], c: Config, now = Date.now()): DiscoveryCandidate[] {
  const d = c.discovery;
  const deny = new Set(d.pool_denylist);
  const allow = new Set(d.pool_allowlist);
  const out: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  for (const p of pools) {
    if (seen.has(p.address) || deny.has(p.address)) continue;
    seen.add(p.address);
    const category = categorize(p.token_x.address, p.token_y.address, c.categories.bluechip_tokens);
    if (allow.has(p.address)) {
      out.push({ api: p, category, rank: 0, reason: "allowlist" });
      continue;
    }
    if (d.exclude_blacklisted && p.is_blacklisted) continue;
    if (!d.include_categories.includes(category)) continue;
    if ((p.tvl ?? 0) < d.min_tvl_usd) continue;
    if ((p.volume?.["1h"] ?? 0) < d.min_volume_1h_usd) continue;
    if (p.created_at && now - p.created_at < d.min_pool_age_minutes * 60_000) continue;
    out.push({ api: p, category, rank: 0, reason: "filter" });
  }
  const allowed = out.filter((x) => x.reason === "allowlist");
  const rest = out.filter((x) => x.reason !== "allowlist").slice(0, Math.max(0, d.max_pools - allowed.length));
  return [...allowed, ...rest].map((x, i) => ({ ...x, rank: i + 1 }));
}

export function toPoolMeta(api: ApiPool, lb: LbPairState, category: PoolCategory): PoolMeta {
  return {
    pool: api.address,
    name: api.name,
    tokenX: lb.tokenXMint,
    tokenY: lb.tokenYMint,
    symbolX: api.token_x.symbol,
    symbolY: api.token_y.symbol,
    decimalsX: api.token_x.decimals,
    decimalsY: api.token_y.decimals,
    binStep: lb.binStep,
    category,
    reserveX: lb.reserveX,
    reserveY: lb.reserveY,
    collectFeeMode: lb.s.collectFeeMode,
    fee: {
      binStep: lb.binStep,
      baseFactor: lb.s.baseFactor,
      baseFeePowerFactor: lb.s.baseFeePowerFactor,
      variableFeeControl: lb.s.variableFeeControl,
      protocolShare: lb.s.protocolShare,
    },
    s: lb.s,
    createdAt: api.created_at ?? null,
  };
}

export function upsertPool(db: Db, m: PoolMeta, lb: LbPairState, now = Date.now()) {
  db.run(
    `INSERT INTO pools (pool, name, token_x, token_y, symbol_x, symbol_y, decimals_x, decimals_y, bin_step,
       base_factor, base_fee_power_factor, filter_period, decay_period, reduction_factor, variable_fee_control,
       max_volatility_accumulator, protocol_share, collect_fee_mode, function_type, token_x_program, token_y_program,
       reserve_x, reserve_y, category, pool_created_at, first_seen_at, last_checked_at, params_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(pool) DO UPDATE SET
       name=excluded.name, base_factor=excluded.base_factor, base_fee_power_factor=excluded.base_fee_power_factor,
       filter_period=excluded.filter_period, decay_period=excluded.decay_period, reduction_factor=excluded.reduction_factor,
       variable_fee_control=excluded.variable_fee_control, max_volatility_accumulator=excluded.max_volatility_accumulator,
       protocol_share=excluded.protocol_share, collect_fee_mode=excluded.collect_fee_mode, function_type=excluded.function_type,
       category=excluded.category, last_checked_at=excluded.last_checked_at, params_json=excluded.params_json`,
    m.pool, m.name, m.tokenX, m.tokenY, m.symbolX, m.symbolY, m.decimalsX, m.decimalsY, m.binStep,
    m.s.baseFactor, m.s.baseFeePowerFactor, m.s.filterPeriod, m.s.decayPeriod, m.s.reductionFactor, m.s.variableFeeControl,
    m.s.maxVolatilityAccumulator, m.s.protocolShare, m.s.collectFeeMode, m.s.functionType,
    lb.tokenXProgramFlag === 0 ? "spl-token" : "token-2022", lb.tokenYProgramFlag === 0 ? "spl-token" : "token-2022",
    m.reserveX, m.reserveY, m.category, m.createdAt, now, now, JSON.stringify({ s: lb.s, status: lb.status }),
  );
}

export async function fetchAllowlisted(api: MeteoraApi, addrs: string[]): Promise<ApiPool[]> {
  const out: ApiPool[] = [];
  for (const a of addrs) out.push(await api.getPool(a));
  return out;
}

/**
 * Pool discovery: API candidates -> filters -> on-chain verification of params (lb_pair account).
 * Writes pools + session_pools.
 */
export async function discoverPools(
  deps: { api: MeteoraApi; rpc: RpcClient; db: Db; log: Logger; config: Config },
  sessionId: string | null,
): Promise<PoolMeta[]> {
  const { api, rpc, db, log, config: c } = deps;
  const d = c.discovery;
  const filters = [`tvl>=${d.min_tvl_usd}`, `volume_1h>=${d.min_volume_1h_usd}`];
  if (d.exclude_blacklisted) filters.push("is_blacklisted=false");
  const page = await api.listPools({ pageSize: d.candidate_page_size, sortBy: d.sort_by, filterBy: filters.join(" && ") });
  const allow = d.pool_allowlist.length ? await fetchAllowlisted(api, d.pool_allowlist) : [];
  const candidates = selectCandidates([...allow, ...page.data], c);
  log.info({ apiCandidates: page.data.length, apiTotal: page.total, selected: candidates.length }, "discovery candidates");

  const { accounts } = await rpc.getMultipleAccounts(candidates.map((x) => x.api.address));
  const metas: PoolMeta[] = [];
  const now = Date.now();
  candidates.forEach((cand, i) => {
    const acc = accounts[i];
    if (!acc) {
      log.warn({ pool: cand.api.address }, "pool account not found on chain; skipped");
      return;
    }
    let lb: LbPairState;
    try {
      lb = decodeLbPair(acc.data);
    } catch (e) {
      log.warn({ pool: cand.api.address, err: (e as Error).message }, "cannot decode lb_pair; skipped");
      return;
    }
    if (lb.tokenXMint !== cand.api.token_x.address || lb.tokenYMint !== cand.api.token_y.address) {
      log.warn({ pool: cand.api.address }, "API token mints differ from chain; skipped");
      return;
    }
    if (lb.binStep !== cand.api.pool_config.bin_step) log.warn({ pool: cand.api.address }, "API bin_step differs from chain; chain wins");
    const meta = toPoolMeta(cand.api, lb, cand.category);
    upsertPool(db, meta, lb, now);
    if (sessionId) {
      db.insert(
        "session_pools",
        {
          session_id: sessionId,
          pool: meta.pool,
          added_at: now,
          rank: cand.rank,
          discovery_json: JSON.stringify({
            reason: cand.reason,
            tvl: cand.api.tvl,
            volume_1h: cand.api.volume?.["1h"],
            fee_tvl_1h: cand.api.fee_tvl_ratio?.["1h"],
            api_protocol_fee_pct: cand.api.pool_config.protocol_fee_pct,
          }),
        },
        "OR IGNORE",
      );
    }
    metas.push(meta);
  });
  return metas;
}

/** Load pool metadata from the DB (used by replay). */
export function loadPoolMeta(db: Db, pool: string): PoolMeta | undefined {
  const r = db.get<Record<string, any>>("SELECT * FROM pools WHERE pool = ?", pool);
  if (!r) return undefined;
  const s = JSON.parse(r.params_json).s;
  return {
    pool: r.pool,
    name: r.name,
    tokenX: r.token_x,
    tokenY: r.token_y,
    symbolX: r.symbol_x,
    symbolY: r.symbol_y,
    decimalsX: r.decimals_x,
    decimalsY: r.decimals_y,
    binStep: r.bin_step,
    category: r.category,
    reserveX: r.reserve_x,
    reserveY: r.reserve_y,
    collectFeeMode: r.collect_fee_mode,
    fee: {
      binStep: r.bin_step,
      baseFactor: r.base_factor,
      baseFeePowerFactor: r.base_fee_power_factor,
      variableFeeControl: r.variable_fee_control,
      protocolShare: r.protocol_share,
    },
    s,
    createdAt: r.pool_created_at,
  };
}
