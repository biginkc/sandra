"use server";

import { getCallerMemberships } from "@/lib/auth/memberships";
import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";
import { prepareLeadCall, prepareManualCall, resumeFailedSoftphoneCall } from "@/lib/dialer/actions";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

import { resolveCallingConfig } from "./config";
import type {
  CallingConfig,
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
  telnyxHangup,
  telnyxSendDtmf,
} from "./telnyx";

async function authenticatedOperator(): Promise<{ ok: true; userId: string } | { ok: false; error: string; errorCode: string }> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { ok: false, error: "Not signed in.", errorCode: "unauthorized" };
  let memberships: Awaited<ReturnType<typeof getCallerMemberships>> = [];
  try {
    memberships = await getCallerMemberships();
  } catch {
    memberships = [];
  }
  if (!memberships.some((m) => m.user_id === user.id && m.org_id === SANDRA_ORG_ID)) {
    return { ok: false, error: "Active Sandra access is required.", errorCode: "forbidden" };
  }
  return { ok: true, userId: user.id };
}

function service() {
  return createDirectCallService({
    store: createSupabaseDirectCallStore(),
    env: process.env,
    now: () => new Date(),
    prepareLeadCall,
    prepareManualCall,
    resumeFailedSoftphoneCall,
    telnyx: {
      dial: telnyxDial,
      hangup: telnyxHangup,
      sendDtmf: telnyxSendDtmf,
      createCredential: telnyxCreateCredential,
      createToken: telnyxCreateToken,
    },
    report: (error, tag) => reportError(error, { tags: { surface: tag } }),
  });
}

export async function getCallingConfigForCurrentUser(): Promise<CallingConfig> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    return resolveCallingConfig(user?.id);
  } catch {
    return { transport: "default" };
  }
}

export async function getDirectRtcToken(): Promise<DirectActionResult<DirectRtcToken>> {
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  return service().getRtcToken(operator.userId);
}

export async function startDirectCall(input: StartDirectCallInput): Promise<DirectActionResult<StartDirectCallResult>> {
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  return service().startCall(operator.userId, input);
}

export async function getDirectCallStatus(directCallId: string): Promise<DirectActionResult<DirectCallStatusView>> {
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  return service().getStatus(operator.userId, directCallId);
}

export async function controlDirectCall(
  directCallId: string,
  control: DirectCallControl,
): Promise<DirectActionResult<{ accepted: true }>> {
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  return service().control(operator.userId, directCallId, control);
}
