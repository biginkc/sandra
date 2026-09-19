import { acquisitionDateRange } from '@/lib/my-leads/period';
import { addDaysInZone, getDayBoundsInZone } from '@/lib/time/zoned';

export type RecordingScope = 'owner' | 'mine';
export type SearchParams = Record<string, string | string[] | undefined>;
export const TIME_ZONE = 'America/Chicago';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class InvalidRecordingFilter extends Error {}
export function parseRecordingFilters(input: SearchParams, scope: RecordingScope, now = new Date()) {
  const one = (name: string) => {
    const v = input[name];
    if (Array.isArray(v)) throw new InvalidRecordingFilter(`Choose one ${name}`);
    return v?.trim() || '';
  };
  const choice = <T extends string>(name: string, values: readonly T[], fallback: T): T => {
    const v = one(name) || fallback;
    if (!values.includes(v as T)) throw new InvalidRecordingFilter(`Invalid ${name}`);
    return v as T;
  };
  const period = choice('period', ['all', 'today', '7days', '30days', 'custom'], 'all');
  let from: string | null = null;
  let until: string | null = null;
  if (period === 'custom') {
    try {
      const range = acquisitionDateRange(one('from'), one('to'));
      from = range.start.toISOString(); until = range.end.toISOString();
    } catch { throw new InvalidRecordingFilter('Choose valid start and end dates'); }
  } else if (period !== 'all') {
    const { dayStart, dayEnd } = getDayBoundsInZone(now, TIME_ZONE);
    from = addDaysInZone(dayStart, period === '7days' ? -6 : period === '30days' ? -29 : 0, TIME_ZONE).toISOString();
    until = dayEnd.toISOString();
  }
  const seconds = (name: string) => {
    const v = one(name);
    if (!v) return null;
    if (!/^\d+$/.test(v) || Number(v) > 604800) throw new InvalidRecordingFilter('Recording length must be between 0 and 604800 seconds');
    return Number(v);
  };
  const min = seconds('min'); const max = seconds('max');
  if (min !== null && max !== null && min > max) throw new InvalidRecordingFilter('Minimum length exceeds maximum length');
  const rawUsers = input.user ? (Array.isArray(input.user) ? input.user : [input.user]) : [];
  const users = [...new Set(rawUsers.filter(Boolean))];
  if (users.length > 100 || users.some(u => !UUID.test(u))) throw new InvalidRecordingFilter('Invalid user selection');
  const group = choice('group', ['all', 'acquisitions', 'former', 'unattributed'], 'all');
  const association = choice('association', ['all', 'missing'], 'all');
  if (scope === 'mine' && (users.length || group !== 'all' || association !== 'all')) throw new InvalidRecordingFilter('Employee filters are available only in Recordings');
  const q = one('q'); const source = one('source'); const outcome = one('outcome');
  if (q.length > 200 || source.length > 80 || outcome.length > 100) throw new InvalidRecordingFilter('Filter is too long');
  const cursor = one('cursor');
  let after: { at: string; id: string } | null = null;
  if (cursor) {
    try {
      const parsed: unknown = JSON.parse(cursor);
      if (!parsed || typeof parsed !== 'object' || !('at' in parsed) || !('id' in parsed) || typeof parsed.at !== 'string' || typeof parsed.id !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(parsed.at) || !Number.isFinite(Date.parse(parsed.at)) || !/^(call|attempt):[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error();
      after = { at: parsed.at, id: parsed.id };
    } catch { throw new InvalidRecordingFilter('Invalid page cursor'); }
  }
  return { period, from, until, min, max, users, group, association, q, source, outcome, after,
    status: choice('status', ['available', 'all', 'pending', 'failed', 'missing', 'external', 'partial'], 'available'),
    direction: choice('direction', ['all', 'inbound', 'outbound', 'unknown'], 'all'),
    purpose: choice('purpose', ['all', 'customer', 'internal_training', 'unknown'], 'all'),
    transcript: choice('transcript', ['all', 'yes', 'no'], 'all'),
    summary: choice('summary', ['all', 'yes', 'no'], 'all'),
  };
}
export type RecordingFilters = ReturnType<typeof parseRecordingFilters>;
