import type { NormaCompletionPayload, NormaOutcome } from "./types";

/**
 * Pure mapping from a Bland call (webhook payload or get-call response) to a
 * Sandra Norma outcome. Used by BOTH the webhook and the reconciliation sweep
 * so they cannot disagree. Anything that does not map cleanly is `unknown`
 * (which parks the request for a human), never a guess.
 *
 * Contract: these extraction names must be verified against the protected
 * pathway version 27 before release. Runtime passes the configured version and
 * voice through unchanged. The parser supports an omitted pin, but release policy
 * requires the protected version 27. All extraction variables are strings.
 *   call_outcome  leading token + a free-text evidence sentence.
 *   follow_up_preference  free text holding any callback time and timezone
 *                         (there is no ISO time).
 */
export const BLAND_VAR_CALL_OUTCOME = "call_outcome";
export const BLAND_VAR_FOLLOW_UP_PREFERENCE = "follow_up_preference";

/** Every extraction variable the pathway produces; all are stored. */
export const BLAND_EXTRACTION_VARIABLES = [
  "seller_and_property",
  "motivation_and_timeline",
  "ownership_and_occupancy",
  "condition_and_financing",
  "price_expectation",
  "follow_up_preference",
  "call_outcome",
  "qualification_nuances",
  "script_progress",
] as const;

/** Display mapping for the qualification answers (label -> pathway variable). */
export const NORMA_QUALIFICATION_DISPLAY = [
  { label: "Motivation and timing", variable: "motivation_and_timeline" },
  { label: "Condition", variable: "condition_and_financing" },
  { label: "Asking price and flexibility", variable: "price_expectation" },
  { label: "Decision-makers", variable: "ownership_and_occupancy" },
] as const;

/**
 * Exactly the `call_outcome` leading tokens the pathway can emit, and what each
 * means in Sandra. `do_not_contact` is `not_interested`, not DNC (Jarrad's
 * decision). `already_sold` and `unclear` are `unknown` on purpose: a human
 * decides. Any other token is `unknown`.
 */
export const CALL_OUTCOME_TOKEN_MAP: Record<string, NormaOutcome> = {
  do_not_contact: "not_interested",
  not_interested: "not_interested",
  wrong_person: "wrong_number",
  voicemail: "no_answer",
  callback_requested: "callback_requested",
  qualified_review_requested: "reached_no_callback",
  interested_incomplete: "reached_no_callback",
  human_requested: "reached_no_callback",
  already_sold: "unknown",
  unclear: "unknown",
};

/**
 * Fallback when no callback time could be worked out (see `callback-time.ts`,
 * which converts the seller's words, or an exact `callback_time`, before the
 * completion): the callback task is due NOW and the raw text is shown in its
 * description. A converted time, when there is one, always wins over this.
 * Flip to false only if a strict ISO value in the free text should be used for
 * the due time instead.
 */
export const CALLBACK_TASK_DUE_NOW = true;

export type NormaCallInput = {
  status?: unknown;
  completed?: unknown;
  answered_by?: unknown;
  variables?: unknown;
  summary?: unknown;
  error_message?: unknown;
};

export type NormaOutcomeMapping = {
  outcome: NormaOutcome;
  payload: NormaCompletionPayload;
  /** Why it is unknown; for logs/review only. */
  reason?: string;
};

function norm(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, "_") : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** First whitespace-delimited token, lower-cased, with punctuation stripped. */
export function parseCallOutcomeToken(value: unknown): string {
  if (typeof value !== "string") return "";
  const first = value.trim().split(/\s+/)[0] ?? "";
  return first.toLowerCase().replace(/[^a-z_]/g, "");
}

const MAX_QUAL_KEYS = 40;
const MAX_QUAL_VALUE = 2000;

/** Scalar-only, capped copy of the call variables for `qualification`. */
export function sanitizeQualification(variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables).slice(0, MAX_QUAL_KEYS)) {
    if (typeof value === "string") out[key.slice(0, 80)] = value.slice(0, MAX_QUAL_VALUE);
    else if (typeof value === "number" || typeof value === "boolean") out[key.slice(0, 80)] = value;
  }
  return out;
}

const MAX_SUMMARY_LINE = 700;

/** Bland's own summary, then the four qualification answers that were captured. */
export function composeSummary(blandSummary: unknown, variables: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (typeof blandSummary === "string" && blandSummary.trim()) parts.push(blandSummary.trim());
  for (const { label, variable } of NORMA_QUALIFICATION_DISPLAY) {
    const value = variables[variable];
    if (typeof value === "string" && value.trim()) parts.push(`${label}: ${value.trim().slice(0, MAX_SUMMARY_LINE)}`);
  }
  return parts.length ? parts.join("\n").slice(0, 4000) : null;
}

const MAX_FUTURE_MS = 90 * 24 * 60 * 60 * 1000;

/** Only an ISO timestamp with an explicit offset, not in the past, within 90 days. */
export function parseCallbackTime(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  if (Number.isNaN(ms) || ms < now || ms > now + MAX_FUTURE_MS) return null;
  return new Date(ms).toISOString();
}

function unknown(reason: string, payload: NormaCompletionPayload = {}): NormaOutcomeMapping {
  return { outcome: "unknown", payload, reason };
}

export function mapBlandCallToOutcome(call: NormaCallInput, now = Date.now()): NormaOutcomeMapping {
  const status = norm(call.status);
  const answeredBy = norm(call.answered_by);
  const variables = asRecord(call.variables);
  const base: NormaCompletionPayload = {
    summary: composeSummary(call.summary, variables),
    qualification: sanitizeQualification(variables),
  };

  if (call.completed !== true) return unknown("call_not_completed", base);

  const token = parseCallOutcomeToken(variables[BLAND_VAR_CALL_OUTCOME]);
  const mapped: NormaOutcome | null = token && Object.hasOwn(CALL_OUTCOME_TOKEN_MAP, token) ? CALL_OUTCOME_TOKEN_MAP[token]! : null;
  if (token && !mapped) return unknown("unrecognised_call_outcome", base);

  // Bland-confirmed nobody reached (no answer, voicemail or a busy line: the
  // seller never spoke to Norma, so the call-twice retry applies). The pathway may not even have run, so a
  // missing call_outcome is fine here; a pathway outcome describing a
  // conversation contradicts it and is a conflict, not a guess.
  const noAnswerByBland =
    status === "no-answer" || status === "no_answer" || status === "busy" || answeredBy === "no-answer" || answeredBy === "no_answer" || answeredBy === "voicemail";
  if (noAnswerByBland) {
    if (mapped && mapped !== "no_answer") return unknown("conflict_no_answer_vs_outcome", base);
    return { outcome: "no_answer", payload: base };
  }
  if (status === "failed" || status === "canceled" || status === "cancelled") {
    return unknown(`call_${status}`, base);
  }
  if (status && status !== "completed") return unknown("unrecognised_status", base);
  if (answeredBy !== "human") return unknown("answered_by_not_human", base);
  if (!mapped) return unknown("missing_call_outcome", base);
  if (mapped === "unknown") return unknown(`call_outcome_${token}`, base);
  if (mapped === "no_answer") return unknown("conflict_human_answered_vs_voicemail", base);

  if (mapped === "callback_requested") {
    const followRaw = variables[BLAND_VAR_FOLLOW_UP_PREFERENCE];
    const followText = typeof followRaw === "string" ? followRaw.trim().slice(0, 1000) : "";
    return {
      outcome: "callback_requested",
      payload: {
        ...base,
        callback_requested_for: CALLBACK_TASK_DUE_NOW ? null : parseCallbackTime(followText, now),
        callback_timezone: null,
        callback_raw: followText || null,
      },
    };
  }
  return { outcome: mapped, payload: base };
}
