import { describe, expect, it, vi } from "vitest";
import { migrate, SqliteDatabase } from "./db";
import { TelegramNotifications, type NotificationFact } from "./notifications";
import { TelegramClient, type TelegramDelivery, type TelegramMessage, type TelegramUpdate } from "./telegram";
import { HouseholdApp } from "./service";
import { PaymentUnknownError } from "@replenish/agent";

// Deliberately fake credentials. No test contacts Telegram or PayPal.
const env = { TELEGRAM_BOT_TOKEN: "test-only", TELEGRAM_CHAT_ID: "12345", PUBLIC_APP_URL: "https://example.test", TELEGRAM_BOT_USERNAME: "replenish_test_bot" };
function harness(config = env) {
  let now = new Date("2026-11-01T08:00:00Z"), updates: TelegramUpdate[] = [], result: TelegramDelivery = { status: "sent" };
  const db = new SqliteDatabase(":memory:"); migrate(db);
  const send = vi.fn(async (_message: TelegramMessage) => result);
  const transport = { send, updates: vi.fn(async (_offset: number) => updates) };
  const clock = () => now;
  const queue = new TelegramNotifications(db, config, clock, transport);
  let sequence = 0;
  const command = (text: string, chat = 12345, type = "private", date = Math.floor(now.getTime() / 1000)) => { updates = [{ update_id: ++sequence, message: { text, date, chat: { id: chat, type } } }]; };
  const commands = (...texts: string[]) => { updates = texts.map(text => ({ update_id: ++sequence,
    message: { text, date: Math.floor(now.getTime() / 1000), chat: { id: 12345, type: "private" } } })); };
  const step = (seconds = 16) => { now = new Date(now.getTime() + seconds * 1000); };
  const fact: NotificationFact = { key: "approval:order-a:7299", kind: "approval", occurredAt: now.toISOString(), text: "Approval needed", path: "/?order=order-a", button: "Review approval" };
  return { db, queue, transport, send, clock, step, command, commands, fact, setResult: (value: TelegramDelivery) => { result = value; } };
}

describe("owner Telegram notification queue", () => {
  it("does not count or send an old test after same-batch start/test/stop/start at an identical timestamp", async () => {
    const h = harness(); h.commands("/start", "/test", "/stop", "/start");
    await h.queue.tick(() => []);
    expect(h.queue.status().setup).toMatchObject({ stage: "awaiting_test", test: null });
    expect(h.send).toHaveBeenCalledTimes(1);
    h.step(); await h.queue.flush(() => []);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.db.get<{ status: string }>("SELECT status FROM notification_outbox WHERE event_key LIKE 'control:test:%'")?.status).toBe("cancelled");
    h.step(61); h.command("/test"); await h.queue.tick(() => []);
    expect(h.queue.status().setup).toMatchObject({ stage: "ready", test: { status: "sent" } });
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a sent test when stop/start shares its timestamp, and preserves the new session across restart and repeated start", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    h.step(2); h.command("/test"); await h.queue.tick(() => []);
    expect(h.queue.status().setup.stage).toBe("ready");
    h.commands("/stop", "/start"); await h.queue.tick(() => []);
    expect(h.queue.status().setup).toMatchObject({ stage: "awaiting_test", test: null });
    const restarted = new TelegramNotifications(h.db, env, h.clock, h.transport);
    expect(restarted.status().setup).toMatchObject({ stage: "awaiting_test", test: null });
    h.command("/test"); await restarted.tick(() => []);
    expect(restarted.status().setup).toMatchObject({ stage: "awaiting_test", test: null }); // The global one-minute limit still applies.
    h.step(61); h.command("/test"); await restarted.tick(() => []);
    h.step(); await restarted.flush(() => []);
    expect(restarted.status().setup.stage).toBe("ready");
    h.step(); h.command("/start"); await restarted.tick(() => []);
    expect(restarted.status().setup.stage).toBe("ready");
    expect(h.send.mock.calls.filter(([message]) => message.text.includes("No order was created"))).toHaveLength(2);
  });

  it("migrates legacy consent without attributing an unbound historical test to the new session", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    h.step(2); h.command("/test"); await h.queue.tick(() => []);
    const offset = h.db.get<{ update_offset: number }>("SELECT update_offset FROM telegram_settings")!.update_offset;
    h.db.exec("ALTER TABLE telegram_settings DROP COLUMN active_session_id; ALTER TABLE notification_outbox DROP COLUMN session_id");
    migrate(h.db);
    const restarted = new TelegramNotifications(h.db, env, h.clock, h.transport);
    expect(restarted.status()).toMatchObject({ enabled: true, setup: { stage: "awaiting_test", test: null } });
    expect(h.db.get<{ update_offset: number }>("SELECT update_offset FROM telegram_settings")?.update_offset).toBe(offset);
    expect(h.send).toHaveBeenCalledTimes(2);
    h.step(61); h.command("/test"); await restarted.tick(() => []);
    expect(restarted.status().setup.stage).toBe("ready");
    expect(h.send).toHaveBeenCalledTimes(3);
  });

  it.each(["sent", "unknown"] as const)("does not count a delayed old test acknowledgement (%s) after reopening", async status => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    let release!: () => void, observed!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { observed = resolve; });
    h.send.mockImplementationOnce(async () => { observed(); await held; return { status }; });
    h.step(2); h.command("/test"); const testing = h.queue.tick(() => []); await seen;
    h.commands("/stop", "/start"); const reopening = h.queue.tick(() => []);
    await vi.waitFor(() => expect(h.db.get<{ update_offset: number }>("SELECT update_offset FROM telegram_settings")?.update_offset).toBe(5));
    release(); await Promise.all([testing, reopening]);
    expect(h.queue.status().setup).toMatchObject({ stage: "awaiting_test", test: null });
    expect(h.db.get<{ status: string }>("SELECT status FROM notification_outbox WHERE event_key LIKE 'control:test:%'")?.status).toBe(status);
  });

  it("does not put a previous session's same-timestamp business report in the new session's history", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    h.step(2); await h.queue.flush(() => [h.fact]);
    expect(h.queue.status().recent).toHaveLength(1);
    h.commands("/stop", "/start"); await h.queue.tick(() => [h.fact]);
    expect(h.queue.status().recent).toEqual([]);
    h.step(); await h.queue.flush(() => [h.fact]);
    expect(h.send.mock.calls.filter(([message]) => message.text === h.fact.text)).toHaveLength(1);
    h.step(); await h.queue.flush(() => [{ ...h.fact, key: "new-session-business" }]);
    expect(h.queue.status().recent).toHaveLength(1);
  });

  it("shows setup progress only from owner commands and a test accepted after the latest /start", async () => {
    const h = harness();
    expect(h.queue.status().setup).toMatchObject({ stage: "awaiting_start", lastCommandCheckedAt: null, test: null });
    h.command("/start"); await h.queue.tick(() => []);
    expect(h.queue.status()).toMatchObject({ enabled: true, lastOutcome: "sent", setup: { stage: "awaiting_test", test: null } });
    h.step(); h.command("/test"); h.setResult({ status: "unknown" }); await h.queue.tick(() => []);
    expect(h.queue.status().setup).toMatchObject({ stage: "awaiting_test", test: { status: "unknown", acceptedAt: null } });
    const sends = h.send.mock.calls.length;
    h.step(); await h.queue.tick(() => []); expect(h.send).toHaveBeenCalledTimes(sends);
    h.step(61); h.command("/test"); h.setResult({ status: "sent" }); await h.queue.tick(() => []);
    expect(h.queue.status().setup).toMatchObject({ stage: "ready", test: { status: "sent", acceptedAt: h.clock().toISOString() } });
    h.step(); h.command("/stop"); await h.queue.tick(() => []);
    expect(h.queue.status().setup.stage).toBe("awaiting_start");
    h.step(); h.command("/start"); await h.queue.tick(() => []);
    expect(h.queue.status().setup).toMatchObject({ stage: "awaiting_test", test: null });
  });

  it("does not turn opening or refreshing status into a Bot check", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) expect(h.queue.status().setup.lastCommandCheckedAt).toBeNull();
    expect(h.transport.updates).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    await h.queue.tick(() => []); const checked = h.clock().toISOString();
    h.step(); expect(h.queue.status().setup.lastCommandCheckedAt).toBe(checked);
    h.transport.updates.mockRejectedValueOnce(new Error("Simulated unavailable transport"));
    await h.queue.tick(() => []);
    expect(h.queue.status().setup).toMatchObject({ stage: "unavailable", lastCommandCheckedAt: h.clock().toISOString() });
  });

  it("exposes only bounded report summaries, without message payloads or recipient identifiers", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    for (let index = 0; index < 7; index++) { h.step(); await h.queue.flush(() => [{ ...h.fact, key: `private-order-${index}`, text: "private-message-body" }]); }
    const status = h.queue.status();
    expect(status.recent).toHaveLength(5);
    expect(status.recent[0]).toEqual({ kind: "approval", status: "sent", createdAt: h.clock().toISOString(), attemptedAt: h.clock().toISOString(), acceptedAt: h.clock().toISOString() });
    for (const privateValue of [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, "private-order-", "private-message-body", "recipient_tag", "payload_json"]) expect(JSON.stringify(status)).not.toContain(privateValue);
    expect(JSON.stringify(status)).not.toContain(h.db.get<{ active_session_id: string }>("SELECT active_session_id FROM telegram_settings")!.active_session_id);
  });

  it("adds Bot check timestamps without losing an existing owner's consent or deduplication", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    h.step(); await h.queue.flush(() => [h.fact]);
    h.db.exec("ALTER TABLE telegram_settings DROP COLUMN last_command_checked_at");
    migrate(h.db);
    const restarted = new TelegramNotifications(h.db, env, h.clock, h.transport);
    expect(restarted.status()).toMatchObject({ enabled: true, setup: { lastCommandCheckedAt: null } });
    h.step(); await restarted.tick(() => [h.fact]);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(restarted.status().setup.lastCommandCheckedAt).toBe(h.clock().toISOString());
  });

  it("is quiet without configuration or private owner consent and exposes no credentials", async () => {
    const h = harness({ ...env, TELEGRAM_BOT_TOKEN: "" });
    await h.queue.tick(() => [h.fact]);
    expect(h.send).not.toHaveBeenCalled(); expect(h.transport.updates).not.toHaveBeenCalled();
    const configured = harness();
    for (const [chat, type] of [[99999, "private"], [12345, "group"]] as const) {
      configured.command("/start", chat, type); await configured.queue.tick(() => [configured.fact]);
    }
    expect(configured.queue.status().enabled).toBe(false);
    expect(configured.send).not.toHaveBeenCalled();
    configured.command("/start", 12345, "private", 1); await configured.queue.tick(() => [configured.fact]);
    expect(configured.queue.status().enabled).toBe(false);
    const safe = JSON.stringify(configured.queue.status());
    expect(safe).not.toContain(env.TELEGRAM_BOT_TOKEN); expect(safe).not.toContain(env.TELEGRAM_CHAT_ID);
  });

  it("persists consent, offset and deduplication across restart, with precise order links", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => [h.fact]);
    expect(h.queue.status().enabled).toBe(true);
    h.step(); await h.queue.tick(() => [h.fact]);
    expect(h.send.mock.calls[1][0].url).toBe("https://example.test/?order=order-a");
    const restarted = new TelegramNotifications(h.db, env, h.clock, h.transport);
    h.step(); await restarted.tick(() => [h.fact]);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.transport.updates).toHaveBeenLastCalledWith(2);
    // Changing recipient or Bot requires a new explicit opt-in.
    const changed = new TelegramNotifications(h.db, { ...env, TELEGRAM_CHAT_ID: "99999" }, h.clock, h.transport);
    expect(changed.status().enabled).toBe(false);
  });

  it("accepts /test immediately after /start, rate limits it and /stop cancels queued events", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    h.command("/test"); h.step(); await h.queue.tick(() => []);
    expect(h.send.mock.calls[1][0].text).toContain("No order was created");
    h.command("/test"); h.step(); await h.queue.tick(() => []); expect(h.send).toHaveBeenCalledTimes(2);
    h.setResult({ status: "retry", retryAfterSeconds: 60 }); h.step(); await h.queue.flush(() => [h.fact]);
    h.command("/stop"); h.step(); h.setResult({ status: "sent" }); await h.queue.tick(() => [h.fact]);
    expect(h.queue.status().enabled).toBe(false);
    expect(h.db.get<{ status: string }>("SELECT status FROM notification_outbox WHERE kind='approval'")?.status).toBe("cancelled");
    expect(h.send.mock.calls.at(-1)?.[0].text).toContain("Notifications are off");
    h.command("/start"); h.step(); await h.queue.tick(() => [h.fact]);
    h.step(); await h.queue.flush(() => [h.fact]);
    expect(h.send.mock.calls.at(-1)?.[0].text).toBe(h.fact.text);
    const count = h.send.mock.calls.length;
    h.step(); await h.queue.flush(() => [h.fact]); expect(h.send).toHaveBeenCalledTimes(count);
  });

  it("retries only explicit rate limits and cancels alerts that are no longer actionable", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    h.setResult({ status: "retry", retryAfterSeconds: 60 }); h.step(); await h.queue.flush(() => [h.fact]);
    h.step(30); await h.queue.flush(() => [h.fact]); expect(h.send).toHaveBeenCalledTimes(2);
    h.step(31); h.setResult({ status: "sent" }); await h.queue.flush(() => []);
    expect(h.send).toHaveBeenCalledTimes(2);
    const next = { ...h.fact, key: "approval:order-b:7299" };
    await h.queue.flush(() => [next]); expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.queue.status().lastOutcome).toBe("sent");
  });

  it("bounds retry attempts and retains uncertain sends without duplication", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    h.setResult({ status: "retry", retryAfterSeconds: 1 });
    for (let i = 0; i < 7; i++) { h.step(); await h.queue.flush(() => [h.fact]); }
    expect(h.send).toHaveBeenCalledTimes(6); expect(h.queue.status().lastOutcome).toBe("failed");
    const next = { ...h.fact, key: "unknown-send" };
    h.setResult({ status: "unknown" }); h.step(); await h.queue.flush(() => [next]);
    h.step(); await h.queue.flush(() => [next]);
    expect(h.send).toHaveBeenCalledTimes(7); expect(h.queue.status().lastOutcome).toBe("unknown");
  });

  it("recovers an interrupted send as unknown and does not replay old receipts or reset alerts", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    const old = { ...h.fact, key: "old-paid", kind: "paid" as const, occurredAt: "2026-10-01T00:00:00Z" };
    h.step(); await h.queue.flush(() => [old]); expect(h.send).toHaveBeenCalledTimes(1);
    h.setResult({ status: "retry" }); await h.queue.flush(() => [h.fact]);
    h.db.run("UPDATE notification_outbox SET status='sending' WHERE kind='approval'");
    h.step(121); await h.queue.flush(() => [h.fact]);
    expect(h.queue.status().lastOutcome).toBe("unknown"); expect(h.send).toHaveBeenCalledTimes(2);
    const next = { ...h.fact, key: "reset-order" };
    h.step(); await h.queue.flush(() => [next]); h.queue.resetDemo();
    h.step(61); await h.queue.flush(() => []); expect(h.send).toHaveBeenCalledTimes(3);
  });

  it("does not send concurrent duplicates and bounds public demo event bursts", async () => {
    const h = harness(); h.command("/start"); await h.queue.tick(() => []);
    for (let i = 0; i < 35; i++) {
      h.step(); const facts = () => [{ ...h.fact, key: `burst-${i}` }];
      await Promise.all([h.queue.flush(facts), h.queue.flush(facts)]);
    }
    expect(h.send).toHaveBeenCalledTimes(31); // control acknowledgement + 30 business alerts/hour
  });
});

describe("Telegram transport certainty and sanitization", () => {
  const message = { text: "hello", url: "https://example.test/?order=a", button: "View order" };
  it.each([
    [200, { ok: true, result: { message_id: 7 } }, "sent"],
    [200, { ok: true, result: {} }, "unknown"],
    [502, { ok: false }, "unknown"], [403, { ok: false }, "failed"],
    [429, { ok: false, parameters: { retry_after: 9 } }, "retry"], [200, null, "unknown"],
  ])("classifies HTTP %s safely", async (http, body, outcome) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: http }));
    const client = new TelegramClient("test-only", "12345", fetcher as typeof fetch);
    expect((await client.send(message)).status).toBe(outcome);
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.reply_markup.inline_keyboard[0][0].url).toBe(message.url);
    expect(sent.parse_mode).toBeUndefined();
  });
  it("never surfaces raw fetch errors or token-bearing URLs", async () => {
    const client = new TelegramClient("test-only", "12345", vi.fn(async () => { throw new Error("sensitive transport internals"); }) as typeof fetch);
    expect(await client.send(message)).toEqual({ status: "unknown" });
    expect(await client.updates(0)).toBeNull();
  });
});

describe("business event integration", () => {
  function household(outcome: "paid" | "failed" | "unknown" = "paid") {
    const h = harness();
    const app = new HouseholdApp({ db: h.db, env, telegram: h.transport, clock: h.clock, timeZone: "UTC", sku: "RC-SMALL-8", priceCents: 7299,
      payments: { query: async () => "not_found", charge: async () => {
        if (outcome === "failed") throw new Error("Payment declined");
        if (outcome === "unknown") throw new PaymentUnknownError("Simulated lost acknowledgement", "test-order");
        return { paymentId: "test-order", captureId: "test-capture-123456" };
      } } });
    return { ...h, app };
  }
  it.each(["paid", "failed", "unknown"] as const)("reports approval then %s without changing the payment rules", async outcome => {
    const h = household(outcome); h.command("/start"); await h.app.tickNotifications(); h.step();
    await h.app.createOrder(); const created = h.app.orders()[0]; await h.app.deliverNotifications();
    const approval = h.send.mock.calls.at(-1)![0];
    expect(approval.text).toContain("Over your $50 auto-pay limit"); expect(approval.url).toContain(created.id);
    await h.app.approve(created.id, 7299, h.app.orderDetails(created.id).approvalSnapshot); h.step(); await h.app.deliverNotifications();
    expect(h.app.orderDetails(created.id).paymentStatus).toBe(outcome);
    const text = h.send.mock.calls.at(-1)![0].text;
    expect(text).toContain(outcome === "paid" ? "payment is confirmed" : outcome === "unknown" ? "not confirmed" : "could not be completed");
    if (outcome === "paid") { expect(text).toContain("123456"); expect(text).not.toContain("test-capture-"); }
    h.step(); await h.app.deliverNotifications(); expect(h.send).toHaveBeenCalledTimes(3);
  });
  it("reports forecast risk once and a rejected Telegram send cannot change orders", async () => {
    const h = household(); h.command("/start"); await h.app.tickNotifications();
    h.app.calibrate(0); h.step(); await h.app.deliverNotifications();
    expect(h.send.mock.calls.at(-1)![0].text).toContain("may run out before delivery");
    h.step(); await h.app.deliverNotifications(); expect(h.send).toHaveBeenCalledTimes(2);
    await h.app.createOrder(); const order = h.app.orders()[0]; h.setResult({ status: "failed" }); h.step(); await h.app.deliverNotifications();
    expect(h.app.orderDetails(order.id).status).toBe("awaiting_approval");
  });
});
