import { describe, expect, it } from "vitest";
import { addDays, assertIsoDate, diffDays, formatLongDate, monthKey, monthLabel } from "./dates";

describe("dates", () => {
  it("rejects impossible calendar dates", () => {
    expect(() => assertIsoDate("2026-02-31")).toThrow(/Invalid date/);
    expect(() => assertIsoDate("17 Oct 2026")).toThrow(/Invalid date/);
  });

  it("counts whole UTC days", () => {
    expect(diffDays("2026-10-17", "2026-10-01")).toBe(16);
    expect(addDays("2026-10-17", 2)).toBe("2026-10-19");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });

  it("formats a stable English date", () => {
    expect(formatLongDate("2026-10-17")).toBe("Sat 17 Oct 2026");
    expect(monthKey("2026-10-17")).toBe("2026-10");
    expect(monthLabel("2026-10-17")).toBe("October 2026");
  });
});
