import { describe, expect, it } from "vitest";

import { generateAiReply, SUBMIT_REPLY_TOOL, type AnthropicLike } from "./generate";
import type { AiStructuredOutput } from "./types";

function clientReturning(input: unknown): AnthropicLike {
  return {
    messages: {
      create: async () => ({
        content: [
          {
            type: "tool_use",
            id: "toolu_test",
            name: "submit_reply",
            input,
          },
        ],
      }),
    } as unknown as AnthropicLike["messages"],
  };
}

async function parse(input: unknown): Promise<AiStructuredOutput> {
  return generateAiReply(
    {
      model: "claude-test",
      systemPrompt: "test",
      conversation: [{ role: "user", content: "hello" }],
    },
    { client: clientReturning(input) },
  );
}

describe("generateAiReply contract", () => {
  it("publishes the closed action and reason enums in the tool schema", () => {
    expect(SUBMIT_REPLY_TOOL.input_schema.properties.action.enum).toEqual([
      "send_reply",
      "escalate",
      "opt_out",
      "close_wrong_number",
      "close_dnc",
      "close_not_interested",
      "deescalate_close",
    ]);
    expect(
      SUBMIT_REPLY_TOOL.input_schema.properties.escalation_reason.enum,
    ).toEqual([
      "hot_lead",
      "price_or_offer",
      "distress",
      "multi_property",
      "call_request",
      "third_party",
      "needs_review",
    ]);
    expect(SUBMIT_REPLY_TOOL.input_schema.properties.sentiment.description).toMatch(
      /Informational only; action controls routing/,
    );
  });

  it.each([
    { action: "send_reply", body: "Would you consider a cash offer?" },
    { action: "escalate", escalation_reason: "hot_lead" },
    { action: "opt_out" },
    { action: "close_wrong_number", wrong_scope: "this_property" },
    { action: "close_dnc" },
    { action: "close_not_interested" },
    { action: "deescalate_close", body: "So sorry to bug you. Are you Sam?" },
  ])("accepts action $action", async (shape) => {
    await expect(
      parse({
        ...shape,
        confidence: 0.9,
        sentiment: "neutral",
      }),
    ).resolves.toMatchObject(shape);
  });

  it.each([
    "opt_out",
    "escalate",
    "close_wrong_number",
    "close_dnc",
    "close_not_interested",
  ])("rejects body on action %s", async (action) => {
    await expect(
      parse({
        action,
        body: "do not send",
        confidence: 0.9,
        sentiment: "neutral",
        ...(action === "escalate" ? { escalation_reason: "needs_review" } : {}),
        ...(action === "close_wrong_number" ? { wrong_scope: "this_property" } : {}),
      }),
    ).rejects.toThrow(/must not include body/);
  });

  it("requires wrong_scope for close_wrong_number", async () => {
    await expect(
      parse({
        action: "close_wrong_number",
        confidence: 0.9,
        sentiment: "neutral",
      }),
    ).rejects.toThrow(/requires wrong_scope/);
  });

  it("requires escalation_reason for escalate", async () => {
    await expect(
      parse({
        action: "escalate",
        confidence: 0.9,
        sentiment: "neutral",
      }),
    ).rejects.toThrow(/requires an escalation_reason/);
  });

  it("sets temperature 0 on the model call", async () => {
    let captured: unknown;
    const client = {
      messages: {
        create: async (args: unknown) => {
          captured = args;
          return {
            content: [
              {
                type: "tool_use",
                id: "toolu_test",
                name: "submit_reply",
                input: {
                  action: "opt_out",
                  confidence: 0.97,
                  sentiment: "neutral",
                },
              },
            ],
          };
        },
      },
    } as unknown as AnthropicLike;

    await generateAiReply(
      {
        model: "claude-test",
        systemPrompt: "test",
        conversation: [{ role: "user", content: "STOP" }],
      },
      { client },
    );

    expect(captured).toMatchObject({ temperature: 0 });
  });
});
