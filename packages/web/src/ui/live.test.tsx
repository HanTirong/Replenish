/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { HomePayload, NotificationStatus } from "../api";

function home(): HomePayload {
  return {
    headline: "Qizai has about 8 days of food left.", reason: "I'll reorder on Nov 5 so it arrives before food runs out.",
    orderDate: "Nov 5", orderDateRaw: "2026-11-05T08:00:00Z", state: "scheduled", autopilot: "active",
    pet: { name: "Qizai", timezone: "UTC" },
    paypal: { connected: true, automaticPaymentAuthorized: true, status: "enabled", environment: "sandbox", last4: "1881" },
    payment: null, order: null, notice: null, undoRevisionId: 1, dates: [], budget: { perOrderLimitCents: 5000, monthlyLimitCents: 12000 },
    pendingApproval: null, plan: { orderDate: "Nov 5", orderDateRaw: "2026-11-05T08:00:00Z", planChanged: false },
    feeding: { stockG: 1200, gramsPerMeal: 75, mealsPerDay: 2, dailyGrams: 150 },
  };
}

function approval(): HomePayload {
  return {
    ...home(), headline: "Qizai's next order needs your approval.", state: "awaiting_approval",
    pendingApproval: {
      orderId: "isolated-order", approvalSnapshot: "a".repeat(64), totalCents: 7299, currency: "USD", sku: "RC-SMALL-8", merchant: "Example store",
      productName: "Taste of the Wild", productDetail: "Pacific Stream Small Breed · 8 kg", retry: false, failure: null,
      violations: [{ code: "per_order", limitCents: 5000, actualCents: 7299, overByCents: 2299, message: "Over limit" }],
    },
  };
}

function reply(body: unknown, status = 200): Response {
  return { ok: status < 400, json: async () => body } as Response;
}

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("live payment and receipt interactions", () => {
  it("requires explicit recovery consent separately from a read-only payment check", async () => {
    const code = crypto.randomUUID();
    const recovery = { orderId: "original-order", attemptId: "original-attempt", totalCents: 7299, approvalSnapshot: "a".repeat(64), recoverable: true };
    let current: HomePayload = { ...home(), state: "reconciling", paymentCheckOrderId: recovery.orderId, paymentRecovery: recovery };
    const calls = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/recover-payment")) {
        expect(url).not.toContain(code);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${code}`);
        expect(init?.body).not.toContain(code);
        expect(sessionStorage.getItem("replenish.pending-operation.v1")).not.toContain(code);
        expect(JSON.parse(init!.body as string)).toEqual({ expectedTotalCents: 7299, approvalSnapshot: recovery.approvalSnapshot, expectedAttemptId: recovery.attemptId });
        current = { ...home(), state: "ordered" };
      }
      return reply(current);
    });
    vi.stubGlobal("fetch", calls); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Check payment status" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Check payment status" }) as HTMLButtonElement).disabled).toBe(false));
    expect(calls.mock.calls.some(([url]) => url.endsWith("/recover-payment"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Recover original payment request" }));
    expect(screen.getByText(/This may complete the original approved payment/)).toBeTruthy();
    expect(screen.getByText("USD $72.99")).toBeTruthy();
    expect(calls.mock.calls.some(([url]) => url.endsWith("/recover-payment"))).toBe(false);
    expect((screen.getByRole("button", { name: "Confirm recovery of original payment" }) as HTMLButtonElement).disabled).toBe(true);
    const codeInput = screen.getByLabelText("Owner recovery access code") as HTMLInputElement;
    expect(codeInput.type).toBe("password");
    fireEvent.change(codeInput, { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm recovery of original payment" }));
    await waitFor(() => expect(calls.mock.calls.filter(([url]) => url.endsWith("/recover-payment"))).toHaveLength(1));
    expect(calls.mock.calls.some(([url]) => url.endsWith("/approve"))).toBe(false);
  });

  it("keeps the maintenance code out of URLs, bodies and persisted operation metadata", async () => {
    const code = crypto.randomUUID();
    const calls = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).not.toContain(code);
      if (url === "/v1/demo/reorder-now") {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${code}`);
        expect(init?.body).toBeUndefined();
        expect(sessionStorage.getItem("replenish.pending-operation.v1")).not.toContain(code);
      }
      return reply(home());
    });
    vi.stubGlobal("fetch", calls); render(<App path="/paypal" search="?demo=1" />);
    const input = await screen.findByLabelText("Maintenance access code");
    expect((input as HTMLInputElement).type).toBe("password");
    fireEvent.change(input, { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: "Run reorder check now" }));
    await waitFor(() => expect(calls.mock.calls.some(([url]) => url === "/v1/demo/reorder-now")).toBe(true));
    await screen.findByText("The reorder check completed. Review the order status.");
    expect(sessionStorage.getItem("replenish.pending-operation.v1")).toBeNull();
  });
  it("shows the pause deadline and lets the owner cancel automatic resumption", async () => {
    let current: HomePayload = { ...home(), autopilot: "paused", autopilotResumeAt: "2026-11-05T00:00:00Z",
      autopilotPauseReason: "I'll resume automatic buying on 2026-11-05 at 00:00 (UTC), on the next background check." };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/pause")) current = { ...current, autopilotResumeAt: null, autopilotPauseReason: "Paused until you resume." };
      return reply(current);
    });
    vi.stubGlobal("fetch", fetchMock); render(<App path="/paypal" />);
    await screen.findByText(current.autopilotPauseReason!);
    expect(screen.getByRole("heading", { name: "Automatic buying is paused." })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep paused until I resume" }));
    await screen.findByRole("button", { name: "Paused" });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/pause"))).toHaveLength(1);
    expect(current.autopilot).toBe("paused"); expect(current.autopilotResumeAt).toBeNull();
  });

  it("refreshes the control screen after the backend automatically resumes buying", async () => {
    let current: HomePayload = { ...home(), autopilot: "paused", autopilotResumeAt: "2026-11-05T00:00:00Z", autopilotPauseReason: "Scheduled to resume in UTC." };
    vi.stubGlobal("fetch", vi.fn(async () => reply(current))); render(<App path="/paypal" />);
    await screen.findByRole("button", { name: "Keep paused until I resume" });
    current = { ...home(), autopilotResumeAt: null };
    window.dispatchEvent(new Event("focus"));
    await screen.findByRole("button", { name: "Pause autopilot" });
    expect(screen.queryByRole("button", { name: "Keep paused until I resume" })).toBeNull();
    expect(screen.queryByText("Scheduled to resume in UTC.")).toBeNull();
  });
  it("shows notification status without public recipient, toggle or send controls", async () => {
    const notifications: NotificationStatus = {
      configured: true, enabled: true, botUrl: "https://t.me/replenish_test_bot", lastOutcome: "unknown",
      lastAttemptAt: null, lastSentAt: null, commandStatus: "ready", queueError: false, pending: 0,
    };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => reply(url === "/v1/notifications" ? notifications : { ...home(), notifications }));
    vi.stubGlobal("fetch", fetchMock); render(<App path="/paypal" />);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    await within(dialog).findByRole("button", { name: "Refresh notification status" });
    expect(dialog.textContent).toContain("Send result unconfirmed");
    expect(dialog.textContent).toContain("/start");
    expect(within(dialog).getByRole("link", { name: "Open Telegram" }).getAttribute("href")).toBe("https://t.me/replenish_test_bot");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /send|enable notifications|disable notifications/i })).toBeNull();
    expect(fetchMock.mock.calls.map(([url, init]) => ({ url, method: init?.method ?? "GET" }))).toEqual([
      { url: "/v1/home", method: "GET" }, { url: "/v1/notifications", method: "GET" },
    ]);
  });

  it("opens an old notification's exact order without presenting the newer approval inside it", async () => {
    const fetchMock = vi.fn(async (url: string) => reply(url.endsWith("/old-order") ? {
      id: "old-order", totalCents: 7299, status: "rejected", paymentStatus: "none", captureId: null,
      productName: "Taste of the Wild", productDetail: "8 kg",
    } : approval()));
    vi.stubGlobal("fetch", fetchMock); render(<App search="?order=old-order" />);
    const dialog = await screen.findByRole("dialog", { name: "Order from notification" });
    await within(dialog).findByText("old-order");
    expect(dialog.textContent).toContain("rejected");
    expect(within(dialog).queryByRole("button", { name: /approval|Approve/ })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/approve"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await screen.findByRole("button", { name: "Approve $72.99" });
  });

  it("requires explicit website review before approving the linked current order", async () => {
    const fetchMock = vi.fn(async (url: string) => reply(url.endsWith("/isolated-order") ? {
      id: "isolated-order", totalCents: 7299, status: "awaiting_approval", paymentStatus: "none", captureId: null,
      productName: "Taste of the Wild", productDetail: "8 kg",
    } : approval()));
    vi.stubGlobal("fetch", fetchMock); render(<App search="?order=isolated-order" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review this approval" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/approve"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Approve $72.99" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/approve"))).toHaveLength(1));
  });

  it("submits the viewed snapshot and asks for review when the server rejects a stale approval", async () => {
    const viewed = approval();
    let current = viewed;
    let submitted: unknown;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/approve")) {
        submitted = JSON.parse(init!.body as string);
        current = { ...viewed, pendingApproval: { ...viewed.pendingApproval!, approvalSnapshot: "b".repeat(64), productDetail: "Updated bag" } };
        return reply({ voided: true, charged: false, message: "This order has changed since you viewed it. Review the current order before approving. No payment was requested." });
      }
      return reply(current);
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve $72.99" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed since you viewed it");
    await screen.findByText("Updated bag");
    expect(submitted).toEqual({ expectedTotalCents: 7299, approvalSnapshot: viewed.pendingApproval!.approvalSnapshot });
    expect(screen.queryByText("The approval request completed. Review the verified payment status.")).toBeNull();
  });

  it("opens forecast risk links directly in the plan details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(home()))); render(<App search="?view=plan" />);
    expect((await screen.findByRole("dialog", { name: "Replenishment plan" })).textContent).toContain("Estimated runout");
  });
  it("disables both approval actions while waiting and shows an API failure without a second request", async () => {
    let finish!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => { finish = resolve; });
    const fetchMock = vi.fn(async (url: string) => url.endsWith("/approve") ? held : reply(approval()));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const approve = await screen.findByRole("button", { name: "Approve $72.99" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect((screen.getByRole("button", { name: "Submitting this approval…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Not now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/approve"))).toHaveLength(1);
    finish(reply({ error: "Could not reach the payment service." }, 503));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the payment service.");
    expect((screen.getByRole("button", { name: "Check status first" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Check latest status" })).toBeTruthy();
  });

  it("shows a PayPal connection error on its own screen", async () => {
    const disconnected = home();
    disconnected.paypal.connected = false;
    disconnected.paypal.automaticPaymentAuthorized = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/connect")
      ? reply({ error: "The connection could not be verified." }, 400) : reply(disconnected)));
    render(<App path="/paypal" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect PayPal" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The connection could not be verified.");
  });

  it("lets the owner resume future buying from the PayPal screen", async () => {
    let current = { ...home(), autopilot: "paused" };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/resume")) current = { ...current, autopilot: "active" };
      return reply(current);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App path="/paypal" />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume autopilot" }));
    await screen.findByRole("button", { name: "Active" });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/resume"))).toHaveLength(1);
  });

  it("opens order details from the paid line and confirms receipt", async () => {
    let current: HomePayload = {
      ...home(), state: "ordered", headline: "Qizai's food is on the way.",
      payment: { paypalOrderId: "isolated-payment", captureId: "isolated-capture" },
      order: { id: "isolated-order", totalCents: 7299, status: "ordered", paymentStatus: "paid", captureId: "isolated-capture",
        productName: "Taste of the Wild", productDetail: "Pacific Stream Small Breed · 8 kg" },
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/receive")) current = { ...home(), headline: "Qizai has about 60 days of food left." };
      return reply(current);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Paid with PayPal/ }));
    fireEvent.click(screen.getByRole("button", { name: "View order" }));
    expect(screen.getByRole("dialog", { name: "Qizai's food order" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Food received" }));
    await screen.findByRole("heading", { name: /60 days of food left/ });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/receive"))).toHaveLength(1);
  });

  it("refreshes the background order state when the owner returns to the page, without posting an order", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let current = home();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => reply(current));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("heading", { name: /8 days of food left/ });
    current = approval();
    fireEvent(window, new Event("focus"));
    await screen.findByRole("button", { name: "Approve $72.99" });
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
});

describe("household detail interactions", () => {
  it("sends the revision visible in the details form when undoing a feeding change", async () => {
    const current = { ...home(), undoRevisionId: 42 };
    let submitted: unknown;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/undo")) {
        submitted = JSON.parse(init!.body as string);
        return reply({ command: { type: "undo" }, headline: "Restored.", reason: "Restored feeding.", decision: null });
      }
      return reply(current);
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "View Qizai's details" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo last feeding change" }));
    await waitFor(() => expect(submitted).toEqual({ expectedRevisionId: 42 }));
  });

  it("keeps feeding quantities off the homepage and saves a calibration without asking for a date", async () => {
    let current = home();
    const calls = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/calibrate")) current = { ...current, feeding: { ...current.feeding!, stockG: 900 } };
      return reply(current);
    });
    vi.stubGlobal("fetch", calls);
    render(<App />);
    await screen.findByRole("button", { name: "View Qizai's details" });
    expect(screen.queryByText("Estimated food left")).toBeNull();
    screen.getByRole("button", { name: "View Qizai's details" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "View Qizai's details" }));
    const dialog = screen.getByRole("dialog", { name: "Qizai's details" });
    expect(within(dialog).getByText("1,200 g")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Food remaining in the bag (g)"), { target: { value: "900" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Calibrate stock" }));
    await within(dialog).findByText("900 g");
    const saved = calls.mock.calls.find(([url]) => url.endsWith("/calibrate"));
    expect(JSON.parse(saved![1]!.body as string)).toEqual({ stockG: 900 });
    expect(dialog.querySelector('input[type="date"]')).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "View Qizai's details" }));
  });

  it("explains a selected date with three forecast nodes and the actual calculation inputs", async () => {
    const current = { ...home(), dates: [{ date: "2026-11-01", markers: [] }], plan: { ...home().plan,
      plannedOrderAt: "2026-11-05T08:00:00Z", estimatedDeliveryAt: "2026-11-07T08:00:00Z", predictedRunoutAt: "2026-11-09T08:00:00Z", shippingHours: 48, bufferHours: 48 } };
    vi.stubGlobal("fetch", vi.fn(async () => reply(current)));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Today 1, no planned event" }));
    const dialog = screen.getByRole("dialog", { name: "Replenishment plan" });
    expect(within(dialog).getByText("2026-11-01: No planned event.")).toBeTruthy();
    for (const label of ["Planned order", "Expected delivery", "Estimated runout", "Store shipping time", "Safety buffer"]) expect(within(dialog).getByText(label)).toBeTruthy();
    expect(within(dialog).getAllByText("48 hours")).toHaveLength(2);
    expect(dialog.textContent).toContain("These are planned events");
  });

  it("shows forecast dates with the year in the household timezone, retaining exact agent check times", async () => {
    const current: HomePayload = { ...home(), pet: { name: "Qizai", timezone: "America/Los_Angeles" },
      plan: { ...home().plan, plannedOrderAt: "2027-01-01T01:55:00Z", estimatedDeliveryAt: "2027-01-03T01:55:00Z", predictedRunoutAt: "2027-01-05T01:55:00Z" },
      agentStatus: { enabled: true, state: "waiting", intervalMs: 900000, lastStartedAt: "2026-11-01T16:55:30Z",
        lastFinishedAt: "2026-11-01T16:55:31Z", lastSucceededAt: "2026-11-01T16:55:31Z", nextCheckAt: "2026-11-01T17:10:30Z", lastResult: null, waitingReason: "Waiting for the planned order date." } };
    vi.stubGlobal("fetch", vi.fn(async () => reply(current)));
    render(<App search="?view=plan" />);
    const dialog = await screen.findByRole("dialog", { name: "Replenishment plan" });
    const nodes = dialog.querySelector(".plan-nodes")!;
    expect(nodes.textContent).toContain("Dec 31, 2026");
    expect(nodes.textContent).toContain("Jan 2, 2027");
    expect(nodes.textContent).toContain("Jan 4, 2027");
    expect(nodes.textContent).not.toMatch(/AM|PM|\d:\d/);
    expect(within(dialog).getByText(/8:55:30/)).toBeTruthy();
  });

  it("displays committed spending and edits limits through a form, leaving automatic authorization separate", async () => {
    let current = home();
    const calls = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/v1/budget" && init?.method === "PUT") current = { ...current, budget: JSON.parse(init.body as string) as HomePayload["budget"] };
      return reply(url === "/v1/budget" ? { ...current.budget, currency: "USD", monthSettledCents: 0, monthCommittedCents: 7299, monthRemainingCents: 4701 } : current);
    });
    vi.stubGlobal("fetch", calls);
    render(<App path="/paypal" />);
    fireEvent.click(await screen.findByRole("button", { name: "Budget details" }));
    const dialog = screen.getByRole("dialog", { name: "Budget details" });
    await within(dialog).findByText("$47.01");
    expect(within(dialog).getByText("$72.99")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Per-order auto-pay limit ($)"), { target: { value: "80" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save limits" }));
    await within(dialog).findByText("Spending limits saved.");
    expect(calls.mock.calls.some(([url]) => url.endsWith("/authorize"))).toBe(false);
    const saved = calls.mock.calls.find(([url, init]) => url === "/v1/budget" && init?.method === "PUT");
    expect(JSON.parse(saved![1]!.body as string)).toEqual({ perOrderLimitCents: 8000, monthlyLimitCents: 12000 });
  });

  it("offers result checking for an uncertain payment without posting another approval", async () => {
    let current = { ...home(), state: "reconciling", paymentCheckOrderId: "uncertain-order" };
    const calls = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/check-payment")) current = { ...current, state: "ordered", paymentCheckOrderId: "" };
      return reply(current);
    });
    vi.stubGlobal("fetch", calls);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Check payment status" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull());
    expect(calls.mock.calls.filter(([url]) => url.endsWith("/check-payment"))).toHaveLength(1);
    expect(calls.mock.calls.some(([url]) => url.endsWith("/approve"))).toBe(false);
  });
});
