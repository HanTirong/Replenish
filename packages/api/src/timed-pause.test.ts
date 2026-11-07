import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PaymentUnknownError } from "@replenish/agent";
import { SqliteDatabase } from "./db";
import { HouseholdApp, type PaymentGateway } from "./service";

function household(timeZone = "UTC", start = "2026-11-01T08:00:00Z", payments?: PaymentGateway, persistent = false) {
  let now = new Date(start), vaulted = true;
  const file = persistent ? path.join(mkdtempSync(path.join(tmpdir(), "replenish-pause-")), "state.sqlite") : ":memory:";
  const db = new SqliteDatabase(file);
  const charge = vi.fn(async () => ({ paymentId: "simulated-payment" }));
  const options = { db, clock: () => new Date(now), env: {}, timeZone, sku: "RC-SMALL-8", priceCents: 7299,
    payments: payments ?? { query: async () => "not_found" as const, charge }, vault: { hasPaymentToken: () => vaulted } };
  return { app: new HouseholdApp(options), db, charge, options, file,
    at: (instant: string) => { now = new Date(instant); }, vault: (value: boolean) => { vaulted = value; } };
}

describe("dated buying pause", () => {
  it("persists across a new database connection, resumes exactly once, and requires approval above the current limit", async () => {
    const h = household("UTC", undefined, undefined, true);
    h.app.authorizePaypal(); await h.app.chat("暂停到11月6日");
    const restarted = new HouseholdApp({ ...h.options, db: new SqliteDatabase(h.file) });
    h.at("2026-11-05T23:59:59Z"); await restarted.runDueJobs();
    expect(restarted.home().autopilot).toBe("paused"); expect(h.charge).not.toHaveBeenCalled();
    h.at("2026-11-06T00:00:00Z");
    expect(restarted.home().autopilot).toBe("paused"); // A GET does not start buying.
    await Promise.all([restarted.runDueJobs(), restarted.runDueJobs()]);
    expect(restarted.home().autopilotResumeAt).toBeNull(); expect(restarted.home().autopilot).toBe("active");
    expect(restarted.home().pendingApproval?.violations[0]?.code).toBe("per_order"); expect(h.charge).not.toHaveBeenCalled();
    expect(restarted.orders()).toHaveLength(1);
    expect(h.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM activities WHERE summary LIKE 'Automatically resumed%'")?.count).toBe(1);
  });

  it("uses local midnight through the daylight-saving transition", async () => {
    const h = household("America/Los_Angeles", "2026-10-31T23:00:00Z");
    const paused = await h.app.chat("pause orders until 2026-11-02");
    expect(paused.reason).toContain("00:00 (America/Los_Angeles)");
    expect(h.app.home().autopilotResumeAt).toBe("2026-11-02T08:00:00.000Z");
    const restarted = new HouseholdApp({ ...h.options, timeZone: undefined });
    expect(restarted.home().autopilotPauseReason).toContain("America/Los_Angeles");
    h.at("2026-11-02T07:59:59Z"); await restarted.runDueJobs(); expect(restarted.home().autopilot).toBe("paused");
    h.at("2026-11-02T08:00:00Z"); await restarted.runDueJobs(); expect(restarted.home().autopilot).toBe("active");
    expect(h.app.orders()).toHaveLength(0);
  });

  it("uses the household calendar rather than the server date", async () => {
    const h = household("Asia/Shanghai"); await h.app.chat("暂停到11月5日");
    expect(h.app.home().autopilotResumeAt).toBe("2026-11-04T16:00:00.000Z");
    h.at("2026-11-04T15:59:59Z"); await h.app.runDueJobs(); expect(h.app.home().autopilot).toBe("paused");
    h.at("2026-11-04T16:00:00Z"); await h.app.runDueJobs(); expect(h.app.home().autopilot).toBe("active");
  });

  it("cancels the deadline when the owner chooses an indefinite pause", async () => {
    const h = household(); await h.app.chat("暂停到11月5日"); h.app.pause();
    expect(h.app.home().autopilotResumeAt).toBeNull();
    h.at("2026-11-10T00:00:00Z"); await new HouseholdApp(h.options).runDueJobs();
    expect(h.app.home().autopilot).toBe("paused"); expect(h.app.orders()).toHaveLength(0);
    expect(h.app.home().notice?.reason).toContain("until you resume");
  });

  it("replaces a deadline and never executes the earlier one", async () => {
    const h = household(); await h.app.chat("暂停到11月5日"); await h.app.chat("暂停到11月10日");
    h.at("2026-11-06T00:00:00Z"); await h.app.runDueJobs();
    expect(h.app.home().autopilot).toBe("paused"); expect(h.app.home().autopilotResumeAt).toBe("2026-11-10T00:00:00.000Z");
    h.app.resume(); expect(h.app.home().autopilotResumeAt).toBeNull();
    h.app.pause(); h.at("2026-11-11T00:00:00Z"); await h.app.runDueJobs(); expect(h.app.home().autopilot).toBe("paused");
  });

  it.each([
    [8000, 12000, true, true, true], [5000, 12000, true, true, false],
    [8000, 7000, true, true, false], [8000, 12000, false, true, false], [8000, 12000, true, false, false],
  ])("checks current limits %i/%i, authorization %s and vault %s before buying", async (perOrder, monthly, authorized, vaulted, pays) => {
    const h = household(); if (authorized) h.app.authorizePaypal();
    await h.app.chat("暂停到11月6日"); h.app.updateBudget({ perOrderLimitCents: perOrder, monthlyLimitCents: monthly }); h.vault(vaulted);
    h.at("2026-11-06T00:00:00Z"); await h.app.runDueJobs(); await h.app.runDueJobs();
    expect(h.charge).toHaveBeenCalledTimes(pays ? 1 : 0);
    expect(h.app.orders()).toHaveLength(1);
    expect(h.app.home().pendingApproval !== null).toBe(!pays);
    if (monthly < 7299) expect(h.app.home().pendingApproval?.violations.some(item => item.code === "monthly")).toBe(true);
  });

  it("recalculates current food and replaces a stale due job before resuming", async () => {
    const h = household(); h.app.authorizePaypal(); await h.app.chat("暂停到11月6日"); h.app.calibrate(5000);
    h.db.run("UPDATE jobs SET run_at='2026-11-01T00:00:00.000Z',status='pending'");
    h.at("2026-11-06T00:00:00Z"); const stock = h.app.home().feeding.stockG;
    await h.app.runDueJobs(); expect(h.app.home().feeding.stockG).toBe(stock);
    expect(h.app.orders()).toHaveLength(0); expect(h.charge).not.toHaveBeenCalled();
    expect(Date.parse(h.app.home().orderDateRaw)).toBeGreaterThan(Date.parse("2026-11-06T00:00:00Z"));
  });

  it("keeps payment uncertainty on hold and honors a manual pause during asynchronous reconciliation", async () => {
    let block = false, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const charge = vi.fn(async () => { throw new PaymentUnknownError("Simulated lost acknowledgement", "simulated-payment"); });
    const h = household("UTC", undefined, { charge, query: async () => "not_found", lookup: async () => { if (block) await held; return { status: "not_found" }; } });
    const id = (await h.app.reorderNow()).pendingApproval!.orderId;
    await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot); await h.app.chat("暂停到11月6日");
    block = true; h.at("2026-11-06T00:00:00Z"); const tick = h.app.runDueJobs(); h.app.pause(); release(); await tick;
    expect(h.app.home().autopilot).toBe("paused"); expect(h.app.home().autopilotResumeAt).toBeNull();
    expect(h.app.orders()).toHaveLength(1); expect(h.app.orderDetails(id).paymentStatus).toBe("unknown"); expect(charge).toHaveBeenCalledTimes(1);
    block = false; await h.app.chat("暂停到11月7日"); h.at("2026-11-07T00:00:00Z"); await h.app.runDueJobs();
    expect(h.app.home().autopilot).toBe("active"); expect(h.app.orderDetails(id).paymentStatus).toBe("unknown");
    expect(h.app.orders()).toHaveLength(1); expect(charge).toHaveBeenCalledTimes(1);
  });

  it("does not replace a paid order or re-charge it when the pause ends", async () => {
    const h = household(); const id = (await h.app.reorderNow()).pendingApproval!.orderId; await h.app.approve(id, 7299, h.app.orderDetails(id).approvalSnapshot);
    await h.app.chat("暂停到11月6日"); h.at("2026-11-06T00:00:00Z"); await h.app.runDueJobs();
    expect(h.app.orderDetails(id).paymentStatus).toBe("paid"); expect(h.app.orders()).toHaveLength(1); expect(h.charge).toHaveBeenCalledTimes(1);
  });

  it("clarifies invalid dates without changing an existing pause, and reset clears its deadline", async () => {
    const h = household(); await h.app.chat("暂停到11月6日");
    for (const text of ["暂停到2026-02-30", "暂停到2026-11-01", "暂停到2026-10-31"]) expect((await h.app.chat(text)).command.type).toBe("clarify");
    expect(h.app.home().autopilotResumeAt).toBe("2026-11-06T00:00:00.000Z");
    h.app.resetDemo(); expect(h.app.home().autopilot).toBe("active"); expect(h.app.home().autopilotResumeAt).toBeNull();
  });
});
