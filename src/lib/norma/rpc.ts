import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types";

import type {
  NormaBindResult,
  NormaCompleteResult,
  NormaCompletionPayload,
  NormaCreateResult,
  NormaEligibility,
  NormaOutcome,
} from "./types";

/**
 * Thin typed wrappers over the `fn_norma_*` RPCs. They contain no business
 * logic and no network code: every rule lives in SQL so the webhook, the
 * reconciliation sweep and the request action cannot drift. All of these are
 * service-role only; pass the admin client. A transport or RPC error throws,
 * so callers fail closed.
 */
type Client = SupabaseClient<Database>;

function fail(name: string, error: { message: string }): never {
  throw new Error(`${name}: ${error.message}`);
}

/**
 * PostgREST (PGRST202) or Postgres (42883) saying the function does not
 * exist: the code is deployed before the Norma migration has been applied.
 */
export function isMissingFunctionError(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/** True while an open Norma request holds the property's enrollments. */
export async function isNormaHoldActive(client: Client, propertyId: string): Promise<boolean> {
  const { data, error } = await client.rpc("fn_norma_hold_active", { p_property_id: propertyId });
  if (error) fail("fn_norma_hold_active", error);
  return data === true;
}

/** Hard blocks only. Any read error, or an unexpected shape, is "not eligible". */
export async function checkNormaEligibility(
  client: Client,
  params: { propertyId: string; contactId: string; phoneE164: string },
): Promise<NormaEligibility> {
  const { data, error } = await client.rpc("fn_norma_eligibility", {
    p_property_id: params.propertyId,
    p_contact_id: params.contactId,
    p_phone_e164: params.phoneE164,
  });
  if (error) return { eligible: false, reason: "eligibility_check_failed" };
  const row = data?.[0];
  if (!row || row.eligible !== true) {
    return { eligible: false, reason: row?.block_reason ?? "eligibility_check_failed" };
  }
  return { eligible: true };
}

/** Eligibility + insert + pause of the lead's drip, atomically. */
export async function createNormaRequest(
  client: Client,
  params: {
    propertyId: string;
    contactId: string;
    phoneE164: string;
    requestedBy: string;
    repContext: string | null;
    callbackAssigneeId: string;
  },
): Promise<NormaCreateResult> {
  const { data, error } = await client.rpc("fn_norma_create_request", {
    p_property_id: params.propertyId,
    p_contact_id: params.contactId,
    p_phone_e164: params.phoneE164,
    p_requested_by: params.requestedBy,
    p_rep_context: params.repContext,
    p_callback_assignee_id: params.callbackAssigneeId,
  });
  if (error) fail("fn_norma_create_request", error);
  const row = data?.[0];
  if (!row) throw new Error("fn_norma_create_request: empty result");
  if (row.outcome === "created" && row.request_id && row.idempotency_key) {
    return { status: "created", requestId: row.request_id, idempotencyKey: row.idempotency_key };
  }
  if (row.outcome === "already_open") return { status: "already_open", requestId: row.request_id };
  return { status: "blocked", reason: row.block_reason ?? "eligibility_check_failed" };
}

/** requested -> dispatching. Exactly one caller wins. */
export async function claimNormaDispatch(client: Client, requestId: string): Promise<boolean> {
  const { data, error } = await client.rpc("fn_norma_claim_dispatch", { p_request_id: requestId });
  if (error) fail("fn_norma_claim_dispatch", error);
  return data === true;
}

/** Record the Bland call id; never overwrites a completed request or another id. */
export async function bindNormaCallId(
  client: Client,
  requestId: string,
  callId: string,
): Promise<NormaBindResult> {
  const { data, error } = await client.rpc("fn_norma_bind_call_id", { p_request_id: requestId, p_call_id: callId });
  if (error) fail("fn_norma_bind_call_id", error);
  return data as NormaBindResult;
}

export async function markNormaDispatchRejected(client: Client, requestId: string, reason: string): Promise<string> {
  const { data, error } = await client.rpc("fn_norma_mark_dispatch_rejected", { p_request_id: requestId, p_reason: reason });
  if (error) fail("fn_norma_mark_dispatch_rejected", error);
  return data;
}

export async function markNormaDispatchUnknown(client: Client, requestId: string, reason: string): Promise<string> {
  const { data, error } = await client.rpc("fn_norma_mark_dispatch_unknown", { p_request_id: requestId, p_reason: reason });
  if (error) fail("fn_norma_mark_dispatch_unknown", error);
  return data;
}

export async function markNormaNeedsReview(client: Client, requestId: string, reason: string): Promise<string> {
  const { data, error } = await client.rpc("fn_norma_mark_needs_review", { p_request_id: requestId, p_reason: reason });
  if (error) fail("fn_norma_mark_needs_review", error);
  return data;
}

/** The only path by which a call result touches CRM state. Replay-safe. */
export async function completeNormaCall(
  client: Client,
  params: { requestId: string; callId: string; outcome: NormaOutcome; payload?: NormaCompletionPayload },
): Promise<NormaCompleteResult> {
  const { data, error } = await client.rpc("fn_norma_complete_call", {
    p_request_id: params.requestId,
    p_call_id: params.callId,
    p_outcome: params.outcome,
    p_payload: (params.payload ?? {}) as Json,
  });
  if (error) fail("fn_norma_complete_call", error);
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    ...(raw.task_id !== undefined ? { taskId: raw.task_id as string | null } : {}),
  } as NormaCompleteResult;
}

/** Resume only the pauses this request made itself; safe to repeat. */
export async function releaseNormaPauses(client: Client, requestId: string): Promise<number> {
  const { data, error } = await client.rpc("fn_norma_release_pauses", { p_request_id: requestId });
  if (error) fail("fn_norma_release_pauses", error);
  return data ?? 0;
}

/**
 * Inbound-reply / human-takeover upgrade ([H1]): while a Norma hold is open,
 * `norma_call` and held `call_in_progress` pauses become the reply reason so
 * no Norma release, softphone cleanup or stale sweep can resume them.
 */
export async function upgradeNormaHoldPauses(
  client: Client,
  params: { propertyId: string; reason: "inbound_reply" | "rep_sms_human_takeover" },
): Promise<number> {
  const { data, error } = await client.rpc("fn_norma_upgrade_pauses_for_reply", {
    p_property_id: params.propertyId,
    p_reason: params.reason,
  });
  // Inbound replies must keep working in the window between a deploy and the
  // migration: with no Norma schema there is no hold to upgrade.
  if (isMissingFunctionError(error)) return 0;
  if (error) fail("fn_norma_upgrade_pauses_for_reply", error);
  return data ?? 0;
}

/** The stale-call sweep's activation: hold aware, locks each enrollment first. */
export async function sweepResumeCallInProgress(
  client: Client,
  params: { enrollmentIds: string[]; resumeAt: string },
): Promise<number> {
  const { data, error } = await client.rpc("sweep_resume_call_in_progress", {
    p_enrollment_ids: params.enrollmentIds,
    p_resume_at: params.resumeAt,
  });
  if (error) fail("sweep_resume_call_in_progress", error);
  return data ?? 0;
}
