import { describe, expect, it } from "vitest";
import { MockPaymentProvider, PayPalPaymentProvider, paymentProviderFromEnv } from "./payments";

const request = {
  amountCents: 3500,
  currency: "USD" as const,
  description: "Royal Canin Small Adult",
  sku: "RC-SMALL-4",
  idempotencyKey: "rpl_0001",
};

describe("payment providers", () => {
  it("records a mock charge", async () => {
    const payments = new MockPaymentProvider(() => "pay_test");
    const result = await payments.charge(request);
    expect(result).toEqual({ paymentId: "pay_test", provider: "mock", status: "paid" });
    expect(payments.charges).toHaveLength(1);
  });

  it("selects the mock provider unless paypal is requested", () => {
    expect(paymentProviderFromEnv({}).name).toBe("mock");
    expect(paymentProviderFromEnv({ PAYMENT_PROVIDER: "paypal" }).name).toBe("paypal");
  });

  it("names the missing PayPal sandbox credentials", async () => {
    const payments = new PayPalPaymentProvider({ env: {} });
    await expect(payments.charge(request)).rejects.toThrow(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  });
});
