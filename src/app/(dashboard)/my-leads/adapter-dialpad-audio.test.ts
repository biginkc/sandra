import { describe, expect, it } from 'vitest';
import { detailView } from './adapter';
import type { AcquisitionDetail, AcquisitionRoster } from '@/lib/my-leads/queries';

const attempt = (source: string, over: Record<string, unknown> = {}) => ({
  groups: { attempts: { rows: [{ id: `attempt-${source}`, actorId: null, at: '2026-10-06T18:00:00Z', source, outcome: 'reached', callActivityId: 'call-7', recordingUrl: null, ...over }], hasMore: false, cursor: null } },
}) as unknown as AcquisitionDetail;
const row = (detail: AcquisitionDetail) => detailView(detail, { members: [] } as unknown as AcquisitionRoster).attempts.rows[0]!;

describe('Dialpad call identity in the lead detail', () => {
  it('a Dialpad attempt exposes dialpadCallActivityId and keeps callActivityId Sandra-only (null)', () => {
    expect(row(attempt('dialpad'))).toMatchObject({ callActivityId: null, dialpadCallActivityId: 'call-7' });
  });

  it('a Sandra attempt keeps callActivityId and has no Dialpad identity; a manual attempt has neither', () => {
    expect(row(attempt('sandra'))).toMatchObject({ callActivityId: 'call-7', dialpadCallActivityId: null });
    expect(row(attempt('manual'))).toMatchObject({ callActivityId: null, dialpadCallActivityId: null });
  });

  it('a Dialpad attempt with no linked call has no identity, and the pasted link survives', () => {
    expect(row(attempt('dialpad', { callActivityId: null, recordingUrl: 'https://dialpad.com/r/abc' }))).toMatchObject({
      dialpadCallActivityId: null, recordingUrl: 'https://dialpad.com/r/abc',
    });
  });
});
