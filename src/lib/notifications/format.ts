import { formatRelativeDay, normalizeTimeZone } from "@/lib/time/zoned";

import type { EventType, FormatPayload } from "./types";

/** Fallback zone when a caller has no assignee timezone preference to pass. */
const DEFAULT_NOTIFICATION_TIME_ZONE = "America/Chicago";

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
 * the supplied `now` (default: real time), bucketed by calendar day in
 * `timeZone` (default: America/Chicago — callers with an assignee timezone
 * preference should pass it). Pure given fixed `now`/`timeZone`, so tests
 * can assert exact strings without mocking Date globally.
 *
 * Delegates to `formatRelativeDay` (src/lib/time/zoned.ts) — a zone-correct,
 * DST-safe day-boundary comparison. The old implementation bucketed by the
 * *server machine's* local calendar day (via `Date.getFullYear/Month/Date`),
 * which silently disagreed with the assignee's actual day whenever the
 * server's timezone differed from theirs; that was the naive bug this
 * replaces.
 *
 * Exported for direct testing — formatNotification calls it with the default
 * `now`/`timeZone`, so test the labels here rather than retrofitting those
 * args into formatNotification's call surface.
 */
export function humanDueDate(
  iso: string,
  now: Date = new Date(),
  timeZone: string = DEFAULT_NOTIFICATION_TIME_ZONE,
): string {
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return "soon";

  // Payload/stored zones are free text — normalize so one malformed value
  // degrades to the default instead of throwing out of a render path.
  const label = formatRelativeDay(due, normalizeTimeZone(timeZone), now);
  if (label === "Today") return "today";
  if (label === "Tomorrow") return "tomorrow";
  // "Yesterday" and the weekday/date fallback both read fine as-is; the old
  // code had no "yesterday" bucket and just fell through to the date format
  // for any past due date, so this is a (harmless) small improvement.
  return label;
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
      if (payload.needsPropertyTriage) {
        return {
          title: "New SMS reply needs property triage",
          body: preview
            ? `Reply from ${address}\n${preview}`
            : `Reply from ${address}`,
        };
      }
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
      const due = payload.dueAt
        ? humanDueDate(
            payload.dueAt,
            undefined,
            payload.timezone ?? undefined,
          )
        : "soon";
      const typeLabel = TASK_TYPE_LABELS[payload.taskType ?? ""] ?? "Task";
      return {
        title: `Task assigned: ${titleSuffix}`,
        body: `Due ${due} · ${typeLabel}`,
      };
    }
    case "ai_responder_provider_failure": {
      // NB: the dispatch throttle and the migration-076 dedupe index
      // both key on these exact titles ("credits exhausted" / "key
      // rejected") — keep those phrases stable if rewording.
      const kind = payload.providerFailure ?? "billing";
      return kind === "billing"
        ? {
            title: "AI responder is DOWN — Anthropic credits exhausted",
            body: "Every inbound reply is escalating unanswered. Add credits at console.anthropic.com → Plans & Billing; it recovers automatically.",
          }
        : {
            title: "AI responder is DOWN — Anthropic API key rejected",
            body: "Every inbound reply is escalating unanswered. Check the key at console.anthropic.com and update ANTHROPIC_API_KEY in Vercel.",
          };
    }
  }
}
