import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataFile } from "./paths";

describe("DATA_DIR", () => {
  it("keeps the historical data directory when DATA_DIR is unset", () => {
    expect(dataFile({}, undefined, "data/replenish.sqlite")).toBe(path.resolve("data/replenish.sqlite"));
    expect(dataFile({}, undefined, "data/household.json")).toBe(path.resolve("data/household.json"));
  });

  it("puts every default file in DATA_DIR and still honors an explicit path", () => {
    const env = { DATA_DIR: "/var/data" };
    expect(dataFile(env, undefined, "data/replenish.sqlite")).toBe(path.resolve("/var/data/replenish.sqlite"));
    expect(dataFile(env, undefined, "data/store.json")).toBe(path.resolve("/var/data/store.json"));
    expect(dataFile(env, undefined, "data/paypal-vault.json")).toBe(path.resolve("/var/data/paypal-vault.json"));
    expect(dataFile(env, "custom/vault.json", "data/paypal-vault.json")).toBe(path.resolve("custom/vault.json"));
  });
});
