/**
 * Minimal Telegram Bot API client (Bot API 10.3, verified 2026-09-29): sendMessage and getUpdates
 * (long polling). Read-only use: nothing here touches funds or configuration. The bot token is
 * part of the URL, so every error message is redacted before it can reach a log.
 */
export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}
export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TelegramClient {
  sendMessage(chatId: string | number, text: string): Promise<void>;
  getUpdates(offset: number | undefined, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
}

export const TG_MAX_TEXT = 4096;

export class TelegramApiError extends Error {
  constructor(message: string, readonly retryAfterSec: number | null = null) {
    super(message);
  }
}

export class TelegramApi implements TelegramClient {
  private readonly base: string;
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch, baseUrl = "https://api.telegram.org") {
    if (!/^\d+:[\w-]+$/.test(token)) throw new Error("TELEGRAM_BOT_TOKEN has an unexpected format");
    this.base = `${baseUrl}/bot${token}`;
  }

  private redact(s: string) {
    return s.split(this.token).join("<token>");
  }

  private async call<T>(method: string, body: object, signal?: AbortSignal, timeoutMs = 20_000): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TelegramApiError(this.redact(`${method}: ${(e as Error).message}`));
    }
    const j = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } | null;
    if (!j?.ok) throw new TelegramApiError(this.redact(`${method}: HTTP ${res.status} ${j?.description ?? ""}`), j?.parameters?.retry_after ?? null);
    return j.result as T;
  }

  async sendMessage(chatId: string | number, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text: text.slice(0, TG_MAX_TEXT), link_preview_options: { is_disabled: true } });
  }

  getUpdates(offset: number | undefined, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, signal, (timeoutSec + 15) * 1000);
  }
}
