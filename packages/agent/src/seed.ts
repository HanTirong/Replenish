import {
  addDays,
  DEFAULT_BUFFER_DAYS,
  todayIso,
  type HouseholdState,
  type IsoDate,
  type PetProfile,
} from "@replenish/domain";
import { gramsFromProduct, SEED_PRODUCTS } from "@replenish/store";

/** Pip, a cockapoo. Daily grams are the predictor input; weight is stored for a later estimate. */
export const PIP: PetProfile = {
  id: "pet_pip",
  name: "Pip",
  species: "dog",
  breed: "cockapoo",
  weightKg: 8.6,
  dailyGrams: 200,
};

export const OPEN_BAG_SKU = "RC-SMALL-4";
export const LARGE_BAG_SKU = "RC-SMALL-8";

export function buildPipHousehold(options?: {
  openedOn?: IsoDate;
  preferredSku?: string;
  openSku?: string;
  perOrderBudgetCents?: number;
  monthlyBudgetCents?: number;
  bufferDays?: number;
}): HouseholdState {
  const openSku = options?.openSku ?? OPEN_BAG_SKU;
  const product = SEED_PRODUCTS.find((item) => item.sku === openSku);
  if (!product) throw new Error(`Unknown open SKU ${openSku}`);
  const grams = gramsFromProduct(product);
  if (grams == null) throw new Error(`SKU ${openSku} is not weighed in grams`);
  // 16 completed days of 200 g from a 4 kg bag leaves 800 g, which is 4.0 days.
  // With a 2-day ship time and a 2-day buffer, today is the reorder morning.
  const openedOn = options?.openedOn ?? addDays(todayIso(), -16);
  return {
    version: 1,
    householdName: "Hart",
    pets: [{ ...PIP }],
    supplies: [
      {
        id: "sup_kibble",
        petId: PIP.id,
        sku: openSku,
        bagSizeGrams: grams,
        openedOn,
        anchor: null,
        refills: [],
        adjustments: [],
      },
    ],
    rules: {
      perOrderBudgetCents: options?.perOrderBudgetCents ?? 5000,
      monthlyBudgetCents: options?.monthlyBudgetCents ?? 12000,
      preferredSku: options?.preferredSku ?? openSku,
      bufferDays: options?.bufferDays ?? DEFAULT_BUFFER_DAYS,
      currency: "USD",
    },
    replenishments: [],
  };
}
