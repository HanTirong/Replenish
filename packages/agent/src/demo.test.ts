import { describe, expect, it } from "vitest";
import { runDemo } from "./demo";

describe("demo", () => {
  it("runs the auto-pay story and the confirmation story", async () => {
    const lines: string[] = [];
    await runDemo((line = "") => {
      lines.push(line);
    });
    const text = lines.join("\n");
    expect(text).toContain("Scenario 1 · auto-pay inside the budget");
    expect(text).toContain("auto-paid with MockPaymentProvider (pay_0001)");
    expect(text).toContain("ord_0001");
    expect(text).toContain("Scenario 2 · over the per-order cap");
    expect(text).toContain("waiting for confirmation");
    expect(text).toContain("not charged");
    expect(text).toContain("Confirmed rpl_0002");
    expect(text).toContain("pay_0002");
    expect(text).toContain("Nothing was charged");
  });
});
