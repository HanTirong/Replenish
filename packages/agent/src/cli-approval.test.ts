import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonHouseholdRepository } from "@replenish/domain";
import { StoreService } from "@replenish/store";
import { runCli } from "./cli";
import type { PaymentAttempt } from "./payment-attempts";
import { PaymentUnknownError } from "./payments";
import { buildPipHousehold, LARGE_BAG_SKU } from "./seed";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "replenish-cli-approval-"));
  const env = { DATA_DIR: directory, PAYMENT_PROVIDER: "paypal", PAYPAL_CLIENT_ID: "test-client",
    PAYPAL_CLIENT_SECRET: "test-secret", PAYPAL_VAULT_ID: "test-vault" };
  const household = new JsonHouseholdRepository(path.join(directory, "household.json"));
  household.save(buildPipHousehold({ openedOn: "2026-10-01", preferredSku: LARGE_BAG_SKU }));
  await runCli(["tick", "--date", "2026-10-16"], env, () => {});
  const id = household.load().replenishments[0]!.id;
  let decline = true, loseCapture = false, beforeToken: (() => void) | undefined;
  const calls: { path: string; requestId: string | null; body: Record<string, unknown> }[] = [];
  let unit: Record<string, unknown> = {};
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", (async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/v1/oauth2/token") {
      beforeToken?.(); return json({ access_token: "test-access", expires_in: 3600 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: pathname, requestId: new Headers(init?.headers).get("PayPal-Request-Id"), body });
    if (pathname === "/v2/checkout/orders") {
      if (decline) return json({ details: [{ issue: "INSTRUMENT_DECLINED" }] }, 422);
      unit = (body.purchase_units as Record<string, unknown>[])[0]!;
      return json({ id: "CLI-ORDER", status: "APPROVED", purchase_units: [unit] });
    }
    if (pathname === "/v2/checkout/orders/CLI-ORDER/capture") {
      if (loseCapture) throw new TypeError("Simulated lost capture acknowledgement");
      return json({ id: "CLI-ORDER", status: "COMPLETED", purchase_units: [{ ...unit,
        payments: { captures: [{ id: "CLI-CAPTURE", status: "COMPLETED", amount: unit.amount }] } }] });
    }
    throw new Error("Unexpected simulated request");
  }) satisfies typeof fetch);
  const approve = () => runCli(["approve", id, "--date", "2026-10-17"], env, () => {});
  const attempts = () => {
    const db = new DatabaseSync(path.join(directory, "paypal-attempts.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT data_json FROM payment_attempts ORDER BY rowid").all()
      .map(row => JSON.parse(row.data_json as string) as PaymentAttempt); }
    finally { db.close(); }
  };
  return { env, id, household, calls, attempts, approve, directory,
    allow: () => { decline = false; }, loseCapture: () => { loseCapture = true; },
    beforeToken: (callback: () => void) => { beforeToken = callback; } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("CLI explicit payment approval", () => {
  it("persists each snapshot-bound approval and starts a new attempt after a definite decline, including a CLI restart", async () => {
    const h = await fixture();
    await expect(h.approve()).rejects.toThrow(/INSTRUMENT_DECLINED/);
    const first = h.attempts()[0]!;
    expect(first.status).toBe("failed");
    expect(h.household.load().replenishments[0]!.status).toBe("pending_approval");
    h.allow();
    await h.approve(); // runCli opens a fresh provider and the persisted household/journal again.
    const attempts = h.attempts(), second = attempts[1]!;
    expect(attempts).toHaveLength(2);
    for (const field of ["authorizationId", "attemptId", "createRequestId", "captureRequestId"] as const) {
      expect(first[field]).toBeTruthy(); expect(second[field]).toBeTruthy(); expect(second[field]).not.toBe(first[field]);
    }
    expect(second.approvalSnapshot).toMatch(/^[a-f0-9]{64}$/);
    expect(second.approvalSnapshot).toBe(first.approvalSnapshot);
    const record = h.household.load().replenishments[0]!;
    expect(record.paymentApproval).toEqual({ authorizationId: second.authorizationId, snapshot: second.approvalSnapshot, approvedOn: "2026-10-17" });
    expect(record.status).toBe("ordered");
    expect(h.calls.filter(call => call.path === "/v2/checkout/orders")).toHaveLength(2);
    expect(h.calls.filter(call => call.path.endsWith("/capture"))).toHaveLength(1);
    expect(new Set(h.calls.map(call => call.requestId)).size).toBe(3);
    expect(StoreService.open(path.join(h.directory, "store.json")).snapshot().orders).toHaveLength(1);
    await expect(h.approve()).rejects.toThrow(/not waiting for confirmation/);
    expect(h.calls).toHaveLength(3);
  });

  it("does not turn another explicit approval of an unknown result into a replacement payment", async () => {
    const h = await fixture(); h.allow(); h.loseCapture();
    await expect(h.approve()).rejects.toBeInstanceOf(PaymentUnknownError);
    const original = h.attempts()[0]!;
    await expect(h.approve()).rejects.toBeInstanceOf(PaymentUnknownError);
    expect(h.attempts()).toEqual([original]);
    expect(h.calls.filter(call => call.path === "/v2/checkout/orders")).toHaveLength(1);
    expect(h.calls.filter(call => call.path.endsWith("/capture"))).toHaveLength(1);
    expect(h.household.load().replenishments[0]!.status).toBe("pending_approval");
  });

  it("checks the persisted approval snapshot again after OAuth before submitting any order", async () => {
    const h = await fixture(); h.allow();
    h.beforeToken(() => {
      const changed = h.household.load(); changed.replenishments[0]!.quantity = 2; h.household.save(changed);
    });
    await expect(h.approve()).rejects.toBeInstanceOf(PaymentUnknownError);
    expect(h.calls).toHaveLength(0);
    expect(h.attempts()).toHaveLength(1);
    expect(h.attempts()[0]).toMatchObject({ status: "unknown", phase: "prepared" });
  });

  it("does not send a payment when the approval cannot be saved", async () => {
    const h = await fixture(); h.allow();
    vi.spyOn(JsonHouseholdRepository.prototype, "save").mockImplementation(() => { throw new Error("Simulated approval save failure"); });
    await expect(h.approve()).rejects.toThrow("Simulated approval save failure");
    expect(h.calls).toHaveLength(0);
  });
});
