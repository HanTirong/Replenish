import type { IsoDate } from "./dates";

/**
 * A temporary change to baseline daily use.
 * A later milestone can append these from an LLM
 * ("Pip is sick, eating less", "boarded for two weeks")
 * without changing the predictor. `multiplier` 0 is a pause.
 * Overlapping windows multiply.
 */
export interface UsageAdjustment {
  id: string;
  startDate: IsoDate;
  endDate: IsoDate;
  multiplier: number;
  reason: string;
  source: "manual" | "llm";
}

export interface Refill {
  id: string;
  date: IsoDate;
  grams: number;
  note?: string;
}

/** Measured remaining at the start of `asOf`, before that day's meal. */
export interface RemainingAnchor {
  asOf: IsoDate;
  grams: number;
}

export interface PetProfile {
  id: string;
  name: string;
  species: string;
  breed: string;
  weightKg: number;
  /** Baseline grams per day. Adjustments scale this; they do not replace it. */
  dailyGrams: number;
}

export interface TrackedSupply {
  id: string;
  petId: string;
  sku: string;
  /** Grams in the bag on the morning it was opened. */
  bagSizeGrams: number;
  openedOn: IsoDate;
  anchor: RemainingAnchor | null;
  refills: Refill[];
  adjustments: UsageAdjustment[];
}

export interface HouseholdRules {
  perOrderBudgetCents: number;
  monthlyBudgetCents: number;
  /** SKU to buy next. Household-wide in this milestone; later this can vary by category. */
  preferredSku: string;
  /** Extra days of food that should still be in the bin when the new bag arrives. */
  bufferDays: number;
  currency: "USD";
}

export type ReplenishmentStatus = "pending_approval" | "rejected" | "ordered" | "delivered";

export interface Replenishment {
  id: string;
  supplyId: string;
  sku: string;
  productName: string;
  quantity: number;
  totalCents: number;
  currency: "USD";
  status: ReplenishmentStatus;
  autoPay: boolean;
  reasons: string[];
  substituted: boolean;
  paymentId: string | null;
  paymentProvider: string | null;
  storeOrderId: string | null;
  shippingDays: number | null;
  orderedOn: IsoDate | null;
  expectedArrival: IsoDate | null;
  deliveredOn: IsoDate | null;
  createdOn: IsoDate;
  decidedOn: IsoDate | null;
  /** CLI one-time approval. Optional so existing household JSON remains readable. */
  paymentApproval?: { authorizationId: string; snapshot: string; approvedOn: IsoDate };
}

export interface HouseholdState {
  version: 1;
  householdName: string;
  pets: PetProfile[];
  supplies: TrackedSupply[];
  rules: HouseholdRules;
  replenishments: Replenishment[];
}
