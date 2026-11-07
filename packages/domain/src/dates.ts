export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function assertIsoDate(value: string): asserts value is IsoDate {
  if (!ISO_DATE.test(value)) {
    throw new Error(`Invalid date: ${value}`);
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date: ${value}`);
  }
}

function utc(value: IsoDate): Date {
  assertIsoDate(value);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
}

export function todayIso(now = new Date()): IsoDate {
  return now.toISOString().slice(0, 10);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) {
    throw new Error(`Days must be an integer, got ${days}`);
  }
  const date = utc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Whole calendar days from `earlier` to `later`. Negative when `later` is first. */
export function diffDays(later: IsoDate, earlier: IsoDate): number {
  const ms = utc(later).getTime() - utc(earlier).getTime();
  return Math.round(ms / 86_400_000);
}

export function formatLongDate(value: IsoDate): string {
  const date = utc(value);
  const weekday = WEEKDAYS[date.getUTCDay()];
  const month = SHORT_MONTHS[date.getUTCMonth()];
  return `${weekday} ${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

export function monthKey(value: IsoDate): string {
  assertIsoDate(value);
  return value.slice(0, 7);
}

export function monthLabel(value: IsoDate): string {
  const date = utc(value);
  return `${LONG_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
