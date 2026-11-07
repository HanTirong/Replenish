import { MemoryHouseholdRepository, sequentialIds } from "@replenish/domain";
import { formatUsd, StoreService } from "@replenish/store";
import { formatResolution, formatSupply } from "./format";
import { MockPaymentProvider } from "./payments";
import { buildPipHousehold, LARGE_BAG_SKU, OPEN_BAG_SKU } from "./seed";
import { resolveApproval, tick, type AgentDeps, type SupplyReport, type TickResult } from "./tick";

type Line = (line?: string) => void;

/**
 * Fallback demo. Time is simulated, payments are mocked, and nothing is written
 * to data/. `pnpm demo` exits non-zero if either story fails to happen.
 */
export async function runDemo(writeLine: Line = console.log): Promise<void> {
  const ids = sequentialIds();
  writeLine("Replenish demo");
  writeLine("Simulated time. No PayPal call. Payments use MockPaymentProvider.");
  writeLine("");
  writeLine("Pip is a cockapoo. The agent watches one open bag of kibble and");
  writeLine("reorders when the bag would run out before a new one can arrive");
  writeLine("with a 2-day buffer. Inside the household caps it pays. Above a");
  writeLine("cap it waits.");

  await scenarioWithinBudget(writeLine, ids);
  await scenarioOverBudget(writeLine, ids);

  writeLine("");
  writeLine("Demo finished.");
  writeLine("PayPal sandbox: PAYMENT_PROVIDER=paypal pnpm demo:paypal");
}

async function scenarioWithinBudget(writeLine: Line, ids: (prefix: string) => string): Promise<void> {
  const { deps, payments, store } = harness(
    buildPipHousehold({
      openedOn: "2026-10-01",
      preferredSku: OPEN_BAG_SKU,
      perOrderBudgetCents: 5000,
      monthlyBudgetCents: 12000,
    }),
    ids,
  );
  writeLine("");
  writeLine("------------------------------------------------------------");
  writeLine("Scenario 1 · auto-pay inside the budget");
  writeLine("Open bag     Royal Canin Small Adult 4 kg, opened Thu 1 Oct 2026");
  writeLine("Pip          cockapoo · 8.6 kg · 200 g/day");
  writeLine("Rules        per order $50.00 · monthly $120.00 · buffer 2 days");
  writeLine("Preferred    RC-SMALL-4 · ships in 2 days · $35.00");
  writeLine("Clock        Thu 15 Oct through Mon 19 Oct 2026");
  writeLine("");

  const days = ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"] as const;
  const results: TickResult[] = [];
  for (const date of days) {
    const result = await tick(deps, date);
    results.push(result);
    writeLine(formatSupply(result.date, onlySupply(result)));
    writeLine("");
  }

  const holdThursday = decision(onlySupply(results[0]!));
  const holdFriday = decision(onlySupply(results[1]!));
  const reorder = decision(onlySupply(results[2]!));
  const waiting = decision(onlySupply(results[3]!));
  const arrival = onlySupply(results[4]!);
  if (holdThursday.type !== "hold" || holdFriday.type !== "hold") {
    throw new Error("Scenario 1 ordered before the bag crossed the threshold");
  }
  if (reorder.type !== "paid") throw new Error("Scenario 1 did not auto-pay");
  if (waiting.type !== "in_flight") throw new Error("Scenario 1 placed a second order while the first was in transit");
  const delivered = arrival.events.find((event) => event.type === "delivery");
  if (!delivered || decision(arrival).type !== "hold") {
    throw new Error("Scenario 1 did not open the delivered bag and hold");
  }
  const scenarioOneCharges = payments.charges.length;
  const scenarioOneOrders = store.snapshot().orders.length;
  if (scenarioOneCharges !== 1 || scenarioOneOrders !== 1) {
    throw new Error("Scenario 1 should charge once and place one store order");
  }
  if (reorder.totalCents !== 3500) throw new Error(`Expected the $35.00 bag, got ${reorder.totalCents}`);
}

async function scenarioOverBudget(writeLine: Line, ids: (prefix: string) => string): Promise<void> {
  const { deps, payments, store } = harness(
    buildPipHousehold({
      openedOn: "2026-10-01",
      preferredSku: LARGE_BAG_SKU,
      perOrderBudgetCents: 5000,
      monthlyBudgetCents: 12000,
    }),
    ids,
  );
  writeLine("------------------------------------------------------------");
  writeLine("Scenario 2 · over the per-order cap, waiting for confirmation");
  writeLine("Same open bag. The rule now prefers the 8 kg bag.");
  writeLine("That bag ships in 3 days, so the agent reaches the threshold");
  writeLine("a day sooner, and $72.99 is over the $50.00 cap.");
  writeLine("");

  const thursday = await tick(deps, "2026-10-15");
  writeLine(formatSupply(thursday.date, onlySupply(thursday)));
  writeLine("");
  const friday = await tick(deps, "2026-10-16");
  const fridaySupply = onlySupply(friday);
  writeLine(formatSupply(friday.date, fridaySupply));
  writeLine("");
  const saturday = await tick(deps, "2026-10-17");
  writeLine(formatSupply(saturday.date, onlySupply(saturday)));
  writeLine("");

  const pending = decision(fridaySupply);
  if (decision(onlySupply(thursday)).type !== "hold") {
    throw new Error("Scenario 2 ordered a day too early");
  }
  if (pending.type !== "pending_approval") throw new Error("Scenario 2 did not wait for confirmation");
  if (decision(onlySupply(saturday)).type !== "in_flight") {
    throw new Error("Scenario 2 should keep waiting instead of ordering again");
  }
  const chargesBefore = payments.charges.length;
  const ordersBefore = store.snapshot().orders.length;
  if (chargesBefore !== 0 || ordersBefore !== 0) {
    throw new Error("Scenario 2 charged or ordered before confirmation");
  }

  writeLine("Nothing was charged. No store order was placed.");
  writeLine("This demo keeps state in memory, then confirms the approval itself.");
  writeLine("On a saved household the same step is:");
  writeLine(`  pnpm replenish approve ${pending.replenishmentId}`);
  writeLine("");
  writeLine("A person confirms the charge.");
  const confirmed = await resolveApproval(deps, pending.replenishmentId, "approve", "2026-10-17");
  writeLine(formatResolution(confirmed));
  writeLine("");
  if (confirmed.replenishment.status !== "ordered" || !confirmed.replenishment.paymentId) {
    throw new Error("Scenario 2 confirmation did not pay");
  }
  const chargesAfter = payments.charges.length;
  const ordersAfter = store.snapshot().orders.length;
  if (chargesAfter !== 1 || ordersAfter !== 1) {
    throw new Error("Scenario 2 should charge once after confirmation");
  }
  if (confirmed.replenishment.totalCents !== 7299) {
    throw new Error(`Expected the ${formatUsd(7299)} bag`);
  }
}

function harness(state: ReturnType<typeof buildPipHousehold>, ids: (prefix: string) => string): {
  deps: AgentDeps;
  payments: MockPaymentProvider;
  store: StoreService;
} {
  const payments = new MockPaymentProvider(() => ids("pay"));
  const store = StoreService.inMemory({ createId: () => ids("ord") });
  const household = new MemoryHouseholdRepository(state);
  return {
    payments,
    store,
    deps: { household, store, payments, ids },
  };
}

function onlySupply(result: TickResult): SupplyReport {
  const supply = result.supplies[0];
  if (!supply) throw new Error("Demo household has no supply");
  return supply;
}

function decision(report: SupplyReport): Exclude<SupplyReport["events"][number], { type: "delivery" }> {
  const event = report.events.find((item) => item.type !== "delivery");
  if (!event) throw new Error("Missing decision");
  return event;
}

function isDirectRun(scriptName: string): boolean {
  const entry = process.argv[1]?.replaceAll("\\", "/");
  return entry !== undefined && entry.endsWith(scriptName);
}

if (isDirectRun("demo.ts")) {
  runDemo().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
