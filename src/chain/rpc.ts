import { RateLimiter, RetryableError, withRetry } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import { redactUrl } from "../util/redact.ts";
import type { UsageTracker } from "./usage.ts";

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
  }
}

export interface RpcClientOptions {
  url: string;
  maxRps: number;
  maxConcurrency: number;
  timeoutMs: number;
  retry: { max_attempts: number; base_delay_ms: number; max_delay_ms: number };
  commitment: "processed" | "confirmed" | "finalized";
  usage?: UsageTracker;
  log?: Logger;
  signal?: AbortSignal;
  /** endpoint label for usage accounting */
  endpoint?: string;
  /** credits charged per call of a method (default 1) */
  creditOf?: (method: string) => number;
}

export interface AccountInfoRaw {
  data: Buffer;
  owner: string;
  lamports: number;
  executable: boolean;
}

/** JSON-RPC codes that indicate a transient server-side condition. */
const RETRYABLE_RPC_CODES = new Set([-32005, -32004, -32007, -32014, -32016, -32603, 429]);

/**
 * Minimal Solana JSON-RPC client over fetch: rate-limited, retried with backoff, accounted.
 * Read-only by construction: there is no method for sending transactions.
 */
export class RpcClient {
  private readonly limiter: RateLimiter;
  private id = 0;
  readonly commitment: RpcClientOptions["commitment"];
  lastOkAt = 0;
  lastErrorAt = 0;
  consecutiveErrors = 0;
  /** credits spent by this client (every answered request except HTTP 429) */
  creditsUsed = 0;

  constructor(private readonly o: RpcClientOptions) {
    this.limiter = new RateLimiter(o.maxRps, o.maxConcurrency);
    this.commitment = o.commitment;
  }

  /** true when the server rate-limited this client within the last 15 s */
  get throttled(): boolean {
    return this.limiter.throttledRecently();
  }

  /** current adaptive request rate */
  get currentRps(): number {
    return this.limiter.rps;
  }

  get healthy(): boolean {
    return this.consecutiveErrors < 3;
  }

  private static readonly FORBIDDEN = new Set(["sendTransaction", "requestAirdrop", "simulateTransaction"]);

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (RpcClient.FORBIDDEN.has(method)) throw new Error(`RPC method ${method} is not allowed (read-only tool)`);
    const endpoint = this.o.endpoint ?? "rpc";
    return withRetry(
      async () => {
        const release = await this.limiter.acquire();
        try {
          const res = await fetch(this.o.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
            signal: AbortSignal.timeout(this.o.timeoutMs),
          });
          if (res.status === 429) this.limiter.throttle();
          else this.creditsUsed += this.o.creditOf?.(method) ?? 1;
          if (res.status === 429 || res.status >= 500) {
            const ra = Number(res.headers.get("retry-after"));
            throw new RetryableError(`HTTP ${res.status} on ${method}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
          }
          if (!res.ok) throw new RpcError(`HTTP ${res.status} on ${method}`, res.status);
          const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
          if (body.error) {
            if (body.error.code === -32005 || body.error.code === 429) this.limiter.throttle();
            if (RETRYABLE_RPC_CODES.has(body.error.code)) {
              throw new RetryableError(`RPC ${body.error.code} ${body.error.message} on ${method}`);
            }
            throw new RpcError(`RPC ${body.error.code} ${body.error.message} on ${method}`, body.error.code, body.error.data);
          }
          this.o.usage?.record(endpoint, method, true);
          this.limiter.success();
          this.lastOkAt = Date.now();
          this.consecutiveErrors = 0;
          return body.result as T;
        } catch (e) {
          this.o.usage?.record(endpoint, method, false);
          this.lastErrorAt = Date.now();
          this.consecutiveErrors++;
          throw e;
        } finally {
          release();
        }
      },
      {
        maxAttempts: this.o.retry.max_attempts,
        baseDelayMs: this.o.retry.base_delay_ms,
        maxDelayMs: this.o.retry.max_delay_ms,
        signal: this.o.signal,
        isRetryable: (e) => !(e instanceof RpcError),
        onRetry: (e, attempt, delay) =>
          this.o.log?.warn({ method, attempt, delay, err: (e as Error).message, url: redactUrl(this.o.url) }, "rpc retry"),
      },
    );
  }

  /** getMultipleAccounts in chunks of 100; returns one entry per key (null when missing) and the min slot. */
  async getMultipleAccounts(keys: string[]): Promise<{ slot: number; accounts: (AccountInfoRaw | null)[] }> {
    const out: (AccountInfoRaw | null)[] = [];
    let slot = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const r = await this.call<{
        context: { slot: number };
        value: ({ data: [string, string]; owner: string; lamports: number; executable: boolean } | null)[];
      }>("getMultipleAccounts", [chunk, { encoding: "base64", commitment: this.commitment }]);
      slot = Math.min(slot, r.context.slot);
      for (const v of r.value) {
        out.push(v ? { data: Buffer.from(v.data[0], "base64"), owner: v.owner, lamports: v.lamports, executable: v.executable } : null);
      }
    }
    return { slot: keys.length ? slot : 0, accounts: out };
  }

  async getTransaction(signature: string): Promise<RawTransaction | null> {
    return this.call<RawTransaction | null>("getTransaction", [
      signature,
      { encoding: "json", maxSupportedTransactionVersion: 1, commitment: this.commitment === "processed" ? "confirmed" : this.commitment },
    ]);
  }

  async getSignaturesForAddress(address: string, opts: { until?: string; before?: string; limit?: number }) {
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [
      address,
      { ...opts, commitment: this.commitment === "processed" ? "confirmed" : this.commitment },
    ]);
  }
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}

export interface RawInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string; // base58
  stackHeight?: number | null;
}

export interface RawTransaction {
  slot: number;
  blockTime: number | null;
  version?: number | "legacy";
  meta: {
    err: unknown;
    innerInstructions?: { index: number; instructions: RawInstruction[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
    logMessages?: string[] | null;
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: string[]; instructions: RawInstruction[] };
  };
}
