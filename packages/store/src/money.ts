export function formatUsd(cents: number): string {
  if (!Number.isFinite(cents)) {
    throw new Error("Amount must be finite");
  }
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.round(Math.abs(cents));
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const body = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${body}.${remainder.toString().padStart(2, "0")}`;
}

export function gramsFromProduct(product: { unitSize: number; unit: string }): number | null {
  if (product.unit === "kg") return Math.round(product.unitSize * 1000);
  if (product.unit === "g") return Math.round(product.unitSize);
  return null;
}
