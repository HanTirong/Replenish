import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { MockPaymentProvider, PaymentUnknownError } from "../../agent/src/payments.ts";
import { SqliteDatabase } from "../../api/src/db.ts";
import { createApiServer, gatewayFromProvider } from "../../api/src/http.ts";
import { HouseholdApp } from "../../api/src/service.ts";

// Real built UI + real HTTP/SQLite, controlled clock and simulated payments.
// Deliberately pass env: {} and use no external merchant, AI or PayPal service.
const servers: Server[] = [];
const pauseDelayMs = Number(process.env.VERIFY_PAUSE_DELAY_MS ?? 0);
assert.ok(Number.isSafeInteger(pauseDelayMs) && pauseDelayMs >= 0 && pauseDelayMs <= 10_000);
async function serve(app: HouseholdApp, maintenanceToken?: string) {
  const server = createApiServer(app, { webRoot: path.resolve("packages/web/dist"), maintenanceToken });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const browser = await chromium.launch({ headless: true, channel: process.env.SCREENSHOT_BROWSER_CHANNEL || undefined });
try {
  let now = new Date("2026-11-01T08:00:00Z");
  const provider = new MockPaymentProvider();
  const app = new HouseholdApp({ db: new SqliteDatabase(":memory:"), env: {}, timeZone: "UTC", clock: () => new Date(now),
    sku: "RC-SMALL-8", priceCents: 7299, payments: gatewayFromProvider(provider),
    vault: { hasPaymentToken: () => true, summary: () => ({ connected: true, last4: "1881" }) } });
  app.authorizePaypal();
  const origin = await serve(app);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "View Qizai's details" }).click();
  await page.getByLabel("New grams per meal").fill("65");
  await page.getByRole("button", { name: "Save feeding plan", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Feeding plan saved" }).waitFor();
  assert.equal(app.home().feeding.dailyGrams, 130);
  await page.getByLabel("Food remaining in the bag (g)").fill("900");
  await page.getByRole("button", { name: "Calibrate stock", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Stock calibrated" }).waitFor();
  assert.equal(app.home().feeding.stockG, 900);
  for (const expected of [65, 75]) {
    await page.getByRole("button", { name: "Undo last feeding change" }).click();
    await page.getByRole("status").filter({ hasText: "undone" }).waitFor();
    assert.equal(app.home().feeding.gramsPerMeal, expected);
  }
  assert.equal(app.home().feeding.stockG, 1200);
  await page.getByRole("button", { name: "Budget details", exact: true }).click();
  await page.getByLabel("Per-order auto-pay limit ($)").fill("80");
  await page.getByRole("button", { name: "Save limits", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Spending limits saved" }).waitFor();
  assert.equal(app.budget().perOrderLimitCents, 8000);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".tile.order").click();
  await page.getByText("Store shipping time", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  for (let cycle = 0; cycle < 2; cycle++) {
    const plan = app.home().plan;
    now = new Date(plan.plannedOrderAt);
    await app.runDueJobs();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("heading", { name: /food is on the way/ }).waitFor();
    assert.equal(provider.charges.length, cycle + 1);
    await page.getByRole("button", { name: "The test-store order is confirmed; delivery is estimated." }).click();
    await page.getByRole("dialog", { name: "Qizai's food order" }).waitFor();
    now = new Date(plan.estimatedDeliveryAt);
    const before = app.home().feeding.stockG;
    await page.getByRole("button", { name: "Food received", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(app.home().feeding.stockG, before + 8000);
  }
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await page.getByRole("button", { name: "Pause autopilot", exact: true }).click();
  await page.getByRole("button", { name: "Paused", exact: true }).click();
  await page.getByRole("button", { name: "Resume autopilot", exact: true }).click();
  await page.getByRole("button", { name: "Active", exact: true }).waitFor();
  await page.getByRole("button", { name: "View Qizai's details" }).click();
  await page.getByRole("button", { name: "Recent activity", exact: true }).click();
  await page.getByText("Resumed automatic buying", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  let verified = false, charges = 0;
  const recovery = new HouseholdApp({ db: new SqliteDatabase(":memory:"), env: {}, timeZone: "UTC",
    clock: () => new Date("2026-11-01T08:00:00Z"), sku: "RC-SMALL-8", priceCents: 7299,
    payments: { query: async () => "not_found", lookup: async () => verified
      ? { status: "paid", paymentId: "SIMULATED-ORDER", captureId: "SIMULATED-CAPTURE" } : { status: "not_found" },
    charge: async () => { charges++; throw new PaymentUnknownError("Simulated lost response", "test-payment"); } } });
  const pending = (await recovery.reorderNow()).pendingApproval!;
  const recoveryOrigin = await serve(recovery);
  await page.goto(recoveryOrigin, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Approve $72.99", exact: true }).click();
  await page.getByRole("button", { name: "Check payment status", exact: true }).waitFor();
  assert.equal(recovery.home().state, "reconciling");
  verified = true;
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await page.getByRole("heading", { name: /food is on the way/ }).waitFor();
  assert.equal(recovery.home().order?.id, pending.orderId);
  assert.equal(charges, 1);
  await page.getByRole("button", { name: /Paid with PayPal/ }).click();
  await page.getByRole("button", { name: "View order", exact: true }).click();
  await page.getByRole("dialog", { name: "Qizai's food order" }).waitFor();
  assert.equal(errors.length, 0);

  // Public snapshot fields cannot authorize a write. The owner must supply a code separately.
  const operatorCode = randomUUID(), attemptId = randomUUID();
  let recoveries = 0;
  const protectedRecovery = new HouseholdApp({ db: new SqliteDatabase(":memory:"), env: {}, timeZone: "UTC",
    clock: () => new Date("2026-11-01T08:00:00Z"), sku: "RC-SMALL-8", priceCents: 7299,
    vault: { hasPaymentToken: () => true }, payments: {
      charge: async () => { throw new PaymentUnknownError("Simulated original response loss", "original-payment"); },
      query: async () => "not_found", recoveryInfo: () => ({ attemptId, recoverable: true }),
      recover: async (_request, expectedAttempt, guard) => {
        assert.equal(expectedAttempt, attemptId); guard(); recoveries++;
        return { status: "paid", attemptId, paymentId: "SIMULATED-RECOVERY", captureId: "SIMULATED-CAPTURE" };
      },
    } });
  const draft = (await protectedRecovery.reorderNow()).pendingApproval!;
  await protectedRecovery.approve(draft.orderId, draft.totalCents, draft.approvalSnapshot);
  const protectedOrigin = await serve(protectedRecovery, operatorCode);
  const publicHome = await (await fetch(`${protectedOrigin}/v1/home`)).json();
  const recoveryBody = { expectedTotalCents: publicHome.paymentRecovery.totalCents,
    approvalSnapshot: publicHome.paymentRecovery.approvalSnapshot, expectedAttemptId: publicHome.paymentRecovery.attemptId };
  const refused = await fetch(`${protectedOrigin}/v1/orders/${draft.orderId}/recover-payment`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(recoveryBody) });
  assert.equal(refused.status, 403); assert.equal(recoveries, 0);
  page.on("request", request => {
    if (!request.url().endsWith("/recover-payment")) return;
    assert.equal(request.headers().authorization, `Bearer ${operatorCode}`);
    assert.ok(!request.url().includes(operatorCode)); assert.ok(!request.postData()?.includes(operatorCode));
  });
  await page.goto(protectedOrigin, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Recover original payment request", exact: true }).click();
  const confirmRecovery = page.getByRole("button", { name: "Confirm recovery of original payment", exact: true });
  assert.equal(await confirmRecovery.isDisabled(), true);
  const accessCode = page.getByLabel("Owner recovery access code", { exact: true });
  assert.equal(await accessCode.getAttribute("type"), "password");
  await accessCode.fill(operatorCode); await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(recoveries, 0);
  await page.getByRole("button", { name: "Recover original payment request", exact: true }).click();
  assert.equal(await accessCode.inputValue(), "");
  await accessCode.fill(operatorCode);
  await confirmRecovery.click();
  await page.getByRole("heading", { name: /food is on the way/ }).waitFor();
  assert.equal(recoveries, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(!(await page.evaluate(() => sessionStorage.getItem("replenish.pending-operation.v1")))?.includes(operatorCode));

  let pauseNow = new Date("2026-10-31T23:00:00Z");
  const timedProvider = new MockPaymentProvider();
  const timed = new HouseholdApp({ db: new SqliteDatabase(":memory:"), env: {}, timeZone: "America/Los_Angeles", clock: () => pauseNow,
    sku: "RC-SMALL-8", priceCents: 7299, payments: gatewayFromProvider(timedProvider), vault: { hasPaymentToken: () => true } });
  timed.authorizePaypal(); const timedOrigin = await serve(timed);
  await page.goto(timedOrigin, { waitUntil: "networkidle" });
  await page.getByLabel("Message about Qizai").fill("暂停到11月2日");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText(/2026-11-02 at 00:00 \(America\/Los_Angeles\)/).first().waitFor();
  await page.getByRole("button", { name: "Okay", exact: true }).click();
  await page.getByRole("button", { name: "Paused", exact: true }).click();
  await page.getByRole("button", { name: "Keep paused until I resume", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  mkdirSync(path.resolve("data/verification"), { recursive: true });
  await page.screenshot({ path: path.resolve("data/verification/timed-pause.png") });
  let pauseCommitted = Promise.resolve();
  let releasePauseResponse = () => {};
  if (pauseDelayMs) {
    let markCommitted = () => {};
    pauseCommitted = new Promise<void>(resolve => { markCommitted = resolve; });
    const inspectedPending = new Promise<void>(resolve => { releasePauseResponse = resolve; });
    await page.route("**/v1/autopilot/pause", async route => {
      const response = await route.fetch();
      markCommitted();
      await inspectedPending;
      await new Promise(resolve => setTimeout(resolve, pauseDelayMs));
      await route.fulfill({ response });
    });
  }
  const pauseResponse = page.waitForResponse(response => response.url() === `${timedOrigin}/v1/autopilot/pause` && response.request().method() === "POST");
  await page.getByRole("button", { name: "Keep paused until I resume", exact: true }).click();
  if (pauseDelayMs) {
    try {
      await page.getByRole("status").filter({ hasText: "Keeping automatic buying paused" }).waitFor();
      await pauseCommitted;
      // Backend has saved, but the browser must stay pending until its delayed acknowledgement arrives.
      assert.equal(timed.home().autopilotResumeAt, null);
      assert.equal(await page.getByRole("button", { name: "Keep paused until I resume", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("status").filter({ hasText: "The resume deadline was cancelled" }).count(), 0);
    } finally { releasePauseResponse(); }
  }
  assert.equal((await pauseResponse).status(), 200);
  await page.getByRole("status").filter({ hasText: "The resume deadline was cancelled" }).waitFor();
  assert.equal(timed.home().autopilotResumeAt, null);
  pauseNow = new Date("2026-11-02T08:00:00Z"); await timed.runDueJobs();
  assert.equal(timed.home().autopilot, "paused"); assert.equal(timedProvider.charges.length, 0);
  await timed.chat("暂停到11月6日");
  await page.goto(timedOrigin, { waitUntil: "networkidle" }); await page.close();
  pauseNow = new Date("2026-11-06T08:00:00Z"); await timed.runDueJobs();
  assert.equal(timed.home().autopilot, "active"); assert.ok(timed.home().pendingApproval); assert.equal(timedProvider.charges.length, 0);
  const reopened = await browser.newPage({ viewport: { width: 390, height: 844 } });
  reopened.on("pageerror", error => errors.push(error.message));
  await reopened.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await reopened.goto(timedOrigin, { waitUntil: "networkidle" });
  await reopened.getByRole("button", { name: "Approve $72.99", exact: true }).waitFor();
  assert.equal(errors.length, 0);
  console.log(`Built UI verified at 390x844: feeding, calibration/Undo, plan/budget/activity, two mock-payment/receipt cycles, payment recovery, dated pause, manual override and automatic resumption with the page closed. Pause response delay: ${pauseDelayMs}ms. Zero external calls.`);
} finally {
  await browser.close();
  for (const server of servers) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
