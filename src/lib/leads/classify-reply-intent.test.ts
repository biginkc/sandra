import { describe, expect, it, vi } from "vitest";

import type Anthropic from "@anthropic-ai/sdk";

import { classifyReplyIntent } from "./classify-reply-intent";

function makeAnthropic(responseText: string): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: responseText }],
      }),
    },
  } as unknown as Anthropic;
}

describe("classifyReplyIntent", () => {
  it("returns positive for an interested reply", async () => {
    const result = await classifyReplyIntent(
      "Yes I might be interested, what's your offer?",
      makeAnthropic("positive"),
    );
    expect(result).toBe("positive");
  });

  it("returns negative for a clear disinterest reply", async () => {
    const result = await classifyReplyIntent(
      "Not interested, stop texting me",
      makeAnthropic("negative"),
    );
    expect(result).toBe("negative");
  });

  it("returns neutral for a confused reply", async () => {
    const result = await classifyReplyIntent(
      "Who is this?",
      makeAnthropic("neutral"),
    );
    expect(result).toBe("neutral");
  });

  it("falls back to neutral when model returns unexpected text", async () => {
    const result = await classifyReplyIntent("ok", makeAnthropic("unknown"));
    expect(result).toBe("neutral");
  });

  it("falls back to neutral when content block is missing", async () => {
    const anthropic = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [] }),
      },
    } as unknown as Anthropic;
    const result = await classifyReplyIntent("anything", anthropic);
    expect(result).toBe("neutral");
  });

  it("handles leading/trailing whitespace in model response", async () => {
    const result = await classifyReplyIntent(
      "Yeah let's talk",
      makeAnthropic("  positive  "),
    );
    expect(result).toBe("positive");
  });
});
