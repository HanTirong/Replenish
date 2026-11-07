import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Only order references and amounts belong here. Never save tokens or card data. */
export interface PaymentAttempt {
  idempotencyKey: string;
  amountCents: number;
  currency: string;
  sku: string;
  status: "paid" | "failed" | "unknown";
  orderId?: string;
  captureId?: string;
  paidAt?: string;
  attemptId?: string;
  preparedAt?: number;
  authorizationId?: string;
  approvalSnapshot?: string;
  policyHash?: string;
  description?: string;
  phase?: "prepared" | "create" | "found" | "capture" | "verified_paid" | "verified_failed" | "legacy";
  createRequestId?: string;
  captureRequestId?: string;
  createFirstSentAt?: number;
  captureFirstSentAt?: number;
  createDigest?: string;
  captureDigest?: string;
  sourceFingerprint?: string;
  contextFingerprint?: string;
  replayBlocked?: boolean;
  replayCount?: number;
  lastReplayAt?: number;
  leaseOwner?: string;
  leaseUntil?: number;
  remoteApproved?: boolean;
  /** Incremented on every journal mutation; delayed responses must match this version. */
  revision?: number;
  responseMismatch?: boolean;
}

export interface PaymentAttemptStore {
  load(key: string): PaymentAttempt | null;
  save(attempt: PaymentAttempt): void;
  transaction<T>(work: () => T): T;
}

export class MemoryPaymentAttemptStore implements PaymentAttemptStore {
  private readonly attempts = new Map<string, PaymentAttempt>();
  load(key: string) { return this.attempts.has(key) ? { ...this.attempts.get(key)! } : null; }
  save(attempt: PaymentAttempt) { this.attempts.set(attempt.idempotencyKey, { ...attempt }); }
  transaction<T>(work: () => T): T { return work(); }
}

export class FilePaymentAttemptStore implements PaymentAttemptStore {
  constructor(private readonly directory: string) {}
  private file(key: string) { return path.join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`); }
  load(key: string): PaymentAttempt | null {
    try {
      const value = JSON.parse(readFileSync(this.file(key), "utf8")) as PaymentAttempt;
      if (value.idempotencyKey !== key || !Number.isSafeInteger(value.amountCents) ||
        !["paid", "failed", "unknown"].includes(value.status)) throw new Error("Invalid payment attempt record. Payment remains on hold.");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  save(attempt: PaymentAttempt): void {
    mkdirSync(this.directory, { recursive: true });
    const file = this.file(attempt.idempotencyKey);
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(attempt), { mode: 0o600 });
    renameSync(temporary, file);
  }
  transaction<T>(work: () => T): T { return work(); }
}

/** The API passes its household connection so order claims and attempts commit together. */
export interface AttemptDatabase {
  exec(sql: string): void;
  get<T>(sql: string, params?: SQLInputValue[]): T | undefined;
  run(sql: string, params?: SQLInputValue[]): void;
}

export class SqlitePaymentAttemptStore implements PaymentAttemptStore {
  constructor(private readonly db: AttemptDatabase) {
    db.exec(`CREATE TABLE IF NOT EXISTS payment_attempts (
      attempt_id TEXT PRIMARY KEY, business_key TEXT NOT NULL, data_json TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS payment_attempt_heads (
      business_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL
    );`);
  }
  load(key: string): PaymentAttempt | null {
    const row = this.db.get<{ data_json: string }>(`SELECT a.data_json FROM payment_attempt_heads h
      JOIN payment_attempts a ON a.attempt_id=h.attempt_id WHERE h.business_key=?`, [key]);
    return row ? JSON.parse(row.data_json) as PaymentAttempt : null;
  }
  save(attempt: PaymentAttempt): void {
    const id = attempt.attemptId ?? `legacy-${createHash("sha256").update(attempt.idempotencyKey).digest("hex")}`;
    this.db.run(`INSERT INTO payment_attempts (attempt_id,business_key,data_json) VALUES (?,?,?)
      ON CONFLICT(attempt_id) DO UPDATE SET data_json=excluded.data_json`, [id, attempt.idempotencyKey, JSON.stringify(attempt)]);
    this.db.run(`INSERT INTO payment_attempt_heads (business_key,attempt_id) VALUES (?,?)
      ON CONFLICT(business_key) DO UPDATE SET attempt_id=excluded.attempt_id`, [attempt.idempotencyKey, id]);
  }
  transaction<T>(work: () => T): T {
    // A savepoint also works inside the household's BEGIN IMMEDIATE transaction.
    this.db.exec("SAVEPOINT payment_attempt_write");
    try { const result = work(); this.db.exec("RELEASE payment_attempt_write"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO payment_attempt_write; RELEASE payment_attempt_write"); throw error; }
  }
  /** One-way, idempotent migration. Original files remain intact; absent facts stay absent. */
  importLegacy(directory: string): number {
    if (!existsSync(directory)) return 0;
    return this.transaction(() => {
      let imported = 0;
      for (const file of readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const value = JSON.parse(readFileSync(path.join(directory, file), "utf8")) as PaymentAttempt;
        if (typeof value.idempotencyKey !== "string" || !Number.isSafeInteger(value.amountCents) || value.amountCents <= 0 ||
          typeof value.sku !== "string" || typeof value.currency !== "string" || !["paid", "failed", "unknown"].includes(value.status) ||
          file !== `${createHash("sha256").update(value.idempotencyKey).digest("hex")}.json`) throw new Error("Invalid legacy payment record. Payment remains on hold.");
        if (this.load(value.idempotencyKey)) continue;
        this.save({ idempotencyKey: value.idempotencyKey, amountCents: value.amountCents, currency: value.currency, sku: value.sku,
          status: value.status, phase: "legacy", replayBlocked: true,
          ...(typeof value.orderId === "string" ? { orderId: value.orderId } : {}),
          ...(typeof value.captureId === "string" ? { captureId: value.captureId } : {}),
          ...(typeof value.paidAt === "string" ? { paidAt: value.paidAt } : {}) });
        imported++;
      }
      return imported;
    });
  }
}

/** CLI journal. The HTTP API uses the household database instead. */
export function openPaymentAttemptStore(file: string, legacyDirectory: string): SqlitePaymentAttemptStore {
  mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA busy_timeout=5000");
  const store = new SqlitePaymentAttemptStore({ exec: sql => sqlite.exec(sql),
    get: <T>(sql: string, params: SQLInputValue[] = []) => sqlite.prepare(sql).get(...params) as T | undefined,
    run: (sql, params = []) => { sqlite.prepare(sql).run(...params); } });
  store.importLegacy(legacyDirectory);
  return store;
}
