import { dataFile, JsonHouseholdRepository, type HouseholdRepository } from "@replenish/domain";
import { StoreService } from "@replenish/store";
import type { AgentDeps } from "./tick";
import { paymentProviderFromEnv, type PaymentProvider } from "./payments";

export function householdPath(env: NodeJS.ProcessEnv = process.env): string {
  return dataFile(env, env.REPLENISH_DATA, "data/household.json");
}

export function storePath(env: NodeJS.ProcessEnv = process.env): string {
  return dataFile(env, env.STORE_DATA, "data/store.json");
}

export function openAgent(env: NodeJS.ProcessEnv = process.env): AgentDeps & {
  household: HouseholdRepository;
  store: StoreService;
  payments: PaymentProvider;
} {
  return {
    household: new JsonHouseholdRepository(householdPath(env)),
    store: StoreService.open(storePath(env)),
    payments: paymentProviderFromEnv(env),
  };
}
