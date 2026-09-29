import type { Json } from '@/lib/supabase/types';

/**
 * Typed contracts for the Dialpad CTI foundation (migration 20260929034021).
 * Dialpad documents no per-event id: an event is identified by
 * (call_id, state, event_timestamp) and the database adds a payload hash.
 * Sources: https://developers.dialpad.com/docs/call-events,
 * https://developers.dialpad.com/docs/event-subscriptions,
 * https://developers.dialpad.com/docs/dialpad-mini-dialer
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
