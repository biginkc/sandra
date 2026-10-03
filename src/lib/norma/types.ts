/** Status machine for `norma_call_requests`. Transitions are enforced in SQL. */
export const NORMA_REQUEST_STATUSES = [
  "requested",
  "dispatching",
  "dispatched",
  "completed",
  "dispatch_rejected",
  "dispatch_unknown",
  "needs_review",
] as const;
export type NormaRequestStatus = (typeof NORMA_REQUEST_STATUSES)[number];

/** Statuses that hold a lead's drip and fence a second request. */
export const NORMA_OPEN_STATUSES = [
  "requested",
  "dispatching",
  "dispatched",
  "dispatch_unknown",
  "needs_review",
] as const satisfies readonly NormaRequestStatus[];

export const NORMA_OUTCOMES = [
  "no_answer",
  "callback_requested",
  "reached_no_callback",
  "not_interested",
  "wrong_number",
  "unknown",
] as const;
export type NormaOutcome = (typeof NORMA_OUTCOMES)[number];

/** Reasons `fn_norma_eligibility` / `fn_norma_create_request` can block a call. */
export type NormaBlockReason =
  | "invalid_request"
  | "property_not_found"
  | "training_lead"
  | "dnc_locked"
  | "dnc_contact"
  | "global_dnc_registry"
  | "wrong_number_flagged"
  | "contact_not_on_property"
  | "phone_not_on_contact"
  | "not_interested"
  | "requester_not_member"
  | "assignee_not_member"
  | "eligibility_check_failed";

export type NormaEligibility =
  | { eligible: true }
  | { eligible: false; reason: NormaBlockReason | (string & {}) };

export type NormaCreateResult =
  | { status: "created"; requestId: string; idempotencyKey: string }
  | { status: "already_open"; requestId: string | null }
  | { status: "blocked"; reason: NormaBlockReason | (string & {}) };

/** Optional fields a completion may carry; all are validated and capped in SQL. */
export type NormaCompletionPayload = {
  summary?: string | null;
  qualification?: Record<string, unknown> | null;
  callback_requested_for?: string | null;
  callback_timezone?: string | null;
  callback_raw?: string | null;
};

export type NormaCompleteResult =
  | {
      result: "applied";
      /** `requested`: attempt 1 was confirmed not answered and the retry (attempt 2) is waiting to be dialled. */
      status: "completed" | "needs_review" | "requested";
      outcome: NormaOutcome;
      /** True exactly once per request: the caller must now run dispatchNormaCall for the second attempt. */
      retry?: boolean;
      taskId?: string | null;
      released?: number;
      converted?: number;
    }
  | { result: "replayed"; status: string; outcome?: string | null }
  | { result: "call_id_mismatch" | "invalid_state" | "not_found" | "call_id_required" | "call_id_conflict" | "stale_attempt"; status?: string };

export type NormaBindResult =
  | "bound"
  | "already_completed"
  | "call_id_conflict"
  | "invalid_state"
  | "invalid_call_id"
  | "not_found";
