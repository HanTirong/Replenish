import { createId } from "@replenish/domain";
import { PayPalPaymentProvider } from "./paypal-provider";

export interface ChargeRequest {
  amountCents: number;
  currency: "USD";
  description: string;
  sku: string;
  /** Stable business reference. Each attempt has separate, persisted stage request IDs. */
  idempotencyKey: string;
  authorizationId?: string;
  approvalSnapshot?: string;
  policyHash?: string;
  preparedAttemptId?: string;
}

export interface PayPalChargeDetails {
  attemptId?: string;
  orderId: string;
  orderStatus: string;
  captureId: string | null;
  captureStatus: string | null;
  vaultId: string;
}

export interface ChargeResult {
  /** Mock id, or the PayPal order id when the provider is PayPal. */
  paymentId: string;
  provider: string;
  status: "paid";
  paypal?: PayPalChargeDetails;
}

/**
 * Moves money. The agent calls this only after the budget check passes,
 * or after a person approves an over-budget replenishment.
 * It does not decide whether a human should confirm.
 */
export class PaymentUnknownError extends Error {
  readonly idempotencyKey: string;

  constructor(message: string, idempotencyKey: string) {
    super(message);
    this.name = "PaymentUnknownError";
    this.idempotencyKey = idempotencyKey;
  }
}

export interface PaymentProvider {
  readonly name: string;
  readonly label: string;
  charge(request: ChargeRequest, beforeWrite?: () => void): Promise<ChargeResult>;
  /** Look up a previous attempt. Unknown means do not call charge again. */
  queryCharge?(idempotencyKey: string): Promise<"paid" | "failed" | "unknown" | "not_found">;
  lookupCharge?(idempotencyKey: string): Promise<PaymentLookup>;
  prepareCharge?(request: ChargeRequest): string;
  finalizeCharge?(key: string, status: "paid" | "failed", attemptId?: string): void;
  recoveryInfo?(key: string): { attemptId: string; recoverable: boolean } | null;
  recoverCharge?(request: ChargeRequest, attemptId: string, guard: () => void): Promise<PaymentLookup>;
}

export interface PaymentLookup {
  attemptId?: string;
  status: "paid" | "failed" | "unknown" | "not_found";
  paymentId?: string;
  captureId?: string;
  paidAt?: string;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly label = "MockPaymentProvider";
  readonly charges: ChargeRequest[] = [];
  private readonly outcomes = new Map<string, "paid" | "failed" | "unknown">();
  private readonly paidIds = new Map<string, string>();

  constructor(private readonly createPaymentId: () => string = () => createId("pay")) {}

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (!Number.isInteger(request.amountCents) || request.amountCents <= 0) {
      throw new Error("Charge amount must be a positive number of cents");
    }
    const prior = this.outcomes.get(request.idempotencyKey);
    if (prior === "unknown") {
      throw new PaymentUnknownError(
        `Payment ${request.idempotencyKey} is still unknown. Query it before retrying.`,
        request.idempotencyKey,
      );
    }
    if (prior === "paid") {
      return {
        paymentId: this.paidIds.get(request.idempotencyKey) ?? this.createPaymentId(),
        provider: this.name,
        status: "paid",
      };
    }
    this.charges.push({ ...request });
    const paymentId = this.createPaymentId();
    this.outcomes.set(request.idempotencyKey, "paid");
    this.paidIds.set(request.idempotencyKey, paymentId);
    return {
      paymentId,
      provider: this.name,
      status: "paid",
    };
  }

  async queryCharge(idempotencyKey: string): Promise<"paid" | "failed" | "unknown" | "not_found"> {
    return this.outcomes.get(idempotencyKey) ?? "not_found";
  }

  /** Test hook: the next charge for this key does not know whether money moved. */
  markUnknown(idempotencyKey: string): void {
    this.outcomes.set(idempotencyKey, "unknown");
  }
}

export { PayPalPaymentProvider };

export function paymentProviderFromEnv(env: NodeJS.ProcessEnv = process.env, options: import("./paypal").PayPalProviderOptions = {}): PaymentProvider {
  const which = (env.PAYMENT_PROVIDER ?? "mock").toLowerCase();
  if (which === "mock") return new MockPaymentProvider();
  if (which === "paypal") return new PayPalPaymentProvider({ ...options, env });
  throw new Error(`Unknown PAYMENT_PROVIDER "${which}". Use "mock" or "paypal".`);
}

export function providerLabel(name: string | null): string {
  if (name === "mock") return "MockPaymentProvider";
  if (name === "paypal") return "PayPalPaymentProvider";
  return name ?? "unknown";
}
