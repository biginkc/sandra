import type { Json } from '@/lib/supabase/types';

/**
 * Typed contracts for the Dialpad CTI foundation (migration 20260929034021).
 * Dialpad documents no per-event id: an event is identified by
 * (call_id, state, event_timestamp) and the database adds a payload hash.
 * Sources: https://developers.dialpad.com/docs/call-events,
 * https://developers.dialpad.com/docs/event-subscriptions,
 * https://developers.dialpad.com/docs/dialpad-mini-dialer
 *
 * A2 dispatch contract: fn_prepare_dialpad_call_intent returns the stored,
 * immutable intent on an idempotent replay, whatever its state. That is
 * historical attribution, not permission to dial. Before dialing, A2 must
 * (1) accept only status 'prepared' with expiresAt in the future
 * (assessDialpadIntentForDispatch) and reject cancelled, matched and expired
 * intents, and (2) re-prove, in the same transaction that authorizes the dial,
 * that the frozen dialpadUserId, assignmentEpisodeId, destinationE164 and
 * caller number/grant are still the rep's current, verified and active values.
 * A revoked binding or grant cancels the intent permanently; a replacement
 * binding never revives it. The caller must prepare a new intent with a new
 * idempotency key.
 */

export const DIALPAD_CTI_CUSTOM_DATA_PATTERN = /^sandra\.dialpad\.v1\.[0-9a-f]{48}$/;
export const DIALPAD_CALL_ID_PATTERN = /^[0-9]{1,20}$/;
export const DIALPAD_IDENTITY_TYPES = ['Office', 'OfficeGroup', 'CallCenter'] as const;
export type DialpadIdentityType = (typeof DIALPAD_IDENTITY_TYPES)[number];

export const DIALPAD_EVENT_DISPOSITIONS = ['received', 'matched', 'quarantined', 'conflict'] as const;
export type DialpadEventDisposition = (typeof DIALPAD_EVENT_DISPOSITIONS)[number];

export const DIALPAD_QUARANTINE_REASONS = [
  'unknown_custom_data',
  'no_custom_data',
  'intent_cancelled',
  'intent_already_matched',
  'target_mismatch',
  'number_mismatch',
  'outside_intent_window',
  // Native-call matching (a call dialed outside Sandra).
  'no_binding',
  'no_lead_match',
  'ambiguous_lead',
  'dnc_number',
] as const;
export type DialpadQuarantineReason = (typeof DIALPAD_QUARANTINE_REASONS)[number];

export const DIALPAD_DENIAL_DETAILS = [
  'connection_inactive',
  'my_leads_disabled',
  'rep_not_active',
  'binding_not_verified',
  'binding_exists',
  'binding_not_pending',
  'property_unavailable',
  'property_dnc_locked',
  'not_assigned_rep',
  'contact_not_on_property',
  'contact_do_not_contact',
  'phone_unavailable',
  'phone_dnc',
  'caller_grant_unavailable',
  'granter_not_owner',
  'revoker_not_owner',
  'dialpad_user_already_bound',
  'intent_already_matched',
  'outside_calling_hours',
] as const;
export type DialpadDenialDetail = (typeof DIALPAD_DENIAL_DETAILS)[number];

export type DialpadRpcFailure =
  | { kind: 'forbidden'; detail: DialpadDenialDetail | null }
  | { kind: 'not_found' }
  | { kind: 'invalid_input'; detail: string | null }
  | { kind: 'idempotency_conflict' }
  | { kind: 'unknown' };

/** Maps a Postgres error raised by the CTI functions (SQLSTATE and detail) to a typed failure. */
export function classifyDialpadRpcError(error: { code?: string | null; details?: string | null; detail?: string | null } | null | undefined): DialpadRpcFailure {
  const detail = error?.details ?? error?.detail ?? null;
  switch (error?.code) {
    case '42501':
      return { kind: 'forbidden', detail: (DIALPAD_DENIAL_DETAILS as readonly string[]).includes(detail ?? '') ? (detail as DialpadDenialDetail) : null };
    case 'P0002':
      return { kind: 'not_found' };
    case '22023':
      return { kind: 'invalid_input', detail };
    case '40001':
      return { kind: 'idempotency_conflict' };
    default:
      return { kind: 'unknown' };
  }
}

export interface PreparedDialpadCallIntent {
  intentId: string;
  /** Opaque token sent to Dialpad initiate_call as custom_data (documented limit: 2000 characters). */
  customData: string;
  status: 'prepared' | 'matched' | 'cancelled';
  preparedAt: string;
  expiresAt: string;
  destinationE164: string;
  phoneSlot: 1 | 2 | 3;
  callerNumberE164: string | null;
  callerIdentityType: DialpadIdentityType | null;
  callerIdentityId: string | null;
  dialpadUserId: string;
  propertyId: string;
  contactId: string;
  assignmentEpisodeId: string;
  replayed: boolean;
}

export type DialpadIntentDispatchAssessment =
  | { dispatchable: true }
  | { dispatchable: false; reason: 'cancelled' | 'matched' | 'expired' | 'invalid_expiry' };

/** Necessary, not sufficient: it checks only the intent's own state, not the frozen identity/assignment/phone/grant. */
export function assessDialpadIntentForDispatch(
  intent: Pick<PreparedDialpadCallIntent, 'status' | 'expiresAt'>,
  now: Date,
): DialpadIntentDispatchAssessment {
  if (intent.status === 'cancelled') return { dispatchable: false, reason: 'cancelled' };
  if (intent.status === 'matched') return { dispatchable: false, reason: 'matched' };
  const expiresAt = Date.parse(intent.expiresAt);
  if (Number.isNaN(expiresAt)) return { dispatchable: false, reason: 'invalid_expiry' };
  if (expiresAt <= now.getTime()) return { dispatchable: false, reason: 'expired' };
  return { dispatchable: true };
}

export interface DialpadEventIngestResult {
  eventId: string;
  disposition: DialpadEventDisposition;
  replayed: boolean;
  conflict: boolean;
}

export interface DialpadEventMatchResult {
  eventId: string;
  disposition: DialpadEventDisposition;
  intentId: string | null;
  reason: string | null;
  replayed: boolean;
}

function record(value: Json | null | undefined, label: string): { [key: string]: Json | undefined } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} response.`);
  return value;
}

function str(value: Json | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}.`);
  return value;
}

function nullableStr(value: Json | undefined, label: string): string | null {
  if (value === null || value === undefined) return null;
  return str(value, label);
}

function bool(value: Json | undefined, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}.`);
  return value;
}

function oneOf<T extends string>(value: Json | undefined, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Error(`Invalid ${label}.`);
  return value as T;
}

export function parsePreparedDialpadCallIntent(value: Json | null | undefined): PreparedDialpadCallIntent {
  const data = record(value, 'call intent');
  const customData = str(data.customData, 'customData');
  if (!DIALPAD_CTI_CUSTOM_DATA_PATTERN.test(customData)) throw new Error('Invalid customData.');
  const phoneSlot = data.phoneSlot;
  if (phoneSlot !== 1 && phoneSlot !== 2 && phoneSlot !== 3) throw new Error('Invalid phoneSlot.');
  const callerIdentityType = data.callerIdentityType === null || data.callerIdentityType === undefined
    ? null
    : oneOf(data.callerIdentityType, DIALPAD_IDENTITY_TYPES, 'callerIdentityType');
  return {
    intentId: str(data.intentId, 'intentId'),
    customData,
    status: oneOf(data.status, ['prepared', 'matched', 'cancelled'] as const, 'status'),
    preparedAt: str(data.preparedAt, 'preparedAt'),
    expiresAt: str(data.expiresAt, 'expiresAt'),
    destinationE164: str(data.destinationE164, 'destinationE164'),
    phoneSlot,
    callerNumberE164: nullableStr(data.callerNumberE164, 'callerNumberE164'),
    callerIdentityType,
    callerIdentityId: nullableStr(data.callerIdentityId, 'callerIdentityId'),
    dialpadUserId: str(data.dialpadUserId, 'dialpadUserId'),
    propertyId: str(data.propertyId, 'propertyId'),
    contactId: str(data.contactId, 'contactId'),
    assignmentEpisodeId: str(data.assignmentEpisodeId, 'assignmentEpisodeId'),
    replayed: bool(data.replayed, 'replayed'),
  };
}

export function parseDialpadEventIngestResult(value: Json | null | undefined): DialpadEventIngestResult {
  const data = record(value, 'event ingest');
  return {
    eventId: str(data.eventId, 'eventId'),
    disposition: oneOf(data.disposition, DIALPAD_EVENT_DISPOSITIONS, 'disposition'),
    replayed: bool(data.replayed, 'replayed'),
    conflict: bool(data.conflict, 'conflict'),
  };
}

export interface DialpadEventProcessResult {
  eventId: string;
  disposition: DialpadEventDisposition;
  intentId: string | null;
  reason: string | null;
  projected: boolean;
  callActivityId: string | null;
  attemptId: string | null;
  replayed: boolean;
}

export function parseDialpadEventProcessResult(value: Json | null | undefined): DialpadEventProcessResult {
  const data = record(value, 'event process');
  return {
    eventId: str(data.eventId, 'eventId'),
    disposition: oneOf(data.disposition, DIALPAD_EVENT_DISPOSITIONS, 'disposition'),
    intentId: nullableStr(data.intentId, 'intentId'),
    reason: nullableStr(data.reason, 'reason'),
    projected: bool(data.projected, 'projected'),
    callActivityId: nullableStr(data.callActivityId, 'callActivityId'),
    attemptId: nullableStr(data.attemptId, 'attemptId'),
    replayed: bool(data.replayed, 'replayed'),
  };
}

export function parseDialpadEventMatchResult(value: Json | null | undefined): DialpadEventMatchResult {
  const data = record(value, 'event match');
  return {
    eventId: str(data.eventId, 'eventId'),
    disposition: oneOf(data.disposition, DIALPAD_EVENT_DISPOSITIONS, 'disposition'),
    intentId: nullableStr(data.intentId, 'intentId'),
    reason: nullableStr(data.reason, 'reason'),
    replayed: bool(data.replayed, 'replayed'),
  };
}

export interface DialpadDialRelease {
  /** The frozen Dialpad user id of the verified binding (int64 as text); the server-side dialer never trusts a browser claim. */
  dialpadUserId: string;
  phoneNumber: string;
  customData: string;
  identityType: DialpadIdentityType | null;
  /** Dialpad ids are int64; kept as text until the caller proves it is a JS-safe integer. */
  identityId: string | null;
  outboundCallerId: string | null;
}

export type DialpadDispatchAuthorization =
  | { status: 'authorized'; intentId: string; expiresAt: string; dispatchAuthorizedAt: string; dial: DialpadDialRelease }
  | { status: 'already_dispatched' | 'cancelled' | 'matched' | 'expired'; intentId: string }
  | { status: 'denied'; intentId: string; denial: DialpadDenialDetail };

export function parseDialpadDispatchAuthorization(value: Json | null | undefined): DialpadDispatchAuthorization {
  const data = record(value, 'dispatch authorization');
  const status = oneOf(data.status, ['authorized', 'already_dispatched', 'cancelled', 'matched', 'expired', 'denied'] as const, 'status');
  const intentId = str(data.intentId, 'intentId');
  if (status === 'denied') return { status, intentId, denial: oneOf(data.denial, DIALPAD_DENIAL_DETAILS, 'denial') };
  if (status !== 'authorized') return { status, intentId };
  const dial = record(data.dial, 'dial release');
  const customData = str(dial.customData, 'customData');
  if (!DIALPAD_CTI_CUSTOM_DATA_PATTERN.test(customData)) throw new Error('Invalid customData.');
  const identityType = dial.identityType === null || dial.identityType === undefined
    ? null
    : oneOf(dial.identityType, DIALPAD_IDENTITY_TYPES, 'identityType');
  const identityId = nullableStr(dial.identityId, 'identityId');
  if (identityId !== null && !DIALPAD_CALL_ID_PATTERN.test(identityId)) throw new Error('Invalid identityId.');
  const dialpadUserId = str(dial.dialpadUserId, 'dialpadUserId');
  if (!DIALPAD_CALL_ID_PATTERN.test(dialpadUserId)) throw new Error('Invalid dialpadUserId.');
  if ((identityType === null) !== (identityId === null)) throw new Error('Invalid caller identity.');
  return {
    status,
    intentId,
    expiresAt: str(data.expiresAt, 'expiresAt'),
    dispatchAuthorizedAt: str(data.dispatchAuthorizedAt, 'dispatchAuthorizedAt'),
    dial: { dialpadUserId, phoneNumber: str(dial.phoneNumber, 'phoneNumber'), customData, identityType, identityId, outboundCallerId: nullableStr(dial.outboundCallerId, 'outboundCallerId') },
  };
}

export const DIALPAD_CALL_STATES = ['prepared', 'awaiting_provider', 'dialing', 'connected', 'ended', 'cancelled', 'expired', 'failed'] as const;
export type DialpadCallState = (typeof DIALPAD_CALL_STATES)[number];
/** States the panel keeps polling and recording for. `failed` is a marker, not terminal: a late event inside the window still projects. */
export const DIALPAD_ACTIVE_CALL_STATES: readonly DialpadCallState[] = ['prepared', 'awaiting_provider', 'dialing', 'connected', 'failed'];

export interface DialpadCallStatus {
  intentId: string;
  state: DialpadCallState;
  /** True only with signed connected/date_connected evidence, at any point in the call. */
  connected: boolean;
  propertyId: string;
  expiresAt: string;
  dispatchAuthorizedAt: string | null;
  /** Set once when an authorized dial got no provider event in time. A marker: a late event still matches. */
  failedAt: string | null;
  callActivityId: string | null;
  attemptId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  talkDurationSeconds: number | null;
  /** Latest owned recording capture for this intent, when one exists. */
  recordingCaptureId: string | null;
}

function nullableNumber(value: Json | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

export function parseDialpadCallStatus(value: Json | null | undefined): DialpadCallStatus {
  const data = record(value, 'call status');
  return {
    intentId: str(data.intentId, 'intentId'),
    state: oneOf(data.state, DIALPAD_CALL_STATES, 'state'),
    connected: bool(data.connected, 'connected'),
    propertyId: str(data.propertyId, 'propertyId'),
    expiresAt: str(data.expiresAt, 'expiresAt'),
    dispatchAuthorizedAt: nullableStr(data.dispatchAuthorizedAt, 'dispatchAuthorizedAt'),
    failedAt: nullableStr(data.failedAt, 'failedAt'),
    callActivityId: nullableStr(data.callActivityId, 'callActivityId'),
    attemptId: nullableStr(data.attemptId, 'attemptId'),
    startedAt: nullableStr(data.startedAt, 'startedAt'),
    endedAt: nullableStr(data.endedAt, 'endedAt'),
    durationSeconds: nullableNumber(data.durationSeconds, 'durationSeconds'),
    talkDurationSeconds: nullableNumber(data.talkDurationSeconds, 'talkDurationSeconds'),
    recordingCaptureId: nullableStr(data.recordingCaptureId, 'recordingCaptureId'),
  };
}
