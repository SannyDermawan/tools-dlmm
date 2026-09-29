import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { Db, migrate } from "../src/db/index.ts";
import { registerConfigVersion } from "../src/db/repo.ts";
import { TelegramService, accessFromEnv } from "../src/notify/service.ts";
import { TelegramApi, TelegramApiError, type TelegramClient, type TgUpdate } from "../src/notify/telegramApi.ts";

const cfg = (): Config => structuredClone(loadConfig().config);
const MIN = 60_000;

class FakeTg implements TelegramClient {
  sent: { chatId: string | number; text: string }[] = [];
  updates: TgUpdate[] = [];
  failNext: Error | null = null;
  async sendMessage(chatId: string | number, text: string) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.sent.push({ chatId, text });
  }
  async getUpdates(offset?: number) {
    return this.updates.filter((u) => offset === undefined || u.update_id >= offset);
  }
}

const setup = (o: (c: Config["telegram"]) => void = () => {}) => {
  const db = new Db(":memory:");
  migrate(db);
  const cv = registerConfigVersion(db, loadConfig());
  const c = cfg().telegram;
  c.min_interval_seconds = 0;
  o(c);
  const tg = new FakeTg();
  const svc = new TelegramService(db, c, tg, { chatIds: ["100"], userIds: ["7"] });
  return { db, cv, c, tg, svc };
};
const msg = (update_id: number, text: string, chat = 100, user = 7): TgUpdate => ({
  update_id, message: { message_id: update_id, date: 0, chat: { id: chat, type: "private" }, from: { id: user }, text },
});
const signalRow = (db: Db, sessionId: string, pool: string, ts: number, action: string, score: number, conf: number) =>
  db.insert("signals", {
    signal_id: `${pool}-${ts}`, session_id: sessionId, pool, ts, action, taken: 0, config_version: "x",
    payload: JSON.stringify({
      session_id: sessionId, final_score: score, confidence: conf, regime_label: "sideways", top_reasons: ["edge high"], risks: ["pvp"],
      recommendation: { strategy: "spot", sides: "two_sided", bins_below: 5, bins_above: 5, price_min: 0.9, price_max: 1.1, size_fraction: 0.05 },
      expectations: { net_return_per_hour_pct: 0.3, fee_il_ratio: 2, p_in_range: 0.7, horizon_minutes: 120 },
    }),
  });

describe("telegram access and API client (addendum 5.3)", () => {
  it("reads chat and user ids from .env", () => {
    expect(accessFromEnv({ TELEGRAM_CHAT_ID: "100, -200", TELEGRAM_ALLOWED_USER_IDS: "7" })).toEqual({ chatIds: ["100", "-200"], userIds: ["7"] });
    expect(accessFromEnv({})).toEqual({ chatIds: [], userIds: [] });
  });
  it("never leaks the bot token in errors; passes retry_after", async () => {
    const token = "123456:ABC-def_ghi";
    const fake = (async (url: string) => {
      expect(url).toContain(token);
      return new Response(JSON.stringify({ ok: false, description: `Too Many Requests at ${url}`, parameters: { retry_after: 3 } }), { status: 429 });
    }) as unknown as typeof fetch;
    const api = new TelegramApi(token, fake);
    const err = (await api.sendMessage(1, "x").then(() => null, (e: unknown) => e)) as TelegramApiError;
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.message).not.toContain(token);
    expect(err.retryAfterSec).toBe(3);
    expect(() => new TelegramApi("not a token")).toThrow();
  });
});

describe("commands (addendum 5.2)", () => {
  it("answers only allowed chat AND user; others are ignored and logged", async () => {
    const { db, tg, svc } = setup();
    svc.handleUpdate(msg(1, "/status", 100, 999)); // wrong user
    svc.handleUpdate(msg(2, "/status", 555, 7)); // wrong chat
    svc.handleUpdate(msg(3, "hello")); // not a command
    await svc.flush();
    expect(tg.sent).toEqual([]);
    expect(db.all<{ status: string }>("SELECT status FROM notifications_log").map((r) => r.status)).toEqual(["ignored", "ignored"]);
    svc.handleUpdate(msg(4, "/help@dlmm_bot"));
    await svc.flush();
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toMatch(/Read-only commands/);
  });
  it("/stop files a session_control request only when a session runs", async () => {
    const { db, cv, tg, svc } = setup();
    svc.handleUpdate(msg(1, "/stop"));
    await svc.flush();
    expect(tg.sent[0].text).toMatch(/No running session/);
    db.insert("sessions", { session_id: "S", kind: "session", start_at: 0, status: "running", config_version: cv });
    svc.handleUpdate(msg(2, "/stop"));
    await svc.flush();
    expect(db.get("SELECT session_id, action FROM session_control")).toEqual({ session_id: "*", action: "stop" });
    expect(tg.sent[1].text).toMatch(/Stop requested for 1/);
  });
  it("/status and /positions read the heartbeat", async () => {
    const { db, cv, tg, svc } = setup();
    db.insert("sessions", { session_id: "S", kind: "session", start_at: 0, status: "running", config_version: cv, label: "sesi-2jam" });
    db.insert("session_heartbeat", {
      session_id: "S", ts: Date.now(), pid: 1,
      state: JSON.stringify({ phase: "active", leftMin: 42, positions: { active: 5, pending: 0, closed: 3, failed: 0 }, health: { openGaps: [], wsConnected: true, credits: 900, quotaPct: 1.2, httpErrors: 0 }, pnl: { byMode: { all_pools_baseline: { n: 8, active: 5, netUsd: 12.5, feeUsd: 20, win: 5 } } } }),
    });
    svc.handleUpdate(msg(1, "/status"));
    svc.handleUpdate(msg(2, "/positions"));
    await svc.flush();
    expect(tg.sent[0].text).toMatch(/sesi-2jam — running, phase active, 42 min left/);
    expect(tg.sent[1].text).toMatch(/all_pools_baseline: 8 \(5\) · \$12\.50/);
  });
  it("update offsets persist: a restart does not re-handle old commands", async () => {
    const { db, c, tg, svc } = setup();
    tg.updates = [msg(10, "/help"), msg(11, "/help")];
    await svc.pollUpdates();
    expect(tg.sent).toHaveLength(2);
    const svc2 = new TelegramService(db, c, tg, { chatIds: ["100"], userIds: ["7"] });
    await svc2.pollUpdates();
    expect(tg.sent).toHaveLength(2);
  });
});

describe("notifications (addendum 5.1)", () => {
  it("signals above the thresholds of live sessions are batched into one message; history is not replayed", async () => {
    const { db, cv, tg, svc, c } = setup((c) => (c.batch_seconds = 60));
    db.insert("sessions", { session_id: "S", kind: "session", start_at: 0, status: "running", config_version: cv });
    db.insert("sessions", { session_id: "R", kind: "sim_replay", start_at: 0, status: "completed", config_version: cv });
    signalRow(db, "S", "OLD", 1, "MASUK", 95, 0.9);
    svc.init(1000);
    signalRow(db, "S", "A", 2, "MASUK", 90, 0.8);
    signalRow(db, "S", "B", 2, "MASUK", 70, 0.9); // score too low
    signalRow(db, "S", "C", 2, "MASUK", 90, 0.5); // confidence too low
    signalRow(db, "S", "D", 2, "PANTAU", 90, 0.9); // action not notified
    signalRow(db, "R", "E", 2, "MASUK", 99, 0.9); // replay
    svc.watchSignals(10 * MIN);
    await svc.flush();
    expect(tg.sent).toHaveLength(0); // batch window still open
    signalRow(db, "S", "F", 3, "MASUK", c.min_signal_score, c.min_confidence);
    svc.watchSignals(10 * MIN + 61_000);
    await svc.flush();
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toMatch(/2 signals/);
    expect(tg.sent[0].text).toMatch(/MASUK A/);
    expect(tg.sent[0].text).toMatch(/MASUK F/);
    expect(tg.sent[0].text).not.toMatch(/OLD|MASUK B|MASUK C|D —|MASUK E/);
    expect(tg.sent[0].text).toMatch(/not financial advice/);
  });
  it("session start and end (with result) are announced once", async () => {
    const { db, cv, tg, svc } = setup();
    svc.init(1000);
    db.insert("sessions", { session_id: "S", kind: "session", start_at: 2000, status: "running", config_version: cv, label: "sesi" });
    svc.watchSessions(3000);
    db.run("UPDATE sessions SET status = 'completed', end_at = 4000 WHERE session_id = 'S'");
    svc.watchSessions(5000);
    svc.watchSessions(6000);
    await svc.flush();
    expect(tg.sent.map((m) => m.text.split("\n")[0])).toEqual(["▶️ Session started: sesi", "⏹ Session finished: sesi (completed)"]);
  });
  it("alerts: open data gap and stale heartbeat, not repeated within repeat_minutes", async () => {
    const { db, cv, tg, svc } = setup();
    const now = 100 * MIN;
    db.insert("sessions", { session_id: "S", kind: "session", start_at: 0, status: "running", config_version: cv, label: "sesi" });
    db.insert("data_gaps", { session_id: "S", source: "pool_state", pool: "P", start_at: now - 10 * MIN, cause: "rpc 429" });
    db.insert("session_heartbeat", { session_id: "S", ts: now - 20 * MIN, pid: 1, state: JSON.stringify({ health: { quotaPct: 85 } }) });
    svc.watchAlerts(now);
    svc.watchAlerts(now + MIN);
    await svc.flush();
    const texts = tg.sent.map((m) => m.text);
    expect(texts).toHaveLength(3);
    expect(texts.some((t) => /data gap on pool_state for 1 pool/.test(t) && /rpc 429/.test(t))).toBe(true);
    expect(texts.some((t) => /no heartbeat for 20 min/.test(t))).toBe(true);
    expect(texts.some((t) => /RPC credits at 85\.0%/.test(t))).toBe(true);
  });
  it("daily briefing once per WIB day after the configured time", async () => {
    const { tg, svc } = setup((c) => (c.daily_briefing_time_wib = "08:00"));
    const day = Date.UTC(2026, 8, 30);
    svc.watchBriefing(day + 0 * 3_600_000); // 07:00 WIB
    svc.watchBriefing(day + 1 * 3_600_000 + 60_000); // 08:01 WIB
    svc.watchBriefing(day + 5 * 3_600_000); // later the same day
    await svc.flush();
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toMatch(/Daily briefing 2026-09-30/);
  });
  it("rate limit: hourly cap drops notifications, never replies; failures are logged", async () => {
    const { db, tg, svc } = setup((c) => (c.max_messages_per_hour = 2));
    for (let i = 0; i < 3; i++) svc.enqueue("alert", `a${i}`);
    svc.enqueue("reply", "r", true);
    await svc.flush();
    expect(tg.sent.map((m) => m.text)).toEqual(["a0", "a1", "r"]);
    tg.failNext = new Error("network down");
    svc.enqueue("reply", "x", true);
    await svc.flush();
    expect(db.all<{ status: string }>("SELECT status FROM notifications_log ORDER BY id").map((r) => r.status)).toEqual(["sent", "sent", "dropped", "sent", "failed"]);
  });
});
