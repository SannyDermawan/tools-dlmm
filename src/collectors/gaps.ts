import type { Db } from "../db/index.ts";
import type { Logger } from "../util/logger.ts";

type Key = string; // `${source}|${pool ?? ""}`

interface Open {
  id: number;
  since: number;
  cause: string;
}

/**
 * Tracks data gaps per (source, pool). A gap opens when a source is explicitly reported down
 * (disconnect, dropped backlog) or when the watchdog sees no success for `staleAfter` seconds,
 * and closes on the next success. Rows go to data_gaps; end_at stays NULL while open.
 */
export class GapTracker {
  private lastOk = new Map<Key, number>();
  private open = new Map<Key, Open>();
  private registered = new Map<Key, { source: string; pool: string | null; startedAt: number }>();
  /** notified when a gap opens (end = null) or a closed gap is recorded */
  listener: ((g: { source: string; pool: string | null; start: number; end: number | null; cause: string }) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly sessionId: string,
    private readonly staleAfterSec: Record<string, number>,
    private readonly log?: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private key(source: string, pool: string | null) {
    return `${source}|${pool ?? ""}`;
  }

  /** Declare that (source, pool) is expected to produce data from now on. */
  register(source: string, pool: string | null = null) {
    const k = this.key(source, pool);
    if (!this.registered.has(k)) this.registered.set(k, { source, pool, startedAt: this.now() });
  }

  unregister(source: string, pool: string | null = null) {
    const k = this.key(source, pool);
    this.close(source, pool);
    this.registered.delete(k);
    this.lastOk.delete(k);
  }

  ok(source: string, pool: string | null = null, ts = this.now()) {
    const k = this.key(source, pool);
    this.lastOk.set(k, ts);
    if (this.open.has(k)) this.close(source, pool, ts);
  }

  /** Explicitly open a gap (idempotent). `since` lets callers backdate the start. */
  down(source: string, pool: string | null, cause: string, since = this.now()) {
    const k = this.key(source, pool);
    if (this.open.has(k)) return;
    const r = this.db.run(
      "INSERT INTO data_gaps (session_id, source, pool, start_at, end_at, cause) VALUES (?,?,?,?,NULL,?)",
      this.sessionId, source, pool, since, cause,
    );
    this.open.set(k, { id: Number(r.lastInsertRowid), since, cause });
    this.log?.warn({ source, pool, cause }, "data gap opened");
    this.listener?.({ source, pool, start: since, end: null, cause });
  }

  /** Record a gap whose start and end are both known (e.g. a backfill that overflowed). */
  record(source: string, pool: string | null, start: number, end: number, cause: string) {
    this.db.run(
      "INSERT INTO data_gaps (session_id, source, pool, start_at, end_at, cause) VALUES (?,?,?,?,?,?)",
      this.sessionId, source, pool, start, end, cause,
    );
    this.log?.warn({ source, pool, cause, start, end }, "data gap recorded");
    this.listener?.({ source, pool, start, end, cause });
  }

  close(source: string, pool: string | null, ts = this.now()) {
    const k = this.key(source, pool);
    const o = this.open.get(k);
    if (!o) return;
    this.db.run("UPDATE data_gaps SET end_at = ? WHERE id = ?", ts, o.id);
    this.open.delete(k);
    this.log?.info({ source, pool, durationS: Math.round((ts - o.since) / 1000) }, "data gap closed");
    // listeners must learn the end too, otherwise they treat the gap as open forever
    this.listener?.({ source, pool, start: o.since, end: ts, cause: o.cause });
  }

  /** Watchdog: open gaps for registered sources that went stale. */
  check(ts = this.now()) {
    for (const [k, r] of this.registered) {
      if (this.open.has(k)) continue;
      const limit = this.staleAfterSec[r.source];
      if (!limit) continue;
      const last = this.lastOk.get(k) ?? r.startedAt;
      if (ts - last > limit * 1000) this.down(r.source, r.pool, `stale>${limit}s`, last);
    }
  }

  openGaps(): { source: string; pool: string | null; since: number; cause: string }[] {
    return [...this.open.entries()].map(([k, o]) => {
      const [source, pool] = k.split("|");
      return { source, pool: pool || null, since: o.since, cause: o.cause };
    });
  }

  isOpen(source: string, pool: string | null = null) {
    return this.open.has(this.key(source, pool));
  }

  /** Close everything at shutdown; the gap ends when collection ends. */
  closeAll(ts = this.now()) {
    for (const k of [...this.open.keys()]) {
      const [source, pool] = k.split("|");
      this.close(source, pool || null, ts);
    }
  }
}
