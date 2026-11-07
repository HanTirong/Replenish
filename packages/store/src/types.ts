export interface Product {
  sku: string;
  name: string;
  /** Free-form category slug. This milestone ships `dog-food` and `household`. */
  category: string;
  brand: string;
  unitSize: number;
  /** Examples: kg, g, L, count. */
  unit: string;
  priceCents: number;
  currency: "USD";
  stock: number;
  shippingDays: number;
  description: string;
}

export interface StoreOrder {
  id: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  currency: "USD";
  shippingDays: number;
  status: "placed";
  createdAt: string;
}

export interface StoreState {
  products: Product[];
  orders: StoreOrder[];
}

export class StoreError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "StoreError";
    this.statusCode = statusCode;
  }
}
