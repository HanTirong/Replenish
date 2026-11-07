import { describe, expect, it } from "vitest";
import { approvalStillValid, evaluateOrderBudget } from "./budget-gate";

describe("order budget gate", () => {
  it("reports both the per-order and monthly overages", () => {
    const spent = 90_00;
    const order = 54_90;
    const result = evaluateOrderBudget({
      orderCents: order,
      perOrderLimitCents: 50_00,
      monthlyLimitCents: 120_00,
      settledCents: spent,
      committedCents: 0,
    });
    expect(result.allowed).toBe(false);
    expect(result.monthTotalCents).toBe(spent + order);
    expect(result.violations.map((item) => item.code)).toEqual(["per_order", "monthly"]);
    expect(result.violations[0]?.overByCents).toBe(order - 50_00);
    expect(result.violations[1]?.overByCents).toBe(spent + order - 120_00);
    expect(result.violations[0]?.message).toContain("$4.90 over the $50.00");
    expect(result.violations[1]?.message).toContain("$144.90");
    expect(result.violations[1]?.message).toContain("$24.90 over the $120.00");
  });

  it("voids an approval when the draft total changes", () => {
    const approval = { orderId: "ord_1", sku: "RC-SMALL-4", merchant: "replenish-store", currency: "USD", totalCents: 5490 };
    expect(approvalStillValid(approval, { ...approval })).toBe(true);
    expect(approvalStillValid(approval, { ...approval, totalCents: 5600 })).toBe(false);
  });
});
