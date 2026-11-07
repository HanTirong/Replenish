import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HouseholdState } from "./types";

export interface HouseholdRepository {
  load(): HouseholdState;
  save(state: HouseholdState): void;
}

export class MemoryHouseholdRepository implements HouseholdRepository {
  constructor(private state: HouseholdState) {}

  load(): HouseholdState {
    return structuredClone(this.state);
  }

  save(state: HouseholdState): void {
    this.state = structuredClone(state);
  }

  snapshot(): HouseholdState {
    return structuredClone(this.state);
  }
}

export class JsonHouseholdRepository implements HouseholdRepository {
  constructor(private readonly filePath: string) {}

  load(): HouseholdState {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`No household file at ${this.filePath}. Run: pnpm replenish init`);
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as HouseholdState;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.supplies) || !parsed.rules) {
      throw new Error(`Household file at ${this.filePath} is not version 1`);
    }
    return parsed;
  }

  save(state: HouseholdState): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, this.filePath);
  }
}
