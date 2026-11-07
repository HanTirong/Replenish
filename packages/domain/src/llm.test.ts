import { afterEach, describe, expect, it, vi } from "vitest";
import { chatParserFromEnv, normalizeIntent } from "./chat";
import { LLM_DEMO_UTTERANCES, runLlmDemo } from "./demo-llm";
import { HttpChatModel, selectLlmProvider, timeoutMsFromEnv } from "./llm";

const context = {
  gramsPerMeal: 75,
  mealsPerDay: 2,
  timeZone: "UTC",
  now: new Date("2026-11-01T08:00:00.000Z"),
};

const KEY = "sk-test-deepseek-key";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLM provider selection", () => {
  it("prefers DeepSeek, then OpenAI, then Anthropic", () => {
    expect(selectLlmProvider({})).toBeNull();
    expect(selectLlmProvider({ DEEPSEEK_API_KEY: "  " })).toBeNull();
    expect(selectLlmProvider({ DEEPSEEK_API_KEY: KEY, OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: "sk-anthropic" })).toMatchObject({
      provider: "deepseek",
      model: "deepseek-flash",
      url: "https://api.deepseek.com/chat/completions",
    });
    expect(selectLlmProvider({ OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: "sk-anthropic" })).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
    });
    expect(selectLlmProvider({ ANTHROPIC_API_KEY: "sk-anthropic" })).toMatchObject({
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      url: "https://api.anthropic.com/v1/messages",
    });
  });

  it("defaults the intent request timeout to 8 seconds", () => {
    expect(timeoutMsFromEnv({})).toBe(8000);
    expect(timeoutMsFromEnv({ LLM_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(timeoutMsFromEnv({ LLM_TIMEOUT_MS: "nope" })).toBe(8000);
    expect(timeoutMsFromEnv({ LLM_TIMEOUT_MS: "1500" }, 20)).toBe(20);
  });
});

describe("HTTP intent extraction", () => {
  it("calls DeepSeek in JSON mode and keeps the key out of the body and the logs", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    let captured: { url: string; init: RequestInit } | undefined;
    const parser = chatParserFromEnv(
      { DEEPSEEK_API_KEY: KEY, OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: "sk-anthropic" },
      null,
      {
        fetch: async (input, init) => {
          captured = { url: String(input), init: init ?? {} };
          return json({
            choices: [{ message: { content: JSON.stringify({ type: "skip_meal", meal: "dinner", dayOffset: 1 }) } }],
          });
        },
      },
    );

    await expect(parser.parse("Qizai skips dinner tomorrow", context)).resolves.toEqual({
      type: "skip_meal",
      meal: "dinner",
      localDate: "2026-11-02",
    });

    expect(captured?.url).toBe("https://api.deepseek.com/chat/completions");
    const headers = new Headers(captured?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(captured?.init.body)) as {
      model: string;
      thinking: { type: string };
      max_tokens: number;
      response_format: { type: string };
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe("deepseek-flash");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(400);
    expect(body.messages[0]?.content).toContain("Do not ask for an absolute target");
    expect(body.messages[1]?.content).toContain("gramsPerMeal=75");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]?.content).toContain('"type":"skip_meal"');
    expect(body.messages[0]?.content).toContain('"type":"feeding_permanent"');
    expect(body.messages[0]?.content).toContain('"type":"pause_orders"');
    expect(body.messages[0]?.content).not.toContain('"action"');
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("accepts the live DeepSeek replies that used action or day offsets", async () => {
    const replies = [
      { action: "skip_meal", meal: "dinner", dayOffset: 1 },
      { action: "feeding_permanent", gramsPerDay: 130 },
      { type: "pause_orders", untilDayOffset: 7 },
    ];
    let call = 0;
    const parser = chatParserFromEnv({ DEEPSEEK_API_KEY: KEY }, null, {
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { response_format?: { type: string } };
        expect(body.response_format).toEqual({ type: "json_object" });
        const reply = replies[call] ?? replies[0];
        call += 1;
        return json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
      },
    });

    await expect(parser.parse("Qizai skips dinner tomorrow", context)).resolves.toEqual({
      type: "skip_meal",
      meal: "dinner",
      localDate: "2026-11-02",
    });
    await expect(parser.parse("he is eating 130g a day now", context)).resolves.toEqual({
      type: "feeding_permanent",
      gramsPerMeal: 65,
    });
    await expect(parser.parse("pause orders until next week", context)).resolves.toEqual({
      type: "pause_orders",
      until: "2026-11-08",
    });
  });

  it("resolves offsets in the household timezone and maps feeding_permanent synonyms", () => {
    const losAngeles = {
      ...context,
      timeZone: "America/Los_Angeles",
      now: new Date("2026-11-02T07:30:00.000Z"),
    };
    expect(normalizeIntent({ action: "permanent_feeding", gramsPerDay: 130 }, losAngeles)).toMatchObject({
      type: "feeding_permanent",
      gramsPerMeal: 65,
    });
    expect(normalizeIntent({ action: "skip_meal", meal: "Dinner", dayOffset: 1 }, losAngeles)).toMatchObject({
      type: "skip_meal",
      meal: "dinner",
      localDate: "2026-11-02",
    });
    expect(normalizeIntent({ type: "pause", untilDayOffset: 7 }, losAngeles)).toMatchObject({
      type: "pause_orders",
      until: "2026-11-08",
    });
  });

  it("uses OpenAI JSON mode only when DeepSeek is unset", async () => {
    let url = "";
    let model = "";
    const parser = chatParserFromEnv({ OPENAI_API_KEY: "sk-openai" }, null, {
      fetch: async (input, init) => {
        url = String(input);
        model = (JSON.parse(String(init?.body)) as { model: string }).model;
        expect(JSON.parse(String(init?.body))).not.toHaveProperty("thinking");
        return json({ choices: [{ message: { content: "{\"type\":\"undo\"}" } }] });
      },
    });
    await expect(parser.parse("undo", context)).resolves.toEqual({ type: "undo" });
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(model).toBe("gpt-4o-mini");
  });

  it("keeps genuinely ambiguous input as clarification and uses the existing rule fallback for blank JSON output", async () => {
    const replies = [JSON.stringify({ type: "clarify", question: "How many grams less per meal?" }), "   ",
      JSON.stringify({ type: "feeding_permanent", gramsPerMeal: 65 })];
    const parser = chatParserFromEnv({ DEEPSEEK_API_KEY: KEY }, null, {
      fetch: async () => json({ choices: [{ message: { content: replies.shift() } }] }),
    });
    expect((await parser.parse("以后每顿少喂一点", context)).type).toBe("clarify");
    expect(await parser.parse("以后每顿少喂10g", context)).toEqual({ type: "feeding_permanent", gramsPerMeal: 65 });
    expect(await parser.parse("Qizai以后的两顿饭，每顿都少10克", context)).toEqual({ type: "feeding_permanent", gramsPerMeal: 65 });
  });

  it("uses Anthropic tool output when it is the only key", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const parser = chatParserFromEnv({ ANTHROPIC_API_KEY: "sk-anthropic" }, null, {
      fetch: async (input, init) => {
        captured = { url: String(input), init: init ?? {} };
        return json({
          content: [{ type: "tool_use", name: "record_intent", input: { type: "plan_query" } }],
        });
      },
    });
    await expect(parser.parse("when should we reorder", context)).resolves.toEqual({ type: "plan_query" });
    expect(captured?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(captured?.init.headers);
    expect(headers.get("x-api-key")).toBe("sk-anthropic");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("authorization")).toBeNull();
    const body = JSON.parse(String(captured?.init.body)) as {
      model: string;
      tools: Array<{ name: string }>;
      tool_choice: { name: string };
    };
    expect(body.model).toBe("claude-3-5-haiku-latest");
    expect(body.tools[0]?.name).toBe("record_intent");
    expect(body.tool_choice.name).toBe("record_intent");
    expect(JSON.stringify(body)).not.toContain("sk-anthropic");
  });

  it("accepts fenced JSON and strips a key the model echoes", async () => {
    const model = new HttpChatModel({
      selection: selectLlmProvider({ DEEPSEEK_API_KEY: KEY })!,
      fetch: async () =>
        json({
          choices: [
            {
              message: {
                content: `\`\`\`json\n${JSON.stringify({ type: "clarify", question: `key ${KEY}` })}\n\`\`\``,
              },
            },
          ],
        }),
    });
    await expect(model.extract("hello", context)).resolves.toEqual({ type: "clarify", question: "key [redacted]" });
  });

  it("redacts the key from an HTTP error and does not log it", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const model = new HttpChatModel({
      selection: selectLlmProvider({ DEEPSEEK_API_KEY: KEY })!,
      fetch: async () => new Response(`{"error":"${KEY}"}`, { status: 500 }),
    });
    await expect(model.extract("hello", context)).rejects.toThrow(/\[redacted\]/);
    await expect(model.extract("hello", context)).rejects.not.toThrow(new RegExp(KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("falls back to the rule parser on timeout, invalid JSON, and a bad schema", async () => {
    const timedOut = chatParserFromEnv({ DEEPSEEK_API_KEY: KEY }, null, {
      fetch: hangUntilAbort,
      timeoutMs: 20,
    });
    await expect(timedOut.parse("Qizai skips dinner tomorrow", context)).resolves.toEqual({
      type: "skip_meal",
      meal: "dinner",
      localDate: "2026-11-02",
    });

    const invalid = chatParserFromEnv({ DEEPSEEK_API_KEY: KEY }, null, {
      fetch: async () => json({ choices: [{ message: { content: "not json" } }] }),
    });
    await expect(invalid.parse("he is eating 130g a day now", context)).resolves.toEqual({
      type: "feeding_permanent",
      gramsPerMeal: 65,
    });

    const badSchema = chatParserFromEnv({ DEEPSEEK_API_KEY: KEY }, null, {
      fetch: async () => json({ choices: [{ message: { content: JSON.stringify({ type: "delete everything" }) } }] }),
    });
    await expect(badSchema.parse("pause orders until next week", context)).resolves.toEqual({
      type: "pause_orders",
      until: "2026-11-08",
    });
  });

  it("does not call the network when no provider key is set", async () => {
    let called = false;
    const parser = chatParserFromEnv({}, null, {
      fetch: async () => {
        called = true;
        throw new Error("should not be called");
      },
    });
    await expect(parser.parse("undo", context)).resolves.toEqual({ type: "undo" });
    expect(called).toBe(false);
  });
});

describe("pnpm demo:llm", () => {
  const now = new Date("2026-11-01T08:00:00.000Z");

  it("refuses to run and does not call fetch when no key is set", async () => {
    let called = false;
    const lines: string[] = [];
    await expect(
      runLlmDemo({
        env: {},
        now,
        writeLine: (line) => lines.push(line),
        fetch: async () => {
          called = true;
          throw new Error("should not be called");
        },
      }),
    ).rejects.toThrow(/No LLM API key/);
    expect(called).toBe(false);
    expect(lines.join("\n")).toMatch(/DEEPSEEK_API_KEY/);
  });

  it("prints validated commands for the sample utterances", async () => {
    const lines: string[] = [];
    await runLlmDemo({
      env: { DEEPSEEK_API_KEY: KEY },
      now,
      writeLine: (line) => lines.push(line),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        const utterance = body.messages.at(-1)?.content ?? "";
        const command = utterance.includes("skips dinner")
          ? { type: "skip_meal", meal: "dinner", dayOffset: 1 }
          : utterance.includes("130g")
            ? { type: "feeding_permanent", gramsPerDay: 130 }
            : { type: "pause_orders", untilDayOffset: 7 };
        return json({ choices: [{ message: { content: JSON.stringify(command) } }] });
      },
    });
    const text = lines.join("\n");
    expect(text).toContain("Provider deepseek, model deepseek-flash.");
    expect(text).not.toContain(KEY);
    expect(LLM_DEMO_UTTERANCES.every((utterance) => text.includes(utterance))).toBe(true);
    expect(text).toContain(JSON.stringify({ type: "skip_meal", meal: "dinner", localDate: "2026-11-02" }));
    expect(text).toContain(JSON.stringify({ type: "feeding_permanent", gramsPerMeal: 65 }));
    expect(text).toContain(JSON.stringify({ type: "pause_orders", until: "2026-11-08" }));
  });

  it("prints a redacted model error and the rule fallback", async () => {
    const lines: string[] = [];
    await runLlmDemo({
      env: { DEEPSEEK_API_KEY: KEY },
      now,
      timeoutMs: 20,
      writeLine: (line) => lines.push(line),
      fetch: hangUntilAbort,
    });
    const text = lines.join("\n");
    expect(text).toContain("timed out");
    expect(text).toContain("Using the rule parser.");
    expect(text).not.toContain(KEY);
    expect(text).toContain(JSON.stringify({ type: "skip_meal", meal: "dinner", localDate: "2026-11-02" }));
    expect(text).toContain(JSON.stringify({ type: "feeding_permanent", gramsPerMeal: 65 }));
    expect(text).toContain(JSON.stringify({ type: "pause_orders", until: "2026-11-08" }));
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hangUntilAbort(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("missing abort signal"));
      return;
    }
    const abort = () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
