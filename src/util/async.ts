export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      res();
    }, { once: true });
  });

/** Exponential backoff with full jitter. attempt starts at 1. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, rand = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + rand() * (exp / 2));
}

/**
 * Error text for logs. Node's fetch only says "fetch failed"; the network reason (ENOTFOUND = DNS,
 * ECONNRESET, ETIMEDOUT, UND_ERR_CONNECT_TIMEOUT, ...) is in `cause`, so append it.
 */
export function errText(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const msg = err?.message ?? String(e);
  const c = err?.cause;
  const why = c?.code ?? c?.message;
  return why && !msg.includes(why) ? `${msg} (${why})` : msg;
}

export class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  isRetryable?: (e: unknown) => boolean;
  onRetry?: (e: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      last = e;
      const retryable = o.isRetryable ? o.isRetryable(e) : true;
      if (!retryable || attempt === o.maxAttempts || o.signal?.aborted) throw e;
      let delay = backoffDelay(attempt, o.baseDelayMs, o.maxDelayMs);
      if (e instanceof RetryableError && e.retryAfterMs) delay = Math.max(delay, e.retryAfterMs);
      o.onRetry?.(e, attempt, delay);
      await sleep(delay, o.signal);
    }
  }
  throw last;
}

/**
 * Token bucket (rate) + semaphore (concurrency) limiter with adaptive rate: throttle() halves the
 * current rate (down to minRps) when the server answers "too many requests"; without new
 * throttling the rate recovers exponentially (x2 per `recoverMs`) back to maxRps.
 */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private active = 0;
  private waiters: Array<() => void> = [];
  private lastThrottleAt = 0;
  rps: number;

  constructor(
    private readonly maxRps: number,
    private readonly maxConcurrency = Infinity,
    private readonly minRps = Math.min(0.5, maxRps),
    private readonly recoverMs = 10_000,
  ) {
    this.rps = maxRps;
    this.tokens = Math.max(1, maxRps);
  }

  throttle() {
    this.lastThrottleAt = Date.now();
    this.rps = Math.max(this.minRps, this.rps / 2);
    this.tokens = Math.min(this.tokens, 0);
  }

  /** kept for API symmetry; recovery is time based */
  success() {}

  /** true when the server throttled us within the last `withinMs` */
  throttledRecently(withinMs = 15_000): boolean {
    return Date.now() - this.lastThrottleAt < withinMs;
  }

  private refill() {
    const now = Date.now();
    const dt = now - this.last;
    if (this.rps < this.maxRps && now - this.lastThrottleAt > 2_000) {
      this.rps = Math.min(this.maxRps, this.rps * 2 ** (dt / this.recoverMs));
    }
    this.tokens = Math.min(Math.max(1, this.rps), this.tokens + (dt / 1000) * this.rps);
    this.last = now;
  }

  async acquire(): Promise<() => void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1 && this.active < this.maxConcurrency) {
        this.tokens -= 1;
        this.active++;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active--;
          this.waiters.shift()?.();
        };
      }
      const waitMs = this.tokens >= 1 ? 50 : Math.ceil(((1 - this.tokens) / this.rps) * 1000);
      await new Promise<void>((res) => {
        const t = setTimeout(res, waitMs);
        this.waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

let everyErrorHandler: (e: unknown) => void = () => {};
/** Where errors of periodic tasks go (the collection runner sets its logger here). */
export function setEveryErrorHandler(h: (e: unknown) => void) {
  everyErrorHandler = h;
}

/**
 * Run `fn` every `intervalMs` (no overlap) until the signal aborts. First run is immediate. An
 * error in one run is reported and the loop continues (a collector must not die on one failure).
 */
export async function every(intervalMs: number, signal: AbortSignal, fn: () => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    const started = Date.now();
    try {
      await fn();
    } catch (e) {
      everyErrorHandler(e);
    }
    const wait = intervalMs - (Date.now() - started);
    if (wait > 0) await sleep(wait, signal);
  }
}

/** Percentile with linear interpolation; p in [0,100]. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
