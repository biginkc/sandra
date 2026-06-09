import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { formatNotification } from "./format";
import {
  resolveAssignmentRecipients,
  resolveJobRecipients,
  resolveOwnerMessageRecipients,
} from "./recipients";
import type { EntityType, EventType, FormatPayload } from "./types";

/**
 * Low-level helper: format a title/body once and insert one notification
 * row per recipient. Never throws across the boundary — notifications
 * are best-effort and must not block the underlying action (a webhook
 * reply, an assignment, a job termination). Any insert error is reported
 * and the dispatch returns `{ inserted: 0 }` instead of bubbling.
 *
 * Returns the number of rows inserted so callers can log / assert.
 */
export async function createNotification(
  supabase: SupabaseClient<Database>,
  params: {
    orgId: string;
    eventType: EventType;
    entityType: EntityType;
    entityId: string;
    payload: FormatPayload;
    recipients: readonly string[];
  },
): Promise<{ inserted: number }> {
  if (params.recipients.length === 0) {
    return { inserted: 0 };
  }
  const { title, body } = formatNotification(params.eventType, params.payload);
  const rows = params.recipients.map((userId) => ({
    org_id: params.orgId,
    user_id: userId,
    event_type: params.eventType,
    entity_type: params.entityType,
    entity_id: params.entityId,
    title,
    body,
  }));
  const { error } = await supabase.from("notifications").insert(rows);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "notifications_insert" },
      extra: {
        eventType: params.eventType,
        entityId: params.entityId,
        recipients: params.recipients.length,
      },
    });
    return { inserted: 0 };
  }
  return { inserted: rows.length };
}

/**
 * Fired from the Dialpad inbound-SMS webhook after a regular (non-STOP,
 * non-HELP) reply is threaded to a property. Caller provides
 * `adminUserIds` (the webhook calls `listAdminUserIds()` on the
 * service-role client before dispatch) — decoupling the admin lookup
 * here keeps this function trivially testable.
 *
 * Assignee wins over admin fallback (decision #6); unassigned property
 * with zero admins is a clean no-op.
 */
export async function dispatchOwnerMessageAdded(
  supabase: SupabaseClient<Database>,
  params: {
    messageId: string;
    propertyId: string;
    adminUserIds: readonly string[];
    messageBody?: string | null;
  },
): Promise<{ inserted: number }> {
  const { data: property, error } = await supabase
    .from("properties")
    .select("id, org_id, address, assigned_user_id")
    .eq("id", params.propertyId)
    .maybeSingle();
  if (error || !property) return { inserted: 0 };

  const recipients = resolveOwnerMessageRecipients({
    assignedUserId: property.assigned_user_id,
    adminUserIds: params.adminUserIds,
  });

  return createNotification(supabase, {
    orgId: property.org_id,
    eventType: "owner_message_added",
    entityType: "message",
    entityId: params.messageId,
    payload: { propertyAddress: property.address, messageBody: params.messageBody },
    recipients,
  });
}

/**
 * Fired from `assignLeadsBulk` after the update succeeds. Suppresses
 * self-assign at the batch level (saves N property lookups on a pure
 * self-assign) and emits one notification per property to the new
 * assignee. Unassign (newAssigneeId = null) is a no-op.
 *
 * Caller passes `assignerName` (derived from the current session
 * user's email) so this function doesn't need service-role access to
 * auth metadata.
 */
export async function dispatchPropertyAssigned(
  supabase: SupabaseClient<Database>,
  params: {
    propertyIds: readonly string[];
    newAssigneeId: string | null;
    actorId: string | null;
    assignerName: string | null;
  },
): Promise<{ inserted: number }> {
  const recipients = resolveAssignmentRecipients({
    newAssigneeId: params.newAssigneeId,
    actorId: params.actorId,
  });
  if (recipients.length === 0) return { inserted: 0 };
  if (params.propertyIds.length === 0) return { inserted: 0 };

  const { data: properties, error } = await supabase
    .from("properties")
    .select("id, org_id, address")
    .in("id", params.propertyIds);
  if (error || !properties) return { inserted: 0 };

  let inserted = 0;
  for (const prop of properties) {
    const r = await createNotification(supabase, {
      orgId: prop.org_id,
      eventType: "property_assigned",
      entityType: "property",
      entityId: prop.id,
      payload: {
        propertyAddress: prop.address,
        assignerName: params.assignerName,
      },
      recipients,
    });
    inserted += r.inserted;
  }
  return { inserted };
}

/**
 * Fired from `runCassEnrichment` after the terminal-state job update.
 * Notifies the user who kicked the job off. System-created jobs
 * (created_by null) notify nobody.
 *
 * Reads the job row directly rather than taking payload args so the
 * dispatch sees exactly what persisted — no drift risk.
 */
export async function dispatchSkipTraceRequested(
  supabase: SupabaseClient<Database>,
  params: {
    jobId: string;
    requesterEmail: string | null;
    propertyCount: number;
    /** Pre-resolved admin user ids; pass [] to no-op cleanly. */
    adminUserIds: readonly string[];
  },
): Promise<{ inserted: number }> {
  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, org_id, created_by")
    .eq("id", params.jobId)
    .maybeSingle();
  if (error || !job) return { inserted: 0 };

  // Don't notify the requester themselves.
  const recipients = params.adminUserIds.filter((id) => id !== job.created_by);

  return createNotification(supabase, {
    orgId: job.org_id,
    eventType: "skip_trace_requested",
    entityType: "job",
    entityId: job.id,
    payload: {
      requesterEmail: params.requesterEmail,
      propertyCount: params.propertyCount,
    },
    recipients,
  });
}

/**
 * Fired from `setOutreachDispo` when a follow-up dispo (nurture or
 * callback_requested) creates a task assigned to someone other than the
 * acting user. Self-assignment is suppressed at the caller (cheaper than
 * resolving here) so this dispatcher always emits the row.
 *
 * Best-effort like every other dispatcher — never throws across the boundary.
 */
export async function dispatchTaskAssigned(
  supabase: SupabaseClient<Database>,
  params: {
    taskId: string;
    orgId: string;
    assigneeId: string;
    taskTitle: string;
    taskType: string;
    /** ISO timestamptz */
    dueAt: string;
    propertyAddress?: string | null;
  },
): Promise<{ inserted: number }> {
  return createNotification(supabase, {
    orgId: params.orgId,
    eventType: "task_assigned",
    entityType: "task",
    entityId: params.taskId,
    payload: {
      taskTitle: params.taskTitle,
      taskType: params.taskType,
      dueAt: params.dueAt,
      propertyAddress: params.propertyAddress,
    },
    recipients: [params.assigneeId],
  });
}

export async function dispatchJobCompleted(
  supabase: SupabaseClient<Database>,
  params: { jobId: string },
): Promise<{ inserted: number }> {
  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, org_id, created_by, type, status, succeeded_items, failed_items")
    .eq("id", params.jobId)
    .maybeSingle();
  if (error || !job) return { inserted: 0 };

  const recipients = resolveJobRecipients({ createdBy: job.created_by });

  return createNotification(supabase, {
    orgId: job.org_id,
    eventType: "bulk_action_completed",
    entityType: "job",
    entityId: job.id,
    payload: {
      jobType: job.type,
      state: job.status,
      succeeded: job.succeeded_items ?? 0,
      failed: job.failed_items ?? 0,
    },
    recipients,
  });
}
