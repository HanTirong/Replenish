import { describe, expect, it } from "vitest";
import { applyUsageAdjustment, logRefill, setRemainingAnchor } from "./household";
import { estimateRemaining, predictRunOut, projectDaysLeft } from "./predictor";
import type { TrackedSupply, UsageAdjustment } from "./types";

const opened = "2026-10-01";

function adjustment(partial: Partial<UsageAdjustment> & Pick<UsageAdjustment, "multiplier" | "startDate" | "endDate">): UsageAdjustment {
  return {
    id: partial.id ?? "adj",
    reason: partial.reason ?? "note",
    source: partial.source ?? "manual",
    ...partial,
  };
}

describe("estimateRemaining", () => {
  it("is the full bag on the morning it is opened", () => {
    expect(estimateRemaining({ bagSize: 4000, openedOn: opened, dailyUsage: 200 }, opened)).toBe(4000);
  });

  it("subtracts daily use for each completed day", () => {
    // 1 Oct through 16 Oct are 16 meals. 17 Oct has not been eaten yet.
    expect(estimateRemaining({ bagSize: 4000, openedOn: opened, dailyUsage: 200 }, "2026-10-17")).toBe(800);
  });

  it("keeps a sealed bag sealed before the open date", () => {
    expect(estimateRemaining({ bagSize: 4000, openedOn: opened, dailyUsage: 200 }, "2026-09-28")).toBe(4000);
  });

  it("adds a logged refill on the morning it happens, before that day's meal", () => {
    const remaining = estimateRemaining(
      {
        bagSize: 1000,
        openedOn: opened,
        dailyUsage: 100,
        refills: [{ date: "2026-10-05", amount: 500 }],
      },
      "2026-10-06",
    );
    expect(remaining).toBe(1000);
  });

  it("uses a manual remaining anchor and ignores earlier bag math", () => {
    const remaining = estimateRemaining(
      {
        bagSize: 4000,
        openedOn: opened,
        dailyUsage: 100,
        anchor: { asOf: "2026-10-05", amount: 400 },
      },
      "2026-10-07",
    );
    expect(remaining).toBe(200);
  });

  it("does not apply a refill twice when the anchor already includes it", () => {
    const remaining = estimateRemaining(
      {
        bagSize: 4000,
        openedOn: opened,
        dailyUsage: 100,
        anchor: { asOf: "2026-10-05", amount: 400 },
        refills: [
          { date: "2026-10-05", amount: 999 },
          { date: "2026-10-06", amount: 100 },
        ],
      },
      "2026-10-07",
    );
    expect(remaining).toBe(300);
  });

  it("clamps at zero when the bag was finished early", () => {
    expect(estimateRemaining({ bagSize: 100, openedOn: opened, dailyUsage: 80 }, "2026-10-05")).toBe(0);
  });

  it("treats a past pause as food that was not eaten", () => {
    const remaining = estimateRemaining(
      {
        bagSize: 1000,
        openedOn: opened,
        dailyUsage: 100,
        adjustments: [adjustment({ multiplier: 0, startDate: "2026-10-01", endDate: "2026-10-05", source: "llm" })],
      },
      "2026-10-11",
    );
    expect(remaining).toBe(500);
  });
});

describe("projectDaysLeft", () => {
  it("counts exact days of food", () => {
    expect(projectDaysLeft(800, "2026-10-17", 200)).toBe(4);
  });

  it("returns a fraction on the last partial day", () => {
    expect(projectDaysLeft(250, "2026-10-17", 200)).toBe(1.25);
  });

  it("is zero when the bin is already empty", () => {
    expect(projectDaysLeft(0, "2026-10-17", 200)).toBe(0);
  });

  it("does not run out when nothing is being eaten", () => {
    expect(projectDaysLeft(800, "2026-10-17", 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("stretches a future pause across calendar days", () => {
    const days = projectDaysLeft(1000, "2026-10-01", 100, [
      adjustment({ multiplier: 0, startDate: "2026-10-01", endDate: "2026-10-07" }),
    ]);
    expect(days).toBe(17);
  });

  it("halves the burn rate when an LLM marks the dog as eating less", () => {
    const days = projectDaysLeft(1000, "2026-10-01", 100, [
      adjustment({ multiplier: 0.5, startDate: "2026-10-01", endDate: "2026-12-01", reason: "Pip is sick, eating less", source: "llm" }),
    ]);
    expect(days).toBe(20);
  });

  it("multiplies overlapping windows", () => {
    const days = projectDaysLeft(100, "2026-10-01", 100, [
      adjustment({ id: "a", multiplier: 0.5, startDate: "2026-10-01", endDate: "2026-10-10" }),
      adjustment({ id: "b", multiplier: 0.5, startDate: "2026-10-01", endDate: "2026-10-10" }),
    ]);
    expect(days).toBe(4);
  });

  it("includes a future refill before that day's meal", () => {
    const withRefill = projectDaysLeft(150, "2026-10-01", 100, [], [{ date: "2026-10-02", amount: 50 }]);
    expect(withRefill).toBe(2);
    expect(projectDaysLeft(150, "2026-10-01", 100)).toBe(1.5);
  });
});

describe("predictRunOut", () => {
  const bag = { bagSize: 4000, openedOn: opened, dailyUsage: 200 };

  it("holds while days left are above shipping plus the default 2-day buffer", () => {
    const forecast = predictRunOut(bag, "2026-10-16", { shippingDays: 2 });
    expect(forecast.remaining).toBe(1000);
    expect(forecast.daysLeft).toBe(5);
    expect(forecast.thresholdDays).toBe(4);
    expect(forecast.bufferDays).toBe(2);
    expect(forecast.runOutDate).toBe("2026-10-21");
    expect(forecast.shouldReorder).toBe(false);
  });

  it("triggers on the morning days left meets shipping plus buffer", () => {
    const forecast = predictRunOut(bag, "2026-10-17", { shippingDays: 2, bufferDays: 2 });
    expect(forecast.remaining).toBe(800);
    expect(forecast.daysLeft).toBe(4);
    expect(forecast.runOutDate).toBe("2026-10-21");
    expect(forecast.shouldReorder).toBe(true);
  });

  it("orders a day sooner when the chosen bag ships slower", () => {
    const friday = predictRunOut(bag, "2026-10-16", { shippingDays: 3, bufferDays: 2 });
    expect(friday.daysLeft).toBe(5);
    expect(friday.thresholdDays).toBe(5);
    expect(friday.shouldReorder).toBe(true);
    const thursday = predictRunOut(bag, "2026-10-15", { shippingDays: 3, bufferDays: 2 });
    expect(thursday.daysLeft).toBe(6);
    expect(thursday.shouldReorder).toBe(false);
  });

  it("does not reorder when a pause keeps the bin ahead of the threshold", () => {
    const quiet = predictRunOut(
      {
        ...bag,
        adjustments: [adjustment({ multiplier: 0, startDate: "2026-10-17", endDate: "2026-10-26", reason: "Boarded", source: "llm" })],
      },
      "2026-10-17",
      { shippingDays: 2, bufferDays: 2 },
    );
    expect(quiet.daysLeft).toBe(14);
    expect(quiet.shouldReorder).toBe(false);
  });

  it("reorders immediately when the bin is already empty", () => {
    const forecast = predictRunOut({ bagSize: 100, openedOn: opened, dailyUsage: 80 }, "2026-10-05", { shippingDays: 2 });
    expect(forecast.remaining).toBe(0);
    expect(forecast.daysLeft).toBe(0);
    expect(forecast.runOutDate).toBe("2026-10-05");
    expect(forecast.shouldReorder).toBe(true);
  });
});

describe("household hooks", () => {
  const supply: TrackedSupply = {
    id: "sup",
    petId: "pet",
    sku: "RC-SMALL-4",
    bagSizeGrams: 1000,
    openedOn: opened,
    anchor: null,
    refills: [],
    adjustments: [],
  };

  it("records an LLM adjustment, a refill, and a manual remaining", () => {
    const adjusted = applyUsageAdjustment(
      supply,
      adjustment({ id: "llm_1", multiplier: 0.5, startDate: "2026-11-01", endDate: "2026-11-07", reason: "Eating less", source: "llm" }),
    );
    const refilled = logRefill(adjusted, { id: "ref_1", date: "2026-10-05", grams: 200, note: "Spare cup" });
    const measured = setRemainingAnchor(refilled, { asOf: "2026-10-06", grams: 700 });
    expect(measured.adjustments).toHaveLength(1);
    expect(measured.adjustments[0]?.source).toBe("llm");
    expect(measured.refills[0]?.grams).toBe(200);
    expect(measured.anchor).toEqual({ asOf: "2026-10-06", grams: 700 });
  });

  it("rejects a negative multiplier and a refill of nothing", () => {
    expect(() =>
      applyUsageAdjustment(supply, adjustment({ multiplier: -1, startDate: opened, endDate: opened })),
    ).toThrow(/multiplier/);
    expect(() => logRefill(supply, { id: "ref", date: opened, grams: 0 })).toThrow(/greater than 0/);
  });
});
