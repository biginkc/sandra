import Link from "next/link";

import { humanDueDate } from "@/lib/notifications/format";

import type { TaskRow } from "../queries";

import { TaskActionsRow } from "./task-actions-row";

type Props = {
  today: TaskRow[];
  upcoming: TaskRow[];
};

const TYPE_LABELS: Record<string, string> = {
  follow_up: "Follow-up",
  callback: "Callback",
  custom: "Task",
};

/**
 * Right-rail dashboard panel surfacing the current viewer's open tasks
 * split into Today (due_at <= end of today) and Upcoming (due_at later).
 * Empty-state collapses to a single "all caught up" line, matching the
 * NeedsAttentionStrip "all clear" visual rest state.
 *
 * Each row links to /messages?property_id=… so the user lands on the
 * conversation thread, not the lead detail page — most follow-ups
 * involve replying to a thread.
 */
export function TasksPanel({ today, upcoming }: Props) {
  const total = today.length + upcoming.length;

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

      {today.length > 0 ? (
        <Section label="Today" tasks={today} variant="today" />
      ) : null}
      {upcoming.length > 0 ? (
        <Section label="Upcoming" tasks={upcoming} variant="upcoming" />
      ) : null}
    </div>
  );
}

function Section({
  label,
  tasks,
  variant,
}: {
  label: string;
  tasks: TaskRow[];
  variant: "today" | "upcoming";
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="text-muted-foreground mb-2 text-[10px] font-bold tracking-widest uppercase">
        {label}
      </div>
      <ul className="divide-border divide-y">
        {tasks.map((t) => (
          <li
            key={t.id}
            className="py-2.5 first:pt-0 last:pb-0"
            data-testid={`task-row-${t.id}`}
          >
            <div className="flex items-center justify-between gap-3">
              <Link
                href={`/messages?property_id=${t.property_id}`}
                className="min-w-0 flex-1 hover:underline"
              >
                <div className="text-foreground truncate text-sm font-bold">
                  {t.address}
                </div>
                <div className="text-muted-foreground truncate text-xs font-medium">
                  {(TYPE_LABELS[t.type] ?? "Task")} ·{" "}
                  {variant === "today"
                    ? "today"
                    : humanDueDate(t.due_at)}
                </div>
              </Link>
              <TaskActionsRow taskId={t.id} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
