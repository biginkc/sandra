import { describe, expect, it } from 'vitest';
import { parseRecordingFilters } from './filters';
describe('recording library filter contract', () => {
  it('defaults to all dates and available recordings', () => {
    expect(parseRecordingFilters({}, 'owner')).toMatchObject({ from: null, until: null, status: 'available', users: [], group: 'all', after: null });
  });
  it('uses Central calendar boundaries across spring and fall DST', () => {
    const spring = parseRecordingFilters({period:'today'},'mine',new Date('2026-03-08T18:00:00Z'));
    expect(spring.from).toBe('2026-03-08T06:00:00.000Z'); expect(spring.until).toBe('2026-03-09T05:00:00.000Z');
    const fall = parseRecordingFilters({period:'custom',from:'2026-11-01',to:'2026-11-01'},'mine');
    expect(fall.from).toBe('2026-11-01T05:00:00.000Z'); expect(fall.until).toBe('2026-11-02T06:00:00.000Z');
  });
  it('rejects malformed dates, lengths, cursors and repeated scalar fields', () => {
    for (const input of [{period:'custom',from:'2026-02-30',to:'2026-03-01'}, {min:'80',max:'20'}, {min:'1.5'}, {cursor:'{}'}, {source:['jitter','manual']}]) expect(()=>parseRecordingFilters(input,'owner')).toThrow();
  });
  it('rejects employee options on My Recordings', () => {
    for(const input of [{group:'acquisitions'}, {association:'missing'}, {user:'10000000-0000-0000-0000-000000000001'}]) expect(()=>parseRecordingFilters(input,'mine')).toThrow();
  });
  it('matches a trailing seven calendar days including today', () => {
    expect(parseRecordingFilters({period:'7days'},'owner',new Date('2026-03-09T18:00:00Z'))).toMatchObject({from:'2026-03-03T06:00:00.000Z',until:'2026-03-10T05:00:00.000Z'});
  });
});
