import { describe, expect, it } from "vitest";
import { formatOrderDate, homeReorderReason } from "@replenish/domain";
import { SqliteDatabase } from "./db";
import { HouseholdApp, paidReason, resolvePreferredProduct, type PaymentGateway } from "./service";

const AS_OF = new Date("2026-11-01T08:00:00.000Z");

function app(overrides: {
  sku?: string;
  priceCents?: number;
  payments?: PaymentGateway;
  vault?: {
    hasPaymentToken(): boolean;
    summary?: () => { connected: boolean; last4: string | null };
    ensure?: () => Promise<{ vaultId: string; last4: string | null }>;
    clear?: () => void;
  };
} = {}) {
  const payments: PaymentGateway = overrides.payments ?? {
    async charge() {
      return { paymentId: "pay_test" };
    },
    async query() {
      return "not_found";
    },
  };
  return new HouseholdApp({
    db: new SqliteDatabase(":memory:"),
    clock: () => AS_OF,
    payments,
    timeZone: "UTC",
    vault: overrides.vault ?? { hasPaymentToken: () => false },
    env: {},
    sku: overrides.sku,
    priceCents: overrides.priceCents,
  });
}

describe("household API copy", () => {
  it("states the reorder date on the home screen and when a skipped dinner does not move the plan", async () => {
    const household = app();
    const home = household.home();
    const stayed = formatOrderDate(new Date(home.orderDateRaw), "UTC");
    expect(home.orderDate).toBe(stayed);
    expect(home.headline).toMatch(/^Qizai has about \d+ day(?:s)? of food left\.$/);
    expect(home.headline).not.toMatch(/\d+\.\d+/);
    expect(home.reason).toBe(homeReorderReason(stayed));
    expect(home.reason).toBe(`I'll reorder on ${stayed} so it arrives before food runs out.`);

    const skipped = await household.chat("skip dinner tomorrow");
    expect(skipped.headline).toBe("Noted. Qizai skips dinner tomorrow.");
    expect(skipped.reason).toBe(`That's half a day of food, so the reorder date stays ${stayed}.`);
    expect(skipped.decision?.orderDate).toBe(stayed);
    expect(skipped.decision?.orderDateRaw).toBe(home.orderDateRaw);
    expect(skipped.decision?.planChanged).toBe(false);

    const after = household.home();
    expect(after.headline).toMatch(/^Qizai has about \d+ day(?:s)? of food left\.$/);
    expect(after.reason).toBe(homeReorderReason(stayed));
    expect(after.notice).toEqual({
      headline: "Noted. Qizai skips dinner tomorrow.",
      reason: `That's half a day of food, so the reorder date stays ${stayed}.`,
    });
    expect(after.orderDateRaw).toBe(home.orderDateRaw);
  });

  it("names the new reorder date when a permanent change moves the plan", async () => {
    const household = app();
    const before = household.home().orderDateRaw;
    const changed = await household.chat("以后每顿少喂10g");
    expect(changed.decision?.planChanged).toBe(true);
    const next = formatOrderDate(new Date(changed.decision?.orderDateRaw ?? before), "UTC");
    expect(changed.reason).toBe(`I recalculated the estimate and moved the reorder date to ${next}.`);
    expect(changed.decision?.orderDate).toBe(next);
    expect(changed.decision?.orderDateRaw).not.toBe(before);
    expect(household.home().headline).toMatch(/^Qizai has about \d+ day(?:s)? of food left\.$/);
    expect(household.home().notice?.headline).toBe(changed.headline);
    expect(household.home().notice?.reason).toBe(changed.reason);
    expect(household.home().orderDateRaw).toBe(changed.decision?.orderDateRaw);
  });

  it("pauses new orders from chat and leaves the feeding plan in place", async () => {
    const household = app();
    const before = household.home().orderDateRaw;
    const paused = await household.chat("pause orders until next week");
    expect(paused.command).toEqual({ type: "pause_orders", until: "2026-11-08" });
    expect(paused.headline).toBe("Paused orders until 2026-11-08.");
    expect(paused.reason).toContain("2026-11-08 at 00:00 (UTC)");
    expect(household.home().autopilotResumeAt).toBe("2026-11-08T00:00:00.000Z");
    expect(household.home().orderDateRaw).toBe(before);
    await expect(household.createOrder()).rejects.toThrow(/paused/i);
  });
});

describe("demo reorder and PayPal approval", () => {
  it("defaults the API server to the 8 kg bag and lets PREFERRED_SKU override it", () => {
    expect(resolvePreferredProduct({})).toEqual({ sku: "RC-SMALL-8", priceCents: 7299 });
    expect(resolvePreferredProduct({ PREFERRED_SKU: "RC-SMALL-4" })).toEqual({ sku: "RC-SMALL-4", priceCents: 3500 });
    expect(() => resolvePreferredProduct({ PREFERRED_SKU: "NO-SUCH" })).toThrow(/NO-SUCH/);
  });

  it("creates an over-cap approval only when the reorder check is run, and names the $50 limit", async () => {
    const household = app({ sku: "RC-SMALL-8", priceCents: 7299 });
    expect(await household.runDueJobs()).toEqual([]);
    const home = await household.reorderNow();
    expect(home.pendingApproval).toMatchObject({
      sku: "RC-SMALL-8",
      totalCents: 7299,
      productName: "Taste of the Wild",
      productDetail: "Pacific Stream Small Breed · 8 kg",
    });
    expect(home.reason).toBe("It exceeds the $50 per-order limit.");
    expect(home.pendingApproval?.violations.map((item) => item.code)).toEqual(["per_order"]);
  });

  it("does not claim a per-order limit breach when the bag is inside the cap", async () => {
    const household = app();
    const home = await household.reorderNow();
    expect(home.pendingApproval?.totalCents).toBe(3500);
    expect(home.reason).toBe("Automatic PayPal payment is not authorized yet, so this order needs your approval.");
    expect(home.reason).not.toMatch(/per-order limit/i);
  });

  it("vaults on Connect and shows the card last 4", async () => {
    let vaulted = false;
    const household = app({
      vault: {
        hasPaymentToken: () => vaulted,
        summary: () => ({ connected: vaulted, last4: vaulted ? "1881" : null }),
        ensure: async () => {
          vaulted = true;
          return { vaultId: "VAULT1", last4: "1881" };
        },
      },
    });
    const connected = await household.connectPaypal();
    expect(connected.paypal).toMatchObject({ connected: true, last4: "1881" });
  });

  it("leaves PayPal disconnected when vaulting fails", async () => {
    const household = app({
      vault: {
        hasPaymentToken: () => false,
        ensure: async () => {
          throw Object.assign(new Error("vault failed"), { name: "UNPROCESSABLE_ENTITY", debugId: "DBG9" });
        },
      },
    });
    await expect(household.connectPaypal()).rejects.toThrow(/vault failed/);
    expect(household.home().paypal.connected).toBe(false);
  });

  it("records the PayPal capture id after approval and the debug id when the charge fails", async () => {
    const paid = app({
      sku: "RC-SMALL-8",
      priceCents: 7299,
      payments: {
        async charge() {
          return { paymentId: "ORDER1", captureId: "CAP123" };
        },
        async query() {
          return "not_found";
        },
      },
    });
    const created = await paid.reorderNow();
    const orderId = created.pendingApproval?.orderId;
    if (!orderId) throw new Error("missing order");
    const approved = (await paid.approve(orderId, 7299, paid.orderDetails(orderId).approvalSnapshot)) as {
      order: { status: string; paypalOrderId: string | null; captureId: string | null };
      charged: boolean;
    };
    expect(approved.order.status).toBe("ordered");
    expect(approved.charged).toBe(true);
    expect(approved.order.paypalOrderId).toBe("ORDER1");
    expect(approved.order.captureId).toBe("CAP123");
    expect(paid.home().reason).toBe(paidReason("CAP123"));
    expect(paid.home().reason).toBe("Paid with PayPal · …CAP123");
    expect(paid.home().payment).toEqual({ paypalOrderId: "ORDER1", captureId: "CAP123" });

    const failed = app({
      sku: "RC-SMALL-8",
      priceCents: 7299,
      payments: {
        async charge() {
          throw Object.assign(new Error("declined"), { issue: "PAYER_ACTION_REQUIRED", debugId: "DBG123" });
        },
        async query() {
          return "not_found";
        },
      },
    });
    const pending = await failed.reorderNow();
    const failedId = pending.pendingApproval?.orderId;
    if (!failedId) throw new Error("missing order");
    const result = (await failed.approve(failedId, 7299, failed.orderDetails(failedId).approvalSnapshot)) as { order: { status: string }; charged: boolean };
    expect(result.order.status).toBe("failed");
    expect(result.charged).toBe(false);
    const retry = failed.home();
    expect(retry.pendingApproval?.retry).toBe(true);
    expect(retry.pendingApproval?.failure).toBe("PAYER_ACTION_REQUIRED · debug_id DBG123");
    expect(retry.reason).toBe("It exceeds the $50 per-order limit.");
  });

  it("does not mark PayPal connected when authorize has no vault token", () => {
    const household = app();
    household.authorizePaypal();
    expect(household.home().paypal.connected).toBe(false);
    expect(household.home().paypal.automaticPaymentAuthorized).toBe(false);
  });

  it("resets orders and feeding, and drops the vault only when asked", async () => {
    let cleared = false;
    const household = app({
      vault: {
        hasPaymentToken: () => !cleared,
        summary: () => ({ connected: !cleared, last4: cleared ? null : "1881" }),
        clear: () => {
          cleared = true;
        },
      },
    });
    await household.reorderNow();
    expect(household.home().pendingApproval).toBeTruthy();
    const kept = household.resetDemo(false);
    expect(kept.pendingApproval).toBeNull();
    expect(kept.feeding.stockG).toBe(1200);
    expect(kept.feeding.gramsPerMeal).toBe(75);
    expect(kept.feeding.mealsPerDay).toBe(2);
    expect(kept.paypal.connected).toBe(true);
    expect(kept.paypal.status).toBe("connected");
    expect(cleared).toBe(false);
    const dropped = household.resetDemo(true);
    expect(dropped.paypal.connected).toBe(false);
    expect(cleared).toBe(true);
  });
});
