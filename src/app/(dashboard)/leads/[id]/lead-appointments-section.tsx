"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  AppointmentOutcomeRow,
  AppointmentUpcomingActions,
} from "@/components/appointments/appointment-outcome-row";
import { TaskActionsRow } from "@/app/(dashboard)/dashboard/_components/task-actions-row";
import { Button } from "@/components/ui/button";
import {
  canActOnLeadAppointment,
  groupLeadAppointments,
  type LeadAppointmentCursor,
  type LeadAppointmentRow,
} from "@/lib/leads/lead-appointments";
import { formatTimeRange } from "@/lib/time/format-time-range";

import {
  loadLeadAppointmentHistory,
  type LeadAppointmentHistoryResult,
} from "./lead-appointments-actions";

export type { LeadAppointmentRow };

export type LeadAppointmentHistoryPage = {
  rows: LeadAppointmentRow[];
  hasMore: boolean;
  cursor: LeadAppointmentCursor | null;
};

type Props = {
  propertyId: string;
  /** Every open or snoozed appointment/callback for the lead. */
  appointments: LeadAppointmentRow[];
  /** First page of completed / cancelled appointments and callbacks. */
  history: LeadAppointmentHistoryPage;
  viewerId: string | null;
  viewerIsOwner: boolean;
  /** Request-captured instant from the lead page; stable across hydration. */
  nowMs: number;
  /** The viewer's saved timezone (user_integration_prefs.timezone). */
  timezone: string;
};

function formatDatedTimeRange(
  dueAt: string,
  endAt: string | null,
  timeZone: string,
): string {
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  });
  return `${dateFmt.format(new Date(dueAt))}, ${formatTimeRange(dueAt, endAt, timeZone)}`;
}

function statusLabel(row: LeadAppointmentRow) {
  if (row.status === "snoozed") return "Snoozed";
  if (row.status === "cancelled") return "Cancelled";
  if (row.status === "completed") {
    if (row.outcome === "held") return "Held";
    if (row.outcome === "no_show") return "No-show";
    return "Completed";
  }
  return null;
}

/**
 * Lead-detail "Appointments" section: every appointment and callback task
 * for the lead, grouped Upcoming / Past due / History, with the same
 * lifecycle controls and assignee-or-owner rule as the My Leads detail panel.
 * Appointments get Held / No-show / Reschedule / Cancel; callbacks get
 * Done / Snooze. Each task keeps its own assignee, so the assignee comes
 * from the row, not the session user.
 */
export function LeadAppointmentsSection({
  propertyId,
  appointments,
  history,
  viewerId,
  viewerIsOwner,
  timezone,
  nowMs,
}: Props) {
  const router = useRouter();
  const { upcoming, pastDue } = groupLeadAppointments(appointments, nowMs);
  const [extra, setExtra] = useState<LeadAppointmentHistoryPage>({
    rows: [],
    hasMore: history.hasMore,
    cursor: history.cursor,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const seen = new Set<string>();
  const historyRows = [...history.rows, ...extra.rows].filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });

  function loadMore() {
    if (!extra.cursor) return;
    const cursor = extra.cursor;
    startTransition(async () => {
      let result: LeadAppointmentHistoryResult;
      try {
        result = await loadLeadAppointmentHistory(propertyId, cursor);
      } catch {
        result = { ok: false, message: "Appointment history could not be loaded. Retry." };
      }
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError(null);
      setExtra((previous) => ({
        rows: [...previous.rows, ...result.rows],
        hasMore: result.hasMore,
        cursor: result.cursor,
      }));
    });
  }

  if (appointments.length === 0 && historyRows.length === 0) {
    return (
      <div
        className="text-muted-foreground px-3 py-2 text-sm"
        data-testid="lead-appointments-empty"
      >
        No appointments or callbacks
      </div>
    );
  }

  const renderRow = (row: LeadAppointmentRow, past: boolean) => {
    const label = statusLabel(row);
    const canAct = canActOnLeadAppointment(row, viewerId, viewerIsOwner);
    return (
      <li
        key={row.id}
        className="flex flex-col items-stretch gap-3 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
        data-testid={`lead-appointment-${row.id}`}
        data-task-type={row.type}
        data-task-status={row.status}
      >
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-bold">
            {row.title}
            {row.type !== "appointment" && (
              <span className="text-muted-foreground ml-2 text-xs font-medium">
                {row.type === "callback" ? "Callback" : "Follow-up"}
              </span>
            )}
          </div>
          <div className="text-muted-foreground truncate text-xs font-medium">
            {formatDatedTimeRange(row.due_at, row.end_at, timezone)}
            {label && <> · {label}</>}
          </div>
        </div>
        {canAct &&
          row.type !== "follow_up" &&
          (row.type === "callback" ? (
            <TaskActionsRow taskId={row.id} onChanged={() => router.refresh()} />
          ) : past ? (
            <AppointmentOutcomeRow
              taskId={row.id}
              assigneeId={row.assignee_id}
              onChanged={() => router.refresh()}
            />
          ) : (
            <AppointmentUpcomingActions
              taskId={row.id}
              assigneeId={row.assignee_id}
              onChanged={() => router.refresh()}
            />
          ))}
      </li>
    );
  };

  const groups: Array<{
    key: string;
    title: string;
    rows: LeadAppointmentRow[];
    past: boolean;
  }> = [
    { key: "upcoming", title: "Upcoming", rows: upcoming, past: false },
    { key: "past-due", title: "Past due", rows: pastDue, past: true },
    { key: "history", title: "History", rows: historyRows, past: true },
  ];

  return (
    <div data-testid="lead-appointments-section">
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <section
            key={group.key}
            data-testid={`lead-appointments-${group.key}`}
            aria-label={group.title}
          >
            <h3 className="text-muted-foreground px-3 pt-2.5 text-[10px] font-extrabold tracking-[0.08em] uppercase">
              {group.title} · {group.rows.length}
            </h3>
            <ul className="divide-border divide-y">
              {group.rows.map((row) =>
                renderRow(row, group.key === "past-due"),
              )}
            </ul>
            {group.key === "history" && (extra.hasMore || error) && (
              <div className="space-y-1.5 px-3 py-2">
                {extra.hasMore && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={pending}
                    onClick={loadMore}
                  >
                    {pending ? "Loading…" : "Load more history"}
                  </Button>
                )}
                {error && (
                  <p className="text-destructive text-xs" role="alert">
                    {error}
                  </p>
                )}
              </div>
            )}
          </section>
        ))}
    </div>
  );
}
