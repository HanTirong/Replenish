import { dataFile } from "@replenish/domain";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChargeRequest, PayPalChargeDetails, PaymentLookup } from "./payments";
import { PaymentUnknownError } from "./payments";
import { openPaymentAttemptStore, type PaymentAttempt, type PaymentAttemptStore } from "./payment-attempts";

export const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
export const PAYPAL_LIVE_BASE = "https://api-m.paypal.com";

/**
 * Chargeable sandbox Visa from PayPal's card-testing list.
 * 4111111111111111 is only a format sample for vault setup; charging it returns PAYER_CANNOT_PAY.
 */
const DEFAULT_TEST_CARD = "4012888888881881";
const DEFAULT_TEST_EXPIRY = "2028-12";
const DEFAULT_TEST_CVV = "123";
const TOKEN_SKEW_MS = 60_000;
const DEFAULT_POLL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 180_000;
export const PAYMENT_REPLAY_WINDOW_MS = 5 * 60 * 60 * 1000;
const PAYMENT_LEASE_MS = 10 * 60 * 1000;

export type VaultSource = "card" | "paypal";

export interface VaultRecord {
  vaultId: string;
  customerId?: string;
  /** Card tokens saved before this field existed are cards. */
  source?: VaultSource;
  /** PayPal capture id from the last successful charge. Not sent as a network reference. */
  previousTransactionId?: string;
  /** Scheme reference from that capture. Required before a SUBSEQUENT merchant charge. */
  networkTransaction?: { id: string; date?: string; network?: string };
  last4?: string;
}

export class PayPalApiError extends Error {
  readonly httpStatus: number;
  readonly pathname: string;
  readonly debugId?: string;
  readonly issue?: string;

  constructor(
    message: string,
    details: { httpStatus: number; pathname: string; debugId?: string; issue?: string },
  ) {
    super(message);
    this.name = "PayPalApiError";
    this.httpStatus = details.httpStatus;
    this.pathname = details.pathname;
    this.debugId = details.debugId;
    this.issue = details.issue;
  }
}

export interface VaultStore {
  load(): VaultRecord | null;
  save(record: VaultRecord): void;
}

export class MemoryVaultStore implements VaultStore {
  private record: VaultRecord | null = null;

  load(): VaultRecord | null {
    return this.record ? { ...this.record } : null;
  }

  save(record: VaultRecord): void {
    this.record = { ...record };
  }
}

export class FileVaultStore implements VaultStore {
  constructor(private readonly filePath: string) {}

  load(): VaultRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as VaultRecord;
      if (!parsed || typeof parsed.vaultId !== "string" || parsed.vaultId.trim() === "") {
        throw new Error(`PayPal vault file at ${this.filePath} has no vaultId. Delete it and run again.`);
      }
      return {
        vaultId: parsed.vaultId,
        source: parsed.source === "paypal" ? "paypal" : "card",
        ...(typeof parsed.customerId === "string" ? { customerId: parsed.customerId } : {}),
        ...(typeof parsed.previousTransactionId === "string" ? { previousTransactionId: parsed.previousTransactionId } : {}),
        ...(typeof parsed.last4 === "string" ? { last4: parsed.last4 } : {}),
        ...(parsed.networkTransaction && typeof parsed.networkTransaction === "object" && typeof parsed.networkTransaction.id === "string"
          ? { networkTransaction: parsed.networkTransaction }
          : {}),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        throw new Error(`PayPal vault file at ${this.filePath} is not JSON. Delete it and run again.`);
      }
      throw error;
    }
  }

  save(record: VaultRecord): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temporary, this.filePath);
  }
}

export interface PayPalProviderOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  vaultStore?: VaultStore;
  attemptStore?: PaymentAttemptStore;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** The household commits the terminal attempt and order state in one transaction. */
  deferFinalization?: boolean;
}

interface PayPalLink {
  href: string;
  rel: string;
}

interface PayPalResource {
  id: string;
  status: string;
  links: PayPalLink[];
  raw: Record<string, unknown>;
}

interface SubmittedOrder { order: PayPalResource; attempt: PaymentAttempt }

/**
 * Sandbox (or live) PayPal client: client-credentials OAuth, Vault v3, Orders v2.
 * The buyer is not present for later charges. The first card save is server-side
 * unless PayPal returns PAYER_ACTION_REQUIRED, in which case we print the approval
 * URL and poll until the setup token is approved.
 */
export class PayPalClient {
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private tokenMeta: { scopes: string[]; expiresIn: number; tokenType: string; appId?: string } | null = null;
  private pendingToken: Promise<string> | null = null;
  private vault: VaultRecord | null = null;

  readonly baseUrl: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly vaultStore: VaultStore;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly attemptStore: PaymentAttemptStore;
  private readonly deferFinalization: boolean;

  constructor(options: PayPalProviderOptions = {}) {
    this.env = options.env ?? process.env;
    const credentials = readCredentials(this.env);
    this.clientId = credentials.clientId;
    this.clientSecret = credentials.clientSecret;
    this.baseUrl = apiBase(this.env);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const writeLog = options.log ?? ((line: string) => console.log(line));
    this.log = (line) => writeLog(this.redactSensitive(line));
    this.vaultStore = options.vaultStore ?? new FileVaultStore(vaultFile(this.env));
    this.attemptStore = options.attemptStore ?? openPaymentAttemptStore(dataFile(this.env, undefined, "data/paypal-attempts.sqlite"), dataFile(this.env, undefined, "data/paypal-attempts"));
    this.deferFinalization = options.deferFinalization ?? false;
    this.pollIntervalMs = options.pollIntervalMs ?? numberEnv(this.env.PAYPAL_APPROVAL_POLL_MS, DEFAULT_POLL_MS);
    this.pollTimeoutMs = options.pollTimeoutMs ?? numberEnv(this.env.PAYPAL_APPROVAL_TIMEOUT_MS, DEFAULT_POLL_TIMEOUT_MS);
  }

  /** PayPal treats a repeated PayPal-Request-Id as the same request, even after a 422. */
  private freshRequestId(): string {
    return randomUUID();
  }

  private vaultMode(): "auto" | "card" | "paypal" {
    const value = this.env.PAYPAL_VAULT_SOURCE?.trim().toLowerCase();
    if (value === "card" || value === "paypal") return value;
    return "auto";
  }

  private async savedVault(): Promise<VaultRecord | null> {
    if (this.vault) return this.vault;
    const fromEnv = this.env.PAYPAL_VAULT_ID?.trim();
    if (fromEnv) {
      const source: VaultSource = this.env.PAYPAL_VAULT_SOURCE === "paypal" ? "paypal" : "card";
      this.vault = { vaultId: fromEnv, source };
      this.log(`PayPal vault     using configured ${source} token`);
      return this.vault;
    }
    const stored = this.vaultStore.load();
    if (!stored) return null;
    this.vault = { ...stored, source: stored.source ?? "card" };
    this.log(`PayPal vault     reusing saved ${this.vault.source} token`);
    return this.vault;
  }

  private async ensureCardVault(): Promise<VaultRecord> {
    const existing = await this.savedVault();
    if (existing?.source === "card") return existing;
    const setup = await this.createSetupToken();
    const approved = await this.waitUntilApproved(setup, "setup");
    const token = await this.createPaymentToken(approved.id);
    const customerId = customerIdOf(approved.raw) ?? customerIdOf(token.raw);
    const last4 = lastDigits(token.raw) ?? this.cardNumber().slice(-4);
    this.vault = {
      vaultId: token.id,
      source: "card",
      last4,
      ...(customerId ? { customerId } : {}),
    };
    this.vaultStore.save(this.vault);
    this.log(`PayPal vault     saved payment token (card ····${last4})`);
    return this.vault;
  }

  private async ensurePayPalWallet(): Promise<VaultRecord> {
    if (this.vault?.source === "paypal") return this.vault;
    const setup = await this.createPayPalSetupToken();
    const approved = await this.waitUntilApproved(setup, "setup");
    const token = await this.createPaymentToken(approved.id);
    const customerId = customerIdOf(approved.raw) ?? customerIdOf(token.raw);
    this.vault = {
      vaultId: token.id,
      source: "paypal",
      ...(customerId ? { customerId } : {}),
    };
    this.vaultStore.save(this.vault);
    this.log("PayPal vault     saved PayPal wallet token");
    return this.vault;
  }

  /** Vault the sandbox test card once and persist it. Reuses a saved card token. */
  async ensureSandboxCard(): Promise<VaultRecord> {
    return this.ensureCardVault();
  }

  /** Allocated synchronously inside the household order-claim transaction. No network. */
  prepareCharge(request: ChargeRequest): string {
    return this.attemptStore.transaction(() => {
      const prior = this.attemptStore.load(request.idempotencyKey);
      if (prior && (prior.status !== "failed" || !request.authorizationId || request.authorizationId === prior.authorizationId)) {
        throw this.unknown(request, "An unresolved attempt or a new approval is required. Check the original payment.");
      }
      const attemptId = randomUUID();
      const saved = this.configuredSavedVault() ?? this.vault;
      this.attemptStore.save({ idempotencyKey: request.idempotencyKey, amountCents: request.amountCents,
        currency: request.currency, sku: request.sku, description: request.description, authorizationId: request.authorizationId,
        approvalSnapshot: request.approvalSnapshot, policyHash: request.policyHash, attemptId,
        createRequestId: randomUUID(), captureRequestId: randomUUID(), status: "unknown", phase: "prepared",
        contextFingerprint: this.contextFingerprint(), replayCount: 0, preparedAt: this.now(), revision: 0,
        ...(saved ? { sourceFingerprint: this.fingerprint(saved) } : {}) });
      return attemptId;
    });
  }

  async captureCharge(request: ChargeRequest, vaultId?: string, beforeWrite?: () => void): Promise<PayPalChargeDetails> {
    const attemptId = request.preparedAttemptId ?? this.prepareCharge(request);
    const lease = this.claim(request, attemptId);
    try {
      beforeWrite?.();
      if (this.attempt(request.idempotencyKey).phase !== "prepared") throw this.unknown(request, "This attempt was already sent. Use explicit payment recovery.");
      const mode = this.vaultMode();
      this.vault = this.configuredSavedVault() ?? this.vault;
      const vault = vaultId ? { vaultId, source: this.vault?.source ?? (mode === "paypal" ? "paypal" as const : "card" as const) }
        : await this.savedVault() ?? (mode === "paypal" ? await this.ensurePayPalWallet() : await this.ensureCardVault());
      return await this.captureSaved(request, vault, attemptId, lease, beforeWrite);
    } catch (error) {
      const current = this.ownedAttempt(request.idempotencyKey, attemptId, lease);
      if (error instanceof PayPalApiError && ["PAYER_CANNOT_PAY", "INSTRUMENT_DECLINED", "CARD_EXPIRED", "CARD_CLOSED"].includes(error.issue ?? "") &&
        current.phase !== "verified_paid" && !current.responseMismatch) {
        this.recordOutcome(current, "failed"); throw error;
      }
      if (current.phase === "verified_failed") throw error;
      throw this.unknown(request, "The payment result needs verification. No replacement payment was started.");
    } finally { this.release(request.idempotencyKey, lease); }
  }

  /** GET only. Keep the exact attempt snapshot across the network boundary. */
  async lookupCharge(key: string): Promise<PaymentLookup> {
    const a = this.attemptStore.load(key);
    if (!a) return { status: "not_found" };
    const identity = a.attemptId ? { attemptId: a.attemptId } : {};
    if (a.status === "failed" || a.phase === "verified_failed") return { status: "failed", ...identity };
    if (!a.orderId) return { status: "unknown", ...identity };
    try { return this.inspectOrder(a, await this.getResource(`/v2/checkout/orders/${encodeURIComponent(a.orderId)}`, "order")); }
    catch { return { status: "unknown", paymentId: a.orderId, ...identity }; }
  }

  recoveryInfo(key: string): { attemptId: string; recoverable: boolean } | null {
    const a = this.attemptStore.load(key);
    if (!a?.attemptId) return null;
    const first = a.phase === "capture" ? a.captureFirstSentAt : a.phase === "prepared" ? a.preparedAt : a.createFirstSentAt;
    const inWindow = first !== undefined && Number.isFinite(first) && this.now() >= first && this.now() + 60_000 < first + PAYMENT_REPLAY_WINDOW_MS;
    return { attemptId: a.attemptId, recoverable: a.status === "unknown" && !a.replayBlocked && !a.responseMismatch && this.validReplayMetadata(a) &&
      ["prepared", "create", "found", "capture"].includes(a.phase ?? "") && (a.phase !== "found" || a.remoteApproved === true) && inWindow && (a.replayCount ?? 0) < 3 };
  }

  /** Explicit authenticated write operation; status checks never call this. */
  async recoverCharge(request: ChargeRequest, attemptId: string, guard: () => void): Promise<PaymentLookup> {
    const lease = this.claim(request, attemptId);
    try {
      let a = this.ownedAttempt(request.idempotencyKey, attemptId, lease);
      if (!this.validReplayMetadata(a)) throw this.unknown(request, "Original request metadata is missing. Use read-only verification.");
      if (a.orderId) {
        const found = await this.lookupCharge(request.idempotencyKey);
        a = this.ownedAttempt(request.idempotencyKey, attemptId, lease);
        if (found.attemptId !== attemptId) throw this.unknown(request, "The lookup belongs to a different attempt.");
        if (found.status !== "unknown") return found;
      }
      if (!this.recoveryInfo(request.idempotencyKey)?.recoverable) throw this.unknown(request, "The original request cannot safely be replayed. An operator must locate it in PayPal.");
      guard();
      const vault = await this.reloadSavedVault();
      this.assertCurrent(a);
      if (!vault || this.fingerprint(vault) !== a.sourceFingerprint || this.contextFingerprint() !== a.contextFingerprint) {
        this.updateAttempt(a, { replayBlocked: true });
        throw this.unknown(request, "The original payment configuration changed. Manual verification is required.");
      }
      this.vault = vault;
      if (a.phase === "prepared" && a.createFirstSentAt === undefined) a = this.updateAttempt(a, { createDigest: digest(this.orderBody(request, vault, a.attemptId!)) });
      if (digest(this.orderBody(request, vault, a.attemptId!)) !== a.createDigest || (a.phase === "capture" && digest({}) !== a.captureDigest)) {
        this.updateAttempt(a, { replayBlocked: true });
        throw this.unknown(request, "The original request no longer matches. Manual verification is required.");
      }
      if (a.lastReplayAt !== undefined && this.now() - a.lastReplayAt < 5_000) throw this.unknown(request, "Wait before checking this original request again.");
      a = this.updateAttempt(a, { replayCount: (a.replayCount ?? 0) + 1, lastReplayAt: this.now() });
      const preflight = () => {
        guard();
        const latest = this.ownedAttempt(request.idempotencyKey, attemptId, lease);
        this.assertSource(latest, false);
        const first = latest.phase === "capture" ? latest.captureFirstSentAt : latest.phase === "prepared" ? latest.preparedAt : latest.createFirstSentAt;
        if (latest.replayBlocked || first === undefined || !Number.isFinite(first) || this.now() < first || this.now() + 60_000 >= first + PAYMENT_REPLAY_WINDOW_MS) throw this.unknown(request, "The replay window has closed.");
      };
      const submitted = a.phase === "create" || a.phase === "prepared"
        ? await this.createOrder(request, vault, preflight)
        : await this.captureOrder(a.orderId!, request.idempotencyKey, preflight);
      this.assertCurrent(submitted.attempt);
      if (this.validateOrder(submitted.attempt, submitted.order).mismatch) return this.inspectOrder(submitted.attempt, submitted.order);
      // Never chain capture after recovering create; verify the same remote order with GET.
      return await this.lookupCharge(request.idempotencyKey);
    } catch (error) {
      const a = this.ownedAttempt(request.idempotencyKey, attemptId, lease);
      if (error instanceof PayPalApiError && !a.responseMismatch && ["PAYER_CANNOT_PAY", "INSTRUMENT_DECLINED", "CARD_EXPIRED", "CARD_CLOSED"].includes(error.issue ?? "")) return this.lookupCharge(request.idempotencyKey);
      throw this.unknown(request, "Recovery is not confirmed. The original budget reservation remains on hold.");
    } finally { this.release(request.idempotencyKey, lease); }
  }

  /** Runs inside the household transaction that writes the terminal order status. */
  finalizeCharge(key: string, status: "paid" | "failed", expectedAttemptId?: string): void {
    const a = this.attemptStore.load(key);
    if (!a) throw new PaymentUnknownError("The verified payment record is missing.", key);
    if (a.attemptId !== expectedAttemptId) throw new PaymentUnknownError("The verified result belongs to an older attempt.", key);
    if (a.status === status) return;
    if (a.phase !== `verified_${status}` || a.responseMismatch) throw new PaymentUnknownError("The provider result is not verified.", key);
    this.updateAttempt(a, { status });
  }


  /** Both a fresh submission and a later GET must pass this same validator. */
  private validateOrder(a: PaymentAttempt, order: PayPalResource) {
    const unknown: PaymentLookup = { status: "unknown", paymentId: a.orderId, ...(a.attemptId ? { attemptId: a.attemptId } : {}) };
    const units = order.raw.purchase_units as Record<string, unknown>[] | undefined;
    const unit = Array.isArray(units) && units.length === 1 ? units[0] : undefined;
    const matchesAmount = (value: unknown) => Boolean(value && typeof value === "object" &&
      (value as Record<string, unknown>).currency_code === a.currency && (value as Record<string, unknown>).value === centsToPayPalAmount(a.amountCents));
    const modern = a.attemptId !== undefined || a.createRequestId !== undefined || a.captureRequestId !== undefined || a.preparedAt !== undefined || a.contextFingerprint !== undefined;
    const mismatch = () => ({ lookup: unknown, mismatch: true, remoteApproved: false });
    if (order.id !== a.orderId || unit?.custom_id !== a.idempotencyKey || !matchesAmount(unit?.amount) ||
      (modern && (!isRequestId(a.attemptId) || unit?.reference_id !== a.attemptId || unit?.description !== a.description))) return mismatch();
    const payments = unit?.payments as Record<string, unknown> | undefined;
    if (payments !== undefined && (!payments || typeof payments !== "object" || Array.isArray(payments))) return mismatch();
    const captures = payments?.captures;
    if (captures !== undefined && !Array.isArray(captures)) return mismatch();
    const list = Array.isArray(captures) ? captures as Record<string, unknown>[] : [];
    const capture = list[0];
    if (list.length > 1 || (list.length === 1 && (!capture || typeof capture.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(capture.id) || !matchesAmount(capture.amount)))) return mismatch();
    if (order.status === "COMPLETED" && list.length === 1 && capture?.status === "COMPLETED") {
      const paidAt = typeof capture.create_time === "string" && Number.isFinite(Date.parse(capture.create_time)) ? capture.create_time : undefined;
      return { lookup: { ...unknown, status: "paid" as const, paymentId: order.id, captureId: capture.id as string, paidAt }, mismatch: false, remoteApproved: false };
    }
    if ((list.length === 1 && ["DECLINED", "DENIED", "FAILED"].includes(String(capture?.status))) || (order.status === "VOIDED" && list.length === 0)) {
      return { lookup: { ...unknown, status: "failed" as const, paymentId: order.id }, mismatch: false, remoteApproved: false };
    }
    return { lookup: unknown, mismatch: false, remoteApproved: order.status === "APPROVED" && list.length === 0 };
  }

  private inspectOrder(expected: PaymentAttempt, order: PayPalResource): PaymentLookup {
    this.assertCurrent(expected);
    if (expected.responseMismatch) return { status: "unknown", paymentId: expected.orderId, attemptId: expected.attemptId };
    const result = this.validateOrder(expected, order);
    if (result.mismatch) {
      this.updateAttempt(expected, { replayBlocked: true, responseMismatch: true });
    } else if (result.lookup.status === "paid") {
      this.recordOutcome(expected, "paid", { captureId: result.lookup.captureId, paidAt: result.lookup.paidAt });
    } else if (result.lookup.status === "failed") {
      this.recordOutcome(expected, "failed");
    } else {
      this.updateAttempt(expected, { remoteApproved: result.remoteApproved,
        ...(expected.phase === "create" && result.remoteApproved ? { phase: "found" as const } : {}) });
    }
    return result.lookup;
  }

  private attempt(key: string): PaymentAttempt {
    const a = this.attemptStore.load(key);
    if (!a) throw new PaymentUnknownError("The payment attempt record is missing.", key);
    return a;
  }
  private unknown(request: ChargeRequest, message: string) { return new PaymentUnknownError(message, request.idempotencyKey); }
  private assertCurrent(expected: PaymentAttempt): PaymentAttempt {
    const current = this.attempt(expected.idempotencyKey);
    if (current.attemptId !== expected.attemptId || current.orderId !== expected.orderId ||
      (current.revision ?? 0) !== (expected.revision ?? 0) || digest(current) !== digest(expected)) {
      throw new PaymentUnknownError("The payment record changed while the response was in flight. Check the current attempt.", expected.idempotencyKey);
    }
    return current;
  }
  private ownedAttempt(key: string, attemptId: string, lease: string): PaymentAttempt {
    const a = this.attempt(key);
    if (a.attemptId !== attemptId || a.leaseOwner !== lease) throw new PaymentUnknownError("This payment attempt is no longer owned by this operation.", key);
    return a;
  }
  private updateAttempt(expected: PaymentAttempt, changes: Partial<PaymentAttempt>): PaymentAttempt {
    return this.attemptStore.transaction(() => {
      const current = this.assertCurrent(expected);
      const next = { ...current, ...changes, revision: (current.revision ?? 0) + 1 };
      this.attemptStore.save(next); return next;
    });
  }
  private recordOutcome(expected: PaymentAttempt, status: "paid" | "failed", details: Partial<PaymentAttempt> = {}) {
    return this.updateAttempt(expected, { ...details, phase: `verified_${status}`,
      ...(this.deferFinalization ? {} : { status }), replayBlocked: true });
  }
  private claim(request: ChargeRequest, attemptId: string): string {
    return this.attemptStore.transaction(() => {
      const a = this.attempt(request.idempotencyKey);
      if (a.attemptId !== attemptId || !this.validRequestIds(a) || a.amountCents !== request.amountCents || a.currency !== request.currency ||
        a.sku !== request.sku || a.description !== request.description || a.approvalSnapshot !== request.approvalSnapshot ||
        a.policyHash !== request.policyHash || a.authorizationId !== request.authorizationId || a.status !== "unknown" ||
        (a.leaseUntil !== undefined && (a.leaseUntil > this.now() || this.now() < a.leaseUntil - PAYMENT_LEASE_MS))) {
        throw this.unknown(request, "This attempt is busy, incomplete or its approval no longer matches.");
      }
      const lease = randomUUID();
      this.updateAttempt(a, { leaseOwner: lease, leaseUntil: this.now() + PAYMENT_LEASE_MS }); return lease;
    });
  }
  private release(key: string, lease: string) {
    this.attemptStore.transaction(() => {
      const a = this.attemptStore.load(key);
      if (a?.leaseOwner === lease) this.updateAttempt(a, { leaseOwner: undefined, leaseUntil: undefined });
    });
  }
  private validRequestIds(a: PaymentAttempt): boolean {
    return isRequestId(a.attemptId) && isRequestId(a.createRequestId) && isRequestId(a.captureRequestId) &&
      a.createRequestId !== a.captureRequestId;
  }
  private validReplayMetadata(a: PaymentAttempt): boolean {
    return this.validRequestIds(a) && isDigest(a.contextFingerprint) && isDigest(a.sourceFingerprint) &&
      (a.phase === "prepared" || (isDigest(a.createDigest) && Number.isFinite(a.createFirstSentAt))) &&
      (a.phase !== "capture" || (Boolean(a.orderId) && isDigest(a.captureDigest) && Number.isFinite(a.captureFirstSentAt)));
  }
  private assertStage(a: PaymentAttempt, stage: "create" | "capture") {
    this.assertCurrent(a);
    const allowedPhase = stage === "create" ? a.phase === "prepared" || a.phase === "create" : a.phase === "found" || a.phase === "capture";
    if (!this.validReplayMetadata(a) || !allowedPhase || a.replayBlocked || a.responseMismatch || !isRequestId(a.leaseOwner) ||
      a.leaseUntil === undefined || !Number.isFinite(a.leaseUntil) || !Number.isFinite(this.now()) || this.now() >= a.leaseUntil || this.now() < a.leaseUntil - PAYMENT_LEASE_MS ||
      (stage === "capture" && (!a.orderId || !isDigest(a.createDigest) || !Number.isFinite(a.createFirstSentAt)))) {
      throw new PaymentUnknownError("The original stage request is incomplete or blocked. No payment request was sent.", a.idempotencyKey);
    }
  }
  private assertSource(a: PaymentAttempt, allowMemory: boolean) {
    const source = this.configuredSavedVault() ?? (allowMemory ? this.vault : null);
    if (!source || this.fingerprint(source) !== a.sourceFingerprint || this.contextFingerprint() !== a.contextFingerprint) {
      this.updateAttempt(a, { replayBlocked: true });
      throw new PaymentUnknownError("The original payment configuration changed. No payment request was sent.", a.idempotencyKey);
    }
  }
  private contextFingerprint() { return digest({ base: this.baseUrl, client: this.clientId }); }
  private fingerprint(vault: VaultRecord) { return digest({ id: vault.vaultId, source: vault.source ?? "card", network: vault.networkTransaction }); }
  private async reloadSavedVault() { this.vault = null; return this.savedVault(); }
  private configuredSavedVault(): VaultRecord | null {
    const id = this.env.PAYPAL_VAULT_ID?.trim();
    return id ? { vaultId: id, source: this.env.PAYPAL_VAULT_SOURCE === "paypal" ? "paypal" : "card" } : this.vaultStore.load();
  }


  async tokenSummary(): Promise<{ scopes: string[]; expiresIn: number; tokenType: string; appId?: string }> {
    await this.accessToken();
    if (!this.tokenMeta) throw new Error("PayPal token response did not include scope metadata.");
    return this.tokenMeta;
  }

  private async captureSaved(request: ChargeRequest, vault: VaultRecord, attemptId: string, lease: string, beforeWrite?: () => void): Promise<PayPalChargeDetails> {
    this.vault = vault;
    const a = this.ownedAttempt(request.idempotencyKey, attemptId, lease);
    if (a.sourceFingerprint && a.sourceFingerprint !== this.fingerprint(vault)) throw this.unknown(request, "The saved payment method changed before submission.");
    this.updateAttempt(a, { sourceFingerprint: this.fingerprint(vault), createDigest: digest(this.orderBody(request, vault, attemptId)) });
    let submitted = await this.createOrder(request, vault, beforeWrite);
    let found = this.inspectOrder(submitted.attempt, submitted.order);
    if (found.status === "unknown" && !this.attempt(request.idempotencyKey).responseMismatch && submitted.order.status === "PAYER_ACTION_REQUIRED") {
      const expected = this.ownedAttempt(request.idempotencyKey, attemptId, lease);
      const approved = await this.waitUntilApproved(submitted.order, "order");
      found = this.inspectOrder(expected, approved);
      submitted = { order: approved, attempt: this.ownedAttempt(request.idempotencyKey, attemptId, lease) };
    }
    if (found.status === "unknown" && this.ownedAttempt(request.idempotencyKey, attemptId, lease).remoteApproved === true) {
      submitted = await this.captureOrder(submitted.order.id, request.idempotencyKey, beforeWrite);
      found = this.inspectOrder(submitted.attempt, submitted.order);
    }
    if (found.status === "failed") throw new Error("The payment was declined. Review the order before trying another payment method.");
    if (found.status !== "paid" || !found.captureId) throw this.unknown(request, "The payment result needs verification.");
    const networkTransaction = readNetworkTransaction(submitted.order.raw) ?? vault.networkTransaction;
    const currentSource = this.configuredSavedVault() ?? this.vault;
    if (currentSource && this.fingerprint(currentSource) === this.fingerprint(vault)) {
      this.vault = { ...vault, previousTransactionId: found.captureId, ...(networkTransaction ? { networkTransaction } : {}) };
      this.vaultStore.save(this.vault);
    }
    return { attemptId, orderId: submitted.order.id, orderStatus: submitted.order.status, captureId: found.captureId,
      captureStatus: "COMPLETED", vaultId: vault.vaultId };
  }


  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.now() < this.cachedToken.expiresAt - TOKEN_SKEW_MS) {
      return this.cachedToken.token;
    }
    if (!this.pendingToken) {
      this.pendingToken = this.fetchAccessToken().finally(() => {
        this.pendingToken = null;
      });
    }
    return this.pendingToken;
  }

  private async fetchAccessToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: "client_credentials" }).toString();
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const parsed = await this.request("POST", "/v1/oauth2/token", body, {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    }, false);
    const record = asRecord(parsed, "OAuth token");
    const token = stringField(record, "access_token");
    // The token endpoint documents expires_in as a number. Sandbox has also sent it as a numeric string.
    const expiresIn = finiteNumber(record.expires_in);
    if (!token || expiresIn === undefined || expiresIn <= 0) {
      throw new Error("PayPal OAuth response did not include access_token and expires_in.");
    }
    this.cachedToken = { token, expiresAt: this.now() + expiresIn * 1000 };
    const appId = stringField(record, "app_id");
    this.tokenMeta = {
      scopes: (stringField(record, "scope") ?? "").split(/\s+/).filter(Boolean),
      expiresIn,
      tokenType: stringField(record, "token_type") ?? "Bearer",
      ...(appId ? { appId } : {}),
    };
    return token;
  }

  private async createSetupToken(): Promise<PayPalResource> {
    const number = this.cardNumber();
    const expiry = this.env.PAYPAL_TEST_CARD_EXPIRY?.trim() || DEFAULT_TEST_EXPIRY;
    const card: Record<string, unknown> = {
      number,
      expiry,
      name: this.env.PAYPAL_TEST_CARD_NAME?.trim() || "Pip Hart",
      billing_address: {
        address_line_1: "2211 N First Street",
        address_line_2: "Building 17",
        admin_area_2: "San Jose",
        admin_area_1: "CA",
        postal_code: "95131",
        country_code: "US",
      },
      experience_context: {
        brand_name: "Replenish",
        locale: "en-US",
        return_url: this.env.PAYPAL_RETURN_URL?.trim() || "https://example.com/replenish/return",
        cancel_url: this.env.PAYPAL_CANCEL_URL?.trim() || "https://example.com/replenish/cancel",
      },
    };
    const configuredCvv = this.env.PAYPAL_TEST_CARD_CVV;
    const securityCode = configuredCvv === undefined ? DEFAULT_TEST_CVV : configuredCvv.trim();
    if (securityCode) card.security_code = securityCode;
    const parsed = await this.request(
      "POST",
      "/v3/vault/setup-tokens",
      { payment_source: { card } },
      { "PayPal-Request-Id": this.freshRequestId() },
    );
    return this.resource(parsed, "setup token");
  }

  private async createPayPalSetupToken(): Promise<PayPalResource> {
    const parsed = await this.request(
      "POST",
      "/v3/vault/setup-tokens",
      {
        payment_source: {
          paypal: {
            description: "Replenish household replenishment",
            usage_pattern: "IMMEDIATE",
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            experience_context: {
              brand_name: "Replenish",
              locale: "en-US",
              shipping_preference: "NO_SHIPPING",
              payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
              return_url: this.env.PAYPAL_RETURN_URL?.trim() || "https://example.com/replenish/return",
              cancel_url: this.env.PAYPAL_CANCEL_URL?.trim() || "https://example.com/replenish/cancel",
            },
          },
        },
      },
      { "PayPal-Request-Id": this.freshRequestId() },
    );
    return this.resource(parsed, "setup token");
  }

  private async createPaymentToken(setupTokenId: string): Promise<PayPalResource> {
    const parsed = await this.request(
      "POST",
      "/v3/vault/payment-tokens",
      { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
      { "PayPal-Request-Id": this.freshRequestId() },
    );
    // Payment Method Tokens v3 returns id, customer, payment_source, and links.
    // A live sandbox 201 has no status field. Orders and setup tokens do.
    return this.resource(parsed, "payment token", { status: "optional" });
  }

  private orderBody(request: ChargeRequest, vault: VaultRecord, attemptId: string) {
    return { intent: "CAPTURE", purchase_units: [{ reference_id: attemptId, custom_id: request.idempotencyKey,
      description: request.description, amount: { currency_code: request.currency, value: centsToPayPalAmount(request.amountCents) } }],
      payment_source: (vault.source ?? "card") === "paypal"
        ? { paypal: { vault_id: vault.vaultId, stored_credential: this.walletCredential() } }
        : { card: { vault_id: vault.vaultId, stored_credential: this.cardCredential() } } };
  }
  private async createOrder(request: ChargeRequest, vault: VaultRecord, preflight?: () => void): Promise<SubmittedOrder> {
    const a = this.attempt(request.idempotencyKey);
    this.assertStage(a, "create");
    const body = this.orderBody(request, vault, a.attemptId!);
    if (digest(body) !== a.createDigest) throw this.unknown(request, "The original create body cannot be reconstructed.");
    let sent = a;
    try {
      const parsed = await this.request("POST", "/v2/checkout/orders", body,
        { "PayPal-Request-Id": a.createRequestId!, Prefer: "return=representation" }, true, () => {
          preflight?.(); this.assertStage(a, "create"); this.assertSource(a, true);
          if (a.phase === "prepared") sent = this.updateAttempt(a, { phase: "create", createFirstSentAt: this.now() });
        });
      this.assertCurrent(sent);
      const order = this.resource(parsed, "order");
      if ((sent.orderId !== undefined && sent.orderId !== order.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(order.id)) {
        this.updateAttempt(sent, { replayBlocked: true, responseMismatch: true });
        throw this.unknown(request, "The returned order does not match the original request.");
      }
      return { order, attempt: sent.orderId === order.id ? sent : this.updateAttempt(sent, { orderId: order.id }) };
    } catch (error) { this.assertCurrent(sent); throw error; }
  }


  /**
   * The $1 diagnose charge that cleared in sandbox used DERIVED and no previous reference.
   * SUBSEQUENT is only sent once a scheme transaction id from that capture is on disk.
   * A PayPal capture id is not that reference. FIRST is customer-initiated only.
   */
  private cardCredential(): Record<string, unknown> {
    const network = this.vault?.networkTransaction;
    if (!network?.id) {
      return {
        payment_initiator: "MERCHANT",
        payment_type: "UNSCHEDULED",
        usage: "DERIVED",
      };
    }
    return {
      payment_initiator: "MERCHANT",
      payment_type: "UNSCHEDULED",
      usage: "SUBSEQUENT",
      previous_network_transaction_reference: {
        id: network.id,
        ...(network.network ? { network: network.network } : {}),
        ...(network.date ? { date: network.date } : {}),
      },
    };
  }

  private walletCredential(): Record<string, string> {
    return {
      payment_initiator: "MERCHANT",
      usage: "DERIVED",
      usage_pattern: "UNSCHEDULED_POSTPAID",
    };
  }

  private async captureOrder(orderId: string, key: string, preflight?: () => void): Promise<SubmittedOrder> {
    const a = this.attempt(key);
    this.assertStage(a, "capture");
    if (orderId !== a.orderId || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) throw new PaymentUnknownError("The capture order reference changed.", key);
    if (a.phase === "capture" && a.captureDigest !== digest({})) throw new PaymentUnknownError("The original capture body changed.", key);
    let sent = a;
    try {
      const parsed = await this.request("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {},
        { "PayPal-Request-Id": a.captureRequestId!, Prefer: "return=representation" }, true, () => {
          preflight?.(); this.assertStage(a, "capture"); this.assertSource(a, true);
          if (a.phase === "found") sent = this.updateAttempt(a, { phase: "capture", captureFirstSentAt: this.now(), captureDigest: digest({}) });
        });
      this.assertCurrent(sent);
      return { order: this.resource(parsed, "capture"), attempt: sent };
    } catch (error) {
      this.assertCurrent(sent);
      if (!(error instanceof PayPalApiError) || error.httpStatus !== 422 || error.issue !== "ORDER_ALREADY_CAPTURED") throw error;
      const order = await this.getResource(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, "order");
      this.assertCurrent(sent);
      return { order, attempt: sent };
    }
  }


  private async getResource(pathname: string, label: string): Promise<PayPalResource> {
    const parsed = await this.request("GET", pathname, undefined, {});
    return this.resource(parsed, label);
  }

  private async waitUntilApproved(resource: PayPalResource, kind: "setup" | "order"): Promise<PayPalResource> {
    if (resource.status !== "PAYER_ACTION_REQUIRED") return resource;
    // Vault setup tokens use rel "approve". Orders v2 uses rel "payer-action".
    const approve = buyerActionUrl(resource.links);
    const label = kind === "order" ? `order ${resource.id}` : "vault card";
    if (!approve) {
      throw new Error(`PayPal ${label} requires buyer approval but returned no approve URL (${resource.id}).`);
    }
    this.log(`PayPal needs a buyer to approve the ${label}.`);
    this.log("Open this URL and approve it. This process will poll until PayPal marks it approved:");
    this.log(approve);
    const deadline = this.now() + this.pollTimeoutMs;
    let current = resource;
    while (current.status === "PAYER_ACTION_REQUIRED") {
      if (this.now() >= deadline) {
        throw new Error(
          `Timed out waiting for PayPal approval of ${label} (${resource.id}). ` +
            `Open ${approve} and run again, or raise PAYPAL_APPROVAL_TIMEOUT_MS.`,
        );
      }
      await this.sleep(this.pollIntervalMs);
      const pathname = kind === "order"
        ? `/v2/checkout/orders/${resource.id}`
        : `/v3/vault/setup-tokens/${resource.id}`;
      current = await this.getResource(pathname, label);
    }
    if (current.status === "APPROVED" || current.status === "COMPLETED") return current;
    throw new Error(`PayPal ${label} ${resource.id} ended as ${current.status}, not approved.`);
  }

  private async request(
    method: string,
    pathname: string,
    body: unknown,
    headers: Record<string, string>,
    authenticate = true,
    beforeSend?: () => void,
  ): Promise<unknown> {
    if (method === "POST" && pathname.startsWith("/v2/checkout/orders") && !isRequestId(headers["PayPal-Request-Id"])) {
      throw new Error("A persisted stage Request-Id is required. No PayPal request was sent.");
    }
    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
      "PayPal-Request-Id": this.freshRequestId(),
      ...headers,
    };
    if (authenticate) {
      requestHeaders.Authorization = `Bearer ${await this.accessToken()}`;
    }
    let payload: string | undefined;
    if (body !== undefined) {
      if (typeof body === "string") {
        payload = body;
      } else {
        requestHeaders["Content-Type"] ??= "application/json";
        payload = JSON.stringify(body);
      }
    }
    beforeSend?.();
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      headers: requestHeaders,
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const parsed = parseBody(text);
    if (!response.ok) {
      throw this.apiError(response.status, pathname, parsed);
    }
    return parsed;
  }

  private apiError(status: number, pathname: string, parsed: unknown): PayPalApiError {
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const debugId = record ? stringField(record, "debug_id") : undefined;
    const details = record && Array.isArray(record.details) ? record.details : [];
    const first = details.find((detail) => detail && typeof detail === "object") as Record<string, unknown> | undefined;
    const issue = first ? stringField(first, "issue") : undefined;
    return new PayPalApiError(this.formatError(status, pathname, parsed), {
      httpStatus: status,
      pathname,
      ...(debugId ? { debugId: this.redactSensitive(debugId) } : {}),
      ...(issue ? { issue: this.redactSensitive(issue) } : {}),
    });
  }

  private formatError(status: number, pathname: string, parsed: unknown): string {
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const name = record ? stringField(record, "name") ?? stringField(record, "error") : undefined;
    const message = record
      ? stringField(record, "message") ?? stringField(record, "error_description")
      : typeof parsed === "string"
        ? parsed.slice(0, 300)
        : undefined;
    const debugId = record ? stringField(record, "debug_id") : undefined;
    const details = record && Array.isArray(record.details) ? record.details : [];
    const detailText = details
      .map((detail) => {
        if (!detail || typeof detail !== "object") return "";
        const issue = stringField(detail as Record<string, unknown>, "issue");
        const description = stringField(detail as Record<string, unknown>, "description");
        return [issue, description].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .join("; ");
    const parts = [`PayPal ${status} ${pathname}`];
    if (name) parts.push(name);
    if (message) parts.push(message);
    if (detailText) parts.push(detailText);
    if (status === 401 && pathname === "/v1/oauth2/token") {
      parts.push("Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for the sandbox app.");
    }
    const headline = redactPan(parts.join(" — "), this.cardNumber());
    return this.redactSensitive(debugId ? `${headline}\ndebug_id: ${debugId}` : headline);
  }

  private redactSensitive(text: string): string {
    let safe = redactPan(text, this.cardNumber());
    for (const value of [this.clientId, this.clientSecret, this.cachedToken?.token, this.env.PAYPAL_VAULT_ID, this.vault?.vaultId]) {
      if (value) safe = safe.split(value).join("[redacted]");
    }
    return safe;
  }

  private resource(
    parsed: unknown,
    label: string,
    requirements: { status: "required" | "optional" } = { status: "required" },
  ): PayPalResource {
    const raw = asRecord(parsed, label);
    const id = stringField(raw, "id");
    if (!id) {
      throw new Error(`PayPal ${label} response did not include an id.`);
    }
    const status = stringField(raw, "status");
    if (!status && requirements.status === "required") {
      throw new Error(`PayPal ${label} response did not include a status.`);
    }
    return { id, status: status ?? "", links: readLinks(raw), raw };
  }

  private cardNumber(): string {
    return (this.env.PAYPAL_TEST_CARD_NUMBER?.trim() || DEFAULT_TEST_CARD).replaceAll(/\s/g, "");
  }
}

export function centsToPayPalAmount(cents: number): string {
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const sign = cents < 0 ? "-" : "";
  return `${sign}${dollars}.${remainder.toString().padStart(2, "0")}`;
}

export function readPayPalCredentials(env: NodeJS.ProcessEnv): { clientId: string; clientSecret: string } {
  return readCredentials(env);
}

export function paypalApiBase(env: NodeJS.ProcessEnv): string {
  return apiBase(env);
}

function readCredentials(env: NodeJS.ProcessEnv): { clientId: string; clientSecret: string } {
  const clientId = env.PAYPAL_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new Error(
      "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required. " +
        "Create a sandbox REST app, enable Vault, then run:\n" +
        "  PAYMENT_PROVIDER=paypal PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... pnpm demo:paypal",
    );
  }
  return { clientId, clientSecret };
}

function apiBase(env: NodeJS.ProcessEnv): string {
  const override = env.PAYPAL_API_BASE?.trim();
  if (override) return override.replace(/\/$/, "");
  return env.PAYPAL_ENV?.trim().toLowerCase() === "live" ? PAYPAL_LIVE_BASE : PAYPAL_SANDBOX_BASE;
}

function vaultFile(env: NodeJS.ProcessEnv): string {
  return dataFile(env, env.PAYPAL_VAULT_FILE, "data/paypal-vault.json");
}

export function deleteSavedVault(env: NodeJS.ProcessEnv): void {
  const file = vaultFile(env);
  if (existsSync(file)) unlinkSync(file);
}

/** Saved sandbox token, if Connect or a previous charge already vaulted a card. Never includes the PAN. */
export function readSavedVault(env: NodeJS.ProcessEnv): { vaultId: string; last4: string | null } | null {
  const fromEnv = env.PAYPAL_VAULT_ID?.trim();
  if (fromEnv) return { vaultId: fromEnv, last4: null };
  const stored = new FileVaultStore(vaultFile(env)).load();
  if (!stored?.vaultId) return null;
  return { vaultId: stored.vaultId, last4: stored.last4 ?? null };
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`PayPal ${label} response was not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function buyerActionUrl(links: readonly PayPalLink[]): string | undefined {
  return links.find((link) => link.rel === "approve" || link.rel === "payer-action")?.href;
}

function readLinks(record: Record<string, unknown>): PayPalLink[] {
  if (!Array.isArray(record.links)) return [];
  const links: PayPalLink[] = [];
  for (const link of record.links) {
    if (!link || typeof link !== "object") continue;
    const href = stringField(link as Record<string, unknown>, "href");
    const rel = stringField(link as Record<string, unknown>, "rel");
    if (href && rel) links.push({ href, rel });
  }
  return links;
}

function customerIdOf(record: Record<string, unknown>): string | undefined {
  const customer = record.customer;
  if (!customer || typeof customer !== "object") return undefined;
  return stringField(customer as Record<string, unknown>, "id");
}

function lastDigits(record: Record<string, unknown>): string | undefined {
  const source = record.payment_source;
  if (!source || typeof source !== "object") return undefined;
  const card = (source as Record<string, unknown>).card;
  if (!card || typeof card !== "object") return undefined;
  return stringField(card as Record<string, unknown>, "last_digits");
}

function firstCapture(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const units = record.purchase_units;
  if (!Array.isArray(units)) return undefined;
  for (const unit of units) {
    if (!unit || typeof unit !== "object") continue;
    const payments = (unit as Record<string, unknown>).payments;
    if (!payments || typeof payments !== "object") continue;
    const captures = (payments as Record<string, unknown>).captures;
    if (!Array.isArray(captures) || !captures[0] || typeof captures[0] !== "object") continue;
    return captures[0] as Record<string, unknown>;
  }
  return undefined;
}

function readNetworkTransaction(record: Record<string, unknown>): VaultRecord["networkTransaction"] | undefined {
  const capture = firstCapture(record);
  if (!capture) return undefined;
  const embedded = capture.network_transaction_reference;
  if (embedded && typeof embedded === "object") {
    const id = stringField(embedded as Record<string, unknown>, "id");
    if (id && id.length >= 9) {
      const date = stringField(embedded as Record<string, unknown>, "date");
      const network = stringField(embedded as Record<string, unknown>, "network");
      return { id, ...(date ? { date } : {}), ...(network ? { network } : {}) };
    }
  }
  const processor = capture.processor_response;
  if (!processor || typeof processor !== "object") return undefined;
  const id = stringField(processor as Record<string, unknown>, "network_transaction_id");
  if (!id || id.length < 9) return undefined;
  const network = cardBrand(record);
  const date = monthDay(stringField(capture, "create_time"));
  return { id, ...(network ? { network } : {}), ...(date ? { date } : {}) };
}

function cardBrand(record: Record<string, unknown>): string | undefined {
  const source = record.payment_source;
  if (!source || typeof source !== "object") return undefined;
  const card = (source as Record<string, unknown>).card;
  if (!card || typeof card !== "object") return undefined;
  return stringField(card as Record<string, unknown>, "brand");
}

function monthDay(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return undefined;
  return `${match[2]}${match[3]}`;
}

function isRequestId(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function redactPan(text: string, pan: string): string {
  const known = pan.length >= 12 && text.includes(pan) ? text.split(pan).join(`····${pan.slice(-4)}`) : text;
  return known.replace(/\b\d{13,19}\b/g, (match) => `····${match.slice(-4)}`);
}
