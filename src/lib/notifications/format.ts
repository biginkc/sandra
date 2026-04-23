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
      return {
        title: "New SMS reply",
        body: `Reply from ${address}`,
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
  }
}
