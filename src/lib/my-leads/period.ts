import { addDaysInZone, getDayBoundsInZone, wallTimeToUtc } from '@/lib/time/zoned';
import { ACQUISITION_TIME_ZONE } from './time';

export type AcquisitionPeriod = 'today' | 'week' | 'month';
/** Current calendar period, half-open in Central time. Caller supplies server time. */
export function acquisitionPeriodBounds(period: AcquisitionPeriod, now: Date): { start: Date; end: Date } {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid instant');
  const { dayStart, dayEnd } = getDayBoundsInZone(now, ACQUISITION_TIME_ZONE);
  if (period === 'today') return { start: dayStart, end: dayEnd };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: ACQUISITION_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const calendarDay = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  if (period === 'week') {
    const offset = (calendarDay.getUTCDay() + 6) % 7;
    const start = addDaysInZone(dayStart, -offset, ACQUISITION_TIME_ZONE);
    return { start, end: addDaysInZone(start, 7, ACQUISITION_TIME_ZONE) };
  }
  if (period !== 'month') throw new RangeError('Invalid reporting period');
  const start = addDaysInZone(dayStart, 1 - Number(parts.day), ACQUISITION_TIME_ZONE);
  const daysInMonth = new Date(Date.UTC(Number(parts.year), Number(parts.month), 0)).getUTCDate();
  return { start, end: addDaysInZone(start, daysInMonth, ACQUISITION_TIME_ZONE) };
}

/** User-selected local dates are inclusive; SQL receives a half-open UTC range. */
export function acquisitionDateRange(startDate: string, endDate: string): { start: Date; end: Date } {
  const start = wallTimeToUtc({ date: startDate, time: '00:00', timeZone: ACQUISITION_TIME_ZONE });
  const endDay = wallTimeToUtc({ date: endDate, time: '00:00', timeZone: ACQUISITION_TIME_ZONE });
  if (!start.ok || !endDay.ok || endDay.utc < start.utc) throw new RangeError('Invalid date range');
  return { start: start.utc, end: addDaysInZone(endDay.utc, 1, ACQUISITION_TIME_ZONE) };
}
