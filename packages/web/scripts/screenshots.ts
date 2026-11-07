import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startApi } from "../../api/src/http.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../screenshots");
const shots = [
  ["1", "1-home-scheduled"],
  ["2", "2-chat-skip-dinner"],
  ["3", "3-home-unchanged"],
  ["4", "4-approval"],
  ["5", "5-paypal-not-connected"],
  ["6", "6-paypal-connected-not-authorized"],
  ["7", "7-paypal-authorized"],
] as const;

const port = Number(process.env.SCREENSHOT_PORT ?? 4793);
const base = process.env.SCREENSHOT_URL ?? `http://127.0.0.1:${port}`;

mkdirSync(outDir, { recursive: true });
const server = process.env.SCREENSHOT_URL
  ? null
  : await startApi({
      API_PORT: String(port),
      API_HOST: "127.0.0.1",
      SQLITE_PATH: "/tmp/replenish-screenshots.sqlite",
      PAYMENT_PROVIDER: "mock",
    });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
try {
  for (const [id, name] of shots) {
    await page.goto(`${base}/shots/${id}`, { waitUntil: "networkidle" });
    await page.locator(`[data-screen="${id}"]`).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(file);
  }
} finally {
  await browser.close();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
