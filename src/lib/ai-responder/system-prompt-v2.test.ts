import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { generateAiReply, type AnthropicLike } from "./generate";
import { resolveResponderOutcome } from "./route";
import type { AiStructuredOutput } from "./types";

const PROMPT_PATH = path.resolve(
  __dirname,
  "../../../docs/ai-responder/system-prompt-v2.txt",
);
const prompt = readFileSync(PROMPT_PATH, "utf8");

function clientReturning(input: AiStructuredOutput): AnthropicLike {
  return {
    messages: {
      create: async () => ({
        content: [
          {
            type: "tool_use",
            id: "toolu_prompt_example",
            name: "submit_reply",
            input,
          },
        ],
      }),
    } as unknown as AnthropicLike["messages"],
  };
}

describe("ai responder system prompt v2 artifact", () => {
  it("contains the 16 decision examples from the approved routing contract", () => {
    for (let i = 1; i <= 16; i += 1) {
      expect(prompt).toMatch(new RegExp(`^${i}\\) `, "m"));
    }
  });

  it("pins the high-risk examples to the intended terminal actions", () => {
    expect(prompt).toMatch(/8\) "NOT SELLING\. STOP" -> opt_out/);
    expect(prompt).toMatch(/11\) "please delete my number" -> opt_out/);
    expect(prompt).toMatch(/14\) "I will find you and make you pay" -> close_dnc/);
  });

  it("pins wrong-number examples to the intended scopes", () => {
    expect(prompt).toMatch(/4\) "I don't own that house" -> close_wrong_number, wrong_scope="this_property"/);
    expect(prompt).toMatch(/5\) "You've got the wrong number, I never owned any property" -> close_wrong_number, wrong_scope="all"/);
  });

  it("states that opt-out sends no body and wrong number requires wrong_scope", () => {
    expect(prompt).toMatch(/action = "opt_out"\. DO NOT SEND ANYTHING/);
    expect(prompt).toMatch(/wrong_scope: required ONLY for action=close_wrong_number/);
  });

  it.each([
    [1, { action: "send_reply", body: "Would you consider a cash offer? We buy it as-is, no repairs, and you pocket more without the realtor fees.", confidence: 0.92, sentiment: "positive" }],
    [2, { action: "escalate", escalation_reason: "hot_lead", confidence: 0.95, sentiment: "positive" }],
    [3, { action: "send_reply", body: "Sorry about that. Do you happen to own the property, or know who does?", confidence: 0.88, sentiment: "neutral" }],
    [4, { action: "close_wrong_number", wrong_scope: "this_property", confidence: 0.92, sentiment: "neutral" }],
    [5, { action: "close_wrong_number", wrong_scope: "all", confidence: 0.95, sentiment: "neutral" }],
    [6, { action: "escalate", escalation_reason: "price_or_offer", confidence: 0.95, sentiment: "neutral" }],
    [7, { action: "close_not_interested", confidence: 0.93, sentiment: "neutral" }],
    [8, { action: "opt_out", confidence: 0.97, sentiment: "frustrated" }],
    [9, { action: "send_reply", body: "Your info came up in public property records for the area. Happy to have a teammate explain.", confidence: 0.88, sentiment: "neutral" }],
    [10, { action: "escalate", escalation_reason: "call_request", confidence: 0.95, sentiment: "positive" }],
    [11, { action: "opt_out", confidence: 0.97, sentiment: "neutral" }],
    [12, { action: "deescalate_close", body: "So sorry to bug you. Sounds like you get a lot of these. Are you {first_name}? Just want to make sure we don't bother you again.", confidence: 0.9, sentiment: "frustrated" }],
    [13, { action: "deescalate_close", body: "Sorry about that, didn't mean to bug you. Are you {first_name}? I'll make sure we don't keep texting if not.", confidence: 0.88, sentiment: "hostile" }],
    [14, { action: "close_dnc", confidence: 0.9, sentiment: "hostile" }],
    [15, { action: "deescalate_close", body: "Ha, fair enough. Sorry to bug you. Are you {first_name}? Want to make sure we stop reaching the wrong person.", confidence: 0.85, sentiment: "neutral" }],
    [16, { action: "escalate", escalation_reason: "third_party", confidence: 0.9, sentiment: "neutral" }],
  ] as const)("example %s routes through the schema and router", async (_n, output) => {
    const parsed = await generateAiReply(
      {
        model: "claude-test",
        systemPrompt: prompt,
        conversation: [{ role: "user", content: "fixture" }],
      },
      { client: clientReturning(output) },
    );
    const route = resolveResponderOutcome(parsed);

    if (
      parsed.action === "opt_out" ||
      parsed.action === "close_wrong_number" ||
      parsed.action === "close_dnc" ||
      parsed.action === "close_not_interested" ||
      parsed.action === "escalate"
    ) {
      expect("body" in parsed).toBe(false);
    }
    if (parsed.action === "close_wrong_number") {
      expect(parsed.wrong_scope).toMatch(/^(this_property|all)$/);
    }
    expect(route).toBeTruthy();
  });
});
