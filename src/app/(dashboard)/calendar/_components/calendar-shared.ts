import { formatRelativeDay } from "@/lib/time/zoned";

import type { StatusVariant } from "@/components/ui/status-chip";

import type { CalendarAppointmentRow, CalendarDayBounds } from "../types";

/** "2:00–2:30 PM" in the given timezone. Appointment rows always carry a
 *  non-null `end_at` per the PR 1 CHECK, so unlike TasksPanel's variant of
 *  this helper there's no null-`endAt` fallback branch to handle. */
export function formatTimeRange(
  dueAt: string,
  endAt: string,
  timeZone: string,
): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  return `${fmt.format(new Date(dueAt))}–${fmt.format(new Date(endAt))}`;
}

/**
 * href for an appointment block/row, or null for a fully-unlinked personal
 * block. Deliberately DIFFERENT from TasksPanel's property-linked href
 * (`/messages?property_id=`) — this PR's own spec routes a property-linked
 * appointment straight to the lead detail page instead.
 */
export function appointmentHref(appt: CalendarAppointmentRow): string | null {
  if (appt.property_id) return `/leads/${appt.property_id}`;
  if (appt.contact_id) return `/messages?thread=${appt.contact_id}`;
  return null;
}

/** Primary label: property address when linked, contact name when
 *  contact-only, "Personal block" when neither — falls back to the raw
 *  appointment title if the expected label field is unexpectedly null
 *  (matches TasksPanel's `taskPrimaryLabel` degradation). */
export function appointmentLabel(appt: CalendarAppointmentRow): string {
  if (appt.property_id) return appt.address ?? appt.title;
  if (appt.contact_id) return appt.contact_name ?? appt.title;
  return "Personal block";
}

/** Only an OPEN appointment already past its start time gets the inline
 *  "How'd it go?" control — a completed/cancelled row (chip instead) or a
 *  not-yet-due one (nothing) never does. */
export function isPastDueOpen(
  appt: CalendarAppointmentRow,
  nowMs: number,
): boolean {
  return appt.status === "open" && new Date(appt.due_at).getTime() < nowMs;
}

/** Index into `days` whose `[startUtc, endUtc)` window contains the
 *  appointment's start, or -1 if none match (shouldn't happen given the
 *  week-scoped read model, but this degrades to "don't render" rather than
 *  throwing or mis-bucketing). */
export function dayIndexForAppointment(
  appt: CalendarAppointmentRow,
  days: CalendarDayBounds[],
): number {
  const t = new Date(appt.due_at).getTime();
  return days.findIndex(
    (d) =>
      t >= new Date(d.startUtc).getTime() && t < new Date(d.endUtc).getTime(),
  );
}

const OUTCOME_CHIP: Record<string, { variant: StatusVariant; label: string }> = {
  held: { variant: "new", label: "Held" },
  no_show: { variant: "hot", label: "No-show" },
  rescheduled: { variant: "cold", label: "Rescheduled" },
  cancelled: { variant: "dead", label: "Cancelled" },
};

/** Maps a completed appointment's `outcome` to the existing 6-hue
 *  StatusChip rather than inventing new colors (semantic tokens only). An
 *  unrecognized outcome value still renders — gray chip, raw label — so a
 *  future outcome type never disappears silently. */
export function outcomeChip(outcome: string): {
  variant: StatusVariant;
  label: string;
} {
  return OUTCOME_CHIP[outcome] ?? { variant: "contacted", label: outcome };
}

/** Weekday + numeric date column header, e.g. "Mon 8/18" — formatted in
 *  `timeZone` so it always agrees with the day's own zone-local bounds
 *  regardless of the runtime/test-process default zone. */
export function formatColumnHeader(
  day: CalendarDayBounds,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "numeric",
    day: "numeric",
  }).format(new Date(day.startUtc));
}

/** "Today" / "Tomorrow" / weekday-date agenda group header — delegates to
 *  the shared zoned-day helper `formatRelativeDay` per the plan's naming
 *  (humanDueDate/formatRelativeDay conventions). */
export function formatAgendaDayHeader(
  day: CalendarDayBounds,
  timeZone: string,
  now: Date = new Date(),
): string {
  return formatRelativeDay(new Date(day.startUtc), timeZone, now);
}

/** Today's YYYY-MM-DD in `timeZone` — drives the week grid's accent column
 *  and the nav bar's "Today" link target. */
export function todayDateKeyInZone(
  timeZone: string,
  now: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Adds/subtracts whole calendar days to a YYYY-MM-DD label — pure
 * date-label arithmetic, UTC-anchored so it never drifts with the runtime's
 * own zone. Used only to build the week-nav prev/next `?week=` hrefs; the
 * page re-derives the real zone-local week boundaries from that label
 * ("any day within the week works" per the shared contract in `../types`).
 */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
