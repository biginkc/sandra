import { describe, expect, it, vi } from "vitest";

import { CALLBACK_AI_MODEL, createAnthropicCallbackTimeProvider, createCallbackTimeProviderFromEnv, type AnthropicLike } from "./callback-time-ai";

const input = {
  text: "a week from Monday",
  timezone: "America/Chicago",
  reference: { date: "2026-10-02", time: "15:30", weekday: "Friday" },
};

function client(content: unknown[]) {
  const create = vi.fn().mockResolvedValue({ content });
  return { create, client: { messages: { create } } as unknown as AnthropicLike };
}

describe("Anthropic callback-time provider (client mocked)", () => {
  it("forces the tool call and sends only the seller's words, zone and reference", async () => {
    const { create, client: c } = client([
      { type: "tool_use", name: "submit_callback_time", input: { local_date: "2026-10-12", local_time: "09:00", confidence: 0.9 } },
    ]);
    const signal = new AbortController().signal;
    const out = await createAnthropicCallbackTimeProvider(c)(input, { signal });
    expect(out).toEqual({ local_date: "2026-10-12", local_time: "09:00", confidence: 0.9 });
    const [params, options] = create.mock.calls[0]!;
    expect(params).toMatchObject({ model: CALLBACK_AI_MODEL, temperature: 0, tool_choice: { type: "tool", name: "submit_callback_time" } });
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].content).toContain("a week from Monday");
    expect(params.messages[0].content).toContain("Friday 2026-10-02 15:30 (America/Chicago)");
    expect(options).toEqual({ signal });
  });

  it("returns null without a tool call and coerces malformed fields to nulls", async () => {
    const signal = new AbortController().signal;
    expect(await createAnthropicCallbackTimeProvider(client([{ type: "text", text: "Tuesday" }]).client)(input, { signal })).toBeNull();
    const bad = client([{ type: "tool_use", input: { local_date: 5, local_time: {}, confidence: "high" } }]).client;
    expect(await createAnthropicCallbackTimeProvider(bad)(input, { signal })).toEqual({ local_date: null, local_time: null, confidence: 0 });
  });
});

describe("createCallbackTimeProviderFromEnv", () => {
  it("is null without an API key", () => {
    expect(createCallbackTimeProviderFromEnv({})).toBeNull();
    expect(createCallbackTimeProviderFromEnv({ ANTHROPIC_API_KEY: "  " })).toBeNull();
  });
  it("is a provider with a key (no call is made)", () => {
    expect(typeof createCallbackTimeProviderFromEnv({ ANTHROPIC_API_KEY: "sk-test" })).toBe("function");
  });
});
