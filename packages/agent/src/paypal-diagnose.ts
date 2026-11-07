import { PayPalApiError, readPayPalCredentials } from "./paypal";
import { PayPalPaymentProvider } from "./paypal-provider";
import type { PayPalProviderOptions, VaultStore } from "./paypal";

type Line = (line?: string) => void;

export interface PayPalDiagnoseOptions {
  env?: NodeJS.ProcessEnv;
  writeLine?: Line;
  fetch?: typeof fetch;
  vaultStore?: VaultStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Prints OAuth scopes (never the access token) and attempts one $1 vaulted charge.
 * Use this on the machine that has sandbox credentials before the full demo.
 */
export async function runPayPalDiagnose(options: PayPalDiagnoseOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const writeLine = options.writeLine ?? console.log;
  readPayPalCredentials(env);
  const payments = new PayPalPaymentProvider({
    env,
    fetch: options.fetch,
    vaultStore: options.vaultStore,
    now: options.now,
    sleep: options.sleep,
    log: (line) => writeLine(line),
  } satisfies PayPalProviderOptions);

  writeLine("PayPal diagnose");
  writeLine(`API              ${payments.baseUrl}`);
  writeLine("Default path     chargeable sandbox Visa, then a PayPal wallet if that card cannot pay.");
  writeLine("Before a retry   delete data/paypal-vault.json (a saved 4111 token cannot pay).");
  writeLine("");

  const summary = await payments.tokenSummary();
  writeLine(`Token type       ${summary.tokenType}`);
  writeLine(`Expires in       ${summary.expiresIn}s`);
  if (summary.appId) writeLine(`App id           ${summary.appId}`);
  writeLine("Scopes");
  if (summary.scopes.length === 0) writeLine("  (none listed)");
  for (const scope of summary.scopes) writeLine(`  ${scope}`);
  writeLine("");
  writeLine("Trying a $1.00 merchant-initiated vault charge.");

  try {
    const result = await payments.charge({
      amountCents: 100,
      currency: "USD",
      description: "Replenish sandbox diagnose",
      sku: "DIAGNOSE",
      idempotencyKey: `diagnose-${options.now?.() ?? Date.now()}`,
    });
    writeLine(`PayPal order     ${result.paypal?.orderId} · ${result.paypal?.orderStatus}`);
    writeLine(`PayPal capture   ${result.paypal?.captureId} · ${result.paypal?.captureStatus}`);
    writeLine("Vault            saved on the backend");
  } catch (error) {
    writeLine(error instanceof Error ? error.message : String(error));
    if (error instanceof PayPalApiError && error.debugId) {
      writeLine(`debug_id: ${error.debugId}`);
    }
    throw error;
  }
}

function isDirectRun(scriptName: string): boolean {
  const entry = process.argv[1]?.replaceAll("\\", "/");
  return entry !== undefined && entry.endsWith(scriptName);
}

if (isDirectRun("paypal-diagnose.ts")) {
  runPayPalDiagnose().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof PayPalApiError && error.debugId) {
      console.error(`debug_id: ${error.debugId}`);
    }
    process.exitCode = 1;
  });
}
