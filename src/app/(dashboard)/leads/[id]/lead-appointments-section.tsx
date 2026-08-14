"use client";

import {
  AppointmentOutcomeRow,
  AppointmentUpcomingActions,
} from "@/components/appointments/appointment-outcome-row";

export type LeadAppointmentRow = {
  id: string;
  title: string;
  /** ISO timestamptz */
  due_at: string;
  end_at: string | null;
  assignee_id: string;
};

type Props = {
  appointments: LeadAppointmentRow[];
  /** Zone to render due/end times in — the viewer's own saved timezone
   *  (same `user_integration_prefs.timezone` source TasksPanel's
   *  `fetchMyTasks` reads, loaded via `loadIntegrationPrefs` and passed
   *  down by the lead page). Without an explicit `timeZone`,
   *  `Intl.DateTimeFormat` falls back to the runtime's device/OS zone,
   *  which silently disagrees with the viewer's saved preference whenever
   *  they differ (e.g. a rep traveling, or a server render in a different
   *  region than the viewer). */
  timezone: string;
};

function formatTimeRange(dueAt: string, endAt: string | null, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  });
  const start = new Date(dueAt);
  const range = endAt ? `${fmt.format(start)}–${fmt.format(new Date(endAt))}` : fmt.format(start);
  return `${dateFmt.format(start)}, ${range}`;
}

/**
 * Lead-detail "Appointments" section — the lead's own open appointments
 * (booked via BookAppointmentPopover above), each with the same outcome
 * ("How'd it go?") / reschedule / cancel controls as the dashboard's
 * TasksPanel: past-due gets the full outcome row, not-yet-due gets the
 * compact overflow. Each appointment keeps its own assignee (a lead's
 * appointments aren't necessarily all owned by the viewer), so the
 * assignee id comes from the row, not the session user.
 */
export function LeadAppointmentsSection({ appointments, timezone }: Props) {
  if (appointments.length === 0) {
    return (
      <div
        className="text-muted-foreground px-3 py-2 text-sm"
        data-testid="lead-appointments-empty"
      >
        No open appointments
      </div>
    );
  }

  const nowMs = Date.now();

  return (
    <ul className="divide-border divide-y" data-testid="lead-appointments-section">
      {appointments.map((appt) => {
        const isPastDue = new Date(appt.due_at).getTime() < nowMs;
        return (
          <li
            key={appt.id}
            className="flex items-center justify-between gap-3 px-3 py-2.5"
            data-testid={`lead-appointment-${appt.id}`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-foreground truncate text-sm font-bold">
                {appt.title}
              </div>
              <div className="text-muted-foreground truncate text-xs font-medium">
                {formatTimeRange(appt.due_at, appt.end_at, timezone)}
              </div>
            </div>
            {isPastDue ? (
              <AppointmentOutcomeRow
                taskId={appt.id}
                assigneeId={appt.assignee_id}
              />
            ) : (
              <AppointmentUpcomingActions
                taskId={appt.id}
                assigneeId={appt.assignee_id}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
