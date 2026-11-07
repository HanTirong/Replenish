import { addLocalDays, instantLocalDate } from "./feeding";
import { HttpChatModel, selectLlmProvider, timeoutMsFromEnv, type LlmSelection } from "./llm";
import { feedingConfirmation } from "./feeding-review";

export type MealName = "breakfast" | "dinner";

export type ChatCommand =
  | { type: "feeding_permanent"; gramsPerMeal: number }
  | { type: "skip_meal"; meal: MealName; localDate: string }
  | { type: "temporary_meal"; meal: MealName; localDate: string; grams: number }
  | { type: "actual_intake"; meal: MealName; localDate: string; grams: number }
  | { type: "plan_query" }
  | { type: "undo" }
  | { type: "pause_orders"; until: string }
  | { type: "clarify"; question: string };

export interface ParseContext {
  gramsPerMeal: number;
  /** Daily grams from the model are split across this many meals. Defaults to 2. */
  mealsPerDay?: number;
  timeZone: string;
  now: Date;
}

export interface ChatModel {
  /** Returns parsed JSON only. The model must not decide payment or dates. */
  extract(text: string, context: ParseContext): Promise<unknown>;
}

const CLARIFY = "Which meal, and by how many grams? I won't change the long-term plan without that.";
const PAUSE_CLARIFY = "On which future date should automatic buying resume? Use YYYY-MM-DD. It resumes at 00:00 in your household timezone, on the next background check.";

export class RuleChatParser {
  parse(text: string, context: ParseContext): ChatCommand {
    const confirmation = feedingConfirmation(text, context);
    if (confirmation) return confirmation;
    const trimmed = text.trim();
    const compact = trimmed.replace(/\s+/g, "");

    if (/^(undo|撤销)$/i.test(trimmed)) return { type: "undo" };
    if (/什么时候(补货|下单)/.test(compact) || /when (is|should).*(order|reorder)/i.test(trimmed)) {
      return { type: "plan_query" };
    }
    if (/少喂一点|今天不想吃|a bit less|does not want to eat/i.test(trimmed)) {
      return { type: "clarify", question: CLARIFY };
    }

    const permanentLess = /以后每顿少喂\s*(\d+(?:\.\d+)?)\s*g/i.exec(compact) ??
      /(?:feed|from now on,?)?\s*(\d+(?:\.\d+)?)\s*g less (?:per|each) meal/i.exec(trimmed);
    if (permanentLess?.[1]) {
      const gramsPerMeal = context.gramsPerMeal - Number(permanentLess[1]);
      if (gramsPerMeal <= 0) return { type: "clarify", question: CLARIFY };
      return { type: "feeding_permanent", gramsPerMeal };
    }

    const permanentSet = /以后每顿\s*(\d+(?:\.\d+)?)\s*g/i.exec(compact);
    if (permanentSet?.[1]) return { type: "feeding_permanent", gramsPerMeal: Number(permanentSet[1]) };

    const daily = /(\d+(?:\.\d+)?)\s*g\s+a\s+day/i.exec(trimmed);
    if (daily?.[1]) {
      const gramsPerMeal = Number(daily[1]) / mealsPerDay(context);
      if (!Number.isFinite(gramsPerMeal) || gramsPerMeal <= 0) return { type: "clarify", question: CLARIFY };
      return { type: "feeding_permanent", gramsPerMeal };
    }

    if (/明天晚饭不喂|明天晚饭跳过|\bskips?\b(?:\s+\S+){0,3}\s+dinner\s+tomorrow\b/i.test(trimmed)) {
      return { type: "skip_meal", meal: "dinner", localDate: tomorrow(context) };
    }

    const pause = /^(?:please\s+)?pause\s+(?:orders|autopilot|automatic buying)\s+until\s+(.+?)[.!]?$/i.exec(trimmed)?.[1] ??
      /^(?:请)?暂停(?:自动)?(?:补货|下单|购买)?(?:到|至)(.+?)[。！!]?$/i.exec(compact)?.[1];
    if (pause !== undefined) {
      const until = pauseDate(pause, context);
      return until ? { type: "pause_orders", until } : { type: "clarify", question: PAUSE_CLARIFY };
    }

    const temporary = /明天晚饭少喂\s*(\d+(?:\.\d+)?)\s*g/i.exec(compact);
    if (temporary?.[1]) {
      const grams = context.gramsPerMeal - Number(temporary[1]);
      if (grams < 0) return { type: "clarify", question: CLARIFY };
      return { type: "temporary_meal", meal: "dinner", localDate: tomorrow(context), grams };
    }

    if (/今天午饭只吃了一半|ate half of (?:breakfast|lunch) today/i.test(trimmed)) {
      return {
        type: "actual_intake",
        meal: "breakfast",
        localDate: instantLocalDate(context.now, context.timeZone),
        grams: context.gramsPerMeal / 2,
      };
    }

    return { type: "clarify", question: CLARIFY };
  }
}

export class RoutingChatParser {
  constructor(
    private readonly model: ChatModel | null,
    private readonly rules = new RuleChatParser(),
    private readonly onModelError?: (error: Error) => void,
  ) {}

  async parse(text: string, context: ParseContext): Promise<ChatCommand> {
    const confirmation = feedingConfirmation(text, context);
    if (confirmation) return confirmation;
    if (this.model) {
      try {
        const extracted = validateCommand(normalizeIntent(await this.model.extract(text, context), context), context);
        if (extracted?.type === "pause_orders" && /\d{1,2}:\d{2}|\bat\s+\d{1,2}(?!\d)|\b\d{1,2}\s*(?:am|pm)\b|\b(?:noon|midnight|morning|afternoon|evening)\b|上午|下午|中午|凌晨|早上|晚上|[0-9一二三四五六七八九十两]+[点时]/i.test(text)) {
          return { type: "clarify", question: PAUSE_CLARIFY };
        }
        if (extracted) return extracted;
        this.onModelError?.(new Error("Model output did not match the intent schema."));
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error("Model request failed");
        this.onModelError?.(wrapped);
      }
    }
    return this.rules.parse(text, context);
  }
}

export interface ChatParserHttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function chatParserFromEnv(
  env: NodeJS.ProcessEnv,
  model?: ChatModel | null,
  http?: ChatParserHttpOptions,
): RoutingChatParser {
  const selection = selectLlmProvider(env);
  if (!selection) return new RoutingChatParser(null);
  return new RoutingChatParser(model ?? httpModel(selection, env, http));
}

export function mealIndex(meal: MealName): number {
  return meal === "breakfast" ? 0 : 1;
}

const TYPE_SYNONYMS: Record<string, ChatCommand["type"]> = {
  feeding_permanent: "feeding_permanent",
  permanent: "feeding_permanent",
  permanent_feeding: "feeding_permanent",
  skip_meal: "skip_meal",
  skip: "skip_meal",
  temporary_meal: "temporary_meal",
  temporary: "temporary_meal",
  actual_intake: "actual_intake",
  actual: "actual_intake",
  plan_query: "plan_query",
  query: "plan_query",
  undo: "undo",
  pause_orders: "pause_orders",
  pause: "pause_orders",
  clarify: "clarify",
};

/**
 * Maps loose model JSON onto the intent schema before validation.
 * `action` becomes `type`. Offsets become household-local dates. Daily grams are split per meal.
 */
export function normalizeIntent(value: unknown, context: ParseContext): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (typeof record.type !== "string") {
    const alias = record.action ?? record.intent ?? record.command;
    if (typeof alias === "string") record.type = alias;
  }
  if (typeof record.type === "string") {
    const key = record.type.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const canonical = TYPE_SYNONYMS[key];
    if (canonical) record.type = canonical;
  }
  if (typeof record.meal === "string") {
    const meal = record.meal.trim().toLowerCase();
    if (meal === "breakfast" || meal === "dinner") record.meal = meal;
  }
  if (typeof record.localDate !== "string" && record.dayOffset !== undefined) {
    const localDate = dayOffset(record.dayOffset, context);
    if (localDate) record.localDate = localDate;
  }
  if (typeof record.until !== "string" && record.untilDayOffset !== undefined && record.untilMonth === undefined && record.untilDay === undefined && record.untilYear === undefined) {
    const until = dayOffset(record.untilDayOffset, context);
    if (until) record.until = until;
  }
  if (!isFiniteNumber(record.gramsPerMeal) && isFiniteNumber(record.gramsPerDay)) {
    record.gramsPerMeal = record.gramsPerDay / mealsPerDay(context);
  }
  return record;
}

export function validateCommand(value: unknown, context: ParseContext): ChatCommand | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "feeding_permanent": {
      const gramsPerMeal = permanentGrams(record, context);
      if (gramsPerMeal === null || gramsPerMeal <= 0) return null;
      return { type: "feeding_permanent", gramsPerMeal };
    }
    case "skip_meal": {
      if (!isMeal(record.meal)) return null;
      const localDate = dateField(record, context);
      if (!localDate) return null;
      return { type: "skip_meal", meal: record.meal, localDate };
    }
    case "temporary_meal":
    case "actual_intake": {
      if (!isMeal(record.meal) || !isFiniteNumber(record.grams) || record.grams < 0) return null;
      const localDate = dateField(record, context);
      if (!localDate) return null;
      return { type: record.type, meal: record.meal, localDate, grams: record.grams };
    }
    case "pause_orders": {
      const calendar = record.untilMonth !== undefined || record.untilDay !== undefined || record.untilYear !== undefined;
      const until = calendar ? calendarPauseDate(record, context) : record.until !== undefined
        ? typeof record.until === "string" && isLocalDate(record.until) ? record.until : null
        : dayOffset(record.untilDayOffset, context);
      if (!until || until <= instantLocalDate(context.now, context.timeZone)) return { type: "clarify", question: PAUSE_CLARIFY };
      return { type: "pause_orders", until };
    }
    case "undo":
      return { type: "undo" };
    case "plan_query":
      return { type: "plan_query" };
    case "clarify": {
      const question = typeof record.question === "string" && record.question.trim() ? record.question.trim() : CLARIFY;
      return { type: "clarify", question };
    }
    default:
      return null;
  }
}

function httpModel(selection: LlmSelection, env: NodeJS.ProcessEnv, http?: ChatParserHttpOptions): HttpChatModel {
  return new HttpChatModel({
    selection,
    fetch: http?.fetch,
    timeoutMs: timeoutMsFromEnv(env, http?.timeoutMs),
  });
}

function mealsPerDay(context: ParseContext): number {
  return context.mealsPerDay && context.mealsPerDay > 0 ? context.mealsPerDay : 2;
}

function tomorrow(context: ParseContext): string {
  return addLocalDays(instantLocalDate(context.now, context.timeZone), 1);
}

function permanentGrams(record: Record<string, unknown>, context: ParseContext): number | null {
  if (isFiniteNumber(record.gramsPerMeal)) return record.gramsPerMeal;
  if (isFiniteNumber(record.gramsPerDay)) return record.gramsPerDay / mealsPerDay(context);
  return null;
}

function dateField(record: Record<string, unknown>, context: ParseContext): string | null {
  if (typeof record.localDate === "string" && isLocalDate(record.localDate)) return record.localDate;
  return dayOffset(record.dayOffset, context);
}

function isMeal(value: unknown): value is MealName {
  return value === "breakfast" || value === "dinner";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dayOffset(value: unknown, context: ParseContext): string | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return addLocalDays(instantLocalDate(context.now, context.timeZone), value);
}

function calendarPauseDate(record: Record<string, unknown>, context: ParseContext): string | null {
  const year = record.untilYear ?? Number(instantLocalDate(context.now, context.timeZone).slice(0, 4));
  const month = record.untilMonth, day = record.untilDay;
  if (![year, month, day].every(Number.isSafeInteger)) return null;
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isLocalDate(date) ? date : null;
}

function pauseDate(value: string, context: ParseContext): string | null {
  const today = instantLocalDate(context.now, context.timeZone);
  const phrase = value.trim().toLowerCase();
  let date: string | null = null;
  if (/^(next week|下周|下星期)$/.test(phrase)) date = addLocalDays(today, 7);
  else if (/^(tomorrow|明天)$/.test(phrase)) date = addLocalDays(today, 1);
  else if (isLocalDate(phrase)) date = phrase;
  else {
    const chinese = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]?$/.exec(phrase);
    const english = /^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(phrase);
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    if (chinese) date = calendarPauseDate({ untilYear: chinese[1] ? Number(chinese[1]) : undefined, untilMonth: Number(chinese[2]), untilDay: Number(chinese[3]) }, context);
    else if (english) {
      const month = months.findIndex(name => name === english[1] || name.slice(0, 3) === english[1]) + 1;
      date = calendarPauseDate({ untilYear: english[3] ? Number(english[3]) : undefined, untilMonth: month, untilDay: Number(english[2]) }, context);
    }
  }
  return date && date > today ? date : null;
}
