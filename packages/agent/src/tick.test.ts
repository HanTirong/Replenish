import { describe, expect, it } from "vitest";
import { MemoryHouseholdRepository, sequentialIds, type HouseholdState } from "@replenish/domain";
import { freshCatalog, StoreService } from "@replenish/store";
import { formatTick } from "./format";
import { MockPaymentProvider } from "./payments";
import { buildPipHousehold, LARGE_BAG_SKU } from "./seed";
import { resolveApproval, tick, type AgentDeps } from "./tick";

function harness(state: HouseholdState, products = freshCatalog()) {
  const ids = sequentialIds();
  const payments = new MockPaymentProvider(() => ids("pay"));
  const store = StoreService.inMemory({ products, createId: () => ids("ord") });
  const household = new MemoryHouseholdRepository(state);
  const deps: AgentDeps = { household, store, payments, ids };
  return { deps, payments, store, household };
}

describe("tick", () => {
  it("holds, auto-pays on the threshold morning, then opens the delivery", async () => {
    const { deps, payments, store, household } = harness(buildPipHousehold({ openedOn: "2026-10-01" }));

    const before = await tick(deps, "2026-10-16");
    expect(before.supplies[0]?.events.map((event) => event.type)).toEqual(["hold"]);

    const ordered = await tick(deps, "2026-10-17");
    const paid = ordered.supplies[0]?.events[0];
    expect(paid?.type).toBe("paid");
    if (paid?.type !== "paid") return;
    expect(paid.totalCents).toBe(3500);
    expect(paid.paymentId).toBe("pay_0001");
    expect(paid.storeOrderId).toBe("ord_0001");
    expect(paid.expectedArrival).toBe("2026-10-19");
    expect(paid.providerLabel).toBe("MockPaymentProvider");
    expect(formatTick(ordered)).toContain("auto-paid with MockPaymentProvider");

    const transit = await tick(deps, "2026-10-18");
    expect(transit.supplies[0]?.events[0]?.type).toBe("in_flight");
    expect(payments.charges).toHaveLength(1);

    const arrived = await tick(deps, "2026-10-19");
    expect(arrived.supplies[0]?.events.map((event) => event.type)).toEqual(["delivery", "hold"]);
    expect(arrived.supplies[0]?.forecast.remaining).toBe(4000);
    expect(arrived.supplies[0]?.forecast.runOutDate).toBe("2026-11-08");
    expect(household.snapshot().supplies[0]?.openedOn).toBe("2026-10-19");
    expect(store.snapshot().orders).toHaveLength(1);
  });

  it("does not charge or order when the preferred bag is over the per-order cap", async () => {
    const { deps, payments, store } = harness(
      buildPipHousehold({ openedOn: "2026-10-01", preferredSku: LARGE_BAG_SKU }),
    );
    const early = await tick(deps, "2026-10-15");
    expect(early.supplies[0]?.events[0]?.type).toBe("hold");

    const pending = await tick(deps, "2026-10-16");
    const event = pending.supplies[0]?.events[0];
    expect(event?.type).toBe("pending_approval");
    if (event?.type !== "pending_approval") return;
    expect(event.totalCents).toBe(7299);
    expect(event.budget.autoPay).toBe(false);
    expect(formatTick(pending)).toContain("waiting for confirmation");
    expect(formatTick(pending)).toContain("not charged");
    expect(payments.charges).toHaveLength(0);
    expect(store.snapshot().orders).toHaveLength(0);

    const stillWaiting = await tick(deps, "2026-10-17");
    expect(stillWaiting.supplies[0]?.events[0]?.type).toBe("in_flight");
    expect(payments.charges).toHaveLength(0);
  });

  it("pays and places the order only after approval", async () => {
    const { deps, payments, store } = harness(
      buildPipHousehold({ openedOn: "2026-10-01", preferredSku: LARGE_BAG_SKU }),
    );
    const pending = await tick(deps, "2026-10-16");
    const event = pending.supplies[0]?.events[0];
    if (event?.type !== "pending_approval") throw new Error("expected a pending approval");

    const confirmed = await resolveApproval(deps, event.replenishmentId, "approve", "2026-10-17");
    expect(confirmed.replenishment.status).toBe("ordered");
    expect(confirmed.replenishment.paymentProvider).toBe("mock");
    expect(confirmed.replenishment.expectedArrival).toBe("2026-10-20");
    expect(payments.charges[0]?.idempotencyKey).toBe(event.replenishmentId);
    expect(store.getOrder(confirmed.replenishment.storeOrderId ?? "")?.totalCents).toBe(7299);
  });

  it("rejects without charging", async () => {
    const { deps, payments, store, household } = harness(
      buildPipHousehold({ openedOn: "2026-10-01", preferredSku: LARGE_BAG_SKU }),
    );
    const pending = await tick(deps, "2026-10-16");
    const event = pending.supplies[0]?.events[0];
    if (event?.type !== "pending_approval") throw new Error("expected a pending approval");
    const rejected = await resolveApproval(deps, event.replenishmentId, "reject", "2026-10-17");
    expect(rejected.replenishment.status).toBe("rejected");
    expect(payments.charges).toHaveLength(0);
    expect(store.snapshot().orders).toHaveLength(0);

    const again = await tick(deps, "2026-10-17");
    expect(again.supplies[0]?.events[0]?.type).toBe("pending_approval");
    expect(household.snapshot().replenishments.filter((item) => item.status === "pending_approval")).toHaveLength(1);
  });

  it("holds an in-budget order when the month would go over", async () => {
    const state = buildPipHousehold({ openedOn: "2026-10-01" });
    state.replenishments.push({
      id: "rpl_old",
      supplyId: "other",
      sku: "RC-SMALL-4",
      productName: "Royal Canin Small Adult",
      quantity: 1,
      totalCents: 10000,
      currency: "USD",
      status: "ordered",
      autoPay: true,
      reasons: [],
      substituted: false,
      paymentId: "pay_old",
      paymentProvider: "mock",
      storeOrderId: "ord_old",
      shippingDays: 2,
      orderedOn: "2026-10-02",
      expectedArrival: "2026-10-04",
      deliveredOn: null,
      createdOn: "2026-10-02",
      decidedOn: "2026-10-02",
    });
    const { deps, payments } = harness(state);
    const result = await tick(deps, "2026-10-17");
    expect(result.supplies[0]?.events[0]?.type).toBe("pending_approval");
    expect(payments.charges).toHaveLength(0);
  });

  it("substitutes the closest in-stock bag when the preferred SKU is gone", async () => {
    const products = freshCatalog().map((product) =>
      product.sku === "RC-SMALL-4" ? { ...product, stock: 0 } : product,
    );
    const { deps } = harness(buildPipHousehold({ openedOn: "2026-10-01" }), products);
    const result = await tick(deps, "2026-10-17");
    const event = result.supplies[0]?.events[0];
    expect(event?.type).toBe("paid");
    if (event?.type !== "paid") return;
    expect(event.sku).toBe("IAMS-MINI-36");
    expect(event.substituted).toBe(true);
  });

  it("blocks the reorder when every dog-food bag is out of stock", async () => {
    const products = freshCatalog().map((product) =>
      product.category === "dog-food" ? { ...product, stock: 0 } : product,
    );
    const { deps, payments, store } = harness(buildPipHousehold({ openedOn: "2026-10-01" }), products);
    const result = await tick(deps, "2026-10-17");
    expect(result.supplies[0]?.events[0]?.type).toBe("blocked");
    expect(payments.charges).toHaveLength(0);
    expect(store.snapshot().orders).toHaveLength(0);
  });
});
