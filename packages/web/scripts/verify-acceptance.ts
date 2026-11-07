import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { startAcceptance } from "./acceptance-preview.ts";

const preview = await startAcceptance({ slowMs: 1500, intervalMs: 1000 });
const browser = await chromium.launch({ headless: true, channel: process.env.SCREENSHOT_BROWSER_CHANNEL || undefined });
const folder = path.resolve("data/acceptance/evidence"); mkdirSync(folder, { recursive: true });
const results: { scenario: string; checks: string[]; status: string }[] = [];
const errors: string[] = [], external: string[] = [];
const startedAt = new Date().toISOString();
writeFileSync(path.join(folder, "results.json"), JSON.stringify({ status: "running", startedAt, humanAcceptance: "pending" }, null, 2));
async function observe(page: Page) {
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => { const host = new URL(route.request().url()).hostname; if (host === "127.0.0.1") return route.continue(); external.push(host); return route.abort(); });
}
async function send(page: Page, text: string) {
  await page.getByLabel("Message about Qizai").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  return page.getByRole("dialog", { name: "Conversation" });
}
async function screenshot(page: Page, name: string) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(folder, `${name}.png`) });
}
try {
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } }); await observe(page);
  await page.goto(preview.launcherUrl); assert.equal(await page.getByRole("link", { name: "打开本场景" }).count(), 4);
  const normal = preview.cases.find(item => item.id === "normal")!;
  await page.goto(`${normal.url}/?__acceptanceFresh=1`, { waitUntil: "networkidle" });
  assert.equal(normal.app.home().feeding.stockG, 1200);
  let dialog = await send(page, "以后每顿少喂10g");
  await dialog.getByText(/75g → 65g per meal/).waitFor(); assert.equal(normal.app.home().feeding.dailyGrams, 130);
  await screenshot(page, "01-feeding-confirmed");
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await dialog.getByText(/65g → 75g per meal/).waitFor(); assert.equal(normal.app.home().feeding.dailyGrams, 150);
  await dialog.getByRole("button", { name: "Okay", exact: true }).click();
  const reset = await page.request.post(`${preview.launcherUrl}/__acceptance/reset?case=normal`); assert.equal(reset.status(), 200);
  await page.goto(`${normal.url}/?__acceptanceFresh=1`, { waitUntil: "networkidle" });
  const originalPlan = normal.app.home().orderDateRaw;
  dialog = await send(page, "明天晚饭不喂"); await dialog.getByText("Reorder plan: No change", { exact: true }).waitFor();
  assert.equal(normal.app.home().orderDateRaw, originalPlan); await screenshot(page, "02-checked-unchanged");
  results.push({ scenario: "正常操作、撤销和计划不变", checks: ["75→65g / 150→130g", "Undo restores 75g", "independent baseline: skip recorded, order unchanged"], status: "passed" });

  const slow = preview.cases.find(item => item.id === "slow")!;
  await page.goto(`${slow.url}/?__acceptanceFresh=1`, { waitUntil: "networkidle" });
  dialog = await send(page, "以后每顿少喂10g"); await dialog.getByText("Processing your message…", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("Message about Qizai").isDisabled(), true);
  assert.equal(slow.app.home().feeding.gramsPerMeal, 75);
  const pendingReset = await page.request.post(`${preview.launcherUrl}/__acceptance/reset?case=slow`); assert.equal(pendingReset.status(), 409);
  await screenshot(page, "03-slow-pending");
  await dialog.getByRole("button", { name: "Close", exact: true }).click(); await page.getByRole("button", { name: "View request", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Conversation" }); await dialog.getByText(/75g → 65g per meal/).waitFor();
  assert.equal(slow.stats.chatPosts, 1); assert.equal(slow.app.home().feeding.gramsPerMeal, 65);
  results.push({ scenario: "慢请求与重复操作保护", checks: ["pending visible before backend mutation", "input disabled", "reset refused while pending", "close/reopen request", "one POST, one change"], status: "passed" });

  const lost = preview.cases.find(item => item.id === "lost")!;
  await page.goto(`${lost.url}/?__acceptanceFresh=1`, { waitUntil: "networkidle" });
  dialog = await send(page, "以后每顿少喂10g"); await dialog.getByText("This result is not confirmed yet.", { exact: true }).waitFor();
  assert.equal(lost.app.home().feeding.gramsPerMeal, 65); await screenshot(page, "04-response-unconfirmed");
  await page.reload({ waitUntil: "networkidle" });
  dialog = page.getByRole("dialog", { name: "Conversation" }); await dialog.getByText("The saved result was recovered. The request was not repeated.", { exact: true }).waitFor();
  assert.equal(lost.app.home().feeding.gramsPerMeal, 65); assert.equal(lost.stats.chatPosts, 1); assert.equal(lost.stats.dropped, 1);
  await screenshot(page, "05-reloaded-receipt");
  await dialog.getByRole("button", { name: "Okay", exact: true }).click();
  await page.request.post(`${preview.launcherUrl}/__acceptance/reset?case=lost`);
  await page.goto(`${lost.url}/?__acceptanceFresh=1`, { waitUntil: "networkidle" });
  dialog = await send(page, "以后每顿少喂10g"); await dialog.getByText("This result is not confirmed yet.", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Check latest status", exact: true }).click();
  await dialog.getByText("The saved result was recovered. The request was not repeated.", { exact: true }).waitFor();
  assert.equal(lost.app.home().feeding.gramsPerMeal, 65); assert.equal(lost.stats.chatPosts, 1);
  results.push({ scenario: "响应丢失和恢复", checks: ["mutation committed before response loss", "unknown stays distinct from rejection", "reload and manual lookup recover receipt", "one POST, still 65g"], status: "passed" });

  const background = preview.cases.find(item => item.id === "background")!;
  await page.goto(background.url, { waitUntil: "networkidle" });
  const before = background.app.home().agentStatus.lastSucceededAt;
  await page.close();
  await new Promise(resolve => setTimeout(resolve, 2200));
  const after = background.app.home().agentStatus.lastSucceededAt;
  assert.ok(before && after && after > before);
  page = await browser.newPage({ viewport: { width: 390, height: 844 } }); await observe(page);
  await page.goto(background.url, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "View Qizai's details" }).click(); await page.getByRole("button", { name: "Replenishment plan", exact: true }).click();
  const last = page.locator(".detail-rows > div").filter({ has: page.getByText("Last successful check", { exact: true }) }).locator("dd");
  assert.match(await last.innerText(), /\d+:\d{2}:\d{2}/); await screenshot(page, "06-live-agent-status");
  results.push({ scenario: "网页关闭后的后台检查", checks: [`before=${before}`, `after=${after}`, "real setInterval runs without an open page", "UI includes seconds"], status: "passed" });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const report = { status: "passed", startedAt, capturedAt: new Date().toISOString(), source: "local built UI + isolated SQLite + local proxy + real timers", externalCalls: 0, results,
    humanAcceptance: "pending: requires owner to judge clarity of the interaction", screenshots: folder };
  writeFileSync(path.join(folder, "results.json"), JSON.stringify(report, null, 2));
  console.log(`PASS: ${results.length} acceptance groups; mobile layout, live proxy faults and page-closed scheduler verified. Human experience review is pending.`);
} catch (error) {
  writeFileSync(path.join(folder, "results.json"), JSON.stringify({ status: "failed", startedAt, capturedAt: new Date().toISOString(), results, humanAcceptance: "pending", message: error instanceof Error ? error.message.slice(0, 500) : "Verification failed" }, null, 2));
  throw error;
} finally { await browser.close(); await preview.close(); }
