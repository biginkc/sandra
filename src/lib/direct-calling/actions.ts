"use server";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { prepareLeadCall, prepareManualCall, resumeFailedSoftphoneCall } from "@/lib/dialer/actions";
import { capabilityKey } from "@/lib/dialer/call-capability";
import { HOMEOWNER_TRAINING_LABEL, isHomeownerTrainingNumber } from "@/lib/dialer/homeowner-training";
import { sealCallCapability } from "@/lib/dialer/jitter-server";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";

import { isDirectCallEligibleMembership, resolveCallingConfig } from "./config";
import type {
  CallingConfig,
  CancelDirectCallResult,
  DirectActionResult,
  DirectCallControl,
  DirectCallTarget,
  DirectCallStatusView,
  DirectRtcToken,
  StartDirectCallInput,
  StartDirectCallResult,
} from "./contract";
import { createDirectCallService } from "./service";
import { createSupabaseDirectCallStore } from "./store";
import { readDirectWatchdogConfig } from "./watchdog";
import {
  telnyxCreateCredential,
  telnyxCreateToken,
  telnyxDial,
  telnyxGetCallAlive,
  telnyxHangup,
  telnyxListActiveCalls,
  telnyxSendDtmf,
} from "./telnyx";

/** Authentication only: used to end or read a call the caller already owns. */
async function authenticatedUser(): Promise<{ ok: true; userId: string } | { ok: false; error: string; errorCode: string }> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { ok: false, error: "Not signed in.", errorCode: "unauthorized" };
  return { ok: true, userId: user.id };
}

async function authenticatedOperator(): Promise<{ ok: true; userId: string } | { ok: false; error: string; errorCode: string }> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { ok: false, error: "Not signed in.", errorCode: "unauthorized" };
  try {
    const memberships = await getCallerMembershipsOrThrow();
    if (!isDirectCallEligibleMembership(user.id, memberships)) {
      return { ok: false, error: "Active Acquisitions access is required.", errorCode: "forbidden" };
    }
  } catch {
    return { ok: false, error: "Active Acquisitions access is required.", errorCode: "forbidden" };
  }
  return { ok: true, userId: user.id };
}

function service(authorizedUserId: string) {
  return createDirectCallService({
    store: createSupabaseDirectCallStore(),
    env: process.env,
    now: () => new Date(),
    isEligible: (userId) => userId === authorizedUserId,
    prepareLeadCall,
    prepareManualCall,
    resumeFailedSoftphoneCall,
    recordTrainingActivity,
    // The existing Jitter-path sealer, unchanged: same payload, key and purpose rule.
    sealCallIdentity: ({ callId, userId, phoneE164 }) => {
      const training = isHomeownerTrainingNumber(phoneE164);
      const key = capabilityKey(process.env.SOFTPHONE_CAPABILITY_KEY);
      return {
        training,
        capability: key ? sealCallCapability(callId, userId, key, phoneE164, training ? "internal_training" : "customer") : null,
      };
    },
    telnyx: {
      dial: telnyxDial,
      hangup: telnyxHangup,
      getCall: telnyxGetCallAlive,
      listActiveCalls: telnyxListActiveCalls,
      sendDtmf: telnyxSendDtmf,
      createCredential: telnyxCreateCredential,
      createToken: telnyxCreateToken,
    },
    report: (error, tag) => reportError(error, { tags: { surface: tag } }),
    // A missing watchdog is a server-side fail-closed condition. The service gate runs before
    // reservation, so no provider request can be issued while the monitor is unavailable.
    watchdog: readDirectWatchdogConfig(process.env),
  });
}

/**
 * Training purpose is an immutable, server-assigned property of a call activity.
 * Create the row with the service role before returning a browser capability so a
 * crashed browser or missing wrap-up cannot turn a training call into an untyped
 * customer activity. The direct call id is also the activity id, making replay
 * idempotent without depending on PostgREST inference for the partial direct-id
 * unique index.
 */
async function recordTrainingActivity(args: {
  directCallId: string;
  operatorUserId: string;
  target: DirectCallTarget;
}): Promise<void> {
  const admin = createAdminClient();
  const values = {
    id: args.directCallId,
    org_id: SANDRA_ORG_ID,
    direct_call_id: args.directCallId,
    provider: "sandra_softphone",
    jitter_attempt_id: `sandra-${args.directCallId}`,
    operator_user_id: args.operatorUserId,
    property_id: null,
    contact_id: null,
    phone_e164: args.target.phoneE164,
    call_purpose: "internal_training",
    direction: "outbound",
    notes: HOMEOWNER_TRAINING_LABEL,
    started_at: args.target.startedAt,
  };
  const { error } = await admin.from("call_activities").insert(values as never);
  if (error && error.code !== "23505") throw error;

  // Select by id because generated Supabase types predate direct_call_id. The
  // inserted identity is still checked through the id, direct linkage, and all
  // immutable fences.
  const { data: recorded, error: readError } = await admin
    .from("call_activities")
    .select("*")
    .eq("id", args.directCallId)
    .maybeSingle();
  const directCallId = (recorded as unknown as { direct_call_id?: string | null } | null)?.direct_call_id;
  if (
    readError ||
    !recorded ||
    recorded.id !== args.directCallId ||
    directCallId !== args.directCallId ||
    recorded.call_purpose !== "internal_training" ||
    recorded.phone_e164 !== args.target.phoneE164 ||
    recorded.org_id !== SANDRA_ORG_ID ||
    recorded.operator_user_id !== args.operatorUserId ||
    recorded.provider !== "sandra_softphone" ||
    recorded.property_id !== null ||
    recorded.contact_id !== null
  ) {
    throw new Error("Training activity identity conflict");
  }
}

export async function getCallingConfigForCurrentUser(): Promise<CallingConfig> {
  try {
    const operator = await authenticatedOperator();
    return operator.ok ? resolveCallingConfig(operator.userId, process.env, true) : { transport: "default" };
  } catch {
    return { transport: "default" };
  }
}

export async function getDirectRtcToken(): Promise<DirectActionResult<DirectRtcToken>> {
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  return service(operator.userId).getRtcToken(operator.userId);
}

export async function startDirectCall(input: StartDirectCallInput): Promise<DirectActionResult<StartDirectCallResult>> {
  const operator = await authenticatedOperator();
  // Refused before the service ran: nothing was reserved.
  if (!operator.ok) return { ...operator, reserved: false };
  return service(operator.userId).startCall(operator.userId, input);
}

export async function getDirectCallStatus(directCallId: string): Promise<DirectActionResult<DirectCallStatusView>> {
  const operator = await authenticatedUser();
  if (!operator.ok) return operator;
  return service(operator.userId).getStatus(operator.userId, directCallId);
}

export async function controlDirectCall(
  directCallId: string,
  control: DirectCallControl,
): Promise<DirectActionResult<{ accepted: true }>> {
  // Hanging up an owned call needs only authentication + ownership; DTMF also needs active access.
  const operator = control?.action === "hangup" ? await authenticatedUser() : await authenticatedOperator();
  if (!operator.ok) return operator;
  return service(operator.userId).control(operator.userId, directCallId, control);
}

export async function getDirectCallStatusByRequest(clientRequestId: string): Promise<DirectActionResult<DirectCallStatusView>> {
  const operator = await authenticatedUser();
  if (!operator.ok) return operator;
  return service(operator.userId).getStatusByRequest(operator.userId, clientRequestId);
}

/** Cancels a start whose response was lost: hangs up the call if it exists, else tombstones the request id. */
export async function cancelDirectCallByRequest(clientRequestId: string): Promise<DirectActionResult<CancelDirectCallResult>> {
  // Like hangup, cancelling needs only authentication: removing a user from the pilot must not strand a call.
  const operator = await authenticatedUser();
  if (!operator.ok) return operator;
  return service(operator.userId).cancelByRequest(operator.userId, clientRequestId);
}
