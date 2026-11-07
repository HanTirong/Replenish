import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { MockPaymentProvider } from "../../agent/src/payments.ts";
import { SqliteDatabase } from "../../api/src/db.ts";
import { createApiServer, gatewayFromProvider } from "../../api/src/http.ts";
import { HouseholdApp } from "../../api/src/service.ts";

// Isolated runtime captures: no process.env is passed to the app and no payment
// is submitted. Use the live Sandbox recording separately for payment evidence.
const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, "../../../data/submission-screenshots");
const fixedTime = "2026-11-01T08:00:00.000Z";
const payments = new MockPaymentProvider();
const app = new HouseholdApp({
  db: new SqliteDatabase(":memory:"),
  clock: () => new Date(fixedTime),
  timeZone: "UTC",
  sku: "RC-SMALL-8",
  priceCents: 7299,
  env: {},
  payments: gatewayFromProvider(payments),
  vault: { hasPaymentToken: () => false },
});
const maintenanceToken = randomUUID();
const api = createApiServer(app, { maintenanceToken });
let vite: ViteDevServer | undefined;
let browser: Browser | undefined;
mkdirSync(output, { recursive: true });

async function capture(page: Page, filename: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, filename) });
}

try {
  await new Promise<void>((resolve, reject) => {
    api.once("error", reject);
    api.listen(0, "127.0.0.1", () => resolve());
  });
  const apiOrigin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  vite = await createViteServer({
    configFile: path.resolve(here, "../vite.config.ts"),
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: { "/v1": { target: apiOrigin } },
    },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.SCREENSHOT_BROWSER_CHANNEL || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const baseline = app.home();

  async function reset() {
    const response = await page.request.post(`${origin}/v1/demo/reset`, { headers: { authorization: `Bearer ${maintenanceToken}` } });
    assert.equal(response.status(), 200);
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: /Qizai has about/ }).waitFor();
  }

  await reset();
  await capture(page, "01-home.png");

  await page.getByRole("textbox").fill("Feed him 10g less per meal from now on");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Reorder plan updated", { exact: true }).waitFor();
  const lighter = app.home();
  assert.equal(lighter.feeding.gramsPerMeal, 65);
  assert.equal(lighter.feeding.dailyGrams, 130);
  const lighterDeltaHours = (Date.parse(lighter.orderDateRaw) - Date.parse(baseline.orderDateRaw)) / 3_600_000;
  assert.ok(Math.abs(lighterDeltaHours - 29.5384615385) < 0.001);
  await capture(page, "02-feeding-change.png");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("heading", { name: /Qizai has about/ }).waitFor();
  assert.equal(app.home().feeding.gramsPerMeal, 75);
  assert.equal(app.home().orderDateRaw, baseline.orderDateRaw);

  await reset();
  await page.getByRole("textbox").fill("Skip Qizai's dinner tomorrow");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Reorder plan: No change", { exact: true }).waitFor();
  const skipped = app.home();
  assert.equal(skipped.orderDateRaw, baseline.orderDateRaw);
  assert.equal(skipped.plan.planChanged, false);
  await capture(page, "03-plan-unchanged.png");
  await page.getByRole("button", { name: "Okay", exact: true }).click();
  await page.getByRole("button", { name: "View Qizai's details" }).click();
  await page.getByRole("button", { name: "Recent activity", exact: true }).click();
  await page.getByRole("dialog", { name: "Recent activity" }).waitFor();
  await page.getByText("Order date:", { exact: false }).first().waitFor();
  await capture(page, "09-activity.png");

  await reset();
  // Fixture setup is in-process; the public maintenance route requires operator authorization.
  await app.reorderNow();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Approve $72.99", exact: true }).waitFor();
  const approval = app.home();
  assert.equal(approval.pendingApproval?.totalCents, 7299);
  assert.deepEqual(approval.pendingApproval.violations.map((v) => v.code), ["per_order"]);
  assert.equal(approval.pendingApproval.violations[0]?.overByCents, 2299);
  assert.equal(approval.payment, null);
  assert.equal(payments.charges.length, 0);
  await capture(page, "04-approval.png");

  await reset();
  await page.goto(`${origin}/paypal`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect PayPal", exact: true }).waitFor();
  await capture(page, "05-paypal-connect.png");

  await reset();
  await page.getByRole("button", { name: "View Qizai's details" }).click();
  await page.getByRole("dialog", { name: "Qizai's details" }).waitFor();
  await capture(page, "06-pet-details.png");
  await page.getByRole("button", { name: "Budget details", exact: true }).click();
  await page.getByText("Settled this month", { exact: true }).waitFor();
  await capture(page, "08-budget.png");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".tile.order").click();
  await page.getByRole("dialog", { name: "Replenishment plan" }).waitFor();
  await capture(page, "07-plan-details.png");

  writeFileSync(path.join(output, "capture-evidence.json"), JSON.stringify({
    clock: fixedTime,
    timezone: "UTC",
    viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    environment: "local in-memory SQLite, rule parser, mock payments; no external AI or PayPal calls",
    baseline: { feeding: baseline.feeding, plannedOrderAt: baseline.orderDateRaw },
    feedingChange: { feeding: lighter.feeding, plannedOrderAt: lighter.orderDateRaw, deltaHours: lighterDeltaHours },
    undo: "restored 75 g per meal and the original planned order timestamp",
    skippedDinner: { plannedOrderAt: skipped.orderDateRaw, planChanged: skipped.plan.planChanged },
    approval: { totalCents: approval.pendingApproval.totalCents, violations: approval.pendingApproval.violations },
    paymentAttempts: payments.charges.length,
    sandboxPaymentEvidence: false,
    detailScreens: ["06-pet-details.png", "07-plan-details.png", "08-budget.png", "09-activity.png"],
  }, null, 2) + "\n");
  console.log("Saved nine runtime screenshots; feeding, Undo, approval and detail views passed; zero payment attempts.");
} finally {
  await browser?.close();
  await vite?.close();
  if (api.listening) await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
}
