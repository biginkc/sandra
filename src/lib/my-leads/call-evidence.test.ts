import { describe, expect, it } from 'vitest';
import { callTokenDigest, parseActualSellerCallStarted, type ActualSellerCallStarted } from './call-evidence';
const event: ActualSellerCallStarted = {
  eventId: '10000000-0000-4000-8000-000000000001', eventVersion: 1,
  orgId: '10000000-0000-4000-8000-000000000002', propertyId: '10000000-0000-4000-8000-000000000003',
  actorUserId: '10000000-0000-4000-8000-000000000004', assignmentEpisodeId: '10000000-0000-4000-8000-000000000005',
  sandraCallToken: 'aaaaaaaa-0000-4000-8000-000000000006', jitterCallId: 'jitter-123', sellerProviderCallId: 'call-456',
  occurredAt: '2026-09-11T09:00:00-05:00', evidence: 'seller_call_create_succeeded',
};
describe('seller initiation evidence boundary', () => {
  it('normalizes time and drops unrelated fields', () => {
    expect(parseActualSellerCallStarted({ ...event, credential: 'not-forwarded' }, event.orgId)).toEqual({ ...event, occurredAt: '2026-09-11T14:00:00.000Z' });
  });
  it.each(['operator_connected', 'rtc_registered', 'session_created', 'seller_answered'])('rejects %s as initiation evidence', evidence => {
    expect(parseActualSellerCallStarted({ ...event, evidence }, event.orgId)).toBeNull();
  });
  it('rejects a foreign organization even for otherwise valid evidence', () => {
    expect(parseActualSellerCallStarted(event, event.actorUserId)).toBeNull();
  });
  it.each([{ eventVersion: 2 }, { sellerProviderCallId: '' }, { occurredAt: '2026-09-11' }, { occurredAt: 'bad' }, { occurredAt: '2026-02-30T12:00:00Z' }, { assignmentEpisodeId: undefined }, { sandraCallToken: 'v1.signed.capability' }])('rejects malformed identity/time/version %j', patch => {
    expect(parseActualSellerCallStarted({ ...event, ...patch }, event.orgId)).toBeNull();
  });
  it('allows a genuine call without an acquisition episode', () => {
    expect(parseActualSellerCallStarted({ ...event, assignmentEpisodeId: null }, event.orgId)?.assignmentEpisodeId).toBeNull();
  });
  it('uses a stable digest and rejects signed capability material', () => {
    expect(callTokenDigest(event.sandraCallToken)).toMatch(/^[0-9a-f]{64}$/);
    expect(callTokenDigest(event.sandraCallToken.toUpperCase())).toBe(callTokenDigest(event.sandraCallToken));
    expect(() => callTokenDigest('v1.signed.capability')).toThrow('Invalid call identity');
  });
});
