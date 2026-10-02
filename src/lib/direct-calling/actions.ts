"use server";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { prepareLeadCall, prepareManualCall, resumeFailedSoftphoneCall } from "@/lib/dialer/actions";
import { capabilityKey } from "@/lib/dialer/call-capability";
import { isHomeownerTrainingNumber } from "@/lib/dialer/homeowner-training";
import { sealCallCapability } from "@/lib/dialer/jitter-server";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

import { isDirectCallEligibleMembership, resolveCallingConfig } from "./config";
import type {
  CallingConfig,
  CancelDirectCallResult,
  DirectActionResult,
  DirectCallControl,
  DirectCallStatusView,
  DirectRtcToken,
  StartDirectCallInput,
  StartDirectCallResult,
} from "./contract";
import { createDirectCallService } from "./service";
import { createSupabaseDirectCallStore } from "./store";
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
  });
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
