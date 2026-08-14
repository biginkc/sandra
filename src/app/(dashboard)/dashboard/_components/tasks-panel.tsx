import Link from "next/link";

import { humanDueDate } from "@/lib/notifications/format";

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
 */
export function TasksPanel({ overdue, today, upcoming, timezone }: Props) {
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
        <Section label="Overdue" tasks={overdue} variant="overdue" timezone={timezone} />
      ) : null}
      {today.length > 0 ? (
        <Section label="Today" tasks={today} variant="today" timezone={timezone} />
      ) : null}
      {upcoming.length > 0 ? (
        <Section label="Upcoming" tasks={upcoming} variant="upcoming" timezone={timezone} />
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

function Section({
  label,
  tasks,
  variant,
  timezone,
}: {
  label: string;
  tasks: TaskRow[];
  variant: "overdue" | "today" | "upcoming";
  timezone: string;
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
          const rowContent = (
            <>
              <div className="text-foreground truncate text-sm font-bold">
                {primary}
              </div>
              <div className="text-muted-foreground truncate text-xs font-medium">
                {(TYPE_LABELS[t.type] ?? "Task")} ·{" "}
                {variant === "today"
                  ? "today"
                  : variant === "overdue"
                    ? "overdue"
                    : humanDueDate(t.due_at, undefined, timezone)}
              </div>
            </>
          );

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
                <TaskActionsRow taskId={t.id} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
