import { createId } from "@replenish/domain";
import { evaluateOrderBudget, type BudgetViolation } from "@replenish/domain";
import {
  addLocalDays,
  decideReplan,
  estimateMealStock,
  forecastMeals,
  formatOrderDate,
  homeReorderReason,
  instantLocalDate,
  assertIsoDate,
  localDateTimeToUtc,
  QIZAI_MEAL_MINUTES,
  type FeedingEvent,
  type PlanDecision,
} from "@replenish/domain";
import {
  chatParserFromEnv,
  mealIndex,
  reviewFeedingChange,
  type ChatCommand,
  type ChatModel,
  type RoutingChatParser,
} from "@replenish/domain";
import { PaymentUnknownError, type PaymentLookup } from "@replenish/agent";
import { gramsFromProduct, SEED_PRODUCTS } from "@replenish/store";
import { migrate, type SqlDatabase } from "./db";
import { createHash } from "node:crypto";
import { TelegramNotifications, type NotificationFact } from "./notifications";
import type { TelegramTransport } from "./telegram";
import { CommandReceipts, OperationRejected } from "./operations";
import { AgentRuntime } from "./runtime";

export interface PaymentGateway {
  charge(input: {
    idempotencyKey: string;
    amountCents: number;
    sku: string;
    description: string;
    authorizationId?: string;
    approvalSnapshot?: string;
    policyHash?: string;
    preparedAttemptId?: string;
  }, beforeWrite?: () => void): Promise<{ paymentId: string; captureId?: string | null; attemptId?: string }>;
  query(idempotencyKey: string): Promise<"paid" | "failed" | "unknown" | "not_found">;
  lookup?(idempotencyKey: string): Promise<PaymentLookup>;
  prepare?(input: Parameters<PaymentGateway["charge"]>[0]): string;
  finalize?(key: string, status: "paid" | "failed", attemptId?: string): void;
  recoveryInfo?(key: string): { attemptId: string; recoverable: boolean } | null;
  recover?(input: Parameters<PaymentGateway["charge"]>[0], attemptId: string, guard: () => void): Promise<PaymentLookup>;
  /** Vault a sandbox card when Connect is pressed. Absent in tests that only flip flags. */
  ensureVault?(): Promise<{ vaultId: string; last4: string | null }>;
}

export interface HouseholdAppOptions {
  db: SqlDatabase;
  clock?: () => Date;
  payments: PaymentGateway;
  vault?: {
    hasPaymentToken(): boolean;
    summary?(): { connected: boolean; last4: string | null };
    ensure?(): Promise<{ vaultId: string; last4: string | null }>;
    clear?(): void;
  };
  timeZone?: string;
  shippingHours?: number;
  bufferHours?: number;
  priceCents?: number;
  sku?: string;
  env?: NodeJS.ProcessEnv;
  model?: ChatModel | null;
  telegram?: TelegramTransport;
}

interface FoodRow {
  pet_id: string;
  sku: string;
  meals_per_day: number;
  grams_per_meal: number;
  meal_minutes_json: string;
  stock_g: number;
  calibrated_at: string;
  stock_baseline_grams: number;
}

interface PlanRow {
  pet_id: string;
  predicted_runout_at: string;
  planned_order_at: string;
  candidate_order_at: string;
  estimated_delivery_at: string;
  delta_hours: number;
  plan_changed: number;
  risk_override: number;
  decision_code: string;
  headline: string;
  reason: string;
  version: number;
  shipping_hours: number;
  buffer_hours: number;
}

interface OrderRow {
  id: string;
  pet_id: string;
  sku: string;
  merchant: string;
  total_cents: number;
  currency: string;
  status: string;
  payment_status: string;
  idempotency_key: string | null;
  payment_id: string | null;
  payment_note: string | null;
  created_at: string;
  updated_at: string;
  received_at: string | null;
  paid_at: string | null;
  quantity_grams: number | null;
}

interface SettingsRow {
  autopilot: string;
  autopilot_resume_at: string | null;
  currency: string;
  per_order_limit_cents: number;
  monthly_limit_cents: number;
  surface_headline: string | null;
  surface_reason: string | null;
  surface_code: string | null;
}

interface AuthRow {
  connected: number;
  automatic_payment_authorized: number;
  environment: string;
  status: string;
  last_verified_at: string | null;
}

const PET_ID = "pet_qizai";
const MERCHANT = "replenish-store";

export class HouseholdApp {
  private readonly clock: () => Date;
  private readonly parser: RoutingChatParser;
  private readonly timeZone: string;
  private readonly shippingHours: number;
  private readonly bufferHours: number;
  private readonly priceCents: number;
  private readonly sku: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly notifications: TelegramNotifications;
  private readonly receipts: CommandReceipts;
  private readonly runtime: AgentRuntime;

  constructor(private readonly options: HouseholdAppOptions) {
    migrate(options.db);
    this.clock = options.clock ?? (() => new Date());
    this.timeZone = options.timeZone ?? options.db.get<{ timezone: string }>("SELECT timezone FROM pets WHERE id=?", [PET_ID])?.timezone ?? "America/Los_Angeles";
    this.shippingHours = options.shippingHours ?? 48;
    this.bufferHours = options.bufferHours ?? 48;
    this.priceCents = options.priceCents ?? 3500;
    this.sku = options.sku ?? "RC-SMALL-4";
    this.env = options.env ?? process.env;
    this.parser = chatParserFromEnv(this.env, options.model);
    this.notifications = new TelegramNotifications(options.db, this.env, this.clock, options.telegram);
    this.receipts = new CommandReceipts(options.db, this.clock);
    this.runtime = new AgentRuntime(options.db, this.clock);
    if (!this.db.get("SELECT id FROM pets WHERE id = ?", [PET_ID])) this.seed();
    // A previous process may have stopped after sending a payment. Never retry
    // that attempt as a new charge merely because the process restarted.
    this.db.run("UPDATE orders SET status = 'reconciling', payment_status = 'unknown' WHERE payment_status = 'processing'");
  }

  private get db(): SqlDatabase {
    return this.options.db;
  }

  home() {
    const pet = this.pet();
    const food = this.food();
    const plan = this.plan();
    const settings = this.settings();
    const auth = this.auth();
    const pending = this.openOrder("awaiting_approval") ?? this.openOrder("failed");
    const active = this.openOrder("ordered") ?? this.openOrder("shipped") ?? this.openOrder("preparing") ?? this.openOrder("reconciling");
    const priority = this.priority(settings, pending, active);
    const dates = this.dateGrid(plan);
    return {
      pet: { id: pet.id, name: pet.name, avatarUrl: pet.avatar_url, timezone: pet.timezone },
      headline: roundDaysLeftCopy(priority.headline),
      reason: priority.reason,
      orderDate: formatOrderDate(new Date(plan.planned_order_at), pet.timezone),
      orderDateRaw: plan.planned_order_at,
      state: priority.state,
      autopilot: settings.autopilot,
      autopilotResumeAt: settings.autopilot === "paused" ? settings.autopilot_resume_at : null,
      autopilotPauseReason: settings.autopilot === "paused" ? this.pauseReason(settings) : null,
      paypal: this.paypalView(auth),
      payment: this.paymentView(active),
      paymentCheckOrderId: active?.payment_status === "unknown" ? active.id : null,
      paymentRecovery: active?.payment_status === "unknown" ? this.recoveryView(active) : null,
      notifications: this.notifications.status(),
      agentStatus: { ...this.runtime.status(), waitingReason: this.waitingReason() },
      order: active?.payment_status === "paid"
        ? { ...orderView(active), ...productCopy(active.sku) }
        : null,
      dates,
      budget: {
        perOrderLimitCents: settings.per_order_limit_cents,
        monthlyLimitCents: settings.monthly_limit_cents,
      },
      notice: this.chatNotice(settings),
      undoRevisionId: this.latestRevision(),
      pendingApproval: pending
        ? {
            orderId: pending.id,
            approvalSnapshot: approvalSnapshot(pending),
            totalCents: pending.total_cents,
            currency: pending.currency,
            sku: pending.sku,
            merchant: pending.merchant,
            ...productCopy(pending.sku),
            violations: this.violationsFor(pending.total_cents, pending.id).violations,
            retry: pending.status === "failed",
            failure: pending.status === "failed" ? pending.payment_note : null,
          }
        : null,
      plan: this.planView(plan),
      feeding: {
        stockG: this.remainingStock(food),
        gramsPerMeal: food.grams_per_meal,
        mealsPerDay: food.meals_per_day,
        dailyGrams: food.grams_per_meal * food.meals_per_day,
      },
    };
  }

  async chat(text: string, idempotencyKey?: string, expectedRevisionId?: number): Promise<ChatTurn> {
    const hash = this.receipts.hash(expectedRevisionId === undefined ? text.trim() : { text: text.trim(), expectedRevisionId });
    const cached = this.receipts.lookup<ChatTurn>("chat", idempotencyKey, hash);
    if (cached) return cached;
    const baseline = this.commandBaseline();
    const food = this.food();
    const context = {
      gramsPerMeal: food.grams_per_meal,
      mealsPerDay: food.meals_per_day,
      timeZone: this.timeZone,
      now: this.clock(),
    };
    const command = await this.parser.parse(text, context);
    return this.receipts.commit("chat", idempotencyKey, hash, () => {
      if (baseline !== this.commandBaseline()) throw new OperationRejected("The household changed while this message was being interpreted. Review the latest plan and send it again.");
      if (command.type === "undo" && (!Number.isSafeInteger(expectedRevisionId) || expectedRevisionId! <= 0 || this.latestRevision() !== expectedRevisionId)) {
        throw new OperationRejected("Review the current feeding change before using Undo. This revision is missing or has already changed.");
      }
      return this.executeWithReceipt(reviewFeedingChange(text, command, context), idempotencyKey);
    });
  }

  undo(idempotencyKey?: string, expectedRevisionId?: number) {
    return this.receipts.commit("undo", idempotencyKey, this.receipts.hash(expectedRevisionId ?? null), () => {
      if (expectedRevisionId !== undefined && this.latestRevision() !== expectedRevisionId) throw new OperationRejected("A newer change exists. Review the current feeding plan before using Undo.");
      return this.executeWithReceipt({ type: "undo" }, idempotencyKey);
    });
  }

  operationStatus(kind: "chat" | "undo", id: string) { return this.receipts.status<ChatTurn>(kind, id); }
  configureScheduler(intervalMs: number) { this.runtime.configure(intervalMs); }
  runScheduledCheck() { return this.runtime.run(() => this.runDueJobs(), () => this.waitingReason()); }

  private waitingReason() {
    const order = this.openOrder();
    if (order?.payment_status === "unknown") return "Payment needs verification. Further payment attempts are on hold.";
    if (order?.payment_status === "processing") return "A payment attempt is in progress.";
    if (order?.payment_status === "paid") return "Waiting for confirmed receipt of the existing food order.";
    if (order?.status === "failed") return "Payment failed. Review this order before retrying.";
    if (order?.status === "awaiting_approval") return "Waiting for the owner's approval of this order.";
    if (this.settings().autopilot === "paused") return this.pauseReason(this.settings());
    if (!this.auth().automatic_payment_authorized || !this.vaultSummary().connected) return "Food monitoring continues. Automatic payment is not authorized.";
    return Date.parse(this.plan().planned_order_at) > this.clock().getTime()
      ? `Waiting for the planned order date: ${formatOrderDate(new Date(this.plan().planned_order_at), this.timeZone)}.`
      : "Replenishment is due. Waiting for a scheduled check.";
  }
  private latestRevision() { return this.db.get<{ id: number }>("SELECT id FROM revisions ORDER BY id DESC LIMIT 1")?.id ?? null; }
  private commandBaseline() {
    return this.receipts.hash({ food: this.food(), plan: this.plan().version, revision: this.latestRevision(), day: instantLocalDate(this.clock(), this.timeZone), pause: [this.settings().autopilot, this.settings().autopilot_resume_at] });
  }
  private executeWithReceipt(command: ChatCommand, operationId?: string): ChatTurn {
    const before = this.food(), previousPlan = this.plan().planned_order_at;
    const result = this.execute(command);
    const after = this.food();
    const undoable = ["feeding_permanent", "skip_meal", "temporary_meal", "actual_intake"].includes(command.type);
    return { ...result, receipt: { operationId: operationId ?? null, at: this.clock().toISOString(),
      outcome: command.type === "clarify" ? "needs_clarification" : command.type === "plan_query" ? "answered" : "applied",
      undoRevisionId: undoable ? this.latestRevision() : null,
      feeding: before.grams_per_meal !== after.grams_per_meal ? {
        before: { gramsPerMeal: before.grams_per_meal, dailyGrams: before.grams_per_meal * before.meals_per_day },
        after: { gramsPerMeal: after.grams_per_meal, dailyGrams: after.grams_per_meal * after.meals_per_day },
      } : null,
      plan: result.decision ? { beforeAt: previousPlan, afterAt: this.plan().planned_order_at, changed: previousPlan !== this.plan().planned_order_at } : null,
    } };
  }

  calibrate(stockG: number) {
    if (!Number.isFinite(stockG) || stockG < 0) throw new Error("Stock must be a non-negative amount");
    const before = this.remainingStock(this.food());
    this.pushRevision();
    this.db.run("UPDATE food_plans SET stock_g = ?, calibrated_at = ?, stock_baseline_grams = grams_per_meal WHERE pet_id = ?", [
      stockG,
      this.clock().toISOString(),
      PET_ID,
    ]);
    this.recordActivity("stock", `Calibrated estimated stock to ${stockG}g.`, String(before), String(stockG));
    return this.recompute("other");
  }

  updateFeeding(gramsPerMeal: number) {
    if (!Number.isFinite(gramsPerMeal) || gramsPerMeal <= 0 || gramsPerMeal > 5000) throw new Error("Grams per meal must be between 0 and 5,000.");
    return this.execute({ type: "feeding_permanent", gramsPerMeal });
  }

  budget() {
    const settings = this.settings();
    const spend = this.monthSpend();
    return {
      currency: settings.currency,
      perOrderLimitCents: settings.per_order_limit_cents,
      monthlyLimitCents: settings.monthly_limit_cents,
      monthSettledCents: spend.settled,
      monthCommittedCents: spend.committed,
      monthRemainingCents: settings.monthly_limit_cents - spend.settled - spend.committed,
    };
  }

  updateBudget(input: { perOrderLimitCents?: number; monthlyLimitCents?: number }) {
    const settings = this.settings();
    const perOrder = input.perOrderLimitCents ?? settings.per_order_limit_cents;
    const monthly = input.monthlyLimitCents ?? settings.monthly_limit_cents;
    if (!Number.isSafeInteger(perOrder) || !Number.isSafeInteger(monthly) || perOrder <= 0 || monthly <= 0) throw new Error("Budget limits must be positive whole cents");
    this.db.run("UPDATE settings SET per_order_limit_cents = ?, monthly_limit_cents = ? WHERE id = 'household'", [
      perOrder,
      monthly,
    ]);
    this.voidApprovalsIfPriceDrifted();
    this.recordActivity("budget", "Updated spending limits.", JSON.stringify({ perOrder: settings.per_order_limit_cents, monthly: settings.monthly_limit_cents }), JSON.stringify({ perOrder, monthly }));
    return this.budget();
  }

  paypalState() {
    const auth = this.auth();
    return {
      provider: "paypal",
      environment: auth.environment,
      connected: Boolean(auth.connected),
      automaticPaymentAuthorized: Boolean(auth.automatic_payment_authorized),
      status: auth.status,
      returnUrl: this.env.PAYPAL_RETURN_URL ?? null,
      webhookUrl: this.env.PAYPAL_WEBHOOK_URL ?? null,
    };
  }

  async connectPaypal() {
    if (this.options.vault?.ensure) {
      const saved = await this.options.vault.ensure();
      if (!saved.vaultId) throw new Error("PayPal did not return a vault token.");
    }
    this.db.run(
      "UPDATE payment_auth SET connected = 1, status = 'connected', last_verified_at = ? WHERE id = 'paypal'",
      [this.clock().toISOString()],
    );
    return this.home();
  }

  authorizePaypal() {
    const ok = this.vaultSummary().connected;
    this.db.run(
      "UPDATE payment_auth SET connected = ?, automatic_payment_authorized = ?, status = ?, last_verified_at = ? WHERE id = 'paypal'",
      [ok ? 1 : 0, ok ? 1 : 0, ok ? "enabled" : "disconnected", this.clock().toISOString()],
    );
    return {
      ...this.paypalState(),
      connected: ok,
      message: ok
        ? "Sandbox vault is verified. Autopilot can pay inside the budget."
        : "No PayPal vault token is stored, so automatic payment was not authorized.",
    };
  }

  pause() {
    this.db.run("UPDATE settings SET autopilot = 'paused', autopilot_resume_at = NULL WHERE id = 'household'");
    this.recordActivity("autopilot", "Paused automatic buying");
    return this.home();
  }

  resume() {
    this.resumeBuying();
    return this.home();
  }

  private pauseUntil(until: string) {
    assertIsoDate(until);
    const at = localDateTimeToUtc(until, 0, this.timeZone);
    if (until <= instantLocalDate(this.clock(), this.timeZone) || at.getTime() <= this.clock().getTime()) throw new Error("Choose a future date for automatic buying to resume.");
    this.db.run("UPDATE settings SET autopilot='paused',autopilot_resume_at=? WHERE id='household'", [at.toISOString()]);
    this.recordActivity("autopilot", `Paused automatic buying until ${until} at 00:00 (${this.timeZone}).`);
    return { command: { type: "pause_orders" as const, until }, headline: `Paused orders until ${until}.`, reason: this.pauseReason(this.settings()), decision: null };
  }

  private pauseReason(settings: SettingsRow) {
    if (!settings.autopilot_resume_at) return "Automatic buying is paused until you resume. Food estimates and payment checks continue.";
    const date = instantLocalDate(new Date(settings.autopilot_resume_at), this.timeZone);
    return `I'll resume automatic buying on ${date} at 00:00 (${this.timeZone}), on the next background check. Payment authorization and budget rules still apply.`;
  }

  private resumeBuying(expectedResumeAt?: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.run(`UPDATE settings SET autopilot='active',autopilot_resume_at=NULL WHERE id='household' AND autopilot='paused'${expectedResumeAt ? " AND autopilot_resume_at=?" : ""}`, expectedResumeAt ? [expectedResumeAt] : []);
      if (this.db.get<{ changed: number }>("SELECT changes() AS changed")?.changed) {
        this.recompute("other", false, expectedResumeAt ? "Automatically resumed buying after the scheduled pause; current stock and feeding were checked." : "Resumed automatic buying");
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  orders() {
    return this.db
      .all<OrderRow>("SELECT * FROM orders WHERE pet_id = ? ORDER BY created_at DESC", [PET_ID])
      .map(orderView);
  }

  orderDetails(orderId: string) {
    const order = this.order(orderId);
    return { ...orderView(order), ...productCopy(order.sku), approvalSnapshot: approvalSnapshot(order) };
  }

  notificationStatus() { return this.notifications.status(); }
  tickNotifications() { return this.notifications.tick(() => this.notificationFacts()); }
  deliverNotifications() { return this.notifications.flush(() => this.notificationFacts()); }

  private notificationFacts(): NotificationFact[] {
    const facts: NotificationFact[] = [];
    const now = this.clock();
    const orders = this.db.all<OrderRow>("SELECT * FROM orders WHERE status IN ('awaiting_approval','failed','reconciling') OR payment_status='paid'");
    const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(cents / 100);
    const paymentLabel = this.env.PAYMENT_PROVIDER === "paypal"
      ? this.env.PAYPAL_ENV === "live" ? "PayPal payment" : "PayPal Sandbox test payment"
      : "Simulated test payment";
    for (const order of orders) {
      const product = productCopy(order.sku);
      const base = { occurredAt: order.updated_at, path: `/?order=${encodeURIComponent(order.id)}`, button: "View order" };
      const identity = `${order.id}:${order.total_cents}`;
      if (order.status === "awaiting_approval" && order.payment_status === "none") {
        const violations = this.violationsFor(order.total_cents, order.id).violations;
        const reasons = violations.map(item => item.code === "per_order"
          ? `Over your ${money(item.limitCents).replace(/\.00$/, "")} auto-pay limit.` : "Over your monthly budget.").join(" ");
        const revision = createHash("sha256").update(reasons).digest("hex").slice(0, 12);
        facts.push({ ...base, key: `approval:${identity}:${revision}`, kind: "approval", button: "Review approval",
          text: `Qizai's next food order needs your approval.\n${product.productName} — ${product.productDetail}\nTotal: ${money(order.total_cents)} USD.\n${reasons || "Automatic payment is not authorized for this order."}\nNo payment has been made. Open the website to review and approve.\nSimulated store · Sandbox demo.` });
      } else if (order.payment_status === "paid") {
        const capture = storedCaptureId(order.payment_note);
        facts.push({ ...base, key: `paid:${identity}`, kind: "paid", occurredAt: order.paid_at ?? order.created_at,
          text: `Qizai's food payment is confirmed.\n${product.productName} — ${product.productDetail}\nPaid: ${money(order.total_cents)} USD.\n${paymentLabel}${capture ? ` · receipt …${capture.slice(-6)}` : ""}.\nThe simulated store order is confirmed. When the bag arrives, open this order and tap Food received. I'll update Qizai's stock and plan the next refill.` });
      } else if (order.payment_status === "unknown") {
        facts.push({ ...base, key: `unknown:${identity}`, kind: "payment_unknown",
          text: `Qizai's payment result needs verification.\nOrder total: ${money(order.total_cents)} USD.\nThe payment is not confirmed. Further payment attempts are on hold while the result is checked.\nOpen the order for the latest status.\nSandbox demo.` });
      } else if (order.status === "failed" && order.payment_status === "failed") {
        facts.push({ ...base, key: `failed:${identity}`, kind: "payment_failed",
          text: `Qizai's food payment could not be completed.\nOrder total: ${money(order.total_cents)} USD.\nPlease review the order before retrying.\nSandbox demo.` });
      }
    }
    const plan = this.plan();
    const activePaid = this.openOrder("ordered") ?? this.openOrder("shipped");
    const shippingMs = plan.shipping_hours * 3_600_000;
    const arrival = activePaid ? Math.max(Date.parse(plan.estimated_delivery_at), Date.parse(activePaid.paid_at ?? activePaid.updated_at) + shippingMs) : now.getTime() + shippingMs;
    if (this.remainingStock(this.food()) <= 0 || Date.parse(plan.predicted_runout_at) < arrival) {
      facts.push({ key: `food-risk:${this.food().calibrated_at}`, kind: "food_risk", occurredAt: now.toISOString(), path: "/?view=plan", button: "Review food plan",
        text: "Qizai's food may run out before delivery.\nThe current food estimate may not cover the delivery time. Please check the stock and replenishment plan.\nThis is an estimate, not a confirmed shortage or a shipment update." });
    }
    return facts;
  }

  async createOrder(input: { totalCents?: number; idempotencyKey?: string } = {}) {
    const cached = this.cached(input.idempotencyKey);
    if (cached) return cached;
    const total = input.totalCents ?? this.priceCents;
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error("Order total must be a positive number of cents.");
    let order: OrderRow;
    let gate: ReturnType<typeof evaluateOrderBudget>;
    // Claim the household and its budget together, before any network work.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.settings().autopilot === "paused") throw new Error("Autopilot is paused. No new order was created.");
      if (this.openOrder()) throw new Error("An order is already open.");
      const now = this.clock().toISOString();
      const id = createId("ord");
      gate = this.violationsFor(total);
      const authorized = Boolean(this.auth().automatic_payment_authorized) && this.vaultSummary().connected;
      const status = authorized && gate.allowed ? "preparing" : "awaiting_approval";
      const product = SEED_PRODUCTS.find((item) => item.sku === this.sku);
      this.db.run(
        `INSERT INTO orders (id, pet_id, sku, merchant, total_cents, currency, status, payment_status, idempotency_key, payment_id, created_at, updated_at, quantity_grams)
         VALUES (?, ?, ?, ?, ?, 'USD', ?, 'none', ?, NULL, ?, ?, ?)`,
        [id, PET_ID, this.sku, MERCHANT, total, status, id, now, now, product ? gramsFromProduct(product) : null],
      );
      order = this.order(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordActivity("order", order.status === "preparing" ? "Scheduled replenishment is ready for automatic payment." : "Scheduled replenishment is waiting for approval.");
    if (order.status === "preparing") order = await this.pay(order);
    const body = { order: orderView(order), violations: gate.violations, monthTotalCents: gate.monthTotalCents };
    return this.storeIdempotent(input.idempotencyKey, body);
  }

  async approve(orderId: string, expectedTotalCents: number, expectedSnapshot: string, idempotencyKey?: string) {
    const cached = this.cached(idempotencyKey);
    if (cached) return cached;
    const order = this.order(orderId);
    if (order.status === "ordered" || order.status === "shipped" || order.status === "delivered") {
      return this.storeIdempotent(idempotencyKey, { order: orderView(order), charged: false });
    }
    if (order.payment_status === "unknown" || order.status === "reconciling") {
      return this.storeIdempotent(idempotencyKey, await this.reconcile(order));
    }
    if (order.status === "preparing" || order.payment_status === "processing") {
      return { order: orderView(order), charged: false };
    }
    if (order.status !== "awaiting_approval" && order.status !== "failed") {
      throw new Error("This order is no longer awaiting approval.");
    }
    if (expectedTotalCents !== order.total_cents || expectedSnapshot !== approvalSnapshot(order)) {
      this.voidApproval(order.id);
      return this.storeIdempotent(idempotencyKey, {
        order: orderView(order),
        charged: false,
        voided: true,
        message: "This order has changed since you viewed it. Review the current order before approving. No payment was requested.",
      });
    }
    this.db.run(
      `INSERT INTO approvals (id, order_id, sku, merchant, total_cents, currency, status, violated_json, created_at, snapshot_hash)
         VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
      [createId("apr"), order.id, order.sku, order.merchant, expectedTotalCents, order.currency, JSON.stringify(this.violationsFor(order.total_cents, order.id).violations), this.clock().toISOString(), expectedSnapshot],
    );
    this.recordActivity("approval", "Approved this food order once; spending limits are unchanged.");
    const paid = await this.pay({ ...order, status: "preparing" });
    return this.storeIdempotent(idempotencyKey, { order: orderView(paid), charged: paid.payment_status === "paid", voided: false });
  }

  reject(orderId: string) {
    const order = this.order(orderId);
    this.assertEditableOrder(order);
    this.db.run(
      "UPDATE orders SET status = 'rejected', updated_at = ? WHERE id = ? AND status IN ('awaiting_approval', 'failed') AND payment_status IN ('none', 'failed')",
      [this.clock().toISOString(), order.id],
    );
    if (!this.db.get<{ changed: number }>("SELECT changes() AS changed")?.changed) throw new Error("This order is already being processed.");
    this.recordActivity("order", "Rejected the unpaid food order.");
    return { order: orderView(this.order(orderId)), charged: false };
  }

  reprice(orderId: string, totalCents: number) {
    const order = this.order(orderId);
    this.assertEditableOrder(order);
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new Error("Order total must be a positive number of cents.");
    this.db.run(
      "UPDATE orders SET total_cents = ?, updated_at = ? WHERE id = ? AND status IN ('awaiting_approval', 'failed') AND payment_status IN ('none', 'failed')",
      [totalCents, this.clock().toISOString(), orderId],
    );
    if (!this.db.get<{ changed: number }>("SELECT changes() AS changed")?.changed) throw new Error("This order is already being processed.");
    this.voidApproval(orderId);
    return { order: orderView(this.order(orderId)), approval: "void" };
  }

  /** A receipt is an explicit event, never inferred from an estimated date. */
  receive(orderId: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const order = this.order(orderId);
      if (order.status === "delivered") {
        this.db.exec("COMMIT");
        return this.home();
      }
      if (order.payment_status !== "paid" || !["ordered", "shipped"].includes(order.status)) {
        throw new Error("Only a confirmed paid order can be received.");
      }
      const product = SEED_PRODUCTS.find((item) => item.sku === order.sku);
      const grams = order.quantity_grams ?? (product ? gramsFromProduct(product) : null);
      if (!grams || !Number.isFinite(grams) || grams <= 0) throw new Error("This order has no known food quantity.");
      const remaining = this.remainingStock();
      const receivedAt = this.clock().toISOString();
      this.db.run(
        "UPDATE food_plans SET stock_g = ?, calibrated_at = ?, stock_baseline_grams = grams_per_meal WHERE pet_id = ?",
        [remaining + grams, receivedAt, PET_ID],
      );
      this.db.run("UPDATE orders SET status = 'delivered', received_at = ?, updated_at = ? WHERE id = ?", [receivedAt, receivedAt, order.id]);
      // Feeding Undo must never remove food that was subsequently received.
      this.db.run("DELETE FROM revisions");
      this.recompute("other", true);
      this.recordActivity("delivery", `Confirmed receipt of ${grams}g; next replenishment scheduled.`, String(remaining), String(remaining + grams));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.home();
  }

  async reconcile(order: OrderRow) {
    const key = order.idempotency_key ?? order.id;
    const expectedAttempt = this.options.payments.recoveryInfo?.(key)?.attemptId;
    const found = await this.lookupPayment(key);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.order(order.id);
      const currentAttempt = this.options.payments.recoveryInfo?.(key)?.attemptId;
      if (expectedAttempt === currentAttempt && (!found.attemptId || found.attemptId === expectedAttempt) &&
        latest.payment_status === "unknown" && latest.updated_at === order.updated_at) {
        if (found.status === "paid") {
          this.confirmRecoveredPayment(order, found, expectedAttempt);
          this.recordActivity("payment", "Verified the payment with the payment provider.");
        } else if (found.status === "failed") {
          this.setOrder(order.id, "failed", "failed", order.payment_id, undefined, expectedAttempt);
        } else {
          this.setOrder(order.id, "reconciling", "unknown", order.payment_id, undefined, expectedAttempt);
        }
      }
      const result = { order: orderView(this.order(order.id)), charged: false };
      this.db.exec("COMMIT"); return result;
    } catch (error) {
      this.db.exec("ROLLBACK"); throw error;
    }
  }

  async checkPayment(orderId: string) {
    const order = this.order(orderId);
    if (order.payment_status === "unknown") await this.reconcile(order);
    return this.home();
  }

  /** Explicit consent to replay the original approved payment, never a new order. */
  async recoverPayment(orderId: string, expectedTotal: number, expectedSnapshot: string, expectedAttemptId: string) {
    const order = this.order(orderId);
    if (order.payment_status !== "unknown" || !this.options.payments.recover) throw new OperationRejected("This order has no recoverable payment.");
    const input = this.paymentInput(order);
    const key = order.idempotency_key ?? order.id;
    if (this.options.payments.recoveryInfo?.(key)?.attemptId !== expectedAttemptId) throw new OperationRejected("This payment attempt changed. Review the current order before recovering it.");
    const guard = () => {
      const current = this.order(orderId);
      if (current.payment_status !== "unknown" || this.options.payments.recoveryInfo?.(key)?.attemptId !== expectedAttemptId || this.settings().autopilot !== "active" ||
        expectedTotal !== current.total_cents || expectedSnapshot !== approvalSnapshot(current) ||
        JSON.stringify(this.paymentInput(current)) !== JSON.stringify(input) || !this.vaultSummary().connected ||
        this.db.get("SELECT id FROM orders WHERE id<>? AND status IN ('awaiting_approval','preparing','reconciling','ordered','shipped')", [orderId])) {
        throw new OperationRejected("Review the latest order, budget and pause state before recovering the original payment.");
      }
    };
    guard();
    const found = await this.options.payments.recover(input, expectedAttemptId, guard);
    const latest = this.order(orderId);
    if (this.options.payments.recoveryInfo?.(key)?.attemptId !== expectedAttemptId || (found.attemptId && found.attemptId !== expectedAttemptId)) return this.home();
    if (latest.payment_status === "unknown") {
      if (found.status === "paid") this.confirmRecoveredPayment(latest, found, expectedAttemptId);
      else if (found.status === "failed") this.setOrder(orderId, "failed", "failed", latest.payment_id, undefined, expectedAttemptId);
    }
    this.recordActivity("payment", found.status === "paid" ? "Recovered and verified the original payment." : "Original payment recovery checked; no replacement payment was started.");
    return this.home();
  }

  private recoveryView(order: OrderRow) {
    const info = this.options.payments.recoveryInfo?.(order.idempotency_key ?? order.id);
    return info ? { ...info, orderId: order.id, totalCents: order.total_cents, approvalSnapshot: approvalSnapshot(order),
      ...productCopy(order.sku), merchant: order.merchant, currency: order.currency,
      recoverable: info.recoverable && this.settings().autopilot === "active" } : null;
  }

  private paymentInput(order: OrderRow): Parameters<PaymentGateway["charge"]>[0] {
    const snapshot = approvalSnapshot(order);
    const approved = this.db.get<{ id: string }>("SELECT id FROM approvals WHERE order_id=? AND status='approved' AND snapshot_hash=? ORDER BY created_at DESC, rowid DESC LIMIT 1", [order.id, snapshot]);
    const automatic = Boolean(this.auth().automatic_payment_authorized) && this.vaultSummary().connected && this.violationsFor(order.total_cents, order.id).allowed;
    if (!approved && !automatic) throw new OperationRejected("Payment needs a current approval or valid automatic payment authorization.");
    const settings = this.settings();
    const policyHash = this.receipts.hash({ month: instantLocalDate(this.clock(), this.timeZone).slice(0, 7),
      perOrder: settings.per_order_limit_cents, monthly: settings.monthly_limit_cents, spend: this.monthSpend(order.id) });
    return { idempotencyKey: order.idempotency_key ?? order.id, amountCents: order.total_cents, sku: order.sku,
      description: `Qizai food ${order.sku}`, approvalSnapshot: snapshot, policyHash,
      authorizationId: approved?.id ?? `automatic:${this.auth().last_verified_at ?? "legacy"}` };
  }

  private async lookupPayment(key: string): Promise<PaymentLookup> {
    return this.options.payments.lookup ? this.options.payments.lookup(key) : { status: await this.options.payments.query(key) };
  }

  private confirmRecoveredPayment(order: OrderRow, found: PaymentLookup, expectedAttemptId?: string) {
    this.db.exec("SAVEPOINT recovered_payment_result");
    try {
      if (found.paidAt && Number.isFinite(Date.parse(found.paidAt))) {
        this.db.run("UPDATE orders SET paid_at = COALESCE(paid_at, ?) WHERE id = ?", [new Date(found.paidAt).toISOString(), order.id]);
      }
      this.setOrder(order.id, "ordered", "paid", found.paymentId ?? order.payment_id, found.captureId ?? null, expectedAttemptId);
      this.db.exec("RELEASE recovered_payment_result");
    } catch (error) { this.db.exec("ROLLBACK TO recovered_payment_result; RELEASE recovered_payment_result"); throw error; }
  }

  webhook(input: { eventId: string; orderId: string; outcome: "paid" | "failed" }) {
    const seen = this.db.get<{ event_id: string }>("SELECT event_id FROM webhook_events WHERE event_id = ?", [input.eventId]);
    if (seen) return { duplicate: true, order: orderView(this.order(input.orderId)) };
    this.db.run("INSERT INTO webhook_events (event_id, received_at) VALUES (?, ?)", [input.eventId, this.clock().toISOString()]);
    const order = this.order(input.orderId);
    if (order.payment_status !== "paid") {
      if (input.outcome === "paid") this.setOrder(order.id, "ordered", "paid", order.payment_id);
      else this.setOrder(order.id, "failed", "failed", order.payment_id);
    }
    return { duplicate: false, order: orderView(this.order(input.orderId)) };
  }

  listActivity() {
    return this.db.all("SELECT id, at, kind, summary, before_json, after_json FROM activities ORDER BY at DESC, rowid DESC");
  }

  /** Place the replenishment now, as if its planned reorder time had already arrived. */
  async reorderNow() {
    if (this.settings().autopilot === "paused") throw new Error("Autopilot is paused. No new order was created.");
    const dueAt = new Date(this.clock().getTime() - 1000).toISOString();
    this.db.run(
      `INSERT INTO jobs (id, type, run_at, payload_json, status) VALUES ('order:qizai', 'place_order', ?, '{}', 'pending')
       ON CONFLICT(id) DO UPDATE SET run_at = excluded.run_at, status = 'pending'`,
      [dueAt],
    );
    await this.runDueJobs();
    return this.home();
  }

  /** Clear the demo household. The saved vault file stays unless `full` is set. */
  resetDemo(full = false) {
    if (this.db.get("SELECT id FROM orders WHERE payment_status IN ('processing', 'unknown')")) {
      throw new Error("Wait for payment reconciliation before resetting the demo.");
    }
    this.notifications.resetDemo();
    const now = this.clock();
    this.db.run("DELETE FROM orders");
    this.db.run("DELETE FROM approvals");
    this.db.run("DELETE FROM webhook_events");
    this.db.run("DELETE FROM idempotency");
    this.db.run("DELETE FROM feeding_events");
    this.db.run("DELETE FROM revisions");
    this.db.run("DELETE FROM activities");
    this.db.run(
      "UPDATE food_plans SET sku = ?, meals_per_day = 2, grams_per_meal = 75, stock_baseline_grams = 75, stock_g = 1200, calibrated_at = ? WHERE pet_id = ?",
      [this.sku, now.toISOString(), PET_ID],
    );
    const vaultKept = !full && this.vaultSummary().connected;
    this.db.run(
      "UPDATE payment_auth SET connected = ?, automatic_payment_authorized = 0, status = ?, last_verified_at = NULL WHERE id = 'paypal'",
      [vaultKept ? 1 : 0, vaultKept ? "connected" : "disconnected"],
    );
    const forecast = forecastMeals({
      stockG: 1200,
      gramsPerMeal: 75,
      mealMinutes: QIZAI_MEAL_MINUTES,
      timeZone: this.timeZone,
      asOf: now,
      events: [],
      shippingHours: this.shippingHours,
      bufferHours: this.bufferHours,
    });
    const headline = `Qizai has ${phraseAboutDays(forecast.daysOfFood)} of food left.`;
    const reason = homeReorderReason(formatOrderDate(forecast.candidateOrderAt, this.timeZone));
    this.db.run(
      `UPDATE replenishment_plans SET predicted_runout_at=?, planned_order_at=?, candidate_order_at=?, estimated_delivery_at=?,
        delta_hours=0, plan_changed=0, risk_override=0, decision_code='scheduled', headline=?, reason=?, version=1, shipping_hours=?, buffer_hours=?
       WHERE pet_id=?`,
      [
        forecast.predictedRunoutAt.toISOString(),
        forecast.candidateOrderAt.toISOString(),
        forecast.candidateOrderAt.toISOString(),
        forecast.estimatedDeliveryAt.toISOString(),
        headline,
        reason,
        this.shippingHours,
        this.bufferHours,
        PET_ID,
      ],
    );
    this.db.run(
      "UPDATE settings SET autopilot = 'active', autopilot_resume_at = NULL, surface_headline = ?, surface_reason = ?, surface_code = 'scheduled' WHERE id = 'household'",
      [headline, reason],
    );
    this.upsertJob(forecast.candidateOrderAt.toISOString());
    if (full) this.options.vault?.clear?.();
    return this.home();
  }

  async runDueJobs() {
    for (const order of this.db.all<OrderRow>("SELECT * FROM orders WHERE payment_status = 'unknown'")) {
      await this.reconcile(order).catch(() => undefined);
    }
    const settings = this.settings();
    if (settings.autopilot === "paused" && settings.autopilot_resume_at && settings.autopilot_resume_at <= this.clock().toISOString()) this.resumeBuying(settings.autopilot_resume_at);
    if (this.settings().autopilot === "paused") return [];
    const due = this.db.all<{ id: string; run_at: string }>(
      "SELECT id, run_at FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at",
      [this.clock().toISOString()],
    );
    const placed = [];
    for (const job of due) {
      if (this.openOrder()) break;
      const created = await this.createOrder({});
      this.db.run("UPDATE jobs SET status = 'done' WHERE id = ? AND run_at = ?", [job.id, job.run_at]);
      placed.push(created);
    }
    return placed;
  }

  private execute(command: ChatCommand) {
    if (command.type === "clarify") {
      return { command, headline: "I need a bit more detail.", reason: command.question, decision: null };
    }
    if (command.type === "plan_query") {
      const plan = this.plan();
      return { command, headline: plan.headline, reason: plan.reason, decision: this.planView(plan) };
    }
    if (command.type === "undo") return this.restore();
    if (command.type === "pause_orders") {
      return this.pauseUntil(command.until);
    }
    this.pushRevision();
    if (command.type === "feeding_permanent") {
      this.db.run("UPDATE food_plans SET grams_per_meal = ? WHERE pet_id = ?", [command.gramsPerMeal, PET_ID]);
      this.insertEvent({ type: "permanent", grams: command.gramsPerMeal, effectiveAt: this.clock().toISOString() });
      return { command, ...this.recompute("permanent") };
    }
    if (command.type === "skip_meal") {
      this.insertEvent({ type: "temporary", grams: 0, mealIndex: mealIndex(command.meal), localDate: command.localDate });
      const change = command.meal === "dinner" && command.localDate === addLocalDays(instantLocalDate(this.clock(), this.timeZone), 1)
        ? "skip_dinner_tomorrow"
        : "other";
      return { command, ...this.recompute(change) };
    }
    if (command.type === "temporary_meal") {
      this.insertEvent({
        type: "temporary",
        grams: command.grams,
        mealIndex: mealIndex(command.meal),
        localDate: command.localDate,
      });
      return { command, ...this.recompute("other") };
    }
    if (command.type !== "actual_intake") {
      const leftover: never = command;
      throw new Error(`Unhandled command ${(leftover as { type: string }).type}`);
    }
    this.insertEvent({
      type: "actual",
      grams: command.grams,
      mealIndex: mealIndex(command.meal),
      localDate: command.localDate,
    });
    return { command, ...this.recompute("other") };
  }

  private recompute(change: "permanent" | "skip_dinner_tomorrow" | "other", newCycle = false, resumeSummary?: string) {
    const food = this.food();
    const previous = this.plan();
    const forecast = forecastMeals({
      stockG: this.remainingStock(food),
      gramsPerMeal: food.grams_per_meal,
      mealMinutes: JSON.parse(food.meal_minutes_json) as number[],
      timeZone: this.timeZone,
      asOf: this.clock(),
      events: this.activeEvents(),
      shippingHours: previous.shipping_hours,
      bufferHours: previous.buffer_hours,
    });
    const locked = this.orderLocked();
    const decision = decideReplan({
      petName: "Qizai",
      timeZone: this.timeZone,
      previousPlannedOrderAt: new Date(previous.planned_order_at),
      forecast,
      shippingHours: previous.shipping_hours,
      bufferHours: previous.buffer_hours,
      orderLocked: locked,
      newCycle,
      change,
    });
    if (newCycle) {
      decision.headline = "Qizai's food is restocked.";
      decision.reason = `Receipt confirmed. ${homeReorderReason(decision.orderDate)}`;
    } else if (locked && this.openOrder()?.payment_status !== "paid") {
      decision.headline = "Qizai's order is being processed.";
      decision.reason = "I'll keep its order date while I update the food estimate.";
    }
    if (resumeSummary) {
      decision.headline = "Automatic buying resumed.";
      decision.reason = "I checked the current stock and feeding plan. New orders still require payment authorization and must meet your budget rules, or wait for approval.";
    }
    this.savePlan(decision, previous);
    this.db.run("UPDATE settings SET surface_headline = ?, surface_reason = ?, surface_code = ? WHERE id = 'household'", [
      decision.headline,
      decision.reason,
      decision.code,
    ]);
    this.upsertJob(decision.plannedOrderAt);
    this.recordActivity(resumeSummary ? "autopilot" : "feeding", resumeSummary ?? decision.headline, previous.planned_order_at, decision.plannedOrderAt);
    return { headline: decision.headline, reason: decision.reason, decision };
  }

  private restore() {
    const revision = this.db.get<{ id: number; snapshot_json: string }>(
      "SELECT id, snapshot_json FROM revisions ORDER BY id DESC LIMIT 1",
    );
    if (!revision) throw new Error("Nothing to undo.");
    const snapshot = JSON.parse(revision.snapshot_json) as {
      grams: number;
      stock: number;
      calibratedAt?: string;
      stockBaselineGrams?: number;
      events: FeedingEvent[];
      plan: PlanRow;
      surface: { headline: string | null; reason: string | null; code: string | null };
    };
    const food = this.food();
    this.db.run("UPDATE food_plans SET grams_per_meal = ?, stock_g = ?, calibrated_at = ?, stock_baseline_grams = ? WHERE pet_id = ?", [
      snapshot.grams, snapshot.stock, snapshot.calibratedAt ?? food.calibrated_at, snapshot.stockBaselineGrams ?? food.stock_baseline_grams, PET_ID,
    ]);
    this.db.run("DELETE FROM feeding_events WHERE pet_id = ?", [PET_ID]);
    for (const event of snapshot.events) this.insertEvent(event);
    const plan = this.orderLocked() ? this.plan() : snapshot.plan;
    this.db.run(
      `UPDATE replenishment_plans SET predicted_runout_at=?, planned_order_at=?, candidate_order_at=?, estimated_delivery_at=?,
       delta_hours=?, plan_changed=?, risk_override=?, decision_code=?, headline=?, reason=?, version=? WHERE pet_id=?`,
      [
        plan.predicted_runout_at,
        plan.planned_order_at,
        plan.candidate_order_at,
        plan.estimated_delivery_at,
        plan.delta_hours,
        plan.plan_changed,
        plan.risk_override,
        plan.decision_code,
        plan.headline,
        plan.reason,
        plan.version,
        PET_ID,
      ],
    );
    this.db.run("UPDATE settings SET surface_headline=?, surface_reason=?, surface_code=? WHERE id='household'", [
      snapshot.surface.headline,
      snapshot.surface.reason,
      snapshot.surface.code,
    ]);
    this.db.run("DELETE FROM revisions WHERE id = ?", [revision.id]);
    this.upsertJob(plan.planned_order_at);
    this.recordActivity("undo", "Restored the previous feeding plan.");
    return {
      command: { type: "undo" } as const,
      headline: "Restored the previous feeding plan.",
      reason: "The last feeding change was undone and the reorder timing was restored with it.",
      decision: this.planView(this.plan()),
    };
  }

  private async pay(order: OrderRow): Promise<OrderRow> {
    const key = order.idempotency_key ?? order.id;
    let preparedAttemptId: string | undefined;
    let input: Parameters<PaymentGateway["charge"]>[0] | undefined;
    // SQLite claims the attempt before the first await. Separate requests and
    // separate processes must both observe the persisted processing state.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.run(
      `UPDATE orders SET status = 'preparing', payment_status = 'processing', updated_at = ?
       WHERE id = ? AND status IN ('awaiting_approval', 'failed', 'preparing') AND payment_status IN ('none', 'failed')
        AND total_cents = ? AND sku = ? AND merchant = ? AND currency = ? AND quantity_grams IS ?`,
      [this.clock().toISOString(), order.id, order.total_cents, order.sku, order.merchant, order.currency, order.quantity_grams],
    );
      if (!this.db.get<{ claimed: number }>("SELECT changes() AS claimed")?.claimed) { this.db.exec("COMMIT"); return this.order(order.id); }
      if (this.options.payments.prepare) {
        input = this.paymentInput(order);
        preparedAttemptId = this.options.payments.prepare(input);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof PaymentUnknownError) { this.setOrder(order.id, "reconciling", "unknown", order.payment_id); return this.order(order.id); }
      throw error;
    }
    let charging = false, remoteReportedPaid = false;
    try {
      const prior = preparedAttemptId ? { status: "not_found" as const } : await this.lookupPayment(key);
      if (prior.status === "unknown") {
        this.setOrder(order.id, "reconciling", "unknown", order.payment_id);
        return this.order(order.id);
      }
      if (prior.status === "paid") {
        this.confirmRecoveredPayment(order, prior);
        return this.order(order.id);
      }
      charging = true;
      const beforeWrite = () => {
        const current = this.order(order.id);
        if (current.payment_status !== "processing" || current.status !== "preparing" || this.settings().autopilot !== "active" ||
          this.db.get("SELECT id FROM orders WHERE id<>? AND status IN ('awaiting_approval','preparing','reconciling','ordered','shipped')", [order.id]) ||
          approvalSnapshot(current) !== approvalSnapshot(order) || (input && (!this.vaultSummary().connected ||
          JSON.stringify(this.paymentInput(current)) !== JSON.stringify(input) || this.options.payments.recoveryInfo?.(key)?.attemptId !== preparedAttemptId))) {
          throw new OperationRejected("Payment authorization changed while preparing. Review the order, budget and pause state.");
        }
      };
      beforeWrite();
      const result = await this.options.payments.charge(input ? { ...input, preparedAttemptId } : {
        idempotencyKey: key,
        amountCents: order.total_cents,
        sku: order.sku,
        description: `Qizai food ${order.sku}`,
      }, beforeWrite);
      const capture = result.captureId?.trim() || null;
      remoteReportedPaid = true;
      if (preparedAttemptId && result.attemptId !== preparedAttemptId) throw new PaymentUnknownError("The payment result belongs to another attempt.", key);
      this.setOrder(order.id, "ordered", "paid", result.paymentId, capture, preparedAttemptId);
      this.recordActivity("payment", "Payment confirmed for the food order.");
    } catch (error) {
      if (this.order(order.id).payment_status === "paid") return this.order(order.id);
      if (preparedAttemptId && this.options.payments.recoveryInfo?.(key)?.attemptId !== preparedAttemptId) return this.order(order.id);
      if (!charging || remoteReportedPaid || isUncertainPayment(error)) {
        this.setOrder(order.id, "reconciling", "unknown", order.payment_id, paymentFailureNote(error), preparedAttemptId);
        this.recordActivity("payment", "Payment result needs verification. Further payment attempts are on hold.");
      } else {
        this.setOrder(order.id, "failed", "failed", order.payment_id, paymentFailureNote(error), preparedAttemptId);
        this.recordActivity("payment", `Payment failed. ${paymentFailureNote(error)}`);
      }
    }
    return this.order(order.id);
  }

  private seed() {
    const now = this.clock();
    const forecast = forecastMeals({
      stockG: 1200,
      gramsPerMeal: 75,
      mealMinutes: QIZAI_MEAL_MINUTES,
      timeZone: this.timeZone,
      asOf: now,
      events: [],
      shippingHours: this.shippingHours,
      bufferHours: this.bufferHours,
    });
    const headline = `Qizai has ${phraseAboutDays(forecast.daysOfFood)} of food left.`;
    const reason = homeReorderReason(formatOrderDate(forecast.candidateOrderAt, this.timeZone));
    this.db.run("INSERT INTO pets (id, name, avatar_url, timezone) VALUES (?, 'Qizai', NULL, ?)", [PET_ID, this.timeZone]);
    this.db.run(
      `INSERT INTO food_plans (pet_id, sku, meals_per_day, grams_per_meal, meal_minutes_json, stock_g, calibrated_at)
       VALUES (?, ?, 2, 75, ?, 1200, ?)`,
      [PET_ID, this.sku, JSON.stringify(QIZAI_MEAL_MINUTES), now.toISOString()],
    );
    this.db.run(
      `INSERT INTO replenishment_plans (pet_id, predicted_runout_at, planned_order_at, candidate_order_at, estimated_delivery_at,
        delta_hours, plan_changed, risk_override, decision_code, headline, reason, version, shipping_hours, buffer_hours)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'scheduled', ?, ?, 1, ?, ?)`,
      [
        PET_ID,
        forecast.predictedRunoutAt.toISOString(),
        forecast.candidateOrderAt.toISOString(),
        forecast.candidateOrderAt.toISOString(),
        forecast.estimatedDeliveryAt.toISOString(),
        headline,
        reason,
        this.shippingHours,
        this.bufferHours,
      ],
    );
    this.db.run(
      `INSERT INTO settings (id, autopilot, currency, per_order_limit_cents, monthly_limit_cents, surface_headline, surface_reason, surface_code)
       VALUES ('household', 'active', 'USD', 5000, 12000, ?, ?, 'scheduled')`,
      [headline, reason],
    );
    this.db.run(
      `INSERT INTO payment_auth (id, provider, connected, automatic_payment_authorized, environment, status, last_verified_at)
       VALUES ('paypal', 'paypal', 0, 0, 'sandbox', 'disconnected', NULL)`,
    );
    this.upsertJob(forecast.candidateOrderAt.toISOString());
  }

  private savePlan(decision: PlanDecision, previous: PlanRow) {
    this.db.run(
      `UPDATE replenishment_plans SET predicted_runout_at=?, planned_order_at=?, candidate_order_at=?, estimated_delivery_at=?,
        delta_hours=?, plan_changed=?, risk_override=?, decision_code=?, headline=?, reason=?, version=? WHERE pet_id=?`,
      [
        decision.predictedRunoutAt,
        decision.plannedOrderAt,
        decision.candidateOrderAt,
        decision.estimatedDeliveryAt,
        decision.deltaHours,
        decision.planChanged ? 1 : 0,
        decision.riskOverride ? 1 : 0,
        decision.code,
        decision.headline,
        decision.reason,
        previous.version + 1,
        PET_ID,
      ],
    );
  }

  private pushRevision() {
    const food = this.food();
    const settings = this.settings();
    const snapshot = {
      grams: food.grams_per_meal,
      stock: food.stock_g,
      calibratedAt: food.calibrated_at,
      stockBaselineGrams: food.stock_baseline_grams,
      events: this.events(),
      plan: this.plan(),
      surface: { headline: settings.surface_headline, reason: settings.surface_reason, code: settings.surface_code },
    };
    this.db.run("INSERT INTO revisions (snapshot_json, created_at) VALUES (?, ?)", [
      JSON.stringify(snapshot),
      this.clock().toISOString(),
    ]);
  }

  private insertEvent(event: Partial<FeedingEvent> & { type: FeedingEvent["type"]; grams: number }) {
    this.db.run(
      `INSERT INTO feeding_events (id, pet_id, type, meal_index, local_date, grams, effective_at, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id ?? createId("fed"),
        PET_ID,
        event.type,
        event.mealIndex ?? null,
        event.localDate ?? null,
        event.grams,
        event.effectiveAt ?? null,
        event.source ?? "chat",
        event.createdAt ?? this.clock().toISOString(),
      ],
    );
  }

  private activeEvents(): FeedingEvent[] {
    return this.events().filter((event) => event.type !== "permanent");
  }

  private events(): FeedingEvent[] {
    return this.db
      .all<{
        id: string;
        type: FeedingEvent["type"];
        meal_index: number | null;
        local_date: string | null;
        grams: number;
        effective_at: string | null;
        source: FeedingEvent["source"];
        created_at: string;
      }>("SELECT * FROM feeding_events WHERE pet_id = ? ORDER BY created_at, rowid", [PET_ID])
      .map((row) => ({
        id: row.id,
        type: row.type,
        grams: row.grams,
        source: row.source,
        createdAt: row.created_at,
        ...(row.meal_index === null ? {} : { mealIndex: row.meal_index }),
        ...(row.local_date ? { localDate: row.local_date } : {}),
        ...(row.effective_at ? { effectiveAt: row.effective_at } : {}),
      }));
  }

  private orderLocked(): boolean {
    const row = this.db.get<{ id: string }>(
      "SELECT id FROM orders WHERE pet_id = ? AND payment_status IN ('paid', 'processing', 'unknown') AND status IN ('ordered', 'preparing', 'shipped', 'reconciling')",
      [PET_ID],
    );
    return Boolean(row);
  }

  private violationsFor(totalCents: number, excludeOrderId?: string) {
    const spend = this.monthSpend(excludeOrderId);
    const settings = this.settings();
    return evaluateOrderBudget({
      orderCents: totalCents,
      perOrderLimitCents: settings.per_order_limit_cents,
      monthlyLimitCents: settings.monthly_limit_cents,
      settledCents: spend.settled,
      committedCents: spend.committed,
    });
  }

  private monthSpend(excludeOrderId?: string) {
    const month = instantLocalDate(this.clock(), this.timeZone).slice(0, 7);
    const rows = this.db.all<OrderRow>("SELECT * FROM orders WHERE pet_id = ?", [PET_ID]);
    let settled = 0;
    let committed = 0;
    for (const order of rows) {
      if (excludeOrderId && order.id === excludeOrderId) continue;
      if (order.payment_status === "paid") {
        if (instantLocalDate(new Date(order.paid_at ?? order.created_at), this.timeZone).startsWith(month)) settled += order.total_cents;
      }
      else if (order.status === "awaiting_approval" || order.status === "preparing" || order.status === "reconciling") {
        // Unsettled commitments carry across months: creation time does not tell
        // us when a pending or uncertain payment will settle. Release only on a
        // definitive outcome; paid amounts belong to their actual payment month.
        committed += order.total_cents;
      }
    }
    return { settled, committed };
  }

  private cached<T>(key: string | undefined): T | undefined {
    if (!key) return undefined;
    const row = this.db.get<{ response_json: string }>("SELECT response_json FROM idempotency WHERE key = ?", [key]);
    return row ? (JSON.parse(row.response_json) as T) : undefined;
  }

  private storeIdempotent<T>(key: string | undefined, body: T): T {
    if (key) {
      this.db.run("INSERT OR IGNORE INTO idempotency (key, response_json, created_at) VALUES (?, ?, ?)", [
        key,
        JSON.stringify(body),
        this.clock().toISOString(),
      ]);
    }
    return body;
  }

  private voidApproval(orderId: string) {
    this.db.run("UPDATE approvals SET status = 'void' WHERE order_id = ? AND status = 'approved'", [orderId]);
  }

  private voidApprovalsIfPriceDrifted() {
    // Budget edits do not rewrite paid orders. Open approvals are re-checked on the next approve call.
  }

  private setOrder(id: string, status: string, paymentStatus: string, paymentId: string | null, note?: string | null, expectedAttemptId?: string) {
    this.db.exec("SAVEPOINT order_payment_result");
    try {
      const current = this.order(id);
      if (expectedAttemptId !== undefined && this.options.payments.recoveryInfo?.(current.idempotency_key ?? id)?.attemptId !== expectedAttemptId) {
        throw new PaymentUnknownError("The order now belongs to another payment attempt.", current.idempotency_key ?? id);
      }
      if (current.payment_status === "paid" && paymentStatus !== "paid") { this.db.exec("RELEASE order_payment_result"); return; }
      if (paymentStatus === "paid" || paymentStatus === "failed") this.options.payments.finalize?.(this.order(id).idempotency_key ?? id, paymentStatus, expectedAttemptId);
    if (paymentStatus === "paid") {
      this.db.run("UPDATE orders SET paid_at = COALESCE(paid_at, ?) WHERE id = ?", [this.clock().toISOString(), id]);
    }
    if (note === undefined) {
      this.db.run("UPDATE orders SET status = ?, payment_status = ?, payment_id = ?, updated_at = ? WHERE id = ?", [
        status,
        paymentStatus,
        paymentId,
        this.clock().toISOString(),
        id,
      ]);
      this.db.exec("RELEASE order_payment_result"); return;
    }
    this.db.run(
      "UPDATE orders SET status = ?, payment_status = ?, payment_id = ?, payment_note = ?, updated_at = ? WHERE id = ?",
      [status, paymentStatus, paymentId, note, this.clock().toISOString(), id],
    );
      this.db.exec("RELEASE order_payment_result");
    } catch (error) { this.db.exec("ROLLBACK TO order_payment_result; RELEASE order_payment_result"); throw error; }
  }

  private upsertJob(runAt: string) {
    this.db.run(
      `INSERT INTO jobs (id, type, run_at, payload_json, status) VALUES ('order:qizai', 'place_order', ?, '{}', 'pending')
       ON CONFLICT(id) DO UPDATE SET run_at = excluded.run_at, status = 'pending'`,
      [runAt],
    );
  }

  private recordActivity(kind: string, summary: string, before?: string, after?: string) {
    this.db.run("INSERT INTO activities (id, at, kind, summary, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)", [
      createId("act"),
      this.clock().toISOString(),
      kind,
      summary,
      before ?? null,
      after ?? null,
    ]);
  }

  private priority(settings: SettingsRow, pending: OrderRow | undefined, active: OrderRow | undefined) {
    if (pending) {
      return {
        state: "awaiting_approval",
        headline: "Qizai's next order needs your approval.",
        reason: this.pendingReason(pending),
      };
    }
    if (active?.status === "reconciling" || active?.payment_status === "unknown") {
      return {
        state: "reconciling",
        headline: "I'm checking whether Qizai's payment went through.",
        reason: "The payment result is unknown, so I will look it up before trying again.",
      };
    }
    if (active?.status === "failed") {
      return {
        state: "failed",
        headline: "I couldn't complete Qizai's order.",
        reason: active.payment_note?.trim() || "I'll show what failed and what needs your action.",
      };
    }
    if (active?.status === "preparing") {
      return {
        state: "preparing",
        headline: "I'm preparing Qizai's next order.",
        reason: "I'm checking the same food, price and budget.",
      };
    }
    if (active?.status === "ordered" || active?.status === "shipped") {
      return {
        state: "ordered",
        headline: "Qizai's food is on the way.",
        reason: paidReason(active.payment_note),
      };
    }
    return {
      state: settings.surface_code && settings.surface_code !== "scheduled" ? settings.surface_code : "scheduled",
      headline: this.daysLeftHeadline(),
      reason: homeReorderReason(formatOrderDate(new Date(this.plan().planned_order_at), this.timeZone)),
    };
  }

  private chatNotice(settings: SettingsRow): { headline: string; reason: string } | null {
    if (settings.autopilot === "paused") return { headline: "Automatic buying is paused.", reason: this.pauseReason(settings) };
    if (!settings.surface_code || settings.surface_code === "scheduled" || !settings.surface_headline) return null;
    return { headline: settings.surface_headline, reason: settings.surface_reason ?? "" };
  }

  private vaultSummary(): { connected: boolean; last4: string | null } {
    return this.options.vault?.summary?.() ?? { connected: this.options.vault?.hasPaymentToken() ?? false, last4: null };
  }

  private paypalView(auth: AuthRow) {
    const vault = this.vaultSummary();
    return {
      connected: vault.connected,
      automaticPaymentAuthorized: Boolean(auth.automatic_payment_authorized) && vault.connected,
      status: vault.connected ? (auth.automatic_payment_authorized ? "enabled" : "connected") : "disconnected",
      environment: auth.environment,
      last4: vault.last4,
    };
  }

  private paymentView(order: OrderRow | undefined) {
    if (!order || order.payment_status !== "paid") return null;
    return {
      paypalOrderId: order.payment_id,
      captureId: storedCaptureId(order.payment_note),
    };
  }

  private daysLeftHeadline(): string {
    const food = this.food();
    const plan = this.plan();
    const forecast = forecastMeals({
      stockG: this.remainingStock(food),
      gramsPerMeal: food.grams_per_meal,
      mealMinutes: JSON.parse(food.meal_minutes_json) as number[],
      timeZone: this.timeZone,
      asOf: this.clock(),
      events: this.activeEvents(),
      shippingHours: plan.shipping_hours,
      bufferHours: plan.buffer_hours,
    });
    return `Qizai has ${phraseAboutDays(forecast.daysOfFood)} of food left.`;
  }

  private remainingStock(food = this.food()): number {
    return estimateMealStock({
      stockG: food.stock_g,
      calibratedAt: new Date(food.calibrated_at),
      baselineGramsPerMeal: food.stock_baseline_grams,
      mealMinutes: JSON.parse(food.meal_minutes_json) as number[],
      timeZone: this.timeZone,
      asOf: this.clock(),
      events: this.events(),
    });
  }

  private assertEditableOrder(order: OrderRow): void {
    if (!["awaiting_approval", "failed"].includes(order.status) || ["paid", "processing", "unknown"].includes(order.payment_status)) {
      throw new Error("This order cannot be changed while paid, processing or awaiting reconciliation.");
    }
  }

  private pendingReason(order: OrderRow): string {
    const gate = this.violationsFor(order.total_cents, order.id);
    const perOrder = gate.violations.find((item) => item.code === "per_order");
    const monthly = gate.violations.find((item) => item.code === "monthly");
    if (perOrder) {
      const dollars = (perOrder.limitCents / 100).toFixed(perOrder.limitCents % 100 === 0 ? 0 : 2);
      const monthlyNote = monthly ? ` ${monthly.message}` : "";
      return `It exceeds the $${dollars} per-order limit.${monthlyNote}`;
    }
    if (monthly) return monthly.message;
    if (!this.auth().automatic_payment_authorized || !this.vaultSummary().connected) {
      return "Automatic PayPal payment is not authorized yet, so this order needs your approval.";
    }
    return "This order needs your approval before I can pay.";
  }

  private dateGrid(plan: PlanRow) {
    const start = instantLocalDate(this.clock(), this.timeZone);
    const markers = new Map<string, string[]>();
    const add = (date: string, marker: string) => {
      const list = markers.get(date) ?? [];
      if (!list.includes(marker)) list.push(marker);
      markers.set(date, list);
    };
    add(instantLocalDate(new Date(plan.planned_order_at), this.timeZone), "order");
    add(instantLocalDate(new Date(plan.estimated_delivery_at), this.timeZone), "delivery");
    add(instantLocalDate(new Date(plan.predicted_runout_at), this.timeZone), "runout");
    for (const event of this.activeEvents()) {
      if (event.type === "temporary" && event.grams === 0 && event.localDate) add(event.localDate, "skip");
    }
    return Array.from({ length: 10 }, (_, index) => {
      const date = addLocalDays(start, index);
      return { date, markers: markers.get(date) ?? [], complete: false };
    });
  }

  private planView(plan: PlanRow) {
    return {
      predictedRunoutAt: plan.predicted_runout_at,
      plannedOrderAt: plan.planned_order_at,
      candidateOrderAt: plan.candidate_order_at,
      estimatedDeliveryAt: plan.estimated_delivery_at,
      deltaHours: plan.delta_hours,
      planChanged: Boolean(plan.plan_changed),
      riskOverride: Boolean(plan.risk_override),
      code: plan.decision_code,
      headline: plan.headline,
      reason: plan.reason,
      orderDate: formatOrderDate(new Date(plan.planned_order_at), this.timeZone),
      orderDateRaw: plan.planned_order_at,
      version: plan.version,
      shippingHours: plan.shipping_hours,
      bufferHours: plan.buffer_hours,
    };
  }

  private pet() {
    const row = this.db.get<{ id: string; name: string; avatar_url: string | null; timezone: string }>(
      "SELECT * FROM pets WHERE id = ?",
      [PET_ID],
    );
    if (!row) throw new Error("Qizai is not seeded");
    return row;
  }

  private food(): FoodRow {
    const row = this.db.get<FoodRow>("SELECT * FROM food_plans WHERE pet_id = ?", [PET_ID]);
    if (!row) throw new Error("Missing food plan");
    return row;
  }

  private plan(): PlanRow {
    const row = this.db.get<PlanRow>("SELECT * FROM replenishment_plans WHERE pet_id = ?", [PET_ID]);
    if (!row) throw new Error("Missing replenishment plan");
    return row;
  }

  private settings(): SettingsRow {
    const row = this.db.get<SettingsRow>("SELECT * FROM settings WHERE id = 'household'");
    if (!row) throw new Error("Missing settings");
    return row;
  }

  private auth(): AuthRow {
    const row = this.db.get<AuthRow>("SELECT * FROM payment_auth WHERE id = 'paypal'");
    if (!row) throw new Error("Missing PayPal auth");
    return row;
  }

  private order(id: string): OrderRow {
    const row = this.db.get<OrderRow>("SELECT * FROM orders WHERE id = ?", [id]);
    if (!row) throw new Error(`No order ${id}`);
    return row;
  }

  private openOrder(status?: string): OrderRow | undefined {
    if (status) return this.db.get<OrderRow>("SELECT * FROM orders WHERE pet_id = ? AND status = ? ORDER BY created_at DESC", [PET_ID, status]);
    return this.db.get<OrderRow>(
      "SELECT * FROM orders WHERE pet_id = ? AND status IN ('awaiting_approval', 'failed', 'preparing', 'reconciling', 'ordered', 'shipped') ORDER BY created_at DESC",
      [PET_ID],
    );
  }
}

/** A comparison token, not payment authorization. Echo the token from the viewed order. */
function approvalSnapshot(order: OrderRow): string {
  return createHash("sha256").update(JSON.stringify([
    "approval-v1", order.id, order.sku, order.merchant, order.currency, order.total_cents, order.quantity_grams,
  ])).digest("hex");
}

function orderView(order: OrderRow) {
  const paid = order.payment_status === "paid";
  return {
    id: order.id,
    sku: order.sku,
    merchant: order.merchant,
    totalCents: order.total_cents,
    currency: order.currency,
    status: order.status,
    paymentStatus: order.payment_status,
    paymentId: order.payment_id,
    paypalOrderId: order.payment_id,
    captureId: paid ? storedCaptureId(order.payment_note) : null,
    receivedAt: order.received_at,
    idempotencyKey: order.idempotency_key,
    createdAt: order.created_at,
  };
}

export function storedCaptureId(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  if (!trimmed) return null;
  const marked = trimmed.match(/capture\s+(\S+)\s*$/i);
  return marked?.[1] ?? trimmed;
}

export function paidReason(note: string | null | undefined): string {
  const id = storedCaptureId(note);
  if (!id) return "The test-store order is confirmed; delivery is estimated.";
  return `Paid with PayPal · …${id.slice(-6)}`;
}

function productCopy(sku: string): { productName: string; productDetail: string } {
  if (sku === "RC-SMALL-8") {
    return { productName: "Taste of the Wild", productDetail: "Pacific Stream Small Breed · 8 kg" };
  }
  const product = SEED_PRODUCTS.find((item) => item.sku === sku);
  if (!product) return { productName: sku, productDetail: "" };
  const variety = product.name.replace(product.brand, "").trim() || product.name;
  return { productName: product.brand, productDetail: `${variety} · ${product.unitSize} ${product.unit}` };
}

/** API server default. Tests that construct HouseholdApp directly keep RC-SMALL-4 unless they pass a sku. */
export function resolvePreferredProduct(env: NodeJS.ProcessEnv): { sku: string; priceCents: number } {
  const sku = env.PREFERRED_SKU?.trim() || "RC-SMALL-8";
  const product = SEED_PRODUCTS.find((item) => item.sku === sku);
  if (!product) throw new Error(`PREFERRED_SKU ${sku} is not in the store catalog.`);
  return { sku: product.sku, priceCents: product.priceCents };
}

function paymentFailureNote(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { name?: unknown; issue?: unknown; debugId?: unknown; message?: unknown };
    const label = typeof record.issue === "string" && record.issue ? record.issue : typeof record.name === "string" ? record.name : "PayPal error";
    const debugId = typeof record.debugId === "string" ? record.debugId : null;
    if (debugId || record.issue) return debugId ? `${label} · debug_id ${debugId}` : label;
  }
  return error instanceof Error ? error.message : "Payment failed";
}

function phraseAboutDays(days: number): string {
  const rounded = Math.max(0, Math.round(Number.isFinite(days) ? days : 0));
  return rounded === 1 ? "about 1 day" : `about ${rounded} days`;
}

function roundDaysLeftCopy(text: string): string {
  return text.replace(/\babout\s+(-?\d+(?:\.\d+)?)\s+days?\b/gi, (_match, raw: string) => phraseAboutDays(Number(raw)));
}

function isUncertainPayment(error: unknown): boolean {
  if (error instanceof PaymentUnknownError) return true;
  if (error && typeof error === "object" && "httpStatus" in error && Number(error.httpStatus) >= 500) return true;
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || /timeout|network|ECONNRESET|fetch failed|socket/i.test(error.message));
}

export interface ChatTurn {
  receipt?: {
    operationId: string | null; at: string; outcome: "applied" | "answered" | "needs_clarification";
    undoRevisionId: number | null;
    feeding: null | { before: { gramsPerMeal: number; dailyGrams: number }; after: { gramsPerMeal: number; dailyGrams: number } };
    plan: null | { beforeAt: string; afterAt: string; changed: boolean };
  };
  command: ChatCommand;
  headline: string;
  reason: string;
  decision: {
    orderDate: string;
    orderDateRaw: string;
    planChanged: boolean;
    headline: string;
    reason: string;
  } | null;
}

export type { BudgetViolation };
