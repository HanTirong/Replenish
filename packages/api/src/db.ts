import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dataFile } from "@replenish/domain";

export interface SqlDatabase {
  exec(sql: string): void;
  all<T>(sql: string, params?: SQLInputValue[]): T[];
  get<T>(sql: string, params?: SQLInputValue[]): T | undefined;
  run(sql: string, params?: SQLInputValue[]): void;
}

export class SqliteDatabase implements SqlDatabase {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ":memory:") mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  all<T>(sql: string, params: SQLInputValue[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, params: SQLInputValue[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, params: SQLInputValue[] = []): void {
    this.db.prepare(sql).run(...params);
  }
}

/** Swap-in point for Railway Postgres. SQL below stays standard. This build runs SQLite. */
export class PostgresDatabase implements SqlDatabase {
  constructor(private readonly url: string) {}

  private fail(): never {
    throw new Error(
      `DATABASE_URL points at Postgres (${this.url}) but this build runs SQLite. ` +
        "Unset DATABASE_URL or set SQLITE_PATH for local and single-volume deploys.",
    );
  }

  exec(): void {
    this.fail();
  }

  all<T>(): T[] {
    this.fail();
  }

  get<T>(): T | undefined {
    this.fail();
  }

  run(): void {
    this.fail();
  }
}

export function openDatabase(env: NodeJS.ProcessEnv = process.env): SqlDatabase {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl && /^postgres(?:ql)?:/i.test(databaseUrl)) return new PostgresDatabase(databaseUrl);
  return new SqliteDatabase(dataFile(env, env.SQLITE_PATH, "data/replenish.sqlite"));
}

export function migrate(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar_url TEXT,
      timezone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS food_plans (
      pet_id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      meals_per_day INTEGER NOT NULL,
      grams_per_meal REAL NOT NULL,
      meal_minutes_json TEXT NOT NULL,
      stock_g REAL NOT NULL,
      calibrated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feeding_events (
      id TEXT PRIMARY KEY,
      pet_id TEXT NOT NULL,
      type TEXT NOT NULL,
      meal_index INTEGER,
      local_date TEXT,
      grams REAL NOT NULL,
      effective_at TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replenishment_plans (
      pet_id TEXT PRIMARY KEY,
      predicted_runout_at TEXT NOT NULL,
      planned_order_at TEXT NOT NULL,
      candidate_order_at TEXT NOT NULL,
      estimated_delivery_at TEXT NOT NULL,
      delta_hours REAL NOT NULL,
      plan_changed INTEGER NOT NULL,
      risk_override INTEGER NOT NULL,
      decision_code TEXT NOT NULL,
      headline TEXT NOT NULL,
      reason TEXT NOT NULL,
      version INTEGER NOT NULL,
      shipping_hours REAL NOT NULL,
      buffer_hours REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      autopilot TEXT NOT NULL,
      currency TEXT NOT NULL,
      per_order_limit_cents INTEGER NOT NULL,
      monthly_limit_cents INTEGER NOT NULL,
      surface_headline TEXT,
      surface_reason TEXT,
      surface_code TEXT
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      pet_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      merchant TEXT NOT NULL,
      total_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      idempotency_key TEXT,
      payment_id TEXT,
      payment_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      merchant TEXT NOT NULL,
      total_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      violated_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_auth (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      connected INTEGER NOT NULL,
      automatic_payment_authorized INTEGER NOT NULL,
      environment TEXT NOT NULL,
      status TEXT NOT NULL,
      last_verified_at TEXT
    );
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT
    );
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      run_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runtime (
      id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, interval_ms INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'not_checked', last_started_at TEXT, last_finished_at TEXT,
      last_succeeded_at TEXT, next_check_at TEXT, last_result TEXT
    );
    INSERT OR IGNORE INTO agent_runtime (id) VALUES ('household');
    CREATE TABLE IF NOT EXISTS telegram_settings (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      enabled_at TEXT,
      update_offset INTEGER NOT NULL DEFAULT 0,
      last_dispatch_at TEXT,
      command_status TEXT
    );
    INSERT OR IGNORE INTO telegram_settings (id) VALUES ('household');
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      event_key TEXT NOT NULL,
      recipient_tag TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempted_at TEXT,
      sent_at TEXT,
      error_code TEXT
    );
  `);
  addColumn(db, "orders", "payment_note", "TEXT");
  addColumn(db, "idempotency", "request_hash", "TEXT");
  addColumn(db, "approvals", "snapshot_hash", "TEXT");
  addColumn(db, "agent_runtime", "run_id", "TEXT");
  addColumn(db, "settings", "autopilot_resume_at", "TEXT");
  addColumn(db, "telegram_settings", "source_tag", "TEXT");
  addColumn(db, "telegram_settings", "commands_after", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "telegram_settings", "last_command_checked_at", "TEXT");
  addColumn(db, "telegram_settings", "active_session_id", "TEXT");
  addColumn(db, "notification_outbox", "session_id", "TEXT");
  addColumn(db, "orders", "received_at", "TEXT");
  addColumn(db, "orders", "paid_at", "TEXT");
  addColumn(db, "orders", "quantity_grams", "REAL");
  // Existing phone households were seeded at 75g per meal. Later permanent
  // changes are retained as dated feeding events, not applied retroactively.
  addColumn(db, "food_plans", "stock_baseline_grams", "REAL NOT NULL DEFAULT 75");
}

function addColumn(db: SqlDatabase, table: string, column: string, definition: string): void {
  const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
