import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { SEED_PRODUCTS } from "./catalog";
import { createStoreMcpServer } from "./mcp";
import { StoreService } from "./service";

async function withClient(store: StoreService, run: (client: Client) => Promise<void>): Promise<void> {
  const server = createStoreMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "replenish-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("store MCP server", () => {
  it("lists search, get, place, and fetch tools", async () => {
    const store = StoreService.inMemory({ createId: () => "ord_mcp" });
    await withClient(store, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "get_order",
        "get_product",
        "place_order",
        "search_products",
      ]);

      const search = await client.callTool({
        name: "search_products",
        arguments: { category: "dog-food", query: "royal canin small" },
      });
      expect(JSON.stringify(search)).toContain("RC-SMALL-4");

      const missing = await client.callTool({
        name: "get_product",
        arguments: { sku: "NOPE" },
      });
      expect(missing.isError).toBe(true);

      const placed = await client.callTool({
        name: "place_order",
        arguments: { sku: "BOUNTY-8", quantity: 1 },
      });
      const placedText = textOf(placed);
      expect(placedText).toContain("ord_mcp");
      expect(placedText).toContain("24.99");

      const fetched = await client.callTool({
        name: "get_order",
        arguments: { orderId: "ord_mcp" },
      });
      expect(textOf(fetched)).toContain("BOUNTY-8");
      const seeded = SEED_PRODUCTS.find((product) => product.sku === "BOUNTY-8")!.stock;
      expect(store.getProduct("BOUNTY-8")!.stock).toBe(seeded - 1);
    });
  });

  it("starts over stdio and lists its tools", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "replenish-mcp-"));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.STORE_DATA = path.join(directory, "store.json");
    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["exec", "tsx", "packages/store/src/mcp.ts"],
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "replenish-stdio", version: "0.1.0" });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "get_order",
        "get_product",
        "place_order",
        "search_products",
      ]);
    } finally {
      await client.close();
    }
  });
});

function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    return JSON.stringify(result);
  }
  return result.content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") return block.text;
      return "";
    })
    .join("\n");
}
