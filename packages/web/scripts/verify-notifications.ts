import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { SqliteDatabase } from "../../api/src/db.ts";
import { createApiServer } from "../../api/src/http.ts";
import { HouseholdApp } from "../../api/src/service.ts";
import type { TelegramMessage, TelegramUpdate } from "../../api/src/telegram.ts";

// Real built UI, HTTP and SQLite; Telegram/PayPal are injected fakes. No external messages or payments.
let now = new Date("2026-11-01T08:00:00Z"), charges = 0;
const messages: TelegramMessage[] = [];
const updates: TelegramUpdate[] = [{ update_id: 1, message: { text: "/start", date: Math.floor(now.getTime() / 1000), chat: { id: 12345, type: "private" } } }];
const app = new HouseholdApp({ db: new SqliteDatabase(":memory:"), clock: () => now, timeZone: "UTC", sku: "RC-SMALL-8", priceCents: 7299,
  env: { TELEGRAM_BOT_TOKEN: "test-only", TELEGRAM_CHAT_ID: "12345", PUBLIC_APP_URL: "https://example.test", TELEGRAM_BOT_USERNAME: "replenish_ai_bot" },
  telegram: { updates: async offset => updates.filter(update => update.update_id >= offset), send: async message => { messages.push(message); return { status: "sent" }; } },
  payments: { query: async () => "not_found", charge: async () => { charges++; return { paymentId: "simulated-order", captureId: "simulated-capture-123456" }; } },
});
const server = createApiServer(app, { webRoot: path.resolve("packages/web/dist") });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.SCREENSHOT_BROWSER_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.goto(origin + "/paypal", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await page.getByText("Waiting for the owner to turn notifications on.", { exact: true }).waitFor();
  mkdirSync(path.resolve("data/verification"), { recursive: true });
  await page.screenshot({ path: path.resolve("data/verification/telegram-setup-start.png") });
  await page.close();
  // No page is open when the background event and notification are processed.
  await app.tickNotifications(); now = new Date(app.home().plan.plannedOrderAt);
  await app.runDueJobs(); await app.tickNotifications();
  const notification = messages.find(message => message.text.includes("needs your approval")); assert.ok(notification);
  const id = new URL(notification.url).searchParams.get("order")!; assert.ok(id); assert.equal(charges, 0);
  const review = await browser.newPage({ viewport: { width: 390, height: 844 } });
  review.on("pageerror", error => errors.push(error.message));
  await review.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await review.goto(origin + new URL(notification.url).search, { waitUntil: "networkidle" });
  await review.getByRole("dialog", { name: "Order from notification" }).getByText(id, { exact: true }).waitFor();
  assert.equal(await review.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(charges, 0);
  await review.getByRole("button", { name: "Review this approval", exact: true }).click();
  await review.getByRole("button", { name: "Approve $72.99", exact: true }).click();
  await review.getByRole("heading", { name: /food is on the way/ }).waitFor(); assert.equal(charges, 1);
  now = new Date(now.getTime() + 16_000); await app.tickNotifications();
  assert.ok(messages.some(message => message.text.includes("payment is confirmed")));
  now = new Date(now.getTime() + 16_000);
  updates.push({ update_id: 2, message: { text: "/test", date: Math.floor(now.getTime() / 1000), chat: { id: 12345, type: "private" } } });
  await app.tickNotifications(); assert.equal(app.notificationStatus().setup.stage, "ready");
  await review.goto(origin + "/paypal", { waitUntil: "networkidle" });
  await review.getByRole("button", { name: "Notifications", exact: true }).click();
  await review.getByText("Notifications are on.", { exact: true }).waitFor();
  await review.getByRole("list", { name: "Recent Agent reports", exact: true }).getByText("Payment confirmed", { exact: true }).waitFor();
  assert.equal(await review.getByRole("link", { name: "Open Telegram", includeHidden: true }).getAttribute("href"), "https://t.me/replenish_ai_bot");
  assert.equal(await review.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  mkdirSync(path.resolve("data/verification"), { recursive: true });
  await review.screenshot({ path: path.resolve("data/verification/telegram-settings.png") });
  // An old message remains tied to its old order after the next cycle is created.
  app.receive(id); await app.createOrder();
  await review.goto(origin + `/?order=${encodeURIComponent(id)}`, { waitUntil: "networkidle" });
  const old = review.getByRole("dialog", { name: "Order from notification" });
  await old.getByText("delivered", { exact: true }).waitFor();
  assert.equal(await old.getByRole("button", { name: "Review this approval" }).count(), 0);
  assert.equal(charges, 1); assert.deepEqual(errors, []);
  console.log("PASS: notifications without an open page, exact-order links, explicit approval, payment result, stale links and mobile settings (simulated transports).");
} finally {
  await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
