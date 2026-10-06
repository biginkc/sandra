/**
 * The seller-reminder job decides quiet hours from the REAL clock (`getQuietHoursLocalTime(state, now)` with the cron's own `now`; the
 * `E2E_QUIET_HOURS_NOW` override is not read there): it sends only from 08:00 to 21:00 in the lead's zone. The synthetic leads are Missouri,
 * America/Chicago. A run (or a part of it) outside that window cannot exercise the send path, and must say so instead of passing.
 */
export function reminderWindowOpenAt(now: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(now));
  return hour >= 8 && hour < 21;
}
