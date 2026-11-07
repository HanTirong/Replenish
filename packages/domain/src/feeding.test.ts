import { describe, expect, it } from "vitest";
import { decideReplan, forecastMeals, formatOrderDate, QIZAI_MEAL_MINUTES, type FeedingEvent } from "./feeding";

const STOCK_G = 1200;
const MEALS = 2;
const GRAMS = 75;
const DAILY = MEALS * GRAMS;
const AS_OF = new Date("2026-11-01T08:00:00.000Z");
const SHIPPING_HOURS = 48;
const BUFFER_HOURS = 48;

function forecast(gramsPerMeal: number, events: FeedingEvent[] = []) {
  return forecastMeals({
    stockG: STOCK_G,
    gramsPerMeal,
    mealMinutes: QIZAI_MEAL_MINUTES,
    timeZone: "UTC",
    asOf: AS_OF,
    events,
    shippingHours: SHIPPING_HOURS,
    bufferHours: BUFFER_HOURS,
  });
}

function hoursBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

describe("Qizai meal forecast from 1200g", () => {
  it("treats two 75g meals as 8 days and moves the order when 130g/day shifts it by at least 24h", () => {
    const baseline = forecast(GRAMS);
    expect(baseline.daysOfFood).toBeCloseTo(STOCK_G / DAILY, 5);

    const lighter = forecast(65);
    const runoutDelay = hoursBetween(lighter.predictedRunoutAt, baseline.predictedRunoutAt);
    const orderDelay = hoursBetween(lighter.candidateOrderAt, baseline.candidateOrderAt);
    const expectedHours = (STOCK_G / (65 * MEALS) - STOCK_G / DAILY) * 24;
    expect(runoutDelay).toBeCloseTo(expectedHours, 4);
    expect(orderDelay).toBeCloseTo(expectedHours, 4);
    expect(expectedHours).toBeGreaterThanOrEqual(24);

    const decision = decideReplan({
      petName: "Qizai",
      timeZone: "UTC",
      previousPlannedOrderAt: baseline.candidateOrderAt,
      forecast: lighter,
      shippingHours: SHIPPING_HOURS,
      bufferHours: BUFFER_HOURS,
      orderLocked: false,
      change: "permanent",
    });
    expect(decision.planChanged).toBe(true);
    expect(decision.code).toBe("updated");
    expect(decision.deltaHours).toBeCloseTo(expectedHours, 4);
    expect(decision.headline).toBe("I updated Qizai's feeding plan.");
    const newDate = formatOrderDate(lighter.candidateOrderAt, "UTC");
    expect(decision.orderDate).toBe(newDate);
    expect(decision.orderDateRaw).toBe(lighter.candidateOrderAt.toISOString());
    expect(decision.reason).toBe(`I recalculated the estimate and moved the reorder date to ${newDate}.`);
  });

  it("keeps the saved order when skipping one 75g dinner moves the candidate by less than 24h", () => {
    const baseline = forecast(GRAMS);
    const skip: FeedingEvent = {
      id: "skip-1",
      type: "temporary",
      mealIndex: 1,
      localDate: "2026-11-02",
      grams: 0,
      source: "chat",
      createdAt: AS_OF.toISOString(),
    };
    const skipped = forecast(GRAMS, [skip]);
    const orderDelay = hoursBetween(skipped.candidateOrderAt, baseline.candidateOrderAt);
    const expectedHours = (GRAMS / DAILY) * 24;
    expect(orderDelay).toBeCloseTo(expectedHours, 4);
    expect(expectedHours).toBeLessThan(24);

    const decision = decideReplan({
      petName: "Qizai",
      timeZone: "UTC",
      previousPlannedOrderAt: baseline.candidateOrderAt,
      forecast: skipped,
      shippingHours: SHIPPING_HOURS,
      bufferHours: BUFFER_HOURS,
      orderLocked: false,
      change: "skip_dinner_tomorrow",
    });
    expect(decision.planChanged).toBe(false);
    expect(decision.code).toBe("below_threshold");
    expect(decision.plannedOrderAt).toBe(baseline.candidateOrderAt.toISOString());
    expect(decision.candidateOrderAt).not.toBe(decision.plannedOrderAt);
    const stayed = formatOrderDate(baseline.candidateOrderAt, "UTC");
    expect(decision.headline).toBe("Noted. Qizai skips dinner tomorrow.");
    expect(decision.reason).toBe(`That's half a day of food, so the reorder date stays ${stayed}.`);
    expect(decision.orderDate).toBe(stayed);
    expect(decision.orderDateRaw).toBe(baseline.candidateOrderAt.toISOString());
    expect(decision.deltaHours).toBeCloseTo(expectedHours, 4);
  });

  it("moves an order earlier inside the 24h band when the current plan would miss the run-out", () => {
    const now = AS_OF;
    const planned = now;
    const runout = new Date(now.getTime() + 30 * 3_600_000);
    const shippingHours = 20;
    const bufferHours = 20;
    const candidate = new Date(runout.getTime() - (shippingHours + bufferHours) * 3_600_000);
    const deltaHours = (candidate.getTime() - planned.getTime()) / 3_600_000;
    expect(Math.abs(deltaHours)).toBeLessThan(24);
    expect(deltaHours).toBeLessThan(0);
    const decision = decideReplan({
      petName: "Qizai",
      timeZone: "UTC",
      previousPlannedOrderAt: planned,
      forecast: {
        predictedRunoutAt: runout,
        candidateOrderAt: candidate,
        estimatedDeliveryAt: new Date(candidate.getTime() + shippingHours * 3_600_000),
        daysOfFood: 30 / 24,
      },
      shippingHours,
      bufferHours,
      orderLocked: false,
      change: "other",
    });
    expect(decision.planChanged).toBe(true);
    expect(decision.code).toBe("risk_override");
    expect(new Date(decision.plannedOrderAt).getTime()).toBeLessThan(planned.getTime());
  });

  it("does not move a paid order", () => {
    const baseline = forecast(GRAMS);
    const lighter = forecast(65);
    const decision = decideReplan({
      petName: "Qizai",
      timeZone: "UTC",
      previousPlannedOrderAt: baseline.candidateOrderAt,
      forecast: lighter,
      shippingHours: SHIPPING_HOURS,
      bufferHours: BUFFER_HOURS,
      orderLocked: true,
      change: "permanent",
    });
    expect(decision.planChanged).toBe(false);
    expect(decision.code).toBe("order_locked");
    expect(decision.plannedOrderAt).toBe(baseline.candidateOrderAt.toISOString());
  });

  it("formats the reorder date in the household timezone", () => {
    expect(formatOrderDate(new Date("2026-11-02T07:30:00.000Z"), "America/Los_Angeles")).toBe("Nov 1");
    expect(formatOrderDate(new Date("2026-11-02T08:00:00.000Z"), "America/Los_Angeles")).toBe("Nov 2");
    expect(formatOrderDate(new Date("2026-11-02T08:00:00.000Z"), "UTC")).toBe("Nov 2");
  });
});
