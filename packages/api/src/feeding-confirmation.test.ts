import { describe, expect, it, vi } from "vitest";
import type { ChatModel } from "@replenish/domain";
import { SqliteDatabase } from "./db";
import { HouseholdApp } from "./service";

function household(intent: unknown = { type: "feeding_permanent", gramsPerDay: 85 }) {
  const db = new SqliteDatabase(":memory:");
  const extract = vi.fn<ChatModel["extract"]>(async () => intent);
  const charge = vi.fn(async () => ({ paymentId: "simulated" }));
  const options = { db, env: { OPENAI_API_KEY: "test-only" }, model: { extract }, timeZone: "UTC",
    clock: () => new Date("2026-11-01T08:00:00Z"), payments: { charge, query: async () => "not_found" as const } };
  const app = new HouseholdApp(options);
  const state = () => Object.fromEntries(["food_plans", "replenishment_plans", "feeding_events", "revisions", "activities", "jobs", "orders"]
    .map(table => [table, db.all(`SELECT * FROM ${table}`)]));
  return { app, db, options, extract, charge, state };
}

describe("feeding changes that need clarification or confirmation", () => {
  it("keeps food, forecast, revisions and buying untouched until a full target is confirmed", async () => {
    const h = household(), before = h.state();
    const proposed = await h.app.chat("从今天起 每天吃85g", "proposal");
    expect(proposed.receipt?.outcome).toBe("needs_clarification");
    expect(proposed.receipt?.feeding).toBeNull();
    expect(proposed.receipt?.undoRevisionId).toBeNull();
    for (const value of ["每天150g", "每天85g", "42.5g", "尚未修改"]) expect(proposed.reason).toContain(value);
    expect(h.state()).toEqual(before);

    const restarted = new HouseholdApp(h.options);
    const applied = await restarted.chat("确认：每天两顿，每顿85g", "confirmed");
    expect(applied.receipt?.feeding).toEqual({ before: { gramsPerMeal: 75, dailyGrams: 150 }, after: { gramsPerMeal: 85, dailyGrams: 170 } });
    expect(h.extract).toHaveBeenCalledTimes(1);
    expect(await restarted.chat("确认：每天两顿，每顿85g", "confirmed")).toEqual(applied);
    expect(await restarted.chat("从今天起 每天吃85g", "proposal")).toEqual(proposed);
    expect(h.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM revisions")?.count).toBe(1);
    restarted.undo("undo", applied.receipt!.undoRevisionId!);
    expect(restarted.home().feeding).toMatchObject({ gramsPerMeal: 75, dailyGrams: 150 });
    expect(h.charge).not.toHaveBeenCalled();
  });

  it("allows the daily-total interpretation after explicit confirmation without asking again", async () => {
    const h = household();
    await h.app.chat("从今天起每天吃85g");
    const saved = await h.app.chat("确认：每天总共85g");
    expect(saved.receipt?.outcome).toBe("applied");
    expect(h.app.home().feeding).toMatchObject({ gramsPerMeal: 42.5, dailyGrams: 85 });
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it.each(["改成85g", "每天2顿，改成85g", "每天两顿改成85g", "change it to 85g"])("does not trust a model-invented scope: %s", async text => {
    const h = household({ type: "feeding_permanent", gramsPerMeal: 85 }), before = h.state();
    expect((await h.app.chat(text)).receipt?.outcome).toBe("needs_clarification");
    expect(h.state()).toEqual(before);
  });

  it.each(["好的", "确认", "第二个", "2", "yes", "确认：85g", "确认：每顿少10g", "确认：每天3顿，每顿85g", "确认：每顿85g，但不要修改"])("requires a complete absolute confirmation: %s", async text => {
    const h = household(), before = h.state();
    expect((await h.app.chat(text)).receipt?.outcome).toBe("needs_clarification");
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.state()).toEqual(before);
  });

  it.each([
    "确认：每天共85g", "确认每天共85克", "确定：每天总共85g", "确认，每天一共85克。",
    "确定 每天合计 85 g", "确认：每日总量85g", "确认：一天共85g",
  ])("accepts an equivalent complete daily target without a model call: %s", async text => {
    const h = household();
    expect((await h.app.chat(text)).receipt?.feeding?.after).toEqual({ gramsPerMeal: 42.5, dailyGrams: 85 });
    expect(h.extract).not.toHaveBeenCalled();
  });

  it.each(["确定每餐85克", "确认：每一顿85g", "确定每天两顿，每顿85g。", "确认 每天 2 顿 每餐 85 g"])("accepts an equivalent complete per-meal target: %s", async text => {
    const h = household();
    expect((await h.app.chat(text)).receipt?.feeding?.after).toEqual({ gramsPerMeal: 85, dailyGrams: 170 });
    expect(h.extract).not.toHaveBeenCalled();
  });

  it.each([
    "确定", "确认每天共85g，每顿85g", "确认：每天共85g但不要修改", "确定每天共85g，暂不确认",
    "确认每天共85g或者每顿85g", "确定每天3顿每顿85g", "确认每天共0g", "确认每餐5001g",
    "暂不确认每天共85g", "不要修改，每餐85g", "不确定每天共85g", "Do not confirm: 85g per day",
  ])("does not turn incomplete, contradictory or negated confirmation into a write: %s", async text => {
    const h = household(), before = h.state();
    expect((await h.app.chat(text)).receipt?.outcome).toBe("needs_clarification");
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.state()).toEqual(before);
  });

  it.each([105, 195])("asks at exactly a 30%% daily change: %sg", async gramsPerDay => {
    const h = household({ type: "feeding_permanent", gramsPerDay });
    expect((await h.app.chat(`每天吃${gramsPerDay}g`)).receipt?.outcome).toBe("needs_clarification");
    expect(h.app.home().feeding.dailyGrams).toBe(150);
  });

  it("keeps a smaller explicit daily change and the demo's relative cut immediate", async () => {
    const h = household({ type: "feeding_permanent", gramsPerDay: 105.001 });
    expect((await h.app.chat("每天吃105.001g")).receipt?.outcome).toBe("applied");
    const rules = new HouseholdApp({ ...h.options, db: new SqliteDatabase(":memory:"), env: {} });
    expect((await rules.chat("以后每顿少喂10g")).receipt?.feeding?.after).toEqual({ gramsPerMeal: 65, dailyGrams: 130 });
  });

  it("also asks for a large increase from the model-free fallback", async () => {
    const h = household(), app = new HouseholdApp({ ...h.options, env: {} });
    expect((await app.chat("he is eating 300g a day now")).receipt?.outcome).toBe("needs_clarification");
    expect(app.home().feeding.dailyGrams).toBe(150);
    expect((await app.chat("Confirm: 300g per day")).receipt?.outcome).toBe("applied");
    expect(app.home().feeding.dailyGrams).toBe(300);
  });

  it.each([
    "以后每顿少喂10g", "从现在开始，每餐少喂10克", "以后每一顿都比现在减少10克", "今后每顿的量减10g",
    "以后每餐从75克改成65克", "Qizai以后的两顿饭，每顿都少10克", "From now on, feed Qizai 10g less per meal.",
    "Reduce each meal by 10 grams going forward.", "He should get 10g less at every meal from now on.",
  ])("keeps the previously verified explicit phrasing eligible for immediate saving: %s", async text => {
    const h = household({ type: "feeding_permanent", gramsPerMeal: 65 });
    expect((await h.app.chat(text)).receipt?.feeding?.after).toEqual({ gramsPerMeal: 65, dailyGrams: 130 });
  });

  it("rejects a confirmation prepared before a newer household change", async () => {
    const h = household();
    const pending = h.app.chat("确认：每顿85g", "confirm-old");
    h.app.updateFeeding(65);
    await expect(pending).rejects.toThrow(/household changed/);
    expect(h.app.home().feeding.gramsPerMeal).toBe(65);
  });

  it.each(["确认一下什么时候补货", "我不确定什么时候补货"])("keeps ordinary plan questions outside feeding confirmation: %s", async text => {
    const h = household({ type: "plan_query" }), before = h.state();
    expect((await h.app.chat(text)).receipt?.outcome).toBe("answered");
    expect(h.state()).toEqual(before);
  });
});
