/**
 * API dial (Phase 2, 2.7, decision D4): Sandra places the call through the Dialpad REST API with
 * the intent token as `custom_data`; the Dialpad desktop app rings the seller on the rep's headset.
 * The Mini Dialer iframe and the browser recording capture are gone.
 *
 * Ordering guarantees (the whole point of this module):
 *  - The intent is prepared and authorized in one server-side transaction (DNC, assignment, grant
 *    and phone are re-proven there); only the first authorization of a key releases the payload, so
 *    a retry of the same idempotency key can never dial twice (`already_dispatched`).
 *  - A fresh intent and a fresh idempotency key are minted only after a PROVEN non-dispatch
 *    rejection: the pre-prepare rate guard and a provider 429. Both cancel the intent first, and a
 *    cancelled intent can never be released again. `accepted`, `unknown` (timeout, network, 5xx:
 *    the call may exist) and `already_dispatched` keep the same key, which can only ever return
 *    `already_dispatched`, never a second dial. The 2.2 timeout marks an unconfirmed intent failed
 *    after two minutes; a late event still matches.
 *  - No attempt row is written here: the projection creates it on the first event (D5).
 *
 * Seam S1 (`DIALPAD_DIAL_PROVIDER=stub|live`): the stub records the would-be request in process
 * and returns `accepted` with no HTTP. It is ignored (behaves as `live`) when VERCEL_ENV=production.
 */

import { reportError } from '@/lib/errors/report';
import { checkQuietHours } from '@/lib/messaging/quiet-hours';

import { DIALPAD_CTI_CUSTOM_DATA_PATTERN, type DialpadDenialDetail, type DialpadIdentityType } from './contracts';
import { DIALPAD_API_ORIGIN, resolveDialpadDirectoryKey, type DialpadDirectoryEnv } from './directory';
import {
  dialpadDenialMessage,
  startDialpadCall,
  type DialpadActor,
  type DialpadCallSlot,
  type DialpadConnectionView,
  type DialpadDialEndpoint,
  type DialpadDispatchDb,
  type DialpadFailureCode,
} from './dispatch';
import { DialpadDbError } from './event-processing';
import { DIALPAD_CUSTOM_DATA_MAX } from './protocol';

export type { DialpadDialEndpoint } from './dispatch';

/** Phase 0 decides between the two endpoints; until its findings land, `initiate_call` is the default. */
export const DIALPAD_DIAL_ENDPOINT_DEFAULT: DialpadDialEndpoint = 'initiate_call';
const DIAL_KEY_REF = /^env:(DIALPAD_CTI_DIAL_KEY_[A-Z0-9_]{1,120})$/;
const MIN_KEY_LENGTH = 16;
const E164 = /^\+1[0-9]{10}$/;
const DIGITS = /^[0-9]{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 60_000;
/** Dialpad allows 5/min per user target and shares it with every other tool; 4 leaves one request of headroom. */
export const DIAL_RATE_LIMIT_PER_MINUTE = 4;
export const DIAL_RATE_RETRY_SECONDS = 60;

/** REST `group_type` for a caller identity (Phase 0 confirms the names; one table, one place). */
export const DIALPAD_GROUP_TYPE_BY_IDENTITY: Record<DialpadIdentityType, string> = {
  Office: 'office',
  OfficeGroup: 'department',
  CallCenter: 'callcenter',
};

export type DialpadDialProviderMode = 'stub' | 'live';

/** `DIALPAD_DIAL_PROVIDER=stub` is honoured only outside production. */
export function resolveDialpadDialProvider(env: DialpadDirectoryEnv): DialpadDialProviderMode {
  if (env.VERCEL_ENV === 'production') return 'live';
  return env.DIALPAD_DIAL_PROVIDER?.trim().toLowerCase() === 'stub' ? 'stub' : 'live';
}

export interface DialpadDialRequest {
  endpoint: DialpadDialEndpoint;
  apiKey: string;
  dialpadUserId: string;
  phoneNumber: string;
  customData: string;
  identity: { type: DialpadIdentityType; id: string } | null;
  outboundCallerId: string | null;
}

export type DialpadDialRejection = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid' | 'rate_limited';

export type DialpadDialResult =
  | { kind: 'accepted'; status: number; providerCallId: string | null }
  | { kind: 'rejected'; status: number; reason: DialpadDialRejection; retryAfterSeconds: number | null }
  /** Timeout, network error or 5xx: the call may have been placed. Never retried with a new key. */
  | { kind: 'unknown' };

export interface DialpadDialer {
  dial(request: DialpadDialRequest): Promise<DialpadDialResult>;
}

export type DialpadDialFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; redirect: 'error'; cache: 'no-store'; signal: AbortSignal },
) => Promise<{ status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>;

/** `dial_api_key_ref` wins when set (its own namespace); otherwise the directory key dials too (Phase 0 default). */
export function resolveDialpadDialKey(connection: Pick<DialpadConnectionView, 'dialKeyRef' | 'directoryKeyRef'>, env: DialpadDirectoryEnv): string | null {
  if (connection.dialKeyRef) {
    const match = DIAL_KEY_REF.exec(connection.dialKeyRef);
    if (!match) return null;
    const value = env[match[1]!];
    return typeof value === 'string' && value.length >= MIN_KEY_LENGTH ? value : null;
  }
  return resolveDialpadDirectoryKey(connection.directoryKeyRef, env);
}

export function dialpadDialUrl(request: Pick<DialpadDialRequest, 'endpoint' | 'dialpadUserId'>): string {
  if (!DIGITS.test(request.dialpadUserId)) throw new Error('Invalid dialpadUserId.');
  return request.endpoint === 'call'
    ? `${DIALPAD_API_ORIGIN}/api/v2/call`
    : `${DIALPAD_API_ORIGIN}/api/v2/users/${request.dialpadUserId}/initiate_call`;
}

/** Manual JSON so int64 ids stay exact integers (pattern: provisioning.ts subscription bodies). */
export function buildDialpadDialBody(request: DialpadDialRequest): string {
  if (!E164.test(request.phoneNumber)) throw new Error('Invalid phone number.');
  if (!DIALPAD_CTI_CUSTOM_DATA_PATTERN.test(request.customData) || request.customData.length > DIALPAD_CUSTOM_DATA_MAX) throw new Error('Invalid custom_data.');
  if (request.identity && request.outboundCallerId) throw new Error('A caller identity and an outbound caller id are mutually exclusive.');
  if (request.identity && !DIGITS.test(request.identity.id)) throw new Error('Invalid identity id.');
  if (request.outboundCallerId !== null && !E164.test(request.outboundCallerId)) throw new Error('Invalid outbound caller id.');
  const parts: string[] = [];
  if (request.endpoint === 'call') {
    if (!DIGITS.test(request.dialpadUserId)) throw new Error('Invalid dialpadUserId.');
    parts.push(`"user_id":${request.dialpadUserId}`);
  }
  parts.push(`"phone_number":${JSON.stringify(request.phoneNumber)}`);
  parts.push(`"custom_data":${JSON.stringify(request.customData)}`);
  if (request.identity) {
    parts.push(`"group_id":${request.identity.id}`);
    parts.push(`"group_type":${JSON.stringify(DIALPAD_GROUP_TYPE_BY_IDENTITY[request.identity.type])}`);
  } else if (request.outboundCallerId) {
    parts.push(`"outbound_caller_id":${JSON.stringify(request.outboundCallerId)}`);
  }
  return `{${parts.join(',')}}`;
}

function parseRetryAfter(headers: { get(name: string): string | null } | undefined): number | null {
  const raw = headers?.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 600) : null;
}

function parseProviderCallId(text: string): string | null {
  const match = /"call_id"\s*:\s*"?([0-9]{1,20})"?/.exec(text);
  return match ? match[1]! : null;
}

/** POST, 10 s timeout, redirect:'error', cache:'no-store', never retries. The key and the response body never leave this function. */
export function createDialpadHttpDialer(fetchImpl?: DialpadDialFetch): DialpadDialer {
  const doFetch: DialpadDialFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    async dial(request) {
      const url = dialpadDialUrl(request);
      const body = buildDialpadDialBody(request);
      let response: Awaited<ReturnType<DialpadDialFetch>>;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${request.apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
          body,
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        return { kind: 'unknown' };
      }
      const status = response.status;
      if (status === 200 || status === 201 || status === 202) {
        let text = '';
        try {
          text = await response.text();
        } catch {
          text = '';
        }
        return { kind: 'accepted', status, providerCallId: parseProviderCallId(text) };
      }
      if (status === 429) return { kind: 'rejected', status, reason: 'rate_limited', retryAfterSeconds: parseRetryAfter(response.headers) ?? DIAL_RATE_RETRY_SECONDS };
      if (status === 401) return { kind: 'rejected', status, reason: 'unauthorized', retryAfterSeconds: null };
      if (status === 403) return { kind: 'rejected', status, reason: 'forbidden', retryAfterSeconds: null };
      if (status === 404) return { kind: 'rejected', status, reason: 'not_found', retryAfterSeconds: null };
      if (status >= 400 && status < 500) return { kind: 'rejected', status, reason: 'invalid', retryAfterSeconds: null };
      return { kind: 'unknown' };
    },
  };
}

/* Seam S1: the stub provider records would-be dials where the acceptance specs can read them. */
export interface StubDialpadDial {
  at: string;
  endpoint: DialpadDialEndpoint;
  dialpadUserId: string;
  phoneNumber: string;
  customData: string;
  outboundCallerId: string | null;
  identity: { type: DialpadIdentityType; id: string } | null;
}
const stubDials: StubDialpadDial[] = [];
export function readStubDialpadDials(): readonly StubDialpadDial[] {
  return stubDials.slice();
}
export function resetStubDialpadDials(): void {
  stubDials.length = 0;
}
export function createStubDialpadDialer(now: () => Date = () => new Date()): DialpadDialer {
  return {
    async dial(request) {
      // Validate exactly like the live dialer so the stub cannot accept a body Dialpad would reject.
      dialpadDialUrl(request);
      buildDialpadDialBody(request);
      stubDials.push({
        at: now().toISOString(),
        endpoint: request.endpoint,
        dialpadUserId: request.dialpadUserId,
        phoneNumber: request.phoneNumber,
        customData: request.customData,
        outboundCallerId: request.outboundCallerId,
        identity: request.identity,
      });
      return { kind: 'accepted', status: 200, providerCallId: null };
    },
  };
}

export function createDialpadDialer(env: DialpadDirectoryEnv, fetchImpl?: DialpadDialFetch): DialpadDialer {
  return resolveDialpadDialProvider(env) === 'stub' ? createStubDialpadDialer() : createDialpadHttpDialer(fetchImpl);
}

/* ------------------------------------------------------------------------ */
/* The dial flow                                                            */
/* ------------------------------------------------------------------------ */

export type DialpadApiDialInput = {
  propertyId: unknown;
  contactId: unknown;
  /** 1 | 2 | 3, or null/undefined for the first callable slot (server-side DNC pre-check). */
  phoneSlot: unknown;
  idempotencyKey: unknown;
  /** The unresolved prior intent the rep chose to redial after the caution. Only honoured when it is the newest one. */
  confirmRedialOf?: unknown;
};

export type DialpadApiDialOutcome =
  | { ok: true; intentId: string; state: 'awaiting_provider'; uncertain: boolean; phoneSlot: 1 | 2 | 3 }
  | { ok: true; intentId: string; state: 'already_dispatched' }
  | {
      ok: false;
      code: DialpadFailureCode | 'rate_limited' | 'call_in_flight' | 'provider_rejected' | 'dialpad_unavailable' | 'prior_call_unresolved';
      message: string;
      retryAfterSeconds?: number;
      /** True only after a proven non-dispatch rejection: the client may mint a new idempotency key. */
      freshAttemptKey?: boolean;
      /** Set with `prior_call_unresolved`: the earlier intent the rep must explicitly confirm to redial. */
      priorIntentId?: string;
      denial?: DialpadDenialDetail;
    };

export interface DialpadApiDialDeps {
  env: DialpadDirectoryEnv;
  now?: () => Date;
}

const SLOT_DENIAL: Record<NonNullable<DialpadCallSlot['reason']>, DialpadDenialDetail> = {
  property_dnc: 'property_dnc_locked',
  contact_dnc: 'contact_do_not_contact',
  phone_dnc: 'phone_dnc',
  invalid: 'phone_unavailable',
};

function isMatchedCancel(error: unknown): boolean {
  return error instanceof DialpadDbError && error.failure.kind === 'forbidden' && error.failure.detail === 'intent_already_matched';
}

/** Cancels the intent; an intent the webhook already matched (events beat the HTTP response) counts as placed. */
async function cancelOrMatched(db: DialpadDispatchDb, actor: DialpadActor, intentId: string): Promise<'cancelled' | 'matched'> {
  try {
    await db.cancelIntent(actor.orgId, actor.userId, intentId);
    return 'cancelled';
  } catch (error) {
    if (isMatchedCancel(error)) return 'matched';
    throw error;
  }
}

export async function startDialpadApiCall(
  db: DialpadDispatchDb,
  dialer: DialpadDialer,
  actor: DialpadActor,
  input: DialpadApiDialInput,
  deps: DialpadApiDialDeps,
): Promise<DialpadApiDialOutcome> {
  const now = deps.now ?? (() => new Date());
  const { propertyId, contactId, idempotencyKey } = input;
  if (typeof propertyId !== 'string' || !UUID.test(propertyId) || typeof contactId !== 'string' || !UUID.test(contactId)
      || typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)
      || (input.confirmRedialOf !== undefined && input.confirmRedialOf !== null && (typeof input.confirmRedialOf !== 'string' || !UUID.test(input.confirmRedialOf)))
      || (input.phoneSlot !== null && input.phoneSlot !== undefined && input.phoneSlot !== 1 && input.phoneSlot !== 2 && input.phoneSlot !== 3)) {
    return { ok: false, code: 'invalid_input', message: 'Choose a lead and contact first.' };
  }
  try {
    // Accepted race: load-then-act is not atomic; simultaneous dials from one rep could both pass
    // these guards. Accepted for a single rep (the provider 429 is the backstop).
    // 1. Rate and in-flight guards before anything is prepared (a refusal here never created an intent).
    const load = await db.loadDispatchLoad(actor.orgId, actor.userId, new Date(now().getTime() - RATE_WINDOW_MS).toISOString());
    if (load.authorizedLastMinute >= DIAL_RATE_LIMIT_PER_MINUTE) {
      return { ok: false, code: 'rate_limited', message: 'Dialpad allows a few calls a minute. Sandra will retry shortly.', retryAfterSeconds: DIAL_RATE_RETRY_SECONDS, freshAttemptKey: true };
    }
    if (load.unmatchedLast20s > 0) {
      return { ok: false, code: 'call_in_flight', message: 'A call is already being placed. Wait for Dialpad to confirm it.' };
    }

    // 1b. Per-lead backstop that does not depend on client memory (reload, second tab, a key overwritten):
    // while an earlier released intent for this lead is unmatched and unexpired, it may have rung, so a
    // NEW key is refused unless the rep confirmed that exact intent. A replay of the intent's own key passes.
    const unresolved = await db.loadUnresolvedIntent(actor.orgId, actor.userId, propertyId, now().toISOString());
    if (unresolved && unresolved.idempotencyKey !== idempotencyKey && input.confirmRedialOf !== unresolved.intentId) {
      return {
        ok: false,
        code: 'prior_call_unresolved',
        message: 'Your last call to this lead was never confirmed. It may have rung. Check Dialpad before calling again.',
        priorIntentId: unresolved.intentId,
      };
    }

    // 2. Server-side DNC pre-check picks (or validates) the slot. Enforcement happens again inside prepare/authorize.
    const slots = await db.loadCallSlots(actor.orgId, actor.userId, propertyId, contactId);
    const wanted = input.phoneSlot === 1 || input.phoneSlot === 2 || input.phoneSlot === 3 ? input.phoneSlot : null;
    const chosen = wanted ? slots.find((slot) => slot.slot === wanted) ?? null : slots.find((slot) => slot.callable) ?? null;
    if (!chosen || !chosen.callable) {
      const reason = chosen?.reason ?? slots.find((slot) => slot.reason)?.reason ?? 'invalid';
      const denial = SLOT_DENIAL[reason];
      // No intent exists yet: proven non-dispatch.
      return { ok: false, code: 'denied', message: dialpadDenialMessage(denial), denial, freshAttemptKey: true };
    }

    // 2b. Calling hours: the existing lead-local 08:00-21:00 rule, unchanged, before any intent is prepared
    // or authorized, so a blocked call creates no intent and reaches no provider. Unknown or missing state fails closed.
    const property = await db.loadPropertyState(actor.orgId, propertyId);
    if (!property.found || !checkQuietHours(property.state, now()).ok) {
      return { ok: false, code: 'denied', message: dialpadDenialMessage('outside_calling_hours'), denial: 'outside_calling_hours', freshAttemptKey: true };
    }

    // 3. Caller id: the oldest active grant, or none (the rep's own line keeps A-level attestation).
    const grants = await db.loadActiveGrants(actor.orgId, actor.userId);
    const grantId = grants[0]?.id ?? null;

    // 4. Prepare + authorize (one transaction each; DNC, assignment, grant and phone are re-proven).
    const started = await startDialpadCall(db, actor, { propertyId, contactId, phoneSlot: chosen.slot, grantId, idempotencyKey }, { allowLargeIdentityIds: true });
    if (!started.ok) {
      // Refused before the payload was released (denied, cancelled): proven non-dispatch, the key is dead.
      return started.code === 'denied' || started.code === 'cancelled' ? { ...started, freshAttemptKey: true } : started;
    }
    if (!started.dispatched) return { ok: true, intentId: started.intentId, state: 'already_dispatched' };

    // 5. Key. Unresolved → cancel; nothing was dialed.
    const connection = await db.loadConnection(actor.orgId);
    const apiKey = connection ? resolveDialpadDialKey(connection, deps.env) : null;
    if (!connection || !apiKey) {
      await cancelOrMatched(db, actor, started.intentId);
      return { ok: false, code: 'not_configured', message: 'Dialpad API dialing is not configured for this organization. Ask an owner to finish setup.', freshAttemptKey: true };
    }

    // 6. Dial.
    const identity = started.dial.identityType && started.dial.identityIdText ? { type: started.dial.identityType, id: started.dial.identityIdText } : null;
    const result = await dialer.dial({
      endpoint: connection.dialEndpoint ?? DIALPAD_DIAL_ENDPOINT_DEFAULT,
      apiKey,
      dialpadUserId: started.dial.dialpadUserId,
      phoneNumber: started.dial.phoneNumber,
      customData: started.dial.customData,
      identity,
      outboundCallerId: identity ? null : started.dial.outboundCallerId,
    });
    if (result.kind === 'accepted') return { ok: true, intentId: started.intentId, state: 'awaiting_provider', uncertain: false, phoneSlot: chosen.slot };
    if (result.kind === 'unknown') {
      // The call may exist: keep the intent; the 2.2 timeout marks it failed if no event arrives.
      return { ok: true, intentId: started.intentId, state: 'awaiting_provider', uncertain: true, phoneSlot: chosen.slot };
    }
    // Proven non-dispatch rejection: cancel, so the same key can never release again.
    const cancel = await cancelOrMatched(db, actor, started.intentId);
    if (cancel === 'matched') return { ok: true, intentId: started.intentId, state: 'awaiting_provider', uncertain: false, phoneSlot: chosen.slot };
    if (result.reason === 'rate_limited') {
      return {
        ok: false,
        code: 'rate_limited',
        message: 'Dialpad is rate limiting calls. Sandra will retry shortly.',
        retryAfterSeconds: result.retryAfterSeconds ?? DIAL_RATE_RETRY_SECONDS,
        freshAttemptKey: true,
      };
    }
    reportError(new Error('dialpad api dial rejected'), {
      tags: { surface: 'dialpad_api_dial', reason: result.reason, status: String(result.status), endpoint: connection.dialEndpoint },
    });
    return { ok: false, code: 'provider_rejected', message: 'Dialpad refused this call. Nothing was dialed; check the Dialpad connection.', freshAttemptKey: true };
  } catch (error) {
    reportError(error instanceof Error ? error : new Error('dialpad api dial failed'), { tags: { surface: 'dialpad_api_dial', kind: 'unexpected' } });
    return { ok: false, code: 'dialpad_unavailable', message: 'Sandra could not reach Dialpad calling. Nothing was dialed; try again.' };
  }
}
