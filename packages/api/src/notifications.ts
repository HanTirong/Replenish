import { createHash, randomUUID } from "node:crypto";
import type { SqlDatabase } from "./db";
import { TelegramClient, type TelegramMessage, type TelegramTransport } from "./telegram";

export interface NotificationFact {
  key: string;
  kind: "approval" | "paid" | "payment_failed" | "payment_unknown" | "food_risk";
  occurredAt: string;
  text: string;
  path: string;
  button: string;
}
interface Preference { enabled: number; enabled_at: string | null; active_session_id: string | null; update_offset: number; last_dispatch_at: string | null; command_status: string | null; commands_after: number; last_command_checked_at: string | null }
interface DeliverySummary { kind: string; status: string; created_at: string; attempted_at: string | null; sent_at: string | null }
interface Pending {
  id: string; event_key: string; kind: string; recipient_tag: string; payload_json: string; session_id: string | null;
  attempts: number; created_at: string;
}

function publicUrl(env: NodeJS.ProcessEnv): string | null {
  try {
    const url = new URL(env.PUBLIC_APP_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim() || "");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

/** Durable business-event queue. Owner commands come only from the configured private Telegram chat. */
export class TelegramNotifications {
  private readonly transport: TelegramTransport | null;
  private readonly origin: string | null;
  private readonly chatId: string;
  private readonly recipientTag: string;
  private readonly botUrl: string | null;
  private delivering: Promise<void> | null = null;
  private polling: Promise<void> | null = null;
  private queueError = false;

  constructor(private readonly db: SqlDatabase, env: NodeJS.ProcessEnv, private readonly clock: () => Date,
    transport?: TelegramTransport) {
    this.origin = publicUrl(env);
    this.chatId = env.TELEGRAM_CHAT_ID?.trim() ?? "";
    const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
    const configured = Boolean(token && /^[1-9]\d{0,15}$/.test(this.chatId) && Number.isSafeInteger(Number(this.chatId)) && this.origin);
    this.transport = configured ? transport ?? new TelegramClient(token, this.chatId) : null;
    this.recipientTag = createHash("sha256").update(this.chatId).digest("hex").slice(0, 24);
    if (configured) {
      const source = createHash("sha256").update(`${token}:${this.chatId}`).digest("hex");
      const previous = db.get<{ source_tag: string | null }>("SELECT source_tag FROM telegram_settings WHERE id='household'");
      if (previous?.source_tag !== source) db.run("UPDATE telegram_settings SET source_tag=?,enabled=0,enabled_at=NULL,active_session_id=NULL,update_offset=0,command_status=NULL,last_command_checked_at=NULL,commands_after=? WHERE id='household'", [source, Math.floor(clock().getTime() / 1000)]);
      // Preserve legacy opt-in, but never infer that its unbound historical test belongs to this session.
      if (this.preferences().enabled && !this.preferences().active_session_id) {
        db.run("UPDATE telegram_settings SET active_session_id=? WHERE id='household' AND enabled=1 AND active_session_id IS NULL", [randomUUID()]);
      }
    }
    const username = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
    this.botUrl = username && /^[A-Za-z0-9_]{5,32}$/.test(username) ? `https://t.me/${username}` : null;
  }

  private preferences() { return this.db.get<Preference>("SELECT * FROM telegram_settings WHERE id='household'")!; }

  status() {
    const preference = this.preferences();
    const configured = Boolean(this.transport), enabled = Boolean(this.transport && preference.enabled);
    const last = this.db.get<{ status: string; attempted_at: string | null; sent_at: string | null }>(
      "SELECT status, attempted_at, sent_at FROM notification_outbox WHERE recipient_tag=? AND status NOT IN ('cancelled','pending') ORDER BY attempted_at DESC, rowid DESC LIMIT 1", [this.recipientTag]);
    const test = configured && preference.active_session_id ? this.db.get<DeliverySummary>(
      "SELECT kind,status,created_at,attempted_at,sent_at FROM notification_outbox WHERE recipient_tag=? AND event_key LIKE 'control:test:%' AND session_id=? ORDER BY rowid DESC LIMIT 1",
      [this.recipientTag, preference.active_session_id]) : undefined;
    const recent = configured && preference.active_session_id ? this.db.all<DeliverySummary>(
      "SELECT kind,status,created_at,attempted_at,sent_at FROM notification_outbox WHERE recipient_tag=? AND kind IN ('approval','paid','payment_failed','payment_unknown','food_risk') AND status<>'cancelled' AND session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5",
      [this.recipientTag, preference.active_session_id]) : [];
    const summary = (row: DeliverySummary) => ({ kind: row.kind, status: row.status, createdAt: row.created_at, attemptedAt: row.attempted_at, acceptedAt: row.sent_at });
    return {
      configured, enabled, botUrl: this.botUrl,
      lastOutcome: last?.status ?? null, lastAttemptAt: last?.attempted_at ?? null, lastSentAt: last?.sent_at ?? null,
      commandStatus: preference.command_status, queueError: this.queueError,
      pending: this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM notification_outbox WHERE status='pending' AND recipient_tag=?", [this.recipientTag])?.count ?? 0,
      setup: {
        stage: !configured ? "not_configured" : preference.command_status === "unavailable" ? "unavailable" : !enabled ? "awaiting_start" : test?.status === "sent" ? "ready" : "awaiting_test",
        enabledAt: configured ? preference.enabled_at : null,
        lastCommandCheckedAt: configured ? preference.last_command_checked_at : null,
        test: test ? summary(test) : null,
      },
      recent: recent.map(summary),
    };
  }

  /** No request-handler exception or transport error is allowed to change an order/payment outcome. */
  async tick(facts: () => NotificationFact[]) {
    try { await this.pollCommands(); await this.flush(facts); } catch { this.queueError = true; }
  }

  async flush(facts: () => NotificationFact[]) {
    if (!this.transport || !this.origin) return;
    if (this.delivering) return this.delivering;
    this.delivering = this.deliver(facts).then(() => { this.queueError = false; }, () => { this.queueError = true; }).finally(() => { this.delivering = null; });
    return this.delivering;
  }

  private async pollCommands() {
    if (!this.transport) return;
    if (this.polling) return this.polling;
    this.polling = this.readCommands().finally(() => { this.polling = null; });
    return this.polling;
  }

  private async readCommands() {
    const updates = await this.transport!.updates(this.preferences().update_offset).catch(() => null);
    this.db.run("UPDATE telegram_settings SET command_status=?,last_command_checked_at=? WHERE id='household'", [updates ? "ready" : "unavailable", this.clock().toISOString()]);
    if (!updates) return;
    for (const update of updates) {
      if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < this.preferences().update_offset) continue;
      const message = update.message;
      // A public demo visitor cannot choose a recipient, toggle another owner's messages, or send arbitrary text.
      if (message?.chat?.type === "private" && String(message.chat.id) === this.chatId && Number.isSafeInteger(message.date) && message.date >= this.preferences().commands_after) {
        const command = /^\/(start|stop|test|status)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(typeof message.text === "string" ? message.text : "")?.[1];
        if (command === "start") {
          if (!this.preferences().enabled) this.db.run("UPDATE telegram_settings SET enabled=1, enabled_at=?,active_session_id=? WHERE id='household'", [this.clock().toISOString(), randomUUID()]);
          this.control(update.update_id, "Notifications are on. I'll report approval requests, confirmed payments, payment problems and food-shortage risks. Routine checks stay quiet.", "start");
        } else if (command === "stop") {
          this.db.run("UPDATE telegram_settings SET enabled=0 WHERE id='household'");
          this.db.run("UPDATE notification_outbox SET status='cancelled',error_code='notifications_disabled' WHERE status='pending' AND kind<>'control'");
          this.control(update.update_id, "Notifications are off. Replenish keeps its order and payment rules. Send /start to enable messages again.", "stop");
        } else if (command === "status") {
          this.control(update.update_id, `Replenish notifications are ${this.preferences().enabled ? "on" : "off"}. Orders and approvals are managed on the website.`);
        } else if (command === "test") {
          const recent = this.db.get("SELECT id FROM notification_outbox WHERE event_key LIKE 'control:test:%' AND recipient_tag=? AND created_at>?", [this.recipientTag, new Date(this.clock().getTime() - 60_000).toISOString()]);
          if (!recent) this.control(update.update_id, "This is a Replenish notification test. No order was created and no payment was made.", "test");
        }
      }
      this.db.run("UPDATE telegram_settings SET update_offset=? WHERE id='household'", [update.update_id + 1]);
    }
  }

  private control(updateId: number, text: string, category = "status") {
    this.enqueue(`control:${category}:${updateId}`, "control", { text, path: "/", button: "Open Replenish", expectedEnabled: Boolean(this.preferences().enabled) });
  }

  private enqueue(key: string, kind: string, payload: unknown) {
    const now = this.clock().toISOString();
    const session = this.preferences().active_session_id;
    this.db.run(`INSERT OR IGNORE INTO notification_outbox (id,event_key,recipient_tag,kind,payload_json,session_id,status,available_at,created_at)
      VALUES (?,?,?,?,?,?,'pending',?,?)`, [`${this.recipientTag}:${key}`, key, this.recipientTag, kind, JSON.stringify(payload), session, now, now]);
    // Re-enabling may resume a still-current alert that was never accepted by Telegram.
    // Sent/unknown events and demo-reset cancellations are never revived.
    this.db.run("UPDATE notification_outbox SET status='pending',available_at=?,created_at=?,session_id=?,error_code=NULL WHERE id=? AND status='cancelled' AND error_code='notifications_disabled' AND attempts<5", [now, now, session, `${this.recipientTag}:${key}`]);
  }

  private async deliver(facts: () => NotificationFact[]) {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - 120_000).toISOString();
    // A prior process may have sent the message before losing its acknowledgement.
    this.db.run("UPDATE notification_outbox SET status='unknown',error_code='acknowledgement_missing' WHERE status='sending' AND attempted_at<=?", [cutoff]);
    let current = this.preferences().enabled ? facts() : [];
    const enabledAt = this.preferences().enabled_at;
    for (const fact of current) {
      if (fact.kind === "paid" && (!enabledAt || fact.occurredAt < enabledAt)) continue;
      this.enqueue(fact.key, fact.kind, fact);
    }
    const last = this.preferences().last_dispatch_at;
    if (last && now.getTime() - Date.parse(last) < 1100) return;
    // The public demo can be reset repeatedly. Bound business alerts independently of polling frequency.
    const recent = this.db.get<{ count: number }>("SELECT COALESCE(SUM(attempts),0) AS count FROM notification_outbox WHERE recipient_tag=? AND kind<>'control' AND attempted_at>?", [this.recipientTag, new Date(now.getTime() - 3_600_000).toISOString()]);
    const limited = (recent?.count ?? 0) >= 30;
    const pending = this.db.all<Pending>("SELECT * FROM notification_outbox WHERE status='pending' AND available_at<=? ORDER BY CASE WHEN kind='control' THEN 0 ELSE 1 END,rowid LIMIT 50", [now.toISOString()]);
    for (const item of pending) {
      const payload = JSON.parse(item.payload_json) as { text: string; path: string; button: string; expectedEnabled?: boolean };
      current = this.preferences().enabled ? facts() : [];
      const valid = item.recipient_tag === this.recipientTag && now.getTime() - Date.parse(item.created_at) < 86_400_000 &&
        (item.kind === "control" ? payload.expectedEnabled === Boolean(this.preferences().enabled) && item.session_id === this.preferences().active_session_id : current.some(fact => fact.key === item.event_key));
      if (!valid) { this.db.run("UPDATE notification_outbox SET status='cancelled' WHERE id=? AND status='pending'", [item.id]); continue; }
      if (limited && item.kind !== "control") continue;
      this.db.run("UPDATE notification_outbox SET status='sending',attempts=attempts+1,attempted_at=? WHERE id=? AND status='pending'", [now.toISOString(), item.id]);
      if (!this.db.get<{ claimed: number }>("SELECT changes() AS claimed")?.claimed) continue;
      this.db.run("UPDATE telegram_settings SET last_dispatch_at=? WHERE id='household'", [now.toISOString()]);
      const destination = new URL(payload.path, this.origin!);
      if (destination.origin !== this.origin) throw new Error("Invalid notification destination");
      const message: TelegramMessage = { text: payload.text, url: destination.toString(), button: payload.button };
      const result = await this.transport!.send(message).catch(() => ({ status: "unknown" as const }));
      if (result.status === "retry" && item.attempts < 4) {
        const delay = Math.max(1, Math.min(result.retryAfterSeconds ?? 60, 86_400));
        this.db.run("UPDATE notification_outbox SET status='pending',available_at=?,error_code='rate_limited' WHERE id=?", [new Date(now.getTime() + delay * 1000).toISOString(), item.id]);
      } else {
        const status = result.status === "retry" ? "failed" : result.status;
        this.db.run("UPDATE notification_outbox SET status=?,sent_at=?,error_code=? WHERE id=?", [status, status === "sent" ? this.clock().toISOString() : null,
          status === "unknown" ? "acknowledgement_missing" : status === "failed" ? "telegram_rejected" : null, item.id]);
      }
      return; // One message per dispatch; Telegram chat flood limits and public demo traffic stay bounded.
    }
  }

  resetDemo() {
    this.db.run("UPDATE notification_outbox SET status='cancelled' WHERE status='pending' AND kind<>'control'");
  }
}
