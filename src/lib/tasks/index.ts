import type { SupabaseClient } from "@supabase/supabase-js";

import type { Result } from "@/lib/errors/result";
import { err, ok } from "@/lib/errors/result";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import type { Database, Tables } from "@/lib/supabase/types";

export type Task = Tables<"tasks">;
/** Read-side union: historical rows keep `follow_up`/`callback` (decision D1, "history untouched"). */
export type TaskType = "follow_up" | "callback" | "custom" | "appointment";
/** The only types a writer may create; the DB rejects `follow_up`/`callback` inserts (TASK_TYPE_RETIRED). */
export type CreatableTaskType = Extract<TaskType, "appointment" | "custom">;
export type TaskStatus = "open" | "snoozed" | "completed" | "cancelled";

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
