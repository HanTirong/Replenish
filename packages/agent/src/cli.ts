import { existsSync } from "node:fs";
import {
  applyUsageAdjustment,
  assertIsoDate,
  createId,
  JsonHouseholdRepository,
  logRefill,
  setRemainingAnchor,
  todayIso,
  type HouseholdState,
  type IsoDate,
  type TrackedSupply,
} from "@replenish/domain";
import { formatResolution, formatStatus, formatTick } from "./format";
import { householdPath, openAgent } from "./runtime";
import { buildPipHousehold } from "./seed";
import { resolveApproval, tick } from "./tick";

const HELP = `Replenish — know when the kibble runs out, and buy inside your rules.

  pnpm demo
      Simulated clock. Auto-pay, then a charge that waits for confirmation.

  pnpm replenish init [--force]
      Save Pip the cockapoo with a 4 kg bag that is due for a check today.
  pnpm replenish status [--date YYYY-MM-DD]
  pnpm replenish tick [--date YYYY-MM-DD]
  pnpm replenish approve <id> [--date YYYY-MM-DD]
  pnpm replenish reject <id> [--date YYYY-MM-DD]
  pnpm replenish adjust --multiplier <n> --from YYYY-MM-DD --to YYYY-MM-DD --reason "..."
  pnpm replenish refill --grams <n> [--date YYYY-MM-DD] [--note "..."]
  pnpm replenish remaining --grams <n> [--date YYYY-MM-DD]

  pnpm store     HTTP catalog and orders on port 4747
  pnpm mcp       MCP tools: search_products, get_product, place_order, get_order

Payments default to MockPaymentProvider. PayPal sandbox:
  PAYMENT_PROVIDER=paypal PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... pnpm paypal:diagnose
  PAYMENT_PROVIDER=paypal PAYPAL_WALLET_FALLBACK=off pnpm demo:paypal
`;

type WriteLine = (line?: string) => void;
type Flags = Map<string, string | true>;

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  writeLine: WriteLine = console.log,
): Promise<void> {
  const [command = "help", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    writeLine(HELP.trimEnd());
    return;
  }
  const { positionals, flags } = readFlags(rest);
  switch (command) {
    case "init":
      initHousehold(env, flags, writeLine);
      return;
    case "status": {
      const deps = openAgent(env);
      writeLine(formatStatus(deps.household.load(), deps.store, readDate(flags)));
      return;
    }
    case "tick": {
      const result = await tick(openAgent(env), readDate(flags));
      writeLine(formatTick(result));
      return;
    }
    case "approve":
    case "reject": {
      const id = positionals[0];
      if (!id) throw new Error(`Usage: pnpm replenish ${command} <id>`);
      const result = await resolveApproval(openAgent(env), id, command, readDate(flags));
      writeLine(formatResolution(result));
      return;
    }
    case "adjust":
      adjust(env, flags, writeLine);
      return;
    case "refill":
      refill(env, flags, writeLine);
      return;
    case "remaining":
      remaining(env, flags, writeLine);
      return;
    default:
      throw new Error(`Unknown command "${command}". Run: pnpm replenish help`);
  }
}

function initHousehold(env: NodeJS.ProcessEnv, flags: Flags, writeLine: WriteLine): void {
  const file = householdPath(env);
  if (existsSync(file) && flags.get("force") !== true) {
    throw new Error(`Household already exists at ${file}. Pass --force to replace it.`);
  }
  new JsonHouseholdRepository(file).save(buildPipHousehold());
  writeLine(`Wrote ${file}`);
  writeLine("Pip the cockapoo has a 4 kg bag of Royal Canin Small Adult that is due for a check today.");
  writeLine("Next: pnpm replenish status");
  writeLine("      pnpm replenish tick");
}

function adjust(env: NodeJS.ProcessEnv, flags: Flags, writeLine: WriteLine): void {
  const multiplier = Number(required(flags, "multiplier"));
  const startDate = required(flags, "from");
  const endDate = required(flags, "to");
  const reason = required(flags, "reason");
  assertIsoDate(startDate);
  assertIsoDate(endDate);
  const sourceFlag = flags.get("source");
  const source = sourceFlag === true || sourceFlag === undefined ? "manual" : sourceFlag;
  if (source !== "manual" && source !== "llm") {
    throw new Error('source must be "manual" or "llm"');
  }
  const deps = openAgent(env);
  const state = deps.household.load();
  const current = findSupply(state, optional(flags, "supply"));
  const adjustment = {
    id: createId("adj"),
    startDate,
    endDate,
    multiplier,
    reason,
    source,
  } as const;
  replaceSupply(state, applyUsageAdjustment(current, adjustment));
  deps.household.save(state);
  writeLine(`Recorded ${adjustment.id} on ${current.id}: ${multiplier}x, ${startDate} to ${endDate}.`);
  writeLine("The next tick uses it. A later milestone can write these from an LLM.");
}

function refill(env: NodeJS.ProcessEnv, flags: Flags, writeLine: WriteLine): void {
  const grams = Number(required(flags, "grams"));
  const date = readDate(flags);
  const note = optional(flags, "note");
  const deps = openAgent(env);
  const state = deps.household.load();
  const current = findSupply(state, optional(flags, "supply"));
  const entry = { id: createId("ref"), date, grams, ...(note ? { note } : {}) };
  replaceSupply(state, logRefill(current, entry));
  deps.household.save(state);
  writeLine(`Logged refill ${entry.id}: ${grams} g on ${date}.`);
}

function remaining(env: NodeJS.ProcessEnv, flags: Flags, writeLine: WriteLine): void {
  const grams = Number(required(flags, "grams"));
  const date = readDate(flags);
  const deps = openAgent(env);
  const state = deps.household.load();
  const current = findSupply(state, optional(flags, "supply"));
  replaceSupply(state, setRemainingAnchor(current, { asOf: date, grams }));
  deps.household.save(state);
  writeLine(`Set remaining to ${grams} g at the start of ${date}.`);
}

function findSupply(state: HouseholdState, id?: string): TrackedSupply {
  if (id) {
    const found = state.supplies.find((supply) => supply.id === id);
    if (!found) throw new Error(`No supply ${id}`);
    return found;
  }
  if (state.supplies.length !== 1) throw new Error("Pass --supply <id>");
  const only = state.supplies[0];
  if (!only) throw new Error("No tracked supply");
  return only;
}

function replaceSupply(state: HouseholdState, supply: TrackedSupply): void {
  const index = state.supplies.findIndex((item) => item.id === supply.id);
  if (index < 0) throw new Error(`No supply ${supply.id}`);
  state.supplies[index] = supply;
}

function readDate(flags: Flags, fallback: IsoDate = todayIso()): IsoDate {
  const value = flags.get("date");
  if (value === undefined || value === true) return fallback;
  assertIsoDate(value);
  return value;
}

function required(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value === true || value.trim() === "") {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

function optional(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined || value === true) return undefined;
  return value;
}

const BOOLEAN_FLAGS = new Set(["force"]);

function readFlags(argv: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (BOOLEAN_FLAGS.has(key) && (next === undefined || next.startsWith("--"))) {
      flags.set(key, true);
      continue;
    }
    if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    flags.set(key, next);
    index += 1;
  }
  return { positionals, flags };
}

function isDirectRun(scriptName: string): boolean {
  const entry = process.argv[1]?.replaceAll("\\", "/");
  return entry !== undefined && entry.endsWith(scriptName);
}

if (isDirectRun("cli.ts")) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
