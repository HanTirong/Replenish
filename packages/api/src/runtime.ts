import type { SqlDatabase } from "./db";
import { randomUUID } from "node:crypto";

interface RuntimeRow {
  enabled: number; interval_ms: number; state: string; last_started_at: string | null;
  last_finished_at: string | null; last_succeeded_at: string | null; next_check_at: string | null; last_result: string | null;
}

/** Records actual scheduler executions; ordinary home reads never advance these timestamps. */
export class AgentRuntime {
  private running: Promise<unknown> | null = null;
  constructor(private db: SqlDatabase, private clock: () => Date) {}
  private row() { return this.db.get<RuntimeRow>("SELECT * FROM agent_runtime WHERE id='household'")!; }
  configure(intervalMs: number) {
    this.db.run("UPDATE agent_runtime SET enabled=?,interval_ms=?,state=CASE WHEN state='running' THEN 'interrupted' ELSE state END,run_id=NULL,next_check_at=? WHERE id='household'", [intervalMs > 0 ? 1 : 0, intervalMs, intervalMs > 0 ? this.clock().toISOString() : null]);
  }
  status() {
    const row = this.row(), now = this.clock().getTime();
    const late = row.next_check_at && now > Date.parse(row.next_check_at) + row.interval_ms;
    const stuck = row.state === "running" && row.last_started_at && now > Date.parse(row.last_started_at) + Math.max(row.interval_ms, 60_000) * 2;
    const state = !row.enabled ? "disabled" : stuck ? "stale" : row.state === "running" ? "running"
      : row.state === "failed" || row.state === "interrupted" ? row.state : late ? "stale" : row.last_succeeded_at ? "waiting" : "not_checked";
    return { enabled: Boolean(row.enabled), state, intervalMs: row.interval_ms, lastStartedAt: row.last_started_at,
      lastFinishedAt: row.last_finished_at, lastSucceededAt: row.last_succeeded_at, nextCheckAt: row.next_check_at, lastResult: row.last_result };
  }
  run<T>(work: () => Promise<T>, decision: () => string): Promise<T | undefined> {
    if (!this.row().enabled) return Promise.resolve(undefined);
    if (this.running) return this.running as Promise<T>;
    this.running = this.execute(work, decision).finally(() => { this.running = null; });
    return this.running as Promise<T>;
  }
  private async execute<T>(work: () => Promise<T>, decision: () => string) {
    const started = this.clock().toISOString();
    const runId = randomUUID();
    const interval = this.row().interval_ms;
    this.db.run("UPDATE agent_runtime SET state='running',run_id=?,last_started_at=?,next_check_at=? WHERE id='household'", [runId, started, new Date(Date.parse(started) + interval).toISOString()]);
    try {
      const result = await work();
      const finished = this.clock().toISOString();
      this.db.run("UPDATE agent_runtime SET state='waiting',last_finished_at=?,last_succeeded_at=?,last_result=? WHERE id='household' AND run_id=?", [finished, finished, decision(), runId]);
      return result;
    } catch (error) {
      this.db.run("UPDATE agent_runtime SET state='failed',last_finished_at=?,last_result='The scheduled check could not complete. Review the household status.' WHERE id='household' AND run_id=?", [this.clock().toISOString(), runId]);
      throw error;
    }
  }
}
