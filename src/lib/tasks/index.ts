import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

import type { Result } from "@/lib/errors/result";
import { err, ok } from "@/lib/errors/result";
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

export async function createTask(
  supabase: SupabaseClient<Database>,
  input: CreateTaskInput,
): Promise<Result<Task>> {
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      org_id: input.orgId,
      assignee_id: input.assigneeId,
      related_property_id: input.relatedPropertyId ?? null,
      contact_id: input.contactId ?? null,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      due_at: input.dueAt,
      end_at: input.endAt ?? null,
      // The DB's chain invariant requires every appointment to carry a
      // calendar_chain_id (and forbids one on any other type) — it is the
      // durable identity of the logical appointment across reschedule
      // successors, born here at creation.
      calendar_chain_id:
        input.type === "appointment" ? crypto.randomUUID() : null,
      created_by: input.createdBy,
    })
    .select()
    .single();

  if (error || !data) {
    return err({
      code: "TASK_CREATE_FAILED",
      message: error?.message ?? "Failed to create task",
    });
  }
  return ok(data);
}

export async function completeTask(
  supabase: SupabaseClient<Database>,
  taskId: string,
  userId: string,
): Promise<Result<Task>> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("tasks")
    .update({
      status: "completed",
      completed_at: now,
      completed_by: userId,
      updated_at: now,
    })
    .eq("id", taskId)
    .select()
    .single();

  if (error || !data) {
    return err({
      code: "TASK_COMPLETE_FAILED",
      message: error?.message ?? "Failed to complete task",
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
): Promise<Result<Task>> {
  const now = new Date().toISOString();

  // Appointments are never snoozed: moving one is a reschedule, which the
  // calendar-mutation lifecycle (PR 3) owns end-to-end. The legacy snooze
  // path would commit a shifted Sandra window and then hand the calendar
  // updater a bare due_at, rebuilding the Google event at the hardcoded
  // 30 minutes regardless of the booked duration. The dashboard hides the
  // control for appointment rows; this guard covers every other caller.
  const { data: existing } = await supabase
    .from("tasks")
    .select("type")
    .eq("id", taskId)
    .single();

  if (existing?.type === "appointment") {
    return err({
      code: "TASK_SNOOZE_UNSUPPORTED",
      message:
        "Appointments can't be snoozed — reschedule them from the appointment instead.",
    });
  }

  const { data, error } = await supabase
    .from("tasks")
    .update({
      due_at: snoozedUntil,
      snoozed_until: snoozedUntil,
      updated_at: now,
    })
    .eq("id", taskId)
    .select()
    .single();

  if (error || !data) {
    return err({
      code: "TASK_SNOOZE_FAILED",
      message: error?.message ?? "Failed to snooze task",
    });
  }
  await scheduleCalendarUpdateAfterSnooze(supabase, data);
  return ok(data);
}

export async function reassignTask(
  supabase: SupabaseClient<Database>,
  taskId: string,
  newAssigneeId: string,
): Promise<Result<Task>> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("tasks")
    .update({
      assignee_id: newAssigneeId,
      updated_at: now,
    })
    .eq("id", taskId)
    .select()
    .single();

  if (error || !data) {
    return err({
      code: "TASK_REASSIGN_FAILED",
      message: error?.message ?? "Failed to reassign task",
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
  const deepLink = buildTaskDeepLink(
    task.related_property_id,
    task.contact_id,
  );

  after(async () => {
    await dispatchTaskCalendarEventUpdate({
      taskId: task.id,
      assigneeId: task.assignee_id,
      taskTitle: task.title,
      propertyAddress,
      dueAt: task.due_at,
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
  if (propertyId) return `${normalizedBaseUrl}/messages?property_id=${propertyId}`;
  // Contact-only tasks (no property) deep-link to the Messages thread
  // instead — canonicalizeThreadId resolves a raw contact id to its
  // conversation.
  if (contactId) return `${normalizedBaseUrl}/messages?thread=${contactId}`;
  return normalizedBaseUrl;
}
