import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { PaymentUnknownError } from "@replenish/agent";
import { SqliteDatabase } from "./db";
import { createApiServer } from "./http";
import { HouseholdApp, type PaymentGateway } from "./service";

function household(payments?: PaymentGateway, timeZone = "UTC") {
  let now = new Date("2026-11-30T23:00:00Z");
  const db = new SqliteDatabase(":memory:");
  const charge = vi.fn(async () => ({ paymentId: "simulated-order" }));
  const app = new HouseholdApp({ db, env: {}, timeZone, clock: () => now, sku: "RC-SMALL-8", priceCents: 7299,
    payments: payments ?? { charge, query: async () => "not_found" } });
  return { app, db, charge, at: (instant: string) => { now = new Date(instant); } };
}

async function withHttp(app: HouseholdApp, check: (origin: string) => Promise<void>) {
  const server = createApiServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe("HTTP Undo revision guard", () => {
  it("binds typed Undo to the displayed revision, including concurrent sends and receipt replay", async () => {
    const h = household();
    h.app.updateFeeding(65); h.app.updateFeeding(55);
    const revision = h.app.home().undoRevisionId!;
    await withHttp(h.app, async origin => {
      const chat = (key: string, expectedRevisionId?: number) => fetch(`${origin}/v1/chat`, { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ text: "撤销", expectedRevisionId }) });
      expect((await chat("missing")).status).toBe(400);
      const replies = await Promise.all([chat("typed-one", revision), chat("typed-two", revision)]);
      expect(replies.map(result => result.status).sort()).toEqual([200, 400]);
      expect(h.app.home().feeding.gramsPerMeal).toBe(65);
      const index = replies.findIndex(result => result.status === 200);
      const key = index === 0 ? "typed-one" : "typed-two";
      const result = await replies[index]!.json();
      expect(await (await chat(key, revision)).json()).toEqual(result);
      expect((await chat(key, h.app.home().undoRevisionId!)).status).toBe(400);
      expect(h.app.home().feeding.gramsPerMeal).toBe(65);
    });
  });

  it("rejects missing or invalid revisions, replays the same Undo once and refuses a stale revision", async () => {
    const h = household();
    await h.app.updateFeeding(65);
    await h.app.updateFeeding(55);
    await withHttp(h.app, async origin => {
      const home = await (await fetch(`${origin}/v1/home`)).json() as { undoRevisionId: number };
      const undo = (expectedRevisionId: unknown, key: string) => fetch(`${origin}/v1/feeding/undo`, { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ expectedRevisionId }) });
      for (const revision of [undefined, null, 0, -1, 1.5, String(home.undoRevisionId)]) {
        const rejected = await undo(revision, "invalid");
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toMatchObject({ operationStatus: "rejected" });
        expect(h.app.home().feeding.gramsPerMeal).toBe(55);
      }
      const first = await undo(home.undoRevisionId, "undo-once");
      expect(first.status).toBe(200);
      const receipt = await first.json();
      expect(await (await undo(home.undoRevisionId, "undo-once")).json()).toEqual(receipt);
      expect(h.app.home().feeding.gramsPerMeal).toBe(65);
      expect((await undo(home.undoRevisionId, "old-result-new-request")).status).toBe(400);
      expect(h.app.home().feeding.gramsPerMeal).toBe(65);
      expect((await undo(h.app.home().undoRevisionId, "undo-previous-change")).status).toBe(200);
      expect(h.app.home().feeding.gramsPerMeal).toBe(75);
    });
  });
});

describe("approval bound to the viewed order", () => {
  it.each([
    ["sku", "RC-SMALL-4"], ["merchant", "different-store"], ["currency", "EUR"],
    ["total_cents", 7300], ["quantity_grams", 4000],
  ] as const)("refuses the viewed snapshot after %s changes, even when the amount sent is current", async (column, value) => {
    const h = household();
    const viewed = (await h.app.reorderNow()).pendingApproval!;
    // Simulate a later catalogue/order edit without granting the browser DB access.
    h.db.run(`UPDATE orders SET ${column}=? WHERE id=?`, [value, viewed.orderId]);
    await withHttp(h.app, async origin => {
      const current = h.app.orderDetails(viewed.orderId);
      const response = await fetch(`${origin}/v1/orders/${viewed.orderId}/approve`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedTotalCents: current.totalCents, approvalSnapshot: viewed.approvalSnapshot }) });
      expect(await response.json()).toMatchObject({ voided: true, charged: false });
      expect(h.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM approvals")?.count).toBe(0);
      expect(h.charge).not.toHaveBeenCalled();
    });
  });

  it("requires a snapshot, rejects one from a different order and pays the freshly viewed order only once", async () => {
    const h = household();
    const old = (await h.app.reorderNow()).pendingApproval!;
    h.app.reject(old.orderId);
    const current = (await h.app.reorderNow()).pendingApproval!;
    await withHttp(h.app, async origin => {
      const approve = (snapshot: unknown, expectedTotalCents = current.totalCents) => fetch(`${origin}/v1/orders/${current.orderId}/approve`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedTotalCents, approvalSnapshot: snapshot }),
      });
      for (const snapshot of [undefined, "", "invalid", 123]) expect((await approve(snapshot)).status).toBe(400);
      expect(await (await approve(old.approvalSnapshot)).json()).toMatchObject({ voided: true, charged: false });
      expect(await (await approve(current.approvalSnapshot, 1)).json()).toMatchObject({ voided: true, charged: false });
      expect(h.charge).not.toHaveBeenCalled();
      const viewed = await (await fetch(`${origin}/v1/home`)).json() as { pendingApproval: typeof current };
      expect(await (await approve(viewed.pendingApproval.approvalSnapshot)).json()).toMatchObject({ charged: true, voided: false });
      expect(await (await approve(viewed.pendingApproval.approvalSnapshot)).json()).toMatchObject({ charged: false });
      expect(h.charge).toHaveBeenCalledTimes(1);
      expect(h.db.get<{ currency: string; snapshot_hash: string }>("SELECT currency,snapshot_hash FROM approvals"))
        .toEqual({ currency: "USD", snapshot_hash: viewed.pendingApproval.approvalSnapshot });
    });
  });

  it("allows a new explicit approval after repricing only with the newly viewed snapshot", async () => {
    const h = household();
    const viewed = (await h.app.reorderNow()).pendingApproval!;
    h.app.reprice(viewed.orderId, 7400);
    expect(await h.app.approve(viewed.orderId, 7400, viewed.approvalSnapshot)).toMatchObject({ voided: true, charged: false });
    const fresh = h.app.home().pendingApproval!;
    expect(await h.app.approve(fresh.orderId, fresh.totalCents, fresh.approvalSnapshot)).toMatchObject({ charged: true });
    expect(h.charge).toHaveBeenCalledTimes(1);
  });
});

describe("unsettled budget commitments across months", () => {
  it("carries an awaiting approval across the household-local month boundary and releases it on rejection", async () => {
    const h = household(undefined, "America/Los_Angeles");
    const pending = (await h.app.reorderNow()).pendingApproval!;
    for (const instant of ["2026-12-01T07:59:59Z", "2026-12-01T08:00:00Z"]) {
      h.at(instant);
      expect(h.app.budget()).toMatchObject({ monthSettledCents: 0, monthCommittedCents: 7299, monthRemainingCents: 4701 });
    }
    h.app.reject(pending.orderId);
    expect(h.app.budget()).toMatchObject({ monthCommittedCents: 0, monthRemainingCents: 12000 });
  });

  it("reserves a preparing payment across months, then moves it to settled without double counting", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const h = household({ query: async () => "not_found", charge: async () => { await held; return { paymentId: "simulated-order" }; } });
    const pending = (await h.app.reorderNow()).pendingApproval!;
    const paying = h.app.approve(pending.orderId, pending.totalCents, pending.approvalSnapshot);
    try {
      expect(h.app.orderDetails(pending.orderId).status).toBe("preparing");
      h.at("2026-12-01T00:00:00Z");
      expect(h.app.budget()).toMatchObject({ monthSettledCents: 0, monthCommittedCents: 7299, monthRemainingCents: 4701 });
    } finally { release(); await paying; }
    expect(h.app.budget()).toMatchObject({ monthSettledCents: 7299, monthCommittedCents: 0, monthRemainingCents: 4701 });
  });

  it.each([
    ["2026-11-30T23:59:00Z", 0, 12000], ["2026-12-01T00:01:00Z", 7299, 4701],
  ] as const)("keeps an unknown payment reserved until verified, using settlement time %s", async (paidAt, settled, remaining) => {
    let found = false;
    const charge = vi.fn(async () => { throw new PaymentUnknownError("Simulated lost response", "simulated-attempt"); });
    const h = household({ charge, query: async () => "not_found", lookup: async () => found
      ? { status: "paid", paymentId: "simulated-order", captureId: "simulated-capture", paidAt } : { status: "not_found" } });
    const pending = (await h.app.reorderNow()).pendingApproval!;
    await h.app.approve(pending.orderId, pending.totalCents, pending.approvalSnapshot);
    h.at("2026-12-01T08:00:00Z");
    await h.app.checkPayment(pending.orderId);
    expect(h.app.budget()).toMatchObject({ monthSettledCents: 0, monthCommittedCents: 7299, monthRemainingCents: 4701 });
    found = true;
    await h.app.checkPayment(pending.orderId);
    expect(h.app.budget()).toMatchObject({ monthSettledCents: settled, monthCommittedCents: 0, monthRemainingCents: remaining });
    expect(charge).toHaveBeenCalledTimes(1);
  });
});
