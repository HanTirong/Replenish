import { dataFile } from "@replenish/domain";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { StoreService, toOrderView, toProductView } from "./service";
import { StoreError } from "./types";

/**
 * MCP tools over the same StoreService as the HTTP API.
 * Stdio is the protocol stream: do not write logs to stdout.
 */
export function createStoreMcpServer(store: StoreService): McpServer {
  const server = new McpServer({
    name: "replenish-store",
    version: "0.1.0",
  });

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: "Search the simulated household catalog by text and category. Omit both to list everything.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive match on name, brand, SKU, category, or description."),
        category: z.string().optional().describe('Category slug, for example "dog-food" or "household".'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, category }) => {
      const products = store.searchProducts({ query, category }).map(toProductView);
      return jsonResult({ products });
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "Fetch one catalog product by SKU.",
      inputSchema: {
        sku: z.string().describe("Product SKU, for example RC-SMALL-4."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sku }) => {
      const product = store.getProduct(sku);
      if (!product) return toolError(`Unknown SKU: ${sku}`);
      return jsonResult(toProductView(product));
    },
  );

  server.registerTool(
    "place_order",
    {
      title: "Place order",
      description: "Place an order in the simulated store. Returns the order id and total. Decrements stock.",
      inputSchema: {
        sku: z.string().describe("Product SKU to buy."),
        quantity: z.number().int().positive().optional().describe("Units to buy. Defaults to 1."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sku, quantity }) => {
      try {
        const order = store.placeOrder({ sku, quantity });
        return jsonResult(toOrderView(order));
      } catch (error) {
        return toolError(error instanceof StoreError ? error.message : "Could not place the order");
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Fetch a simulated store order by id.",
      inputSchema: {
        orderId: z.string().describe("Order id returned by place_order."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ orderId }) => {
      const order = store.getOrder(orderId);
      if (!order) return toolError(`Unknown order: ${orderId}`);
      return jsonResult(toOrderView(order));
    },
  );

  return server;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function isDirectRun(scriptName: string): boolean {
  const entry = process.argv[1]?.replaceAll("\\", "/");
  return entry !== undefined && entry.endsWith(scriptName);
}

async function main(): Promise<void> {
  const filePath = dataFile(process.env, process.env.STORE_DATA, "data/store.json");
  const store = StoreService.open(filePath);
  const server = createStoreMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isDirectRun("mcp.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
