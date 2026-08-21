import { createHmac, timingSafeEqual } from "node:crypto";

import { getCallerMemberships, type Membership } from "@/lib/auth/memberships";
import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";
import { prepareLeadCall, prepareManualCall } from "@/lib/dialer/actions";
import { createClient } from "@/lib/supabase/server";

import {
  requestJitterCancel,
  requestJitterConnect,
  requestJitterStartCall,
  requestJitterToken,
  type JitterCancelReason,
  type JitterProxyError,
  type JitterProxyResult,
  type JitterTokenResponse,
} from "./jitter-contract";
import type { CallTarget } from "./transport";

const E164 = /^\+[1-9]\d{7,14}$/;
const MAX_REF_LENGTH = 200;
const MAX_CAPABILITY_LENGTH = 1_024;

type AuthenticatedOperator = { ok: true; email: string; userId: string };
type ClientStartResponse = { sessionRef: string; batchId: string };

async function authenticatedOperator(): Promise<AuthenticatedOperator | JitterProxyError> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user?.email?.trim()) {
    return {
      ok: false,
      status: 401,
      error: "Not signed in.",
      errorCode: "unauthorized",
    };
  }
  let memberships: Membership[];
  try {
    memberships = await getCallerMemberships();
  } catch {
    memberships = [];
  }
  if (!memberships.some((membership) => (
    membership.user_id === user.id && membership.org_id === SANDRA_ORG_ID
  ))) {
    return {
      ok: false,
      status: 403,
      error: "Active Sandra access is required.",
      errorCode: "forbidden",
    };
  }
  return { ok: true, email: user.email.trim().toLowerCase(), userId: user.id };
}

function validRef(value: unknown, maxLength = MAX_REF_LENGTH): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function invalidInput(error: string): JitterProxyError {
  return { ok: false, status: 400, error, errorCode: "invalid_request" };
}

export async function startAuthenticatedJitterCall(
  target: unknown,
): Promise<JitterProxyResult<ClientStartResponse>> {
  if (!isCallTarget(target)) return invalidInput("A valid call target is required.");
  if (!E164.test(target.phoneE164)) return invalidInput("A valid E.164 phone number is required.");
  if (target.propertyId !== undefined && !validRef(target.propertyId)) return invalidInput("Invalid property reference.");
  if (target.contactId !== undefined && !validRef(target.contactId)) return invalidInput("Invalid contact reference.");

  // Server Actions are public mutation boundaries. Authorize before the
  // eligibility path, which can pause a lead's active sequences.
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;

  // Re-run the unchanged Sandra eligibility path instead of trusting a
  // browser-prepared target.
  const prepared = target.propertyId
    ? await prepareLeadCall(target.propertyId)
    : await prepareManualCall(target.phoneE164);
  if (!prepared.ok) {
    return {
      ok: false,
      status: 422,
      error: prepared.error,
      errorCode: "not_callable",
      reason: prepared.error,
    };
  }
  if (
    prepared.data.phoneE164 !== target.phoneE164
    || (target.contactId !== undefined && prepared.data.contactId !== target.contactId)
  ) {
    return {
      ok: false,
      status: 422,
      error: "The call target no longer matches Sandra's eligible lead.",
      errorCode: "not_callable",
      reason: "target_changed",
    };
  }

  const started = await requestJitterStartCall({
    operatorEmail: operator.email,
    phoneE164: prepared.data.phoneE164,
    ...(prepared.data.propertyId ? { propertyRef: prepared.data.propertyId } : {}),
    ...(prepared.data.contactId ? { contactRef: prepared.data.contactId } : {}),
  });
  if (!started.ok) return started;
  const capability = sealSessionCapability(started.data.sessionRef, operator.userId);
  if (!capability) {
    return {
      ok: false,
      status: 503,
      error: "Jitter softphone is not configured.",
      errorCode: "jitter_not_configured",
    };
  }
  return { ok: true, data: { sessionRef: capability, batchId: started.data.batchId } };
}

export async function getAuthenticatedJitterToken(
  sessionCapability: unknown,
): Promise<JitterProxyResult<JitterTokenResponse>> {
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  const sessionRef = openSessionCapability(sessionCapability, operator.userId);
  if (!sessionRef) return invalidInput("Invalid Jitter session reference.");
  return requestJitterToken(sessionRef);
}

export async function connectAuthenticatedJitterCall(
  sessionCapability: unknown,
): Promise<JitterProxyResult<{ dialing: true }>> {
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  const sessionRef = openSessionCapability(sessionCapability, operator.userId);
  if (!sessionRef) return invalidInput("Invalid Jitter session reference.");
  return requestJitterConnect(sessionRef);
}

export async function cancelAuthenticatedJitterCall(
  sessionCapability: unknown,
  reason: unknown,
): Promise<JitterProxyResult<{ tornDown: true }>> {
  if (!isCancelReason(reason)) {
    return invalidInput("Invalid Jitter cancellation reason.");
  }
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  const sessionRef = openSessionCapability(sessionCapability, operator.userId);
  if (!sessionRef) return invalidInput("Invalid Jitter session reference.");
  return requestJitterCancel(sessionRef, reason);
}

function isCallTarget(value: unknown): value is CallTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Partial<Record<keyof CallTarget, unknown>>;
  return typeof target.phoneE164 === "string"
    && (target.propertyId === undefined || typeof target.propertyId === "string")
    && (target.contactId === undefined || typeof target.contactId === "string");
}

function isCancelReason(value: unknown): value is JitterCancelReason {
  return value === "hangup" || value === "failed" || value === "abandoned";
}

function sealSessionCapability(sessionRef: string, userId: string): string | null {
  const token = process.env.JITTER_SOFTPHONE_SERVICE_TOKEN?.trim();
  if (!token) return null;
  const payload = Buffer.from(JSON.stringify({ sessionRef, userId }), "utf8").toString("base64url");
  const signature = createHmac("sha256", token).update(`sandra-softphone:${payload}`).digest("base64url");
  return `v1.${payload}.${signature}`;
}

function openSessionCapability(value: unknown, userId: string): string | null {
  if (!validRef(value, MAX_CAPABILITY_LENGTH)) return null;
  const token = process.env.JITTER_SOFTPHONE_SERVICE_TOKEN?.trim();
  if (!token) return null;
  const [version, payload, signature, extra] = value.split(".");
  if (version !== "v1" || !payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", token).update(`sandra-softphone:${payload}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const candidate = decoded as { sessionRef?: unknown; userId?: unknown };
    return candidate.userId === userId && validRef(candidate.sessionRef) ? candidate.sessionRef : null;
  } catch {
    return null;
  }
}
