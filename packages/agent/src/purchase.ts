import { gramsFromProduct, type Product, type StoreService } from "@replenish/store";

export interface PurchasePlan {
  /** In stock and weighable. Null when nothing can be bought. */
  product: Product | null;
  substituted: boolean;
  /** Lead time of the bag we would buy, or of the preferred SKU when none are in stock. */
  shippingDays: number;
}

/**
 * Buy the preferred SKU when it is in stock.
 * Otherwise pick the closest in-stock bag, in grams, in the same category.
 */
export function planPurchase(store: StoreService, preferredSku: string): PurchasePlan {
  const preferred = store.getProduct(preferredSku);
  if (preferred && preferred.stock > 0 && gramsFromProduct(preferred) != null) {
    return { product: preferred, substituted: false, shippingDays: preferred.shippingDays };
  }

  const category = preferred && gramsFromProduct(preferred) != null ? preferred.category : "dog-food";
  const target = preferred ? comparableSize(preferred) : null;
  const candidates = store
    .searchProducts({ category })
    .filter((product) => product.stock > 0 && product.sku !== preferredSku && gramsFromProduct(product) != null);

  candidates.sort((a, b) => {
    if (target != null) {
      const delta = Math.abs(comparableSize(a) - target) - Math.abs(comparableSize(b) - target);
      if (delta !== 0) return delta;
    }
    if (a.priceCents !== b.priceCents) return a.priceCents - b.priceCents;
    return a.sku.localeCompare(b.sku);
  });

  const product = candidates[0] ?? null;
  return {
    product,
    substituted: product != null,
    shippingDays: product?.shippingDays ?? preferred?.shippingDays ?? 0,
  };
}

function comparableSize(product: Product): number {
  return gramsFromProduct(product) ?? product.unitSize;
}
