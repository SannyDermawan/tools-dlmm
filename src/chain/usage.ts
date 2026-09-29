import type { Db } from "../db/index.ts";

interface Bucket {
  calls: number;
  errors: number;
  credits: number;
}

/** Per-minute call / error / credit counters, flushed to rpc_usage. */
export class UsageTracker {
  private buckets = new Map<string, Bucket>();
  totalCredits = 0;
  totalCalls = 0;
  totalErrors = 0;

  constructor(
    private readonly methodCredits: Record<string, number> = {},
    private readonly sessionId?: string,
  ) {}

  record(endpoint: string, method: string, ok: boolean, ts = Date.now()) {
    const minute = Math.floor(ts / 60000) * 60000;
    const key = `${minute}|${endpoint}|${method}`;
    const b = this.buckets.get(key) ?? { calls: 0, errors: 0, credits: 0 };
    const credits = endpoint === "rpc" ? (this.methodCredits[method] ?? this.methodCredits.default ?? 1) : 0;
    b.calls++;
    b.credits += credits;
    if (!ok) b.errors++;
    this.buckets.set(key, b);
    this.totalCalls++;
    this.totalCredits += credits;
    if (!ok) this.totalErrors++;
  }

  flush(db: Db) {
    if (!this.sessionId || this.buckets.size === 0) return;
    const rows = [...this.buckets.entries()];
    this.buckets.clear();
    db.tx(() => {
      for (const [key, b] of rows) {
        const [minute, endpoint, method] = key.split("|");
        db.run(
          `INSERT INTO rpc_usage (session_id, minute, endpoint, method, calls, errors, credits) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(session_id, minute, endpoint, method) DO UPDATE SET
             calls = calls + excluded.calls, errors = errors + excluded.errors, credits = credits + excluded.credits`,
          this.sessionId!, Number(minute), endpoint, method, b.calls, b.errors, b.credits,
        );
      }
    });
  }
}
