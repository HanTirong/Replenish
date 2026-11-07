import { assertAdjustments } from "./predictor";
import type { Refill, RemainingAnchor, TrackedSupply, UsageAdjustment } from "./types";

/** Hook for a later LLM step: append a multiplier or a pause. The predictor only reads the list. */
export function applyUsageAdjustment(supply: TrackedSupply, adjustment: UsageAdjustment): TrackedSupply {
  assertAdjustments([adjustment]);
  if (!adjustment.reason.trim()) {
    throw new Error("Adjustment reason is required");
  }
  return { ...supply, adjustments: [...supply.adjustments, adjustment] };
}

export function logRefill(supply: TrackedSupply, refill: Refill): TrackedSupply {
  if (!Number.isFinite(refill.grams) || refill.grams <= 0) {
    throw new Error("Refill grams must be greater than 0");
  }
  return { ...supply, refills: [...supply.refills, refill] };
}

export function setRemainingAnchor(supply: TrackedSupply, anchor: RemainingAnchor): TrackedSupply {
  if (!Number.isFinite(anchor.grams) || anchor.grams < 0) {
    throw new Error("Remaining grams cannot be negative");
  }
  return { ...supply, anchor };
}
