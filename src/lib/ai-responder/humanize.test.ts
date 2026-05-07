import { describe, expect, it, vi } from "vitest";

import {
  HUMANIZER_SYSTEM_PROMPT,
  humanizeReply,
  type AnthropicLike,
} from "./humanize";

function mockClient(
  fn: (req: Parameters<AnthropicLike["messages"]["create"]>[0]) => unknown,
): AnthropicLike {
  return {
    messages: {
      create: vi.fn(fn) as unknown as AnthropicLike["messages"]["create"],
    },
  } as unknown as AnthropicLike;
}

function textResponse(text: string) {
  return {
    content: [{ type: "text", text }],
  };
}

describe("humanizeReply — success path", () => {
  it("returns the rewritten body when API returns clean text", async () => {
    const client = mockClient(() =>
      textResponse("Awesome, appreciate you confirming. Open to a cash offer if the number worked?"),
    );
    const out = await humanizeReply(
      { draft: "Great — thanks for confirming! What's your motivation to sell?", model: "claude-haiku-4-5-20251001" },
      { client },
    );
    expect(out).toBe(
      "Awesome, appreciate you confirming. Open to a cash offer if the number worked?",
    );
  });

  it("trims surrounding whitespace from the API output", async () => {
    const client = mockClient(() => textResponse("\n\n  hello there  \n"));
    const out = await humanizeReply(
      { draft: "Hi there!", model: "test-model" },
      { client },
    );
    expect(out).toBe("hello there");
  });

  it("strips a 'Here's the rewrite:' preamble", async () => {
    const client = mockClient(() =>
      textResponse("Here's the rewrite: All good, my number's here if anything changes."),
    );
    const out = await humanizeReply(
      { draft: "Sounds good — feel free to reach out!", model: "test-model" },
      { client },
    );
    expect(out).toBe("All good, my number's here if anything changes.");
  });

  it("strips wrapping double quotes", async () => {
    const client = mockClient(() =>
      textResponse('"Sorry for the cold text. If it is not a fit just say so."'),
    );
    const out = await humanizeReply(
      { draft: "Apologies for the cold text — please advise.", model: "test-model" },
      { client },
    );
    expect(out).toBe(
      "Sorry for the cold text. If it is not a fit just say so.",
    );
  });
});

describe("humanizeReply — fallback path (NEVER drops a message)", () => {
  it("returns the original draft when API throws", async () => {
    const client = mockClient(() => {
      throw new Error("network down");
    });
    const out = await humanizeReply(
      { draft: "Original draft body.", model: "test-model" },
      { client },
    );
    expect(out).toBe("Original draft body.");
  });

  it("returns the original draft when API rejects", async () => {
    const client = mockClient(() => Promise.reject(new Error("rate limited")));
    const out = await humanizeReply(
      { draft: "Original draft body.", model: "test-model" },
      { client },
    );
    expect(out).toBe("Original draft body.");
  });

  it("returns the original when API returns empty content", async () => {
    const client = mockClient(() => ({ content: [] }));
    const out = await humanizeReply(
      { draft: "Original draft.", model: "test-model" },
      { client },
    );
    expect(out).toBe("Original draft.");
  });

  it("returns the original when API returns a non-text block (tool_use)", async () => {
    const client = mockClient(() => ({
      content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
    }));
    const out = await humanizeReply(
      { draft: "Original draft.", model: "test-model" },
      { client },
    );
    expect(out).toBe("Original draft.");
  });

  it("returns the original when humanized output is too short", async () => {
    const client = mockClient(() => textResponse("ok"));
    const out = await humanizeReply(
      { draft: "Original draft body that is long enough.", model: "test-model" },
      { client },
    );
    expect(out).toBe("Original draft body that is long enough.");
  });

  it("returns the original when humanized output is too long", async () => {
    const longText = "a".repeat(400);
    const client = mockClient(() => textResponse(longText));
    const out = await humanizeReply(
      { draft: "Original short draft.", model: "test-model" },
      { client },
    );
    expect(out).toBe("Original short draft.");
  });

  it("returns the empty string for an empty draft (no API call)", async () => {
    const create = vi.fn();
    const client = {
      messages: { create: create as unknown as AnthropicLike["messages"]["create"] },
    } as unknown as AnthropicLike;
    const out = await humanizeReply({ draft: "   ", model: "test-model" }, { client });
    expect(out).toBe("");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("humanizeReply — call shape", () => {
  it("sends the humanizer system prompt with cache_control ephemeral", async () => {
    const create = vi.fn(() => textResponse("rewritten body for testing"));
    const client = {
      messages: { create: create as unknown as AnthropicLike["messages"]["create"] },
    } as unknown as AnthropicLike;
    await humanizeReply(
      { draft: "draft body", model: "claude-haiku-4-5-20251001" },
      { client },
    );
    expect(create).toHaveBeenCalledOnce();
    const calls = create.mock.calls as unknown as Array<
      [
        {
          model: string;
          system: Array<{ text: string; cache_control: { type: string } }>;
          messages: Array<{ role: string; content: string }>;
        },
      ]
    >;
    const callArg = calls[0][0];
    expect(callArg.model).toBe("claude-haiku-4-5-20251001");
    expect(callArg.system[0].text).toBe(HUMANIZER_SYSTEM_PROMPT);
    expect(callArg.system[0].cache_control.type).toBe("ephemeral");
    expect(callArg.messages[0].role).toBe("user");
    expect(callArg.messages[0].content).toContain("draft body");
  });
});

describe("HUMANIZER_SYSTEM_PROMPT — sanity", () => {
  it("forbids em-dashes", () => {
    expect(HUMANIZER_SYSTEM_PROMPT).toMatch(/em-dashes/i);
  });

  it("forbids 'investor'", () => {
    expect(HUMANIZER_SYSTEM_PROMPT).toMatch(/as an investor/i);
  });

  it("forbids 'no-obligation cash offer'", () => {
    expect(HUMANIZER_SYSTEM_PROMPT).toMatch(/no-obligation cash offer/i);
  });

  it("requires contractions", () => {
    expect(HUMANIZER_SYSTEM_PROMPT).toMatch(/contractions/i);
  });

  it("does not itself contain em-dashes", () => {
    expect(HUMANIZER_SYSTEM_PROMPT).not.toMatch(/—/);
    expect(HUMANIZER_SYSTEM_PROMPT).not.toMatch(/–/);
  });
});
