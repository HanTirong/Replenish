import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteSavedVault, paymentProviderFromEnv, PayPalPaymentProvider, PaymentUnknownError, readSavedVault, SqlitePaymentAttemptStore, type PaymentProvider } from "@replenish/agent";
import { dataFile } from "@replenish/domain";
import { HouseholdApp, resolvePreferredProduct, type PaymentGateway } from "./service";
import { openDatabase, type SqlDatabase } from "./db";
import { OperationRejected } from "./operations";

export interface ApiServerOptions {
  app: HouseholdApp;
  webRoot?: string;
}

const MEDIA: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
};

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, idempotency-key",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export function createApiServer(app: HouseholdApp, options: { webRoot?: string; maintenanceToken?: string } = {}): Server {
  return createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const protectedWrite = pathname === "/v1/demo/reorder-now" || pathname === "/v1/demo/reset" || /^\/v1\/orders\/[^/]+\/recover-payment$/.test(pathname);
    if (request.method === "POST" && protectedWrite &&
      !maintenanceAuthorized(request.headers.authorization, options.maintenanceToken)) {
      send(response, 403, { error: "This action requires operator authorization. No payment or order was requested.", operationStatus: "rejected" });
      return;
    }
    void handle(app, request, response, options.webRoot).finally(() => {
      void app.deliverNotifications().catch(() => undefined);
    });
  });
}

function maintenanceAuthorized(header: string | undefined, configured: string | undefined): boolean {
  const expected = configured?.trim();
  if (!expected || expected.length < 32 || !header || header.length > 4096) return false;
  const supplied = /^Bearer (\S+)$/.exec(header)?.[1];
  return Boolean(supplied && timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(expected).digest()));
}

async function handle(app: HouseholdApp, request: IncomingMessage, response: ServerResponse, webRoot?: string): Promise<void> {
  if (request.method === "OPTIONS") {
    send(response, 204, {});
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const idempotencyKey = request.headers["idempotency-key"];
  const key = Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey;
  try {
    if (url.pathname.startsWith("/v1/")) {
      await handleApi(app, request, response, url, key);
      return;
    }
    if (webRoot && serveWeb(webRoot, url.pathname, response)) return;
    send(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    send(response, 400, { error: message, ...(error instanceof OperationRejected ? { operationStatus: "rejected" } : {}) });
  }
}

async function handleApi(
  app: HouseholdApp,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  key: string | undefined,
): Promise<void> {
  if (request.method === "GET" && url.pathname === "/v1/health") {
    send(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/home") {
    send(response, 200, app.home());
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/budget") {
    send(response, 200, app.budget());
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/notifications") {
    send(response, 200, app.notificationStatus());
    return;
  }
  const orderDetail = /^\/v1\/orders\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && orderDetail?.[1]) {
    send(response, 200, app.orderDetails(orderDetail[1]));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/activity") {
    send(response, 200, app.listActivity());
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/feeding/calibrate") {
    const body = await readJson(request);
    if (typeof body.stockG !== "number") throw new Error("stockG is required");
    send(response, 200, app.calibrate(body.stockG));
    return;
  }
  if (request.method === "PUT" && url.pathname === "/v1/feeding") {
    const body = await readJson(request);
    if (typeof body.gramsPerMeal !== "number") throw new Error("gramsPerMeal is required");
    send(response, 200, app.updateFeeding(body.gramsPerMeal));
    return;
  }
  if (request.method === "PUT" && url.pathname === "/v1/budget") {
    const body = await readJson(request);
    send(response, 200, app.updateBudget({
      perOrderLimitCents: numberOrUndefined(body.perOrderLimitCents),
      monthlyLimitCents: numberOrUndefined(body.monthlyLimitCents),
    }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/chat") {
    const body = await readJson(request);
    const text = typeof body.text === "string" ? body.text : "";
    if (body.expectedRevisionId !== undefined && (!Number.isSafeInteger(body.expectedRevisionId) || Number(body.expectedRevisionId) <= 0)) throw new OperationRejected("expectedRevisionId must be a positive revision number.");
    send(response, 200, await app.chat(text, key, body.expectedRevisionId as number | undefined));
    return;
  }
  const operation = /^\/v1\/(chat|feeding\/undo)\/operations\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
  if (request.method === "GET" && operation?.[1] && operation[2]) {
    send(response, 200, app.operationStatus(operation[1] === "chat" ? "chat" : "undo", operation[2]));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/feeding/undo") {
    const body = await readJson(request);
    if (!Number.isSafeInteger(body.expectedRevisionId) || Number(body.expectedRevisionId) <= 0) throw new OperationRejected("A positive expectedRevisionId is required for Undo. No changes were saved.");
    send(response, 200, app.undo(key, body.expectedRevisionId as number));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/paypal/connect") {
    send(response, 200, await app.connectPaypal());
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/demo/reorder-now") {
    send(response, 200, await app.reorderNow());
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/demo/reset") {
    send(response, 200, app.resetDemo(url.searchParams.get("full") === "1"));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/paypal/authorize") {
    send(response, 200, app.authorizePaypal());
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/autopilot/pause") {
    send(response, 200, app.pause());
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/autopilot/resume") {
    send(response, 200, app.resume());
    return;
  }
  const orderAction = /^\/v1\/orders\/([^/]+)\/(approve|reject|receive|check-payment|recover-payment)$/.exec(url.pathname);
  if (request.method === "POST" && orderAction?.[1] && orderAction[2] === "recover-payment") {
    const body = await readJson(request);
    if (!Number.isSafeInteger(body.expectedTotalCents) || Number(body.expectedTotalCents) <= 0 || typeof body.approvalSnapshot !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.approvalSnapshot) || typeof body.expectedAttemptId !== "string" || !/^[a-f0-9-]{36}$/.test(body.expectedAttemptId)) throw new OperationRejected("Review the original order and payment attempt before recovering it.");
    send(response, 200, await app.recoverPayment(orderAction[1], Number(body.expectedTotalCents), body.approvalSnapshot, body.expectedAttemptId));
    return;
  }
  if (request.method === "POST" && orderAction?.[1] && orderAction[2] === "check-payment") {
    send(response, 200, await app.checkPayment(orderAction[1]));
    return;
  }
  if (request.method === "POST" && orderAction?.[1] && orderAction[2] === "approve") {
    const body = await readJson(request);
    const expected = Number(body.expectedTotalCents);
    if (!Number.isSafeInteger(expected) || expected <= 0) throw new Error("expectedTotalCents must be positive integer cents");
    if (typeof body.approvalSnapshot !== "string" || !/^[a-f0-9]{64}$/.test(body.approvalSnapshot)) throw new Error("approvalSnapshot is required. Refresh and review this order before approving.");
    send(response, 200, await app.approve(orderAction[1], expected, body.approvalSnapshot, key));
    return;
  }
  if (request.method === "POST" && orderAction?.[1] && orderAction[2] === "reject") {
    send(response, 200, app.reject(orderAction[1]));
    return;
  }
  if (request.method === "POST" && orderAction?.[1] && orderAction[2] === "receive") {
    send(response, 200, app.receive(orderAction[1]));
    return;
  }
  send(response, 404, { error: "Not found" });
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Budget limits must be numbers");
  return parsed;
}

function serveWeb(webRoot: string, pathname: string, response: ServerResponse): boolean {
  const root = resolve(webRoot);
  if (!existsSync(root)) return false;
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = safeFile(root, requested);
  const target = file ?? (extname(requested) ? null : safeFile(root, "index.html"));
  if (!target) return false;
  response.writeHead(200, { "content-type": MEDIA[extname(target)] ?? "application/octet-stream" });
  createReadStream(target).pipe(response);
  return true;
}

function safeFile(root: string, relative: string): string | null {
  const full = resolve(root, relative);
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

export function gatewayFromProvider(provider: PaymentProvider): PaymentGateway {
  return {
    async charge(input, beforeWrite) {
      const result = await provider.charge({
        amountCents: input.amountCents,
        currency: "USD",
        description: input.description,
        sku: input.sku,
        idempotencyKey: input.idempotencyKey,
        authorizationId: input.authorizationId, approvalSnapshot: input.approvalSnapshot,
        policyHash: input.policyHash, preparedAttemptId: input.preparedAttemptId,
      }, beforeWrite);
      return { paymentId: result.paymentId, captureId: result.paypal?.captureId ?? null, attemptId: result.paypal?.attemptId };
    },
    async query(idempotencyKey) {
      if (provider.queryCharge) return provider.queryCharge(idempotencyKey);
      return "not_found";
    },
    ...(provider.lookupCharge ? { lookup: (key: string) => provider.lookupCharge!(key) } : {}),
    ...(provider.prepareCharge ? { prepare: (input: Parameters<PaymentGateway["charge"]>[0]) => provider.prepareCharge!({ ...input, currency: "USD" }) } : {}),
    ...(provider.finalizeCharge ? { finalize: (key: string, status: "paid" | "failed", attemptId?: string) => provider.finalizeCharge!(key, status, attemptId) } : {}),
    ...(provider.recoveryInfo ? { recoveryInfo: (key: string) => provider.recoveryInfo!(key) } : {}),
    ...(provider.recoverCharge ? { recover: (input: Parameters<PaymentGateway["charge"]>[0], attemptId: string, guard: () => void) => provider.recoverCharge!({ ...input, currency: "USD" }, attemptId, guard) } : {}),
    async ensureVault() {
      if (provider instanceof PayPalPaymentProvider) {
        const saved = await provider.ensureSandboxCard();
        return { vaultId: saved.vaultId, last4: saved.last4 };
      }
      return { vaultId: "vault_mock", last4: "1881" };
    },
  };
}

export function webRootFromHere(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

/** Render sets PORT. API_PORT remains the local default. */
export function listenPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT?.trim() || env.API_PORT?.trim() || "4781";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer from 0 to 65535");
  }
  return port;
}

/** How often the API places a replenishment whose planned time has arrived. 0 disables it. */
export function reorderIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.REORDER_INTERVAL_MS?.trim();
  if (!raw) return 15 * 60 * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 15 * 60 * 1000;
  return parsed;
}

export function startApi(env: NodeJS.ProcessEnv = process.env, db?: SqlDatabase): Promise<Server> {
  const database = db ?? openDatabase(env);
  const attemptStore = new SqlitePaymentAttemptStore(database);
  attemptStore.importLegacy(dataFile(env, undefined, "data/paypal-attempts"));
  const provider = paymentProviderFromEnv(env, { attemptStore, deferFinalization: true });
  const preferred = resolvePreferredProduct(env);
  const app = new HouseholdApp({
    db: database,
    env,
    sku: preferred.sku,
    priceCents: preferred.priceCents,
    payments: gatewayFromProvider(provider),
    vault: {
      hasPaymentToken: () => Boolean(readSavedVault(env)?.vaultId),
      summary: () => {
        const saved = readSavedVault(env);
        return { connected: Boolean(saved?.vaultId), last4: saved?.last4 ?? null };
      },
      ensure: () => gatewayFromProvider(provider).ensureVault!(),
      clear: () => deleteSavedVault(env),
    },
  });
  const server = createApiServer(app, { webRoot: env.WEB_ROOT?.trim() || webRootFromHere(), maintenanceToken: env.REPLENISH_MAINTENANCE_TOKEN });
  const port = listenPort(env);
  const host = env.API_HOST ?? "0.0.0.0";
  const intervalMs = reorderIntervalMs(env);
  app.configureScheduler(intervalMs);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const notify = () => { void app.tickNotifications().catch(() => undefined); };
      notify();
      const notificationTimer = setInterval(notify, 15_000);
      notificationTimer.unref();
      server.on("close", () => clearInterval(notificationTimer));
      if (intervalMs > 0) {
        const tick = () => {
          void app.runScheduledCheck().catch(() => {
            console.error("The scheduled replenishment check could not complete.");
          });
        };
        tick();
        const timer = setInterval(tick, intervalMs);
        timer.unref();
        server.on("close", () => clearInterval(timer));
      }
      console.error(`Replenish listening on http://${host}:${port}`);
      resolve(server);
    });
  });
}

function isDirectRun(scriptName: string): boolean {
  const entry = process.argv[1]?.replaceAll("\\", "/");
  return entry !== undefined && entry.endsWith(scriptName);
}

if (isDirectRun("http.ts")) {
  startApi().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof PaymentUnknownError) console.error(error.message);
    process.exitCode = 1;
  });
}
