import type {
  CalendarAppointmentRow,
  CalendarDayBounds,
  CalendarViewerRole,
} from "../types";

import { AppointmentBlock } from "./appointment-block";
import {
  dayIndexForAppointment,
  formatColumnHeader,
  todayDateKeyInZone,
} from "./calendar-shared";

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

/**
 * 7-column week grid — the desktop-only "secondary/read-mostly" surface
 * (caller gates visibility below `md`). Appointments are simple blocks
 * stacked in start-time order per day column; no absolute-positioned hour
 * grid, which the plan explicitly allows for this surface. Today's column
 * gets the `--nav-active-border` accent, the same token the sidebar uses
 * for its own active-link border.
 */
export function WeekGrid({
  days,
  appointments,
  timezone,
  viewerRole,
  assignees,
  currentUserId,
}: Props) {
  const todayKey = todayDateKeyInZone(timezone);
  // Server-rendered-once-per-request pattern (matches TasksPanel's own
  // `nowMs` capture) — stable for the life of this render.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  return (
    <div className="grid grid-cols-7 gap-2" data-testid="calendar-week-grid">
      {days.map((day, i) => {
        const isToday = day.date === todayKey;
        const dayAppointments = appointments
          .filter((a) => dayIndexForAppointment(a, days) === i)
          .sort(
            (a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime(),
          );

        return (
          <div
            key={day.date}
            className={`border-border bg-card min-h-32 rounded-xl border p-2 ${
              isToday ? "border-nav-active-border border-2" : ""
            }`}
            data-testid={`calendar-day-column-${day.date}`}
            data-today={isToday || undefined}
          >
            <div className="text-muted-foreground mb-2 text-[10px] font-bold tracking-widest uppercase">
              {formatColumnHeader(day, timezone)}
            </div>
            <div className="flex flex-col gap-1.5">
              {dayAppointments.length === 0 ? (
                <div className="text-muted-foreground text-xs">—</div>
              ) : (
                dayAppointments.map((appt) => (
                  <AppointmentBlock
                  currentUserId={currentUserId}
                    key={appt.id}
                    appt={appt}
                    timezone={timezone}
                    viewerRole={viewerRole}
                    assignees={assignees}
                    nowMs={nowMs}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
