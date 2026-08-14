"use client";

import { useState } from "react";

import type {
  CalendarAppointmentRow,
  CalendarDayBounds,
  CalendarViewerRole,
} from "../types";

import { AppointmentBlock } from "./appointment-block";
import { dayIndexForAppointment, formatAgendaDayHeader } from "./calendar-shared";

type Props = {
  days: CalendarDayBounds[];
  appointments: CalendarAppointmentRow[];
  timezone: string;
  viewerRole: CalendarViewerRole;
  /** Fed `assigneeLabels` (not the roster-only `assignees`) by
   *  `CalendarView` — a superset covering an inactive/former assignee too
   *  (Codex round 4), since this is only ever used for the per-row
   *  "whose appointment" label, never a selectable option list. */
  assignees: Record<string, string>;
  currentUserId: string;
};

const VISIBLE_ROW_CAP = 40;

/**
 * Chronological appointment list grouped by zone-local day header — this
 * IS the mobile experience (day-agenda, always shown below `md` regardless
 * of `?view`) and the desktop `?view=agenda` layout. Same row content as
 * WeekGrid (shared `AppointmentBlock`), just laid out as a flat,
 * day-headered list instead of 7 columns.
 *
 * Caps legibility at 40 visible rows total (plan: "≤40-row legibility"); a
 * "Show more" control reveals the rest. This is the one `_components` file
 * that needs `"use client"` for its own reason (the expand toggle), not
 * merely because a parent happens to be client.
 */
export function AgendaList({
  days,
  appointments,
  timezone,
  viewerRole,
  assignees,
  currentUserId,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  const sorted = [...appointments].sort(
    (a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime(),
  );

  if (sorted.length === 0) {
    return (
      <p
        className="text-muted-foreground px-1 py-4 text-sm"
        data-testid="calendar-agenda-empty"
      >
        No appointments this week.
      </p>
    );
  }

  const visible = expanded ? sorted : sorted.slice(0, VISIBLE_ROW_CAP);
  const hiddenCount = sorted.length - visible.length;

  // Group the VISIBLE slice by day — grouping AFTER slicing keeps the cap
  // an exact total-row-count cap rather than a per-group one.
  const groups: { day: CalendarDayBounds; rows: CalendarAppointmentRow[] }[] = [];
  for (const appt of visible) {
    const idx = dayIndexForAppointment(appt, days);
    if (idx === -1) continue;
    const day = days[idx];
    const last = groups[groups.length - 1];
    if (last && last.day.date === day.date) {
      last.rows.push(appt);
    } else {
      groups.push({ day, rows: [appt] });
    }
  }

  return (
    <div data-testid="calendar-agenda-list">
      {groups.map(({ day, rows }) => (
        <div key={day.date} className="mb-4 last:mb-0">
          <div
            className="text-muted-foreground mb-2 text-[10px] font-bold tracking-widest uppercase"
            data-testid={`calendar-agenda-day-header-${day.date}`}
          >
            {formatAgendaDayHeader(day, timezone)}
          </div>
          <ul className="divide-border divide-y">
            {rows.map((appt) => (
              <li key={appt.id} className="py-1.5 first:pt-0 last:pb-0">
                <AppointmentBlock
                  currentUserId={currentUserId}
                  appt={appt}
                  timezone={timezone}
                  viewerRole={viewerRole}
                  assignees={assignees}
                  nowMs={nowMs}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mt-2 text-xs font-bold"
          onClick={() => setExpanded(true)}
          data-testid="calendar-agenda-show-more"
        >
          Show {hiddenCount} more
        </button>
      ) : null}
    </div>
  );
}
