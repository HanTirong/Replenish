import { MemoryHouseholdRepository, sequentialIds } from "@replenish/domain";
import { randomUUID } from "node:crypto";
import { StoreService } from "@replenish/store";
import { formatResolution, formatSupply } from "./format";
import type { ChargeResult } from "./payments";
import { readPayPalCredentials } from "./paypal";
import { PayPalPaymentProvider } from "./paypal-provider";
import type { PayPalProviderOptions, VaultStore } from "./paypal";
import { buildPipHousehold, LARGE_BAG_SKU, OPEN_BAG_SKU } from "./seed";
import { resolveApproval, tick, type AgentDeps, type SupplyReport, type TickEvent, type TickResult } from "./tick";

type Line = (line?: string) => void;

export interface PayPalDemoOptions {
  env?: NodeJS.ProcessEnv;
  writeLine?: Line;
  fetch?: typeof fetch;
  vaultStore?: VaultStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Pip's kibble, charged against the PayPal sandbox.
 * Fails immediately when PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is missing.
 */
export async function runPayPalDemo(options: PayPalDemoOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const writeLine = options.writeLine ?? console.log;
  if (env.PAYMENT_PROVIDER && env.PAYMENT_PROVIDER.toLowerCase() !== "paypal") {
    throw new Error("demo:paypal charges the PayPal sandbox. Run it with PAYMENT_PROVIDER=paypal.");
  }
  if ((env.PAYPAL_ENV ?? "sandbox").toLowerCase() === "live" && env.PAYPAL_ALLOW_LIVE !== "1") {
    throw new Error("demo:paypal refuses PAYPAL_ENV=live. Use the sandbox (unset PAYPAL_ENV, or set it to sandbox).");
  }
  readPayPalCredentials(env);

  const payments = new PayPalPaymentProvider({
    env,
    fetch: options.fetch,
    vaultStore: options.vaultStore,
    now: options.now,
    sleep: options.sleep,
    log: (line) => writeLine(line),
  } satisfies PayPalProviderOptions);

  writeLine("Replenish PayPal sandbox demo");
  writeLine(`API              ${payments.baseUrl}`);
  writeLine("Simulated dates. Each charge uses the same order shape as pnpm paypal:diagnose.");
  writeLine("A saved card token is reused with usage DERIVED unless a scheme transaction id was stored.");
  writeLine("PAYPAL_WALLET_FALLBACK=off, so a refused card exits with PayPal's error instead of waiting.");
  writeLine("");

  const nextId = sequentialIds();
  const runId = randomUUID();
  const ids = (prefix: string) => `${nextId(prefix)}_${runId}`;
  const auto = await runAutoPay(writeLine, ids, payments);
  const approved = await runApproval(writeLine, ids, payments);

  writeLine("------------------------------------------------------------");
  writeLine("Sandbox result");
  writeLine(`  Auto-pay order    ${auto.paypal?.orderId} · ${auto.paypal?.orderStatus}`);
  writeLine(`  Auto-pay capture  ${auto.paypal?.captureId} · ${auto.paypal?.captureStatus}`);
  writeLine(`  Approved order    ${approved.paypal?.orderId} · ${approved.paypal?.orderStatus}`);
  writeLine(`  Approved capture  ${approved.paypal?.captureId} · ${approved.paypal?.captureStatus}`);
  writeLine("  Vault             saved on the backend");
  requireCompleted("auto-pay", auto);
  requireCompleted("approval", approved);
  writeLine("");
  writeLine("Demo finished. Both captures are COMPLETED.");
}

async function runAutoPay(
  writeLine: Line,
  ids: (prefix: string) => string,
  payments: PayPalPaymentProvider,
): Promise<ChargeResult> {
  const deps = harness(
    buildPipHousehold({
      openedOn: "2026-10-01",
      preferredSku: OPEN_BAG_SKU,
      perOrderBudgetCents: 5000,
      monthlyBudgetCents: 12000,
    }),
    ids,
    payments,
  );
  writeLine("------------------------------------------------------------");
  writeLine("Scenario 1 · auto-pay inside the budget");
  writeLine("Preferred    RC-SMALL-4 · $35.00 · inside the $50.00 cap");
  writeLine("");
  await printTick(deps, "2026-10-15", writeLine);
  await printTick(deps, "2026-10-16", writeLine);
  const ordered = await printTick(deps, "2026-10-17", writeLine);
  const paid = decision(onlySupply(ordered));
  if (paid.type !== "paid") throw new Error("Scenario 1 did not auto-pay through PayPal");
  const charge = payments.results.at(-1);
  if (!charge?.paypal) throw new Error("Scenario 1 did not return a PayPal order");
  return charge;
}

async function runApproval(
  writeLine: Line,
  ids: (prefix: string) => string,
  payments: PayPalPaymentProvider,
): Promise<ChargeResult> {
  const deps = harness(
    buildPipHousehold({
      openedOn: "2026-10-01",
      preferredSku: LARGE_BAG_SKU,
      perOrderBudgetCents: 5000,
      monthlyBudgetCents: 12000,
    }),
    ids,
    payments,
  );
  writeLine("------------------------------------------------------------");
  writeLine("Scenario 2 · over the cap, then a person approves");
  writeLine("Preferred    RC-SMALL-8 · $72.99 · over the $50.00 cap");
  writeLine("");
  const friday = await printTick(deps, "2026-10-16", writeLine);
  const pending = decision(onlySupply(friday));
  if (pending.type !== "pending_approval") throw new Error("Scenario 2 did not wait for confirmation");
  if (payments.results.length !== 1) throw new Error("Scenario 2 charged PayPal before confirmation");
  writeLine("Nothing was charged for this bag yet.");
  writeLine("");
  writeLine("A person confirms the charge.");
  const confirmed = await resolveApproval(deps, pending.replenishmentId, "approve", "2026-10-17");
  writeLine(formatResolution(confirmed));
  writeLine("");
  const charge = confirmed.charge;
  if (!charge?.paypal) throw new Error("Approval did not capture a PayPal order");
  return charge;
}

function requireCompleted(label: string, charge: ChargeResult): void {
  if (charge.paypal?.orderStatus !== "COMPLETED" || charge.paypal.captureStatus !== "COMPLETED") {
    throw new Error(
      `PayPal ${label} did not complete. ` +
        `Order ${charge.paypal?.orderId ?? "missing"} is ${charge.paypal?.orderStatus ?? "missing"}, ` +
        `capture ${charge.paypal?.captureId ?? "missing"} is ${charge.paypal?.captureStatus ?? "missing"}.`,
    );
  }
}

function harness(
  state: ReturnType<typeof buildPipHousehold>,
  ids: (prefix: string) => string,
  payments: PayPalPaymentProvider,
): AgentDeps {
  return {
    household: new MemoryHouseholdRepository(state),
    store: StoreService.inMemory({ createId: () => ids("ord") }),
    payments,
    ids,
  };
}

async function printTick(deps: AgentDeps, date: string, writeLine: Line): Promise<TickResult> {
  const result = await tick(deps, date);
  writeLine(formatSupply(result.date, onlySupply(result)));
  writeLine("");
  return result;
}

function onlySupply(result: TickResult): SupplyReport {
  const supply = result.supplies[0];
  if (!supply) throw new Error("Demo household has no supply");
  return supply;
}

function decision(report: SupplyReport): Exclude<TickEvent, { type: "delivery" }> {
  const event = report.events.find((item) => item.type !== "delivery");
  if (!event) throw new Error("Missing decision");
  return event;
}

function isDirectRun(scriptName: string): boolean {
  const entry = process.argv[1]?.replaceAll("\\", "/");
  return entry !== undefined && entry.endsWith(scriptName);
}

if (isDirectRun("demo-paypal.ts")) {
  runPayPalDemo().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
