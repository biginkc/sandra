/**
 * Convert a step's `delay_after_previous_minutes` into an absolute
 * timestamp, relative to a given anchor. Centralized so tests and the
 * cron tick agree on math to the millisecond.
 */
export function delayToDate(delayMinutes: number, from: Date): Date {
  if (delayMinutes < 0) {
    throw new Error(
      `delayToDate: delay must be non-negative, got ${delayMinutes}`,
    );
  }
  return new Date(from.getTime() + delayMinutes * 60_000);
}
