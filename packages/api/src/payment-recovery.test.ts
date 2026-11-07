import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PayPalPaymentProvider, SqlitePaymentAttemptStore } from "@replenish/agent";
import { FilePaymentAttemptStore } from "../../agent/src/payment-attempts";
import { PAYMENT_REPLAY_WINDOW_MS } from "../../agent/src/paypal";
import { SqliteDatabase } from "./db";
import { createApiServer, gatewayFromProvider } from "./http";
import { HouseholdApp } from "./service";

type Remote = { id: string; status: string; purchase_units: { reference_id: string; custom_id: string; description: string;
  amount: { currency_code: string; value: string }; payments?: { captures: Record<string, unknown>[] } }[] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function fixture(file = ":memory:") {
  const db = new SqliteDatabase(file), store = new SqlitePaymentAttemptStore(db);
  let now = Date.parse("2026-10-31T10:00:00Z"), loss: "oauth" | "create-before" | "create-after" | "capture-after" | null = "create-after";
  let completeOnCreate = true, captures = 0, creates = 0, staleGets = 0, decline = false, alreadyCaptured = false, tokenExpiresIn = 3600;
  let changed: ((remote: Remote) => void) | null = null, hold: Promise<void> | null = null;
  let beforeToken: (() => void | Promise<void>) | null = null;
  let writeResponse: ((remote: Remote, stage: "create" | "capture") => void) | null = null;
  let beforeGetReturn: (() => Promise<void>) | null = null;
  const calls: { method: string; path: string; id: string; body?: string }[] = [];
  const byRequest = new Map<string, Remote>();
  let remote: Remote | null = null;
  const env = { PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret", PAYPAL_VAULT_ID: "test-vault", PAYPAL_VAULT_SOURCE: "card" };
  function settle(order: Remote) {
    if (order.status !== "COMPLETED") captures++;
    order.status = "COMPLETED";
    order.purchase_units[0]!.payments = { captures: [{ id: "CAPTURE1", status: "COMPLETED", amount: { ...order.purchase_units[0]!.amount }, create_time: new Date(now).toISOString() }] };
  }
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname, method = init?.method ?? "GET";
    const id = new Headers(init?.headers).get("PayPal-Request-Id")!;
    calls.push({ method, path: pathname, id, body: init?.body as string | undefined });
    if (pathname === "/v1/oauth2/token") {
      if (loss === "oauth") { loss = null; throw new TypeError("Simulated interruption before any order submission"); }
      await beforeToken?.(); return json({ access_token: "test-access", expires_in: tokenExpiresIn });
    }
    if (pathname === "/v2/checkout/orders") {
      await hold;
      if (loss === "create-before") { loss = null; throw new TypeError("Simulated request never reached PayPal"); }
      if (decline) return json({ details: [{ issue: "INSTRUMENT_DECLINED" }] }, 422);
      remote = byRequest.get(id) ?? { ...JSON.parse(init!.body as string), id: `REMOTE${++creates}`, status: "APPROVED" } as Remote;
      byRequest.set(id, remote);
      if (completeOnCreate) settle(remote);
      if (loss === "create-after") { loss = null; throw new TypeError("Simulated lost create response"); }
      const result = structuredClone(remote); writeResponse?.(result, "create"); return json(result);
    }
    if (pathname.endsWith("/capture")) {
      if (!remote) throw new Error("No remote order");
      if (remote.status === "COMPLETED" || alreadyCaptured) {
        settle(remote); return json({ details: [{ issue: "ORDER_ALREADY_CAPTURED" }] }, 422);
      }
      settle(remote);
      if (loss === "capture-after") { loss = null; throw new TypeError("Simulated lost capture response"); }
      const result = structuredClone(remote); writeResponse?.(result, "capture"); return json(result);
    }
    if (!remote) return json({}, 404);
    const result = structuredClone(remote);
    if (staleGets-- > 0) { result.status = "APPROVED"; delete result.purchase_units[0]!.payments; }
    changed?.(result);
    await beforeGetReturn?.();
    return json(result);
  };
  const makeApp = (database = db) => {
    const provider = new PayPalPaymentProvider({ env, fetch, attemptStore: new SqlitePaymentAttemptStore(database),
      deferFinalization: true, now: () => now, log: () => {}, vaultStore: { load: () => null, save: () => {} } });
    return new HouseholdApp({ db: database, env: {}, model: null, timeZone: "UTC", clock: () => new Date(now),
      sku: "RC-SMALL-8", priceCents: 7299, payments: gatewayFromProvider(provider), vault: { hasPaymentToken: () => true } });
  };
  const app = makeApp();
  const start = async () => { const p = (await app.reorderNow()).pendingApproval!; await app.approve(p.orderId, p.totalCents, p.approvalSnapshot); return p; };
  const recover = (target = app) => { const r = target.home().paymentRecovery!; return target.recoverPayment(r.orderId, r.totalCents, r.approvalSnapshot, r.attemptId); };
  return { db, store, app, env, calls, start, recover, makeApp, now: () => now, advance: (ms: number) => { now += ms; },
    config: (options: { loss?: typeof loss; completeOnCreate?: boolean; decline?: boolean; staleGets?: number; alreadyCaptured?: boolean; tokenExpiresIn?: number; changed?: typeof changed; hold?: typeof hold; beforeToken?: typeof beforeToken; writeResponse?: typeof writeResponse; beforeGetReturn?: typeof beforeGetReturn }) => {
      if ("loss" in options) loss = options.loss!;
      if ("completeOnCreate" in options) completeOnCreate = options.completeOnCreate!;
      if ("decline" in options) decline = options.decline!;
      if ("staleGets" in options) staleGets = options.staleGets!;
      if ("alreadyCaptured" in options) alreadyCaptured = options.alreadyCaptured!;
      if ("tokenExpiresIn" in options) tokenExpiresIn = options.tokenExpiresIn!;
      if ("changed" in options) changed = options.changed!;
      if ("hold" in options) hold = options.hold!;
      if ("beforeToken" in options) beforeToken = options.beforeToken!;
      if ("writeResponse" in options) writeResponse = options.writeResponse!;
      if ("beforeGetReturn" in options) beforeGetReturn = options.beforeGetReturn!;
    }, counts: () => ({ captures, creates }), attempt: (key: string) => store.load(key)! };
}

describe("SQLite payment recovery and household policy", () => {
  it("does not authorize recovery from public home fields, even with spoofed local access or body/query credentials", async () => {
    const h = fixture(); await h.start();
    const operatorCode = randomUUID();
    for (const configured of [undefined, operatorCode]) {
      const server = createApiServer(h.app, { maintenanceToken: configured });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const home = await (await fetch(`${origin}/v1/home`)).json() as ReturnType<HouseholdApp["home"]>;
        expect(JSON.stringify(home)).not.toContain(operatorCode);
        const r = home.paymentRecovery!;
        const body = { expectedTotalCents: r.totalCents, approvalSnapshot: r.approvalSnapshot, expectedAttemptId: r.attemptId, token: operatorCode };
        const before = h.calls.length;
        const headers: Record<string, string>[] = [{}, { authorization: `Bearer ${randomUUID()}` }, { "x-forwarded-for": "127.0.0.1" }];
        if (!configured) headers.push({ authorization: `Bearer ${operatorCode}` });
        for (const extra of headers) {
          const response = await fetch(`${origin}/v1/orders/${r.orderId}/recover-payment?token=${encodeURIComponent(operatorCode)}`, {
            method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body),
          });
          expect(response.status).toBe(403);
          expect(await response.text()).not.toContain(operatorCode);
        }
        expect(h.calls).toHaveLength(before);
        expect(h.app.orderDetails(r.orderId).paymentStatus).toBe("unknown");
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    }
  });

  it.each(["create", "capture"])("never writes a recovery request with a missing %s Request-Id", async stage => {
    const h = fixture();
    if (stage === "capture") h.config({ completeOnCreate: false, loss: "capture-after" });
    const p = await h.start(); const original = h.attempt(p.orderId);
    h.store.save({ ...original, [stage === "create" ? "createRequestId" : "captureRequestId"]: undefined });
    if (stage === "capture") h.config({ staleGets: 1 });
    const posts = h.calls.filter(call => call.path.startsWith("/v2/") && call.method === "POST").length;
    await expect(h.recover()).rejects.toThrow();
    expect(h.calls.filter(call => call.path.startsWith("/v2/") && call.method === "POST")).toHaveLength(posts);
    expect(h.calls.some(call => call.id === "undefined")).toBe(false);
    expect(h.counts().captures).toBe(1);
    expect(h.app.budget().monthCommittedCents).toBe(7299);
  });

  it.each(["approval", "pause", "snapshot", "budget", "source", "automatic authorization", "open order"])("rechecks %s after OAuth before the first payment write", async change => {
    const h = fixture(); h.config({ loss: null });
    if (change === "automatic authorization") { h.app.updateBudget({ perOrderLimitCents: 8000 }); h.app.authorizePaypal(); }
    h.config({ beforeToken: () => {
      if (change === "approval") h.db.run("UPDATE approvals SET status='void'");
      if (change === "pause") h.app.pause();
      if (change === "snapshot") h.db.run("UPDATE orders SET quantity_grams=4000");
      if (change === "budget") h.app.updateBudget({ monthlyLimitCents: 10000 });
      if (change === "source") h.env.PAYPAL_VAULT_ID = "different-before-first-send";
      if (change === "automatic authorization") h.db.run("UPDATE payment_auth SET automatic_payment_authorized=0");
      if (change === "open order") h.db.run(`INSERT INTO orders (id,pet_id,sku,merchant,total_cents,currency,status,payment_status,idempotency_key,created_at,updated_at,paid_at)
        SELECT 'other-open',pet_id,sku,merchant,total_cents,currency,'ordered','paid','other-open','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z','2026-09-01T10:00:00Z' FROM orders LIMIT 1`);
    } });
    if (change === "automatic authorization") await h.app.reorderNow();
    else await h.start();
    expect(h.calls.filter(call => call.path.startsWith("/v2/") && call.method === "POST")).toHaveLength(0);
    expect(h.counts()).toEqual({ creates: 0, captures: 0 });
    expect(h.app.budget().monthSettledCents).toBe(0);
  });

  it.each(["create", "capture"].flatMap(stage => ["reference", "custom_id", "order amount", "currency", "capture amount", "capture currency", "multiple captures", "multiple units", "empty capture ID"].map(mismatch => ({ stage, mismatch }))))("rejects initial $stage response: $mismatch", async ({ stage, mismatch }) => {
      const h = fixture(); h.config({ loss: null, completeOnCreate: stage === "create", writeResponse: (order, current) => {
        if (current !== stage) return;
        const unit = order.purchase_units[0]!;
        if (mismatch === "reference") unit.reference_id = "different-attempt";
        if (mismatch === "custom_id") unit.custom_id = "different-order";
        if (mismatch === "currency") unit.amount.currency_code = "EUR";
        if (mismatch === "capture currency") (unit.payments!.captures[0]!.amount as { currency_code: string }).currency_code = "EUR";
        if (mismatch === "multiple units") order.purchase_units.push(structuredClone(unit));
        if (mismatch === "empty capture ID") unit.payments!.captures[0]!.id = "";
        if (mismatch === "order amount") unit.amount.value = "1.00";
        if (mismatch === "capture amount") (unit.payments!.captures[0]!.amount as { value: string }).value = "1.00";
        if (mismatch === "multiple captures") unit.payments!.captures.push({ ...unit.payments!.captures[0]!, id: "EXTRA" });
      } });
      const p = await h.start();
      expect(h.app.orderDetails(p.orderId).paymentStatus, `${stage}: ${mismatch}`).toBe("unknown");
      expect(h.app.budget()).toMatchObject({ monthSettledCents: 0, monthCommittedCents: 7299 });
      expect(h.attempt(p.orderId)).toMatchObject({ status: "unknown", replayBlocked: true });
  });

  it.each(["failed", "paid", "mismatch"])("does not let a delayed %s GET for the previous attempt mutate a newly approved attempt", async outcome => {
    const h = fixture(); h.config({ completeOnCreate: false }); const p = await h.start();
    await h.recover();
    const previous = h.attempt(p.orderId);
    let release!: () => void, observed!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { observed = resolve; });
    h.config({ changed: order => {
      if (outcome === "failed") { order.status = "VOIDED"; delete order.purchase_units[0]!.payments; }
      if (outcome === "paid") {
        order.status = "COMPLETED";
        order.purchase_units[0]!.payments = { captures: [{ id: "OLD-CAPTURE", status: "COMPLETED", amount: { ...order.purchase_units[0]!.amount } }] };
      }
      if (outcome === "mismatch") order.purchase_units[0]!.reference_id = "wrong-old-reference";
    }, beforeGetReturn: async () => { observed(); await held; } });
    const delayed = h.app.checkPayment(p.orderId); await seen;
    // A separate verifier confirmed the old VOIDED order while this GET was in flight.
    h.store.save({ ...previous, status: "failed", phase: "verified_failed", replayBlocked: true });
    h.db.run("UPDATE orders SET payment_status='failed',status='failed' WHERE id=?", [p.orderId]);
    h.config({ changed: null, beforeGetReturn: null, loss: "create-after" });
    const viewed = h.app.home().pendingApproval!;
    await h.app.approve(viewed.orderId, viewed.totalCents, viewed.approvalSnapshot);
    const current = h.attempt(p.orderId);
    expect(current.attemptId).not.toBe(previous.attemptId);
    release(); await delayed;
    expect(h.attempt(p.orderId)).toEqual(current);
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("unknown");
    expect(h.app.home().paymentRecovery?.recoverable).toBe(true);
    h.advance(5_001); await h.recover();
    expect(h.counts()).toEqual({ creates: 2, captures: 0 });
    expect(h.attempt(p.orderId)).toMatchObject({ attemptId: current.attemptId, phase: "found" });
  });

  it.each(["reference", "amount", "unit count"])("does not capture an initially approved order with mismatched %s", async mismatch => {
    const h = fixture(); h.config({ loss: null, completeOnCreate: false, writeResponse: (order, stage) => {
      if (stage !== "create") return;
      if (mismatch === "reference") order.purchase_units[0]!.custom_id = "different-order";
      if (mismatch === "amount") order.purchase_units[0]!.amount.value = "1.00";
      if (mismatch === "unit count") order.purchase_units.push(structuredClone(order.purchase_units[0]!));
    } });
    const p = await h.start();
    expect(h.calls.filter(call => call.path.endsWith("/capture"))).toHaveLength(0);
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("unknown");
    expect(h.counts()).toEqual({ creates: 1, captures: 0 });
  });

  it("rejects a capture response for another remote order", async () => {
    const h = fixture(); h.config({ loss: null, completeOnCreate: false, writeResponse: (order, stage) => {
      if (stage === "capture") order.id = "OTHER-REMOTE";
    } });
    const p = await h.start();
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("unknown");
    expect(h.attempt(p.orderId)).toMatchObject({ orderId: "REMOTE1", responseMismatch: true, status: "unknown" });
  });

  it("discards a stale GET of the same attempt after a newer lookup has verified payment", async () => {
    const h = fixture(); h.config({ completeOnCreate: false, loss: "capture-after" }); const p = await h.start();
    let release!: () => void, observed!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { observed = resolve; });
    h.config({ staleGets: 1, beforeGetReturn: async () => { observed(); await held; } });
    const delayed = h.app.checkPayment(p.orderId); await seen;
    h.config({ beforeGetReturn: null }); await h.app.checkPayment(p.orderId);
    const paid = h.attempt(p.orderId); expect(paid.status).toBe("paid");
    release(); await delayed;
    expect(h.attempt(p.orderId)).toEqual(paid);
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("paid");
  });

  it.each(["approval", "pause", "budget", "source"])("rechecks %s again before initial capture after create approval", async change => {
    const h = fixture(); h.config({ completeOnCreate: false, loss: null, writeResponse: (_order, stage) => {
      if (stage !== "create") return;
      if (change === "approval") h.db.run("UPDATE approvals SET status='void'");
      if (change === "pause") h.app.pause();
      if (change === "budget") h.app.updateBudget({ monthlyLimitCents: 10000 });
      if (change === "source") h.env.PAYPAL_VAULT_ID = "different-before-capture";
    } });
    const p = await h.start();
    expect(h.calls.filter(call => call.path.endsWith("/capture"))).toHaveLength(0);
    expect(h.counts()).toEqual({ creates: 1, captures: 0 });
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("unknown");
  });

  it.each(["create", "capture"].flatMap(stage => [null, "", "undefined", 1, "not-a-uuid", "same-as-other-stage"].map(invalid => ({ stage, invalid }))))
    ("fails closed for invalid $stage Request-Id metadata: $invalid", async ({ stage, invalid }) => {
    const h = fixture();
    if (stage === "capture") h.config({ completeOnCreate: false, loss: "capture-after" });
    const p = await h.start(); const a = h.attempt(p.orderId);
    h.store.save({ ...a, [stage === "create" ? "createRequestId" : "captureRequestId"]:
      invalid === "same-as-other-stage" ? a[stage === "create" ? "captureRequestId" : "createRequestId"] : invalid });
    expect(h.app.home().paymentRecovery?.recoverable).toBe(false);
    await expect(h.recover()).rejects.toThrow();
    expect(h.calls.filter(call => call.path === "/v2/checkout/orders")).toHaveLength(1);
    expect(h.calls.filter(call => call.path.endsWith("/capture"))).toHaveLength(stage === "capture" ? 1 : 0);
    expect(h.counts()).toEqual({ creates: 1, captures: 1 });
  });

  it.each(["create", "capture"].flatMap(stage => [null, 123, " ", "bad/id", "x".repeat(65)].map(invalid => ({ stage, invalid }))))
    ("keeps an invalid capture receipt ID unknown in the first $stage response: $invalid", async ({ stage, invalid }) => {
    const h = fixture(); h.config({ loss: null, completeOnCreate: stage === "create", writeResponse: (order, current) => {
      if (stage === current) order.purchase_units[0]!.payments!.captures[0]!.id = invalid;
    } });
    const p = await h.start();
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("unknown");
    expect(h.attempt(p.orderId)).toMatchObject({ status: "unknown", replayBlocked: true, responseMismatch: true });
    expect(h.app.budget()).toMatchObject({ monthSettledCents: 0, monthCommittedCents: 7299 });
    expect(h.calls.filter(call => call.path.endsWith("/capture"))).toHaveLength(stage === "capture" ? 1 : 0);
  });

  it.each(["create", "capture"].flatMap(stage => ["pending", "missing capture", "missing capture status", "order not completed"].map(outcome => ({ stage, outcome }))))
    ("does not mark an unfinished $stage response paid: $outcome", async ({ stage, outcome }) => {
    const h = fixture(); h.config({ loss: null, completeOnCreate: stage === "create", writeResponse: (order, current) => {
      if (stage !== current) return;
      const unit = order.purchase_units[0]!;
      if (outcome === "pending") unit.payments!.captures[0]!.status = "PENDING";
      if (outcome === "missing capture") unit.payments!.captures = [];
      if (outcome === "missing capture status") delete unit.payments!.captures[0]!.status;
      if (outcome === "order not completed") order.status = "APPROVED";
    } });
    const p = await h.start();
    expect(h.app.orderDetails(p.orderId)).toMatchObject({ status: "reconciling", paymentStatus: "unknown" });
    expect(h.attempt(p.orderId).status).toBe("unknown");
    expect(h.app.budget()).toMatchObject({ monthSettledCents: 0, monthCommittedCents: 7299 });
    expect(h.calls.filter(call => call.path.endsWith("/capture"))).toHaveLength(stage === "capture" ? 1 : 0);
  });

  it.each(["approval", "pause", "snapshot", "budget", "source", "capture Request-Id"])
    ("rechecks %s after a genuinely awaited second OAuth before initial capture", async change => {
    const h = fixture();
    let release!: () => void, observed!: () => void, tokenCalls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { observed = resolve; });
    h.config({ loss: null, completeOnCreate: false, tokenExpiresIn: 60, beforeToken: async () => {
      if (++tokenCalls !== 2) return;
      observed(); await held;
    } });
    const starting = h.start(); await seen;
    const id = h.db.get<{ id: string }>("SELECT id FROM orders")!.id;
    if (change === "approval") h.db.run("UPDATE approvals SET status='void'");
    if (change === "pause") h.app.pause();
    if (change === "snapshot") h.db.run("UPDATE orders SET quantity_grams=4000");
    if (change === "budget") h.app.updateBudget({ monthlyLimitCents: 10000 });
    if (change === "source") h.env.PAYPAL_VAULT_ID = "changed-during-capture-oauth";
    if (change === "capture Request-Id") h.store.save({ ...h.attempt(id), captureRequestId: undefined });
    release(); const p = await starting;
    expect(tokenCalls).toBe(2);
    expect(h.calls.filter(call => call.path.endsWith("/capture"))).toHaveLength(0);
    expect(h.counts()).toEqual({ creates: 1, captures: 0 });
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("unknown");
    expect(h.app.budget()).toMatchObject({ monthSettledCents: 0, monthCommittedCents: 7299 });
    expect(h.attempt(p.orderId).captureFirstSentAt).toBeUndefined();
  });

  it("does not send an initially prepared request whose persisted ID vanished during OAuth", async () => {
    const h = fixture(); h.config({ loss: null, beforeToken: () => {
      const key = h.db.get<{ id: string }>("SELECT id FROM orders")!.id;
      h.store.save({ ...h.attempt(key), createRequestId: undefined });
    } });
    const p = await h.start();
    expect(h.calls.filter(call => call.path.startsWith("/v2/"))).toHaveLength(0);
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("unknown");
  });

  it.each(["source", "budget", "pause", "window"])("rechecks %s after waiting for OAuth and immediately before replay", async change => {
    const h = fixture(); await h.start(); const restarted = h.makeApp();
    h.config({ beforeToken: () => {
      if (change === "source") h.env.PAYPAL_VAULT_ID = "changed-during-oauth";
      if (change === "budget") restarted.updateBudget({ monthlyLimitCents: 10000 });
      if (change === "pause") restarted.pause();
      if (change === "window") h.advance(PAYMENT_REPLAY_WINDOW_MS);
    } });
    await expect(h.recover(restarted)).rejects.toThrow();
    expect(h.calls.filter(call => call.path === "/v2/checkout/orders")).toHaveLength(1);
    expect(h.counts()).toEqual({ creates: 1, captures: 1 });
    expect(restarted.budget().monthCommittedCents).toBe(7299);
  });

  it("requires the viewed amount, snapshot and attempt at the HTTP recovery boundary", async () => {
    const h = fixture(); await h.start(); const r = h.app.home().paymentRecovery!;
    const operatorCode = randomUUID();
    const server = createApiServer(h.app, { maintenanceToken: operatorCode });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const recover = (body: unknown) => fetch(`${origin}/v1/orders/${r.orderId}/recover-payment`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${operatorCode}` }, body: JSON.stringify(body) });
    const body = { expectedTotalCents: r.totalCents, approvalSnapshot: r.approvalSnapshot, expectedAttemptId: r.attemptId };
    try {
      for (const invalid of [{}, { ...body, approvalSnapshot: "b".repeat(64) }, { ...body, expectedTotalCents: 1 }, { ...body, expectedAttemptId: "b".repeat(36) }]) {
        expect((await recover(invalid)).status).toBe(400);
      }
      expect(h.calls.filter(call => call.path === "/v2/checkout/orders")).toHaveLength(1);
      expect((await recover(body)).status).toBe(200);
      expect(h.counts()).toEqual({ creates: 1, captures: 1 });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("can resume a prepared attempt interrupted before its first send without inventing an old send time", async () => {
    const h = fixture(); h.config({ loss: "oauth" }); const p = await h.start();
    const a = h.attempt(p.orderId);
    expect(a.phase).toBe("prepared"); expect(a.createFirstSentAt).toBeUndefined();
    h.advance(1000); await h.recover();
    expect(h.attempt(p.orderId).createFirstSentAt).toBe(h.now());
    expect(h.attempt(p.orderId).attemptId).toBe(a.attemptId);
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("paid");
    expect(h.counts()).toEqual({ creates: 1, captures: 1 });
  });

  it("recovers a lost create response after reopening SQLite, reuses the original request and settles once", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "replenish-recovery-")), "household.sqlite");
    const h = fixture(file), p = await h.start();
    const first = h.attempt(p.orderId);
    expect(first).toMatchObject({ phase: "create", status: "unknown" });
    expect(first.orderId).toBeUndefined();
    const restarted = h.makeApp(new SqliteDatabase(file));
    await restarted.checkPayment(p.orderId);
    expect(h.calls.filter(call => call.path === "/v2/checkout/orders")).toHaveLength(1);
    await h.recover(restarted);
    expect(restarted.orderDetails(p.orderId)).toMatchObject({ paymentStatus: "paid", status: "ordered" });
    expect(h.attempt(p.orderId)).toMatchObject({ status: "paid", orderId: "REMOTE1", captureId: "CAPTURE1" });
    const posts = h.calls.filter(call => call.path === "/v2/checkout/orders");
    expect(posts).toHaveLength(2); expect(posts[0]!.id).toBe(posts[1]!.id); expect(posts[0]!.body).toBe(posts[1]!.body);
    expect(h.attempt(p.orderId).createFirstSentAt).toBe(first.createFirstSentAt);
    expect(h.counts()).toEqual({ creates: 1, captures: 1 });
    expect(restarted.budget()).toMatchObject({ monthSettledCents: 7299, monthCommittedCents: 0 });
    expect(restarted.home().feeding.stockG).toBe(1200);
    restarted.receive(p.orderId); const stock = restarted.home().feeding.stockG;
    restarted.receive(p.orderId); expect(restarted.home().feeding.stockG).toBe(stock);
  });

  it("uses GET after capture loss, without any repeated write", async () => {
    const h = fixture(); h.config({ completeOnCreate: false, loss: "capture-after" }); const p = await h.start();
    const postsBefore = h.calls.filter(call => call.method === "POST").length;
    await h.app.checkPayment(p.orderId);
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("paid");
    expect(h.calls.filter(call => call.method === "POST")).toHaveLength(postsBefore);
    expect(h.attempt(p.orderId).captureRequestId).not.toBe(h.attempt(p.orderId).createRequestId);
    expect(h.counts()).toEqual({ creates: 1, captures: 1 });
  });

  it.each([false, true])("queries and registers ORDER_ALREADY_CAPTURED (replay=%s) instead of failing", async replay => {
    const h = fixture(); h.config({ completeOnCreate: false, loss: replay ? "capture-after" : null, alreadyCaptured: !replay });
    const p = await h.start();
    if (replay) { h.config({ staleGets: 1 }); await h.recover(); }
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("paid");
    const captures = h.calls.filter(call => call.path.endsWith("/capture"));
    expect(captures).toHaveLength(replay ? 2 : 1);
    expect(new Set(captures.map(call => call.id)).size).toBe(1);
    expect(h.counts().captures).toBe(1);
  });

  it("finds an unpaid order without chaining capture; a second explicit confirmation completes it", async () => {
    const h = fixture(); h.config({ completeOnCreate: false }); const p = await h.start();
    await h.recover(); expect(h.counts()).toEqual({ creates: 1, captures: 0 });
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("unknown");
    expect(h.attempt(p.orderId).phase).toBe("found");
    h.advance(5_001); await h.recover();
    expect(h.counts()).toEqual({ creates: 1, captures: 1 });
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("paid");
  });

  it.each(["pause", "budget", "approval", "snapshot", "month"])("rechecks %s before a previously undelivered create may reach PayPal", async change => {
    const h = fixture(); h.config({ loss: "create-before" }); const p = await h.start();
    if (change === "pause") h.app.pause();
    if (change === "budget") h.app.updateBudget({ monthlyLimitCents: 10000 });
    if (change === "approval") h.db.run("UPDATE approvals SET status='void'");
    if (change === "snapshot") h.db.run("UPDATE orders SET quantity_grams=4000 WHERE id=?", [p.orderId]);
    if (change === "month") h.advance(32 * 86400_000);
    await expect(h.recover()).rejects.toThrow();
    expect(h.calls.filter(call => call.path === "/v2/checkout/orders")).toHaveLength(1);
    expect(h.counts()).toEqual({ creates: 0, captures: 0 });
    expect(h.app.budget().monthCommittedCents).toBe(7299);
  });

  it.each([PAYMENT_REPLAY_WINDOW_MS, -1])("never extends the original stage window or accepts a backwards clock (%s)", async delta => {
    const h = fixture(); const p = await h.start(); const first = h.attempt(p.orderId).createFirstSentAt;
    const r = h.app.home().paymentRecovery!;
    h.advance(delta); await expect(h.app.recoverPayment(r.orderId, r.totalCents, r.approvalSnapshot, r.attemptId)).rejects.toThrow();
    expect(h.calls.filter(call => call.path === "/v2/checkout/orders")).toHaveLength(1);
    expect(h.attempt(p.orderId).createFirstSentAt).toBe(first);
  });

  it.each(["amount", "reference", "multiple"])("permanently prevents replay after remote %s mismatch", async mismatch => {
    const h = fixture(); const p = await h.start();
    h.config({ changed: order => {
      if (mismatch === "amount") order.purchase_units[0]!.amount.value = "1.00";
      if (mismatch === "reference") order.purchase_units[0]!.reference_id = "other-attempt";
      if (mismatch === "multiple") order.purchase_units.push(structuredClone(order.purchase_units[0]!));
    } });
    await h.recover(); expect(h.attempt(p.orderId)).toMatchObject({ replayBlocked: true, status: "unknown" });
    const posts = h.calls.filter(call => call.method === "POST").length;
    await expect(h.recover()).rejects.toThrow();
    expect(h.calls.filter(call => call.method === "POST")).toHaveLength(posts);
  });

  it("refuses a changed payment source without persisting the vault or credentials", async () => {
    const h = fixture(); const p = await h.start(); h.env.PAYPAL_VAULT_ID = "another-test-vault";
    await expect(h.recover()).rejects.toThrow();
    expect(h.calls.filter(call => call.path === "/v2/checkout/orders")).toHaveLength(1);
    const stored = h.db.get<{ data_json: string }>("SELECT data_json FROM payment_attempts")!.data_json;
    for (const value of Object.values(h.env)) if (value !== "card") expect(stored).not.toContain(value);
    expect(h.attempt(p.orderId).replayBlocked).toBe(true);
  });

  it("claims concurrent recovery in SQLite before either request can write to PayPal", async () => {
    const h = fixture(); await h.start(); let release!: () => void;
    h.config({ hold: new Promise<void>(resolve => { release = resolve; }) });
    const first = h.recover(); await expect(h.recover()).rejects.toThrow(/busy/);
    release(); await first; expect(h.counts()).toEqual({ creates: 1, captures: 1 });
  });

  it("requires new approval and new stage IDs after a declined card before changing payment method", async () => {
    const h = fixture(); h.config({ loss: null, decline: true }); const p = await h.start();
    const original = h.attempt(p.orderId);
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("failed");
    expect(h.calls.some(call => call.path.startsWith("/v3/vault/"))).toBe(false);
    h.env.PAYPAL_VAULT_SOURCE = "paypal"; h.env.PAYPAL_VAULT_ID = "test-wallet"; h.config({ decline: false });
    expect(h.counts().captures).toBe(0);
    const pending = h.app.home().pendingApproval!;
    await h.app.approve(pending.orderId, pending.totalCents, pending.approvalSnapshot);
    const next = h.attempt(p.orderId);
    for (const field of ["attemptId", "authorizationId", "createRequestId", "captureRequestId"] as const) expect(next[field]).not.toBe(original[field]);
    expect(h.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM payment_attempts")?.count).toBe(2);
    expect(h.counts().captures).toBe(1);
  });

  it("imports an old unknown file once, preserves the budget hold, and never invents replay metadata", async () => {
    const h = fixture(); const p = (await h.app.reorderNow()).pendingApproval!;
    const directory = mkdtempSync(path.join(tmpdir(), "replenish-legacy-"));
    new FilePaymentAttemptStore(directory).save({ idempotencyKey: p.orderId, amountCents: 7299, currency: "USD", sku: "RC-SMALL-8", status: "unknown" });
    h.db.run("UPDATE orders SET payment_status='unknown', status='reconciling'");
    expect(h.store.importLegacy(directory)).toBe(1); expect(h.store.importLegacy(directory)).toBe(0);
    expect(h.attempt(p.orderId)).toMatchObject({ status: "unknown", phase: "legacy", replayBlocked: true });
    for (const key of ["attemptId", "createFirstSentAt", "createRequestId"] as const) expect(h.attempt(p.orderId)[key]).toBeUndefined();
    expect(h.app.home().paymentRecovery).toBeNull();
    await h.app.checkPayment(p.orderId); expect(h.calls).toHaveLength(0);
    expect(h.app.budget().monthCommittedCents).toBe(7299);
    expect(h.db.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check).toBe("ok");
  });

  it("rolls back the order claim if the attempt cannot be persisted", async () => {
    const h = fixture(); const p = (await h.app.reorderNow()).pendingApproval!;
    h.db.exec("CREATE TRIGGER fail_attempt BEFORE INSERT ON payment_attempts BEGIN SELECT RAISE(ABORT,'simulated disk write failure'); END;");
    await expect(h.app.approve(p.orderId, p.totalCents, p.approvalSnapshot)).rejects.toThrow();
    expect(h.app.orderDetails(p.orderId)).toMatchObject({ paymentStatus: "none", status: "awaiting_approval" });
    expect(h.store.load(p.orderId)).toBeNull(); expect(h.calls).toHaveLength(0);
  });

  it("keeps the attempt unknown when the local paid-order commit fails, then reconciles both together", async () => {
    const h = fixture(); h.config({ loss: null });
    h.db.exec("CREATE TRIGGER fail_paid BEFORE UPDATE OF payment_status ON orders WHEN NEW.payment_status='paid' BEGIN SELECT RAISE(ABORT,'simulated commit failure'); END;");
    const p = await h.start();
    expect(h.attempt(p.orderId)).toMatchObject({ phase: "verified_paid", status: "unknown" });
    expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("unknown");
    h.db.exec("DROP TRIGGER fail_paid"); await h.app.checkPayment(p.orderId);
    expect(h.attempt(p.orderId).status).toBe("paid"); expect(h.app.orderDetails(p.orderId).paymentStatus).toBe("paid");
    expect(h.counts().captures).toBe(1);
  });
});
