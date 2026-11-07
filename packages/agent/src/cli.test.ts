import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonHouseholdRepository } from "@replenish/domain";
import { runCli } from "./cli";

describe("CLI", () => {
  it("inits a household, shows status, and auto-pays on tick", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "replenish-cli-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REPLENISH_DATA: path.join(directory, "household.json"),
      STORE_DATA: path.join(directory, "store.json"),
      PAYMENT_PROVIDER: "mock",
    };
    const lines: string[] = [];
    const write = (line = "") => {
      lines.push(line);
    };
    await runCli(["init"], env, write);
    await runCli(["status"], env, write);
    await runCli(["tick"], env, write);
    await runCli(["tick"], env, write);
    const text = lines.join("\n");
    expect(text).toContain("Pip");
    expect(text).toContain("cockapoo");
    expect(text).toContain("auto-paid with MockPaymentProvider");
    expect(text).toContain("waiting on");
    const saved = new JsonHouseholdRepository(env.REPLENISH_DATA!).load();
    expect(saved.replenishments.filter((item) => item.status === "ordered")).toHaveLength(1);

    await runCli(
      ["adjust", "--multiplier", "0", "--from", "2026-11-01", "--to", "2026-11-14", "--reason", "Boarded while traveling"],
      env,
      write,
    );
    const adjusted = new JsonHouseholdRepository(env.REPLENISH_DATA!).load();
    expect(adjusted.supplies[0]?.adjustments[0]?.reason).toBe("Boarded while traveling");
    expect(adjusted.supplies[0]?.adjustments[0]?.source).toBe("manual");
  });
});
