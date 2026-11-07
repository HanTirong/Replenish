import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freshCatalog } from "./catalog";
import { formatUsd } from "./money";
import { StoreError, type Product, type StoreOrder, type StoreState } from "./types";

export interface ProductView extends Product {
  price: string;
}

export interface OrderView extends StoreOrder {
  total: string;
  unitPrice: string;
}

export interface StoreOptions {
  filePath?: string;
  createId?: () => string;
  now?: () => Date;
}

function fallbackOrderId(): string {
  return `ord_${randomBytes(4).toString("hex")}`;
}

export function toProductView(product: Product): ProductView {
  return { ...product, price: formatUsd(product.priceCents) };
}

export function toOrderView(order: StoreOrder): OrderView {
  return {
    ...order,
    total: formatUsd(order.totalCents),
    unitPrice: formatUsd(order.unitPriceCents),
  };
}

export class StoreService {
  constructor(
    private state: StoreState,
    private readonly options: StoreOptions = {},
  ) {}

  static inMemory(partial?: { products?: Product[]; orders?: StoreOrder[] } & StoreOptions): StoreService {
    const { products, orders, ...options } = partial ?? {};
    return new StoreService(
      {
        products: (products ?? freshCatalog()).map((product) => ({ ...product })),
        orders: (orders ?? []).map((order) => ({ ...order })),
      },
      options,
    );
  }

  static open(filePath: string, options: Omit<StoreOptions, "filePath"> = {}): StoreService {
    let state: StoreState;
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreState;
      if (!parsed || !Array.isArray(parsed.products) || !Array.isArray(parsed.orders)) {
        throw new StoreError(`Store file at ${filePath} is invalid`);
      }
      state = parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      state = { products: freshCatalog(), orders: [] };
    }
    const service = new StoreService(state, { ...options, filePath });
    if (state.orders.length === 0) {
      // Persist the seed on first open so HTTP and MCP share one catalog.
      service.persist();
    }
    return service;
  }

  searchProducts(query?: { query?: string; category?: string }): Product[] {
    const text = query?.query?.trim().toLowerCase() ?? "";
    const category = query?.category?.trim().toLowerCase() ?? "";
    return this.state.products
      .filter((product) => {
        if (category && product.category.toLowerCase() !== category) return false;
        if (!text) return true;
        const haystack = [product.name, product.brand, product.sku, product.category, product.description]
          .join(" ")
          .toLowerCase();
        return haystack.includes(text);
      })
      .map((product) => ({ ...product }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku));
  }

  getProduct(sku: string): Product | null {
    const found = this.state.products.find((product) => product.sku === sku);
    return found ? { ...found } : null;
  }

  placeOrder(input: { sku: string; quantity?: number; createdAt?: string }): StoreOrder {
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new StoreError("quantity must be a positive integer", 400);
    }
    const product = this.state.products.find((item) => item.sku === input.sku);
    if (!product) {
      throw new StoreError(`Unknown SKU: ${input.sku}`, 404);
    }
    if (product.stock < quantity) {
      throw new StoreError(`Not enough stock for ${input.sku}`, 409);
    }
    product.stock -= quantity;
    const order: StoreOrder = {
      id: this.options.createId?.() ?? fallbackOrderId(),
      sku: product.sku,
      productName: product.name,
      quantity,
      unitPriceCents: product.priceCents,
      totalCents: product.priceCents * quantity,
      currency: "USD",
      shippingDays: product.shippingDays,
      status: "placed",
      createdAt: input.createdAt ?? (this.options.now ?? (() => new Date()))().toISOString(),
    };
    this.state.orders.push(order);
    this.persist();
    return { ...order };
  }

  getOrder(id: string): StoreOrder | null {
    const found = this.state.orders.find((order) => order.id === id);
    return found ? { ...found } : null;
  }

  snapshot(): StoreState {
    return structuredClone(this.state);
  }

  private persist(): void {
    if (!this.options.filePath) return;
    mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    const temporary = `${this.options.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(temporary, this.options.filePath);
  }
}
