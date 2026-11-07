import { createHash } from "node:crypto";
import type { SqlDatabase } from "./db";

export class OperationRejected extends Error {
  readonly operationStatus = "rejected";
}

/** Application receipts are separate from PayPal request IDs. Only committed changes have receipts. */
export class CommandReceipts {
  constructor(private db: SqlDatabase, private clock: () => Date) {}
  hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  private key(kind: string, id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new OperationRejected("Invalid operation ID. No changes were saved.");
    return `command:${kind}:${id}`;
  }
  lookup<T>(kind: string, id?: string, hash?: string): T | undefined {
    if (!id) return undefined;
    const row = this.db.get<{ response_json: string; request_hash: string | null }>("SELECT response_json,request_hash FROM idempotency WHERE key=?", [this.key(kind, id)]);
    if (row && hash && row.request_hash !== hash) throw new OperationRejected("This operation ID belongs to a different request. No new change was saved.");
    return row ? JSON.parse(row.response_json) as T : undefined;
  }
  status<T>(kind: string, id: string) {
    const result = this.lookup<T>(kind, id);
    return result ? { status: "completed" as const, result } : { status: "unconfirmed" as const };
  }
  commit<T>(kind: string, id: string | undefined, hash: string, apply: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cached = this.lookup<T>(kind, id, hash);
      if (cached) { this.db.exec("COMMIT"); return cached; }
      const result = apply();
      if (id) this.db.run("INSERT INTO idempotency (key,response_json,request_hash,created_at) VALUES (?,?,?,?)", [this.key(kind, id), JSON.stringify(result), hash, this.clock().toISOString()]);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof OperationRejected) throw error;
      const message = error instanceof Error && !("code" in error) ? error.message : "The change could not be saved.";
      throw new OperationRejected(`${message} No changes were saved.`);
    }
  }
}
