import type { Config } from "../config/schema.ts";
import type { Db } from "../db/index.ts";
import type { Logger } from "../util/logger.ts";
import { sleep } from "../util/async.ts";
import {
  formatLatestSignals, formatPositions, formatSessionResult, formatSignals, formatStatus, HELP, latestHeartbeat, wib, type SignalRow,
} from "./format.ts";
import { TelegramApiError, type TelegramClient, type TgUpdate } from "./telegramApi.ts";

export interface TelegramAccess {
  /** notifications go here; commands are accepted only from these chats */
  chatIds: string[];
  /** commands are accepted only from these users */
  userIds: string[];
}

/** Access list from .env (TELEGRAM_CHAT_ID, TELEGRAM_ALLOWED_USER_IDS; comma-separated). */
export function accessFromEnv(env = process.env): TelegramAccess {
  const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return { chatIds: list(env.TELEGRAM_CHAT_ID), userIds: list(env.TELEGRAM_ALLOWED_USER_IDS) };
}

type OutType = "session_start" | "session_end" | "signal" | "alert" | "briefing" | "reply";

interface Outgoing {
  type: OutType;
  text: string;
  chatId: string;
  /** replies are never dropped by the hourly cap */
  priority: boolean;
}

/**
 * Read-only Telegram notifier + command handler (addendum 5). Works purely from the database, so
 * it runs inside a live session or as its own process (`dlmm telegram run`) with the same result:
 *  - session start / end (with the result), batched signals above the thresholds, operational
 *    alerts (open data gaps, RPC quota, WebSocket down, stale heartbeat, error bursts), a daily
 *    briefing at telegram.daily_briefing_time_wib;
 *  - commands /status /positions /signals /report /stop /help, only from allowed chat AND user ids;
 *    /stop uses the existing session_control request (the session closes cleanly). No command
 *    changes configuration, weights or anything touching funds.
 * Cursors live in telegram_state, so a restart never resends. Messages are rate limited
 * (min interval, hourly cap for non-replies); every message is logged in notifications_log.
 */
export class TelegramService {
  private queue: Outgoing[] = [];
  private lastSentAt = 0;
  private sentTimes: number[] = [];
  private pendingSignals: SignalRow[] = [];
  private batchStartedAt: number | null = null;
  private wsDownSince: number | null = null;
  private errorSamples: { ts: number; errors: number }[] = [];

  constructor(
    private readonly db: Db,
    private readonly c: Config["telegram"],
    private readonly tg: TelegramClient,
    private readonly access: TelegramAccess,
    private readonly log?: Logger,
    private readonly quotaWarnPct?: number,
  ) {}

  // ------------------------------------------------------------------ state
  private get(key: string): string | null {
    return this.db.get<{ value: string }>("SELECT value FROM telegram_state WHERE key = ?", key)?.value ?? null;
  }
  private set(key: string, value: string | number) {
    this.db.run("INSERT INTO telegram_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
  }
  private logMsg(type: string, text: string, status: string, detail?: unknown) {
    this.db.insert("notifications_log", { ts: Date.now(), type, summary: text.split("\n")[0].slice(0, 200), status, detail: detail === undefined ? null : JSON.stringify(detail) });
  }

  /** First start: cursors at "now" so the history is not replayed into the chat. */
  init(now = Date.now()) {
    if (this.get("signal_rowid") === null) this.set("signal_rowid", this.db.get<{ m: number | null }>("SELECT MAX(rowid) m FROM signals")?.m ?? 0);
    if (this.get("session_cursor") === null) this.set("session_cursor", now);
  }

  // ------------------------------------------------------------------ sending
  enqueue(type: OutType, text: string, priority = false, chatId?: string) {
    for (const id of chatId ? [chatId] : this.access.chatIds) this.queue.push({ type, text, chatId: id, priority });
  }

  /** Send what the rate limits allow; drop non-replies over the hourly cap (logged). */
  async flush(now = Date.now()) {
    this.sentTimes = this.sentTimes.filter((t) => t > now - 3_600_000);
    while (this.queue.length) {
      const m = this.queue[0];
      if (!m.priority && this.sentTimes.length >= this.c.max_messages_per_hour) {
        this.queue.shift();
        this.logMsg(m.type, m.text, "dropped", { reason: "max_messages_per_hour" });
        continue;
      }
      const wait = this.lastSentAt + this.c.min_interval_seconds * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        await this.tg.sendMessage(m.chatId, m.text);
        this.queue.shift();
        this.lastSentAt = Date.now();
        this.sentTimes.push(this.lastSentAt);
        this.logMsg(m.type, m.text, "sent");
      } catch (e) {
        const retry = e instanceof TelegramApiError ? e.retryAfterSec : null;
        if (retry !== null && retry <= 60) {
          await sleep(retry * 1000);
          continue;
        }
        this.queue.shift();
        this.logMsg(m.type, m.text, "failed", { err: (e as Error).message });
        this.log?.warn({ err: (e as Error).message }, "telegram send failed");
      }
    }
  }

  // ------------------------------------------------------------------ watchers
  watchSessions(now = Date.now()) {
    const cursor = Number(this.get("session_cursor") ?? now);
    for (const s of this.db.all<{ session_id: string; label: string | null; start_at: number }>(
      "SELECT session_id, label, start_at FROM sessions WHERE kind = 'session' AND start_at > ? AND start_at <= ? ORDER BY start_at", cursor, now,
    )) {
      const pools = this.db.get<{ n: number }>("SELECT COUNT(*) n FROM session_pools WHERE session_id = ?", s.session_id)?.n ?? 0;
      this.enqueue("session_start", `▶️ Session started: ${s.label ?? s.session_id.slice(0, 8)}\n${wib(s.start_at)} · ${pools} pools\nVirtual demo only — no real funds.`);
    }
    for (const s of this.db.all<{ session_id: string }>(
      "SELECT session_id FROM sessions WHERE kind = 'session' AND status != 'running' AND end_at > ? AND end_at <= ? ORDER BY end_at", cursor, now,
    ))
      this.enqueue("session_end", formatSessionResult(this.db, s.session_id, "⏹ Session finished"));
    this.set("session_cursor", now);
  }

  watchSignals(now = Date.now()) {
    const last = Number(this.get("signal_rowid") ?? 0);
    const rows = this.db.all<SignalRow & { rowid: number; score: number | null; conf: number | null }>(
      `SELECT rowid, signal_id, pool, ts, action, payload, json_extract(payload, '$.final_score') score, json_extract(payload, '$.confidence') conf
       FROM signals WHERE rowid > ? ORDER BY rowid`,
      last,
    );
    if (rows.length) this.set("signal_rowid", rows[rows.length - 1].rowid);
    // only sessions that are live (replays write signals too)
    const live = new Set(this.db.all<{ session_id: string }>("SELECT session_id FROM sessions WHERE kind = 'session'").map((r) => r.session_id));
    const keep = rows.filter(
      (r) => live.has(JSON.parse(r.payload).session_id) && this.c.signal_actions.includes(r.action) && (r.score ?? -1) >= this.c.min_signal_score && (r.conf ?? 0) >= this.c.min_confidence,
    );
    // newest signal per pool within the batch
    for (const r of keep) {
      this.pendingSignals = this.pendingSignals.filter((x) => x.pool !== r.pool);
      this.pendingSignals.push(r);
      this.batchStartedAt ??= now;
    }
    if (this.batchStartedAt !== null && now - this.batchStartedAt >= this.c.batch_seconds * 1000 && this.pendingSignals.length) {
      this.enqueue("signal", formatSignals(this.db, this.pendingSignals));
      this.pendingSignals = [];
      this.batchStartedAt = null;
    }
  }

  private alert(key: string, text: string, now: number) {
    const last = Number(this.get(`alert|${key}`) ?? 0);
    if (now - last < this.c.alerts.repeat_minutes * 60_000) return;
    this.set(`alert|${key}`, now);
    this.enqueue("alert", `⚠️ ${text}`);
  }

  watchAlerts(now = Date.now()) {
    const a = this.c.alerts;
    const running = this.db.all<{ session_id: string; label: string | null; start_at: number }>(
      "SELECT session_id, label, start_at FROM sessions WHERE kind IN ('session', 'collect') AND status = 'running'",
    );
    for (const s of running) {
      const name = s.label ?? s.session_id.slice(0, 8);
      const gaps = this.db.all<{ source: string; pool: string | null; start_at: number; reason: string | null }>(
        "SELECT source, pool, start_at, cause AS reason FROM data_gaps WHERE session_id = ? AND end_at IS NULL AND start_at <= ?", s.session_id, now - a.gap_minutes * 60_000,
      );
      const bySource = new Map<string, typeof gaps>();
      for (const g of gaps) (bySource.get(g.source) ?? bySource.set(g.source, []).get(g.source)!).push(g);
      for (const [src, list] of bySource)
        this.alert(`gap|${s.session_id}|${src}`, `${name}: data gap on ${src} for ${list.length} pool(s), open since ${wib(Math.min(...list.map((g) => g.start_at)))}${list[0].reason ? ` (${list[0].reason})` : ""}`, now);
      const hb = this.db.get<{ ts: number; state: string }>("SELECT ts, state FROM session_heartbeat WHERE session_id = ?", s.session_id);
      if (!hb) {
        if (now - s.start_at > a.heartbeat_stale_minutes * 60_000 * 2) this.alert(`nohb|${s.session_id}`, `${name}: running but no heartbeat yet`, now);
        continue;
      }
      if (now - hb.ts > a.heartbeat_stale_minutes * 60_000) this.alert(`stale|${s.session_id}`, `${name}: no heartbeat for ${((now - hb.ts) / 60_000).toFixed(0)} min — session hung or laptop asleep?`, now);
      const h = (JSON.parse(hb.state).health ?? {}) as { quotaPct?: number; wsConnected?: boolean | null; httpErrors?: number };
      if (h.quotaPct !== undefined && h.quotaPct >= (this.quotaWarnPct ?? a.quota_pct)) this.alert(`quota|${s.session_id}`, `${name}: RPC credits at ${h.quotaPct.toFixed(1)}% of the plan`, now);
      if (h.wsConnected === false) {
        this.wsDownSince ??= hb.ts;
        if (hb.ts - this.wsDownSince >= a.ws_down_minutes * 60_000) this.alert(`ws|${s.session_id}`, `${name}: swap stream WebSocket down for ${((hb.ts - this.wsDownSince) / 60_000).toFixed(0)} min (backfill polling continues)`, now);
      } else if (h.wsConnected) this.wsDownSince = null;
      if (typeof h.httpErrors === "number") {
        this.errorSamples.push({ ts: now, errors: h.httpErrors });
        this.errorSamples = this.errorSamples.filter((x) => x.ts >= now - 10 * 60_000);
        const d = h.httpErrors - this.errorSamples[0].errors;
        if (d >= 100) this.alert(`errors|${s.session_id}`, `${name}: ${d} HTTP/RPC errors in the last 10 min`, now);
      }
    }
  }

  /** Daily briefing once per WIB day after the configured time: last finished session. */
  watchBriefing(now = Date.now()) {
    const local = new Date(now + 7 * 3_600_000);
    const day = local.toISOString().slice(0, 10);
    const [hh, mm] = this.c.daily_briefing_time_wib.split(":").map(Number);
    if (local.getUTCHours() * 60 + local.getUTCMinutes() < hh * 60 + mm || this.get("briefing_day") === day) return;
    this.set("briefing_day", day);
    const last = this.db.get<{ session_id: string }>("SELECT session_id FROM sessions WHERE kind = 'session' AND status != 'running' ORDER BY end_at DESC LIMIT 1");
    const sessions24 = this.db.get<{ n: number }>("SELECT COUNT(*) n FROM sessions WHERE kind = 'session' AND end_at > ?", now - 86_400_000)?.n ?? 0;
    const body = last ? formatSessionResult(this.db, last.session_id, "Last session") : "No finished session yet.";
    const real = this.db.get<{ n: number; smart: number }>("SELECT (SELECT COUNT(*) FROM real_lp_positions) n, (SELECT COUNT(*) FROM lp_wallets WHERE status_smart = 1) smart");
    this.enqueue("briefing", [`☀️ Daily briefing ${day}`, `${sessions24} session(s) finished in the last 24 h.`, "", body, "", `Real LP data: ${real?.n ?? 0} positions, ${real?.smart ?? 0} smart wallets.`].join("\n"));
  }

  // ------------------------------------------------------------------ commands
  authorized(u: TgUpdate): boolean {
    const m = u.message;
    return !!m && this.access.chatIds.includes(String(m.chat.id)) && !!m.from && this.access.userIds.includes(String(m.from.id));
  }

  handleUpdate(u: TgUpdate, now = Date.now()) {
    const m = u.message;
    if (!m?.text?.startsWith("/")) return;
    const cmd = m.text.split(/[\s@]/)[0].toLowerCase();
    if (!this.authorized(u)) {
      this.logMsg("command", `${cmd} from chat ${m.chat.id} user ${m.from?.id ?? "?"}`, "ignored");
      return;
    }
    this.logMsg("command", `${cmd} from user ${m.from!.id}`, "accepted");
    const chat = String(m.chat.id);
    const reply = (text: string) => this.enqueue("reply", text, true, chat);
    switch (cmd) {
      case "/status":
        return reply(formatStatus(this.db, now));
      case "/positions":
        return reply(formatPositions(this.db));
      case "/signals":
        return reply(formatLatestSignals(this.db));
      case "/report": {
        const last = this.db.get<{ session_id: string }>("SELECT session_id FROM sessions WHERE kind IN ('session', 'sim_replay') AND status != 'running' ORDER BY end_at DESC LIMIT 1");
        return reply(last ? formatSessionResult(this.db, last.session_id, "Last report") + `\nfull report: reports/${last.session_id}/report.html` : "No finished session yet.");
      }
      case "/stop": {
        const running = this.db.all<{ session_id: string }>("SELECT session_id FROM sessions WHERE status = 'running' AND kind IN ('session', 'collect')");
        if (!running.length) return reply("No running session.");
        this.db.insert("session_control", { session_id: "*", action: "stop", requested_at: now });
        return reply(`Stop requested for ${running.length} running session(s): positions are closed and the report is written within ~5 s.`);
      }
      case "/start":
      case "/help":
        return reply(HELP);
      default:
        return reply(`Unknown command ${cmd}.\n\n${HELP}`);
    }
  }

  async pollUpdates(signal?: AbortSignal, timeoutSec = 25) {
    const off = this.get("update_offset");
    const ups = await this.tg.getUpdates(off === null ? undefined : Number(off), timeoutSec, signal);
    for (const u of ups) {
      this.set("update_offset", u.update_id + 1);
      this.handleUpdate(u);
    }
    if (ups.length) await this.flush();
  }

  /** One watch round (sessions, signals, alerts, briefing) and a flush. */
  async tick(now = Date.now()) {
    this.watchSessions(now);
    this.watchSignals(now);
    this.watchAlerts(now);
    this.watchBriefing(now);
    await this.flush(now);
  }

  /** Watch loop + long-poll loop until aborted. */
  async run(signal: AbortSignal) {
    this.init();
    const watch = (async () => {
      while (!signal.aborted) {
        try {
          await this.tick();
        } catch (e) {
          this.log?.warn({ err: (e as Error).message }, "telegram watch failed");
        }
        await sleep(this.c.poll_seconds * 1000, signal).catch(() => {});
      }
    })();
    const poll = (async () => {
      while (!signal.aborted) {
        try {
          await this.pollUpdates(signal);
        } catch (e) {
          if (signal.aborted) break;
          this.log?.warn({ err: (e as Error).message }, "telegram getUpdates failed");
          await sleep(10_000, signal).catch(() => {});
        }
      }
    })();
    await Promise.all([watch, poll]);
    await this.flush().catch(() => {});
  }
}

export { latestHeartbeat };
