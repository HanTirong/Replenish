/** Ten-day strip. Phones show Today through Runs out as equal columns inside the 24px gutters. */
export const DAY_STRIP = { count: 10, gutter: 24, gap: 5, phoneMax: 800, phoneTypeMax: 400, minCell: 30 } as const;

export type DayMarker = "order" | "delivery" | "runout" | "skip";

export interface DayTile {
  weekday: string;
  day: string;
  today: boolean;
  marker?: DayMarker;
}

export interface DaySource {
  date: string;
  markers: string[];
}

const KEY_MARKERS = new Set(["order", "delivery", "runout"]);

export function isKeyMarker(marker: string | undefined): boolean {
  return marker != null && KEY_MARKERS.has(marker);
}

/** Days from Today through Runs out, inclusive. The whole strip when there is no run-out day. */
export function daysThroughRunout(days: { marker?: string }[]): number {
  const index = days.findIndex((day) => day.marker === "runout");
  return index >= 0 ? index + 1 : Math.max(days.length, 1);
}

/** Equal column width inside the gutters. Never reports less than the cell minimum. */
export function phoneColumnWidth(
  viewport: number,
  count: number,
  gutter = DAY_STRIP.gutter,
  gap = DAY_STRIP.gap,
  minCell = DAY_STRIP.minCell,
): number {
  if (count <= 0) return minCell;
  const available = viewport - gutter * 2 - gap * Math.max(0, count - 1);
  return Math.max(minCell, available / count);
}

/** True when equal columns would drop under the minimum, so the strip may scroll, still starting at Today. */
export function phoneStripOverflows(
  viewport: number,
  count: number,
  gutter = DAY_STRIP.gutter,
  gap = DAY_STRIP.gap,
  minCell = DAY_STRIP.minCell,
): boolean {
  if (count <= 0 || viewport <= 0) return false;
  const available = viewport - gutter * 2 - gap * Math.max(0, count - 1);
  return available / count < minCell;
}

/** Shrink tiles only when the marker span itself is wider than the strip. */
export function tileWidthToFit(viewport: number, span: number, gap: number, pad: number, preferred: number): number {
  if (span <= 0 || preferred <= 0) return preferred;
  const available = viewport - pad;
  const fit = (available - gap * Math.max(0, span - 1)) / span;
  if (!Number.isFinite(fit) || fit <= 0) return preferred;
  return Math.min(preferred, fit);
}

/**
 * Scroll so Order, Delivery, and Runs out are fully inside the strip.
 * The scroll lands on a whole cell: that cell's left edge is the gutter, and nothing before it is cut in half.
 */
export function scrollLeftToReveal(input: {
  viewport: number;
  contentWidth: number;
  tileStarts: number[];
  tileWidth: number;
  markerIndexes: number[];
  gutter?: number;
}): number {
  const { viewport, contentWidth, tileStarts, tileWidth, markerIndexes } = input;
  const gutter = input.gutter ?? 0;
  const maxScroll = Math.max(0, contentWidth - viewport);
  const keys = markerIndexes.filter((index) => index >= 0 && index < tileStarts.length);
  if (!keys.length || viewport <= 0 || tileWidth <= 0) return 0;
  const first = Math.min(...keys);

  const snapScroll = (index: number) => {
    const start = tileStarts[index] ?? 0;
    return Math.min(maxScroll, Math.max(0, start - gutter));
  };
  const markersFit = (scroll: number) =>
    keys.every((index) => tileFullyVisible(index, scroll, viewport, tileStarts, tileWidth, gutter));

  for (let index = 0; index <= first; index += 1) {
    const scroll = snapScroll(index);
    if (markersFit(scroll)) return scroll;
  }
  return snapScroll(first);
}

export function tileFullyVisible(
  index: number,
  scroll: number,
  viewport: number,
  tileStarts: number[],
  tileWidth: number,
  gutter = 0,
): boolean {
  const left = (tileStarts[index] ?? 0) - scroll;
  const right = left + tileWidth;
  return left >= gutter - 0.5 && right <= viewport + 0.5;
}

/** Left edge of the first cell that is actually on screen. Half cells in the gutter do not count. */
export function leftmostVisibleLeft(
  scroll: number,
  viewport: number,
  tileStarts: number[],
  tileWidth: number,
  gutter: number,
): number | null {
  let leftmost: number | null = null;
  for (const start of tileStarts) {
    const left = start - scroll;
    const right = left + tileWidth;
    if (right <= gutter + 0.5 || left >= viewport) continue;
    if (leftmost == null || left < leftmost) leftmost = left;
  }
  return leftmost;
}

export function buildStrip(dates: DaySource[]): DayTile[] {
  const source = dates.slice(0, DAY_STRIP.count);
  while (source.length < DAY_STRIP.count) {
    const previous = source.at(-1)?.date;
    source.push({ date: previous ? nextDate(previous) : "2026-10-28", markers: [] });
  }
  return source.map((item, index) => ({
    weekday: index === 0 ? "Today" : shortWeekday(item.date),
    day: String(Number(item.date.slice(8, 10))),
    today: index === 0,
    marker: pickMarker(item.markers),
  }));
}

function pickMarker(markers: string[]): DayMarker | undefined {
  if (markers.includes("order")) return "order";
  if (markers.includes("delivery")) return "delivery";
  if (markers.includes("runout")) return "runout";
  if (markers.includes("skip")) return "skip";
  return undefined;
}

function shortWeekday(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function nextDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
