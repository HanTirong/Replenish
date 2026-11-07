import type { ChatCommand, ParseContext } from "./chat";

// A product confirmation threshold, not a nutritional recommendation.
const CONFIRM_CHANGE_RATIO = 0.3;
const AMOUNT = /(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万点]+)\s*(?:grams?|g|克)(?![a-z])/i;
const PER_MEAL = /每(?:一)?[顿餐]|\b(?:per|each|every|a)\s+meal\b|\/\s*(?:meal|[顿餐])/i;
const PER_DAY = /(?:每[天日]|一天|一日)(?!\s*(?:\d+|[一二两三四五六七八九十]+)\s*[顿餐])|\b(?:per|each|every|a)\s+day\b|\bdaily\b|\/\s*(?:day|天)/i;

function clarification(text: string, context: ParseContext): ChatCommand {
  return { type: "clarify", question: /\p{Script=Han}/u.test(text)
    ? `这是每天的总量，还是每顿的用量？尚未修改。请写完整目标，例如“确认：每天总共85g”或“确认：每天${context.mealsPerDay ?? 2}顿，每顿85g”。`
    : 'Is that the daily total or the amount per meal? No change saved. Send a complete target, such as "Confirm: 85g per day" or "Confirm: 85g per meal".' };
}

/** Full absolute targets are self-contained; a bare yes must never approve a guess. */
export function feedingConfirmation(text: string, context: ParseContext): ChatCommand | null {
  const compact = text.replace(/\s+/g, "");
  const negated = /不要(?:修改|保存)|(?:暂不|不)(?:确认|确定)/.test(compact) || /\b(?:do not|don't)\s+confirm\b/i.test(text);
  if (negated && (AMOUNT.test(text) || /^(?:(?:暂不|不)(?:确认|确定)|do not confirm|don't confirm)[。.!！]?$/i.test(text.trim()))) return clarification(text, context);
  if (/^(?:好的?|是的?|确认|确定|可以|同意|第?[一二两12]个|[12]|yes|ok(?:ay)?|confirm|first|second)[。.!！]?$/i.test(compact)) return clarification(text, context);
  if (!/^(?:(?:确认|确定)(?=\s*[:：，,]|\s*(?:每[天日顿餐]|每一[顿餐]|一天|\d))|confirm\s*:)/i.test(text.trim())) return null;

  // Match the entire target. Do not strip negations, extra clauses or conflicting amounts.
  const target = compact.replace(/^(?:确认|确定)[:：，,]?/, "").replace(/[。.!！]$/, "");
  const daily = /^(?:每天|每日|一天)(?:共|总共|一共|合计|总量)?(?:吃|喂)?(\d+(?:\.\d+)?)(?:g|克)$/i.exec(target);
  const perMeal = /^每(?:一)?[顿餐](?:吃|喂)?(\d+(?:\.\d+)?)(?:g|克)$/i.exec(target);
  const withMeals = /^(?:每天|每日|一天)(\d+|两|二)顿[，,]?每(?:一)?[顿餐](?:吃|喂)?(\d+(?:\.\d+)?)(?:g|克)$/i.exec(target);
  const english = /^confirm\s*:\s*(\d+(?:\.\d+)?)\s*(?:g|grams?)\s*(per day|a day|daily|per meal|each meal)[.!]?$/i.exec(text.trim());
  const meals = context.mealsPerDay ?? 2;
  if (withMeals && Number(withMeals[1]!.replace(/[两二]/, "2")) !== meals) return clarification(text, context);
  const grams = daily ? Number(daily[1]) / meals : perMeal ? Number(perMeal[1]) : withMeals ? Number(withMeals[2])
    : english ? Number(english[1]) / (/meal/i.test(english[2]!) ? 1 : meals) : NaN;
  if (!Number.isFinite(grams) || grams <= 0 || grams > 5000) return clarification(text, context);
  return { type: "feeding_permanent", gramsPerMeal: grams };
}

/** Run inside the existing command transaction, before any feeding or plan write. */
export function reviewFeedingChange(text: string, command: ChatCommand, context: ParseContext): ChatCommand {
  const confirmation = feedingConfirmation(text, context);
  if (confirmation) return confirmation;
  if (command.type !== "feeding_permanent") return command;
  if (!AMOUNT.test(text) || (!PER_MEAL.test(text) && !PER_DAY.test(text))) return clarification(text, context);
  if (Math.abs(command.gramsPerMeal - context.gramsPerMeal) / context.gramsPerMeal < CONFIRM_CHANGE_RATIO) return command;

  const meals = context.mealsPerDay ?? 2;
  const before = context.gramsPerMeal * meals, after = command.gramsPerMeal * meals;
  return { type: "clarify", question: /\p{Script=Han}/u.test(text)
    ? `现在每天${before}g（${meals}顿×${context.gramsPerMeal}g）。按这句话将改为每天${after}g（${meals}顿×${command.gramsPerMeal}g），变化达到30%，尚未修改。若这正是你的意思，请发送“确认：每天总共${after}g”。若你指每顿的用量，请用“确认：每顿…”并写出具体克数。`
    : `Currently ${before}g per day (${meals} meals × ${context.gramsPerMeal}g). This would become ${after}g per day (${meals} meals × ${command.gramsPerMeal}g), a change of at least 30%. No change saved. To apply this daily total, send "Confirm: ${after}g per day". For a per-meal target, send "Confirm: <grams>g per meal" with your intended amount.` };
}
