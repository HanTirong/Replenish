import { describe, expect, it } from "vitest";
import { chatParserFromEnv, RoutingChatParser, RuleChatParser, validateCommand, type ChatModel } from "./chat";

const context = {
  gramsPerMeal: 75,
  timeZone: "UTC",
  now: new Date("2026-11-01T08:00:00.000Z"),
};

describe("rule chat parser", () => {
  const rules = new RuleChatParser();

  it.each([
    ["暂停到下周", "2026-11-08"], ["暂停自动补货到明天", "2026-11-02"],
    ["暂停到11月5日", "2026-11-05"], ["暂停下单到2027年1月5日", "2027-01-05"],
    ["pause orders until 2026-11-05", "2026-11-05"], ["Pause orders until November 5.", "2026-11-05"],
  ])("parses a dated pause: %s", (text, until) => {
    expect(rules.parse(text, context)).toEqual({ type: "pause_orders", until });
  });

  it.each(["暂停到今天", "暂停到2026-10-31", "暂停到2026-11-01", "暂停到2026-02-30", "暂停到1月5日", "pause orders until tomorrow at 3pm"])("clarifies invalid, elapsed or unsupported pause dates: %s", text => {
    const command = rules.parse(text, context);
    expect(command.type).toBe("clarify");
    if (command.type === "clarify") expect(command.question).toContain("future date");
  });

  it("resolves relative dates from the household date and validates model calendar parts", () => {
    const local = { ...context, timeZone: "America/Los_Angeles", now: new Date("2026-11-01T00:30:00Z") };
    expect(rules.parse("pause orders until next week", local)).toEqual({ type: "pause_orders", until: "2026-11-07" });
    expect(validateCommand({ type: "pause_orders", untilMonth: 11, untilDay: 5 }, local)).toEqual({ type: "pause_orders", until: "2026-11-05" });
    expect(validateCommand({ type: "pause_orders", untilMonth: 2, untilDay: 30, untilDayOffset: 7 }, local)?.type).toBe("clarify");
    expect(validateCommand({ type: "pause_orders", untilYear: 2028, untilMonth: 2, untilDay: 29 }, local)).toEqual({ type: "pause_orders", until: "2028-02-29" });
    expect(validateCommand({ type: "pause_orders", untilDayOffset: -1 }, local)?.type).toBe("clarify");
  });

  it("parses the demo phrases for a permanent cut, a skipped dinner, and undo", () => {
    expect(rules.parse("以后每顿少喂10g", context)).toEqual({ type: "feeding_permanent", gramsPerMeal: 65 });
    expect(rules.parse("feed 10g less per meal from now on", context)).toEqual({
      type: "feeding_permanent",
      gramsPerMeal: 65,
    });
    expect(rules.parse("明天晚饭不喂", context)).toEqual({
      type: "skip_meal",
      meal: "dinner",
      localDate: "2026-11-02",
    });
    expect(rules.parse("Skip Qizai's dinner tomorrow.", context)).toEqual({
      type: "skip_meal",
      meal: "dinner",
      localDate: "2026-11-02",
    });
    expect(rules.parse("skip dinner tomorrow", context)).toEqual({
      type: "skip_meal",
      meal: "dinner",
      localDate: "2026-11-02",
    });
    expect(rules.parse("undo", context)).toEqual({ type: "undo" });
    expect(rules.parse("少喂一点", context).type).toBe("clarify");
  });

  it("parses the live demo utterances", () => {
    expect(rules.parse("Qizai skips dinner tomorrow", context)).toEqual({
      type: "skip_meal",
      meal: "dinner",
      localDate: "2026-11-02",
    });
    expect(rules.parse("he is eating 130g a day now", { ...context, mealsPerDay: 2 })).toEqual({
      type: "feeding_permanent",
      gramsPerMeal: 65,
    });
    expect(rules.parse("pause orders until next week", context)).toEqual({
      type: "pause_orders",
      until: "2026-11-08",
    });
  });
});

describe("routing chat parser", () => {
  it("resolves model-extracted calendar parts without turning a stated time into midnight", async () => {
    const parser = new RoutingChatParser({ extract: async () => ({ type: "pause_orders", untilMonth: 11, untilDay: 5 }) });
    await expect(parser.parse("暂停自动采购到11月5日", context)).resolves.toEqual({ type: "pause_orders", until: "2026-11-05" });
    for (const text of ["暂停到11月5日下午三点", "pause orders until November 5 at 3pm", "pause orders until November 5 at noon"]) {
      expect((await parser.parse(text, context)).type).toBe("clarify");
    }
  });
  it("uses a valid model extraction and falls back to rules when the model is wrong", async () => {
    const model: ChatModel = {
      async extract(text: string) {
        if (text === "model") return { type: "feeding_permanent", gramsPerMeal: 65 };
        return { type: "delete everything" };
      },
    };
    const parser = new RoutingChatParser(model);
    await expect(parser.parse("model", context)).resolves.toEqual({ type: "feeding_permanent", gramsPerMeal: 65 });
    await expect(parser.parse("以后每顿少喂10g", context)).resolves.toEqual({
      type: "feeding_permanent",
      gramsPerMeal: 65,
    });
  });

  it("does not call a model unless an API key is configured", async () => {
    let called = false;
    const model: ChatModel = {
      async extract() {
        called = true;
        return { type: "undo" };
      },
    };
    const parser = chatParserFromEnv({}, model);
    await parser.parse("undo", context);
    expect(called).toBe(false);
    const live = chatParserFromEnv({ OPENAI_API_KEY: "test-key" }, model);
    await live.parse("ignored", context);
    expect(called).toBe(true);
  });

  it("accepts daily grams and a pause offset from the model", async () => {
    const model: ChatModel = {
      async extract(text: string) {
        if (text.startsWith("he is eating")) return { type: "feeding_permanent", gramsPerDay: 130 };
        return { type: "pause_orders", untilDayOffset: 7 };
      },
    };
    const parser = new RoutingChatParser(model);
    await expect(parser.parse("he is eating 130g a day now", { ...context, mealsPerDay: 2 })).resolves.toEqual({
      type: "feeding_permanent",
      gramsPerMeal: 65,
    });
    await expect(parser.parse("pause orders until next week", context)).resolves.toEqual({
      type: "pause_orders",
      until: "2026-11-08",
    });
  });
});
