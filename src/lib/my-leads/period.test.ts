import { describe, expect, it } from 'vitest';
import { acquisitionPeriodBounds, acquisitionDateRange } from './period';
describe('Central KPI periods', () => {
  it('uses the Central date before UTC midnight rollover', () => {
    const bounds = acquisitionPeriodBounds('today', new Date('2026-09-12T02:00Z'));
    expect(bounds.start.toISOString()).toBe('2026-09-11T05:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-09-12T05:00:00.000Z');
  });
  it('starts the week Monday and spans spring DST correctly', () => {
    const bounds = acquisitionPeriodBounds('week', new Date('2026-03-08T18:00Z'));
    expect(bounds.start.toISOString()).toBe('2026-03-02T06:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-03-09T05:00:00.000Z');
  });
  it('uses calendar month endpoints across fall DST', () => {
    const bounds = acquisitionPeriodBounds('month', new Date('2026-11-15T18:00Z'));
    expect(bounds.start.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-12-01T06:00:00.000Z');
  });
});

it('converts inclusive selected dates into Central half-open UTC range', () => {
  const range = acquisitionDateRange('2026-03-07', '2026-03-08');
  expect(range.start.toISOString()).toBe('2026-03-07T06:00:00.000Z');
  expect(range.end.toISOString()).toBe('2026-03-09T05:00:00.000Z');
  expect(() => acquisitionDateRange('2026-02-30', '2026-03-01')).toThrow(RangeError);
  expect(() => acquisitionDateRange('2026-09-12', '2026-09-11')).toThrow(RangeError);
});
