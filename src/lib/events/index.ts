import "server-only";

import type { Json, TablesInsert } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const LEAD_EVENT_TYPES = {
  LEAD_CREATED: "lead_created",
  QUALIFIED: "qualified",
  REVERTED_TO_PROSPECT: "reverted_to_prospect",
  STATUS_CHANGED: "status_changed",
  MOTIVATION_CHANGED: "motivation_changed",
  ASSIGNED: "assigned",
  TASK_CREATED: "task_created",
  TASK_COMPLETED: "task_completed",
  TASK_SNOOZED: "task_snoozed",
  TASK_REASSIGNED: "task_reassigned",
  APPOINTMENT_BOOKED: "appointment_booked",
  APPOINTMENT_HELD: "appointment_held",
  APPOINTMENT_NO_SHOW: "appointment_no_show",
  APPOINTMENT_CANCELED: "appointment_canceled",
  APPOINTMENT_RESCHEDULED: "appointment_rescheduled",
  APPOINTMENT_REASSIGNED: "appointment_reassigned",
  TAG_APPLIED: "tag_applied",
  TAG_REMOVED: "tag_removed",
  LIST_ADDED: "list_added",
  LIST_REMOVED: "list_removed",
  SEQUENCE_ENROLLED: "sequence_enrolled",
  SEQUENCE_PAUSED: "sequence_paused",
  SEQUENCE_RESUMED: "sequence_resumed",
  SEQUENCE_CANCELED: "sequence_canceled",
  DISPO_SET: "dispo_set",
  AI_ESCALATED: "ai_escalated",
  AI_ESCALATION_CLEARED: "ai_escalation_cleared",
  AI_RESPONDER_TOGGLED: "ai_responder_toggled",
  SKIP_TRACE_TOGGLED: "skip_trace_toggled",
  SKIP_TRACE_REQUESTED: "skip_trace_requested",
  SKIP_TRACE_COMPLETED: "skip_trace_completed",
  ADDRESS_VERIFIED: "address_verified",
  CONSENT_CAPTURED: "consent_captured",
  OPTED_OUT: "opted_out",
  QUEUED_MESSAGE_DELETED: "queued_message_deleted",
} as const;

export type LeadEventType =
  (typeof LEAD_EVENT_TYPES)[keyof typeof LEAD_EVENT_TYPES];

type LeadEventActor =
  | { actorType: "user"; actorId: string }
  | { actorType: "ai" | "system"; actorId?: never };

type LeadEventSource =
  | { sourceType: string; sourceId: string }
  | { sourceType?: never; sourceId?: never };

export type RecordLeadEventInput = {
  propertyId: string;
  eventType: LeadEventType;
  payload?: Json;
} &
  LeadEventActor &
  LeadEventSource;

type PropertyOrgRow = { id: string; org_id: string };
const PROPERTY_LOOKUP_CHUNK_SIZE = 250;

function reportLedgerFailure(
  stage: "client" | "property_lookup" | "insert",
  detail: unknown,
  requestedCount: number,
): void {
  console.error("[lead-events] append failed", {
    stage,
    requestedCount,
    message:
      detail instanceof Error
        ? detail.message
        : typeof detail === "object" && detail && "message" in detail
          ? String(detail.message)
          : "Unknown lead event error",
  });
}

/**
 * Append confirmed property activity without ever failing the parent action.
 *
 * Organization ownership is deliberately resolved from `properties` using the
 * trusted server client. Callers cannot supply an org id to a client that
 * bypasses RLS. Missing/ambiguous properties are skipped, and payloads are
 * never copied into failure logs.
 */
export async function recordLeadEvents(
  inputs: readonly RecordLeadEventInput[],
): Promise<void> {
  if (inputs.length === 0) return;

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    reportLedgerFailure("client", error, inputs.length);
    return;
  }

  const propertyIds = [...new Set(inputs.map((input) => input.propertyId))];
  const propertyRows: PropertyOrgRow[] = [];
  try {
    for (
      let offset = 0;
      offset < propertyIds.length;
      offset += PROPERTY_LOOKUP_CHUNK_SIZE
    ) {
      const chunk = propertyIds.slice(
        offset,
        offset + PROPERTY_LOOKUP_CHUNK_SIZE,
      );
      const { data, error } = await admin
        .from("properties")
        .select("id, org_id")
        .in("id", chunk);
      if (error) {
        reportLedgerFailure("property_lookup", error, inputs.length);
        return;
      }
      propertyRows.push(...((data ?? []) as PropertyOrgRow[]));
    }
  } catch (error) {
    reportLedgerFailure("property_lookup", error, inputs.length);
    return;
  }

  const orgByProperty = new Map(
    propertyRows.map((property) => [property.id, property.org_id]),
  );
  const rows: TablesInsert<"lead_events">[] = [];
  for (const input of inputs) {
    const orgId = orgByProperty.get(input.propertyId);
    if (!orgId) continue;
    rows.push({
      org_id: orgId,
      property_id: input.propertyId,
      actor_type: input.actorType,
      actor_id: input.actorType === "user" ? input.actorId : null,
      event_type: input.eventType,
      payload: input.payload ?? {},
      source_type: input.sourceType ?? null,
      source_id: input.sourceId ?? null,
    });
  }

  if (rows.length < inputs.length) {
    console.warn("[lead-events] skipped unresolved properties", {
      requestedCount: inputs.length,
      skippedCount: inputs.length - rows.length,
    });
  }
  if (rows.length === 0) return;

  try {
    const { error } = await admin.from("lead_events").insert(rows);
    if (error) reportLedgerFailure("insert", error, rows.length);
  } catch (error) {
    reportLedgerFailure("insert", error, rows.length);
  }
}

export async function recordLeadEvent(
  input: RecordLeadEventInput,
): Promise<void> {
  await recordLeadEvents([input]);
}
