import { RoutingChatParser, RuleChatParser, type ParseContext } from "./chat";
import { HttpChatModel, selectLlmProvider, timeoutMsFromEnv } from "./llm";

export const LLM_DEMO_UTTERANCES = [
  "Qizai skips dinner tomorrow",
  "he is eating 130g a day now",
  "pause orders until next week",
] as const;

type Line = (line: string) => void;

export interface LlmDemoOptions {
  env?: NodeJS.ProcessEnv;
  writeLine?: Line;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: Date;
}

/**
 * Sends three sample utterances to the configured provider.
 * Prints the provider and the validated command. On any model error, prints the
 * redacted error and the rule-parser result. Never prints the API key.
 */
export async function runLlmDemo(options: LlmDemoOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const writeLine = options.writeLine ?? console.log;
  const selection = selectLlmProvider(env);
  if (!selection) {
    writeLine("Set DEEPSEEK_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY. No request was sent.");
    throw new Error("No LLM API key is set.");
  }

  writeLine(`Provider ${selection.provider}, model ${selection.model}.`);
  const model = new HttpChatModel({
    selection,
    fetch: options.fetch,
    timeoutMs: timeoutMsFromEnv(env, options.timeoutMs),
  });
  const parser = new RoutingChatParser(model, new RuleChatParser(), (error) => {
    writeLine(`Model error: ${error.message}`);
    writeLine("Using the rule parser.");
  });
  const context: ParseContext = {
    gramsPerMeal: 75,
    mealsPerDay: 2,
    timeZone: "America/Los_Angeles",
    now: options.now ?? new Date(),
  };
  for (const utterance of LLM_DEMO_UTTERANCES) {
    writeLine(`> ${utterance}`);
    const command = await parser.parse(utterance, context);
    writeLine(JSON.stringify(command));
  }
}

function isDirectRun(scriptName: string): boolean {
  const entry = process.argv[1]?.replaceAll("\\", "/");
  return entry !== undefined && entry.endsWith(scriptName);
}

if (isDirectRun("demo-llm.ts")) {
  runLlmDemo().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
