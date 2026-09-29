import { describe, expect, it } from 'vitest';
import { groupMyLeadDrips } from './drip-queries';

const progress = { propertyId: 'one', enrollmentId: 'e1', sequenceId: 's1', sequenceName: 'Warm check-in', step: 2, totalSteps: 4,
  nextTextAt: null, lastText: null, status: 'Waiting' as const, reason: null };

describe('groupMyLeadDrips', () => {
  it('uses exact stage and search scope when removing active drip rows', () => {
    const result = groupMyLeadDrips([
      { property_id: 'one', stage: 'contacted', in_drip: true, replied_at: null, search_text: 'One Main' },
      { property_id: 'two', stage: 'offer_sent', in_drip: true, replied_at: null, search_text: 'Two Oak' },
    ], [progress, { ...progress, propertyId: 'two' }], 'main');
    expect(result.active.map(row => row.propertyId)).toEqual(['one']);
    expect(result.counts.contacted).toBe(1);
    expect(result.counts.offer_sent).toBe(0);
  });

  it('keeps a replied flag only when the scope query returns a valid reply', () => {
    const result = groupMyLeadDrips([
      { property_id: 'one', stage: 'contacted', in_drip: false, replied_at: '2026-09-29T12:00:00Z', search_text: 'One Main' },
      { property_id: 'two', stage: 'contacted', in_drip: false, replied_at: null, search_text: 'Two Oak' },
    ], [progress, { ...progress, propertyId: 'two' }], '');
    expect(result.replied.map(row => row.propertyId)).toEqual(['one']);
  });
});
