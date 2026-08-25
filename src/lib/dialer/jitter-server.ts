import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { getCallerMemberships, type Membership } from "@/lib/auth/memberships";
import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";
import { prepareLeadCall, prepareManualCall } from "@/lib/dialer/actions";
import { STATE_TO_TZ } from "@/lib/messaging/quiet-hours";
import { createClient } from "@/lib/supabase/server";

import {
  requestJitterCancel,
  requestJitterCancelByIdempotencyKey,
  requestJitterAudioHealth,
  requestJitterConnect,
  requestJitterCallerIds,
  requestJitterDigit,
  requestJitterStartCall,
  requestJitterToken,
  type JitterCancelResponse,
  type JitterCancelReason,
  type JitterAudioHealthResponse,
  type JitterAudioHealthSample,
  type JitterConnectPhase,
  type JitterCallerIdsResponse,
  type JitterProxyError,
  type JitterProxyResult,
  type JitterStartCallResult,
  type JitterTokenResponse,
} from "./jitter-contract";
import type { CallTarget } from "./transport";

const E164 = /^\+[1-9]\d{7,14}$/;
const MAX_REF_LENGTH = 200;
const MAX_CAPABILITY_LENGTH = 1_024;
const MIN_CAPABILITY_KEY_LENGTH = 32;
const MAX_CAPABILITY_KEY_LENGTH = 512;

type AuthenticatedOperator = { ok: true; userId: string };
type StartIntent = { idempotencyKey: string; userId: string };

async function authenticatedOperator(): Promise<
  AuthenticatedOperator | JitterProxyError
> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
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
  if (
    !memberships.some(
      (membership) =>
        membership.user_id === user.id && membership.org_id === SANDRA_ORG_ID,
    )
  ) {
    return {
      ok: false,
      status: 403,
      error: "Active Sandra access is required.",
      errorCode: "forbidden",
    };
  }
  return { ok: true, userId: user.id };
}

function validRef(value: unknown, maxLength = MAX_REF_LENGTH): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function invalidInput(error: string): JitterProxyError {
  return { ok: false, status: 400, error, errorCode: "invalid_request" };
}

export async function startAuthenticatedJitterCall(
  target: unknown,
): Promise<JitterStartCallResult> {
  if (!isCallTarget(target))
    return startLocalError("A valid call target is required.");
  if (!E164.test(target.phoneE164))
    return startLocalError("A valid E.164 phone number is required.");
  if (
    typeof target.callerIdE164 !== "string" ||
    !E164.test(target.callerIdE164)
  )
    return startLocalError("A valid caller ID is required.");
  const callerIdE164 = target.callerIdE164;
  if (target.propertyId !== undefined && !validRef(target.propertyId))
    return startLocalError("Invalid property reference.");
  if (target.contactId !== undefined && !validRef(target.contactId))
    return startLocalError("Invalid contact reference.");
  if (!validRef(target.callToken, 200))
    return startLocalError("A stable call token is required.");
  if (!validRef(target.intentCapability, MAX_CAPABILITY_LENGTH))
    return startLocalError("A valid start intent is required.");

  // Server Actions are public mutation boundaries. Authorize and validate the
  // sealed intent before the eligibility path, which can pause a lead.
  const operator = await authenticatedOperator();
  if (!operator.ok) return startLocalError(operator.error, operator);

  const capabilitySigningKey = capabilityKey(
    process.env.SOFTPHONE_CAPABILITY_KEY,
  );
  if (!capabilitySigningKey) {
    return {
      ok: false,
      status: 503,
      error: "Jitter softphone is not configured.",
      errorCode: "jitter_not_configured",
      // No request left Sandra, so nothing can have provisioned.
      ambiguous: false,
    };
  }

  const intent = openStartIntentCapability(
    target.intentCapability,
    operator.userId,
    capabilitySigningKey,
  );
  if (!intent || intent.idempotencyKey !== target.callToken) {
    return startLocalError("Invalid Jitter start intent.");
  }

  // Re-run the unchanged Sandra eligibility path instead of trusting a
  // browser-prepared target.
  const prepared = target.propertyId
    ? await prepareLeadCall(target.propertyId)
    : await prepareManualCall(target.phoneE164);
  if (!prepared.ok) {
    return startLocalError(prepared.error, {
      ok: false,
      status: 422,
      error: prepared.error,
      errorCode: "not_callable",
      reason: prepared.error,
    });
  }
  if (
    prepared.data.phoneE164 !== target.phoneE164 ||
    (target.contactId !== undefined &&
      prepared.data.contactId !== target.contactId)
  ) {
    return startLocalError("The call target no longer matches Sandra's eligible lead.", {
      ok: false,
      status: 422,
      error: "The call target no longer matches Sandra's eligible lead.",
      errorCode: "not_callable",
      reason: "target_changed",
    });
  }

  // prepareManualCall historically uses Missouri as a quiet-hours fallback
  // for an unlinked number. CONTRACT v2 requires the prospect's actual IANA
  // timezone, so that fallback must never cross the Jitter boundary.
  if (!prepared.data.propertyId) {
    return startLocalError("A verified lead timezone is required before calling this number.", {
      ok: false,
      status: 422,
      error: "A verified lead timezone is required before calling this number.",
      errorCode: "not_callable",
      reason: "timezone_unverified",
    });
  }

  const timezone = prepared.data.state
    ? STATE_TO_TZ[prepared.data.state.trim().toUpperCase()]
    : undefined;
  if (!timezone) {
    return startLocalError("The call target does not have a supported IANA timezone.", {
      ok: false,
      status: 422,
      error: "The call target does not have a supported IANA timezone.",
      errorCode: "not_callable",
      reason: "timezone_unavailable",
    });
  }

  const started = await requestJitterStartCall(
    {
      operator_id: operator.userId,
      phone_e164: prepared.data.phoneE164,
      timezone,
      caller_id_e164: callerIdE164,
    },
    intent.idempotencyKey,
  );
  if (!started.ok) {
    // Deterministic configuration failures never reach Jitter; only outcomes
    // where a request may have committed are ambiguous.
    const deterministic =
      started.errorCode === "jitter_not_configured" ||
      started.errorCode === "jitter_invalid_configuration";
    return {
      ...started,
      ambiguous: started.ambiguous ?? (!deterministic && started.status >= 500),
    };
  }
  const capability = sealCallCapability(
    started.data.call_id,
    operator.userId,
    capabilitySigningKey,
  );
  return {
    ok: true,
    data: { callId: capability, batchId: started.data.batch_id },
    ambiguous: false,
  };
}

export async function mintStartIntent(): Promise<
  JitterProxyResult<{ callToken: string; intentCapability: string }>
> {
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  const key = capabilityKey(process.env.SOFTPHONE_CAPABILITY_KEY);
  if (!key) {
    return {
      ok: false,
      status: 503,
      error: "Jitter softphone is not configured.",
      errorCode: "jitter_not_configured",
    };
  }
  const callToken = randomUUID();
  return {
    ok: true,
    data: {
      callToken,
      intentCapability: sealStartIntentCapability(callToken, operator.userId, key),
    },
  };
}

export async function getAuthenticatedJitterCallerIds(): Promise<
  JitterProxyResult<JitterCallerIdsResponse>
> {
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  return requestJitterCallerIds();
}

export async function getAuthenticatedJitterToken(
  callCapability: unknown,
): Promise<JitterProxyResult<JitterTokenResponse>> {
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  const callId = openCallCapability(callCapability, operator.userId);
  if (!callId) return invalidInput("Invalid Jitter call reference.");
  return requestJitterToken(callId);
}

export async function connectAuthenticatedJitterCall(
  callCapability: unknown,
  phase: unknown,
): Promise<JitterProxyResult<{ dialing: true }>> {
  if (!isConnectPhase(phase))
    return invalidInput("Invalid Jitter connect phase.");
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  const callId = openCallCapability(callCapability, operator.userId);
  if (!callId) return invalidInput("Invalid Jitter call reference.");
  return requestJitterConnect(callId, phase);
}

export async function cancelAuthenticatedJitterCall(
  callCapability: unknown,
  reason: unknown,
): Promise<JitterProxyResult<JitterCancelResponse>> {
  if (!isCancelReason(reason)) {
    return invalidInput("Invalid Jitter cancellation reason.");
  }
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  const callId = openCallCapability(callCapability, operator.userId);
  if (!callId) return invalidInput("Invalid Jitter call reference.");
  return requestJitterCancel(callId, reason);
}

export async function cancelJitterCallByStartIntent(
  intentCapability: unknown,
  reason: unknown,
): Promise<JitterProxyResult<JitterCancelResponse>> {
  if (!isCancelReason(reason)) {
    return invalidInput("Invalid Jitter cancellation reason.");
  }
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  const capabilitySigningKey = capabilityKey(
    process.env.SOFTPHONE_CAPABILITY_KEY,
  );
  if (!capabilitySigningKey) {
    return {
      ok: false,
      status: 503,
      error: "Jitter softphone is not configured.",
      errorCode: "jitter_not_configured",
    };
  }
  const intent = openStartIntentCapability(
    intentCapability,
    operator.userId,
    capabilitySigningKey,
  );
  if (!intent) return invalidInput("Invalid Jitter start intent.");
  return requestJitterCancelByIdempotencyKey(intent.idempotencyKey, reason);
}

export async function sendAuthenticatedJitterDigit(
  callCapability: unknown,
  digit: unknown,
): Promise<JitterProxyResult<{ sent: true }>> {
  if (typeof digit !== "string" || !/^[0-9*#]$/.test(digit)) {
    return invalidInput("Invalid keypad digit.");
  }
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  const callId = openCallCapability(callCapability, operator.userId);
  if (!callId) return invalidInput("Invalid Jitter call reference.");
  return requestJitterDigit(callId, digit);
}

export async function reportAuthenticatedJitterAudioHealth(
  callCapability: unknown,
  sample: unknown,
): Promise<JitterProxyResult<JitterAudioHealthResponse>> {
  if (!isAudioHealthSample(sample))
    return invalidInput("Invalid browser audio health sample.");
  const operator = await authenticatedOperator();
  if (!operator.ok) return operator;
  const callId = openCallCapability(callCapability, operator.userId);
  if (!callId) return invalidInput("Invalid Jitter call reference.");
  return requestJitterAudioHealth(callId, sample);
}

function isCallTarget(value: unknown): value is CallTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Partial<Record<keyof CallTarget, unknown>>;
  return (
    typeof target.phoneE164 === "string" &&
    (target.callerIdE164 === undefined || typeof target.callerIdE164 === "string") &&
    (target.propertyId === undefined ||
      typeof target.propertyId === "string") &&
    (target.contactId === undefined || typeof target.contactId === "string") &&
    typeof target.callToken === "string" &&
    (target.intentCapability === undefined ||
      typeof target.intentCapability === "string")
  );
}

function isConnectPhase(value: unknown): value is JitterConnectPhase {
  return value === "registered" || value === "accepted";
}

function isCancelReason(value: unknown): value is JitterCancelReason {
  return value === "hangup" || value === "failed" || value === "abandoned";
}

function isAudioHealthSample(value: unknown): value is JitterAudioHealthSample {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sample = value as Partial<
    Record<keyof JitterAudioHealthSample, unknown>
  >;
  return (
    validRef(sample.controller_id, 64) &&
    Number.isSafeInteger(sample.peer_connection_generation) &&
    Number(sample.peer_connection_generation) > 0 &&
    Number.isSafeInteger(sample.sample_sequence) &&
    Number(sample.sample_sequence) > 0 &&
    Number.isSafeInteger(sample.packets_received) &&
    Number(sample.packets_received) >= 0 &&
    Number.isSafeInteger(sample.bytes_received) &&
    Number(sample.bytes_received) >= 0
  );
}

function sealCallCapability(
  callId: string,
  userId: string,
  key: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({ type: "call", callId, userId }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`sandra-softphone:call:${payload}`)
    .digest("base64url");
  return `v1.${payload}.${signature}`;
}

function sealStartIntentCapability(
  idempotencyKey: string,
  userId: string,
  key: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({ type: "start_intent", idempotencyKey, userId }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`sandra-softphone:start-intent:${payload}`)
    .digest("base64url");
  return `v1.${payload}.${signature}`;
}

function openCallCapability(value: unknown, userId: string): string | null {
  if (!validRef(value, MAX_CAPABILITY_LENGTH)) return null;
  const currentKey = capabilityKey(process.env.SOFTPHONE_CAPABILITY_KEY);
  if (!currentKey) return null;
  const previousKey = capabilityKey(
    process.env.SOFTPHONE_CAPABILITY_KEY_PREVIOUS,
  );
  const [version, payload, signature, extra] = value.split(".");
  if (version !== "v1" || !payload || !signature || extra !== undefined)
    return null;
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  const verified = [currentKey, previousKey]
    .filter((candidate): candidate is string => Boolean(candidate))
    .slice(0, 2)
    .some((candidate) => {
      const expected = createHmac("sha256", candidate)
        .update(`sandra-softphone:call:${payload}`)
        .digest();
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    });
  if (!verified) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      return null;
    const candidate = decoded as {
      type?: unknown;
      callId?: unknown;
      userId?: unknown;
    };
    return candidate.type === "call" &&
      candidate.userId === userId && validRef(candidate.callId)
      ? candidate.callId
      : null;
  } catch {
    return null;
  }
}

function openStartIntentCapability(
  value: unknown,
  userId: string,
  key: string,
): StartIntent | null {
  if (!validRef(value, MAX_CAPABILITY_LENGTH)) return null;
  const [version, payload, signature, extra] = value.split(".");
  if (version !== "v1" || !payload || !signature || extra !== undefined)
    return null;
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  const currentKey = capabilityKey(process.env.SOFTPHONE_CAPABILITY_KEY);
  const previousKey = capabilityKey(process.env.SOFTPHONE_CAPABILITY_KEY_PREVIOUS);
  if (currentKey !== key) return null;
  const verified = [currentKey, previousKey]
    .filter((candidate): candidate is string => Boolean(candidate))
    .slice(0, 2)
    .some((candidate) => {
      const expected = createHmac("sha256", candidate)
        .update(`sandra-softphone:start-intent:${payload}`)
        .digest();
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    });
  if (!verified) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      return null;
    const candidate = decoded as {
      type?: unknown;
      idempotencyKey?: unknown;
      userId?: unknown;
    };
    return candidate.type === "start_intent" &&
      candidate.userId === userId &&
      validRef(candidate.idempotencyKey, 200)
      ? { idempotencyKey: candidate.idempotencyKey, userId: candidate.userId }
      : null;
  } catch {
    return null;
  }
}

function capabilityKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized?.startsWith("v1:")) return null;
  const key = normalized.slice(3);
  return key.length >= MIN_CAPABILITY_KEY_LENGTH &&
    key.length <= MAX_CAPABILITY_KEY_LENGTH
    ? key
    : null;
}

function startLocalError(
  error: string,
  result: JitterProxyError = invalidInput(error),
): JitterStartCallResult {
  return { ...result, ambiguous: false };
}
