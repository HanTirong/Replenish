import { describe, expect, it } from "vitest";
import { runPayPalDemo } from "./demo-paypal";
import { MemoryVaultStore } from "./paypal";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("PayPal sandbox demo", () => {
  it("fails before any network call when credentials are missing", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      throw new Error("should not be called");
    };
    await expect(
      runPayPalDemo({
        env: { PAYMENT_PROVIDER: "paypal" },
        fetch: fetchImpl,
        writeLine: () => {},
      }),
    ).rejects.toThrow(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
    expect(called).toBe(false);
  });

  it("runs both Pip charges against a scripted sandbox and prints capture ids", async () => {
    let orders = 0;
    const lines: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(url).pathname;
      const method = init?.method ?? "GET";
      const body = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (pathname === "/v1/oauth2/token") return body({ access_token: "token-1", expires_in: 3600 });
      if (pathname === "/v3/vault/setup-tokens" && method === "POST") {
        return body({ id: "SETUP1", status: "APPROVED", payment_source: { card: { last_digits: "1111" } } });
      }
      if (pathname === "/v3/vault/payment-tokens") {
        return body({
          id: "VAULT1",
          customer: { id: "customer_4029352050" },
          payment_source: { card: { brand: "VISA", last_digits: "1111", expiry: "2030-12" } },
          links: [{ href: "https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/VAULT1", rel: "self", method: "GET" }],
          create_time: "2026-10-28T01:12:00Z",
          update_time: "2026-10-28T01:12:00Z",
        }, 201);
      }
      if (pathname === "/v2/checkout/orders" && method === "POST") {
        orders += 1;
        const orderId = orders === 1 ? "ORDER_AUTO" : "ORDER_OK";
        const captureId = orders === 1 ? "CAP_AUTO" : "CAP_OK";
        const unit = JSON.parse(init!.body as string).purchase_units[0];
        return body({
          id: orderId,
          status: "COMPLETED",
          purchase_units: [{ ...unit, payments: { captures: [{ id: captureId, status: "COMPLETED", amount: unit.amount }] } }],
        });
      }
      return body({ message: pathname }, 404);
    };

    await runPayPalDemo({
      env: {
        DATA_DIR: mkdtempSync(path.join(tmpdir(), "replenish-demo-paypal-")),
        PAYMENT_PROVIDER: "paypal",
        PAYPAL_CLIENT_ID: "sandbox-id",
        PAYPAL_CLIENT_SECRET: "sandbox-secret",
      },
      fetch: fetchImpl,
      vaultStore: new MemoryVaultStore(),
      writeLine: (line = "") => lines.push(line),
    });

    const text = lines.join("\n");
    expect(text).toContain("auto-paid with PayPalPaymentProvider (ORDER_AUTO)");
    expect(text).toContain("PayPal order     ORDER_AUTO · COMPLETED");
    expect(text).toContain("PayPal capture   CAP_AUTO · COMPLETED");
    expect(text).toContain("not charged");
    expect(text).toContain("PayPal order     ORDER_OK · COMPLETED");
    expect(text).toContain("PayPal capture   CAP_OK · COMPLETED");
    expect(text).toContain("Both captures are COMPLETED.");
    expect(orders).toBe(2);
  });
});
