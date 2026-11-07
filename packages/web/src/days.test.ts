import { describe, expect, it } from "vitest";
import { approvalNote, breakHeadline, PAYPAL_TITLES, paidCaptureLine, phraseAboutDays } from "./copy";
import {
  DAY_STRIP,
  buildStrip,
  daysThroughRunout,
  leftmostVisibleLeft,
  phoneColumnWidth,
  phoneStripOverflows,
  scrollLeftToReveal,
  tileFullyVisible,
  tileWidthToFit,
} from "./days";

function tileStarts(count: number, pad: number, tile: number, gap: number): number[] {
  return Array.from({ length: count }, (_, index) => pad + index * (tile + gap));
}

describe("day strip", () => {
  it("snaps the first visible cell to the 24px gutter and keeps Order, Delivery, and Runs out whole", () => {
    const markers = [4, 6, 8];
    const gap = 5;
    const gutter = DAY_STRIP.gutter;
    const count = 10;
    for (const viewport of [360, 390, 430, 1280]) {
      const preferred = 39;
      const span = Math.max(...markers) - Math.min(...markers) + 1;
      const tile = tileWidthToFit(viewport, span, gap, gutter, preferred);
      const starts = tileStarts(count, gutter, tile, gap);
      const contentWidth = gutter + count * tile + (count - 1) * gap + gutter;
      const scroll = scrollLeftToReveal({
        viewport,
        contentWidth,
        tileStarts: starts,
        tileWidth: tile,
        markerIndexes: markers,
        gutter,
      });
      for (const index of markers) {
        expect(tileFullyVisible(index, scroll, viewport, starts, tile, gutter)).toBe(true);
      }
      expect(leftmostVisibleLeft(scroll, viewport, starts, tile, gutter)).toBeCloseTo(gutter, 0);
    }
  });

  it("keeps a full ten-day marker span on a narrow phone by shrinking tiles", () => {
    const markers = [0, 4, 9];
    const viewport = 360;
    const gutter = DAY_STRIP.gutter;
    const tile = tileWidthToFit(viewport, 10, 5, gutter, 39);
    expect(tile).toBeLessThan(39);
    const starts = tileStarts(10, gutter, tile, 5);
    const contentWidth = gutter + 10 * tile + 9 * 5 + gutter;
    const scroll = scrollLeftToReveal({
      viewport,
      contentWidth,
      tileStarts: starts,
      tileWidth: tile,
      markerIndexes: markers,
      gutter,
    });
    for (const index of markers) expect(tileFullyVisible(index, scroll, viewport, starts, tile, gutter)).toBe(true);
    expect(leftmostVisibleLeft(scroll, viewport, starts, tile, gutter)).toBeCloseTo(gutter, 0);
  });

  it("does not scroll when the markers already fit", () => {
    const gutter = DAY_STRIP.gutter;
    const starts = tileStarts(10, gutter, 39, 5);
    const scroll = scrollLeftToReveal({
      viewport: 1280,
      contentWidth: gutter + 10 * 39 + 9 * 5 + gutter,
      tileStarts: starts,
      tileWidth: 39,
      markerIndexes: [1, 2, 3],
      gutter,
    });
    expect(scroll).toBe(0);
    expect(leftmostVisibleLeft(scroll, 1280, starts, 39, gutter)).toBeCloseTo(gutter, 0);
  });

  it("fills Today through Runs out on a phone without scrolling", () => {
    const days = [
      {},
      {},
      {},
      {},
      { marker: "order" },
      {},
      { marker: "delivery" },
      {},
      { marker: "runout" },
      {},
    ];
    const count = daysThroughRunout(days);
    expect(count).toBe(9);
    for (const viewport of [360, 390]) {
      expect(phoneStripOverflows(viewport, count)).toBe(false);
      const width = phoneColumnWidth(viewport, count);
      expect(width).toBeGreaterThanOrEqual(DAY_STRIP.minCell);
      const runoutRight = DAY_STRIP.gutter + count * width + (count - 1) * DAY_STRIP.gap;
      expect(runoutRight).toBeLessThanOrEqual(viewport - DAY_STRIP.gutter + 0.5);
    }
  });

  it("keeps a 30px floor and starts at Today when the run-out span is very long", () => {
    expect(phoneStripOverflows(360, 14)).toBe(true);
    expect(phoneColumnWidth(360, 14)).toBe(DAY_STRIP.minCell);
    expect(daysThroughRunout([{ marker: "runout" }, {}])).toBe(1);
    expect(daysThroughRunout([{}, {}])).toBe(2);
  });

  it("pads a short API grid out to ten cells and marks a skip", () => {
    const tiles = buildStrip([
      { date: "2026-10-28", markers: [] },
      { date: "2026-10-29", markers: ["skip"] },
      { date: "2026-10-30", markers: ["order"] },
    ]);
    expect(tiles).toHaveLength(10);
    expect(tiles[0]).toMatchObject({ weekday: "Today", day: "28" });
    expect(tiles[1]?.marker).toBe("skip");
    expect(tiles[2]).toMatchObject({ weekday: "Fri", marker: "order" });
    expect(tiles.at(-1)?.day).toBe("6");
  });
});

describe("days left", () => {
  it("rounds a fractional count to whole days, with a singular day", () => {
    expect(phraseAboutDays(8.36)).toBe("about 8 days");
    expect(phraseAboutDays(8.5)).toBe("about 9 days");
    expect(phraseAboutDays(1.2)).toBe("about 1 day");
    expect(phraseAboutDays(1)).toBe("about 1 day");
    expect(phraseAboutDays(0.4)).toBe("about 0 days");
    expect(breakHeadline("Qizai has about 8.36 days of food left.")).toBe("Qizai has about\n8 days of food left.");
    expect(breakHeadline("Qizai has about 1.2 days of food left.")).toBe("Qizai has about\n1 day of food left.");
    expect(breakHeadline("Qizai has about 8 days of food left.")).toBe("Qizai has about\n8 days of food left.");
  });
});

describe("approval note", () => {
  it("names the limit that was crossed", () => {
    expect(approvalNote([{ code: "per_order", limitCents: 5000 }])).toBe("Over your $50 auto-pay limit");
    expect(approvalNote([{ code: "monthly", limitCents: 12000 }])).toBe("Over your monthly budget");
    expect(approvalNote([
      { code: "per_order", limitCents: 5000 },
      { code: "monthly", limitCents: 12000 },
    ])).toBe("Over your $50 auto-pay limit. Over your monthly budget");
    expect(approvalNote([])).toBe("");
  });
});

describe("paid capture line", () => {
  it("shows the last six characters until the line is opened", () => {
    expect(paidCaptureLine("3C679366HH908993F")).toBe("Paid with PayPal · …08993F");
    expect(paidCaptureLine("3C679366HH908993F", true)).toBe("Paid with PayPal · 3C679366HH908993F");
    expect(paidCaptureLine("CAP123")).toBe("Paid with PayPal · …CAP123");
  });
});

describe("screen copy", () => {
  it("breaks the home sentence and uses the spec titles for PayPal screens 6 and 7", () => {
    expect(breakHeadline("Qizai has about 8 days of food left.")).toBe("Qizai has about\n8 days of food left.");
    expect(breakHeadline("Noted. Qizai skips dinner tomorrow.")).toBe("Noted. Qizai skips\ndinner tomorrow.");
    expect(PAYPAL_TITLES.connected).toBe("One more step: allow\nautomatic payments.");
    expect(PAYPAL_TITLES.authorized).toBe("Automatic\nreplenishment is on.");
  });
});
