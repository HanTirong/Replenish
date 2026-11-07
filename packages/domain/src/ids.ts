import { randomBytes } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

/** Stable ids for the demo and tests. Counters are per prefix. */
export function sequentialIds(): (prefix: string) => string {
  const counts = new Map<string, number>();
  return (prefix: string) => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `${prefix}_${String(next).padStart(4, "0")}`;
  };
}
