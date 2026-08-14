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
};

function formatTimeRange(dueAt: string, endAt: string | null): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const dateFmt = new Intl.DateTimeFormat("en-US", {
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
export function LeadAppointmentsSection({ appointments }: Props) {
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
                {formatTimeRange(appt.due_at, appt.end_at)}
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
