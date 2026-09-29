import type { Db } from "../db/index.ts";
import type { RpcClient, SignatureInfo } from "../chain/rpc.ts";
import { extractSwaps, type SwapEvent } from "../chain/dlmm.ts";

export interface CensusSwap extends SwapEvent {
  signature: string;
  eventIndex: number;
  ts: number;
}

export interface Census {
  pool: string;
  from: number;
  to: number;
  signaturesScanned: number;
  successfulTxs: number;
  swaps: CensusSwap[];
  truncated: boolean;
}

/**
 * Ground truth for a window: list every signature touching the pool with
 * getSignaturesForAddress, fetch each successful transaction and decode its swaps.
 * Expensive (one getTransaction per transaction) — use on short windows.
 * A stored swap signature just after `to` is used as the paging anchor when available.
 */
export async function chainSwapCensus(db: Db | null, rpc: RpcClient, pool: string, from: number, to: number, maxTx = 5000): Promise<Census> {
  let before: string | undefined = db
    ? db.get<{ signature: string }>("SELECT signature FROM swaps WHERE pool = ? AND ts >= ? ORDER BY ts LIMIT 1", pool, to)?.signature
    : undefined;
  const sigs: SignatureInfo[] = [];
  for (;;) {
    const page = await rpc.getSignaturesForAddress(pool, { before, limit: 1000 });
    if (!page.length) break;
    for (const s of page) {
      const t = (s.blockTime ?? 0) * 1000;
      if (t >= from && t < to) sigs.push(s);
    }
    const oldest = (page[page.length - 1].blockTime ?? 0) * 1000;
    if (oldest < from || page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  const okAll = sigs.filter((s) => !s.err);
  const ok = okAll.slice(0, maxTx);
  const swaps: CensusSwap[] = [];
  await Promise.all(
    ok.map(async (s) => {
      const tx = await rpc.getTransaction(s.signature);
      if (!tx || tx.meta?.err) return;
      const ts = (tx.blockTime ?? s.blockTime ?? 0) * 1000;
      for (const sw of extractSwaps(tx)) if (sw.lbPair === pool) swaps.push({ ...sw, signature: s.signature, ts });
    }),
  );
  return { pool, from, to, signaturesScanned: sigs.length, successfulTxs: ok.length, swaps, truncated: okAll.length > ok.length };
}

export interface SwapAuditResult {
  pool: string;
  from: number;
  to: number;
  signaturesScanned: number;
  successfulTxs: number;
  swapsOnChain: number;
  swapsInDb: number;
  missingInDb: string[]; // "signature:eventIndex"
  extraInDb: string[];
}

/** Completeness audit of the swap stream against the on-chain census. */
export async function auditSwaps(db: Db, rpc: RpcClient, pool: string, from: number, to: number, maxTx = 2000): Promise<SwapAuditResult> {
  const c = await chainSwapCensus(db, rpc, pool, from, to, maxTx);
  const onChain = new Set(c.swaps.map((s) => `${s.signature}:${s.eventIndex}`));
  const rows = db.all<{ k: string }>(
    "SELECT signature || ':' || event_index AS k FROM swaps WHERE pool = ? AND ts >= ? AND ts < ?",
    pool, from, to,
  );
  const inDb = new Set(rows.map((r) => r.k));
  return {
    pool, from, to,
    signaturesScanned: c.signaturesScanned,
    successfulTxs: c.successfulTxs,
    swapsOnChain: onChain.size,
    swapsInDb: inDb.size,
    missingInDb: [...onChain].filter((k) => !inDb.has(k)),
    extraInDb: [...inDb].filter((k) => !onChain.has(k)),
  };
}
