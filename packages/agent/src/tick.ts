import { createHash, randomUUID } from "node:crypto";
import {
  addDays,
  assertIsoDate,
  createId,
  estimateRemaining,
  monthLabel,
  predictRunOut,
  todayIso,
  type HouseholdRepository,
  type HouseholdState,
  type IsoDate,
  type PetProfile,
  type Replenishment,
  type TrackedSupply,
  type UsageAdjustment,
} from "@replenish/domain";
import { gramsFromProduct, type StoreService } from "@replenish/store";
import { evaluateBudget, totalsForDate, type BudgetDecision } from "./budget";
import type { ChargeResult, PaymentProvider, PayPalChargeDetails } from "./payments";
import { planPurchase } from "./purchase";

export interface AgentDeps {
  household: HouseholdRepository;
  store: StoreService;
  payments: PaymentProvider;
  ids?: (prefix: string) => string;
  today?: () => IsoDate;
}

export interface ForecastSnapshot {
  sku: string;
  productName: string;
  unitSize: number;
  unit: string;
  remaining: number;
  bagSize: number;
  dailyUsage: number;
  daysLeft: number;
  runOutDate: IsoDate | null;
  thresholdDays: number;
  shippingDays: number;
  bufferDays: number;
}

export type TickEvent =
  | {
      type: "delivery";
      replenishmentId: string;
      sku: string;
      productName: string;
      unitSize: number | null;
      unit: string | null;
      openedGrams: number | null;
      leftoverGrams: number;
    }
  | { type: "hold" }
  | {
      type: "in_flight";
      replenishmentId: string;
      status: "pending_approval" | "ordered";
      expectedArrival: IsoDate | null;
      storeOrderId: string | null;
      totalCents: number;
    }
  | {
      type: "paid";
      replenishmentId: string;
      sku: string;
      productName: string;
      unitSize: number;
      unit: string;
      totalCents: number;
      paymentId: string;
      providerLabel: string;
      storeOrderId: string;
      shippingDays: number;
      expectedArrival: IsoDate;
      substituted: boolean;
      budget: BudgetDecision;
      paypal?: PayPalChargeDetails;
    }
  | {
      type: "pending_approval";
      replenishmentId: string;
      sku: string;
      productName: string;
      unitSize: number;
      unit: string;
      totalCents: number;
      shippingDays: number;
      substituted: boolean;
      budget: BudgetDecision;
    }
  | { type: "blocked"; reason: string };

export interface SupplyReport {
  supplyId: string;
  petName: string;
  breed: string;
  species: string;
  weightKg: number;
  dailyGrams: number;
  adjustments: UsageAdjustment[];
  /** Set when a delivery opened a new bag before the decision. */
  morning: ForecastSnapshot | null;
  forecast: ForecastSnapshot;
  events: TickEvent[];
}

export interface TickResult {
  date: IsoDate;
  householdName: string;
  supplies: SupplyReport[];
}

export interface DecisionResult {
  action: "approve" | "reject";
  replenishment: Replenishment;
  charge?: ChargeResult;
}

export async function tick(deps: AgentDeps, asOf?: IsoDate): Promise<TickResult> {
  const date = resolveDate(deps, asOf);
  const state = deps.household.load();
  const supplies: SupplyReport[] = [];
  for (const supply of state.supplies) {
    supplies.push(await tickSupply(deps, state, supply, date));
  }
  deps.household.save(state);
  return { date, householdName: state.householdName, supplies };
}

export async function resolveApproval(
  deps: AgentDeps,
  id: string,
  action: "approve" | "reject",
  asOf?: IsoDate,
): Promise<DecisionResult> {
  const date = resolveDate(deps, asOf);
  const state = deps.household.load();
  const record = state.replenishments.find((item) => item.id === id);
  if (!record) throw new Error(`No approval ${id}`);
  if (record.status !== "pending_approval") {
    throw new Error(`${id} is ${record.status}, not waiting for confirmation`);
  }

  if (action === "reject") {
    record.status = "rejected";
    record.decidedOn = date;
    deps.household.save(state);
    return { action, replenishment: structuredClone(record) };
  }

  assertApprovalProduct(deps.store, record);
  const approval = { authorizationId: randomUUID(), snapshot: approvalSnapshot(record), approvedOn: date };
  record.paymentApproval = approval;
  // Persist the owner's decision before any network call, including a failed payment.
  deps.household.save(state);
  const beforeWrite = () => {
    const current = deps.household.load().replenishments.find(item => item.id === id);
    if (!current || current.status !== "pending_approval" || current.paymentApproval?.authorizationId !== approval.authorizationId ||
      current.paymentApproval.snapshot !== approval.snapshot || approvalSnapshot(current) !== approval.snapshot) {
      throw new Error("The approved order changed before payment. Review it before approving again.");
    }
    assertApprovalProduct(deps.store, current);
  };
  beforeWrite();

  const payment = await deps.payments.charge({
    amountCents: record.totalCents,
    currency: record.currency,
    description: `${record.productName} (${record.sku})`,
    sku: record.sku,
    idempotencyKey: record.id,
    authorizationId: approval.authorizationId,
    approvalSnapshot: approval.snapshot,
  }, beforeWrite);
  const order = placeOrExplain(deps, record.sku, record.quantity, date, payment.paymentId);
  record.status = "ordered";
  record.decidedOn = date;
  record.orderedOn = date;
  record.paymentId = payment.paymentId;
  record.paymentProvider = deps.payments.name;
  record.storeOrderId = order.id;
  record.shippingDays = order.shippingDays;
  record.expectedArrival = addDays(date, order.shippingDays);
  deps.household.save(state);
  return { action, replenishment: structuredClone(record), charge: payment };
}

function approvalSnapshot(record: Replenishment): string {
  return createHash("sha256").update(JSON.stringify({ orderId: record.id, supplyId: record.supplyId,
    merchant: "replenish-store", sku: record.sku, productName: record.productName, quantity: record.quantity,
    totalCents: record.totalCents, currency: record.currency, shippingDays: record.shippingDays })).digest("hex");
}

function assertApprovalProduct(store: StoreService, record: Replenishment): void {
  const product = store.getProduct(record.sku);
  if (!product) throw new Error(`SKU ${record.sku} is no longer in the catalog`);
  if (product.stock < record.quantity) throw new Error(`Not enough stock for ${record.sku}`);
  if (product.priceCents * record.quantity !== record.totalCents || product.currency !== record.currency || product.name !== record.productName) {
    throw new Error("The product changed since this approval was requested. Reject it and run tick again.");
  }
}

async function tickSupply(
  deps: AgentDeps,
  state: HouseholdState,
  supply: TrackedSupply,
  date: IsoDate,
): Promise<SupplyReport> {
  const pet = state.pets.find((item) => item.id === supply.petId);
  if (!pet) throw new Error(`Supply ${supply.id} references missing pet ${supply.petId}`);

  const plan = planPurchase(deps.store, state.rules.preferredSku);
  const morningForecast = forecastFor(supply, pet, date, plan.shippingDays, state.rules.bufferDays);
  // Snapshot before delivery mutates the open bag.
  const morning = toSnapshot(deps.store, supply, morningForecast, pet);
  const events: TickEvent[] = [];
  const deliveries = applyDeliveries(deps, state, supply, pet, date, events);
  const decisionForecast = deliveries
    ? forecastFor(supply, pet, date, plan.shippingDays, state.rules.bufferDays)
    : morningForecast;
  const forecast = deliveries ? toSnapshot(deps.store, supply, decisionForecast, pet) : morning;

  const open = inFlight(state, supply.id);
  if (open) {
    events.push({
      type: "in_flight",
      replenishmentId: open.id,
      status: open.status === "ordered" ? "ordered" : "pending_approval",
      expectedArrival: open.expectedArrival,
      storeOrderId: open.storeOrderId,
      totalCents: open.totalCents,
    });
  } else if (decisionForecast.shouldReorder) {
    await reorder(deps, state, supply, date, plan, events);
  } else {
    events.push({ type: "hold" });
  }

  return {
    supplyId: supply.id,
    petName: pet.name,
    breed: pet.breed,
    species: pet.species,
    weightKg: pet.weightKg,
    dailyGrams: pet.dailyGrams,
    adjustments: supply.adjustments,
    morning: deliveries ? morning : null,
    forecast,
    events,
  };
}

function forecastFor(
  supply: TrackedSupply,
  pet: PetProfile,
  date: IsoDate,
  shippingDays: number,
  bufferDays: number,
) {
  return predictRunOut(
    {
      bagSize: supply.bagSizeGrams,
      openedOn: supply.openedOn,
      dailyUsage: pet.dailyGrams,
      anchor: supply.anchor ? { asOf: supply.anchor.asOf, amount: supply.anchor.grams } : null,
      refills: supply.refills.map((refill) => ({ date: refill.date, amount: refill.grams })),
      adjustments: supply.adjustments,
    },
    date,
    { shippingDays, bufferDays },
  );
}

function applyDeliveries(
  deps: AgentDeps,
  state: HouseholdState,
  supply: TrackedSupply,
  pet: PetProfile,
  date: IsoDate,
  events: TickEvent[],
): boolean {
  let delivered = false;
  for (const replenishment of state.replenishments) {
    if (replenishment.supplyId !== supply.id) continue;
    if (replenishment.status !== "ordered") continue;
    if (!replenishment.expectedArrival || replenishment.expectedArrival > date) continue;

    const leftoverGrams = estimateRemaining(
      {
        bagSize: supply.bagSizeGrams,
        openedOn: supply.openedOn,
        dailyUsage: pet.dailyGrams,
        anchor: supply.anchor ? { asOf: supply.anchor.asOf, amount: supply.anchor.grams } : null,
        refills: supply.refills.map((refill) => ({ date: refill.date, amount: refill.grams })),
        adjustments: supply.adjustments,
      },
      date,
    );
    const product = deps.store.getProduct(replenishment.sku);
    const gramsEach = product ? gramsFromProduct(product) : null;
    const openedGrams = gramsEach == null ? null : gramsEach * replenishment.quantity;
    if (product && openedGrams != null) {
      supply.sku = product.sku;
      supply.bagSizeGrams = openedGrams;
      supply.openedOn = date;
      supply.anchor = null;
      supply.refills = [];
      supply.adjustments = supply.adjustments.filter((adjustment) => adjustment.endDate >= date);
    }
    replenishment.status = "delivered";
    replenishment.deliveredOn = date;
    events.push({
      type: "delivery",
      replenishmentId: replenishment.id,
      sku: replenishment.sku,
      productName: product?.name ?? replenishment.productName,
      unitSize: product?.unitSize ?? null,
      unit: product?.unit ?? null,
      openedGrams,
      leftoverGrams,
    });
    delivered = true;
  }
  return delivered;
}

async function reorder(
  deps: AgentDeps,
  state: HouseholdState,
  supply: TrackedSupply,
  date: IsoDate,
  plan: ReturnType<typeof planPurchase>,
  events: TickEvent[],
): Promise<void> {
  const product = plan.product;
  if (!product) {
    events.push({
      type: "blocked",
      reason: "reorder blocked — nothing in stock that can refill this bag",
    });
    return;
  }

  const quantity = 1;
  const totalCents = product.priceCents * quantity;
  const totals = totalsForDate(state.replenishments, date);
  const budget = evaluateBudget({
    orderCents: totalCents,
    perOrderCapCents: state.rules.perOrderBudgetCents,
    monthlyCapCents: state.rules.monthlyBudgetCents,
    spentCents: totals.spentCents,
    pendingCents: totals.pendingCents,
    monthLabel: monthLabel(date),
  });
  const id = (deps.ids ?? createId)("rpl");
  const base: Replenishment = {
    id,
    supplyId: supply.id,
    sku: product.sku,
    productName: product.name,
    quantity,
    totalCents,
    currency: "USD",
    status: "pending_approval",
    autoPay: budget.autoPay,
    reasons: budget.reasons,
    substituted: plan.substituted,
    paymentId: null,
    paymentProvider: null,
    storeOrderId: null,
    shippingDays: product.shippingDays,
    orderedOn: null,
    expectedArrival: null,
    deliveredOn: null,
    createdOn: date,
    decidedOn: null,
  };

  if (!budget.autoPay) {
    state.replenishments.push(base);
    events.push({
      type: "pending_approval",
      replenishmentId: id,
      sku: product.sku,
      productName: product.name,
      unitSize: product.unitSize,
      unit: product.unit,
      totalCents,
      shippingDays: product.shippingDays,
      substituted: plan.substituted,
      budget,
    });
    return;
  }

  const payment = await deps.payments.charge({
    amountCents: totalCents,
    currency: "USD",
    description: `${product.name} (${product.sku})`,
    sku: product.sku,
    idempotencyKey: id,
  });
  const order = placeOrExplain(deps, product.sku, quantity, date, payment.paymentId);
  const expectedArrival = addDays(date, order.shippingDays);
  state.replenishments.push({
    ...base,
    status: "ordered",
    decidedOn: date,
    orderedOn: date,
    paymentId: payment.paymentId,
    paymentProvider: deps.payments.name,
    storeOrderId: order.id,
    shippingDays: order.shippingDays,
    expectedArrival,
  });
  events.push({
    type: "paid",
    replenishmentId: id,
    sku: product.sku,
    productName: product.name,
    unitSize: product.unitSize,
    unit: product.unit,
    totalCents,
    paymentId: payment.paymentId,
    providerLabel: deps.payments.label,
    storeOrderId: order.id,
    shippingDays: order.shippingDays,
    expectedArrival,
    substituted: plan.substituted,
    budget,
    ...(payment.paypal ? { paypal: payment.paypal } : {}),
  });
}

function placeOrExplain(
  deps: AgentDeps,
  sku: string,
  quantity: number,
  date: IsoDate,
  paymentId: string,
) {
  try {
    return deps.store.placeOrder({
      sku,
      quantity,
      createdAt: `${date}T15:00:00.000Z`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "order failed";
    throw new Error(`Charged ${paymentId} but the store order failed: ${message}`);
  }
}

function inFlight(state: HouseholdState, supplyId: string): Replenishment | undefined {
  return state.replenishments.find(
    (item) => item.supplyId === supplyId && (item.status === "pending_approval" || item.status === "ordered"),
  );
}

function toSnapshot(
  store: StoreService,
  supply: TrackedSupply,
  forecast: ReturnType<typeof forecastFor>,
  pet: PetProfile,
): ForecastSnapshot {
  const product = store.getProduct(supply.sku);
  return {
    sku: supply.sku,
    productName: product?.name ?? supply.sku,
    unitSize: product?.unitSize ?? supply.bagSizeGrams / 1000,
    unit: product?.unit ?? "g",
    remaining: forecast.remaining,
    bagSize: supply.bagSizeGrams,
    dailyUsage: pet.dailyGrams,
    daysLeft: forecast.daysLeft,
    runOutDate: forecast.runOutDate,
    thresholdDays: forecast.thresholdDays,
    shippingDays: forecast.shippingDays,
    bufferDays: forecast.bufferDays,
  };
}

function resolveDate(deps: AgentDeps, asOf?: IsoDate): IsoDate {
  const date = asOf ?? deps.today?.() ?? todayIso();
  assertIsoDate(date);
  return date;
}
