import { describe, expect, it } from 'vitest';
import {
  acquisitionAttemptInput,
  acquisitionMutationEnvelope,
  motivationResponse,
  offerAmountCents,
  offerFollowUp,
} from './validation';
describe('offer input', () => {
  it('distinguishes an explicit no-motivation response from missing input', () => {
    expect(motivationResponse(undefined, '')).toMatchObject({ ok: false });
    expect(motivationResponse('specified', '  ')).toMatchObject({ ok: false });
    expect(motivationResponse('specified', ' Moving ')).toEqual({ ok: true, value: { kind: 'specified', text: 'Moving' } });
    expect(motivationResponse('no_motivation', '')).toEqual({ ok: true, value: { kind: 'no_motivation', text: null } });
  });
  it.each([['0.01', 1], ['250000', 25000000], ['123.45', 12345], ['10.1', 1010]])('parses %s into cents', (input, expected) => {
    expect(offerAmountCents(input)).toEqual({ ok: true, value: expected });
  });
  it.each(['0', '-1', '1e6', '12.345', 'Infinity', '', '9007199254740992'])('rejects invalid amount %s', input => {
    expect(offerAmountCents(input).ok).toBe(false);
  });
  it('requires a later explicit follow-up while allowing an overdue historical log', () => {
    expect(offerFollowUp('2026-01-01T14:00:00Z', '2026-01-01T15:00:00Z').ok).toBe(true);
    expect(offerFollowUp('2026-01-01T14:00:00Z', '2026-01-01T14:00:00Z').ok).toBe(false);
    expect(offerFollowUp('2026-01-01T14:00:00Z', '2026-01-01T13:00:00Z').ok).toBe(false);
    expect(offerFollowUp('2026-01-01T14:00', '2026-01-01T15:00').ok).toBe(false);
  });
});

describe('acquisition command validation', () => {
  it('allows pending Sandra calls but requires outcomes for external outreach', () => {
    expect(acquisitionAttemptInput('call', 'sandra', null).ok).toBe(true);
    expect(acquisitionAttemptInput('call', 'dialpad', null).ok).toBe(false);
    expect(acquisitionAttemptInput('outreach', 'manual', 'reached').ok).toBe(true);
    expect(acquisitionAttemptInput('outreach', 'dialpad', 'reached').ok).toBe(false);
  });

  it('rejects malformed or negative CAS envelopes', () => {
    expect(acquisitionMutationEnvelope(null).ok).toBe(false);
    expect(acquisitionMutationEnvelope({
      propertyId: '00000000-0000-4000-8000-000000000001',
      expectedEpisodeId: null,
      expectedQueueVersion: -1,
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
    }).ok).toBe(false);
  });

  it('accepts a zero-version envelope for a property without queue state', () => {
    expect(acquisitionMutationEnvelope({
      propertyId: '00000000-0000-4000-8000-000000000001',
      expectedEpisodeId: '00000000-0000-4000-8000-000000000003',
      expectedQueueVersion: 0,
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
    })).toMatchObject({ ok: true });
  });
});
