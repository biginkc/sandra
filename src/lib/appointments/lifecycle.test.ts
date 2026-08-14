import { describe, expect, it, vi } from "vitest";

import {
  cancelAppointment,
  completeAppointment,
  reassignAppointment,
  rescheduleAppointment,
} from "./lifecycle";

/** Minimal fake Supabase client exposing only `.rpc`, matching how every
 *  RPC-wrapping function in lifecycle.ts calls it. */
function fakeSupabase(
  response: { data: unknown; error: { message: string; code?: string } | null },
) {
  const rpc = vi.fn().mockResolvedValue(response);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { rpc } as any;
}

describe("completeAppointment", () => {
  it("rejects an outcome that isn't held/no_show before ever calling the RPC", async () => {
    const supabase = fakeSupabase({ data: null, error: null });

    // @ts-expect-error — deliberately passing an invalid outcome to prove
    // the client-side guard fires before the RPC call.
    const result = await completeAppointment(supabase, "task-1", "cancelled");

    expect(result.ok).toBe(false);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("maps a successful RPC call to a typed result", async () => {
    const supabase = fakeSupabase({
      data: { task_id: "task-1", status: "completed", outcome: "held" },
      error: null,
    });

    const result = await completeAppointment(supabase, "task-1", "held");

    expect(supabase.rpc).toHaveBeenCalledWith("fn_complete_appointment", {
      p_task: "task-1",
      p_outcome: "held",
    });
    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", status: "completed", outcome: "held" },
    });
  });

  it("maps an RPC error to a typed failure", async () => {
    const supabase = fakeSupabase({
      data: null,
      error: { message: "appointment is not open", code: "P0001" },
    });

    const result = await completeAppointment(supabase, "task-1", "held");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("COMPLETE_APPOINTMENT_FAILED");
      expect(result.error.message).toBe("appointment is not open");
    }
  });
});

describe("cancelAppointment", () => {
  it("maps a successful RPC call to a typed result", async () => {
    const supabase = fakeSupabase({
      data: { task_id: "task-1", status: "cancelled", ledger_id: "ledger-1" },
      error: null,
    });

    const result = await cancelAppointment(supabase, "task-1");

    expect(supabase.rpc).toHaveBeenCalledWith("fn_cancel_appointment", { p_task: "task-1" });
    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", status: "cancelled", ledgerId: "ledger-1" },
    });
  });

  it("maps an RPC error to a typed failure", async () => {
    const supabase = fakeSupabase({
      data: null,
      error: { message: "calendar sync in progress" },
    });

    const result = await cancelAppointment(supabase, "task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CANCEL_APPOINTMENT_FAILED");
  });
});

describe("rescheduleAppointment", () => {
  const input = {
    taskId: "task-1",
    newStartUtc: "2026-09-02T15:00:00.000Z",
    newEndUtc: "2026-09-02T15:30:00.000Z",
    timeZone: "America/Chicago",
  };

  it("rejects a non-positive window before calling the RPC", async () => {
    const supabase = fakeSupabase({ data: null, error: null });

    const result = await rescheduleAppointment(supabase, {
      ...input,
      newEndUtc: input.newStartUtc,
    });

    expect(result.ok).toBe(false);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("maps a successful RPC call to a typed result, defaulting idempotencyKey to null", async () => {
    const supabase = fakeSupabase({
      data: {
        task_id: "succ-1",
        old_task_id: "task-1",
        calendar_chain_id: "chain-1",
        duplicate: false,
      },
      error: null,
    });

    const result = await rescheduleAppointment(supabase, input);

    expect(supabase.rpc).toHaveBeenCalledWith("fn_reschedule_appointment", {
      p_task: "task-1",
      p_new_start: input.newStartUtc,
      p_new_end: input.newEndUtc,
      p_timezone: "America/Chicago",
      p_idempotency_key: null,
    });
    expect(result).toEqual({
      ok: true,
      data: { taskId: "succ-1", oldTaskId: "task-1", chainId: "chain-1", duplicate: false },
    });
  });

  it("passes idempotencyKey through when supplied", async () => {
    const supabase = fakeSupabase({
      data: {
        task_id: "succ-1",
        old_task_id: "task-1",
        calendar_chain_id: "chain-1",
        duplicate: true,
      },
      error: null,
    });

    await rescheduleAppointment(supabase, { ...input, idempotencyKey: "idem-1" });

    expect(supabase.rpc).toHaveBeenCalledWith(
      "fn_reschedule_appointment",
      expect.objectContaining({ p_idempotency_key: "idem-1" }),
    );
  });

  it("maps an RPC error to a typed failure", async () => {
    const supabase = fakeSupabase({ data: null, error: { message: "timezone mismatch" } });

    const result = await rescheduleAppointment(supabase, input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RESCHEDULE_APPOINTMENT_FAILED");
  });
});

describe("reassignAppointment", () => {
  it("rejects an empty new-assignee id before calling the RPC", async () => {
    const supabase = fakeSupabase({ data: null, error: null });

    const result = await reassignAppointment(supabase, "task-1", "");

    expect(result.ok).toBe(false);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("maps a successful RPC call to a typed result", async () => {
    const supabase = fakeSupabase({
      data: {
        task_id: "task-1",
        old_assignee_id: "user-a",
        new_assignee_id: "user-b",
        duplicate: false,
      },
      error: null,
    });

    const result = await reassignAppointment(supabase, "task-1", "user-b");

    expect(supabase.rpc).toHaveBeenCalledWith("fn_reassign_appointment", {
      p_task: "task-1",
      p_new_assignee: "user-b",
      p_idempotency_key: null,
    });
    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-a", newAssigneeId: "user-b", duplicate: false },
    });
  });

  it("maps an RPC error to a typed failure", async () => {
    const supabase = fakeSupabase({
      data: null,
      error: { message: "new assignee has no active membership" },
    });

    const result = await reassignAppointment(supabase, "task-1", "user-b");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("REASSIGN_APPOINTMENT_FAILED");
  });
});
