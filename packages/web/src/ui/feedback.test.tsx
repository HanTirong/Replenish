/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { ChatPayload, HomePayload } from "../api";

const home: HomePayload = {
  headline: "Qizai has about 8 days of food left.", reason: "I'll reorder on Nov 5 so it arrives before food runs out.",
  orderDate: "Nov 5", orderDateRaw: "2026-11-05T08:00:00Z", state: "scheduled", autopilot: "active", pet: { name: "Qizai", timezone: "UTC" },
  paypal: { connected: true, automaticPaymentAuthorized: true, status: "enabled", environment: "sandbox", last4: "1881" },
  payment: null, notice: null, dates: [], budget: { perOrderLimitCents: 5000, monthlyLimitCents: 12000 }, pendingApproval: null,
  plan: { orderDate: "Nov 5", orderDateRaw: "2026-11-05T08:00:00Z", planChanged: false },
  feeding: { stockG: 1200, gramsPerMeal: 65, mealsPerDay: 2, dailyGrams: 130 },
};
const reply = (body: unknown, status = 200) => ({ ok: status < 400, json: async () => body }) as Response;
const turn = (id: string, type = "feeding_permanent"): ChatPayload => ({
  command: { type }, headline: "Feeding change confirmed.", reason: "I recalculated the estimate.", decision: null,
  receipt: { operationId: id, at: "2026-11-01T08:00:00Z", outcome: type === "clarify" ? "needs_clarification" : type === "plan_query" ? "answered" : "applied",
    undoRevisionId: type === "feeding_permanent" ? 1 : null, plan: null,
    feeding: type === "feeding_permanent" ? { before: { gramsPerMeal: 75, dailyGrams: 150 }, after: { gramsPerMeal: 65, dailyGrams: 130 } } : null },
});
async function send() {
  fireEvent.change(await screen.findByLabelText("Message about Qizai"), { target: { value: "以后每顿少喂10g" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  return screen.findByRole("dialog", { name: "Conversation" });
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("visible operation feedback", () => {
  it("preserves the viewed revision for a typed Undo retry even after home changes", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/v1/chat") {
        requests.push(JSON.parse(init!.body as string));
        if (requests.length === 1) throw new TypeError("Simulated lost acknowledgement");
        return reply(turn((init!.headers as Record<string, string>)["idempotency-key"], "undo"));
      }
      return reply(url.includes("/operations/") ? { status: "unconfirmed" } : { ...home, undoRevisionId: requests.length ? 99 : 42 });
    }));
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Message about Qizai"), { target: { value: "撤销" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const dialog = await screen.findByRole("dialog", { name: "Conversation" });
    await within(dialog).findByText("This result is not confirmed yet.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Check latest status" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Retry same request" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests).toEqual([{ text: "撤销", expectedRevisionId: 42 }, { text: "撤销", expectedRevisionId: 42 }]);
  });

  it("immediately echoes the message, blocks repeated sends, then shows server-confirmed before/after values", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let id = "";
    const calls = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/v1/chat") { id = (init!.headers as Record<string, string>)["idempotency-key"]; await gate; return reply(turn(id)); }
      return reply(home);
    });
    vi.stubGlobal("fetch", calls); render(<App />); let dialog = await send();
    expect(within(dialog).getByText("以后每顿少喂10g")).toBeTruthy();
    expect(within(dialog).getAllByText("Processing your message…").length).toBeGreaterThan(0);
    const input = within(dialog).getByLabelText("Message about Qizai") as HTMLInputElement;
    expect(input.disabled).toBe(true); fireEvent.submit(input.closest("form")!); fireEvent.submit(input.closest("form")!);
    expect(calls.mock.calls.filter(([url]) => url === "/v1/chat")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View request" }));
    dialog = await screen.findByRole("dialog", { name: "Conversation" });
    release(); await within(dialog).findByText(/75g → 65g per meal/);
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(false));
    expect(sessionStorage.getItem("replenish.pending-operation.v1")).toBeNull();
  });

  it("preserves confirmed success when only the subsequent home refresh fails", async () => {
    let submitted = false, recover = false;
    const calls = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/v1/chat") { submitted = true; return reply(turn((init!.headers as Record<string, string>)["idempotency-key"])); }
      if (submitted && !recover) throw new TypeError("Simulated lost refresh");
      return reply(home);
    });
    vi.stubGlobal("fetch", calls); render(<App />); const dialog = await send();
    await within(dialog).findByText("Confirmed. The latest page state is still syncing.");
    expect(within(dialog).getByText(/75g → 65g/)).toBeTruthy(); expect(within(dialog).queryByRole("alert")).toBeNull();
    recover = true; fireEvent.click(within(dialog).getByRole("button", { name: "Check latest status" }));
    await waitFor(() => expect(within(dialog).queryByText("Confirmed. The latest page state is still syncing.")).toBeNull());
    expect(calls.mock.calls.filter(([url]) => url === "/v1/chat")).toHaveLength(1);
  });

  it("recovers a lost acknowledgement after remount through a read-only receipt lookup", async () => {
    let id = "";
    const calls = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/v1/chat") { id = (init!.headers as Record<string, string>)["idempotency-key"]; throw new TypeError("Simulated lost response after saving"); }
      if (url.includes("/operations/")) return reply({ status: "completed", result: turn(id) });
      return reply(home);
    });
    vi.stubGlobal("fetch", calls); const first = render(<App />); const dialog = await send();
    await within(dialog).findByText("This result is not confirmed yet.");
    expect(sessionStorage.getItem("replenish.pending-operation.v1")).toContain(id);
    first.unmount(); render(<App />);
    await screen.findByText("The saved result was recovered. The request was not repeated.");
    expect(calls.mock.calls.filter(([url]) => url === "/v1/chat")).toHaveLength(1);
    expect(calls.mock.calls.some(([url]) => url.endsWith(`/operations/${id}`))).toBe(true);
  });

  it("only offers safe retry after receipt lookup and reuses the original ID", async () => {
    const ids: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/v1/chat") { const id = (init!.headers as Record<string, string>)["idempotency-key"]; ids.push(id); if (ids.length === 1) throw new TypeError("Simulated disconnect"); return reply(turn(id)); }
      return reply(url.includes("/operations/") ? { status: "unconfirmed" } : home);
    }));
    render(<App />); const dialog = await send(); await within(dialog).findByText("This result is not confirmed yet.");
    expect(within(dialog).queryByRole("button", { name: "Retry same request" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Check latest status" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Retry same request" }));
    await within(dialog).findByText("Feeding change confirmed."); expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(1);
  });

  it("keeps the draft after a guaranteed rejection instead of silently losing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => reply(url === "/v1/chat" ? { error: "The household changed. No new change was saved.", operationStatus: "rejected" } : home, url === "/v1/chat" ? 400 : 200)));
    render(<App />); const dialog = await send(); await within(dialog).findByText("The change was not saved.");
    await waitFor(() => expect((within(dialog).getByLabelText("Message about Qizai") as HTMLInputElement).value).toBe("以后每顿少喂10g"));
    expect(within(dialog).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it.each(["clarify", "plan_query", "pause_orders"])("does not offer unrelated Undo for %s", async type => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => reply(url === "/v1/chat" ? turn((init!.headers as Record<string, string>)["idempotency-key"], type) : home)));
    render(<App />); const dialog = await send(); await within(dialog).findByText("Feeding change confirmed.");
    expect(within(dialog).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("explains real failed-check evidence in the existing plan details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ ...home, agentStatus: { enabled: true, state: "failed", intervalMs: 900000,
      lastStartedAt: "2026-11-01T08:00:00Z", lastFinishedAt: "2026-11-01T08:00:01Z", lastSucceededAt: null,
      nextCheckAt: "2026-11-01T08:15:00Z", lastResult: "The scheduled check could not complete.", waitingReason: "Waiting for owner approval." } })));
    render(<App />); fireEvent.click(await screen.findByRole("button", { name: "View Qizai's details" }));
    fireEvent.click(screen.getByRole("button", { name: "Replenishment plan" }));
    await screen.findByText("Last check failed"); expect(screen.getByText("Waiting for owner approval.")).toBeTruthy();
    expect(screen.getByText("Last successful check")).toBeTruthy();
    expect(screen.getByText(/8:00:00/)).toBeTruthy();
  });
});
