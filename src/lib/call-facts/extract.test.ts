import { describe, expect, it, vi } from "vitest";

import { createFactsExtractor, createFactsExtractorFromEnv, FACTS_AI_MODEL, FACTS_TOOL_NAME, prepareFactsInput, SUMMARY_MAX_CHARS, TRANSCRIPT_MAX_CHARS } from "./extract";
import { FACTS_PROMPT_V1 } from "./prompt";

// A dummy fixture string: the real extraction prompt is not written yet (FACTS_PROMPT_V1 is null).
const TEST_ONLY_PROMPT = "TEST-ONLY-FIXTURE";

const fake = (content: unknown[]) => {
  const create = vi.fn(async () => ({ content }));
  return { client: { messages: { create } } as never, create };
};
const ctx = { referenceDate: "2026-10-05" };

describe("createFactsExtractor", () => {
  it("ships with no approved prompt: the extractor refuses to build and the env factory is null", () => {
    expect(FACTS_PROMPT_V1).toBeNull();
    expect(() => createFactsExtractor(fake([]).client)).toThrow(/not approved/);
    expect(createFactsExtractorFromEnv({ ANTHROPIC_API_KEY: "k" })).toBeNull();
    expect(createFactsExtractorFromEnv({}, TEST_ONLY_PROMPT)).toBeNull(); // no key
    expect(createFactsExtractorFromEnv({ ANTHROPIC_API_KEY: "  " }, TEST_ONLY_PROMPT)).toBeNull();
  });

  it("forces the submit_call_facts tool at temperature 0 and sends only summary and transcript text", async () => {
    const { client, create } = fake([{ type: "tool_use", name: FACTS_TOOL_NAME, input: { motivation: { value: "a", evidence: "b" } } }]);
    const extract = createFactsExtractor(client, { prompt: TEST_ONLY_PROMPT });
    const out = await extract({ summary: "S", transcript: "T" }, ctx);
    expect(out).toEqual({ facts: { motivation: { value: "a", evidence: "b" } }, model: FACTS_AI_MODEL });
    const [body] = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(body).toMatchObject({ model: FACTS_AI_MODEL, temperature: 0, system: TEST_ONLY_PROMPT, tool_choice: { type: "tool", name: FACTS_TOOL_NAME } });
    expect(JSON.parse((body.messages as { content: string }[])[0].content)).toEqual({ reference_date: "2026-10-05", summary: "S", transcript: "T" });
    const tool = (body.tools as { name: string; description?: string; input_schema: { properties: Record<string, unknown> } }[])[0];
    expect(tool.description).toBeUndefined(); // no rule-like text in the tool definition
    expect(Object.keys(tool.input_schema.properties).sort()).toEqual(["asking_price", "condition", "mortgage", "motivation", "next_step", "timeline"]);
  });

  it("malformed output (no tool call, non-object input) yields no facts", async () => {
    for (const content of [[], [{ type: "text", text: "hi" }], [{ type: "tool_use", name: FACTS_TOOL_NAME, input: "nope" }], [{ type: "tool_use", name: FACTS_TOOL_NAME, input: [1] }]]) {
      const extract = createFactsExtractor(fake(content).client, { prompt: TEST_ONLY_PROMPT });
      expect((await extract({ summary: "S", transcript: null }, ctx)).facts).toEqual({});
    }
  });

  it("truncates the input to bounded lengths, and prepareFactsInput is what the model sees", () => {
    const prepared = prepareFactsInput({ summary: "s".repeat(SUMMARY_MAX_CHARS + 5), transcript: "t".repeat(TRANSCRIPT_MAX_CHARS + 5) });
    expect(prepared.summary).toHaveLength(SUMMARY_MAX_CHARS);
    expect(prepared.transcript).toHaveLength(TRANSCRIPT_MAX_CHARS);
    expect(prepareFactsInput({ summary: null, transcript: null })).toEqual({ summary: null, transcript: null });
  });
});
