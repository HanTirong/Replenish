import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium, devices, type Page } from "playwright";
import { SqliteDatabase } from "../../api/src/db.ts";
import { createApiServer } from "../../api/src/http.ts";
import { HouseholdApp } from "../../api/src/service.ts";

const app = new HouseholdApp({ db: new SqliteDatabase(":memory:"), env: {}, timeZone: "UTC",
  clock: () => new Date("2026-11-02T08:00:00Z"),
  payments: { query: async () => "not_found", charge: async () => { throw new Error("Payments are forbidden in guide verification"); } } });
const server = createApiServer(app, { webRoot: path.resolve("packages/web/dist") });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.SCREENSHOT_BROWSER_CHANNEL || undefined });
const folder = path.resolve("data/guide-verification");
mkdirSync(folder, { recursive: true });
async function checkHighlight(page: Page) {
  assert.ok(await page.locator(".guide-spot.active > .guide-target").evaluate(wrapper => {
    const target = wrapper.firstElementChild!;
    const border = getComputedStyle(target), surrounding = getComputedStyle(wrapper);
    return border.outlineStyle === "solid" && border.outlineWidth === "2px" && border.outlineOffset === "-2px" && surrounding.outlineStyle === "none";
  }), "Highlight must follow the real target, excluding its outside margin and preserving its corner radius");
}
try {
  for (const width of [320, 390, 430]) {
    const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width, height: 844 } });
    const page = await context.newPage();
    const errors: string[] = [], writes: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() !== "GET") writes.push(request.url()); });
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Show me around", exact: true }).click();
    await page.getByLabel("Tap Qizai", { exact: true }).waitFor();
    await checkHighlight(page);
    await page.getByRole("button", { name: "View Qizai's details" }).click();
    await checkHighlight(page);
    await page.screenshot({ path: path.join(folder, `food-details-${width}.png`) });
    await page.getByRole("button", { name: "Show other places" }).click();
    await checkHighlight(page);
    for (const title of ["Replenishment plan", "Budget details", "Recent activity", "Notifications"]) {
      await page.getByRole("button", { name: title, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await dialog.getByRole("button", { name: "Got it", exact: true }).waitFor();
      await checkHighlight(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    }
    await page.getByRole("button", { name: "Go to message box" }).click();
    await page.getByRole("button", { name: "Use example", exact: true }).click();
    assert.equal(await page.getByLabel("Message about Qizai").inputValue(), "Feed 10g less per meal from now on.");
    assert.deepEqual(writes, []);
    const tip = await page.getByLabel("Tell me what changed", { exact: true }).boundingBox();
    const composer = await page.locator(".composer").boundingBox();
    assert.ok(tip && composer && tip.y + tip.height <= composer.y, "The hint must not cover the input");
    await page.screenshot({ path: path.join(folder, `draft-${width}.png`) });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByLabel("Check what changed", { exact: true }).waitFor();
    await checkHighlight(page);
    assert.equal(app.home().feeding.gramsPerMeal, width === 320 ? 65 : width === 390 ? 55 : 45);
    await page.getByRole("button", { name: "Show Undo" }).click();
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    assert.ok((await undo.getAttribute("class"))?.includes("guide-highlight"));
    assert.ok(await page.getByLabel("Undo is optional", { exact: true }).evaluate(tip => {
      const button = tip.parentElement!.querySelector("button.guide-highlight")!.getBoundingClientRect();
      const pointer = tip.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(tip, "::before").left) + 6;
      return pointer >= button.left && pointer <= button.right;
    }), "The pointer must point to Undo, not Okay");
    await undo.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(folder, `undo-${width}.png`) });
    const stock = app.home().feeding.stockG;
    await page.getByRole("button", { name: "Finish tour" }).click();
    assert.equal(writes.length, 1, "Only the user's explicit Send can write");
    assert.equal(app.home().feeding.stockG, stock);
    await page.getByRole("button", { name: "Okay", exact: true }).click();
    await page.getByRole("button", { name: "Show me around", exact: true }).scrollIntoViewIfNeeded();
    assert.ok(await page.locator(".screen").evaluate(screen => {
      const notice = screen.querySelector<HTMLElement>(".home-notice")!, entry = screen.querySelector<HTMLElement>(".guide-entry")!;
      const composer = screen.querySelector<HTMLElement>(".composer")!;
      const a = notice.getBoundingClientRect(), b = entry.getBoundingClientRect(), c = composer.getBoundingClientRect();
      return getComputedStyle(notice).position === "static" && a.bottom <= b.top && b.bottom <= c.top;
    }), "Saved feedback, Show me around and the input must not overlap");
    await page.screenshot({ path: path.join(folder, `home-feedback-${width}.png`) });
    await page.reload();
    assert.equal(await page.getByRole("button", { name: "Dismiss first-visit hint" }).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS: guide at 320/390/430px, real target borders, no feedback/entry/input overlap, four destinations, draft-only example and optional Undo; no unintended writes or external calls.");
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
