/** Whole days of food, as shown to a person. 8.36 → "about 8 days", 1.2 → "about 1 day". */
export function phraseAboutDays(days: number): string {
  const rounded = Math.max(0, Math.round(Number.isFinite(days) ? days : 0));
  return rounded === 1 ? "about 1 day" : `about ${rounded} days`;
}

/** Rewrites a stored fractional count so an existing household still reads as whole days. */
export function roundDaysLeftCopy(text: string): string {
  return text.replace(/\babout\s+(-?\d+(?:\.\d+)?)\s+days?\b/gi, (_match, raw: string) => phraseAboutDays(Number(raw)));
}

/** Manual breaks from the round-6 screens. Headlines stay at most two lines. */
export function breakHeadline(headline: string): string {
  const text = roundDaysLeftCopy(headline);
  const rules: Array<[RegExp, string]> = [
    [/^(Qizai has about)\s+(.+)$/i, "$1\n$2"],
    [/^(Noted\.\s+.+?\s+skips)\s+(dinner tomorrow\.?)$/i, "$1\n$2"],
    [/^(Qizai's next order)\s+(needs your approval\.?)$/i, "$1\n$2"],
    [/^(Connect PayPal for)\s+(automatic replenishment\.?)$/i, "$1\n$2"],
    [/^(One more step: allow)\s+(automatic payments\.?)$/i, "$1\n$2"],
    [/^(Automatic)\s+(replenishment is on\.?)$/i, "$1\n$2"],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

/** Line under the limit box. Derived from the violation codes, not a price-change story. */
export function approvalNote(violations: { code: "per_order" | "monthly"; limitCents: number }[]): string {
  const lines: string[] = [];
  for (const violation of violations) {
    if (violation.code === "per_order") {
      const amount = dollars(violation.limitCents, violation.limitCents % 100 === 0 ? 0 : 2);
      lines.push(`Over your ${amount} auto-pay limit`);
    } else if (violation.code === "monthly") {
      lines.push("Over your monthly budget");
    }
  }
  return lines.join(". ");
}

/** Home paid line. Collapsed shows the last 6 characters; expanded shows the whole capture id. */
export function paidCaptureLine(captureId: string, expanded = false): string {
  if (expanded) return `Paid with PayPal · ${captureId}`;
  return `Paid with PayPal · …${captureId.slice(-6)}`;
}

export function dollars(cents: number, digits?: 0 | 2): string {
  const places = digits ?? (cents % 100 === 0 ? 0 : 2);
  return `$${(cents / 100).toFixed(places)}`;
}

export function signedDollars(cents: number): string {
  return `+${dollars(Math.abs(cents), 2)}`;
}

export function reorderCaption(orderDate: string, orderDateRaw: string, timeZone: string, changed: boolean): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(new Date(orderDateRaw));
  return `${changed ? "Now" : "Still"} ${weekday}, ${orderDate}`;
}

export const PAYPAL_TITLES = {
  disconnected: "Connect PayPal for\nautomatic replenishment.",
  connected: "One more step: allow\nautomatic payments.",
  authorized: "Automatic\nreplenishment is on.",
} as const;
