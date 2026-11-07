import { monthKey, type IsoDate } from "@replenish/domain";
import type { Replenishment } from "@replenish/domain";
import { formatUsd } from "@replenish/store";

export interface BudgetInput {
  orderCents: number;
  perOrderCapCents: number;
  monthlyCapCents: number;
  /** Already charged this month (ordered or delivered). */
  spentCents: number;
  /** Still waiting on a person, requested this month. */
  pendingCents: number;
  monthLabel: string;
}

export interface BudgetDecision {
  autoPay: boolean;
  perOrderOk: boolean;
  monthlyOk: boolean;
  spentCents: number;
  pendingCents: number;
  projectedCents: number;
  orderCents: number;
  perOrderCapCents: number;
  monthlyCapCents: number;
  reasons: string[];
}

/**
 * Auto-pay only when the order fits both caps.
 * Pending approvals count as committed so a second tick cannot stack past the month.
 */
export function evaluateBudget(input: BudgetInput): BudgetDecision {
  const committedCents = input.spentCents + input.pendingCents;
  const projectedCents = committedCents + input.orderCents;
  const perOrderOk = input.orderCents <= input.perOrderCapCents;
  const monthlyOk = projectedCents <= input.monthlyCapCents;
  const order = formatUsd(input.orderCents);
  const perCap = formatUsd(input.perOrderCapCents);
  const monthCap = formatUsd(input.monthlyCapCents);
  const projected = formatUsd(projectedCents);
  return {
    autoPay: perOrderOk && monthlyOk,
    perOrderOk,
    monthlyOk,
    spentCents: input.spentCents,
    pendingCents: input.pendingCents,
    projectedCents,
    orderCents: input.orderCents,
    perOrderCapCents: input.perOrderCapCents,
    monthlyCapCents: input.monthlyCapCents,
    reasons: [
      perOrderOk
        ? `Order ${order} is within the ${perCap} per-order cap.`
        : `Order ${order} is over the ${perCap} per-order cap.`,
      monthlyOk
        ? `${input.monthLabel} would be ${projected} of the ${monthCap} monthly cap.`
        : `${input.monthLabel} would be ${projected}, over the ${monthCap} monthly cap.`,
    ],
  };
}

export function monthTotals(
  replenishments: readonly Replenishment[],
  month: string,
): { spentCents: number; pendingCents: number } {
  let spentCents = 0;
  let pendingCents = 0;
  for (const item of replenishments) {
    const when = item.status === "pending_approval" || item.status === "rejected" ? item.createdOn : (item.orderedOn ?? item.createdOn);
    if (!when.startsWith(month)) continue;
    if (item.status === "ordered" || item.status === "delivered") spentCents += item.totalCents;
    else if (item.status === "pending_approval") pendingCents += item.totalCents;
  }
  return { spentCents, pendingCents };
}

export function totalsForDate(replenishments: readonly Replenishment[], date: IsoDate): { spentCents: number; pendingCents: number } {
  return monthTotals(replenishments, monthKey(date));
}
