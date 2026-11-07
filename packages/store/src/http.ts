import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dataFile } from "@replenish/domain";
import { StoreService, toOrderView, toProductView } from "./service";
import { StoreError } from "./types";

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new StoreError("Body too large", 413);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StoreError("Invalid JSON", 400);
  }
}

function parseOrderBody(body: unknown): { sku: string; quantity?: number } {
  if (!body || typeof body !== "object") {
    throw new StoreError("Expected a JSON object", 400);
  }
  const record = body as { sku?: unknown; quantity?: unknown };
  if (typeof record.sku !== "string" || record.sku.trim() === "") {
    throw new StoreError("sku is required", 400);
  }
  if (record.quantity === undefined) {
    return { sku: record.sku.trim() };
  }
  if (typeof record.quantity !== "number" || !Number.isInteger(record.quantity) || record.quantity < 1) {
    throw new StoreError("quantity must be a positive integer", 400);
  }
  return { sku: record.sku.trim(), quantity: record.quantity };
}

export async function handleStoreRequest(
  store: StoreService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  try {
    if (method === "GET" && url.pathname === "/health") {
      send(response, 200, { ok: true, products: store.searchProducts().length });
      return;
    }
    if (method === "GET" && url.pathname === "/products") {
      const products = store.searchProducts({
        query: url.searchParams.get("q") ?? undefined,
        category: url.searchParams.get("category") ?? undefined,
      });
      send(response, 200, { products: products.map(toProductView) });
      return;
    }
    const productMatch = url.pathname.match(/^\/products\/([^/]+)$/);
    if (method === "GET" && productMatch?.[1]) {
      const product = store.getProduct(decodeURIComponent(productMatch[1]));
      if (!product) {
        send(response, 404, { error: "Product not found" });
        return;
      }
      send(response, 200, toProductView(product));
      return;
    }
    if (method === "POST" && url.pathname === "/orders") {
      const order = store.placeOrder(parseOrderBody(await readJson(request)));
      send(response, 201, toOrderView(order));
      return;
    }
    const orderMatch = url.pathname.match(/^\/orders\/([^/]+)$/);
    if (method === "GET" && orderMatch?.[1]) {
      const order = store.getOrder(decodeURIComponent(orderMatch[1]));
      if (!order) {
        send(response, 404, { error: "Order not found" });
        return;
      }
      send(response, 200, toOrderView(order));
      return;
    }
    send(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof StoreError) {
      send(response, error.statusCode, { error: error.message });
      return;
    }
    console.error(error);
    send(response, 500, { error: "Internal error" });
  }
}

export function startStoreServer(options: {
  store: StoreService;
  port: number;
  host?: string;
}): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void handleStoreRequest(options.store, request, response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => resolve(server));
  });
}

function isDirectRun(scriptName: string): boolean {
  const entry = process.argv[1]?.replaceAll("\\", "/");
  return entry !== undefined && entry.endsWith(scriptName);
}

async function main(): Promise<void> {
  const port = Number(process.env.STORE_PORT ?? 4747);
  const host = process.env.STORE_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("STORE_PORT must be an integer from 0 to 65535");
  }
  const filePath = dataFile(process.env, process.env.STORE_DATA, "data/store.json");
  const store = StoreService.open(filePath);
  const server = await startStoreServer({ store, port, host });
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  console.error(`Simulated store listening on http://${host}:${bound}`);
}

if (isDirectRun("http.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
