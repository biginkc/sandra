import Anthropic from "@anthropic-ai/sdk";

import type {
  AiAction,
  AiEscalationReason,
  AiStructuredOutput,
  AiWrongScope,
} from "./types";

/**
 * Call Claude to generate the next reply + escalation decision.
 *
 * Uses tool-use to force a structured output matching our
 * `AiStructuredOutput` shape — more reliable than asking for JSON in
 * the prompt text. The system prompt is sent with `cache_control:
 * ephemeral` so repeated requests within 5 minutes hit the 90%-off
 * prompt-cache path (meaningful: system prompts are ~800 tokens, so
 * uncached = $0.0008 vs cached = $0.00008 per call).
 *
 * No retries on V1. If the provider call fails or the model returns a
 * malformed tool call, throws — the caller (`dispatch`) catches and
 * escalates instead of sending.
 */

// Dependency-injected client so integration tests can stub.
export type AnthropicLike = Pick<Anthropic, "messages">;

export type GenerateInput = {
  model: string;
  systemPrompt: string;
  /** Conversation history in chronological order. First item is the
   *  oldest message. */
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
};

const AI_ACTIONS_BY_NAME = {
  send_reply: true,
  escalate: true,
  opt_out: true,
  close_wrong_number: true,
  close_not_interested: true,
  deescalate_close: true,
} as const satisfies Record<AiAction, true>;

const AI_ESCALATION_REASONS_BY_NAME = {
  hot_lead: true,
  price_or_offer: true,
  distress: true,
  multi_property: true,
  call_request: true,
  third_party: true,
  needs_review: true,
} as const satisfies Record<AiEscalationReason, true>;

const AI_WRONG_SCOPES_BY_NAME = {
  this_property: true,
  all: true,
} as const satisfies Record<AiWrongScope, true>;

const AI_ACTIONS = Object.keys(AI_ACTIONS_BY_NAME) as AiAction[];
const AI_ESCALATION_REASONS = Object.keys(
  AI_ESCALATION_REASONS_BY_NAME,
) as AiEscalationReason[];
const AI_WRONG_SCOPES = Object.keys(AI_WRONG_SCOPES_BY_NAME) as AiWrongScope[];

export const SUBMIT_REPLY_TOOL = {
  name: "submit_reply",
  description:
    "Submit your structured reply or escalation decision. You MUST call this tool exactly once per response.",
  input_schema: {
    type: "object" as const,
    required: ["action", "confidence", "sentiment"],
    properties: {
      action: {
        type: "string",
        enum: AI_ACTIONS,
        description:
          "send_reply: draft an SMS. escalate: hand off to a human. opt_out/close_*: auto-close without sending. deescalate_close: one fixed system reply, then close.",
      },
      body: {
        type: "string",
        description:
          "Required only when action is send_reply or deescalate_close. Must be under 160 characters.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "How confident you are that this reply is safe, on-topic, and compliant with the system rules. Below 0.70 → the caller will auto-escalate.",
      },
      sentiment: {
        type: "string",
        enum: ["positive", "neutral", "frustrated", "hostile"],
        description:
          "The seller's emotional tone in the inbound message. Informational only; action controls routing.",
      },
      escalation_reason: {
        type: "string",
        enum: AI_ESCALATION_REASONS,
        description:
          "Required only when action='escalate'.",
      },
      wrong_scope: {
        type: "string",
        enum: AI_WRONG_SCOPES,
        description:
          "Required only when action='close_wrong_number'. Use this_property by default; all only when the phone is wrong for everything.",
      },
    },
  },
};

export async function generateAiReply(
  input: GenerateInput,
  deps: { client: AnthropicLike },
): Promise<AiStructuredOutput> {
  const response = await deps.client.messages.create({
    model: input.model,
    max_tokens: 400,
    temperature: 0,
    tools: [SUBMIT_REPLY_TOOL],
    tool_choice: { type: "tool", name: "submit_reply" },
    system: [
      {
        type: "text",
        text: input.systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: input.conversation.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a tool_use block");
  }
  const parsed = toolUse.input as Partial<AiStructuredOutput> & {
    action?: unknown;
    body?: unknown;
    confidence?: unknown;
    escalation_reason?: unknown;
    sentiment?: unknown;
    wrong_scope?: unknown;
  };

  // Light shape validation — the tool schema handles most of this, but
  // we double-check the critical invariants so a malformed input is a
  // clean error rather than a runtime surprise downstream.
  if (
    typeof parsed.action !== "string" ||
    !AI_ACTIONS.includes(parsed.action as AiAction)
  ) {
    throw new Error(`Unexpected action: ${String(parsed.action)}`);
  }
  if (
    (parsed.action === "send_reply" ||
      parsed.action === "deescalate_close") &&
    (typeof parsed.body !== "string" || !parsed.body.trim())
  ) {
    throw new Error(`action=${parsed.action} requires a non-empty body`);
  }
  if (
    parsed.action !== "send_reply" &&
    parsed.action !== "deescalate_close" &&
    typeof parsed.body === "string" &&
    parsed.body.trim().length > 0
  ) {
    throw new Error(`action=${parsed.action} must not include body`);
  }
  if (
    parsed.action === "escalate" &&
    (typeof parsed.escalation_reason !== "string" ||
      !AI_ESCALATION_REASONS.includes(
        parsed.escalation_reason as AiEscalationReason,
      ))
  ) {
    throw new Error("action=escalate requires an escalation_reason");
  }
  if (
    parsed.action !== "escalate" &&
    typeof parsed.escalation_reason === "string" &&
    parsed.escalation_reason.trim().length > 0
  ) {
    throw new Error(`action=${parsed.action} must not include escalation_reason`);
  }
  if (
    parsed.action === "close_wrong_number" &&
    (typeof parsed.wrong_scope !== "string" ||
      !AI_WRONG_SCOPES.includes(parsed.wrong_scope as AiWrongScope))
  ) {
    throw new Error("action=close_wrong_number requires wrong_scope");
  }
  if (
    parsed.action !== "close_wrong_number" &&
    typeof parsed.wrong_scope === "string" &&
    parsed.wrong_scope.trim().length > 0
  ) {
    throw new Error(`action=${parsed.action} must not include wrong_scope`);
  }
  if (
    typeof parsed.confidence !== "number" ||
    parsed.confidence < 0 ||
    parsed.confidence > 1
  ) {
    throw new Error(`Bad confidence: ${parsed.confidence}`);
  }
  if (
    parsed.sentiment !== "positive" &&
    parsed.sentiment !== "neutral" &&
    parsed.sentiment !== "frustrated" &&
    parsed.sentiment !== "hostile"
  ) {
    throw new Error(`Bad sentiment: ${String(parsed.sentiment)}`);
  }

  return parsed as AiStructuredOutput;
}

/** Default client factory — reads `ANTHROPIC_API_KEY` from env.
 *  Callers should pass this into `generateAiReply` via deps in
 *  production code paths. */
export function createAnthropicClient(): Anthropic {
  return new Anthropic();
}

/**
 * Classify a thrown provider error into the two account-level failure
 * modes an operator must act on TODAY, as opposed to transient or
 * code-level failures a retry/deploy fixes:
 *   - "billing": the org is out of API credits — every call fails until
 *     someone adds funds (live incident 2026-06-12: 6 hot replies in the
 *     first campaign hour, zero AI responses, generic generate_error)
 *   - "auth": the API key is invalid/revoked/expired
 * Duck-typed on status + message so it works for the real SDK's
 * APIError and for test stubs alike.
 */
export function classifyProviderFailure(
  err: unknown,
): "billing" | "auth" | null {
  const e = err as
    | {
        status?: unknown;
        message?: unknown;
        error?: { type?: unknown; error?: { type?: unknown } };
      }
    | null;
  // The SDK's APIError carries the structured body: { type: "error",
  // error: { type: "billing_error" | "authentication_error" | ... } }.
  // Trust that FIRST — Anthropic can reword the human message, but the
  // typed enum is the contract. Message regex stays as fallback for
  // older payload shapes and test stubs.
  const structuredType =
    (typeof e?.error?.error?.type === "string" && e.error.error.type) ||
    (typeof e?.error?.type === "string" && e.error.type) ||
    null;
  if (structuredType === "billing_error") return "billing";
  if (structuredType === "authentication_error") return "auth";

  const status = typeof e?.status === "number" ? e.status : null;
  const message = typeof e?.message === "string" ? e.message : "";
  if (status === 401 || /invalid x-api-key|authentication_error/i.test(message)) {
    return "auth";
  }
  if (/credit balance|purchase credits|billing/i.test(message)) {
    return "billing";
  }
  return null;
}
