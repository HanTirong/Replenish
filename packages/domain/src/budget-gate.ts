export interface BudgetGateInput {
  orderCents: number;
  perOrderLimitCents: number;
  monthlyLimitCents: number;
  /** Paid orders this calendar month. */
  settledCents: number;
  /** Drafts already promised but not paid, excluding the order being judged. */
  committedCents: number;
}

export interface BudgetViolation {
  code: "per_order" | "monthly";
  limitCents: number;
  actualCents: number;
  overByCents: number;
  message: string;
}

export interface BudgetGateResult {
  allowed: boolean;
  violations: BudgetViolation[];
  monthTotalCents: number;
}

/** Both limits are reported together. Neither one hides the other. */
export function evaluateOrderBudget(input: BudgetGateInput): BudgetGateResult {
  const violations: BudgetViolation[] = [];
  if (input.orderCents > input.perOrderLimitCents) {
    const overByCents = input.orderCents - input.perOrderLimitCents;
    violations.push({
      code: "per_order",
      limitCents: input.perOrderLimitCents,
      actualCents: input.orderCents,
      overByCents,
      message: `Order is ${money(input.orderCents)}, ${money(overByCents)} over the ${money(input.perOrderLimitCents)} per-order limit.`,
    });
  }
  const monthTotalCents = input.settledCents + input.committedCents + input.orderCents;
  if (monthTotalCents > input.monthlyLimitCents) {
    const overByCents = monthTotalCents - input.monthlyLimitCents;
    violations.push({
      code: "monthly",
      limitCents: input.monthlyLimitCents,
      actualCents: monthTotalCents,
      overByCents,
      message: `This month would total ${money(monthTotalCents)}, ${money(overByCents)} over the ${money(input.monthlyLimitCents)} monthly limit.`,
    });
  }
  return { allowed: violations.length === 0, violations, monthTotalCents };
}

export interface ApprovalBinding {
  orderId: string;
  sku: string;
  merchant: string;
  currency: string;
  totalCents: number;
}

export function approvalStillValid(approval: ApprovalBinding, draft: ApprovalBinding): boolean {
  return (
    approval.orderId === draft.orderId &&
    approval.sku === draft.sku &&
    approval.merchant === draft.merchant &&
    approval.currency === draft.currency &&
    approval.totalCents === draft.totalCents
  );
}

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  return `${sign}$${dollars}.${remainder.toString().padStart(2, "0")}`;
}
