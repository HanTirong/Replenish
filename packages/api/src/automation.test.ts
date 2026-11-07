import { describe, expect, it, vi } from "vitest";
import { MockPaymentProvider, PaymentUnknownError } from "@replenish/agent";
import { SqliteDatabase } from "./db";
import { gatewayFromProvider } from "./http";
import { HouseholdApp, type PaymentGateway } from "./service";

function household(payments?: PaymentGateway, timeZone = "UTC") {
  let now = new Date("2026-11-01T08:00:00Z");
  const db = new SqliteDatabase(":memory:");
  const provider = new MockPaymentProvider();
  const options = {
    db, clock: () => new Date(now), env: {}, timeZone,
    sku: "RC-SMALL-8", priceCents: 7299,
    payments: payments ?? gatewayFromProvider(provider),
    vault: { hasPaymentToken: () => true },
  };
  return {
    app: new HouseholdApp(options), db, provider, options,
    at: (instant: string) => { now = new Date(instant); },
  };
}

async function pendingOrder(app: HouseholdApp) {
  const pending = (await app.reorderNow()).pendingApproval;
  if (!pending) throw new Error("Expected an approval");
  return pending.orderId;
}

describe("payment attempt boundaries", () => {
  it("queries an interrupted payment even while paused and restores the receipt in its actual payment month", async () => {
    const charge = vi.fn(async () => { throw new PaymentUnknownError("Lost response", "test-reference"); });
    let found = false;
    const h = household({ charge, query: async () => "not_found", lookup: async () => found
      ? { status: "paid", paymentId: "REMOTE1", captureId: "CAPTURE1", paidAt: "2026-11-30T23:59:00Z" }
      : { status: "not_found" } });
    const id = await pendingOrder(h.app);
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    h.app.pause();
    found = true;
    h.at("2026-12-01T08:00:00Z");
    const restarted = new HouseholdApp(h.options);
    await restarted.runDueJobs();
    expect(restarted.home().order?.captureId).toBe("CAPTURE1");
    expect(restarted.home().payment?.paypalOrderId).toBe("REMOTE1");
    expect(restarted.budget().monthSettledCents).toBe(0);
    expect(restarted.home().autopilot).toBe("paused");
    await restarted.checkPayment(id);
    expect(charge).toHaveBeenCalledTimes(1);
  });
  it("claims payment before awaiting the gateway and blocks concurrent approval, rejection and reset", async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const charge = vi.fn(async () => { await held; return { paymentId: "isolated-payment" }; });
    const h = household({ query: async () => "not_found", charge });
    const id = await pendingOrder(h.app);
    const first = h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot, "first-click");
    const second = await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot, "second-click") as { charged: boolean };
    expect(second.charged).toBe(false);
    await vi.waitFor(() => expect(charge).toHaveBeenCalledTimes(1));
    expect(h.app.home().state).toBe("preparing");
    expect(() => h.app.reject(id)).toThrow(/cannot be changed/);
    expect(() => h.app.reprice(id, 7300)).toThrow(/cannot be changed/);
    expect(() => h.app.resetDemo()).toThrow(/reconciliation/);
    const orderDate = h.app.home().orderDateRaw;
    const changed = await h.app.chat("以后每顿少喂10g");
    expect(h.app.home().orderDateRaw).toBe(orderDate);
    expect(changed.headline).not.toContain("on the way");
    finish();
    await first;
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot, "later-click");
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("does not approve a rejected order, even with a stale browser request", async () => {
    const h = household();
    const id = await pendingOrder(h.app);
    h.app.reject(id);
    await expect(h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot)).rejects.toThrow(/no longer awaiting approval/);
    expect(h.provider.charges).toHaveLength(0);
  });

  it("keeps an unknown payment for reconciliation instead of charging again", async () => {
    const charge = vi.fn(async () => { throw new PaymentUnknownError("Outcome unknown", "isolated-order"); });
    const h = household({ query: async () => "not_found", charge });
    const id = await pendingOrder(h.app);
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    expect(h.app.home().state).toBe("reconciling");
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(() => h.app.reject(id)).toThrow(/cannot be changed/);
    expect(() => h.app.resetDemo(true)).toThrow(/reconciliation/);
  });

  it("recovers a process-interrupted attempt as unknown after restart", async () => {
    const h = household();
    const id = await pendingOrder(h.app);
    h.db.run("UPDATE orders SET status='preparing', payment_status='processing' WHERE id=?", [id]);
    const restarted = new HouseholdApp(h.options);
    expect(restarted.home().state).toBe("reconciling");
    await restarted.approve(id, 7299, restarted.orderDetails(id).approvalSnapshot);
    expect(h.provider.charges).toHaveLength(0);
  });

  it("treats a gateway server error as uncertain and does not blindly retry it", async () => {
    const charge = vi.fn(async () => { throw Object.assign(new Error("Gateway server error"), { httpStatus: 503 }); });
    const h = household({ query: async () => "not_found", charge });
    const id = await pendingOrder(h.app);
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    expect(h.app.home().state).toBe("reconciling");
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a confirmed payment with a late reconciliation response", async () => {
    let release!: (outcome: "not_found") => void;
    let reconciling = false;
    const query: PaymentGateway["query"] = async () => reconciling
      ? new Promise((resolve) => { release = resolve; }) : "not_found";
    const charge = vi.fn(async () => { throw new PaymentUnknownError("Outcome unknown", "isolated-order"); });
    const h = household({ query, charge });
    const id = await pendingOrder(h.app);
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    reconciling = true;
    const checking = h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    h.app.webhook({ eventId: "isolated-confirmation", orderId: id, outcome: "paid" });
    release("not_found");
    await checking;
    expect(h.app.home().state).toBe("ordered");
    expect(charge).toHaveBeenCalledTimes(1);
  });
});

describe("stock across days and feeding changes", () => {
  it("counts local meal times across the daylight-saving change", () => {
    const h = household(undefined, "America/Los_Angeles");
    h.at("2026-11-02T16:00:00Z");
    expect(h.app.home().feeding.stockG).toBe(1050);
  });

  it("adds columns to a previous schema without resetting its household or order", async () => {
    const h = household();
    const id = await pendingOrder(h.app);
    for (const [table, column] of [["food_plans", "stock_baseline_grams"], ["orders", "received_at"], ["orders", "quantity_grams"], ["orders", "paid_at"], ["approvals", "snapshot_hash"]]) {
      h.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    const migrated = new HouseholdApp(h.options);
    expect(migrated.home().pendingApproval?.orderId).toBe(id);
    expect(migrated.home().feeding.stockG).toBe(1200);
    await migrated.approve(id, 7299, migrated.orderDetails(id).approvalSnapshot);
    expect(migrated.receive(id).feeding.stockG).toBe(9200);
  });
  it("consumes the anchored meals once across reads and process restarts", () => {
    const h = household();
    h.at("2026-11-02T08:00:00Z");
    expect(h.app.home().feeding.stockG).toBe(1050);
    expect(h.app.home().headline).toContain("7 days");
    expect(h.app.home().feeding.stockG).toBe(1050);
    expect(new HouseholdApp(h.options).home().feeding.stockG).toBe(1050);
  });

  it("uses the old meal rate before a permanent change and does not restore eaten food on Undo", async () => {
    const h = household();
    h.at("2026-11-02T08:00:00Z");
    await h.app.chat("以后每顿少喂10g");
    h.at("2026-11-03T08:00:00Z");
    expect(h.app.home().feeding.stockG).toBe(920);
    h.app.undo();
    expect(h.app.home().feeding.gramsPerMeal).toBe(75);
    expect(h.app.home().feeding.stockG).toBe(900);
  });

  it("counts temporary skipped meals and actual intake in past consumption", async () => {
    const skipped = household();
    await skipped.app.chat("Skip Qizai's dinner tomorrow");
    skipped.at("2026-11-03T08:00:00Z");
    expect(skipped.app.home().feeding.stockG).toBe(975);
    const actual = household();
    await actual.app.chat("ate half of breakfast today");
    actual.at("2026-11-02T08:00:00Z");
    expect(actual.app.home().feeding.stockG).toBe(1087.5);
  });

  it("starts a calibration at the current rate without applying old meals again", async () => {
    const h = household();
    await h.app.chat("以后每顿少喂10g");
    h.at("2026-11-02T08:00:00Z");
    h.app.calibrate(1000);
    h.at("2026-11-03T08:00:00Z");
    expect(h.app.home().feeding.stockG).toBe(870);
  });
});

describe("confirmed receipt and repeating replenishment", () => {
  it("holds a budget-permitted order if the saved vault disappears after authorization", async () => {
    let connected = true;
    const h = household();
    h.options.vault.hasPaymentToken = () => connected;
    h.app.updateBudget({ perOrderLimitCents: 8000 });
    h.app.authorizePaypal();
    connected = false;
    h.at(h.app.home().orderDateRaw);
    await h.app.runDueJobs();
    expect(h.app.home().paypal.automaticPaymentAuthorized).toBe(false);
    expect(h.app.home().pendingApproval).not.toBeNull();
    expect(h.provider.charges).toHaveLength(0);
  });
  it("does not infer delivery from its estimate and refuses to receive an unpaid order", async () => {
    const h = household();
    const id = await pendingOrder(h.app);
    expect(() => h.app.receive(id)).toThrow(/paid order/);
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    h.at("2026-11-09T08:00:00Z");
    await h.app.runDueJobs();
    expect(h.app.home().state).toBe("ordered");
    expect(h.app.home().feeding.stockG).toBe(0);
    expect(h.provider.charges).toHaveLength(1);
  });

  it("receives an 8kg bag exactly once and automatically completes two order cycles", async () => {
    const h = household();
    h.app.updateBudget({ perOrderLimitCents: 8000 });
    h.app.authorizePaypal();
    for (let cycle = 0; cycle < 2; cycle++) {
      const plan = h.app.home().plan;
      h.at(plan.plannedOrderAt);
      await h.app.runDueJobs();
      expect(h.app.home().state).toBe("ordered");
      expect(h.provider.charges).toHaveLength(cycle + 1);
      const order = h.app.home().order;
      if (!order) throw new Error("Missing paid order");
      h.at(plan.estimatedDeliveryAt);
      const before = h.app.home().feeding.stockG;
      const received = h.app.receive(order.id);
      expect(received.feeding.stockG).toBe(before + 8000);
      expect(received.state).not.toBe("ordered");
      expect(Date.parse(received.orderDateRaw)).toBeGreaterThan(Date.parse(plan.plannedOrderAt));
      expect(h.app.receive(order.id).feeding.stockG).toBe(before + 8000);
      expect(h.db.get<{ status: string }>("SELECT status FROM jobs")?.status).toBe("pending");
    }
  });

  it("keeps a new cycle paused until resumed and rejects Undo across a received bag", async () => {
    const h = household();
    await h.app.chat("以后每顿少喂10g");
    const id = await pendingOrder(h.app);
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    h.app.pause();
    const received = h.app.receive(id);
    expect(() => h.app.undo()).toThrow(/Nothing to undo/);
    h.at(received.orderDateRaw);
    expect(await h.app.runDueJobs()).toEqual([]);
    h.app.resume();
    await h.app.runDueJobs();
    expect(h.app.home().pendingApproval).not.toBeNull();
    expect(h.provider.charges).toHaveLength(1);
  });

  it("counts a late approval in its payment month, even after the bag is received", async () => {
    const h = household();
    h.at("2026-11-30T23:00:00Z");
    const id = await pendingOrder(h.app);
    h.at("2026-12-01T08:00:00Z");
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    h.app.receive(id);
    h.app.updateBudget({ perOrderLimitCents: 8000 });
    h.app.authorizePaypal();
    await h.app.reorderNow();
    expect(h.app.home().pendingApproval?.violations.map((item) => item.code)).toEqual(["monthly"]);
    expect(h.provider.charges).toHaveLength(1);
  });
});
