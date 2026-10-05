import Anthropic from "@anthropic-ai/sdk";

import { FACTS_PROMPT_V1 } from "./prompt";
import { FACT_FIELDS, type FactsInput, type RawFacts } from "./types";

/**
 * Facts extractor, following src/lib/norma/callback-time-ai.ts: injected Anthropic client, forced
 * tool call, temperature 0, Haiku. The model only proposes; every rule is applied afterwards in
 * validate.ts. Only the summary text and the transcript text are sent (no name, address or phone
 * is ever added by this code). The system prompt is FACTS_PROMPT_V1 (null until approved) and the
 * tool carries no description text: its JSON schema is structural only.
 */
export type AnthropicLike = Pick<Anthropic, "messages">;

export const FACTS_AI_MODEL = "claude-haiku-4-5-20251001";
export const FACTS_TOOL_NAME = "submit_call_facts";
export const SUMMARY_MAX_CHARS = 4_000;
export const TRANSCRIPT_MAX_CHARS = 30_000;

const FIELD_SCHEMA = {
  type: ["object", "null"] as const,
  properties: {
    value: { type: ["string", "null"] as const },
    evidence: { type: ["string", "null"] as const },
  },
  required: ["value", "evidence"],
};

const TOOL = {
  name: FACTS_TOOL_NAME,
  input_schema: {
    type: "object" as const,
    properties: Object.fromEntries(FACT_FIELDS.map((f) => [f, FIELD_SCHEMA])),
    required: [...FACT_FIELDS],
  },
};

export type FactsExtraction = { facts: RawFacts; model: string };
export type FactsExtractor = (input: FactsInput, ctx: { referenceDate: string; signal?: AbortSignal }) => Promise<FactsExtraction>;

/** The exact text the model sees and that evidence is validated against. */
export function prepareFactsInput(input: FactsInput): FactsInput {
  return {
    summary: input.summary ? input.summary.slice(0, SUMMARY_MAX_CHARS) : null,
    transcript: input.transcript ? input.transcript.slice(0, TRANSCRIPT_MAX_CHARS) : null,
  };
}

/** Throws when no approved prompt is supplied: the extractor never runs on invented text. */
export function createFactsExtractor(client: AnthropicLike, options: { prompt?: string | null } = {}): FactsExtractor {
  const prompt = options.prompt === undefined ? FACTS_PROMPT_V1 : options.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("FACTS_PROMPT_V1 is not approved yet");
  return async (input, { referenceDate, signal }) => {
    const prepared = prepareFactsInput(input);
    const response = await client.messages.create(
      {
        model: FACTS_AI_MODEL,
        max_tokens: 800,
        temperature: 0,
        system: prompt,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content: JSON.stringify({ reference_date: referenceDate, summary: prepared.summary, transcript: prepared.transcript }) }],
      },
      { signal },
    );
    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use" || !block.input || typeof block.input !== "object" || Array.isArray(block.input)) {
      return { facts: {}, model: FACTS_AI_MODEL };
    }
    return { facts: block.input as RawFacts, model: FACTS_AI_MODEL };
  };
}

/** Null (summary note only) when no API key is set or the prompt is not approved yet. */
export function createFactsExtractorFromEnv(
  env: Record<string, string | undefined> = process.env,
  prompt: string | null = FACTS_PROMPT_V1,
): FactsExtractor | null {
  if (!env.ANTHROPIC_API_KEY?.trim()) return null;
  if (typeof prompt !== "string" || prompt.trim() === "") return null;
  return createFactsExtractor(new Anthropic({ maxRetries: 0 }), { prompt });
}
