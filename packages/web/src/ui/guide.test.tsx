/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";
import type { ChatPayload, HomePayload } from "../api";

function home(): HomePayload {
  return { headline: "Qizai has about 8 days of food left.", reason: "A reorder is planned.", state: "scheduled", autopilot: "active",
    pet: { name: "Qizai", timezone: "UTC" }, paypal: { connected: true, automaticPaymentAuthorized: false, environment: "sandbox", status: "connected", last4: null },
    orderDate: "Nov 6", orderDateRaw: "2026-11-06T00:00:00Z", dates: [], payment: null, order: null, notice: null,
    pendingApproval: null, undoRevisionId: 1, budget: { perOrderLimitCents: 5000, monthlyLimitCents: 12000 },
    plan: { orderDate: "Nov 6", orderDateRaw: "2026-11-06T00:00:00Z", planChanged: false },
    feeding: { stockG: 1200, gramsPerMeal: 75, mealsPerDay: 2, dailyGrams: 150 } };
}
function response(body: unknown) { return { ok: true, json: async () => body } as Response; }
function mockApi(initial = home(), chat?: ChatPayload) {
  let current = initial;
  const calls = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/v1/chat") {
      if (chat?.receipt?.feeding && current.feeding) current = { ...current, state: "updated", feeding: { ...current.feeding, ...chat.receipt.feeding.after } };
      return response(chat);
    }
    if (url === "/v1/activity") return response([]);
    if (url === "/v1/budget") return response({ ...current.budget, monthSettledCents: 0, monthCommittedCents: 0, monthRemainingCents: 12000 });
    if (url === "/v1/notifications") return response({ configured: false, enabled: false, pending: 0 });
    expect(init?.method ?? "GET").toBe("GET");
    return response(current);
  });
  vi.stubGlobal("fetch", calls);
  return { calls, update: (next: HomePayload) => { current = next; } };
}
async function enterDetails() {
  fireEvent.click(await screen.findByRole("button", { name: "Show me around" }));
  fireEvent.click(screen.getByRole("button", { name: "View Qizai's details" }));
  return screen.findByRole("dialog", { name: "Qizai's details" });
}
async function enterComposer() {
  const dialog = await enterDetails();
  fireEvent.click(within(dialog).getByRole("button", { name: "Go to message box" }));
}
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("allows skipping the first hint, remembers that choice, and never starts the tour automatically", async () => {
  const api = mockApi(); const view = render(<App />);
  await screen.findByText("New here?");
  expect(screen.queryByLabelText("Tap Qizai")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss first-visit hint" }));
  view.unmount(); render(<App />);
  await screen.findByRole("button", { name: "Show me around" });
  expect(screen.queryByText("New here?")).toBeNull();
  expect(api.calls.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it("introduces all four real destinations, returns to their links, and only reads data", async () => {
  const api = mockApi(); render(<App />);
  const dialog = await enterDetails();
  fireEvent.click(within(dialog).getByRole("button", { name: "Show other places" }));
  for (const title of ["Replenishment plan", "Budget details", "Recent activity", "Notifications"]) {
    fireEvent.click(screen.getByRole("button", { name: title }));
    const page = await screen.findByRole("dialog", { name: title });
    await within(page).findByRole("button", { name: "Got it" });
    fireEvent.click(within(page).getByRole("button", { name: "Close" }));
    await screen.findByRole("dialog", { name: "Qizai's details" });
  }
  expect(api.calls.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it("preserves an existing draft and only prefills an example after it is cleared", async () => {
  const api = mockApi(); render(<App />);
  await screen.findByRole("button", { name: "Show me around" });
  fireEvent.change(screen.getByLabelText("Message about Qizai"), { target: { value: "My own message" } });
  await enterComposer();
  const input = screen.getByLabelText("Message about Qizai") as HTMLInputElement;
  expect(input.value).toBe("My own message");
  expect((screen.getByRole("button", { name: "Use example" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Use example" }));
  expect(input.value).toBe("Feed 10g less per meal from now on.");
  expect(document.activeElement).toBe(input);
  expect(api.calls.mock.calls.some(([, init]) => init?.method)).toBe(false);
});

it("uses a real saved receipt for result guidance and finishing never invokes Undo", async () => {
  const chat: ChatPayload = { headline: "Feeding saved.", reason: "Forecast recalculated.", command: { type: "feeding_permanent" }, decision: null,
    receipt: { operationId: "test-operation", at: "2026-11-02T00:00:00Z", outcome: "applied", undoRevisionId: 2,
      feeding: { before: { gramsPerMeal: 75, dailyGrams: 150 }, after: { gramsPerMeal: 65, dailyGrams: 130 } }, plan: null } };
  const api = mockApi(home(), chat); render(<App />); await enterComposer();
  fireEvent.click(screen.getByRole("button", { name: "Use example" }));
  expect(screen.queryByLabelText("Check what changed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByLabelText("Check what changed");
  fireEvent.click(screen.getByRole("button", { name: "Show Undo" }));
  expect(screen.getByRole("button", { name: "Undo" }).className).toContain("guide-highlight");
  fireEvent.click(screen.getByRole("button", { name: "Finish tour" }));
  expect(api.calls.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  expect(api.calls.mock.calls.some(([url]) => url.includes("undo"))).toBe(false);
});

it("does not pretend clarification is a saved change", async () => {
  const api = mockApi(home(), { headline: "Please clarify.", reason: "No change saved.", command: { type: "clarify" }, decision: null,
    receipt: { operationId: "clarification", at: "2026-11-02T00:00:00Z", outcome: "needs_clarification", feeding: null, plan: null, undoRevisionId: null } });
  render(<App />); await enterComposer(); fireEvent.click(screen.getByRole("button", { name: "Use example" }));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByLabelText("Read the actual response");
  expect(screen.queryByLabelText("Check what changed")).toBeNull();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(api.calls.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
});

it("gives a new critical payment state priority over an open tour", async () => {
  const api = mockApi(); render(<App />); await enterDetails();
  api.update({ ...home(), state: "reconciling", paymentCheckOrderId: "payment-to-check" });
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "Check payment status" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show me around" })).toBeNull();
  expect(api.calls.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it("keeps unsubmitted budget edits when explanation is toggled", async () => {
  const api = mockApi(); render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "View Qizai's details" }));
  fireEvent.click(screen.getByRole("button", { name: "Budget details" }));
  const input = await screen.findByLabelText("Per-order auto-pay limit ($)");
  fireEvent.change(input, { target: { value: "45" } });
  fireEvent.click(screen.getByRole("button", { name: "Explain this page" }));
  expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Save limits" }));
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  expect((input as HTMLInputElement).value).toBe("45");
  expect(api.calls.mock.calls.some(([, init]) => init?.method)).toBe(false);
});
