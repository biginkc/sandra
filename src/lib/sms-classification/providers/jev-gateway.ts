import type {
  JevEscalationReason,
  JevOutcome,
  JevReplyIntent,
  JevWrongScope,
  SmsClassificationDecision,
} from "../types";

/** Dependency-injected fetch so tests can stub, matching the
 *  `AnthropicLike`-DI convention in `ai-responder/generate.ts`. */
export type FetchLike = typeof fetch;

export type JevThreadMessage = {
  direction: "inbound" | "outbound";
  body: string;
  sentAt: string;
};

export type JevClassifyInput = {
  conversationId: string;
  /** Chronological, both directions, last ~15 messages. */
  thread: JevThreadMessage[];
  /** Bounded business-state facts relevant to the questions below —
   *  never raw PII beyond what's needed to answer them. */
  state: Record<string, unknown>;
  includeReplyIntent: boolean;
};

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const SCHEMA_VERSION = "1";

const OUTCOME_VALUES: readonly JevOutcome[] = [
  "nurture",
  "not_interested",
  "wrong_number",
  "bad_number",
  "opted_out",
  "dnc",
  "unclear",
];
const WRONG_SCOPE_VALUES: readonly JevWrongScope[] = [
  "this_property",
  "all",
  "not_applicable",
  "uncertain",
];
const ESCALATION_REASON_VALUES: readonly JevEscalationReason[] = [
  "hot_lead",
  "price_or_offer",
  "distress",
  "multi_property",
  "call_request",
  "third_party",
  "needs_review",
  "not_applicable",
  "uncertain",
];
const REPLY_INTENT_VALUES: readonly JevReplyIntent[] = [
  "positive",
  "negative",
  "neutral",
];

function buildQuestions(includeReplyIntent: boolean) {
  const questions: Array<{ id: string; type: "choice"; options: string[] }> =
    [
      { id: "outcome", type: "choice", options: [...OUTCOME_VALUES] },
      { id: "wrong_scope", type: "choice", options: [...WRONG_SCOPE_VALUES] },
      {
        id: "escalation_reason",
        type: "choice",
        options: [...ESCALATION_REASON_VALUES],
      },
    ];
  if (includeReplyIntent) {
    questions.push({
      id: "reply_intent",
      type: "choice",
      options: [...REPLY_INTENT_VALUES],
    });
  }
  return questions;
}

type JevRawAnswer = { choice: string; probabilities?: Record<string, number> };
type JevRawResponse = {
  answers?: Record<string, JevRawAnswer>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export class JevProviderError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "auth"
      | "billing"
      | "rate_limited"
      | "server_error"
      | "timeout"
      | "invalid_response",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "JevProviderError";
  }
}

function classifyHttpFailure(status: number, body: string): JevProviderError {
  if (status === 401) return new JevProviderError("Jev auth failed", "auth", status);
  if (status === 402)
    return new JevProviderError("Jev billing/credits exhausted", "billing", status);
  if (status === 429)
    return new JevProviderError("Jev rate limited", "rate_limited", status);
  if (status >= 500)
    return new JevProviderError(`Jev server error: ${body}`, "server_error", status);
  return new JevProviderError(
    `Jev request failed (${status}): ${body}`,
    "invalid_response",
    status,
  );
}

function readChoice<T extends string>(
  answers: Record<string, JevRawAnswer> | undefined,
  id: string,
  allowed: readonly T[],
): { value: T | null; probabilities: Record<string, number> } {
  const answer = answers?.[id];
  if (!answer || typeof answer.choice !== "string") {
    return { value: null, probabilities: {} };
  }
  const value = allowed.includes(answer.choice as T) ? (answer.choice as T) : null;
  return { value, probabilities: answer.probabilities ?? {} };
}

/**
 * One HTTP call per classification — TypeSafe has no batch endpoint.
 * Bounded retry with exponential backoff on 429/5xx only; auth/billing
 * failures are not retried (retrying a bad key wastes the deadline).
 */
export async function classifyWithJev(
  input: JevClassifyInput,
  deps: {
    fetch: FetchLike;
    apiKey: string;
    maxRetries?: number;
    timeoutMs?: number;
  },
): Promise<SmsClassificationDecision> {
  const maxRetries = deps.maxRetries ?? 2;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const questions = buildQuestions(input.includeReplyIntent);
  const body = JSON.stringify({
    model: JEV_MODEL,
    state: {
      ...input.state,
      thread: input.thread,
    },
    questions,
  });

  let lastErr: JevProviderError | null = null;
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await deps.fetch(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = classifyHttpFailure(res.status, text);
        if (err.kind === "auth" || err.kind === "billing") throw err;
        lastErr = err;
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }

      const json = (await res.json()) as JevRawResponse;
      return parseJevResponse(json, input.includeReplyIntent, Date.now() - startedAt);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof JevProviderError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        lastErr = new JevProviderError("Jev request timed out", "timeout");
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastErr;
      }
      throw e;
    }
  }
  throw lastErr ?? new JevProviderError("Jev request failed", "server_error");
}

function parseJevResponse(
  json: JevRawResponse,
  includeReplyIntent: boolean,
  latencyMs: number,
): SmsClassificationDecision {
  const outcome = readChoice(json.answers, "outcome", OUTCOME_VALUES);
  if (!outcome.value) {
    throw new JevProviderError(
      "Jev response missing or invalid required 'outcome' answer",
      "invalid_response",
    );
  }
  const wrongScope = readChoice(json.answers, "wrong_scope", WRONG_SCOPE_VALUES);
  const escalationReason = readChoice(
    json.answers,
    "escalation_reason",
    ESCALATION_REASON_VALUES,
  );
  const replyIntent = includeReplyIntent
    ? readChoice(json.answers, "reply_intent", REPLY_INTENT_VALUES)
    : { value: null, probabilities: {} };

  const probabilities: Record<string, Record<string, number>> = {
    outcome: outcome.probabilities,
  };
  if (Object.keys(wrongScope.probabilities).length)
    probabilities.wrong_scope = wrongScope.probabilities;
  if (Object.keys(escalationReason.probabilities).length)
    probabilities.escalation_reason = escalationReason.probabilities;
  if (includeReplyIntent && Object.keys(replyIntent.probabilities).length)
    probabilities.reply_intent = replyIntent.probabilities;

  return {
    outcome: outcome.value,
    wrongScope: wrongScope.value,
    escalationReason: escalationReason.value,
    replyIntent: replyIntent.value,
    replyIntentAvailable: includeReplyIntent,
    probabilities,
    provider: "jev",
    model: json.model ?? JEV_MODEL,
    schemaVersion: SCHEMA_VERSION,
    usage:
      json.usage?.input_tokens != null || json.usage?.output_tokens != null
        ? {
            inputTokens: json.usage?.input_tokens ?? null,
            outputTokens: json.usage?.output_tokens ?? null,
          }
        : null,
    latencyMs,
  };
}

function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 250, 4000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
