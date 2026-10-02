import Anthropic from "@anthropic-ai/sdk";

import type { CallbackAiOutput, CallbackTimeProvider } from "./callback-time";

/**
 * AI fallback for the seller's callback words, using the same vendor and
 * pattern as the rest of Sandra (Anthropic SDK, Haiku, forced tool call,
 * client injected). The model only reads the words and returns a local date
 * and time; every guard (past, horizon, calling hours, confidence) is applied
 * in code afterwards. Only the seller's callback sentence is sent: no name,
 * address, phone or any other lead data.
 */
export type AnthropicLike = Pick<Anthropic, "messages">;

export const CALLBACK_AI_MODEL = "claude-haiku-4-5-20251001";

const TOOL = {
  name: "submit_callback_time",
  description:
    "Return the single local date and time the seller asked to be called back, or nulls when it cannot be pinned down exactly.",
  input_schema: {
    type: "object" as const,
    properties: {
      local_date: { type: ["string", "null"], description: "YYYY-MM-DD in the stated timezone, or null" },
      local_time: { type: ["string", "null"], description: "HH:MM 24-hour in the stated timezone, or null" },
      confidence: { type: "number", description: "0 to 1. Use below 0.8 for anything you had to guess." },
    },
    required: ["local_date", "local_time", "confidence"],
  },
};

const SYSTEM = [
  "You convert a homeowner's words about when to call them back into one concrete local date and time.",
  "Rules: never choose a moment before the reference time. Use the stated timezone. Morning=09:00, afternoon=14:00, evening=17:00.",
  "If the words are vague, ambiguous, give several options, name no day or time, or are not about a callback, return nulls and confidence 0.",
  "Never invent a time the words do not support.",
].join(" ");

export function createAnthropicCallbackTimeProvider(client: AnthropicLike): CallbackTimeProvider {
  return async (input, { signal }): Promise<CallbackAiOutput> => {
    const response = await client.messages.create(
      {
        model: CALLBACK_AI_MODEL,
        max_tokens: 150,
        temperature: 0,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [
          {
            role: "user",
            content: `Reference time: ${input.reference.weekday} ${input.reference.date} ${input.reference.time} (${input.timezone}).\nSeller said: ${JSON.stringify(input.text.slice(0, 500))}`,
          },
        ],
      },
      { signal },
    );
    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") return null;
    const out = block.input as Record<string, unknown>;
    const date = typeof out.local_date === "string" ? out.local_date : null;
    const time = typeof out.local_time === "string" ? out.local_time : null;
    const confidence = typeof out.confidence === "number" ? out.confidence : 0;
    return { local_date: date, local_time: time, confidence };
  };
}

/** Null when no API key is configured: the parser alone is used. */
export function createCallbackTimeProviderFromEnv(env: Record<string, string | undefined> = process.env): CallbackTimeProvider | null {
  if (!env.ANTHROPIC_API_KEY?.trim()) return null;
  return createAnthropicCallbackTimeProvider(new Anthropic({ maxRetries: 0 }));
}
