import Link from "next/link";

import { humanDueDate } from "@/lib/notifications/format";
import {
  AppointmentOutcomeRow,
  AppointmentUpcomingActions,
} from "@/components/appointments/appointment-outcome-row";

import type { TaskRow } from "../queries";

import { TaskActionsRow } from "./task-actions-row";

type Props = {
  overdue: TaskRow[];
  today: TaskRow[];
  upcoming: TaskRow[];
  /** Zone the buckets were computed in (fetchMyTasks.timezone) — due
   *  labels must be formatted in the same zone or a row can sit under
   *  Upcoming while its label reads "today". */
  timezone: string;
  /** The viewer these tasks belong to (fetchMyTasks always scopes to
   *  `assignee_id = viewer`) — appointment rows need this to drive the
   *  reschedule popover's timezone lookup. */
  currentUserId: string;
};

const TYPE_LABELS: Record<string, string> = {
  follow_up: "Follow-up",
  callback: "Callback",
  custom: "Task",
  appointment: "Appointment",
};

/**
 * Right-rail dashboard panel surfacing the current viewer's open tasks
 * split into Overdue / Today / Upcoming. Empty-state collapses to a
 * single "all caught up" line, matching the NeedsAttentionStrip "all
 * clear" visual rest state.
 *
 * Row linking depends on what the task is attached to (property is now
 * optional — appointment-type tasks may have neither):
 *   - property-linked → /messages?property_id=<id> (unchanged)
 *   - contact-only (no property) → /messages?thread=<contactId>, same
 *     canonical thread param the cockpit itself reads/writes
 *     (canonicalizeThreadId resolves a raw contact id to its conversation)
 *   - fully unlinked (personal block) → "Personal block", no link
 *
 * Appointment rows get their own action area instead of the generic
 * Done/Snooze row: once `due_at` has passed, the "How'd it go?" outcome
 * row (held / no-show / reschedule / cancel); before that, a compact
 * "..." overflow with just Reschedule/Cancel.
 */
export function TasksPanel({
  overdue,
  today,
  upcoming,
  timezone,
  currentUserId,
}: Props) {
  const total = overdue.length + today.length + upcoming.length;

  if (total === 0) {
    return (
      <div className="border-border bg-card rounded-2xl border px-5 py-5">
        <div className="text-foreground text-base font-bold">My Tasks</div>
        <p className="text-muted-foreground mt-3 text-sm">
          No follow-ups scheduled — all caught up ✓
        </p>
      </div>
    );
  }

  // Server components render once per request; capturing request time
  // here is intentional and stable for the duration of the response —
  // same convention as dashboard/page.tsx's own `nowMs`.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  return (
    <div
      className="border-border bg-card rounded-2xl border px-5 py-5"
      data-testid="tasks-panel"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-foreground text-base font-bold">My Tasks</h2>
        <span className="text-muted-foreground rounded-full bg-stone-100 px-2.5 py-1 text-xs font-bold tabular-nums">
          {total}
        </span>
      </div>

      {overdue.length > 0 ? (
        <Section
          label="Overdue"
          tasks={overdue}
          variant="overdue"
          timezone={timezone}
          nowMs={nowMs}
          currentUserId={currentUserId}
        />
      ) : null}
      {today.length > 0 ? (
        <Section
          label="Today"
          tasks={today}
          variant="today"
          timezone={timezone}
          nowMs={nowMs}
          currentUserId={currentUserId}
        />
      ) : null}
      {upcoming.length > 0 ? (
        <Section
          label="Upcoming"
          tasks={upcoming}
          variant="upcoming"
          timezone={timezone}
          nowMs={nowMs}
          currentUserId={currentUserId}
        />
      ) : null}
    </div>
  );
}

/** href for a task row, or null when there's nothing to link to (a fully
 *  unlinked personal block). */
function taskHref(t: TaskRow): string | null {
  if (t.property_id) return `/messages?property_id=${t.property_id}`;
  if (t.contact_id) return `/messages?thread=${t.contact_id}`;
  return null;
}

/** Primary row label — property address when linked; "Personal block" only
 *  for a fully-unlinked appointment; otherwise the task title (covers
 *  contact-only rows and non-appointment tasks whose property was
 *  soft-deleted, which must not read as personal blocks). */
function taskPrimaryLabel(t: TaskRow): string {
  if (t.address) return t.address;
  if (t.type === "appointment" && !t.contact_id) return "Personal block";
  return t.title;
}

/** "2:00–2:30 PM" in the panel's timezone; just the start time when
 *  `end_at` is missing (shouldn't happen for a real appointment, but a
 *  malformed row degrades gracefully rather than throwing). */
function formatTimeRange(
  dueAt: string,
  endAt: string | null,
  timeZone: string,
): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  const start = fmt.format(new Date(dueAt));
  if (!endAt) return start;
  return `${start}–${fmt.format(new Date(endAt))}`;
}

/** Subtitle for an appointment row: the usual day label (today / overdue
 *  / relative date) plus the appointment's own time range, so a row in
 *  the (possibly multi-day) Upcoming bucket still reads as a specific
 *  time, not just "in 3 days". */
function appointmentSubtitle(
  t: TaskRow,
  variant: "overdue" | "today" | "upcoming",
  timezone: string,
): string {
  const dayLabel =
    variant === "today"
      ? "today"
      : variant === "overdue"
        ? "overdue"
        : humanDueDate(t.due_at, undefined, timezone);
  return `${dayLabel}, ${formatTimeRange(t.due_at, t.end_at, timezone)}`;
}

function Section({
  label,
  tasks,
  variant,
  timezone,
  nowMs,
  currentUserId,
}: {
  label: string;
  tasks: TaskRow[];
  variant: "overdue" | "today" | "upcoming";
  timezone: string;
  nowMs: number;
  currentUserId: string;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div
        className={`mb-2 text-[10px] font-bold tracking-widest uppercase ${
          variant === "overdue" ? "text-alert-critical" : "text-muted-foreground"
        }`}
      >
        {label}
      </div>
      <ul className="divide-border divide-y">
        {tasks.map((t) => {
          const href = taskHref(t);
          const primary = taskPrimaryLabel(t);
          const isAppointment = t.type === "appointment";
          const rowContent = (
            <>
              <div className="text-foreground truncate text-sm font-bold">
                {primary}
              </div>
              <div className="text-muted-foreground truncate text-xs font-medium">
                {(TYPE_LABELS[t.type] ?? "Task")} ·{" "}
                {isAppointment
                  ? appointmentSubtitle(t, variant, timezone)
                  : variant === "today"
                    ? "today"
                    : variant === "overdue"
                      ? "overdue"
                      : humanDueDate(t.due_at, undefined, timezone)}
              </div>
            </>
          );

          let actions: React.ReactNode;
          if (!isAppointment) {
            actions = <TaskActionsRow taskId={t.id} />;
          } else if (new Date(t.due_at).getTime() < nowMs) {
            actions = (
              <AppointmentOutcomeRow taskId={t.id} assigneeId={currentUserId} />
            );
          } else {
            actions = (
              <AppointmentUpcomingActions
                taskId={t.id}
                assigneeId={currentUserId}
              />
            );
          }

          return (
            <li
              key={t.id}
              className="py-2.5 first:pt-0 last:pb-0"
              data-testid={`task-row-${t.id}`}
            >
              <div className="flex items-center justify-between gap-3">
                {href ? (
                  <Link
                    href={href}
                    className="min-w-0 flex-1 hover:underline"
                  >
                    {rowContent}
                  </Link>
                ) : (
                  <div
                    className="min-w-0 flex-1"
                    data-testid={`task-row-${t.id}-unlinked`}
                  >
                    {rowContent}
                  </div>
                )}
                {actions}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
