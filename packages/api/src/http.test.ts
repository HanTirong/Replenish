import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatOrderDate } from "@replenish/domain";
import { SqliteDatabase } from "./db";
import { createApiServer, listenPort, reorderIntervalMs } from "./http";
import { HouseholdApp, type PaymentGateway } from "./service";

describe("listen address", () => {
  it("prefers PORT, then API_PORT, then 4781", () => {
    expect(listenPort({ PORT: "10000", API_PORT: "4781" })).toBe(10000);
    expect(listenPort({ API_PORT: "4791" })).toBe(4791);
    expect(listenPort({})).toBe(4781);
    expect(reorderIntervalMs({})).toBe(900_000);
    expect(reorderIntervalMs({ REORDER_INTERVAL_MS: "0" })).toBe(0);
  });
});

describe("receipt route and built web files", () => {
  it("serves the phone app on Windows and receives a paid bag exactly once through HTTP", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "replenish-web-check-"));
    writeFileSync(path.join(root, "index.html"), "<main>Replenish test build</main>");
    const app = new HouseholdApp({
      db: new SqliteDatabase(":memory:"), env: {}, timeZone: "UTC",
      clock: () => new Date("2026-11-01T08:00:00Z"), sku: "RC-SMALL-8", priceCents: 7299,
      payments: { query: async () => "not_found", charge: async () => ({ paymentId: "isolated-payment" }) },
    });
    const server = createApiServer(app, { webRoot: root });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const index = await fetch(base);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("Replenish test build");
      expect((await fetch(`${base}/paypal`)).status).toBe(200);
      const pending = (await app.reorderNow()).pendingApproval;
      if (!pending) throw new Error("Missing order");
      const receiveUrl = `${base}/v1/orders/${pending.orderId}/receive`;
      expect((await fetch(receiveUrl, { method: "POST" })).status).toBe(400);
      await app.approve(pending.orderId, 7299, app.orderDetails(pending.orderId).approvalSnapshot);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(receiveUrl, { method: "POST" });
        expect(response.status).toBe(200);
        const body = await response.json() as { feeding: { stockG: number }; order: null };
        expect(body.feeding.stockG).toBe(9200);
        expect(body.order).toBeNull();
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("GET /v1/home and POST /v1/chat", () => {
  it("updates stock and feeding through their HTTP routes and exposes budget and activity details", async () => {
    const app = new HouseholdApp({ db: new SqliteDatabase(":memory:"), env: {}, timeZone: "UTC",
      clock: () => new Date("2026-11-01T08:00:00Z"),
      payments: { query: async () => "not_found", charge: async () => ({ paymentId: "test-payment" }) } });
    const server = createApiServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${address.port}`;
    const change = (endpoint: string, method: string, body: unknown) => fetch(`${base}${endpoint}`, { method,
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await change("/v1/feeding/calibrate", "POST", { stockG: -1 })).status).toBe(400);
      expect((await change("/v1/feeding/calibrate", "POST", { stockG: "900" })).status).toBe(400);
      expect((await change("/v1/feeding/calibrate", "POST", { stockG: 900 })).status).toBe(200);
      expect((await change("/v1/feeding", "PUT", { gramsPerMeal: 65 })).status).toBe(200);
      expect(app.home().feeding).toMatchObject({ stockG: 900, dailyGrams: 130 });
      expect((await change("/v1/budget", "PUT", { perOrderLimitCents: 0.5 })).status).toBe(400);
      expect((await (await fetch(`${base}/v1/budget`)).json() as { monthRemainingCents: number }).monthRemainingCents).toBe(12000);
      const activities = await (await fetch(`${base}/v1/activity`)).json() as { kind: string; summary: string }[];
      expect(activities.some(item => item.kind === "stock" && item.summary.includes("900g"))).toBe(true);
      expect((await change("/v1/feeding/undo", "POST", { expectedRevisionId: app.home().undoRevisionId })).status).toBe(200);
      expect(app.home().feeding.gramsPerMeal).toBe(75);
      expect(app.home().feeding.stockG).toBe(900);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it("returns the dated reason strings and the raw reorder instant", async () => {
    const payments: PaymentGateway = {
      async charge() {
        return { paymentId: "pay_test" };
      },
      async query() {
        return "not_found";
      },
    };
    const asOf = new Date("2026-11-01T08:00:00.000Z");
    const app = new HouseholdApp({
      db: new SqliteDatabase(":memory:"),
      clock: () => asOf,
      payments,
      timeZone: "America/Los_Angeles",
      env: {},
    });
    const maintenanceToken = randomUUID();
    const server: Server = createApiServer(app, { maintenanceToken });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const home = (await (await fetch(`${base}/v1/home`)).json()) as {
        reason: string;
        orderDate: string;
        orderDateRaw: string;
      };
      const local = formatOrderDate(new Date(home.orderDateRaw), "America/Los_Angeles");
      expect(home.orderDate).toBe(local);
      expect(home.reason).toBe(`I'll reorder on ${local} so it arrives before food runs out.`);

      const chat = (await (
        await fetch(`${base}/v1/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "明天晚饭不喂" }),
        })
      ).json()) as { headline: string; reason: string; decision: { orderDate: string; orderDateRaw: string; planChanged: boolean } };
      expect(chat.headline).toBe("Noted. Qizai skips dinner tomorrow.");
      expect(chat.reason).toBe(`That's half a day of food, so the reorder date stays ${chat.decision.orderDate}.`);
      expect(chat.decision.planChanged).toBe(false);
      expect(chat.decision.orderDateRaw).toBe(home.orderDateRaw);

      const triggered = await fetch(`${base}/v1/demo/reorder-now`, { method: "POST", headers: { authorization: `Bearer ${maintenanceToken}` } });
      const demo = (await triggered.json()) as {
        pendingApproval: { totalCents: number } | null;
        reason: string;
      };
      expect(triggered.status).toBe(200);
      expect(demo.pendingApproval?.totalCents).toBe(3500);
      expect(demo.reason).not.toMatch(/per-order limit/i);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
