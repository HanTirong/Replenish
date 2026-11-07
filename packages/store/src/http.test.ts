import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { startStoreServer } from "./http";
import { StoreService } from "./service";

describe("store HTTP API", () => {
  it("lists, fetches, orders, and reads the order back", async () => {
    const store = StoreService.inMemory({ createId: () => "ord_http" });
    const server: Server = await startStoreServer({ store, port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const health = await fetch(`${base}/health`);
      expect(await health.json()).toMatchObject({ ok: true, products: 15 });

      const listed = await fetch(`${base}/products?category=dog-food&q=oriJen`);
      const listedBody = (await listed.json()) as { products: Array<{ sku: string; price: string }> };
      expect(listedBody.products).toEqual([expect.objectContaining({ sku: "ORIJEN-ORIG-6", price: "$74.99" })]);

      const missing = await fetch(`${base}/products/NOPE`);
      expect(missing.status).toBe(404);

      const created = await fetch(`${base}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku: "RC-SMALL-4" }),
      });
      expect(created.status).toBe(201);
      const order = (await created.json()) as { id: string; totalCents: number; total: string };
      expect(order).toMatchObject({ id: "ord_http", totalCents: 3500, total: "$35.00" });

      const fetched = await fetch(`${base}/orders/${order.id}`);
      expect(fetched.status).toBe(200);
      expect(await fetched.json()).toMatchObject({ id: "ord_http", sku: "RC-SMALL-4" });

      const bad = await fetch(`${base}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku: "RC-SMALL-4", quantity: 0 }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
