import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium, devices, type Page } from "playwright";
import { SqliteDatabase } from "../../api/src/db.ts";
import { createApiServer } from "../../api/src/http.ts";
import { HouseholdApp } from "../../api/src/service.ts";

// Mobile emulation checks layout and input sizing; it does not certify physical iOS keyboard behavior.
const app = new HouseholdApp({ db: new SqliteDatabase(":memory:"), env: {}, timeZone: "UTC",
  clock: () => new Date("2026-11-01T08:00:00Z"),
  payments: { query: async () => "not_found", charge: async () => { throw new Error("No payment allowed in mobile verification"); } } });
const server = createApiServer(app, { webRoot: path.resolve("packages/web/dist") });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const folder = path.resolve("data/mobile-verification");
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.SCREENSHOT_BROWSER_CHANNEL || undefined });
const results: unknown[] = [], errors: string[] = [];
async function inspect(page: Page) {
  return page.evaluate(() => {
    const screen = document.querySelector(".screen")!.getBoundingClientRect();
    const composer = document.querySelector(".composer")!.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      screenWidth: screen.width, composerLeft: composer.left, composerRight: composer.right, composerBottom: composer.bottom,
      inputFonts: [...document.querySelectorAll("input")].map(input => Number.parseFloat(getComputedStyle(input).fontSize)),
      scale: visualViewport?.scale ?? 1, viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") };
  });
}
try {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
    const context = await browser.newContext({ ...devices["iPhone 13"], viewport });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto(origin, { waitUntil: "networkidle" });
    const initial = await inspect(page);
    assert.equal(initial.width, viewport.width);
    assert.equal(initial.documentWidth, viewport.width);
    assert.equal(initial.screenWidth, viewport.width);
    assert.ok(initial.composerLeft >= 0 && initial.composerRight <= viewport.width && initial.composerBottom <= initial.height);
    assert.ok(initial.inputFonts.every(font => font >= 16));
    assert.equal(initial.scale, 1);
    assert.match(initial.viewport ?? "", /width=device-width/);
    assert.doesNotMatch(initial.viewport ?? "", /user-scalable\s*=\s*(no|0)|maximum-scale/);
    await page.getByLabel("Message about Qizai").focus();
    assert.equal((await inspect(page)).scale, 1);
    await page.screenshot({ path: path.join(folder, `home-${viewport.width}.png`) });
    // Exercise a smaller browser viewport without claiming to emulate an actual iOS keyboard.
    await page.setViewportSize({ width: viewport.width, height: 360 });
    const resized = await inspect(page);
    assert.equal(resized.documentWidth, viewport.width);
    assert.ok(resized.composerBottom <= resized.height);
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "View Qizai's details" }).click();
    for (const font of await page.locator("input").evaluateAll(inputs => inputs.map(input => Number.parseFloat(getComputedStyle(input).fontSize)))) assert.ok(font >= 16);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    results.push({ viewport, initial, resized });
    if (viewport.width === 390) {
      await page.getByLabel("Message about Qizai").fill("he is eating 85g a day now");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const conversation = page.getByRole("dialog", { name: "Conversation" });
      await conversation.getByText(/No change saved/).waitFor();
      assert.equal(app.home().feeding.dailyGrams, 150);
      assert.equal((await inspect(page)).documentWidth, viewport.width);
      await conversation.getByLabel("Message about Qizai").fill("确认每天共85克");
      await conversation.getByRole("button", { name: "Send", exact: true }).click();
      await conversation.getByText(/75g → 42.5g per meal/).waitFor();
      assert.equal(app.home().feeding.dailyGrams, 85);
      assert.equal((await inspect(page)).documentWidth, viewport.width);
      await page.screenshot({ path: path.join(folder, "confirmation-390.png") });
      await conversation.getByRole("button", { name: "Undo", exact: true }).click();
      await conversation.getByText(/42.5g → 75g per meal/).waitFor();
      assert.equal(app.home().feeding.dailyGrams, 150);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(folder, "results.json"), JSON.stringify({ ok: true, engine: "Chromium mobile emulation", realIphoneVerified: false, results }, null, 2));
  console.log("PASS: 320/390/430px mobile viewports, unzoomed layout, 16px inputs, viewport resize, confirmation synonyms and Undo. Physical iPhone Safari still needs owner confirmation. No external calls.");
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
