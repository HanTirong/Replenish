export interface BudgetViolation {
  code: "per_order" | "monthly";
  limitCents: number;
  actualCents: number;
  overByCents: number;
  message: string;
}

export interface HomePayload {
  headline: string;
  reason: string;
  orderDate: string;
  orderDateRaw: string;
  state: string;
  autopilot: string;
  autopilotResumeAt?: string | null;
  autopilotPauseReason?: string | null;
  pet: { name: string; timezone: string };
  paypal: {
    connected: boolean;
    automaticPaymentAuthorized: boolean;
    status: string;
    environment: string;
    last4: string | null;
  };
  notice: { headline: string; reason: string } | null;
  undoRevisionId?: number | null;
  payment: null | { paypalOrderId: string | null; captureId: string | null };
  order?: PaidOrder | null;
  paymentCheckOrderId?: string | null;
  paymentRecovery?: { attemptId: string; recoverable: boolean; orderId: string; totalCents: number; approvalSnapshot: string; productName?: string; productDetail?: string; merchant?: string; currency?: string } | null;
  notifications?: NotificationStatus;
  agentStatus?: AgentStatus;
  feeding?: { stockG: number; gramsPerMeal: number; mealsPerDay: number; dailyGrams: number };
  dates: { date: string; markers: string[]; complete: boolean }[];
  budget: { perOrderLimitCents: number; monthlyLimitCents: number };
  pendingApproval: null | {
    orderId: string;
    approvalSnapshot: string;
    totalCents: number;
    currency: string;
    sku: string;
    merchant: string;
    productName: string;
    productDetail: string;
    violations: BudgetViolation[];
    retry: boolean;
    failure: string | null;
  };
  plan: { orderDate: string; orderDateRaw: string; planChanged: boolean; predictedRunoutAt?: string;
    plannedOrderAt?: string; estimatedDeliveryAt?: string; shippingHours?: number; bufferHours?: number };
}

export interface PaidOrder {
  id: string;
  totalCents: number;
  status: string;
  paymentStatus: string;
  captureId: string | null;
  productName: string;
  productDetail: string;
}

export interface NotificationStatus {
  configured: boolean; enabled: boolean; botUrl: string | null;
  lastOutcome: string | null; lastAttemptAt: string | null; lastSentAt: string | null;
  commandStatus: string | null; queueError: boolean; pending: number;
  setup?: { stage: "not_configured" | "unavailable" | "awaiting_start" | "awaiting_test" | "ready";
    enabledAt: string | null; lastCommandCheckedAt: string | null; test: NotificationDeliverySummary | null };
  recent?: NotificationDeliverySummary[];
}
export interface NotificationDeliverySummary {
  kind: string; status: string; createdAt: string; attemptedAt: string | null; acceptedAt: string | null;
}
export const getNotifications = () => request<NotificationStatus>("/v1/notifications");
export const getOrder = (id: string) => request<PaidOrder>(`/v1/orders/${encodeURIComponent(id)}`);

export interface ChatPayload {
  receipt?: { operationId: string | null; at: string; outcome: "applied" | "answered" | "needs_clarification";
    undoRevisionId: number | null;
    feeding: null | { before: { gramsPerMeal: number; dailyGrams: number }; after: { gramsPerMeal: number; dailyGrams: number } };
    plan: null | { beforeAt: string; afterAt: string; changed: boolean } };
  command: { type: string; meal?: string; localDate?: string };
  headline: string;
  reason: string;
  decision: null | { orderDate: string; orderDateRaw: string; planChanged: boolean };
}

export interface AgentStatus {
  enabled: boolean; state: string; intervalMs: number; lastStartedAt: string | null; lastFinishedAt: string | null;
  lastSucceededAt: string | null; nextCheckAt: string | null; lastResult: string | null; waitingReason: string;
}
export class RequestError extends Error {
  constructor(message: string, readonly operationStatus?: string) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(60_000) });
  const body = (await response.json()) as T & { error?: string; operationStatus?: string };
  if (!response.ok) throw new RequestError(body.error || "The request could not be confirmed.", body.operationStatus);
  return body;
}

export function getHome(): Promise<HomePayload> {
  return request("/v1/home");
}

export interface BudgetPayload {
  currency: string; perOrderLimitCents: number; monthlyLimitCents: number;
  monthSettledCents: number; monthCommittedCents: number; monthRemainingCents: number;
}
export interface ActivityPayload { id: string; at: string; kind: string; summary: string; before_json: string | null; after_json: string | null }
export const getBudget = () => request<BudgetPayload>("/v1/budget");
export const getActivity = () => request<ActivityPayload[]>("/v1/activity");
export const calibrateStock = (stockG: number) => request("/v1/feeding/calibrate", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stockG }),
});
export const updateFeeding = (gramsPerMeal: number) => request("/v1/feeding", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ gramsPerMeal }),
});
export const checkPayment = (id: string) => request(`/v1/orders/${id}/check-payment`, { method: "POST" });
export const recoverPayment = (recovery: NonNullable<HomePayload["paymentRecovery"]>, operatorCode: string) => request(`/v1/orders/${recovery.orderId}/recover-payment`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${operatorCode}` },
  body: JSON.stringify({ expectedTotalCents: recovery.totalCents, approvalSnapshot: recovery.approvalSnapshot, expectedAttemptId: recovery.attemptId }),
});

export function postChat(text: string, operationId: string = crypto.randomUUID(), expectedRevisionId?: number): Promise<ChatPayload> {
  return request<ChatPayload>("/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": operationId },
    body: JSON.stringify({ text, expectedRevisionId }),
  }).then(verifiedChatResult);
}

export function postUndo(operationId: string = crypto.randomUUID(), expectedRevisionId?: number): Promise<ChatPayload> {
  return request<ChatPayload>("/v1/feeding/undo", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": operationId }, body: JSON.stringify({ expectedRevisionId }) }).then(verifiedChatResult);
}
function verifiedChatResult(result: ChatPayload) {
  if (typeof result?.command?.type !== "string" || typeof result.headline !== "string" || typeof result.reason !== "string") throw new RequestError("The result could not be verified. Check status before repeating this action.");
  return result;
}
export async function getOperation(kind: "chat" | "undo", id: string) {
  const response = await request<{ status: "completed"; result: ChatPayload } | { status: "unconfirmed" }>(`/v1/${kind === "chat" ? "chat" : "feeding/undo"}/operations/${encodeURIComponent(id)}`);
  if (response?.status === "unconfirmed") return response;
  if (response?.status === "completed" && response.result?.receipt?.operationId === id && typeof response.result.headline === "string" && typeof response.result.command?.type === "string") return response;
  throw new RequestError("The saved result could not be verified. Check its status before repeating it.");
}

export function connectPaypal(): Promise<HomePayload> {
  return request("/v1/paypal/connect", { method: "POST" });
}

export function reorderNow(maintenanceToken: string): Promise<HomePayload> {
  return request("/v1/demo/reorder-now", { method: "POST", headers: { authorization: `Bearer ${maintenanceToken}` } });
}

export function resetDemo(full = false): Promise<HomePayload> {
  return request(`/v1/demo/reset${full ? "?full=1" : ""}`, { method: "POST" });
}

export function authorizePaypal(): Promise<unknown> {
  return request("/v1/paypal/authorize", { method: "POST" });
}

export function pauseAutopilot(): Promise<HomePayload> {
  return request("/v1/autopilot/pause", { method: "POST" });
}

export function resumeAutopilot(): Promise<HomePayload> {
  return request("/v1/autopilot/resume", { method: "POST" });
}

export function receiveOrder(orderId: string): Promise<HomePayload> {
  return request(`/v1/orders/${orderId}/receive`, { method: "POST" });
}

export function approveOrder(orderId: string, expectedTotalCents: number, approvalSnapshot: string): Promise<unknown> {
  return request(`/v1/orders/${orderId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ expectedTotalCents, approvalSnapshot }),
  });
}

export function rejectOrder(orderId: string): Promise<unknown> {
  return request(`/v1/orders/${orderId}/reject`, { method: "POST" });
}

export function updateBudget(input: { perOrderLimitCents?: number; monthlyLimitCents?: number }): Promise<unknown> {
  return request("/v1/budget", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
