/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HomePayload, NotificationStatus } from "../api";
import { NotificationDetails } from "./notifications";

const status = (changes: Partial<NotificationStatus> = {}): NotificationStatus => ({
  configured: true, enabled: false, botUrl: "https://t.me/replenish_ai_bot", lastOutcome: null, lastAttemptAt: null, lastSentAt: null,
  commandStatus: "ready", queueError: false, pending: 0,
  setup: { stage: "awaiting_start", enabledAt: null, lastCommandCheckedAt: "2026-11-01T08:00:00Z", test: null }, recent: [], ...changes,
});
const home = (notifications: NotificationStatus): HomePayload => ({
  headline: "Qizai has about 8 days of food left.", reason: "Reorder on Nov 5.", orderDate: "Nov 5", orderDateRaw: "2026-11-05T08:00:00Z", state: "scheduled", autopilot: "active",
  pet: { name: "Qizai", timezone: "UTC" }, paypal: { connected: false, automaticPaymentAuthorized: false, status: "disconnected", environment: "sandbox", last4: null },
  notice: null, payment: null, dates: [], budget: { perOrderLimitCents: 5000, monthlyLimitCents: 12000 }, pendingApproval: null,
  plan: { orderDate: "Nov 5", orderDateRaw: "2026-11-05T08:00:00Z", planChanged: false }, notifications,
});
const reply = (body: NotificationStatus) => ({ ok: true, json: async () => body }) as Response;
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (navigator as unknown as { clipboard?: unknown }).clipboard; });

describe("owner notification onboarding and feedback", () => {
  it("shows the next owner step, copies commands without sending, and refreshes real server state", async () => {
    let current = status();
    const copy = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const calls = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/v1/notifications"); expect(init?.method ?? "GET").toBe("GET"); return reply(current);
    });
    vi.stubGlobal("fetch", calls); render(<NotificationDetails home={home(current)} />);
    await screen.findByRole("button", { name: "Refresh notification status" });
    expect((screen.getByRole("link", { name: "Open Telegram" }) as HTMLAnchorElement).href).toBe("https://t.me/replenish_ai_bot");
    fireEvent.click(screen.getByRole("button", { name: "Copy /start" }));
    await screen.findByText("Copied /start. Paste it into the owner's Bot chat.");
    expect(copy).toHaveBeenCalledWith("/start"); expect(calls).toHaveBeenCalledTimes(1);
    current = status({ enabled: true, lastOutcome: "sent", setup: { stage: "awaiting_test", enabledAt: "2026-11-01T08:00:00Z", lastCommandCheckedAt: "2026-11-01T08:00:15Z", test: null } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh notification status" }));
    await screen.findByText("Notifications are on. Try a test message.");
    expect(screen.getByRole("button", { name: "Copy /test" })).toBeTruthy();
    const steps = screen.getByRole("list", { name: "Notification setup" });
    expect(within(steps).getAllByText("Done")).toHaveLength(2); expect(within(steps).getByText("Waiting")).toBeTruthy();
  });

  it("keeps an uncertain test distinct from an accepted start acknowledgement", async () => {
    const current = status({ enabled: true, lastOutcome: "sent", setup: { stage: "awaiting_test", enabledAt: "2026-11-01T08:00:00Z", lastCommandCheckedAt: "2026-11-01T08:00:30Z",
      test: { kind: "control", status: "unknown", createdAt: "2026-11-01T08:00:15Z", attemptedAt: "2026-11-01T08:00:15Z", acceptedAt: null } } });
    vi.stubGlobal("fetch", vi.fn(async () => reply(current))); render(<NotificationDetails home={home(current)} />);
    await screen.findByText("The test result is unconfirmed. Check the owner's Bot chat before trying again.");
    expect(screen.queryByText("Telegram accepted the test. Check the owner's chat to see it.")).toBeNull();
    expect(within(screen.getByRole("list", { name: "Notification setup" })).getByText("Waiting")).toBeTruthy();
  });

  it("preserves the last confirmed status when refresh fails, then offers another read", async () => {
    const current = status({ enabled: true }); let offline = true;
    vi.stubGlobal("fetch", vi.fn(async () => { if (offline) throw new TypeError("Simulated disconnect"); return reply(current); }));
    render(<NotificationDetails home={home(current)} />);
    await screen.findByRole("alert"); expect(screen.getByText("On")).toBeTruthy();
    offline = false; fireEvent.click(screen.getByRole("button", { name: "Refresh notification status" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("refreshes while open and visible, pauses when hidden, and cleans up on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls = vi.fn(async () => reply(status())); vi.stubGlobal("fetch", calls);
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(<NotificationDetails home={home(status())} />);
    await screen.findByRole("button", { name: "Refresh notification status" });
    await act(async () => { vi.advanceTimersByTime(10_000); }); expect(calls).toHaveBeenCalledTimes(2);
    visible.mockReturnValue("hidden"); await act(async () => { vi.advanceTimersByTime(20_000); }); expect(calls).toHaveBeenCalledTimes(2);
    visible.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(3));
    view.unmount(); await act(async () => { vi.advanceTimersByTime(20_000); }); expect(calls).toHaveBeenCalledTimes(3);
  });

  it("shows setup requirements and a manual copy fallback without claiming a message was sent", async () => {
    let current = status({ configured: false, botUrl: null });
    vi.stubGlobal("fetch", vi.fn(async () => reply(current)));
    const view = render(<NotificationDetails home={home(current)} />);
    await screen.findByText("Owner setup is needed."); expect(screen.queryByRole("link", { name: "Open Telegram" })).toBeNull();
    view.unmount(); current = status(); render(<NotificationDetails home={home(current)} />);
    await screen.findByRole("button", { name: "Copy /start" }); fireEvent.click(screen.getByRole("button", { name: "Copy /start" }));
    await screen.findByText("Copy is unavailable here. Type /start in the owner's Bot chat.");
  });
});
