import {
  formatLongDate,
  monthLabel,
  predictRunOut,
  type HouseholdState,
  type IsoDate,
  type UsageAdjustment,
} from "@replenish/domain";
import { formatUsd, type StoreService } from "@replenish/store";
import { totalsForDate } from "./budget";
import { providerLabel, type PayPalChargeDetails } from "./payments";
import { planPurchase } from "./purchase";
import type { DecisionResult, ForecastSnapshot, SupplyReport, TickEvent, TickResult } from "./tick";

export function formatTick(result: TickResult): string {
  return result.supplies
    .map((supply) => {
      const banner = `${result.householdName} household · ${supply.petName} · ${supply.breed} · ${supply.weightKg} kg · ${formatGrams(supply.dailyGrams)}/day`;
      return `${banner}\n${formatSupply(result.date, supply)}`;
    })
    .join("\n\n");
}

export function formatSupply(date: IsoDate, report: SupplyReport): string {
  const lines: string[] = [formatLongDate(date)];
  const delivered = report.events.some((event) => event.type === "delivery");
  if (delivered && report.morning) {
    lines.push(...formatReading(report.morning, "Morning"));
  } else {
    lines.push(...formatReading(report.forecast, "On hand"));
  }
  lines.push(...formatAdjustments(report.adjustments, date));
  for (const event of report.events) {
    if (event.type === "delivery") lines.push(...formatDelivery(event));
  }
  if (delivered) {
    const when = report.forecast.runOutDate ? formatLongDate(report.forecast.runOutDate) : "outside the forecast";
    lines.push(
      ...row(
        "On hand now",
        `${formatGrams(report.forecast.remaining)} · ${formatDays(report.forecast.daysLeft)} · runs out ${when}`,
      ),
    );
  }
  for (const event of report.events) {
    if (event.type !== "delivery") lines.push(...formatDecision(event));
  }
  return lines.join("\n");
}

export function formatResolution(result: DecisionResult): string {
  const item = result.replenishment;
  if (result.action === "reject") {
    return [
      `Rejected ${item.id}`,
      ...row("Payment", "not charged"),
      ...row("Store order", "not placed"),
    ].join("\n");
  }
  const arrival = item.expectedArrival ? formatLongDate(item.expectedArrival) : "unscheduled";
  return [
    `Confirmed ${item.id}`,
    ...row("Payment", `paid with ${providerLabel(item.paymentProvider)} (${item.paymentId})`),
    ...paypalRows(result.charge?.paypal),
    ...row("Store order", `${item.storeOrderId} · ${formatUsd(item.totalCents)} · arrives ${arrival}`),
  ].join("\n");
}

export function formatStatus(state: HouseholdState, store: StoreService, date: IsoDate): string {
  const lines: string[] = [`${state.householdName} household`, ""];
  for (const pet of state.pets) {
    lines.push(`${pet.name} · ${pet.breed} · ${pet.species} · ${pet.weightKg} kg · ${formatGrams(pet.dailyGrams)}/day`);
  }
  const preferred = store.getProduct(state.rules.preferredSku);
  const plan = planPurchase(store, state.rules.preferredSku);
  lines.push(
    "",
    "Rules",
    ...row("Per order", formatUsd(state.rules.perOrderBudgetCents)),
    ...row("Monthly", formatUsd(state.rules.monthlyBudgetCents)),
    ...row("Buffer", `${state.rules.bufferDays} days`),
    ...row(
      "Preferred",
      preferred
        ? `${preferred.sku} · ${preferred.name} · ships in ${preferred.shippingDays} days · ${formatUsd(preferred.priceCents)}`
        : state.rules.preferredSku,
    ),
  );
  if (plan.substituted && plan.product) {
    lines.push(...row("Would buy", `${plan.product.sku} · ${plan.product.name} (preferred SKU is out of stock)`));
  }
  lines.push("");
  for (const supply of state.supplies) {
    const pet = state.pets.find((item) => item.id === supply.petId);
    if (!pet) continue;
    const forecast = predictRunOut(
      {
        bagSize: supply.bagSizeGrams,
        openedOn: supply.openedOn,
        dailyUsage: pet.dailyGrams,
        anchor: supply.anchor ? { asOf: supply.anchor.asOf, amount: supply.anchor.grams } : null,
        refills: supply.refills.map((refill) => ({ date: refill.date, amount: refill.grams })),
        adjustments: supply.adjustments,
      },
      date,
      { shippingDays: plan.shippingDays, bufferDays: state.rules.bufferDays },
    );
    const product = store.getProduct(supply.sku);
    lines.push(
      ...formatReading(
        {
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
        },
        "On hand",
        date,
      ),
    );
    lines.push(...formatAdjustments(supply.adjustments, date));
    lines.push(...row("Next action", nextAction(state, supply.id, forecast.shouldReorder)));
    lines.push("");
  }
  const totals = totalsForDate(state.replenishments, date);
  lines.push("Replenishments");
  if (state.replenishments.length === 0) {
    lines.push("  none");
  } else {
    for (const item of state.replenishments) {
      const money = formatUsd(item.totalCents);
      const extra =
        item.status === "pending_approval"
          ? ` · pnpm replenish approve ${item.id}`
          : item.storeOrderId
            ? ` · ${item.storeOrderId}`
            : "";
      lines.push(`  ${item.createdOn}  ${item.status.padEnd(17)} ${item.sku}  ${money}${extra}`);
    }
  }
  lines.push(
    "",
    `${monthLabel(date)} · paid ${formatUsd(totals.spentCents)} · waiting ${formatUsd(totals.pendingCents)}`,
  );
  return lines.join("\n");
}

function nextAction(state: HouseholdState, supplyId: string, shouldReorder: boolean): string {
  const open = state.replenishments.find(
    (item) => item.supplyId === supplyId && (item.status === "pending_approval" || item.status === "ordered"),
  );
  if (open?.status === "ordered") {
    const when = open.expectedArrival ? ` until ${formatLongDate(open.expectedArrival)}` : "";
    return `waiting on ${open.storeOrderId ?? open.id}${when}`;
  }
  if (open?.status === "pending_approval") {
    return `waiting for confirmation · ${open.id}`;
  }
  return shouldReorder ? "reorder on the next tick" : "hold";
}

function formatReading(snapshot: ForecastSnapshot, label: string, date?: IsoDate): string[] {
  const heading = date ? [formatLongDate(date)] : [];
  const runOut = snapshot.runOutDate ? formatLongDate(snapshot.runOutDate) : "outside the forecast";
  return [
    ...heading,
    ...row(label, `${formatGrams(snapshot.remaining)} of ${formatGrams(snapshot.bagSize)} · ${snapshot.productName}`),
    ...row("Daily use", formatGrams(snapshot.dailyUsage)),
    ...row("Days left", formatDays(snapshot.daysLeft)),
    ...row("Runs out", runOut),
    ...row(
      "Reorder when",
      `days left <= ${snapshot.thresholdDays} (ships in ${snapshot.shippingDays} + ${snapshot.bufferDays} buffer)`,
    ),
  ];
}

function formatAdjustments(adjustments: readonly UsageAdjustment[], date: IsoDate): string[] {
  const active = adjustments.filter((adjustment) => adjustment.endDate >= date);
  if (active.length === 0) return [];
  const text = active
    .map(
      (adjustment) =>
        `${formatMultiplier(adjustment.multiplier)} ${formatLongDate(adjustment.startDate)} to ${formatLongDate(adjustment.endDate)} · ${adjustment.reason} (${adjustment.source})`,
    )
    .join("\n");
  return row("Adjustments", text);
}

function formatDelivery(event: Extract<TickEvent, { type: "delivery" }>): string[] {
  const size =
    event.openedGrams == null
      ? `${event.productName} arrived. The bag was not opened because the unit is not weighed in grams.`
      : `${event.productName}, ${formatUnit(event.unitSize, event.unit)}, opened`;
  return [
    ...row("Delivery", size),
    ...row("Set aside", `${formatGrams(event.leftoverGrams)} left in the previous bag`),
  ];
}

function formatDecision(event: Exclude<TickEvent, { type: "delivery" }>): string[] {
  switch (event.type) {
    case "hold":
      return row("Decision", "hold");
    case "blocked":
      return row("Decision", event.reason);
    case "in_flight":
      if (event.status === "ordered") {
        const when = event.expectedArrival ? `arrives ${formatLongDate(event.expectedArrival)}` : "on the way";
        return row("Decision", `waiting on ${event.storeOrderId ?? event.replenishmentId} · ${when}`);
      }
      return row("Decision", `still waiting for confirmation · ${event.replenishmentId}`);
    case "paid":
      return [
        ...row("Decision", event.substituted ? "reorder (substituted)" : "reorder"),
        ...productRows(event),
        ...row("Budget", event.budget.reasons.join("\n")),
        ...row("Payment", `auto-paid with ${event.providerLabel} (${event.paymentId})`),
        ...paypalRows(event.paypal),
        ...row(
          "Store order",
          `${event.storeOrderId} · ${formatUsd(event.totalCents)} · arrives ${formatLongDate(event.expectedArrival)}`,
        ),
      ];
    case "pending_approval":
      return [
        ...row("Decision", "reorder, waiting for confirmation"),
        ...productRows(event),
        ...row("Budget", event.budget.reasons.join("\n")),
        ...row("Payment", "not charged"),
        ...row("Store order", "not placed"),
        ...row("Approval", event.replenishmentId),
        ...row("Confirm", `pnpm replenish approve ${event.replenishmentId}`),
        ...row("Reject", `pnpm replenish reject ${event.replenishmentId}`),
      ];
    default:
      return [];
  }
}

function paypalRows(details: PayPalChargeDetails | undefined): string[] {
  if (!details) return [];
  const capture = details.captureId
    ? `${details.captureId} · ${details.captureStatus ?? "unknown"}`
    : "none";
  return [
    ...row("PayPal order", `${details.orderId} · ${details.orderStatus}`),
    ...row("PayPal capture", capture),
  ];
}

function productRows(event: {
  productName: string;
  unitSize: number;
  unit: string;
  sku: string;
  totalCents: number;
  substituted: boolean;
}): string[] {
  const note = event.substituted ? " · substituted, preferred SKU was out of stock" : "";
  return [
    ...row("Product", `${event.productName} · ${formatUnit(event.unitSize, event.unit)} · ${event.sku}${note}`),
    ...row("Price", formatUsd(event.totalCents)),
  ];
}

function formatUnit(size: number | null, unit: string | null): string {
  if (size == null || unit == null) return "";
  const body = Number.isInteger(size) ? size.toString() : String(size);
  return `${body} ${unit}`;
}

function formatMultiplier(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : String(value)}x`;
}

function formatDays(days: number): string {
  if (!Number.isFinite(days)) return "no run-out in the forecast window";
  const rounded = Math.max(0, Math.round(days));
  return rounded === 1 ? "about 1 day" : `about ${rounded} days`;
}

export function formatGrams(grams: number): string {
  const rounded = Math.round(grams);
  const body = rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${body} g`;
}

function row(label: string, value: string): string[] {
  const [first, ...rest] = value.split("\n");
  const lines = [`  ${label.padEnd(16)} ${first ?? ""}`];
  for (const line of rest) lines.push(`  ${"".padEnd(16)} ${line}`);
  return lines;
}
