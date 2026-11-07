import { addDays, assertIsoDate, diffDays, type IsoDate } from "./dates";
import type { UsageAdjustment } from "./types";

/** Default spare days still on hand when a delivery arrives. */
export const DEFAULT_BUFFER_DAYS = 2;

const MAX_PROJECTION_DAYS = 3660;
const MAX_HISTORY_DAYS = 20000;

export interface AmountOnDate {
  date: IsoDate;
  amount: number;
}

export interface ForecastAnchor {
  /** Remaining at the start of this date, before consumption, refill already included. */
  asOf: IsoDate;
  amount: number;
}

/**
 * Unit-agnostic supply. This milestone passes grams of kibble.
 * A later category (paper towels, detergent) can pass its own unit.
 */
export interface ForecastInput {
  bagSize: number;
  openedOn: IsoDate;
  /** Baseline amount consumed per calendar day, before adjustments. */
  dailyUsage: number;
  anchor?: ForecastAnchor | null;
  refills?: readonly AmountOnDate[];
  adjustments?: readonly UsageAdjustment[];
}

export interface RunOutForecast {
  asOf: IsoDate;
  /** Amount at the start of `asOf`, after a refill dated today, before today's use. */
  remaining: number;
  /**
   * Calendar days until the bin is empty at the start of a morning.
   * A pause counts: boarded days push the run-out date out.
   * Infinity means the forecast window never drains the supply.
   */
  daysLeft: number;
  /** First morning with nothing left. Null when `daysLeft` is infinite. */
  runOutDate: IsoDate | null;
  shippingDays: number;
  bufferDays: number;
  thresholdDays: number;
  shouldReorder: boolean;
}

export function assertAdjustments(adjustments: readonly UsageAdjustment[]): void {
  for (const adjustment of adjustments) {
    assertIsoDate(adjustment.startDate);
    assertIsoDate(adjustment.endDate);
    if (adjustment.endDate < adjustment.startDate) {
      throw new Error(`Adjustment "${adjustment.id}" ends before it starts`);
    }
    if (!Number.isFinite(adjustment.multiplier) || adjustment.multiplier < 0) {
      throw new Error(`Adjustment "${adjustment.id}" multiplier must be >= 0`);
    }
    if (adjustment.source !== "manual" && adjustment.source !== "llm") {
      throw new Error(`Adjustment "${adjustment.id}" has an unknown source`);
    }
  }
}

/** Product of every adjustment covering `date`. An empty set is 1. */
export function multiplierOn(date: IsoDate, adjustments: readonly UsageAdjustment[]): number {
  let factor = 1;
  for (const adjustment of adjustments) {
    if (date >= adjustment.startDate && date <= adjustment.endDate) {
      factor *= adjustment.multiplier;
    }
  }
  if (!Number.isFinite(factor) || factor < 0) return 0;
  return factor;
}

function assertAmount(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

function refillOn(refills: readonly AmountOnDate[], date: IsoDate): number {
  let total = 0;
  for (const refill of refills) {
    if (refill.date === date) total += refill.amount;
  }
  return total;
}

/**
 * Remaining at the start of `asOf`.
 *
 * Each earlier day adds that morning's refills, then subtracts daily use
 * times the adjustment multiplier. Today's refill is included. Today's meal
 * is not. An anchor replaces the bag math from that morning onward and
 * already includes any refill the person counted when they measured.
 */
export function estimateRemaining(input: ForecastInput, asOf: IsoDate): number {
  assertIsoDate(asOf);
  assertIsoDate(input.openedOn);
  assertAmount("bagSize", input.bagSize);
  assertAmount("dailyUsage", input.dailyUsage);
  const adjustments = input.adjustments ?? [];
  const refills = input.refills ?? [];
  assertAdjustments(adjustments);
  for (const refill of refills) {
    assertIsoDate(refill.date);
    assertAmount("refill", refill.amount);
  }

  const anchor = input.anchor && input.anchor.asOf <= asOf ? input.anchor : null;
  if (anchor) {
    assertIsoDate(anchor.asOf);
    assertAmount("anchor", anchor.amount);
  }

  if (!anchor && asOf < input.openedOn) {
    return input.bagSize;
  }

  const start = anchor ? anchor.asOf : input.openedOn;
  let remaining = anchor ? anchor.amount : input.bagSize;
  if (diffDays(asOf, start) > MAX_HISTORY_DAYS) {
    throw new Error("Date range is too large");
  }

  let cursor = start;
  while (cursor < asOf) {
    if (!(anchor && cursor === anchor.asOf)) {
      remaining += refillOn(refills, cursor);
    }
    const used = input.dailyUsage * multiplierOn(cursor, adjustments);
    remaining = Math.max(0, remaining - used);
    cursor = addDays(cursor, 1);
  }

  if (!(anchor && asOf === anchor.asOf)) {
    remaining += refillOn(refills, asOf);
  }
  return remaining;
}

export function projectDaysLeft(
  remaining: number,
  asOf: IsoDate,
  dailyUsage: number,
  adjustments: readonly UsageAdjustment[] = [],
  refills: readonly AmountOnDate[] = [],
): number {
  assertIsoDate(asOf);
  assertAmount("remaining", remaining);
  assertAmount("dailyUsage", dailyUsage);
  assertAdjustments(adjustments);
  if (remaining <= 0) return 0;
  if (dailyUsage <= 0 && refills.every((refill) => refill.date <= asOf)) {
    return Number.POSITIVE_INFINITY;
  }

  let left = remaining;
  let days = 0;
  let cursor = asOf;
  while (left > 0 && days < MAX_PROJECTION_DAYS) {
    if (cursor !== asOf) {
      left += refillOn(refills, cursor);
    }
    const used = dailyUsage * multiplierOn(cursor, adjustments);
    if (used <= 0) {
      days += 1;
      cursor = addDays(cursor, 1);
      continue;
    }
    if (left <= used) {
      days += left / used;
      left = 0;
      break;
    }
    left -= used;
    days += 1;
    cursor = addDays(cursor, 1);
  }

  if (left > 0) return Number.POSITIVE_INFINITY;
  return days;
}

/** First morning that starts empty. Exact integers land on that morning. */
export function runOutDateFor(asOf: IsoDate, daysLeft: number): IsoDate | null {
  if (!Number.isFinite(daysLeft)) return null;
  const morningsAhead = Math.ceil(daysLeft - 1e-9);
  return addDays(asOf, morningsAhead);
}

/**
 * Reorder when the bin will be empty before a shipment can arrive
 * and still leave `bufferDays` of food (default 2).
 */
export function predictRunOut(
  input: ForecastInput,
  asOf: IsoDate,
  options: { shippingDays: number; bufferDays?: number },
): RunOutForecast {
  assertAmount("shippingDays", options.shippingDays);
  const bufferDays = options.bufferDays ?? DEFAULT_BUFFER_DAYS;
  assertAmount("bufferDays", bufferDays);
  const adjustments = input.adjustments ?? [];
  const refills = input.refills ?? [];
  const remaining = estimateRemaining(input, asOf);
  const daysLeft = projectDaysLeft(remaining, asOf, input.dailyUsage, adjustments, refills);
  const thresholdDays = options.shippingDays + bufferDays;
  return {
    asOf,
    remaining,
    daysLeft,
    runOutDate: runOutDateFor(asOf, daysLeft),
    shippingDays: options.shippingDays,
    bufferDays,
    thresholdDays,
    shouldReorder: daysLeft <= thresholdDays,
  };
}
