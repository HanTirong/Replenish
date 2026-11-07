import { describe, expect, it } from "vitest";
import type { Replenishment } from "@replenish/domain";
import { evaluateBudget, monthTotals } from "./budget";

function replenishment(partial: Partial<Replenishment> & Pick<Replenishment, "status" | "totalCents" | "createdOn">): Replenishment {
  return {
    id: partial.id ?? "rpl",
    supplyId: "sup",
    sku: "RC-SMALL-4",
    productName: "Royal Canin Small Adult",
    quantity: 1,
    currency: "USD",
    autoPay: false,
    reasons: [],
    substituted: false,
    paymentId: null,
    paymentProvider: null,
    storeOrderId: null,
    shippingDays: 2,
    orderedOn: null,
    expectedArrival: null,
    deliveredOn: null,
    decidedOn: null,
    ...partial,
  };
}

describe("evaluateBudget", () => {
  it("auto-pays inside both caps", () => {
    const decision = evaluateBudget({
      orderCents: 3500,
      perOrderCapCents: 5000,
      monthlyCapCents: 12000,
      spentCents: 0,
      pendingCents: 0,
      monthLabel: "October 2026",
    });
    expect(decision.autoPay).toBe(true);
    expect(decision.reasons[0]).toContain("within the $50.00");
    expect(decision.reasons[1]).toContain("$35.00 of the $120.00");
  });

  it("waits when the order alone is over the per-order cap", () => {
    const decision = evaluateBudget({
      orderCents: 7299,
      perOrderCapCents: 5000,
      monthlyCapCents: 12000,
      spentCents: 0,
      pendingCents: 0,
      monthLabel: "October 2026",
    });
    expect(decision.autoPay).toBe(false);
    expect(decision.perOrderOk).toBe(false);
    expect(decision.monthlyOk).toBe(true);
  });

  it("counts paid and pending amounts against the monthly cap", () => {
    const decision = evaluateBudget({
      orderCents: 3500,
      perOrderCapCents: 5000,
      monthlyCapCents: 12000,
      spentCents: 9000,
      pendingCents: 2000,
      monthLabel: "October 2026",
    });
    expect(decision.autoPay).toBe(false);
    expect(decision.monthlyOk).toBe(false);
    expect(decision.projectedCents).toBe(14500);
  });
});

describe("monthTotals", () => {
  it("ignores other months and rejected rows", () => {
    const totals = monthTotals(
      [
        replenishment({ status: "ordered", totalCents: 3500, createdOn: "2026-10-02", orderedOn: "2026-10-02" }),
        replenishment({ status: "delivered", totalCents: 1000, createdOn: "2026-10-03", orderedOn: "2026-10-03" }),
        replenishment({ status: "pending_approval", totalCents: 500, createdOn: "2026-10-04" }),
        replenishment({ status: "rejected", totalCents: 9000, createdOn: "2026-10-05" }),
        replenishment({ status: "ordered", totalCents: 8000, createdOn: "2026-09-30", orderedOn: "2026-09-30" }),
      ],
      "2026-10",
    );
    expect(totals).toEqual({ spentCents: 4500, pendingCents: 500 });
  });
});
