import { PublicKey } from "@solana/web3.js";
import type { Config } from "../config/schema.ts";
import type { Db, Row } from "../db/index.ts";
import type { JsonHttp } from "../api/meteora.ts";
import type { RpcClient } from "../chain/rpc.ts";
import { every } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import type { GapTracker } from "./gaps.ts";
import type { PoolMeta } from "./types.ts";

export const BURN_OWNERS = new Set([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
]);
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1tNmsWvXeGFiEH9Ar";

export interface MintInfo {
  program: string;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: string[];
  transferFeeBps: number | null;
}

export function parseMintInfo(value: any): MintInfo {
  const info = value.data.parsed.info;
  const exts: any[] = info.extensions ?? [];
  const tf = exts.find((e) => e.extension === "transferFeeConfig");
  // The fee that applies now is newerTransferFee once its epoch is reached; take the max (pessimistic).
  const bps = tf
    ? Math.max(Number(tf.state?.newerTransferFee?.transferFeeBasisPoints ?? 0), Number(tf.state?.olderTransferFee?.transferFeeBasisPoints ?? 0))
    : null;
  return {
    program: value.owner,
    decimals: info.decimals,
    supply: BigInt(info.supply),
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    extensions: exts.map((e) => e.extension),
    transferFeeBps: bps,
  };
}

/**
 * Top-10 share of supply, excluding DLMM pool reserves (token account address known) and
 * burn owners. Other AMM vaults are not excluded yet (P1: known-vault list / RugCheck insiders).
 */
export function top10Pct(
  largest: { address: string; amount: string }[],
  owners: Map<string, string | null>,
  supply: bigint,
  excludedAccounts: Set<string>,
): { pct: number | null; excluded: string[] } {
  if (supply === 0n) return { pct: null, excluded: [] };
  const excluded: string[] = [];
  const kept: bigint[] = [];
  for (const a of largest) {
    const owner = owners.get(a.address) ?? null;
    if (excludedAccounts.has(a.address) || (owner && BURN_OWNERS.has(owner))) {
      excluded.push(a.address);
      continue;
    }
    kept.push(BigInt(a.amount));
  }
  const top = kept.slice(0, 10).reduce((s, v) => s + v, 0n);
  return { pct: Number((top * 1_000_000n) / supply) / 10_000, excluded };
}

export interface RugcheckDerived {
  score: number | null;
  risks: unknown[];
  rugged: boolean;
  totalHolders: number | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  transferFeePct: number | null;
  top10Pct: number | null;
  top10Excluded: string[];
  clusterPct: number | null;
  devRugCount: number | null;
  devHistory: { creator: string | null; tokens: number; dead: number } | null;
}

/**
 * Derive security fields from a RugCheck /tokens/{mint}/report response:
 *  - top10: topHolders excluding accounts RugCheck labels AMM / LOCKER, burn owners and our
 *    known pool reserves (pct is % of supply);
 *  - cluster: largest insider network (same funding source) currently held, % of supply;
 *  - dev history (proxy for "tokens that rugged"): other tokens of the creator whose market cap is
 *    below `deadCapUsd` and that are older than 7 days.
 */
export function parseRugcheckReport(r: any, mint: string, reserves: Set<string>, deadCapUsd: number, now = Date.now(), maxClusterAccounts = 1000): RugcheckDerived {
  const known: Record<string, { type?: string }> = r.knownAccounts ?? {};
  const isKnown = (a?: string) => !!a && ["AMM", "LOCKER"].includes(known[a]?.type ?? "");
  const holders: any[] = r.topHolders ?? [];
  const excluded: string[] = [];
  const kept: number[] = [];
  for (const h of holders) {
    if (isKnown(h.owner) || isKnown(h.address) || reserves.has(h.address) || BURN_OWNERS.has(h.owner)) {
      excluded.push(h.address);
      continue;
    }
    kept.push(Number(h.pct ?? 0));
  }
  const supply = Number(r.token?.supply ?? 0);
  // RugCheck sometimes reports the token's whole transfer graph as one "network" (100k+ accounts,
  // holdings above supply): not a same-funder cluster. Ignore huge networks; >100% is invalid.
  const nets: any[] = (r.insiderNetworks ?? []).filter((n: any) => Number(n.size ?? n.activeAccounts ?? 0) <= maxClusterAccounts);
  let cluster: number | null = supply > 0 && nets.length ? (Math.max(...nets.map((n) => Number(n.currentHolding ?? 0))) / supply) * 100 : holders.length ? 0 : null;
  if (cluster !== null && cluster > 100) cluster = null;
  const created: any[] = (r.creatorTokens ?? []).filter((t: any) => t.mint !== mint);
  const dead = created.filter((t) => Number(t.marketCap ?? 0) < deadCapUsd && now - Date.parse(t.createdAt ?? 0) > 7 * 86_400_000).length;
  return {
    score: r.score_normalised ?? r.score ?? null,
    risks: r.risks ?? [],
    rugged: !!r.rugged,
    totalHolders: r.totalHolders ?? null,
    mintAuthority: r.mintAuthority ?? null,
    freezeAuthority: r.freezeAuthority ?? null,
    transferFeePct: r.transferFee?.pct ?? null,
    top10Pct: holders.length ? kept.slice(0, 10).reduce((a, b) => a + b, 0) : null,
    top10Excluded: excluded,
    clusterPct: cluster,
    devRugCount: r.creator ? dead : null,
    devHistory: r.creator ? { creator: r.creator, tokens: created.length, dead } : null,
  };
}

export interface SecurityDeps {
  rpc: RpcClient;
  rugcheck: JsonHttp | null;
  db: Db;
  log: Logger;
  gaps: GapTracker;
  config: Config;
  sessionId: string;
  pools: Map<string, PoolMeta>;
}

export class TokenSecurityCollector {
  static readonly SOURCE = "token_security";
  constructor(private readonly d: SecurityDeps) {}

  private tokens(): string[] {
    const s = new Set<string>();
    for (const p of this.d.pools.values()) {
      s.add(p.tokenX);
      s.add(p.tokenY);
    }
    return [...s];
  }

  async checkToken(mint: string): Promise<Row> {
    const { d } = this;
    const ts = Date.now();
    const bluechip = new Set(d.config.categories.bluechip_tokens);
    const row: Row = { token: mint, ts, session_id: d.sessionId, source: "rpc" };
    const errors: string[] = [];
    try {
      const r = await d.rpc.call<{ value: any }>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: d.rpc.commitment }]);
      if (!r.value) throw new Error("mint account not found");
      const m = parseMintInfo(r.value);
      Object.assign(row, {
        token_program: m.program === TOKEN_2022 ? "token-2022" : "spl-token",
        decimals: m.decimals,
        supply_ui: Number(m.supply) / 10 ** m.decimals,
        mint_auth: m.mintAuthority,
        freeze_auth: m.freezeAuthority,
        mint_auth_active: m.mintAuthority ? 1 : 0,
        freeze_auth_active: m.freezeAuthority ? 1 : 0,
        transfer_fee_bps: m.transferFeeBps,
        extensions: JSON.stringify(m.extensions),
      });
      const skipHolders = d.config.collectors.token_security.skip_bluechip_holders && bluechip.has(mint);
      if (!skipHolders) {
        const lg = await d.rpc.call<{ value: { address: string; amount: string }[] }>("getTokenLargestAccounts", [mint, { commitment: d.rpc.commitment }]);
        const accs = await d.rpc.getMultipleAccounts(lg.value.map((a) => a.address));
        const owners = new Map<string, string | null>();
        lg.value.forEach((a, i) => {
          const data = accs.accounts[i]?.data;
          owners.set(a.address, data && data.length >= 64 ? new PublicKey(data.subarray(32, 64)).toBase58() : null);
        });
        const reserves = new Set(
          d.db.all<{ r: string }>("SELECT reserve_x AS r FROM pools UNION SELECT reserve_y FROM pools").map((x) => x.r),
        );
        const t = top10Pct(lg.value, owners, m.supply, reserves);
        row.top10_pct = t.pct;
        row.top10_excluded = JSON.stringify(t.excluded);
      }
    } catch (e) {
      errors.push(`rpc: ${(e as Error).message}`);
    }
    if (d.rugcheck && d.config.collectors.token_security.use_rugcheck && !bluechip.has(mint)) {
      try {
        const rep = await d.rugcheck.get<any>(`/tokens/${mint}/report`, {}, "/tokens/{mint}/report");
        const reserves = new Set(d.db.all<{ r: string }>("SELECT reserve_x AS r FROM pools UNION SELECT reserve_y FROM pools").map((x) => x.r));
        const rc = parseRugcheckReport(rep, mint, reserves, d.config.scoring.safety_gate.dead_token_market_cap_usd);
        row.rugcheck_score = rc.score;
        row.rugcheck_risks = JSON.stringify(rc.risks);
        row.rugged = rc.rugged ? 1 : 0;
        row.total_holders = rc.totalHolders;
        row.cluster_pct = rc.clusterPct;
        row.dev_rug_count = rc.devRugCount;
        row.dev_history = rc.devHistory ? JSON.stringify(rc.devHistory) : null;
        if (row.top10_pct == null && rc.top10Pct !== null) {
          row.top10_pct = rc.top10Pct;
          row.top10_excluded = JSON.stringify(rc.top10Excluded);
        }
        if (row.mint_auth_active == null) {
          row.mint_auth = rc.mintAuthority;
          row.freeze_auth = rc.freezeAuthority;
          row.mint_auth_active = rc.mintAuthority ? 1 : 0;
          row.freeze_auth_active = rc.freezeAuthority ? 1 : 0;
        }
        if (row.transfer_fee_bps == null && rc.transferFeePct) row.transfer_fee_bps = Math.round(rc.transferFeePct * 100);
        row.source = "rpc+rugcheck";
      } catch (e) {
        errors.push(`rugcheck: ${(e as Error).message}`);
      }
    }
    if (errors.length) row.error = errors.join("; ");
    return row;
  }

  async tick() {
    const { d } = this;
    for (const mint of this.tokens()) {
      const row = await this.checkToken(mint);
      d.db.insert("token_security", row, "OR REPLACE");
      if (row.mint_auth_active != null && (row.top10_pct != null || new Set(d.config.categories.bluechip_tokens).has(mint))) d.gaps.ok(TokenSecurityCollector.SOURCE, mint);
      else d.log.warn({ mint, err: row.error }, "token security check failed");
    }
  }

  run(signal: AbortSignal) {
    return every(this.d.config.collectors.token_security.interval_minutes * 60_000, signal, () => this.tick());
  }
}
