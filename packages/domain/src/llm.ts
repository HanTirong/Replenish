import { instantLocalDate } from "./feeding";
import type { ParseContext } from "./chat";

export type LlmProviderId = "deepseek" | "openai" | "anthropic";

export interface LlmSelection {
  provider: LlmProviderId;
  apiKey: string;
  model: string;
  url: string;
}

export const LLM_TIMEOUT_MS = 8_000;

const INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [
        "feeding_permanent",
        "skip_meal",
        "temporary_meal",
        "actual_intake",
        "plan_query",
        "undo",
        "pause_orders",
        "clarify",
      ],
    },
    meal: { type: "string", enum: ["breakfast", "dinner"] },
    dayOffset: { type: "integer" },
    gramsPerMeal: { type: "number" },
    gramsPerDay: { type: "number" },
    grams: { type: "number" },
    untilDayOffset: { type: "integer" },
    untilYear: { type: "integer" },
    untilMonth: { type: "integer" },
    untilDay: { type: "integer" },
    question: { type: "string" },
  },
  required: ["type"],
} as const;

const RELATIVE_FEEDING_GUIDANCE = `For an ongoing per-meal change with an explicit numeric reduction or increase, use the current Household gramsPerMeal as the starting amount and return the resulting absolute gramsPerMeal. A permanent per-meal change applies to every scheduled meal, so do not ask which meal. Do not ask for an absolute target when the current amount and the numeric difference are both known. Clarify when no numeric amount or difference is stated, or the resulting amount would not be positive.
Example: with Household gramsPerMeal=75, Utterance: 以后每顿少喂10g
{"type":"feeding_permanent","gramsPerMeal":65}
Example: with Household gramsPerMeal=75, Utterance: Qizai以后的两顿饭，每顿都少10克
{"type":"feeding_permanent","gramsPerMeal":65}
Example: with Household gramsPerMeal=75, Utterance: Reduce each meal by 10 grams going forward.
{"type":"feeding_permanent","gramsPerMeal":65}
Example: 以后每顿少喂一点
{"type":"clarify","question":"How many grams less per meal?"}`;

const SYSTEM_PROMPT = `Return one JSON object and nothing else. The command field is "type".
The backend applies the command. Do not invent products, prices, payments, or calendar dates. Copy explicit date parts only; the backend resolves them.
Exact JSON schema:
{"type":"feeding_permanent|skip_meal|temporary_meal|actual_intake|plan_query|undo|pause_orders|clarify","meal":"breakfast|dinner","dayOffset":0,"gramsPerMeal":0,"gramsPerDay":0,"grams":0,"untilDayOffset":0,"untilYear":0,"untilMonth":0,"untilDay":0,"question":""}
Omit fields that do not apply. dayOffset and untilDayOffset are whole days from the household local date: 0 is today, 1 is tomorrow, 7 is next week.
feeding_permanent sets gramsPerMeal, or gramsPerDay when the person states grams a day.
Daily total and per-meal amount are different: 每天85g means gramsPerDay=85; 每顿85g means gramsPerMeal=85. Never infer a missing daily/per-meal scope from the current household. For "改成85g" or "change it to 85g", clarify which scope is intended. The backend checks large changes before saving. A bare yes, okay, confirmation, or option number is not a complete feeding instruction; clarify instead of guessing a previous target.
skip_meal, temporary_meal, and actual_intake set meal and dayOffset. temporary_meal and actual_intake also set grams for that one meal.
pause_orders sets untilDayOffset for relative dates (next week means 7 days). For a stated calendar date, copy untilMonth and untilDay, and untilYear only when explicitly stated; do not calculate a day offset or infer a year. The backend validates a future date and resumes at its household-local 00:00. If a time of day is requested, clarify that only date-based pauses are supported; do not silently discard the time. plan_query asks when food will be reordered. undo reverses the last feeding change.
clarify, with a short question, is for a missing meal or amount.
Examples:
Utterance: Qizai skips dinner tomorrow
{"type":"skip_meal","meal":"dinner","dayOffset":1}
Utterance: he is eating 130g a day now
{"type":"feeding_permanent","gramsPerDay":130}
Utterance: pause orders until next week
{"type":"pause_orders","untilDayOffset":7}
Utterance: 暂停到11月5日
{"type":"pause_orders","untilMonth":11,"untilDay":5}
Utterance: pause orders until 2027-01-05
{"type":"pause_orders","untilYear":2027,"untilMonth":1,"untilDay":5}
Utterance: undo
{"type":"undo"}
Utterance: when should we reorder
{"type":"plan_query"}
Utterance: tomorrow dinner is 40g
{"type":"temporary_meal","meal":"dinner","dayOffset":1,"grams":40}
Utterance: he ate 30g of breakfast today
{"type":"actual_intake","meal":"breakfast","dayOffset":0,"grams":30}
Utterance: a bit less
{"type":"clarify","question":"Which meal, and by how many grams?"}`;

/**
 * DeepSeek, then OpenAI, then Anthropic. A blank key is ignored.
 * The returned apiKey is for the Authorization header only. Do not log it.
 */
export function selectLlmProvider(env: NodeJS.ProcessEnv): LlmSelection | null {
  const deepseek = env.DEEPSEEK_API_KEY?.trim();
  if (deepseek) {
    return {
      provider: "deepseek",
      apiKey: deepseek,
      model: env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
      url: joinUrl(env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com", "/chat/completions"),
    };
  }
  const openai = env.OPENAI_API_KEY?.trim();
  if (openai) {
    return {
      provider: "openai",
      apiKey: openai,
      model: env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
      url: joinUrl(env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1", "/chat/completions"),
    };
  }
  const anthropic = env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) {
    return {
      provider: "anthropic",
      apiKey: anthropic,
      model: env.ANTHROPIC_MODEL?.trim() || "claude-3-5-haiku-latest",
      url: joinUrl(env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com", "/v1/messages"),
    };
  }
  return null;
}

export function redactSecrets(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

export function timeoutMsFromEnv(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return override;
  const raw = env.LLM_TIMEOUT_MS?.trim();
  if (!raw) return LLM_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : LLM_TIMEOUT_MS;
}

export interface HttpChatModelOptions {
  selection: LlmSelection;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpChatModel {
  constructor(private readonly options: HttpChatModelOptions) {}

  async extract(text: string, context: ParseContext): Promise<unknown> {
    const selection = this.options.selection;
    const fetchImpl = this.options.fetch ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? LLM_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(selection.url, {
        method: "POST",
        headers: headersFor(selection),
        body: JSON.stringify(bodyFor(selection, text, context)),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`LLM ${selection.provider} HTTP ${response.status}: ${redactSecrets(raw, selection.apiKey)}`);
      }
      return redactValue(readPayload(selection.provider, raw), selection.apiKey);
    } catch (error) {
      if (isAbort(error, controller.signal)) {
        throw new Error(`LLM ${selection.provider} timed out after ${timeoutMs}ms`);
      }
      throw redactError(error, selection.apiKey);
    } finally {
      clearTimeout(timer);
    }
  }
}

function headersFor(selection: LlmSelection): Record<string, string> {
  if (selection.provider === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": selection.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return {
    "content-type": "application/json",
    authorization: `Bearer ${selection.apiKey}`,
  };
}

function bodyFor(selection: LlmSelection, text: string, context: ParseContext): unknown {
  const prompt = userPrompt(text, context);
  if (selection.provider === "anthropic") {
    return {
      model: selection.model,
      max_tokens: 400,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: "record_intent",
          description: "Record the extracted household command.",
          input_schema: INTENT_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: "record_intent" },
      messages: [{ role: "user", content: prompt }],
    };
  }
  return {
    model: selection.model,
    ...(selection.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
    temperature: 0,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: selection.provider === "deepseek" ? `${SYSTEM_PROMPT}\n${RELATIVE_FEEDING_GUIDANCE}` : SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  };
}

function userPrompt(text: string, context: ParseContext): string {
  const meals = context.mealsPerDay && context.mealsPerDay > 0 ? context.mealsPerDay : 2;
  const today = instantLocalDate(context.now, context.timeZone);
  return [
    `Utterance: ${text}`,
    `Household: gramsPerMeal=${context.gramsPerMeal}, mealsPerDay=${meals}, timeZone=${context.timeZone}, localDate=${today}.`,
    "Return the JSON object only.",
  ].join("\n");
}

function readPayload(provider: LlmProviderId, raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`LLM ${provider} returned invalid JSON`);
  }
  if (provider === "anthropic") {
    const content = asRecord(parsed).content;
    if (!Array.isArray(content)) throw new Error("LLM anthropic response had no content");
    const tool = content.find((block) => asRecord(block).type === "tool_use" && asRecord(block).input);
    if (tool) return asRecord(tool).input;
    const text = content.find((block) => asRecord(block).type === "text" && typeof asRecord(block).text === "string");
    if (!text) throw new Error("LLM anthropic response had no intent");
    return parseJsonContent(String(asRecord(text).text));
  }
  const choices = asRecord(parsed).choices;
  const message = Array.isArray(choices) ? asRecord(asRecord(choices[0]).message) : {};
  if (typeof message.content !== "string" || !message.content.trim()) {
    throw new Error(`LLM ${provider} response had no message content`);
  }
  return parseJsonContent(message.content);
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("LLM message content was not JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function redactValue(value: unknown, secret: string): unknown {
  if (typeof value === "string") return redactSecrets(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, secret);
    return out;
  }
  return value;
}

function redactError(error: unknown, secret: string): Error {
  if (error instanceof Error && error.message.startsWith("LLM ") && !error.message.includes(secret)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactSecrets(message, secret));
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "TimeoutError" || (error instanceof Error && /aborted|timeout/i.test(error.message));
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}
