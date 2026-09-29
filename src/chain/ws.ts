import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { backoffDelay, sleep } from "../util/async.ts";
import type { Logger } from "../util/logger.ts";
import { redactUrl } from "../util/redact.ts";

/** `ws` ignores HTTPS_PROXY; honour it when set (sandboxed / corporate networks). Unset -> direct. */
let agentCache: HttpsProxyAgent<string> | null | undefined;
function proxyAgent(): HttpsProxyAgent<string> | undefined {
  if (agentCache === undefined) {
    const p = process.env.HTTPS_PROXY || process.env.https_proxy;
    agentCache = p ? new HttpsProxyAgent(p) : null;
  }
  return agentCache ?? undefined;
}

export interface SubscriptionSpec {
  key: string; // caller's id (e.g. pool address)
  method: string; // e.g. logsSubscribe
  params: unknown[];
  notification: string; // e.g. logsNotification
}

export interface WsOptions {
  url: string;
  heartbeatSeconds: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  log?: Logger;
  signal: AbortSignal;
}

/**
 * Solana PubSub client with automatic reconnect (exponential backoff), resubscription and a
 * ping/pong heartbeat. Events:
 *   'up'                      connection (re)established and all subscriptions re-sent
 *   'down' (reason)           connection lost
 *   'notification' (key, value)
 */
export class ReconnectingWs extends EventEmitter {
  private ws?: WebSocket;
  private specs = new Map<string, SubscriptionSpec>();
  private reqToKey = new Map<number, string>();
  private subIdToKey = new Map<number, string>();
  private nextId = 1;
  private alive = false;
  connected = false;
  reconnects = 0;
  lastMessageAt = 0;

  constructor(private readonly o: WsOptions) {
    super();
  }

  subscribe(spec: SubscriptionSpec) {
    this.specs.set(spec.key, spec);
    if (this.connected) this.sendSubscribe(spec);
  }

  private sendSubscribe(spec: SubscriptionSpec) {
    const id = this.nextId++;
    this.reqToKey.set(id, spec.key);
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method: spec.method, params: spec.params }));
  }

  async run(): Promise<void> {
    let attempt = 0;
    while (!this.o.signal.aborted) {
      const startedAt = Date.now();
      const reason = await this.connectOnce();
      if (this.o.signal.aborted) break;
      this.emit("down", reason);
      // A connection that stayed up for a while resets the backoff.
      attempt = Date.now() - startedAt > 60_000 ? 1 : attempt + 1;
      const delay = backoffDelay(attempt, this.o.reconnectBaseDelayMs, this.o.reconnectMaxDelayMs);
      this.o.log?.warn({ reason, delay, url: redactUrl(this.o.url) }, "ws reconnecting");
      this.reconnects++;
      await sleep(delay, this.o.signal);
    }
  }

  private connectOnce(): Promise<string> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (reason: string) => {
        if (settled) return;
        settled = true;
        clearInterval(hb);
        this.connected = false;
        this.reqToKey.clear();
        this.subIdToKey.clear();
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        resolve(reason);
      };
      const ws = new WebSocket(this.o.url, { handshakeTimeout: 15_000, agent: proxyAgent() });
      this.ws = ws;
      const onAbort = () => done("aborted");
      this.o.signal.addEventListener("abort", onAbort, { once: true });

      const hb = setInterval(() => {
        if (!this.alive) return done("heartbeat timeout");
        this.alive = false;
        try {
          ws.ping();
        } catch {
          done("ping failed");
        }
      }, this.o.heartbeatSeconds * 1000);

      ws.on("open", () => {
        this.connected = true;
        this.alive = true;
        this.lastMessageAt = Date.now();
        for (const s of this.specs.values()) this.sendSubscribe(s);
        this.emit("up");
      });
      ws.on("pong", () => (this.alive = true));
      ws.on("message", (buf) => {
        this.alive = true;
        this.lastMessageAt = Date.now();
        let msg: any;
        try {
          msg = JSON.parse(buf.toString());
        } catch {
          return;
        }
        if (msg.id !== undefined && this.reqToKey.has(msg.id)) {
          const key = this.reqToKey.get(msg.id)!;
          this.reqToKey.delete(msg.id);
          if (msg.error) {
            this.o.log?.error({ key, err: msg.error }, "ws subscribe failed");
            this.emit("subscribeError", key, msg.error);
          } else this.subIdToKey.set(msg.result, key);
          return;
        }
        if (msg.method && msg.params) {
          const key = this.subIdToKey.get(msg.params.subscription);
          if (key) {
            try {
              this.emit("notification", key, msg.params.result);
            } catch (e) {
              // a listener failure (e.g. a busy database) must not kill the connection or process
              this.o.log?.error({ key, err: (e as Error).message }, "ws notification handler failed");
            }
          }
        }
      });
      ws.on("close", (code) => {
        this.o.signal.removeEventListener("abort", onAbort);
        done(`closed ${code}`);
      });
      ws.on("error", (e) => done(`error ${(e as Error).message}`));
    });
  }
}
