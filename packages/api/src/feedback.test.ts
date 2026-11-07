import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { migrate, SqliteDatabase, type SqlDatabase } from "./db";
import { HouseholdApp } from "./service";
import { createApiServer } from "./http";
import { AgentRuntime } from "./runtime";
import type { ChatModel } from "@replenish/domain";

function household(model?: ChatModel, db: SqlDatabase = new SqliteDatabase(":memory:")) {
  let now = new Date("2026-11-01T08:00:00Z");
  const options = { db, timeZone: "UTC", clock: () => now, env: model ? { OPENAI_API_KEY: "test-only" } : {}, model,
    payments: { query: async () => "not_found" as const, charge: vi.fn(async () => ({ paymentId: "simulated" })) } };
  return { app: new HouseholdApp(options), options, db, at: (instant: string) => { now = new Date(instant); } };
}

describe("committed command receipts", () => {
  it("recovers a lost response after restart without applying a relative cut twice", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "replenish-receipt-")), "state.sqlite");
    const h = household(undefined, new SqliteDatabase(file));
    const first = await h.app.chat("以后每顿少喂10g", "same-request");
    expect(first.receipt?.feeding).toEqual({ before: { gramsPerMeal: 75, dailyGrams: 150 }, after: { gramsPerMeal: 65, dailyGrams: 130 } });
    const restarted = new HouseholdApp({ ...h.options, db: new SqliteDatabase(file) });
    expect(restarted.operationStatus("chat", "same-request")).toEqual({ status: "completed", result: first });
    expect(await restarted.chat("以后每顿少喂10g", "same-request")).toEqual(first);
    expect(restarted.home().feeding.gramsPerMeal).toBe(65);
    await expect(restarted.chat("以后每顿少喂20g", "same-request")).rejects.toThrow(/different request/);
    expect(restarted.home().feeding.gramsPerMeal).toBe(65);
  });

  it("deduplicates concurrent parses of one request and rejects a different request parsed against stale state", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = household({ extract: async () => { await gate; return { type: "feeding_permanent", gramsPerMeal: 65 }; } });
    const a = h.app.chat("cut each meal by 10g", "one"), b = h.app.chat("cut each meal by 10g", "one"), c = h.app.chat("reduce each meal by 10g", "two");
    const rejected = expect(c).rejects.toThrow(/household changed/);
    release(); const [left, right] = await Promise.all([a, b]); await rejected;
    expect(left).toEqual(right); expect(h.app.home().feeding.gramsPerMeal).toBe(65);
    expect(h.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM feeding_events")?.count).toBe(1);
  });

  it("rolls back feeding, revisions and activity if storing the result fails", async () => {
    const db = new SqliteDatabase(":memory:");
    let fail = true;
    const wrapped: SqlDatabase = {
      exec: sql => db.exec(sql), get: (sql, params) => db.get(sql, params), all: (sql, params) => db.all(sql, params),
      run: (sql, params) => { if (fail && sql.startsWith("INSERT INTO idempotency")) throw new Error("Simulated interrupted commit"); db.run(sql, params); },
    };
    const h = household(undefined, wrapped);
    await expect(h.app.chat("以后每顿少喂10g", "interrupted")).rejects.toThrow(/No changes were saved/);
    expect(h.app.home().feeding.gramsPerMeal).toBe(75);
    expect(h.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM revisions")?.count).toBe(0);
    expect(h.app.operationStatus("chat", "interrupted")).toEqual({ status: "unconfirmed" });
    fail = false; await h.app.chat("以后每顿少喂10g", "interrupted"); expect(h.app.home().feeding.gramsPerMeal).toBe(65);
  });

  it("makes Undo recoverable and prevents an old result from undoing a newer change", async () => {
    const h = household();
    const first = await h.app.chat("以后每顿少喂10g", "first");
    const second = await h.app.chat("以后每顿少喂10g", "second");
    expect(() => h.app.undo("old-undo", first.receipt!.undoRevisionId!)).toThrow(/newer change/);
    const undone = h.app.undo("undo-once", second.receipt!.undoRevisionId!);
    expect(h.app.home().feeding.gramsPerMeal).toBe(65);
    expect(new HouseholdApp(h.options).undo("undo-once", second.receipt!.undoRevisionId!)).toEqual(undone);
    expect(h.app.home().feeding.gramsPerMeal).toBe(65);
  });

  it("distinguishes clarification, read-only answers and applied changes whose plan stays unchanged", async () => {
    const h = household();
    const clarify = await h.app.chat("少喂一点", "clarify"); expect(clarify.receipt?.outcome).toBe("needs_clarification"); expect(clarify.receipt?.undoRevisionId).toBeNull();
    const query = await h.app.chat("什么时候补货", "query"); expect(query.receipt?.outcome).toBe("answered"); expect(query.receipt?.undoRevisionId).toBeNull();
    const skip = await h.app.chat("明天晚饭不喂", "skip"); expect(skip.receipt?.outcome).toBe("applied"); expect(skip.receipt?.plan?.changed).toBe(false); expect(skip.receipt?.undoRevisionId).not.toBeNull();
    expect(h.app.operationStatus("chat", "missing")).toEqual({ status: "unconfirmed" });
  });

  it("serves read-only receipt lookup and guaranteed rejection over HTTP", async () => {
    const h = household(), server = createApiServer(h.app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${origin}/v1/chat/operations/id`)).json()).toEqual({ status: "unconfirmed" });
      const post = (text: string) => fetch(`${origin}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "id" }, body: JSON.stringify({ text }) });
      await post("以后每顿少喂10g");
      expect((await (await fetch(`${origin}/v1/chat/operations/id`)).json() as { status: string }).status).toBe("completed");
      const wrong = await post("以后每顿少喂20g"); expect(wrong.status).toBe(400);
      expect((await wrong.json() as { operationStatus: string }).operationStatus).toBe("rejected");
      expect(h.app.home().feeding.gramsPerMeal).toBe(65);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe("real scheduler evidence", () => {
  it("does not fake a run on reads and reports disabled, waiting and overdue checks", async () => {
    const h = household(); expect(h.app.home().agentStatus.state).toBe("disabled");
    h.app.configureScheduler(900_000); expect(h.app.home().agentStatus.lastSucceededAt).toBeNull();
    await h.app.runScheduledCheck();
    const done = h.app.home().agentStatus; expect(done.lastSucceededAt).toBe("2026-11-01T08:00:00.000Z"); expect(done.state).toBe("waiting");
    h.at("2026-11-01T08:10:00Z"); expect(h.app.home().agentStatus.lastSucceededAt).toBe(done.lastSucceededAt);
    h.at("2026-11-01T08:31:00Z"); expect(h.app.home().agentStatus.state).toBe("stale");
    h.app.configureScheduler(0); await h.app.runScheduledCheck(); expect(h.app.home().agentStatus.state).toBe("disabled"); expect(h.app.home().agentStatus.lastSucceededAt).toBe(done.lastSucceededAt);
  });

  it("tracks failures without exposing raw errors or overwriting an earlier success", async () => {
    const db = new SqliteDatabase(":memory:"); migrate(db); const runtime = new AgentRuntime(db, () => new Date("2026-11-01T08:00:00Z"));
    runtime.configure(1000); await runtime.run(async () => [], () => "No order due.");
    await expect(runtime.run(async () => { throw new Error("sensitive transport detail"); }, () => "unused")).rejects.toThrow();
    expect(runtime.status().state).toBe("failed"); expect(JSON.stringify(runtime.status())).not.toContain("sensitive"); expect(runtime.status().lastSucceededAt).not.toBeNull();
  });

  it("serializes checks and marks interruption on restart without accepting the prior run's late result", async () => {
    const db = new SqliteDatabase(":memory:"); migrate(db); const clock = () => new Date("2026-11-01T08:00:00Z");
    const runtime = new AgentRuntime(db, clock); runtime.configure(1000);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const work = vi.fn(async () => { await gate; return []; });
    const a = runtime.run(work, () => "old"), b = runtime.run(work, () => "old");
    expect(runtime.status().state).toBe("running"); expect(work).toHaveBeenCalledTimes(1);
    const restarted = new AgentRuntime(db, clock); restarted.configure(1000); expect(restarted.status().state).toBe("interrupted");
    release(); await Promise.all([a, b]); expect(restarted.status().lastSucceededAt).toBeNull();
    await restarted.run(async () => [], () => "New check completed."); expect(restarted.status().lastResult).toBe("New check completed.");
  });
});
