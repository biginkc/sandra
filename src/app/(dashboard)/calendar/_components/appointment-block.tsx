import Link from "next/link";

import { AppointmentOutcomeRow } from "@/components/appointments/appointment-outcome-row";
import { StatusChip } from "@/components/ui/status-chip";
import { cn } from "@/lib/utils";

import type { CalendarAppointmentRow, CalendarViewerRole } from "../types";

import {
  appointmentHref,
  appointmentLabel,
  appointmentToneClass,
  appointmentVisualTone,
  formatTimeRange,
  isPastDueOpen,
  outcomeChip,
} from "./calendar-shared";

type Props = {
  appt: CalendarAppointmentRow;
  timezone: string;
  viewerRole: CalendarViewerRole;
  /** user_id -> email, for the whose-appointment line (any non-self row). */
  assignees: Record<string, string>;
  currentUserId: string;
  nowMs: number;
};

/**
 * One appointment's block/row content — shared by WeekGrid (stacked in a
 * day column) and AgendaList (a flat chronological row) so both surfaces
 * render identical content per the plan ("same row content as grid
 * blocks"). This component owns only the inner content; callers own the
 * `<li>`/grid-cell wrapper and spacing.
 *
 * Click-through mirrors TasksPanel's linkage rules but with a Calendar-
 * specific destination for the property-linked case (straight to the lead
 * detail page, not the Messages thread) — see `appointmentHref`.
 */
export function AppointmentBlock({
  appt,
  timezone,
  viewerRole,
  assignees,
  currentUserId,
  nowMs,
}: Props) {
  const href = appointmentHref(appt);
  const label = appointmentLabel(appt);
  // Label whose appointment this is whenever it isn't the viewer's own —
  // members can view teammates (scoping.ts honors ?assignee=), so the
  // label follows the row's owner, not the viewer's role.
  const assigneeEmail =
    appt.assignee_id !== currentUserId
      ? assignees[appt.assignee_id]
      : undefined;
  const chip =
    appt.status === "completed" && appt.outcome
      ? outcomeChip(appt.outcome)
      : null;
  const tone = appointmentVisualTone(appt, nowMs);

  const body = (
    <>
      <div className="text-foreground truncate text-xs font-bold tabular-nums">
        {formatTimeRange(appt.due_at, appt.end_at, timezone)}
      </div>
      <div className="text-foreground truncate text-sm font-bold">{label}</div>
      {assigneeEmail ? (
        <div className="text-muted-foreground truncate text-xs font-medium">
          {assigneeEmail}
        </div>
      ) : null}
      {chip ? (
        <StatusChip
          status={chip.variant}
          label={chip.label}
          className="mt-1"
          data-testid={`calendar-outcome-chip-${appt.id}`}
        />
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "rounded-lg border px-2 py-1.5",
        appointmentToneClass(tone),
      )}
      data-testid={`calendar-appointment-${appt.id}`}
      data-appointment-tone={tone}
    >
      {href ? (
        <Link
          href={href}
          className="block hover:underline"
          data-testid={`calendar-appointment-link-${appt.id}`}
        >
          {body}
        </Link>
      ) : (
        <div data-testid={`calendar-appointment-unlinked-${appt.id}`}>
          {body}
        </div>
      )}
      {isPastDueOpen(appt, nowMs) ? (
        <div className="mt-1.5">
          <div className="mb-1 text-[10px] font-bold tracking-wide text-amber-800 uppercase">
            Needs outcome
          </div>
          <AppointmentOutcomeRow
            taskId={appt.id}
            assigneeId={appt.assignee_id}
          />
        </div>
      ) : null}
    </div>
  );
}
