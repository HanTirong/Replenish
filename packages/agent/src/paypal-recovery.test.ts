import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FilePaymentAttemptStore, MemoryPaymentAttemptStore, type PaymentAttemptStore } from "./payment-attempts";
import { PayPalPaymentProvider } from "./paypal-provider";
import { PaymentUnknownError } from "./payments";

const request = { idempotencyKey: "recovery-order", amountCents: 7299, currency: "USD" as const, sku: "RC-SMALL-8", description: "Qizai food" };
const amount = { currency_code: "USD", value: "72.99" };
const env = { PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret", PAYPAL_VAULT_ID: "test-vault" };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function paid(overrides: Record<string, unknown> = {}) {
  return { id: "REMOTE1", status: "COMPLETED", purchase_units: [{ custom_id: request.idempotencyKey, amount,
    payments: { captures: [{ id: "CAPTURE1", status: "COMPLETED", amount, create_time: "2026-10-31T23:59:00Z" }] } }], ...overrides };
}
function provider(store: PaymentAttemptStore, fetch: typeof globalThis.fetch) {
  return new PayPalPaymentProvider({ env, attemptStore: store, fetch, log: () => {}, vaultStore: { load: () => null, save: () => {} } });
}

describe("persistent PayPal payment recovery", () => {
  it("requires the exact attempt identity when committing a verified result, including legacy callers", () => {
    const store = new MemoryPaymentAttemptStore();
    const payments = provider(store, async () => { throw new Error("No network is allowed"); });
    expect(() => payments.finalizeCharge(request.idempotencyKey, "paid", randomUUID())).toThrow();
    const attemptId = randomUUID();
    store.save({ ...request, attemptId, status: "unknown", phase: "verified_paid", orderId: "NEW-REMOTE", captureId: "NEW-CAPTURE" });
    expect(() => payments.finalizeCharge(request.idempotencyKey, "paid")).toThrow();
    expect(() => payments.finalizeCharge(request.idempotencyKey, "paid", randomUUID())).toThrow();
    expect(store.load(request.idempotencyKey)?.status).toBe("unknown");
    payments.finalizeCharge(request.idempotencyKey, "paid", attemptId);
    expect(store.load(request.idempotencyKey)?.status).toBe("paid");
  });

  it("preserves repeated read-only verification of a legacy record without inventing stage IDs", async () => {
    const store = new MemoryPaymentAttemptStore();
    store.save({ ...request, phase: "legacy", status: "unknown", orderId: "REMOTE1", replayBlocked: true });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/v1/oauth2/token")) return json({ access_token: "test-access", expires_in: 3600 });
      expect(init?.method).toBe("GET"); return json(paid());
    };
    const payments = provider(store, fetch);
    expect((await payments.lookupCharge(request.idempotencyKey)).status).toBe("paid");
    expect((await payments.lookupCharge(request.idempotencyKey)).status).toBe("paid");
    expect(store.load(request.idempotencyKey)?.attemptId).toBeUndefined();
    expect(store.load(request.idempotencyKey)?.createRequestId).toBeUndefined();
  });

  it("recovers a lost capture response after restart with a GET, preserving the receipt and settlement time", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "replenish-payments-"));
    const calls: { path: string; method: string; requestId: string }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      calls.push({ path: pathname, method: init?.method ?? "GET", requestId: (init?.headers as Record<string, string>)["PayPal-Request-Id"]! });
      if (pathname === "/v1/oauth2/token") return json({ access_token: "test-access", expires_in: 3600 });
      if (pathname === "/v2/checkout/orders") return json({ id: "REMOTE1", status: "APPROVED", purchase_units: JSON.parse(init!.body as string).purchase_units });
      if (pathname.endsWith("/capture")) throw new TypeError("Connection closed after payment submission");
      return json({ ...paid(), purchase_units: [{ ...paid().purchase_units[0], reference_id: new FilePaymentAttemptStore(directory).load(request.idempotencyKey)?.attemptId, description: request.description }] });
    };
    await expect(provider(new FilePaymentAttemptStore(directory), fetch).charge(request)).rejects.toBeInstanceOf(PaymentUnknownError);
    const restarted = provider(new FilePaymentAttemptStore(directory), fetch);
    expect(await restarted.lookupCharge(request.idempotencyKey)).toEqual({ status: "paid", paymentId: "REMOTE1", captureId: "CAPTURE1", paidAt: "2026-10-31T23:59:00Z", attemptId: new FilePaymentAttemptStore(directory).load(request.idempotencyKey)?.attemptId });
    await expect(restarted.charge(request)).rejects.toBeInstanceOf(PaymentUnknownError);
    expect(calls.filter(call => call.path === "/v2/checkout/orders")).toHaveLength(1);
    expect(calls.filter(call => call.path.endsWith("/capture"))).toHaveLength(1);
    expect(new Set(calls.map(call => call.requestId)).size).toBe(calls.length);
    const saved = readFileSync(path.join(directory, readdirSync(directory)[0]!), "utf8");
    for (const secret of [...Object.values(env), "test-access"]) expect(saved).not.toContain(secret);
  });

  it("keeps a lost create response unknown without issuing another create", async () => {
    const store = new MemoryPaymentAttemptStore();
    let creates = 0;
    const fetch: typeof globalThis.fetch = async input => {
      if (String(input).endsWith("/v1/oauth2/token")) return json({ access_token: "test-access", expires_in: 3600 });
      creates++;
      throw new TypeError("Lost create response");
    };
    await expect(provider(store, fetch).charge(request)).rejects.toBeInstanceOf(PaymentUnknownError);
    const restarted = provider(store, fetch);
    expect(await restarted.queryCharge(request.idempotencyKey)).toBe("unknown");
    await expect(restarted.charge(request)).rejects.toBeInstanceOf(PaymentUnknownError);
    expect(creates).toBe(1);
  });

  it.each(["pending", "wrong amount", "wrong reference", "404", "multiple captures"])("does not turn %s into payment success or permission to retry", async scenario => {
    const store = new MemoryPaymentAttemptStore();
    store.save({ ...request, status: "unknown", orderId: "REMOTE1" });
    const result = paid();
    const unit = result.purchase_units[0]!;
    if (scenario === "pending") unit.payments.captures[0]!.status = "PENDING";
    if (scenario === "wrong amount") unit.amount = { ...amount, value: "1.00" };
    if (scenario === "wrong reference") unit.custom_id = "other-order";
    if (scenario === "multiple captures") unit.payments.captures.push({ ...unit.payments.captures[0]!, id: "EXTRA" });
    const fetch: typeof globalThis.fetch = async input => String(input).endsWith("/v1/oauth2/token")
      ? json({ access_token: "test-access", expires_in: 3600 }) : scenario === "404" ? json({}, 404) : json(result);
    expect((await provider(store, fetch).lookupCharge(request.idempotencyKey)).status).toBe("unknown");
  });

  it("retains a definite decline so the owner can retry, while rejecting a changed order snapshot", async () => {
    const store = new MemoryPaymentAttemptStore();
    store.save({ ...request, status: "failed", orderId: "DECLINED1" });
    const fetch: typeof globalThis.fetch = async (input, init) => String(input).endsWith("/v1/oauth2/token")
      ? json({ access_token: "test-access", expires_in: 3600 }) : json({ ...paid(), purchase_units: [{ ...JSON.parse(init!.body as string).purchase_units[0], payments: paid().purchase_units[0]!.payments }] });
    const payments = provider(store, fetch);
    await expect(payments.charge({ ...request, amountCents: 1 })).rejects.toBeInstanceOf(PaymentUnknownError);
    expect(await payments.queryCharge(request.idempotencyKey)).toBe("failed");
    await expect(payments.charge(request)).rejects.toBeInstanceOf(PaymentUnknownError);
    expect((await payments.charge({ ...request, authorizationId: "reviewed-again" })).status).toBe("paid");
  });

});
