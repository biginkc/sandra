import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

import type { Result } from "@/lib/errors/result";
import { err, ok } from "@/lib/errors/result";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { dispatchTaskCalendarEventUpdate } from "@/lib/integrations/google/dispatch";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import type { Database, Tables } from "@/lib/supabase/types";

export type Task = Tables<"tasks">;
export type TaskType = "follow_up" | "callback" | "custom" | "appointment";
export type TaskStatus = "open" | "snoozed" | "completed" | "cancelled";

/**
 * Maps the two follow-up dispos to their canonical task type. Kept in lock-step
 * with REQUIRES_FOLLOW_UP in src/app/(dashboard)/messages/dispo-actions.ts —
 * if a third "needs follow-up" dispo lands, both sets must update.
 */
export function dispoToTaskType(
  dispo: "nurture" | "callback_requested",
): TaskType {
  return dispo === "callback_requested" ? "callback" : "follow_up";
}

export type CreateTaskInput = {
  orgId: string;
  assigneeId: string;
  /** Optional as of the appointments migration — appointment-type tasks
   *  may be personal blocks or contact-only, with no property attached. */
  relatedPropertyId?: string;
  contactId?: string;
  type: TaskType;
  title: string;
  description?: string;
  /** ISO timestamptz */
  dueAt: string;
  /** ISO timestamptz — appointment-only; end of the booked window. */
  endAt?: string;
  createdBy: string;
};

const APPOINTMENT_REQUIRES_END = {
  code: "TASK_CREATE_INVALID",
  message: "Appointments require an end time after their start time.",
} as const;

export async function createTask(
  supabase: SupabaseClient<Database>,
  input: CreateTaskInput,
): Promise<Result<Task>> {
  // Mirrors the DB's bidirectional end_at CHECK so callers get a typed
  // error instead of a constraint violation. endAt stays optional on the
  // shared input type; the requirement is appointment-only.
  if (input.type === "appointment") {
    if (
      !input.endAt ||
      new Date(input.endAt).getTime() <= new Date(input.dueAt).getTime()
    ) {
      return err(APPOINTMENT_REQUIRES_END);
    }
  } else if (input.endAt !== undefined) {
    return err(APPOINTMENT_REQUIRES_END);
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      org_id: input.orgId,
      assignee_id: input.assigneeId,
      related_property_id: input.relatedPropertyId ?? null,
      type: input.type,
      title: input.title,
      due_at: input.dueAt,
      created_by: input.createdBy,
      // Migration-added columns ride along only when the call actually
      // uses them. During the brief new-code/old-schema window after a
      // deploy (migrations apply post-merge via the guard workflows),
      // legacy follow_up/callback creation must keep working — an
      // unconditional payload would fail every insert until the
      // migration lands. Appointment creation cannot predate the schema
      // (no booking UI ships before PR 2).
      ...(input.contactId !== undefined ? { contact_id: input.contactId } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.endAt !== undefined ? { end_at: input.endAt } : {}),
      // The DB's chain invariant requires every appointment to carry a
      // calendar_chain_id (and forbids one on any other type) — it is the
      // durable identity of the logical appointment across reschedule
      // successors, born here at creation.
      ...(input.type === "appointment"
        ? { calendar_chain_id: crypto.randomUUID() }
        : {}),
    })
    .select()
    .single();

  if (error || !data) {
    return err({
      code: "TASK_CREATE_FAILED",
      message: error?.message ?? "Failed to create task",
    });
  }

  if (data.type !== "appointment" && data.related_property_id) {
    await recordLeadEvent({
      propertyId: data.related_property_id,
      actorType: "user",
      actorId: input.createdBy,
      eventType: LEAD_EVENT_TYPES.TASK_CREATED,
      payload: {
        task_id: data.id,
        task_type: data.type,
        due_at: data.due_at,
        assignee_id: data.assignee_id,
      },
      sourceType: "tasks.created",
      sourceId: data.id,
    });
  }
  return ok(data);
}

export async function completeTask(
  supabase: SupabaseClient<Database>,
  taskId: string,
  userId: string,
  expectedAssigneeId?: string,
): Promise<Result<Task>> {
  const { data: previous, error: readError } = await supabase
    .from("tasks")
    .select()
    .eq("id", taskId)
    .maybeSingle();

  if (readError || !previous) {
    return err({
      code: "TASK_COMPLETE_FAILED",
      message: readError?.message ?? "Failed to complete task",
    });
  }
  if (previous.type === "appointment") {
    return err({
      code: "TASK_COMPLETE_UNSUPPORTED",
      message:
        "Appointments close through their outcome (held / no-show / rescheduled), not the generic Done action.",
    });
  }
  if (
    expectedAssigneeId !== undefined &&
    previous.assignee_id !== expectedAssigneeId
  ) {
    return err({
      code: "TASK_COMPLETE_FAILED",
      message: "Task is no longer assigned to this user",
    });
  }
  if (previous.status === "completed") return ok(previous);

  const now = new Date().toISOString();
  // Appointments complete only through the outcome flow (PR 3): closing
  // one without held/no-show semantics would hide it from the queue with
  // no record of what happened and no calendar lifecycle coordination.
  // The status read supplies the event's truthful previous value. Pair it
  // with the UPDATE predicate so a racing change returns zero rows and is
  // reconciled below instead of being overwritten or double-recorded.
  const { data, error } = await supabase
    .from("tasks")
    .update({
      status: "completed",
      completed_at: now,
      completed_by: userId,
      updated_at: now,
    })
    .eq("id", taskId)
    .eq("status", previous.status)
    .eq("assignee_id", previous.assignee_id)
    .neq("type", "appointment")
    .select()
    .maybeSingle();

  if (error) {
    return err({
      code: "TASK_COMPLETE_FAILED",
      message: error.message,
    });
  }

  if (!data) {
    const { data: existing, error: reconcileError } = await supabase
      .from("tasks")
      .select()
      .eq("id", taskId)
      .maybeSingle();
    if (reconcileError) {
      return err({
        code: "TASK_COMPLETE_FAILED",
        message: reconcileError.message,
      });
    }
    if (existing?.type === "appointment") {
      return err({
        code: "TASK_COMPLETE_UNSUPPORTED",
        message:
          "Appointments close through their outcome (held / no-show / rescheduled), not the generic Done action.",
      });
    }
    if (
      expectedAssigneeId !== undefined &&
      existing?.assignee_id !== expectedAssigneeId
    ) {
      return err({
        code: "TASK_COMPLETE_FAILED",
        message: "Task is no longer assigned to this user",
      });
    }
    if (existing?.status === "completed") return ok(existing);
    return err({
      code: "TASK_COMPLETE_FAILED",
      message: "Failed to complete task",
    });
  }

  if (data.related_property_id) {
    await recordLeadEvent({
      propertyId: data.related_property_id,
      actorType: "user",
      actorId: userId,
      eventType: LEAD_EVENT_TYPES.TASK_COMPLETED,
      payload: {
        task_id: data.id,
        from: previous.status,
        to: "completed",
      },
    });
  }
  return ok(data);
}

/**
 * Bumps `due_at` forward to `snoozedUntil` so the task drops out of "Today"
 * and reappears on the assignee's dashboard at the new time. Also stamps
 * `snoozed_until` as an audit trail (V1 doesn't read it, but a future
 * "snoozed N times — flag it" surface will).
 *
 * Status stays `open` — V1 has no separate snoozed-bucket query path.
 */
export async function snoozeTask(
  supabase: SupabaseClient<Database>,
  taskId: string,
  /** ISO timestamptz — the new due_at */
  snoozedUntil: string,
  actorId: string,
): Promise<Result<Task>> {
  const { data: previous, error: readError } = await supabase
    .from("tasks")
    .select()
    .eq("id", taskId)
    .maybeSingle();

  if (readError || !previous) {
    return err({
      code: "TASK_SNOOZE_FAILED",
      message: readError?.message ?? "Failed to snooze task",
    });
  }
  if (previous.type === "appointment") {
    return err({
      code: "TASK_SNOOZE_UNSUPPORTED",
      message:
        "Appointments can't be snoozed — reschedule them from the appointment instead.",
    });
  }
  if (previous.status !== "open") {
    return err({
      code: "TASK_SNOOZE_FAILED",
      message: "Only open tasks can be snoozed",
    });
  }
  if (
    new Date(previous.due_at).getTime() === new Date(snoozedUntil).getTime()
  ) {
    return ok(previous);
  }

  const now = new Date().toISOString();

  // Appointments are never snoozed: moving one is a reschedule, which the
  // calendar-mutation lifecycle owns end-to-end. The due_at predicate makes
  // this compare-and-set atomic; the type predicate and DB trigger also
  // reject a racing appointment conversion.
  const { data, error } = await supabase
    .from("tasks")
    .update({
      due_at: snoozedUntil,
      snoozed_until: snoozedUntil,
      updated_at: now,
    })
    .eq("id", taskId)
    .eq("due_at", previous.due_at)
    .eq("status", previous.status)
    .neq("type", "appointment")
    .select()
    .maybeSingle();

  if (error) {
    return err({
      code: "TASK_SNOOZE_FAILED",
      message: error.message,
    });
  }

  if (!data) {
    const { data: existing, error: reconcileError } = await supabase
      .from("tasks")
      .select()
      .eq("id", taskId)
      .maybeSingle();
    if (reconcileError) {
      return err({
        code: "TASK_SNOOZE_FAILED",
        message: reconcileError.message,
      });
    }
    if (existing?.type === "appointment") {
      return err({
        code: "TASK_SNOOZE_UNSUPPORTED",
        message:
          "Appointments can't be snoozed — reschedule them from the appointment instead.",
      });
    }
    if (existing?.status !== "open") {
      return err({
        code: "TASK_SNOOZE_FAILED",
        message: "Only open tasks can be snoozed",
      });
    }
    if (
      new Date(existing.due_at).getTime() ===
      new Date(snoozedUntil).getTime()
    ) {
      return ok(existing);
    }
    return err({
      code: "TASK_SNOOZE_FAILED",
      message: "Failed to snooze task",
    });
  }

  if (data.related_property_id) {
    await recordLeadEvent({
      propertyId: data.related_property_id,
      actorType: "user",
      actorId,
      eventType: LEAD_EVENT_TYPES.TASK_SNOOZED,
      payload: {
        task_id: data.id,
        from: previous.due_at,
        to: data.due_at,
      },
    });
  }
  await scheduleCalendarUpdateAfterSnooze(supabase, data);
  return ok(data);
}

export async function reassignTask(
  supabase: SupabaseClient<Database>,
  taskId: string,
  newAssigneeId: string,
  actorId: string,
): Promise<Result<Task>> {
  const { data: previous, error: readError } = await supabase
    .from("tasks")
    .select()
    .eq("id", taskId)
    .maybeSingle();

  if (readError || !previous) {
    return err({
      code: "TASK_REASSIGN_FAILED",
      message: readError?.message ?? "Failed to reassign task",
    });
  }
  if (previous.type === "appointment") {
    return err({
      code: "TASK_REASSIGN_UNSUPPORTED",
      message:
        "Appointments are reassigned from the appointment itself, moving the calendar event with them.",
    });
  }
  if (previous.assignee_id === newAssigneeId) return ok(previous);

  const now = new Date().toISOString();
  // Appointments reassign only through the calendar lifecycle: ownership
  // moves the Google event between accounts. Compare on the old assignee so
  // concurrent ownership changes cannot be overwritten or double-recorded;
  // the type predicate and DB trigger backstop appointment races.
  const { data, error } = await supabase
    .from("tasks")
    .update({
      assignee_id: newAssigneeId,
      updated_at: now,
    })
    .eq("id", taskId)
    .eq("assignee_id", previous.assignee_id)
    .neq("type", "appointment")
    .select()
    .maybeSingle();

  if (error) {
    return err({
      code: "TASK_REASSIGN_FAILED",
      message: error.message,
    });
  }

  if (!data) {
    const { data: existing, error: reconcileError } = await supabase
      .from("tasks")
      .select()
      .eq("id", taskId)
      .maybeSingle();
    if (reconcileError) {
      return err({
        code: "TASK_REASSIGN_FAILED",
        message: reconcileError.message,
      });
    }
    if (existing?.type === "appointment") {
      return err({
        code: "TASK_REASSIGN_UNSUPPORTED",
        message:
          "Appointments are reassigned from the appointment itself, moving the calendar event with them.",
      });
    }
    if (existing?.assignee_id === newAssigneeId) return ok(existing);
    return err({
      code: "TASK_REASSIGN_FAILED",
      message: "Failed to reassign task",
    });
  }

  if (data.related_property_id) {
    await recordLeadEvent({
      propertyId: data.related_property_id,
      actorType: "user",
      actorId,
      eventType: LEAD_EVENT_TYPES.TASK_REASSIGNED,
      payload: {
        task_id: data.id,
        from: previous.assignee_id,
        to: data.assignee_id,
      },
    });
  }
  return ok(data);
}

async function scheduleCalendarUpdateAfterSnooze(
  supabase: SupabaseClient<Database>,
  task: Task,
): Promise<void> {
  if (!task.assignee_id || !task.due_at) return;

  // Property-less tasks (personal blocks, contact-only appointments)
  // still get a calendar update — just a title-only payload instead of
  // an address-based one, since there's no property to summarize.
  const propertyAddress = task.related_property_id
    ? await loadTaskPropertyAddress(supabase, task.related_property_id)
    : task.title;
  const prefs = await loadIntegrationPrefs(supabase, task.assignee_id);
  const deepLink = buildTaskDeepLink(task.related_property_id, task.contact_id);

  after(async () => {
    await dispatchTaskCalendarEventUpdate({
      taskId: task.id,
      assigneeId: task.assignee_id,
      taskTitle: task.title,
      propertyAddress,
      dueAt: task.due_at,
      // Snooze is already blocked for appointments (see snoozeTask above),
      // but this update path is shared by future lifecycle callers — thread
      // end_at through faithfully whenever the row carries one.
      endAt: task.end_at ?? undefined,
      timezone: prefs.timezone,
      deepLink,
      calendarEnabled: prefs.calendarEnabled,
    });
  });
}

async function loadTaskPropertyAddress(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<string> {
  const { data } = await supabase
    .from("properties")
    .select("address")
    .eq("id", propertyId)
    .maybeSingle();
  return data?.address ?? "Property";
}

function buildTaskDeepLink(
  propertyId: string | null,
  contactId: string | null,
): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    "https://sandra-sooty.vercel.app";
  const normalizedBaseUrl = baseUrl.startsWith("http")
    ? baseUrl
    : `https://${baseUrl}`;
  if (propertyId)
    return `${normalizedBaseUrl}/messages?property_id=${propertyId}`;
  // Contact-only tasks (no property) deep-link to the Messages thread
  // instead — canonicalizeThreadId resolves a raw contact id to its
  // conversation.
  if (contactId) return `${normalizedBaseUrl}/messages?thread=${contactId}`;
  return normalizedBaseUrl;
}
