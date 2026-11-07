import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonHouseholdRepository, MemoryHouseholdRepository } from "./repository";
import type { HouseholdState } from "./types";

function sample(): HouseholdState {
  return {
    version: 1,
    householdName: "Hart",
    pets: [
      {
        id: "pet_pip",
        name: "Pip",
        species: "dog",
        breed: "cockapoo",
        weightKg: 8.6,
        dailyGrams: 200,
      },
    ],
    supplies: [],
    rules: {
      perOrderBudgetCents: 5000,
      monthlyBudgetCents: 12000,
      preferredSku: "RC-SMALL-4",
      bufferDays: 2,
      currency: "USD",
    },
    replenishments: [],
  };
}

describe("household repositories", () => {
  it("round-trips JSON and keeps the caller's object detached", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "replenish-"));
    const repository = new JsonHouseholdRepository(path.join(directory, "household.json"));
    const state = sample();
    repository.save(state);
    state.householdName = "Changed after save";
    expect(repository.load().householdName).toBe("Hart");
  });

  it("clones memory state on load and save", () => {
    const repository = new MemoryHouseholdRepository(sample());
    const loaded = repository.load();
    loaded.rules.bufferDays = 9;
    expect(repository.snapshot().rules.bufferDays).toBe(2);
    repository.save(loaded);
    expect(repository.snapshot().rules.bufferDays).toBe(9);
  });
});
