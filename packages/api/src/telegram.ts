/** Telegram tokens are part of request URLs. Never log URLs, raw errors or response bodies here. */
export interface TelegramMessage { text: string; url: string; button: string }
export type TelegramDelivery = { status: "sent" | "unknown" | "failed" | "retry"; retryAfterSeconds?: number };
export interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; date: number; chat: { id: number; type: string } };
}
export interface TelegramTransport {
  send(message: TelegramMessage): Promise<TelegramDelivery>;
  updates(offset: number): Promise<TelegramUpdate[] | null>;
}

export class TelegramClient implements TelegramTransport {
  constructor(private readonly token: string, private readonly chatId: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request(method: string, body: unknown) {
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000), redirect: "error",
      });
      const value = await response.json() as { ok?: boolean; result?: unknown; error_code?: number; parameters?: { retry_after?: number } };
      if (!value || typeof value !== "object") return null;
      return { httpStatus: response.status, value };
    } catch { return null; }
  }

  async send(message: TelegramMessage): Promise<TelegramDelivery> {
    const result = await this.request("sendMessage", {
      chat_id: this.chatId, text: message.text.slice(0, 4000),
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: message.button, url: message.url }]] },
    });
    if (!result) return { status: "unknown" };
    const { httpStatus, value } = result;
    if (httpStatus === 200 && value.ok === true && value.result && typeof value.result === "object" &&
      Number.isSafeInteger((value.result as { message_id?: number }).message_id)) return { status: "sent" };
    if (httpStatus === 429 && value.ok === false) {
      const delay = value.parameters?.retry_after;
      return { status: "retry", retryAfterSeconds: Number.isSafeInteger(delay) && delay! > 0 ? Math.min(delay!, 86_400) : 60 };
    }
    if (httpStatus >= 400 && httpStatus < 500 && value.ok === false) return { status: "failed" };
    return { status: "unknown" };
  }

  async updates(offset: number): Promise<TelegramUpdate[] | null> {
    const result = await this.request("getUpdates", { offset, limit: 100, timeout: 0, allowed_updates: ["message"] });
    if (!result || result.httpStatus !== 200 || result.value.ok !== true || !Array.isArray(result.value.result)) return null;
    return result.value.result as TelegramUpdate[];
  }
}
