import type { NormaCompletionPayload, NormaOutcome } from "./types";

/**
 * Pure mapping from a Bland call (webhook payload or get-call response) to a
 * Sandra Norma outcome. Used by BOTH the webhook and the reconciliation sweep
 * so they cannot disagree. Anything that does not map cleanly is `unknown`
 * (which parks the request for a human), never a guess.
 *
 * TODO(pathway pin): the variable names and value vocabularies below are the
 * ones the plan says staging pathway 0.0.17 already exposes (`call_outcome`,
 * `follow_up_preference`). They have NOT been confirmed against the pinned
 * pathway version. Confirm every constant here at rehearsal before releasing
 * to real sellers. Do not change the pathway to fit this file.
 */
export const BLAND_VAR_CALL_OUTCOME = "call_outcome";
export const BLAND_VAR_FOLLOW_UP_PREFERENCE = "follow_up_preference";
// TODO(pathway pin): unconfirmed names for an explicit callback time/zone.
export const BLAND_VAR_CALLBACK_TIME_ISO = "callback_time_iso";
export const BLAND_VAR_CALLBACK_TIMEZONE = "callback_timezone";

/** Normalised `call_outcome` values, grouped by the Sandra outcome they imply. */
export const CALL_OUTCOME_VALUES = {
  callback_requested: ["callback_requested", "callback", "call_back", "schedule_callback"],
  reached_no_callback: ["reached", "qualified", "completed", "interested", "no_callback", "reached_no_callback"],
  not_interested: ["not_interested", "stop", "stop_calling", "do_not_call", "do_not_contact", "declined"],
  wrong_number: ["wrong_number", "wrong_person"],
  no_answer: ["no_answer", "voicemail", "no-answer"],
} as const satisfies Record<Exclude<NormaOutcome, "unknown">, readonly string[]>;

/** `follow_up_preference` values that mean "no follow-up wanted". */
export const NO_FOLLOW_UP_VALUES = ["", "none", "no", "n/a", "na", "null", "no_follow_up", "not_applicable"] as const;

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

function lookupOutcome(raw: string): Exclude<NormaOutcome, "unknown"> | null {
  for (const [outcome, values] of Object.entries(CALL_OUTCOME_VALUES)) {
    if ((values as readonly string[]).includes(raw)) return outcome as Exclude<NormaOutcome, "unknown">;
  }
  return null;
}

const MAX_QUAL_KEYS = 40;
const MAX_QUAL_VALUE = 500;

/** Scalar-only, capped copy of the call variables for `qualification`. */
export function sanitizeQualification(variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables).slice(0, MAX_QUAL_KEYS)) {
    if (typeof value === "string") out[key.slice(0, 80)] = value.slice(0, MAX_QUAL_VALUE);
    else if (typeof value === "number" || typeof value === "boolean") out[key.slice(0, 80)] = value;
  }
  return out;
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
  const summary = typeof call.summary === "string" && call.summary.trim() ? call.summary.trim().slice(0, 4000) : null;
  const base: NormaCompletionPayload = { summary, qualification: sanitizeQualification(variables) };

  if (call.completed !== true) return unknown("call_not_completed", base);

  const rawOutcome = norm(variables[BLAND_VAR_CALL_OUTCOME]);
  const mapped = rawOutcome ? lookupOutcome(rawOutcome) : null;
  if (rawOutcome && !mapped) return unknown("unrecognised_call_outcome", base);

  // Bland-confirmed nobody reached. A pathway outcome claiming a conversation
  // contradicts it, so that is a conflict, not a guess.
  const noAnswerByBland = status === "no-answer" || status === "no_answer" || answeredBy === "no-answer" || answeredBy === "no_answer" || answeredBy === "voicemail";
  if (noAnswerByBland) {
    if (mapped && mapped !== "no_answer") return unknown("conflict_no_answer_vs_outcome", base);
    return { outcome: "no_answer", payload: base };
  }
  if (status === "busy" || status === "failed" || status === "canceled" || status === "cancelled") {
    return unknown(`call_${status}`, base);
  }
  if (status && status !== "completed") return unknown("unrecognised_status", base);
  if (answeredBy !== "human") return unknown("answered_by_not_human", base);
  if (!mapped) return unknown("missing_call_outcome", base);
  if (mapped === "no_answer") return unknown("conflict_human_answered_vs_no_answer", base);

  const followRaw = variables[BLAND_VAR_FOLLOW_UP_PREFERENCE];
  const followText = typeof followRaw === "string" ? followRaw.trim() : "";
  const hasFollowUp = !(NO_FOLLOW_UP_VALUES as readonly string[]).includes(followText.toLowerCase());

  if (mapped === "not_interested" || mapped === "wrong_number") {
    if (hasFollowUp) return unknown("conflict_stop_vs_follow_up", base);
    return { outcome: mapped, payload: base };
  }

  const callbackAt = parseCallbackTime(variables[BLAND_VAR_CALLBACK_TIME_ISO], now);
  const tz = typeof variables[BLAND_VAR_CALLBACK_TIMEZONE] === "string" ? (variables[BLAND_VAR_CALLBACK_TIMEZONE] as string).trim() : "";

  // A conversation that names a follow-up is a callback request; the free-text
  // preference is kept raw (the time is unconfirmed either way).
  if (mapped === "callback_requested" || (mapped === "reached_no_callback" && hasFollowUp)) {
    return {
      outcome: "callback_requested",
      payload: {
        ...base,
        callback_requested_for: callbackAt,
        callback_timezone: tz || null,
        callback_raw: hasFollowUp ? followText.slice(0, 1000) : null,
      },
    };
  }
  return { outcome: "reached_no_callback", payload: base };
}
