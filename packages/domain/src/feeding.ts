/**
 * Meal-by-meal forecast for one dog.
 * Meals are fixed local clock times. Evenly spaced meals make a rate change
 * move the run-out time by (stock/newDaily - stock/oldDaily) days.
 */

export const PLAN_THRESHOLD_HOURS = 24;
export const QIZAI_MEAL_MINUTES = [8 * 60, 20 * 60] as const;

export interface FeedingEvent {
  id: string;
  type: "permanent" | "temporary" | "actual";
  mealIndex?: number;
  /** Local calendar date in the pet timezone. */
  localDate?: string;
  grams: number;
  effectiveAt?: string;
  source: "chat" | "manual" | "llm";
  createdAt: string;
}

export interface MealForecastInput {
  stockG: number;
  gramsPerMeal: number;
  mealMinutes: readonly number[];
  timeZone: string;
  asOf: Date;
  events: readonly FeedingEvent[];
  shippingHours: number;
  bufferHours: number;
}

export interface MealForecast {
  predictedRunoutAt: Date;
  candidateOrderAt: Date;
  estimatedDeliveryAt: Date;
  daysOfFood: number;
}

/** Estimated stock at `asOf`, counting meals since the last measured anchor.
 * The anchor itself is before that instant's meal; meals at `asOf` are upcoming.
 * Keep the anchor immutable so reads, restarts and Undo cannot consume twice.
 */
export function estimateMealStock(input: {
  stockG: number;
  calibratedAt: Date;
  baselineGramsPerMeal: number;
  mealMinutes: readonly number[];
  timeZone: string;
  asOf: Date;
  events: readonly FeedingEvent[];
}): number {
  const anchor = input.calibratedAt.getTime();
  const end = input.asOf.getTime();
  if (!Number.isFinite(anchor) || !Number.isFinite(end) || end < anchor) {
    throw new Error("Stock estimate requires a valid time at or after calibration.");
  }
  const events = input.events.filter((event) =>
    event.type !== "permanent" || (event.effectiveAt && Date.parse(event.effectiveAt) >= anchor),
  );
  let remaining = input.stockG;
  for (const meal of mealsFrom(input.calibratedAt, input.timeZone, input.mealMinutes)) {
    if (meal.at.getTime() >= end || remaining <= 0) break;
    remaining = Math.max(0, remaining - gramsForMeal(meal, input.baselineGramsPerMeal, events));
  }
  return remaining;
}

export interface PlanDecision {
  planChanged: boolean;
  deltaHours: number;
  thresholdHours: number;
  riskOverride: boolean;
  code: "updated" | "below_threshold" | "risk_override" | "order_locked";
  previousPlannedOrderAt: string;
  candidateOrderAt: string;
  plannedOrderAt: string;
  predictedRunoutAt: string;
  estimatedDeliveryAt: string;
  /** Reorder date rendered in the pet timezone, for example "Nov 2". */
  orderDate: string;
  /** Planned reorder instant. This is the raw value behind orderDate. */
  orderDateRaw: string;
  headline: string;
  reason: string;
}

export function forecastMeals(input: MealForecastInput): MealForecast {
  const intervalMs = mealIntervalMs(input.mealMinutes.length);
  const runoutMs = walkRunoutMs(input, intervalMs);
  const predictedRunoutAt = new Date(runoutMs);
  const leadMs = (input.shippingHours + input.bufferHours) * 3_600_000;
  const candidateOrderAt = new Date(runoutMs - leadMs);
  const estimatedDeliveryAt = new Date(candidateOrderAt.getTime() + input.shippingHours * 3_600_000);
  const daysOfFood = (runoutMs - input.asOf.getTime()) / 86_400_000;
  return { predictedRunoutAt, candidateOrderAt, estimatedDeliveryAt, daysOfFood };
}

export function formatOrderDate(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
  const month = months[Number(parts.month) - 1] ?? "Jan";
  return `${month} ${Number(parts.day)}`;
}

export function homeReorderReason(orderDate: string): string {
  return `I'll reorder on ${orderDate} so it arrives before food runs out.`;
}

export function decideReplan(input: {
  petName: string;
  timeZone: string;
  previousPlannedOrderAt: Date;
  forecast: MealForecast;
  shippingHours: number;
  bufferHours: number;
  orderLocked: boolean;
  /** A confirmed receipt starts a new cycle, independently of the 24h edit rule. */
  newCycle?: boolean;
  change: "permanent" | "skip_dinner_tomorrow" | "other";
}): PlanDecision {
  const deltaHours = (input.forecast.candidateOrderAt.getTime() - input.previousPlannedOrderAt.getTime()) / 3_600_000;
  const deliveryUnderCurrent = input.previousPlannedOrderAt.getTime() + input.shippingHours * 3_600_000;
  const risk =
    deliveryUnderCurrent + input.bufferHours * 3_600_000 > input.forecast.predictedRunoutAt.getTime();
  const keptAt = input.previousPlannedOrderAt;
  const movedAt = input.forecast.candidateOrderAt;
  const base = {
    deltaHours,
    thresholdHours: PLAN_THRESHOLD_HOURS,
    previousPlannedOrderAt: keptAt.toISOString(),
    candidateOrderAt: input.forecast.candidateOrderAt.toISOString(),
    predictedRunoutAt: input.forecast.predictedRunoutAt.toISOString(),
  };
  const dated = (at: Date) => ({
    orderDate: formatOrderDate(at, input.timeZone),
    orderDateRaw: at.toISOString(),
  });

  if (input.orderLocked) {
    const when = dated(keptAt);
    return {
      ...base,
      ...when,
      planChanged: false,
      riskOverride: false,
      code: "order_locked",
      plannedOrderAt: keptAt.toISOString(),
      estimatedDeliveryAt: new Date(deliveryUnderCurrent).toISOString(),
      headline: `${input.petName}'s food is on the way.`,
      reason: `A paid order stays as it is. The reorder date stays ${when.orderDate}.`,
    };
  }

  if (risk && deltaHours < 0) {
    const when = dated(movedAt);
    return {
      ...base,
      ...when,
      planChanged: true,
      riskOverride: true,
      code: "risk_override",
      plannedOrderAt: movedAt.toISOString(),
      estimatedDeliveryAt: input.forecast.estimatedDeliveryAt.toISOString(),
      headline: `I moved ${input.petName}'s reorder earlier.`,
      reason: `Food would run out before delivery, so the reorder date moved up to ${when.orderDate}.`,
    };
  }

  if (input.newCycle || Math.abs(deltaHours) + 1e-9 >= PLAN_THRESHOLD_HOURS) {
    const when = dated(movedAt);
    return {
      ...base,
      ...when,
      planChanged: true,
      riskOverride: false,
      code: "updated",
      plannedOrderAt: movedAt.toISOString(),
      estimatedDeliveryAt: input.forecast.estimatedDeliveryAt.toISOString(),
      headline: `I updated ${input.petName}'s feeding plan.`,
      reason: `I recalculated the estimate and moved the reorder date to ${when.orderDate}.`,
    };
  }

  const unchangedDelivery = new Date(deliveryUnderCurrent).toISOString();
  const when = dated(keptAt);
  if (input.change === "skip_dinner_tomorrow") {
    return {
      ...base,
      ...when,
      planChanged: false,
      riskOverride: false,
      code: "below_threshold",
      plannedOrderAt: keptAt.toISOString(),
      estimatedDeliveryAt: unchangedDelivery,
      headline: `Noted. ${input.petName} skips dinner tomorrow.`,
      reason: `That's half a day of food, so the reorder date stays ${when.orderDate}.`,
    };
  }

  return {
    ...base,
    ...when,
    planChanged: false,
    riskOverride: false,
    code: "below_threshold",
    plannedOrderAt: keptAt.toISOString(),
    estimatedDeliveryAt: unchangedDelivery,
    headline: `Noted. I checked ${input.petName}'s plan.`,
    reason: `The reorder date stays ${when.orderDate}.`,
  };
}

export function localDateTimeToUtc(localDate: string, minutes: number, timeZone: string): Date {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const localIso = `${localDate}T${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00`;
  return zonedLocalToUtc(localIso, timeZone);
}

export function instantLocalDate(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mealIntervalMs(mealsPerDay: number): number {
  return (24 / mealsPerDay) * 3_600_000;
}

function walkRunoutMs(input: MealForecastInput, intervalMs: number): number {
  let stock = input.stockG;
  for (const meal of mealsFrom(input.asOf, input.timeZone, input.mealMinutes)) {
    const grams = gramsForMeal(meal, input.gramsPerMeal, input.events);
    if (grams <= 0) continue;
    if (stock <= grams) {
      return meal.at.getTime() + (stock / grams) * intervalMs;
    }
    stock -= grams;
    if (meal.index > 5000) break;
  }
  return input.asOf.getTime();
}

interface MealPoint {
  at: Date;
  localDate: string;
  mealIndex: number;
  index: number;
}

function* mealsFrom(asOf: Date, timeZone: string, mealMinutes: readonly number[]): Generator<MealPoint> {
  let localDate = instantLocalDate(asOf, timeZone);
  let index = 0;
  for (let day = 0; day < 800; day += 1) {
    for (let mealIndex = 0; mealIndex < mealMinutes.length; mealIndex += 1) {
      const at = localDateTimeToUtc(localDate, mealMinutes[mealIndex] ?? 0, timeZone);
      if (at.getTime() + 1 < asOf.getTime()) continue;
      yield { at, localDate, mealIndex, index };
      index += 1;
    }
    localDate = addLocalDays(localDate, 1);
  }
}

function gramsForMeal(meal: MealPoint, baseline: number, events: readonly FeedingEvent[]): number {
  const actual = events.find(
    (event) =>
      event.type === "actual" && event.localDate === meal.localDate && event.mealIndex === meal.mealIndex,
  );
  if (actual) return actual.grams;
  const temporary = events.find(
    (event) =>
      event.type === "temporary" && event.localDate === meal.localDate && event.mealIndex === meal.mealIndex,
  );
  if (temporary) return temporary.grams;
  const permanent = [...events]
    .reverse()
    .find((event) => event.type === "permanent" && event.effectiveAt && new Date(event.effectiveAt).getTime() <= meal.at.getTime());
  if (permanent) return permanent.grams;
  return baseline;
}

function zonedParts(instant: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  if (parts.hour === "24") parts.hour = "00";
  return parts;
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

function zonedLocalToUtc(localIso: string, timeZone: string): Date {
  const guess = new Date(`${localIso}Z`);
  const corrected = new Date(guess.getTime() - timeZoneOffsetMs(guess, timeZone));
  return new Date(guess.getTime() - timeZoneOffsetMs(corrected, timeZone));
}
