import type { SupabaseClient } from "@supabase/supabase-js";

import type { Result } from "@/lib/errors/result";
import { err, ok } from "@/lib/errors/result";
import type { Database, Tables } from "@/lib/supabase/types";

export type Task = Tables<"tasks">;
export type TaskType = "follow_up" | "callback" | "custom";
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
  relatedPropertyId: string;
  type: TaskType;
  title: string;
  /** ISO timestamptz */
  dueAt: string;
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
      related_property_id: input.relatedPropertyId,
      type: input.type,
      title: input.title,
      due_at: input.dueAt,
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
