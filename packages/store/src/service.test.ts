import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SEED_PRODUCTS } from "./catalog";
import { gramsFromProduct } from "./money";
import { StoreService } from "./service";
import { StoreError } from "./types";

describe("catalog", () => {
  it("seeds dog food and other household essentials", () => {
    expect(SEED_PRODUCTS.length).toBeGreaterThanOrEqual(10);
    expect(SEED_PRODUCTS.length).toBeLessThanOrEqual(15);
    const categories = new Set(SEED_PRODUCTS.map((product) => product.category));
    expect(categories).toContain("dog-food");
    expect(categories).toContain("household");
    const dogFoodSizes = new Set(
      SEED_PRODUCTS.filter((product) => product.category === "dog-food").map((product) => product.unitSize),
    );
    expect(dogFoodSizes.size).toBeGreaterThanOrEqual(4);
    expect(gramsFromProduct(SEED_PRODUCTS.find((product) => product.sku === "RC-SMALL-4")!)).toBe(4000);
    expect(gramsFromProduct(SEED_PRODUCTS.find((product) => product.sku === "HILLS-AD-68")!)).toBe(6800);
  });
});

describe("StoreService", () => {
  it("searches by text and category", () => {
    const store = StoreService.inMemory();
    const royal = store.searchProducts({ query: "royal canin", category: "dog-food" });
    expect(royal.map((product) => product.sku)).toEqual(["RC-SMALL-4", "RC-SMALL-8"]);
    expect(store.searchProducts({ category: "household" }).every((product) => product.category === "household")).toBe(true);
    expect(store.searchProducts({ query: "pike place" })).toHaveLength(1);
  });

  it("places an order and decrements stock", () => {
    const store = StoreService.inMemory({ createId: () => "ord_test", now: () => new Date("2026-10-17T15:00:00Z") });
    const before = store.getProduct("RC-SMALL-4")!.stock;
    const order = store.placeOrder({ sku: "RC-SMALL-4", quantity: 2 });
    expect(order).toMatchObject({
      id: "ord_test",
      totalCents: 3500 * 2,
      shippingDays: 2,
      status: "placed",
      createdAt: "2026-10-17T15:00:00.000Z",
    });
    expect(store.getOrder("ord_test")?.quantity).toBe(2);
    expect(store.getProduct("RC-SMALL-4")!.stock).toBe(before - 2);
  });

  it("rejects unknown SKUs and empty stock", () => {
    const store = StoreService.inMemory({
      products: [{ ...SEED_PRODUCTS[0]!, stock: 0 }],
    });
    expect(() => store.placeOrder({ sku: "NOPE" })).toThrow(StoreError);
    try {
      store.placeOrder({ sku: "RC-SMALL-4" });
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).statusCode).toBe(409);
    }
  });

  it("persists stock and orders to a JSON file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "replenish-store-"));
    const filePath = path.join(directory, "store.json");
    const first = StoreService.open(filePath, { createId: () => "ord_file" });
    first.placeOrder({ sku: "DAWN-ULTRA" });
    const second = StoreService.open(filePath);
    expect(second.getOrder("ord_file")?.sku).toBe("DAWN-ULTRA");
    const seeded = SEED_PRODUCTS.find((product) => product.sku === "DAWN-ULTRA")!.stock;
    expect(second.getProduct("DAWN-ULTRA")!.stock).toBe(seeded - 1);
  });
});
