import type { AppContext } from "../app.ts";
import { loadPoolMeta } from "../collectors/discovery.ts";
import { createSession, finishSession, getSession } from "../db/repo.ts";
import { loadReplay } from "../sim/replay.ts";
import { ScoringRunner, swapPoolsOf } from "./runner.ts";

export interface ScoreReplayResult {
  sessionId: string;
  decisions: number;
  scores: number;
  seconds: number;
}

/** Re-score a stored data session on the fixed decision grid (look-ahead free by construction). */
export function runScoreReplay(app: AppContext, sourceSessionId: string, opts: { pools?: string[]; untilTs?: number; persistSessionId?: string } = {}): ScoreReplayResult {
  const t0 = Date.now();
  const src = getSession(app.db, sourceSessionId);
  if (!src) throw new Error(`session ${sourceSessionId} not found`);
  const pools = opts.pools?.length
    ? opts.pools
    : app.db.all<{ pool: string }>("SELECT pool FROM session_pools WHERE session_id=? ORDER BY rank", src.session_id).map((r) => r.pool);
  const metas = pools.map((p) => loadPoolMeta(app.db, p)!).filter(Boolean);
  const from = src.start_at;
  const to = Math.min(src.end_at ?? Date.now(), opts.untilTs ?? Number.MAX_SAFE_INTEGER);
  const sessionId =
    opts.persistSessionId ??
    createSession(app.db, { kind: "score_replay", configVersion: app.configVersion, label: `score:${src.label ?? ""}`, sourceSessionId: src.session_id });
  const runner = new ScoringRunner(app.db, app.lc.config, app.configVersion, sessionId, metas, from, true, swapPoolsOf(app.db, src.session_id));
  const events = loadReplay(app.db, {
    pools: metas.map((m) => m.pool), from, to,
    binSteps: new Map(metas.map((m) => [m.pool, m.binStep])),
    collectFeeModes: new Map(metas.map((m) => [m.pool, m.collectFeeMode])),
    sessionId: src.session_id,
  });
  let decisions = 0;
  const before = runner.scored;
  runner.onScores = () => decisions++;
  app.db.beginBatch();
  try {
    for (const e of events) {
      if (e.ts > to) continue;
      runner.feed(e);
      app.db.yieldBatch();
    }
    runner.advanceTo(to);
  } finally {
    app.db.endBatch();
  }
  if (!opts.persistSessionId) finishSession(app.db, sessionId, "completed", { poolCount: metas.length });
  return { sessionId, decisions, scores: runner.scored - before, seconds: (Date.now() - t0) / 1000 };
}
