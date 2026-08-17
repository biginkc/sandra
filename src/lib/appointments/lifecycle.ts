import type { SupabaseClient } from "@supabase/supabase-js";

import type { Result } from "@/lib/errors/result";
import { err, ok } from "@/lib/errors/result";
import type { Database } from "@/lib/supabase/types";

/**
 * Thin RPC-wrapping layer for the PR 3 appointment lifecycle functions
 * (migration 20260814210000). No auth/session lookup, no `after()` side
 * effects, no `revalidatePath` here — that's `lifecycle-actions.ts`'s job
 * ("use server" boundary). This file exists so the RPC call shape, typed
 * args, and error mapping can be unit-tested (and reused by any future
 * caller) without pulling in Next.js server-action machinery.
 *
 * The four RPC functions are not (and, per this PR's scope, must not be) in
 * the generated `Database["public"]["Functions"]` map — same local-cast
 * pattern PR 2 used for `fn_book_appointment`/`fn_get_member_timezone`
 * (src/components/appointments/book-appointment-action.ts).
 */

export type AppointmentOutcome = "held" | "no_show";

export type CompleteAppointmentResult = {
  taskId: string;
  status: "completed";
  outcome: AppointmentOutcome;
};

export type CancelAppointmentResult = {
  taskId: string;
  status: "cancelled";
  ledgerId: string;
};

export type RescheduleAppointmentInput = {
  taskId: string;
  newStartUtc: string;
  newEndUtc: string;
  timeZone: string;
  idempotencyKey?: string;
};

export type RescheduleAppointmentResult = {
  /** The successor task's id — the caller's new "current" appointment. */
  taskId: string;
  oldTaskId: string;
  chainId: string;
  duplicate: boolean;
  ledgerId: string;
};

export type ReassignAppointmentResult = {
  taskId: string;
  oldAssigneeId: string;
  newAssigneeId: string;
  duplicate: boolean;
  ledgerId: string;
};

type RpcResult<T> = PromiseLike<{
  data: T | null;
  error: { message: string; code?: string } | null;
}>;

type LifecycleRpcClient = {
  rpc(
    fn: "fn_complete_appointment",
    args: { p_task: string; p_outcome: AppointmentOutcome },
  ): RpcResult<{ task_id: string; status: string; outcome: string }>;
  rpc(
    fn: "fn_cancel_appointment",
    args: { p_task: string },
  ): RpcResult<{ task_id: string; status: string; ledger_id: string }>;
  rpc(
    fn: "fn_reschedule_appointment",
    args: {
      p_task: string;
      p_new_start: string;
      p_new_end: string;
      p_timezone: string;
      p_idempotency_key: string | null;
    },
  ): RpcResult<{
    task_id: string;
    old_task_id: string;
    calendar_chain_id: string;
    duplicate: boolean;
    ledger_id: string;
  }>;
  rpc(
    fn: "fn_reassign_appointment",
    args: {
      p_task: string;
      p_new_assignee: string;
      p_idempotency_key: string | null;
    },
  ): RpcResult<{
    task_id: string;
    old_assignee_id: string;
    new_assignee_id: string;
    duplicate: boolean;
    ledger_id: string;
  }>;
};

function asLifecycleRpcClient(
  supabase: SupabaseClient<Database>,
): LifecycleRpcClient {
  return supabase as unknown as LifecycleRpcClient;
}

export async function completeAppointment(
  supabase: SupabaseClient<Database>,
  taskId: string,
  outcome: AppointmentOutcome,
): Promise<Result<CompleteAppointmentResult>> {
  if (outcome !== "held" && outcome !== "no_show") {
    return err({
      code: "COMPLETE_APPOINTMENT_INVALID_OUTCOME",
      message: "Outcome must be held or no_show.",
    });
  }
  const { data, error } = await asLifecycleRpcClient(supabase).rpc(
    "fn_complete_appointment",
    { p_task: taskId, p_outcome: outcome },
  );
  if (error || !data) {
    return err({
      code: "COMPLETE_APPOINTMENT_FAILED",
      message: error?.message ?? "Could not complete the appointment.",
    });
  }
  return ok({ taskId: data.task_id, status: "completed", outcome });
}

export async function cancelAppointment(
  supabase: SupabaseClient<Database>,
  taskId: string,
): Promise<Result<CancelAppointmentResult>> {
  const { data, error } = await asLifecycleRpcClient(supabase).rpc(
    "fn_cancel_appointment",
    { p_task: taskId },
  );
  if (error || !data) {
    return err({
      code: "CANCEL_APPOINTMENT_FAILED",
      message: error?.message ?? "Could not cancel the appointment.",
    });
  }
  return ok({
    taskId: data.task_id,
    status: "cancelled",
    ledgerId: data.ledger_id,
  });
}

export async function rescheduleAppointment(
  supabase: SupabaseClient<Database>,
  input: RescheduleAppointmentInput,
): Promise<Result<RescheduleAppointmentResult>> {
  if (
    new Date(input.newEndUtc).getTime() <= new Date(input.newStartUtc).getTime()
  ) {
    return err({
      code: "RESCHEDULE_APPOINTMENT_INVALID_WINDOW",
      message: "End must be after start.",
    });
  }
  const { data, error } = await asLifecycleRpcClient(supabase).rpc(
    "fn_reschedule_appointment",
    {
      p_task: input.taskId,
      p_new_start: input.newStartUtc,
      p_new_end: input.newEndUtc,
      p_timezone: input.timeZone,
      p_idempotency_key: input.idempotencyKey ?? null,
    },
  );
  if (error || !data) {
    return err({
      code: "RESCHEDULE_APPOINTMENT_FAILED",
      message: error?.message ?? "Could not reschedule the appointment.",
    });
  }
  return ok({
    taskId: data.task_id,
    oldTaskId: data.old_task_id,
    chainId: data.calendar_chain_id,
    duplicate: data.duplicate,
    ledgerId: data.ledger_id,
  });
}

export async function reassignAppointment(
  supabase: SupabaseClient<Database>,
  taskId: string,
  newAssigneeId: string,
  idempotencyKey?: string,
): Promise<Result<ReassignAppointmentResult>> {
  if (!newAssigneeId) {
    return err({
      code: "REASSIGN_APPOINTMENT_ASSIGNEE_REQUIRED",
      message: "Choose who this appointment goes to.",
    });
  }
  const { data, error } = await asLifecycleRpcClient(supabase).rpc(
    "fn_reassign_appointment",
    {
      p_task: taskId,
      p_new_assignee: newAssigneeId,
      p_idempotency_key: idempotencyKey ?? null,
    },
  );
  if (error || !data) {
    return err({
      code: "REASSIGN_APPOINTMENT_FAILED",
      message: error?.message ?? "Could not reassign the appointment.",
    });
  }
  return ok({
    taskId: data.task_id,
    oldAssigneeId: data.old_assignee_id,
    newAssigneeId: data.new_assignee_id,
    duplicate: data.duplicate,
    ledgerId: data.ledger_id,
  });
}
