import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChargeRequest } from "./payments";
import { PaymentUnknownError } from "./payments";
import { MemoryPaymentAttemptStore } from "./payment-attempts";
import { PayPalPaymentProvider } from "./paypal-provider";
import { FileVaultStore, centsToPayPalAmount, type VaultStore } from "./paypal";

const request: ChargeRequest = {
  amountCents: 3500,
  currency: "USD",
  description: "Royal Canin Small Adult (RC-SMALL-4)",
  sku: "RC-SMALL-4",
  idempotencyKey: "rpl_0001",
};

const credentials = {
  PAYPAL_CLIENT_ID: "sandbox-id",
  PAYPAL_CLIENT_SECRET: "sandbox-secret",
};

interface Call {
  pathname: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function headerValue(headers: RequestInit["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? record[key] : undefined;
}

function recorded(handler: (call: Call, calls: Call[]) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = {
      pathname: new URL(url).pathname,
      method: init?.method ?? "GET",
      headers: {},
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    if (init?.headers && !Array.isArray(init.headers) && !(init.headers instanceof Headers)) {
      call.headers = init.headers as Record<string, string>;
    } else {
      const auth = headerValue(init?.headers, "authorization");
      const requestId = headerValue(init?.headers, "paypal-request-id");
      if (auth) call.headers.Authorization = auth;
      if (requestId) call.headers["PayPal-Request-Id"] = requestId;
    }
    calls.push(call);
    return handler(call, calls);
  };
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unitFor(calls: Call[]): { amount: { currency_code: string; value: string }; [key: string]: unknown } {
  const create = [...calls].reverse().find(call => call.pathname === "/v2/checkout/orders" && call.method === "POST")!;
  return JSON.parse(create.body!).purchase_units[0];
}

function completedOrder(orderId: string, captureId: string, unit: ReturnType<typeof unitFor>) {
  return {
    id: orderId,
    status: "COMPLETED",
    purchase_units: [
      {
        ...unit,
        payments: {
          captures: [{ id: captureId, status: "COMPLETED", amount: { ...unit.amount } }],
        },
      },
    ],
  };
}

function happyPath(options?: { orderStatus?: string }): { fetch: typeof fetch; calls: Call[] } {
  return recorded((call, _calls) => {
    if (call.pathname === "/v1/oauth2/token") {
      return json({ access_token: "token-1", expires_in: 3600, token_type: "Bearer" });
    }
    if (call.pathname === "/v3/vault/setup-tokens" && call.method === "POST") {
      return json({
        id: "SETUP1",
        status: "APPROVED",
        customer: { id: "customer_1" },
        payment_source: { card: { last_digits: "1111" } },
      });
    }
    if (call.pathname === "/v3/vault/payment-tokens") {
      return json({
        id: "VAULT1",
        status: "CREATED",
        customer: { id: "customer_1" },
        payment_source: { card: { last_digits: "1111" } },
      });
    }
    if (call.pathname === "/v2/checkout/orders" && call.method === "POST") {
      if (options?.orderStatus === "APPROVED") {
        return json({ id: "ORDER1", status: "APPROVED", purchase_units: [unitFor(_calls)] });
      }
      return json(completedOrder("ORDER1", "CAP1", unitFor(_calls)));
    }
    if (call.pathname === "/v2/checkout/orders/ORDER1/capture") {
      return json(completedOrder("ORDER1", "CAP1", unitFor(_calls)));
    }
    return json({ name: "NOT_FOUND", message: call.pathname }, 404);
  });
}

function provider(fetchImpl: typeof fetch, extra?: Record<string, string>, vaultStore?: VaultStore, now?: () => number) {
  return new PayPalPaymentProvider({ attemptStore: new MemoryPaymentAttemptStore(),
    env: { ...credentials, ...extra },
    fetch: fetchImpl,
    vaultStore: vaultStore ?? { load: () => null, save: () => {} },
    log: () => {},
    now,
    sleep: async () => {},
  });
}

describe("PayPal sandbox client", () => {
  it("keeps a non-final capture outcome unknown instead of allowing a new charge", async () => {
    const fake = recorded((call, _calls) => call.pathname === "/v1/oauth2/token"
      ? json({ access_token: "token-1", expires_in: 3600 })
      : json({ id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "PENDING" }] } }] }));
    await expect(provider(fake.fetch, { PAYPAL_VAULT_ID: "VAULT1" }).charge(request)).rejects.toBeInstanceOf(PaymentUnknownError);
  });
  it("keeps saved, configured and freshly vaulted tokens out of logs", async () => {
    const lines: string[] = [];
    const store = { load: () => null, save: () => {} };
    const fresh = new PayPalPaymentProvider({ attemptStore: new MemoryPaymentAttemptStore(), env: credentials, fetch: happyPath().fetch, vaultStore: store, log: (line) => lines.push(line) });
    await fresh.charge(request);
    const saved = new PayPalPaymentProvider({ attemptStore: new MemoryPaymentAttemptStore(), env: credentials, fetch: happyPath().fetch,
      vaultStore: { load: () => ({ vaultId: "VAULT1", source: "card" }), save: () => {} }, log: (line) => lines.push(line) });
    await saved.charge(request);
    const configured = new PayPalPaymentProvider({ attemptStore: new MemoryPaymentAttemptStore(), env: { ...credentials, PAYPAL_VAULT_ID: "VAULT1" },
      fetch: happyPath().fetch, vaultStore: store, log: (line) => lines.push(line) });
    await configured.charge(request);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const value of ["VAULT1", credentials.PAYPAL_CLIENT_ID, credentials.PAYPAL_CLIENT_SECRET, "token-1"]) {
      expect(lines.join("\n")).not.toContain(value);
    }
  });

  it("redacts credentials and vault tokens echoed in a PayPal error", async () => {
    const fake = recorded((call, _calls) => call.pathname === "/v1/oauth2/token"
      ? json({ access_token: "token-1", expires_in: 3600 })
      : json({ name: "ERROR", message: [credentials.PAYPAL_CLIENT_ID, credentials.PAYPAL_CLIENT_SECRET, "VAULT1", "token-1"].join(" ") }, 422));
    const payments = provider(fake.fetch, { PAYPAL_VAULT_ID: "VAULT1" });
    const error = await payments.charge(request).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    for (const value of [credentials.PAYPAL_CLIENT_ID, credentials.PAYPAL_CLIENT_SECRET, "VAULT1", "token-1"]) {
      expect((error as Error).message).not.toContain(value);
    }
  });
  it("refuses to charge when sandbox credentials are missing", async () => {
    const payments = new PayPalPaymentProvider({ attemptStore: new MemoryPaymentAttemptStore(), env: {}, fetch: async () => { throw new Error("network"); } });
    await expect(payments.charge(request)).rejects.toThrow(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  });

  it("vaults a test card and captures with the replenishment id", async () => {
    const fake = happyPath();
    const payments = provider(fake.fetch);
    const result = await payments.charge(request);

    expect(result).toMatchObject({
      paymentId: "ORDER1",
      provider: "paypal",
      status: "paid",
      paypal: {
        orderId: "ORDER1",
        orderStatus: "COMPLETED",
        captureId: "CAP1",
        captureStatus: "COMPLETED",
        vaultId: "VAULT1",
      },
    });
    expect(payments.baseUrl).toBe("https://api-m.sandbox.paypal.com");

    const tokenCall = fake.calls.find((call) => call.pathname === "/v1/oauth2/token");
    expect(tokenCall?.body).toBe("grant_type=client_credentials");
    expect(Buffer.from((tokenCall?.headers.Authorization ?? "").replace("Basic ", ""), "base64").toString()).toBe(
      "sandbox-id:sandbox-secret",
    );

    const setup = fake.calls.find((call) => call.pathname === "/v3/vault/setup-tokens");
    const setupBody = JSON.parse(setup?.body ?? "{}") as {
      payment_source: { card: { number: string; verification_method?: string } };
    };
    expect(setupBody.payment_source.card.number).toBe("4012888888881881");
    expect(setupBody.payment_source.card.verification_method).toBeUndefined();

    const order = fake.calls.find((call) => call.pathname === "/v2/checkout/orders" && call.method === "POST");
    const setupId = setup?.headers["PayPal-Request-Id"];
    const tokenId = fake.calls.find((call) => call.pathname === "/v3/vault/payment-tokens")?.headers["PayPal-Request-Id"];
    const orderIdHeader = order?.headers["PayPal-Request-Id"];
    expect(setupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokenId).toMatch(/^[0-9a-f-]{36}$/);
    expect(orderIdHeader).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set([setupId, tokenId, orderIdHeader]).size).toBe(3);
    expect(JSON.parse(order?.body ?? "{}")).toMatchObject({
      intent: "CAPTURE",
      payment_source: {
        card: {
          vault_id: "VAULT1",
          stored_credential: {
            payment_initiator: "MERCHANT",
            payment_type: "UNSCHEDULED",
            usage: "DERIVED",
          },
        },
      },
      purchase_units: [{ amount: { currency_code: "USD", value: "35.00" }, custom_id: "rpl_0001" }],
    });
    expect(fake.calls.some((call) => call.pathname.endsWith("/capture"))).toBe(false);
  });

  it("uses fresh PayPal-Request-Ids for new attempts in independent journals", async () => {
    const ids: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const requestId = headers?.["PayPal-Request-Id"];
      const url = typeof _input === "string" ? _input : _input instanceof URL ? _input.toString() : _input.url;
      const pathname = new URL(url).pathname;
      if (pathname === "/v2/checkout/orders" && requestId) ids.push(requestId);
      if (pathname === "/v1/oauth2/token") {
        return json({ access_token: "token-1", expires_in: 3600 });
      }
      if (pathname === "/v2/checkout/orders") return json(completedOrder("ORDER1", "CAP1", JSON.parse(init!.body as string).purchase_units[0]));
      return json({ message: pathname }, 404);
    };
    const shared = {
      env: { ...credentials, PAYPAL_VAULT_ID: "SAVED" },
      fetch: fetchImpl,
      vaultStore: { load: () => null, save: () => {} },
      log: () => {},
      sleep: async () => {},
    };
    const first = new PayPalPaymentProvider({ ...shared, attemptStore: new MemoryPaymentAttemptStore() });
    await first.charge(request);
    await first.charge({ ...request, idempotencyKey: "rpl_0002" });
    const second = new PayPalPaymentProvider({ ...shared, attemptStore: new MemoryPaymentAttemptStore() });
    await second.charge(request);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives each vault attempt its own setup and payment-token request ids", async () => {
    const setupIds: string[] = [];
    const tokenIds: string[] = [];
    const fake = recorded((call, _calls) => {
      if (call.pathname === "/v3/vault/setup-tokens" && call.headers["PayPal-Request-Id"]) setupIds.push(call.headers["PayPal-Request-Id"]);
      if (call.pathname === "/v3/vault/payment-tokens" && call.headers["PayPal-Request-Id"]) tokenIds.push(call.headers["PayPal-Request-Id"]);
      if (call.pathname === "/v1/oauth2/token") return json({ access_token: "token-1", expires_in: 3600 });
      if (call.pathname === "/v3/vault/setup-tokens") return json({ id: `SETUP${setupIds.length}`, status: "APPROVED" });
      if (call.pathname === "/v3/vault/payment-tokens") return json({ id: `VAULT${tokenIds.length}`, status: "CREATED" });
      if (call.pathname === "/v2/checkout/orders") return json(completedOrder("ORDER1", "CAP1", unitFor(_calls)));
      return json({ message: call.pathname }, 404);
    });
    const first = provider(fake.fetch);
    const second = provider(fake.fetch);
    await first.charge(request);
    await second.charge(request);
    expect(setupIds).toHaveLength(2);
    expect(tokenIds).toHaveLength(2);
    expect(new Set([...setupIds, ...tokenIds]).size).toBe(4);
  });

  it("caches the access token and reuses the vault on the next charge", async () => {
    const fake = happyPath();
    const payments = provider(fake.fetch);
    await payments.charge(request);
    await payments.charge({ ...request, idempotencyKey: "rpl_0002", amountCents: 7299 });
    expect(fake.calls.filter((call) => call.pathname === "/v1/oauth2/token")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.pathname === "/v3/vault/setup-tokens")).toHaveLength(1);
    const second = fake.calls.filter((call) => call.pathname === "/v2/checkout/orders" && call.method === "POST");
    expect(second).toHaveLength(2);
    expect(JSON.parse(second[1]?.body ?? "{}").purchase_units[0].amount.value).toBe("72.99");
  });

  it("fetches a new token after the cached one is inside the expiry skew", async () => {
    let now = 1_000_000;
    const fake = recorded((call, _calls) => {
      if (call.pathname === "/v1/oauth2/token") return json({ access_token: `token-${now}`, expires_in: 120 });
      if (call.pathname === "/v3/vault/setup-tokens") return json({ id: "SETUP1", status: "APPROVED" });
      if (call.pathname === "/v3/vault/payment-tokens") return json({ id: "VAULT1", status: "CREATED" });
      if (call.pathname === "/v2/checkout/orders") return json(completedOrder("ORDER1", "CAP1", unitFor(_calls)));
      return json({ message: "nope" }, 404);
    });
    const payments = provider(fake.fetch, {}, undefined, () => now);
    await payments.charge(request);
    now += 70_000;
    await payments.charge({ ...request, idempotencyKey: "rpl_0002" });
    expect(fake.calls.filter((call) => call.pathname === "/v1/oauth2/token")).toHaveLength(2);
  });

  it("captures when create order is not already completed", async () => {
    const fake = happyPath({ orderStatus: "APPROVED" });
    const payments = provider(fake.fetch);
    const result = await payments.charge(request);
    expect(result.paypal?.captureId).toBe("CAP1");
    const capture = fake.calls.find((call) => call.pathname === "/v2/checkout/orders/ORDER1/capture");
    const createIdHeader = fake.calls.find((call) => call.pathname === "/v2/checkout/orders" && call.method === "POST")?.headers["PayPal-Request-Id"];
    expect(capture?.headers["PayPal-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(capture?.headers["PayPal-Request-Id"]).not.toBe(createIdHeader);
  });

  it("skips vaulting when PAYPAL_VAULT_ID is already set", async () => {
    const fake = happyPath();
    const payments = provider(fake.fetch, { PAYPAL_VAULT_ID: "SAVED" });
    const result = await payments.charge(request);
    expect(result.paypal?.vaultId).toBe("SAVED");
    expect(fake.calls.some((call) => call.pathname.includes("/vault/"))).toBe(false);
    const order = fake.calls.find((call) => call.pathname === "/v2/checkout/orders");
    expect(JSON.parse(order?.body ?? "{}").payment_source.card.vault_id).toBe("SAVED");
  });

  it("prints the approval URL and continues after the setup token is approved", async () => {
    const lines: string[] = [];
    let setupReads = 0;
    const fake = recorded((call, _calls) => {
      if (call.pathname === "/v1/oauth2/token") return json({ access_token: "token-1", expires_in: 3600 });
      if (call.pathname === "/v3/vault/setup-tokens" && call.method === "POST") {
        return json({
          id: "SETUP1",
          status: "PAYER_ACTION_REQUIRED",
          links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/approve-card" }],
        });
      }
      if (call.pathname === "/v3/vault/setup-tokens/SETUP1") {
        setupReads += 1;
        return json({ id: "SETUP1", status: "APPROVED" });
      }
      if (call.pathname === "/v3/vault/payment-tokens") return json({ id: "VAULT1", status: "CREATED" });
      if (call.pathname === "/v2/checkout/orders") return json(completedOrder("ORDER1", "CAP1", unitFor(_calls)));
      return json({ message: "nope" }, 404);
    });
    const payments = new PayPalPaymentProvider({ attemptStore: new MemoryPaymentAttemptStore(),
      env: credentials,
      fetch: fake.fetch,
      vaultStore: { load: () => null, save: () => {} },
      log: (line) => lines.push(line),
      sleep: async () => {},
      pollTimeoutMs: 10_000,
    });
    await payments.charge(request);
    expect(setupReads).toBe(1);
    expect(lines.join("\n")).toContain("https://www.sandbox.paypal.com/approve-card");
  });

  it("times out with the approval URL when the buyer never approves", async () => {
    const lines: string[] = [];
    const fake = recorded((call, _calls) => {
      if (call.pathname === "/v1/oauth2/token") return json({ access_token: "token-1", expires_in: 3600 });
      if (call.pathname === "/v3/vault/setup-tokens") {
        return json({
          id: "SETUP1",
          status: "PAYER_ACTION_REQUIRED",
          links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/approve-card" }],
        });
      }
      return json({ message: "nope" }, 404);
    });
    const payments = new PayPalPaymentProvider({ attemptStore: new MemoryPaymentAttemptStore(),
      env: credentials,
      fetch: fake.fetch,
      vaultStore: { load: () => null, save: () => {} },
      log: (line) => lines.push(line),
      sleep: async () => {},
      pollTimeoutMs: 0,
    });
    await expect(payments.charge(request)).rejects.toThrow(/payment result needs verification/);
    expect(lines.join("\n")).toContain("https://www.sandbox.paypal.com/approve-card");
  });

  it("includes the PayPal debug id and hides the test card number", async () => {
    const fake = recorded((call, _calls) => {
      if (call.pathname === "/v1/oauth2/token") return json({ access_token: "token-1", expires_in: 3600 });
      if (call.pathname === "/v3/vault/setup-tokens") {
        return json(
          {
            name: "UNPROCESSABLE_ENTITY",
            message: "Card 4111111111111111 was declined",
            debug_id: "debug123",
            details: [{ issue: "CARD_EXPIRED", description: "Card is expired" }],
          },
          422,
        );
      }
      return json({ message: "nope" }, 404);
    });
    const payments = provider(fake.fetch);
    await expect(payments.charge(request)).rejects.toThrow(/debug_id: debug123/);
    await expect(provider(fake.fetch).charge(request)).rejects.toThrow(/CARD_EXPIRED/);
    await expect(provider(fake.fetch).charge(request)).rejects.not.toThrow(/4111111111111111/);
  });

  it("accepts the live payment-token body, which has an id and no status", async () => {
    const lines: string[] = [];
    const fake = recorded((call, _calls) => {
      if (call.pathname === "/v1/oauth2/token") {
        return json({ access_token: "token-1", token_type: "Bearer", expires_in: "32399" });
      }
      if (call.pathname === "/v3/vault/setup-tokens" && call.method === "POST") {
        return json({
          id: "5C991763VB2781612",
          status: "APPROVED",
          customer: { id: "customer_4029352050" },
          payment_source: { card: { last_digits: "1111", brand: "VISA" } },
          links: [
            { href: "https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/5C991763VB2781612", rel: "self", method: "GET" },
          ],
        }, 201);
      }
      if (call.pathname === "/v3/vault/payment-tokens") {
        return json({
          id: "dnbbj3g",
          customer: { id: "customer_4029352050" },
          payment_source: {
            card: {
              brand: "VISA",
              last_digits: "1111",
              expiry: "2030-12",
              name: "Firstname Lastname",
            },
          },
          links: [
            { href: "https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/dnbbj3g", rel: "self", method: "GET" },
            { href: "https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/dnbbj3g", rel: "delete", method: "DELETE" },
          ],
          create_time: "2026-10-28T01:12:00Z",
          update_time: "2026-10-28T01:12:00Z",
        }, 201);
      }
      if (call.pathname === "/v2/checkout/orders" && call.method === "POST") {
        return json({
          id: "5O190127TN364715T",
          status: "COMPLETED",
          payment_source: { card: { brand: "VISA", last_digits: "1111" } },
          purchase_units: [
            {
              ...unitFor(_calls),
              payments: {
                captures: [
                  {
                    id: "3C679366HH908993F",
                    status: "COMPLETED",
                    amount: { currency_code: "USD", value: "35.00" },
                    final_capture: true,
                  },
                ],
              },
            },
          ],
        }, 201);
      }
      return json({ message: call.pathname }, 404);
    });
    const payments = new PayPalPaymentProvider({ attemptStore: new MemoryPaymentAttemptStore(),
      env: credentials,
      fetch: fake.fetch,
      vaultStore: { load: () => null, save: () => {} },
      log: (line) => lines.push(line),
      sleep: async () => {},
    });
    const result = await payments.charge(request);
    expect(result.paypal).toEqual({
      attemptId: expect.any(String),
      orderId: "5O190127TN364715T",
      orderStatus: "COMPLETED",
      captureId: "3C679366HH908993F",
      captureStatus: "COMPLETED",
      vaultId: "dnbbj3g",
    });
    expect(lines.join("\n")).toContain("saved payment token (card");
    expect(fake.calls.filter((call) => call.pathname === "/v1/oauth2/token")).toHaveLength(1);
    await payments.charge({ ...request, idempotencyKey: "rpl_0002" });
    expect(fake.calls.filter((call) => call.pathname === "/v1/oauth2/token")).toHaveLength(1);
  });

  it("follows an Orders v2 payer-action link, then captures the documented order", async () => {
    const lines: string[] = [];
    const fake = recorded((call, _calls) => {
      if (call.pathname === "/v1/oauth2/token") return json({ access_token: "token-1", expires_in: 3600 });
      if (call.pathname === "/v3/vault/setup-tokens") return json({ id: "SETUP1", status: "APPROVED" });
      if (call.pathname === "/v3/vault/payment-tokens") {
        return json({ id: "VAULT1", customer: { id: "customer_1" }, payment_source: { card: { last_digits: "1111" } } });
      }
      if (call.pathname === "/v2/checkout/orders" && call.method === "POST") {
        return json({
          id: "ORDER1",
          status: "PAYER_ACTION_REQUIRED",
          purchase_units: [unitFor(_calls)],
          links: [
            { href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1", rel: "self", method: "GET" },
            { href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1", rel: "payer-action", method: "GET" },
          ],
        });
      }
      if (call.pathname === "/v2/checkout/orders/ORDER1" && call.method === "GET") {
        return json({ id: "ORDER1", status: "APPROVED", purchase_units: [unitFor(_calls)] });
      }
      if (call.pathname === "/v2/checkout/orders/ORDER1/capture") {
        return json(completedOrder("ORDER1", "CAP1", unitFor(_calls)));
      }
      return json({ message: call.pathname }, 404);
    });
    const payments = new PayPalPaymentProvider({ attemptStore: new MemoryPaymentAttemptStore(),
      env: credentials,
      fetch: fake.fetch,
      vaultStore: { load: () => null, save: () => {} },
      log: (line) => lines.push(line),
      sleep: async () => {},
      pollTimeoutMs: 10_000,
    });
    const result = await payments.charge(request);
    expect(result.paypal?.captureId).toBe("CAP1");
    expect(lines.join("\n")).toContain("https://www.sandbox.paypal.com/checkoutnow?token=ORDER1");
    expect(fake.calls.some((call) => call.pathname === "/v2/checkout/orders/ORDER1/capture")).toBe(true);
  });

  it("never opens a wallet after a card decline, even when the legacy fallback setting is on", async () => {
    const fake = recorded(call => call.pathname === "/v1/oauth2/token" ? json({ access_token: "token-1", expires_in: 3600 })
      : json({ details: [{ issue: "INSTRUMENT_DECLINED" }] }, 422));
    const payments = provider(fake.fetch, { PAYPAL_VAULT_ID: "VAULT1", PAYPAL_WALLET_FALLBACK: "on" });
    await expect(payments.charge(request)).rejects.toThrow();
    expect(fake.calls.filter(call => call.pathname === "/v2/checkout/orders")).toHaveLength(1);
    expect(fake.calls.some(call => call.pathname.startsWith("/v3/vault/"))).toBe(false);
    await expect(payments.charge(request)).rejects.toBeInstanceOf(PaymentUnknownError);
  });

  it("refuses a card without opening a wallet approval when the fallback is off", async () => {
    const lines: string[] = [];
    const fake = recorded((call, _calls) => {
      if (call.pathname === "/v1/oauth2/token") return json({ access_token: "token-1", expires_in: 3600 });
      if (call.pathname === "/v3/vault/setup-tokens") return json({ id: "SETUP1", status: "APPROVED" });
      if (call.pathname === "/v3/vault/payment-tokens") return json({ id: "VAULT1", payment_source: { card: { last_digits: "1881" } } });
      if (call.pathname === "/v2/checkout/orders") {
        return json(
          {
            name: "UNPROCESSABLE_ENTITY",
            message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
            debug_id: "f766407af3ff7",
            details: [{ issue: "PAYER_CANNOT_PAY", description: "Payer cannot pay for this transaction." }],
          },
          422,
        );
      }
      return json({ message: call.pathname }, 404);
    });
    const payments = new PayPalPaymentProvider({ attemptStore: new MemoryPaymentAttemptStore(),
      env: { ...credentials, PAYPAL_WALLET_FALLBACK: "off" },
      fetch: fake.fetch,
      vaultStore: { load: () => null, save: () => {} },
      log: (line) => lines.push(line),
      sleep: async () => {},
    });
    await expect(payments.charge(request)).rejects.toThrow(/UNPROCESSABLE_ENTITY/);
    await expect(payments.charge({ ...request, authorizationId: "new-approval-1" })).rejects.toThrow(/PAYER_CANNOT_PAY: Payer cannot pay for this transaction/);
    await expect(payments.charge({ ...request, authorizationId: "new-approval-2" })).rejects.toThrow(/debug_id: f766407af3ff7/);
    expect(lines.join("\n")).not.toContain("approve");
    expect(fake.calls.some((call) => call.body?.includes('"paypal"'))).toBe(false);
  });

  it("keeps DERIVED after a capture id, and sends SUBSEQUENT only with a scheme reference", async () => {
    const saved: { record: import("./paypal").VaultRecord | null } = { record: null };
    const store = {
      load: () => saved.record,
      save: (record: import("./paypal").VaultRecord) => {
        saved.record = record;
      },
    };
    let orders = 0;
    const fake = recorded((call, _calls) => {
      if (call.pathname === "/v1/oauth2/token") return json({ access_token: "token-1", expires_in: 3600 });
      if (call.pathname === "/v3/vault/setup-tokens") return json({ id: "SETUP1", status: "APPROVED" });
      if (call.pathname === "/v3/vault/payment-tokens") return json({ id: "VAULT1881", payment_source: { card: { last_digits: "1881", brand: "VISA" } } });
      if (call.pathname === "/v2/checkout/orders" && call.method === "POST") {
        orders += 1;
        return json({
          id: `ORDER${orders}`,
          status: "COMPLETED",
          payment_source: { card: { brand: "VISA", last_digits: "1881" } },
          purchase_units: [
            {
              ...unitFor(_calls),
              payments: {
                captures: [
                  {
                    id: `CAP${orders}`,
                    status: "COMPLETED",
                    amount: unitFor(_calls).amount,
                    create_time: "2026-10-28T01:58:00Z",
                    processor_response: {
                      avs_code: "Y",
                      cvv_code: "M",
                      response_code: "0000",
                      network_transaction_id: "305123456789012",
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return json({ message: call.pathname }, 404);
    });
    const payments = provider(fake.fetch, {}, store);
    await payments.charge(request);
    expect(saved.record?.previousTransactionId).toBe("CAP1");
    expect(saved.record?.networkTransaction).toEqual({ id: "305123456789012", network: "VISA", date: "1028" });
    const orderPosts = () => fake.calls.filter((call) => call.pathname === "/v2/checkout/orders" && call.method === "POST");
    const first = JSON.parse(orderPosts()[0]?.body ?? "{}") as {
      payment_source: { card: { stored_credential: { usage: string } } };
    };
    expect(first.payment_source.card.stored_credential.usage).toBe("DERIVED");

    await payments.charge({ ...request, idempotencyKey: "rpl_0002", amountCents: 3500 });
    const subsequent = orderPosts().filter((call) => {
      const parsed = JSON.parse(call.body ?? "{}") as { payment_source?: { card?: { stored_credential?: { usage?: string } } } };
      return parsed.payment_source?.card?.stored_credential?.usage === "SUBSEQUENT";
    });
    expect(subsequent).toHaveLength(1);
    expect(JSON.parse(subsequent[0]?.body ?? "{}")).toMatchObject({
      payment_source: {
        card: {
          vault_id: "VAULT1881",
          stored_credential: {
            payment_initiator: "MERCHANT",
            payment_type: "UNSCHEDULED",
            usage: "SUBSEQUENT",
            previous_network_transaction_reference: {
              id: "305123456789012",
              network: "VISA",
              date: "1028",
            },
          },
        },
      },
    });
  });

  it("remembers a payment token in the vault file", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "replenish-vault-"));
    const store = new FileVaultStore(path.join(directory, "paypal-vault.json"));
    const first = happyPath();
    await provider(first.fetch, {}, store).charge(request);
    const second = happyPath();
    const again = await provider(second.fetch, {}, store).charge({ ...request, idempotencyKey: "rpl_0002" });
    expect(again.paypal?.vaultId).toBe("VAULT1");
    expect(second.calls.some((call) => call.pathname === "/v3/vault/setup-tokens")).toBe(false);
    expect(centsToPayPalAmount(50)).toBe("0.50");
  });
});
