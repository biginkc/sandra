import type { EventType, FormatPayload } from "./types";

/**
 * Map raw `jobs.type` enum values to human-readable labels for
 * notification titles. Unknown types fall back to the raw value so a
 * new job type never silently produces a blank title.
 */
const JOB_LABELS: Record<string, string> = {
  cass_dsf2_ncoa: "Address verification",
  csv_import: "CSV import",
  skip_trace: "Skip trace",
};

/**
 * Map terminal job states to natural-language title fragments.
 *   completed → "complete"      ("Address verification complete")
 *   failed    → "failed"        ("Address verification failed")
 *   partial   → "completed with errors"
 *   canceled  → "canceled"
 */
const STATE_WORDS: Record<string, string> = {
  completed: "complete",
  failed: "failed",
  partial: "completed with errors",
  canceled: "canceled",
};

/** Human-readable labels for the task type values stored on `tasks.type`. */
const TASK_TYPE_LABELS: Record<string, string> = {
  follow_up: "Follow-up",
  callback: "Callback",
  custom: "Task",
};

/**
 * Render an ISO due_at as "today" / "tomorrow" / "Fri May 9" relative to
 * the supplied `now` (default: real time). Pure given a fixed `now`, so
 * tests can assert exact strings without mocking Date globally.
 *
 * Exported for direct testing — formatNotification calls it with the default
 * `now`, so test the labels here rather than retrofitting a `now` arg into
 * formatNotification's call surface.
 */
export function humanDueDate(iso: string, now: Date = new Date()): string {
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return "soon";

  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const todayStart = startOfDay(now);
  const dueStart = startOfDay(due);
  const diffDays = Math.round((dueStart - todayStart) / (24 * 60 * 60 * 1000));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  return due.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Build title + body for a notification given the event type and a
 * loose-typed payload. Pure — no DB, no fetch. Defensive about
 * missing fields so a dispatch hook that's missing one lookup still
 * produces a sensible notification instead of a thrown error (test #4).
 */
export function formatNotification(
  eventType: EventType,
  payload: FormatPayload,
): { title: string; body: string } {
  switch (eventType) {
    case "owner_message_added": {
      const address = payload.propertyAddress ?? "a property";
      const raw = payload.messageBody?.trim() ?? "";
      const isUrl = /^\s*https?:\/\/\S+\s*$/.test(raw);
      const preview = raw && !isUrl ? raw.slice(0, 80) : null;
      return {
        title: "New SMS reply",
        body: preview ? `Reply from ${address}\n${preview}` : `Reply from ${address}`,
      };
    }
    case "property_assigned": {
      const address = payload.propertyAddress ?? "A property";
      const assigner = payload.assignerName ?? "a teammate";
      return {
        title: "Lead assigned to you",
        body: `${address} — assigned by ${assigner}`,
      };
    }
    case "bulk_action_completed": {
      const label = payload.jobType
        ? (JOB_LABELS[payload.jobType] ?? payload.jobType)
        : "Job";
      const state = payload.state
        ? (STATE_WORDS[payload.state] ?? payload.state)
        : "finished";
      const succeeded = payload.succeeded ?? 0;
      const failed = payload.failed ?? 0;
      return {
        title: `${label} ${state}`,
        body: `${succeeded} succeeded, ${failed} failed`,
      };
    }
    case "skip_trace_requested": {
      const who = payload.requesterEmail ?? "A teammate";
      const count = payload.propertyCount ?? 0;
      return {
        title: "Skip-trace approval needed",
        body: `${who} requested skip-trace for ${count} propert${count === 1 ? "y" : "ies"}`,
      };
    }
    case "task_assigned": {
      const rawTitle = payload.taskTitle?.trim() ?? "";
      const truncated =
        rawTitle.length > 60 ? `${rawTitle.slice(0, 57)}...` : rawTitle;
      const titleSuffix = truncated || "new task";
      const due = payload.dueAt ? humanDueDate(payload.dueAt) : "soon";
      const typeLabel = TASK_TYPE_LABELS[payload.taskType ?? ""] ?? "Task";
      return {
        title: `Task assigned: ${titleSuffix}`,
        body: `Due ${due} · ${typeLabel}`,
      };
    }
  }
}
