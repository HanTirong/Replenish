import type { ChargeRequest, ChargeResult } from "./payments";
import { PayPalClient, paypalApiBase, type PayPalProviderOptions } from "./paypal";

/**
 * Charges a vaulted sandbox card with Orders v2.
 * The tick calls this only after the budget check passes, or after a person approves.
 */
export class PayPalPaymentProvider {
  readonly name = "paypal";
  readonly label = "PayPalPaymentProvider";
  readonly results: ChargeResult[] = [];
  private client: PayPalClient | null = null;

  constructor(private readonly options: PayPalProviderOptions = {}) {}

  get baseUrl(): string {
    return paypalApiBase(this.options.env ?? process.env);
  }

  tokenSummary(): Promise<{ scopes: string[]; expiresIn: number; tokenType: string; appId?: string }> {
    return this.paypal().tokenSummary();
  }

  async ensureSandboxCard(): Promise<{ vaultId: string; last4: string | null }> {
    const vault = await this.paypal().ensureSandboxCard();
    return { vaultId: vault.vaultId, last4: vault.last4 ?? null };
  }

  async charge(request: ChargeRequest, beforeWrite?: () => void): Promise<ChargeResult> {
    if (!Number.isInteger(request.amountCents) || request.amountCents <= 0) {
      throw new Error("Charge amount must be a positive number of cents");
    }
    const paypal = await this.paypal().captureCharge(request, undefined, beforeWrite);
    const result: ChargeResult = {
      paymentId: paypal.orderId,
      provider: this.name,
      status: "paid",
      paypal,
    };
    this.results.push(result);
    return result;
  }

  lookupCharge(key: string) { return this.paypal().lookupCharge(key); }
  async queryCharge(key: string) { return (await this.lookupCharge(key)).status; }
  prepareCharge(request: ChargeRequest) { return this.paypal().prepareCharge(request); }
  finalizeCharge(key: string, status: "paid" | "failed", attemptId?: string) { this.paypal().finalizeCharge(key, status, attemptId); }
  recoveryInfo(key: string) { return this.paypal().recoveryInfo(key); }
  recoverCharge(request: ChargeRequest, attemptId: string, guard: () => void) { return this.paypal().recoverCharge(request, attemptId, guard); }

  private paypal(): PayPalClient {
    this.client ??= new PayPalClient(this.options);
    return this.client;
  }
}
