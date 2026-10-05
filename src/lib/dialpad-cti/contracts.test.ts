import { describe, expect, it } from 'vitest';

import {
  assessDialpadIntentForDispatch,
  classifyDialpadRpcError,
  DIALPAD_CTI_CUSTOM_DATA_PATTERN,
  DIALPAD_QUARANTINE_REASONS,
  parseDialpadEventIngestResult,
  parseDialpadCallStatus,
  parseDialpadEventMatchResult,
  parsePreparedDialpadCallIntent,
} from './contracts';

const intent = {
  intentId: '11111111-1111-4111-8111-111111111111',
  customData: `sandra.dialpad.v1.${'a'.repeat(48)}`,
  status: 'prepared',
  preparedAt: '2026-09-28T12:00:00Z',
  expiresAt: '2026-09-28T12:10:00Z',
  destinationE164: '+18165550142',
  phoneSlot: 1,
  callerNumberE164: null,
  callerIdentityType: null,
  callerIdentityId: null,
  dialpadUserId: '5150000000000001',
  propertyId: '22222222-2222-4222-8222-222222222222',
  contactId: '33333333-3333-4333-8333-333333333333',
  assignmentEpisodeId: '44444444-4444-4444-8444-444444444444',
  replayed: false,
};

describe('dialpad CTI contracts', () => {
  it('parses a prepared intent and keeps custom_data within the documented 2000 character limit', () => {
    const parsed = parsePreparedDialpadCallIntent(intent);
    expect(parsed.customData.length).toBeLessThan(2000);
    expect(DIALPAD_CTI_CUSTOM_DATA_PATTERN.test(parsed.customData)).toBe(true);
    expect(parsed).toMatchObject({ phoneSlot: 1, callerIdentityType: null, replayed: false });
  });

  it.each([
    ['token shape', { customData: 'sandra.dialpad.v1.short' }],
    ['phone slot', { phoneSlot: 4 }],
    ['status', { status: 'dispatched' }],
    ['identity type', { callerIdentityType: 'Department' }],
    ['replayed flag', { replayed: 'no' }],
  ])('rejects an invalid %s', (_label, override) => {
    expect(() => parsePreparedDialpadCallIntent({ ...intent, ...override })).toThrow();
  });

  it('treats a replayed cancelled, matched or expired intent as not dispatchable', () => {
    const now = new Date('2026-09-28T12:05:00Z');
    expect(assessDialpadIntentForDispatch(parsePreparedDialpadCallIntent(intent), now)).toEqual({ dispatchable: true });
    expect(assessDialpadIntentForDispatch(parsePreparedDialpadCallIntent({ ...intent, status: 'cancelled', replayed: true }), now)).toEqual({ dispatchable: false, reason: 'cancelled' });
    expect(assessDialpadIntentForDispatch(parsePreparedDialpadCallIntent({ ...intent, status: 'matched', replayed: true }), now)).toEqual({ dispatchable: false, reason: 'matched' });
    expect(assessDialpadIntentForDispatch(parsePreparedDialpadCallIntent(intent), new Date('2026-09-28T12:10:00Z'))).toEqual({ dispatchable: false, reason: 'expired' });
    expect(assessDialpadIntentForDispatch({ status: 'prepared', expiresAt: 'not-a-date' }, now)).toEqual({ dispatchable: false, reason: 'invalid_expiry' });
  });

  it('rejects non-object responses', () => {
    expect(() => parsePreparedDialpadCallIntent(null)).toThrow();
    expect(() => parseDialpadEventIngestResult([] as never)).toThrow();
    expect(() => parseDialpadEventMatchResult('x')).toThrow();
  });

  it('parses ingest and match results', () => {
    expect(parseDialpadEventIngestResult({ eventId: 'e', disposition: 'received', replayed: false, conflict: false })).toEqual({
      eventId: 'e', disposition: 'received', replayed: false, conflict: false,
    });
    expect(parseDialpadEventMatchResult({ eventId: 'e', disposition: 'quarantined', intentId: null, reason: 'target_mismatch', replayed: false })).toMatchObject({
      disposition: 'quarantined', reason: 'target_mismatch', intentId: null,
    });
    expect(() => parseDialpadEventIngestResult({ eventId: 'e', disposition: 'processed', replayed: false, conflict: false })).toThrow();
  });

  it('classifies function failures by SQLSTATE and detail', () => {
    expect(classifyDialpadRpcError({ code: '42501', details: 'not_assigned_rep' })).toEqual({ kind: 'forbidden', detail: 'not_assigned_rep' });
    expect(classifyDialpadRpcError({ code: '42501', details: 'something_else' })).toEqual({ kind: 'forbidden', detail: null });
    expect(classifyDialpadRpcError({ code: 'P0002' })).toEqual({ kind: 'not_found' });
    expect(classifyDialpadRpcError({ code: '22023', details: 'phone_unavailable' })).toEqual({ kind: 'invalid_input', detail: 'phone_unavailable' });
    expect(classifyDialpadRpcError({ code: '40001' })).toEqual({ kind: 'idempotency_conflict' });
    expect(classifyDialpadRpcError(null)).toEqual({ kind: 'unknown' });
  });

  it('parses the failed call state and failedAt marker, and tolerates a status without failedAt', () => {
    const base = { intentId: 'i', state: 'failed', connected: false, propertyId: 'p', expiresAt: '2026-10-06T10:10:00Z', dispatchAuthorizedAt: '2026-10-06T10:00:00Z' };
    expect(parseDialpadCallStatus({ ...base, failedAt: '2026-10-06T10:02:00Z' })).toMatchObject({ state: 'failed', failedAt: '2026-10-06T10:02:00Z' });
    expect(parseDialpadCallStatus({ ...base, state: 'ended' })).toMatchObject({ state: 'ended', failedAt: null });
    expect(() => parseDialpadCallStatus({ ...base, state: 'bogus' })).toThrow();
  });

  it('knows the native-matching quarantine reasons', () => {
    expect(DIALPAD_QUARANTINE_REASONS).toEqual(expect.arrayContaining(['no_binding', 'no_lead_match', 'ambiguous_lead', 'dnc_number']));
  });
});
