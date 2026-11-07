/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../App";

afterEach(() => cleanup());

describe("round 6 screens", () => {
  it("shows the scheduled home sentence, reason, ten day cells, and the chat box", () => {
    const { container } = render(<App path="/shots/1" />);
    expect(screen.getByRole("heading", { name: /Qizai has about 8 days of food left/i })).toBeTruthy();
    expect(screen.getByText("I'll reorder on Nov 2 so it arrives before food runs out.")).toBeTruthy();
    expect(container.querySelectorAll(".tile")).toHaveLength(10);
    expect(screen.getByLabelText("Message about Qizai")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("opens the skip-dinner chat over the home screen", () => {
    render(<App path="/shots/2" />);
    expect(screen.getByText("Skip Qizai's dinner tomorrow.")).toBeTruthy();
    expect(screen.getByText("Noted. Qizai skips dinner tomorrow.")).toBeTruthy();
    expect(screen.getByText("That's half a day of food, so the reorder date stays Nov 2.")).toBeTruthy();
    expect(screen.getByText("Feeding plan updated (temporary)")).toBeTruthy();
    expect(screen.getByText("Tomorrow's dinner: skipped")).toBeTruthy();
    expect(screen.getByText("Reorder plan: No change")).toBeTruthy();
    expect(screen.getByText("Still Mon, Nov 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Okay" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.getAllByLabelText("Message about Qizai")).toHaveLength(2);
  });

  it("shows the unchanged plan with a skip on the date strip", () => {
    const { container } = render(<App path="/shots/3" />);
    expect(screen.getByRole("heading", { name: /Noted\. Qizai skips dinner tomorrow/i })).toBeTruthy();
    expect(screen.getByText("That's half a day of food, so the reorder date stays Nov 2.")).toBeTruthy();
    const skip = container.querySelector(".tile.skip");
    expect(skip?.textContent).toContain("Skip");
    expect(skip?.textContent).toContain("29");
  });

  it("pins the over-limit approval card with both deltas", () => {
    render(<App path="/shots/4" />);
    expect(screen.getByRole("heading", { name: /Qizai's next order needs your approval/i })).toBeTruthy();
    expect(screen.getByText("Action needed")).toBeTruthy();
    expect(screen.getByText("Taste of the Wild")).toBeTruthy();
    expect(screen.getByText("Over your $50 auto-pay limit. Over your monthly budget")).toBeTruthy();
    expect(screen.getByText("+$22.99")).toBeTruthy();
    expect(screen.getByText("+$42.99")).toBeTruthy();
    expect(screen.getByText("$120.00 · $162.99 this month")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve $72.99" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    expect(screen.getByLabelText("Message about Qizai")).toBeTruthy();
  });

  it("shows PayPal disconnected, then the spec titles for connected and authorized", () => {
    const { unmount } = render(<App path="/shots/5" />);
    expect(screen.getByRole("heading", { name: /Connect PayPal for automatic replenishment/i })).toBeTruthy();
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.getByText("You can change these after connecting.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect PayPal" })).toBeTruthy();
    expect(screen.getByLabelText("Message about Qizai")).toBeTruthy();
    unmount();

    render(<App path="/shots/6" />);
    expect(screen.getByRole("heading", { name: /One more step: allow automatic payments/i })).toBeTruthy();
    expect(screen.getByText("Automatic payments not enabled yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow automatic payments" })).toBeTruthy();
    expect(screen.getByLabelText("Message about Qizai")).toBeTruthy();
    cleanup();

    render(<App path="/shots/7" />);
    expect(screen.getByRole("heading", { name: /Automatic replenishment is on/i })).toBeTruthy();
    expect(screen.getByText("Automatic payments enabled. You can revoke access anytime.")).toBeTruthy();
    expect(screen.getByText(/I'll only order within these limits/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause autopilot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeTruthy();
    expect(screen.getByLabelText("Message about Qizai")).toBeTruthy();
  });
});
