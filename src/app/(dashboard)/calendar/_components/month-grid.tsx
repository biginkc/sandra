import Link from "next/link";

import type {
  CalendarAppointmentRow,
  CalendarDayBounds,
  CalendarViewerRole,
} from "../types";

import {
  appointmentHref,
  appointmentLabel,
  dayIndexForAppointment,
  todayDateKeyInZone,
} from "./calendar-shared";

/** Compact start-time label for a month cell ("4:45 PM") — the full
 *  formatTimeRange treatment (cross-midnight/DST markers) belongs to the
 *  week/agenda surfaces where there's room; the month cell links through
 *  to them for detail. */
function startTimeLabel(dueAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(dueAt));
}

const WEEKDAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** How many appointment lines a cell shows before collapsing into
 *  "+N more" (which links to that day's week view). */
const MAX_PER_CELL = 3;

type Props = {
  days: CalendarDayBounds[];
  appointments: CalendarAppointmentRow[];
  timezone: string;
  viewerRole: CalendarViewerRole;
  /** Fed `assigneeLabels` by `CalendarView` — same contract as WeekGrid. */
  assignees: Record<string, string>;
  currentUserId: string;
  /** YYYY-MM of the displayed month — cells outside it render muted. */
  month: string;
  /** Builds an href that jumps to a given day's WEEK view while
   *  preserving the current assignee filter (CalendarView owns the URL
   *  state, so it supplies the builder). */
  dayHref: (date: string) => string;
};

/**
 * Sunday-to-Saturday month grid (5 or 6 rows) — desktop-only like WeekGrid
 * (caller gates visibility below `md`; mobile keeps the agenda). Cells in
 * the displayed month show up to MAX_PER_CELL compact appointment lines
 * (start time + the same label rule as every other surface) plus a
 * "+N more" overflow link; leading/trailing cells from the neighboring
 * months render muted. The day number always links to that day's week
 * view — the month surface is for orientation, the week/agenda surfaces
 * own detail and lifecycle controls.
 */
export function MonthGrid({
  days,
  appointments,
  timezone,
  viewerRole,
  assignees,
  currentUserId,
  month,
  dayHref,
}: Props) {
  void viewerRole;
  const todayKey = todayDateKeyInZone(timezone);

  return (
    <div data-testid="calendar-month-grid">
      <div className="grid grid-cols-7 gap-2">
        {WEEKDAY_HEADERS.map((label) => (
          <div
            key={label}
            className="text-muted-foreground px-1 text-[10px] font-bold tracking-widest uppercase"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-7 gap-2">
        {days.map((day, i) => {
          const inMonth = day.date.slice(0, 7) === month;
          const isToday = day.date === todayKey;
          const dayAppointments = appointments
            .filter((a) => dayIndexForAppointment(a, days) === i)
            .sort(
              (a, b) =>
                new Date(a.due_at).getTime() - new Date(b.due_at).getTime(),
            );
          const visible = dayAppointments.slice(0, MAX_PER_CELL);
          const overflow = dayAppointments.length - visible.length;
          const dayNumber = Number(day.date.slice(8));

          return (
            <div
              key={day.date}
              className={`border-border rounded-xl border p-1.5 ${
                inMonth ? "bg-card" : "bg-background"
              } ${isToday ? "border-nav-active-border border-2" : ""}`}
              data-testid={`calendar-month-cell-${day.date}`}
              data-today={isToday || undefined}
              data-outside-month={!inMonth || undefined}
            >
              <Link
                href={dayHref(day.date)}
                className={`block text-xs font-bold hover:underline ${
                  inMonth ? "text-foreground" : "text-muted-foreground"
                }`}
                data-testid={`calendar-month-day-link-${day.date}`}
              >
                {dayNumber}
              </Link>
              <div className="mt-1 flex min-h-16 flex-col gap-0.5">
                {visible.map((appt) => {
                  const href = appointmentHref(appt);
                  // Ownership must survive the compact format (Codex
                  // round 4): in the owner's Everyone view several
                  // teammates' rows — especially personal blocks, which
                  // all label "Personal block" — are indistinguishable
                  // without it. Same rule as AppointmentBlock: label any
                  // row that isn't the viewer's own, via the superset
                  // label map (covers former teammates too).
                  const ownerLabel =
                    appt.assignee_id !== currentUserId
                      ? (assignees[appt.assignee_id] ??
                        `Former teammate (${appt.assignee_id.slice(0, 8)})`)
                      : null;
                  const line = (
                    <span className="block truncate text-[11px] leading-4">
                      <span className="text-muted-foreground font-bold tabular-nums">
                        {startTimeLabel(appt.due_at, timezone)}
                      </span>{" "}
                      <span
                        className={
                          appt.status === "completed"
                            ? "text-muted-foreground"
                            : "text-foreground"
                        }
                      >
                        {appointmentLabel(appt)}
                      </span>
                      {ownerLabel ? (
                        <span
                          className="text-muted-foreground"
                          data-testid={`calendar-month-owner-${appt.id}`}
                        >
                          {" "}
                          · {ownerLabel}
                        </span>
                      ) : null}
                    </span>
                  );
                  return href ? (
                    <Link
                      key={appt.id}
                      href={href}
                      className="hover:underline"
                      data-testid={`calendar-month-appointment-${appt.id}`}
                    >
                      {line}
                    </Link>
                  ) : (
                    <span
                      key={appt.id}
                      data-testid={`calendar-month-appointment-${appt.id}`}
                    >
                      {line}
                    </span>
                  );
                })}
                {overflow > 0 ? (
                  <Link
                    href={dayHref(day.date)}
                    className="text-muted-foreground text-[11px] font-bold hover:underline"
                    data-testid={`calendar-month-more-${day.date}`}
                  >
                    +{overflow} more
                  </Link>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
