import { describe, expect, it } from "vitest";
import { runPayPalDiagnose } from "./paypal-diagnose";
import { MemoryVaultStore } from "./paypal";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("PayPal diagnose", () => {
  it("prints token scopes and a $1 capture, never the access token", async () => {
    const lines: string[] = [];
    const secret = "SECRET-TOKEN-VALUE";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(url).pathname;
      const method = init?.method ?? "GET";
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (pathname === "/v1/oauth2/token") {
        return json({
          access_token: secret,
          token_type: "Bearer",
          app_id: "APP-1",
          expires_in: 32000,
          scope: "https://uri.paypal.com/services/vault/payment-tokens/readwrite openid",
        });
      }
      if (pathname === "/v3/vault/setup-tokens") return json({ id: "SETUP1", status: "APPROVED" });
      if (pathname === "/v3/vault/payment-tokens") {
        return json({ id: "VAULT1", payment_source: { card: { last_digits: "1881" } } });
      }
      if (pathname === "/v2/checkout/orders" && method === "POST") {
        const unit = JSON.parse(init!.body as string).purchase_units[0];
        return json({
          id: "ORDER_DIAG",
          status: "COMPLETED",
          purchase_units: [{ ...unit, payments: { captures: [{ id: "CAP_DIAG", status: "COMPLETED", amount: unit.amount }] } }],
        });
      }
      return json({ message: pathname }, 404);
    };

    await runPayPalDiagnose({
      env: { DATA_DIR: mkdtempSync(path.join(tmpdir(), "replenish-diagnose-")), PAYPAL_CLIENT_ID: "sandbox-id", PAYPAL_CLIENT_SECRET: "sandbox-secret" },
      fetch: fetchImpl,
      vaultStore: new MemoryVaultStore(),
      writeLine: (line = "") => lines.push(line),
      now: () => 1_700_000_000_000,
    });

    const text = lines.join("\n");
    expect(text).toContain("https://uri.paypal.com/services/vault/payment-tokens/readwrite");
    expect(text).toContain("openid");
    expect(text).toContain("PayPal order     ORDER_DIAG · COMPLETED");
    expect(text).toContain("PayPal capture   CAP_DIAG · COMPLETED");
    expect(text).not.toContain(secret);
  });
});
