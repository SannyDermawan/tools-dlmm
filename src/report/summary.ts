import type { Db } from "../db/index.ts";
import { getSession } from "../db/repo.ts";

export interface SessionSummary {
  session: NonNullable<ReturnType<typeof getSession>>;
  durationMin: number;
  perPool: {
    pool: string;
    name: string;
    chainSnapshots: number;
    apiSnapshots: number;
    binSnapshots: number;
    binRows: number;
    swaps: number;
    firstSwap: number | null;
    lastSwap: number | null;
  }[];
  totals: Record<string, number>;
  gaps: { source: string; pool: string | null; start_at: number; end_at: number | null; cause: string }[];
  rpc: { endpoint: string; method: string; calls: number; errors: number; credits: number }[];
}

export function sessionSummary(db: Db, sessionId: string): SessionSummary {
  const session = getSession(db, sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const end = session.end_at ?? Date.now();
  const pools = db.all<{ pool: string; name: string }>(
    "SELECT sp.pool, p.name FROM session_pools sp JOIN pools p USING(pool) WHERE sp.session_id = ? ORDER BY sp.rank",
    sessionId,
  );
  const count = (sql: string, ...a: (string | number)[]) => (db.get<{ n: number }>(sql, ...a)?.n ?? 0);
  const perPool = pools.map((p) => {
    const sw = db.get<{ n: number; lo: number | null; hi: number | null }>(
      "SELECT COUNT(*) n, MIN(ts) lo, MAX(ts) hi FROM swaps WHERE session_id = ? AND pool = ?", sessionId, p.pool,
    )!;
    return {
      pool: p.pool,
      name: p.name,
      chainSnapshots: count("SELECT COUNT(*) n FROM pool_snapshots WHERE session_id=? AND pool=? AND source='chain'", sessionId, p.pool),
      apiSnapshots: count("SELECT COUNT(*) n FROM pool_snapshots WHERE session_id=? AND pool=? AND source='api'", sessionId, p.pool),
      binSnapshots: count("SELECT COUNT(*) n FROM bin_snapshot_meta WHERE session_id=? AND pool=?", sessionId, p.pool),
      binRows: count("SELECT COALESCE(SUM(stored_count),0) n FROM bin_snapshot_meta WHERE session_id=? AND pool=?", sessionId, p.pool),
      swaps: sw.n,
      firstSwap: sw.lo,
      lastSwap: sw.hi,
    };
  });
  const totals = {
    ohlcv: count("SELECT COUNT(*) n FROM ohlcv WHERE pool IN (SELECT pool FROM session_pools WHERE session_id=?)", sessionId),
    token_security: count("SELECT COUNT(*) n FROM token_security WHERE session_id=?", sessionId),
    token_security_errors: count("SELECT COUNT(*) n FROM token_security WHERE session_id=? AND error IS NOT NULL", sessionId),
    ecosystem: count("SELECT COUNT(*) n FROM ecosystem_metrics WHERE session_id=?", sessionId),
  };
  const gaps = db.all<SessionSummary["gaps"][number]>(
    "SELECT source, pool, start_at, end_at, cause FROM data_gaps WHERE session_id = ? ORDER BY start_at", sessionId,
  );
  const rpc = db.all<SessionSummary["rpc"][number]>(
    "SELECT endpoint, method, SUM(calls) calls, SUM(errors) errors, SUM(credits) credits FROM rpc_usage WHERE session_id=? GROUP BY endpoint, method ORDER BY calls DESC",
    sessionId,
  );
  return { session, durationMin: (end - session.start_at) / 60000, perPool, totals, gaps, rpc };
}

export function printSessionSummary(db: Db, sessionId: string) {
  const s = sessionSummary(db, sessionId);
  const iso = (t: number | null) => (t ? new Date(t).toISOString() : "-");
  console.log(`\nSession ${s.session.session_id}  [${s.session.kind}] ${s.session.status}  label=${s.session.label ?? ""}`);
  console.log(`  config ${s.session.config_version}   ${iso(s.session.start_at)} -> ${iso(s.session.end_at)}  (${s.durationMin.toFixed(1)} min)`);
  console.log("\n  pool                                          name                  chain   api  binsnap  binrows  swaps");
  for (const p of s.perPool) {
    console.log(
      `  ${p.pool.padEnd(45)} ${p.name.slice(0, 20).padEnd(20)} ${String(p.chainSnapshots).padStart(6)} ${String(p.apiSnapshots).padStart(5)} ${String(p.binSnapshots).padStart(8)} ${String(p.binRows).padStart(8)} ${String(p.swaps).padStart(6)}`,
    );
  }
  console.log(`\n  totals: ${JSON.stringify(s.totals)}`);
  const closed = s.gaps.filter((g) => g.end_at);
  const gapMin = closed.reduce((a, g) => a + (g.end_at! - g.start_at), 0) / 60000;
  console.log(`  data gaps: ${s.gaps.length} (${gapMin.toFixed(1)} min total, ${s.gaps.length - closed.length} still open)`);
  for (const g of s.gaps.slice(0, 20)) {
    console.log(`    ${g.source.padEnd(14)} ${(g.pool ?? "-").slice(0, 12).padEnd(12)} ${iso(g.start_at)} -> ${iso(g.end_at)}  ${g.cause}`);
  }
  if (s.gaps.length > 20) console.log(`    ... ${s.gaps.length - 20} more`);
  const calls = s.rpc.reduce((a, r) => a + r.calls, 0);
  const errs = s.rpc.reduce((a, r) => a + r.errors, 0);
  console.log(`  http calls: ${calls} (${errs} errors)`);
  for (const r of s.rpc.slice(0, 10)) console.log(`    ${r.endpoint.padEnd(8)} ${r.method.padEnd(34)} ${String(r.calls).padStart(7)} err=${r.errors}`);
}
