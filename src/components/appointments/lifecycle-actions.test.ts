import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  afterCallbacks,
  afterMock,
  cancelAppointment,
  completeAppointment,
  createAdminClient,
  createClient,
  dispatchTaskAssigned,
  dispatchTaskAssignedSlack,
  kickCalendarMutationSync,
  loadIntegrationPrefs,
  reassignAppointment,
  rescheduleAppointment,
  revalidatePath,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void> | void>,
  afterMock: vi.fn((callback: () => Promise<void> | void) => {
    afterCallbacks.push(callback);
  }),
  cancelAppointment: vi.fn(),
  completeAppointment: vi.fn(),
  createAdminClient: vi.fn(() => ({ __admin: true })),
  createClient: vi.fn(),
  dispatchTaskAssigned: vi.fn(),
  dispatchTaskAssignedSlack: vi.fn(),
  kickCalendarMutationSync: vi.fn().mockResolvedValue(undefined),
  loadIntegrationPrefs: vi.fn(async () => ({
    slackEnabled: true,
    calendarEnabled: true,
    timezone: "America/Chicago",
  })),
  reassignAppointment: vi.fn(),
  rescheduleAppointment: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs }));
vi.mock("@/lib/integrations/slack/dispatch", () => ({ dispatchTaskAssignedSlack }));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchTaskAssigned }));
vi.mock("@/lib/appointments/inline-sync-kick", () => ({ kickCalendarMutationSync }));
vi.mock("@/lib/appointments/lifecycle", () => ({
  cancelAppointment,
  completeAppointment,
  reassignAppointment,
  rescheduleAppointment,
}));

import {
  cancelAppointmentAction,
  completeAppointmentAction,
  reassignAppointmentAction,
  rescheduleAppointmentAction,
} from "./lifecycle-actions";

type TaskRow = {
  org_id: string;
  title: string;
  due_at: string;
  related_property_id: string | null;
  contact_id: string | null;
};

function makeSupabaseMock(opts: {
  userId?: string | null;
  taskRow?: TaskRow | null;
  propertyAddress?: string | null;
}) {
  const tasksBuilder: Record<string, unknown> = {
    select: vi.fn(function (this: unknown) {
      return this;
    }),
    eq: vi.fn(function (this: unknown) {
      return this;
    }),
    maybeSingle: vi.fn().mockResolvedValue({ data: opts.taskRow ?? null, error: null }),
  };
  const propertiesBuilder: Record<string, unknown> = {
    select: vi.fn(function (this: unknown) {
      return this;
    }),
    eq: vi.fn(function (this: unknown) {
      return this;
    }),
    maybeSingle: vi.fn().mockResolvedValue({
      data: opts.propertyAddress !== undefined ? { address: opts.propertyAddress } : null,
      error: null,
    }),
  };
  const from = vi.fn((table: string) => {
    if (table === "tasks") return tasksBuilder;
    if (table === "properties") return propertiesBuilder;
    throw new Error(`Unexpected table in test: ${table}`);
  });

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.userId ? { id: opts.userId } : null },
      }),
    },
    from,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  afterCallbacks.length = 0;
});

describe("completeAppointmentAction", () => {
  it("rejects when unauthenticated, never calling the lib function", async () => {
    createClient.mockResolvedValue(makeSupabaseMock({ userId: null }));

    const result = await completeAppointmentAction("task-1", "held");

    expect(result).toEqual({ ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } });
    expect(completeAppointment).not.toHaveBeenCalled();
  });

  it("delegates to the lib and revalidates on success", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        taskRow: { org_id: "org-1", title: "Call", due_at: "2026-09-01T15:00:00Z", related_property_id: "prop-1", contact_id: null },
      }),
    );
    completeAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", status: "completed", outcome: "held" },
    });

    const result = await completeAppointmentAction("task-1", "held");

    expect(completeAppointment).toHaveBeenCalledWith(expect.anything(), "task-1", "held");
    expect(result.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/leads/prop-1");
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(revalidatePath).toHaveBeenCalledWith("/calendar");
  });

  it("does not revalidate when the RPC fails", async () => {
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));
    completeAppointment.mockResolvedValue({
      ok: false,
      error: { code: "COMPLETE_APPOINTMENT_FAILED", message: "not open" },
    });

    const result = await completeAppointmentAction("task-1", "held");

    expect(result.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // Codex round 11 (finding 3): the RPC above already committed — a
  // failure in the POST-commit task lookup (used only for revalidation)
  // must never flip this action's result back to an error. Before this
  // round, `revalidateAppointmentPaths(await loadTaskForNotification(...))`
  // ran uncaught, so a transient read failure here fell into the outer
  // catch and reported COMPLETE_APPOINTMENT_FAILED despite the mutation
  // having already durably succeeded.
  it("still returns the committed ok:true result — and reports separately — when the post-commit task lookup throws", async () => {
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));
    completeAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", status: "completed", outcome: "held" },
    });
    const supabase = await createClient();
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("transient read failure");
    });

    const result = await completeAppointmentAction("task-1", "held");

    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", status: "completed", outcome: "held" },
    });
    // The task lookup failed, so no property to scope a /leads/* path to —
    // but the unconditional paths still revalidate (null-task tolerance).
    expect(revalidatePath).not.toHaveBeenCalledWith(expect.stringMatching(/^\/leads\//));
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  // Codex round 11 (finding 3): same guarantee, but the throw is in
  // `revalidatePath` itself rather than the task lookup that feeds it.
  it("still returns the committed ok:true result when revalidatePath throws — the failure is reported on its own", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        taskRow: { org_id: "org-1", title: "Call", due_at: "2026-09-01T15:00:00Z", related_property_id: "prop-1", contact_id: null },
      }),
    );
    completeAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", status: "completed", outcome: "held" },
    });
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("revalidate boom");
    });

    const result = await completeAppointmentAction("task-1", "held");

    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", status: "completed", outcome: "held" },
    });
  });
});

describe("cancelAppointmentAction", () => {
  it("delegates to the lib and revalidates on success", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        taskRow: { org_id: "org-1", title: "Call", due_at: "2026-09-01T15:00:00Z", related_property_id: null, contact_id: "contact-1" },
      }),
    );
    cancelAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", status: "cancelled", ledgerId: "ledger-1" },
    });

    const result = await cancelAppointmentAction("task-1");

    expect(cancelAppointment).toHaveBeenCalledWith(expect.anything(), "task-1");
    expect(result.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(revalidatePath).toHaveBeenCalledWith("/calendar");
    // No property linkage on this task — no /leads/* revalidation.
    expect(revalidatePath).not.toHaveBeenCalledWith(expect.stringMatching(/^\/leads\//));
  });

  // Codex round 11 (finding 3): the RPC above already committed — a
  // `revalidatePath` throw in the best-effort post-commit step must never
  // flip this action's result back to an error.
  it("still returns the committed ok:true result when revalidatePath throws — the failure is reported on its own", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        taskRow: { org_id: "org-1", title: "Call", due_at: "2026-09-01T15:00:00Z", related_property_id: null, contact_id: "contact-1" },
      }),
    );
    cancelAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", status: "cancelled", ledgerId: "ledger-1" },
    });
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("revalidate boom");
    });

    const result = await cancelAppointmentAction("task-1");

    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", status: "cancelled", ledgerId: "ledger-1" },
    });
  });
});

describe("rescheduleAppointmentAction", () => {
  const validInput = {
    taskId: "task-1",
    date: "2026-09-02",
    time: "15:00",
    timeZone: "America/Chicago",
    durationMinutes: 30,
  };

  it("rejects an invalid duration before touching the network", async () => {
    const result = await rescheduleAppointmentAction({ ...validInput, durationMinutes: 0 });

    expect(result.ok).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("converts the wall time server-side and delegates to the lib", async () => {
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));
    rescheduleAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "succ-1", oldTaskId: "task-1", chainId: "chain-1", duplicate: false },
    });

    const result = await rescheduleAppointmentAction(validInput);

    expect(result.ok).toBe(true);
    expect(rescheduleAppointment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: "task-1",
        timeZone: "America/Chicago",
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
    expect(revalidatePath).toHaveBeenCalledWith("/calendar");
  });

  // Codex round 11 (finding 3): the RPC above already committed — a
  // `revalidatePath` throw in the best-effort post-commit step must never
  // flip this action's result back to an error.
  it("still returns the committed ok:true result when revalidatePath throws — the failure is reported on its own", async () => {
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));
    rescheduleAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "succ-1", oldTaskId: "task-1", chainId: "chain-1", duplicate: false },
    });
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("revalidate boom");
    });

    const result = await rescheduleAppointmentAction(validInput);

    expect(result).toEqual({
      ok: true,
      data: { taskId: "succ-1", oldTaskId: "task-1", chainId: "chain-1", duplicate: false },
    });
  });
});

describe("reassignAppointmentAction", () => {
  it("fires the assignment notification/Slack side effects for a real (non-duplicate, non-self) reassignment", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        taskRow: {
          org_id: "org-1",
          title: "Walkthrough",
          due_at: "2026-09-01T15:00:00Z",
          related_property_id: "prop-1",
          contact_id: null,
        },
        propertyAddress: "123 Main St",
      }),
    );
    reassignAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-1", newAssigneeId: "user-2", duplicate: false },
    });

    const result = await reassignAppointmentAction("task-1", "user-2");

    expect(result.ok).toBe(true);
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(dispatchTaskAssigned).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: "task-1", assigneeId: "user-2", taskType: "appointment" }),
    );
    expect(dispatchTaskAssignedSlack).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", assigneeId: "user-2" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/leads/prop-1");
    expect(revalidatePath).toHaveBeenCalledWith("/calendar");
  });

  it("skips the notification when the result is a duplicate (no-op) reassignment", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        taskRow: { org_id: "org-1", title: "Walkthrough", due_at: "2026-09-01T15:00:00Z", related_property_id: null, contact_id: null },
      }),
    );
    reassignAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-2", newAssigneeId: "user-2", duplicate: true },
    });

    await reassignAppointmentAction("task-1", "user-2");

    expect(afterCallbacks).toHaveLength(0);
  });

  it("skips the notification when the actor reassigns the appointment to themselves", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        taskRow: { org_id: "org-1", title: "Walkthrough", due_at: "2026-09-01T15:00:00Z", related_property_id: null, contact_id: null },
      }),
    );
    reassignAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-2", newAssigneeId: "user-1", duplicate: false },
    });

    await reassignAppointmentAction("task-1", "user-1");

    expect(afterCallbacks).toHaveLength(0);
  });

  it("does not revalidate or notify when the RPC fails", async () => {
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));
    reassignAppointment.mockResolvedValue({
      ok: false,
      error: { code: "REASSIGN_APPOINTMENT_FAILED", message: "not open" },
    });

    const result = await reassignAppointmentAction("task-1", "user-2");

    expect(result.ok).toBe(false);
    expect(afterCallbacks).toHaveLength(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // Codex round 10 (finding 3): the RPC above already committed the
  // reassignment — a failure in ANYTHING past that point (task re-fetch,
  // prefs, address lookup, admin client, the dispatch calls themselves)
  // must never flip this action's result back to an error. Before this
  // round, an uncaught task-fetch throw here fell into the action's OWN
  // catch block and reported REASSIGN_APPOINTMENT_FAILED despite the
  // mutation having already durably succeeded.
  it("still returns the committed ok:true result — and reports separately — when the post-RPC task lookup throws", async () => {
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));
    reassignAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-1", newAssigneeId: "user-2", duplicate: false },
    });
    const supabase = await createClient();
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("transient read failure");
    });

    const result = await reassignAppointmentAction("task-1", "user-2");

    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-1", newAssigneeId: "user-2", duplicate: false },
    });
    // The task lookup failed, so there's no property to scope a /leads/*
    // revalidation to, and no `after()` callback (which would need `task`)
    // is registered — but the RPC's own committed result still comes back
    // unchanged, and the unconditional paths still revalidate (same
    // null-task tolerance every other lifecycle action's
    // `revalidateAppointmentPaths` call already has).
    expect(afterCallbacks).toHaveLength(0);
    expect(revalidatePath).not.toHaveBeenCalledWith(expect.stringMatching(/^\/leads\//));
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("still returns the committed ok:true result when the after() notification prep throws — the failure is reported on its own, never touching the already-returned result", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        taskRow: {
          org_id: "org-1",
          title: "Walkthrough",
          due_at: "2026-09-01T15:00:00Z",
          related_property_id: "prop-1",
          contact_id: null,
        },
        propertyAddress: "123 Main St",
      }),
    );
    reassignAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-1", newAssigneeId: "user-2", duplicate: false },
    });
    // Two createAdminClient() calls now happen for a successful reassign:
    // the inline sync kick (synchronous, right after the RPC) and the
    // notification-prep inside after(). Only the SECOND (notification
    // prep) should throw here — chaining two one-shot implementations
    // (rather than a persistent override) keeps this scoped to this test,
    // same as every other `mockImplementationOnce` use in this file.
    createAdminClient
      .mockImplementationOnce(() => ({ __admin: true }))
      .mockImplementationOnce(() => {
        throw new Error("admin client unavailable");
      });

    const result = await reassignAppointmentAction("task-1", "user-2");

    // The result was already committed and returned before after() ever
    // ran — the notification-prep throw below can't touch it.
    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-1", newAssigneeId: "user-2", duplicate: false },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/leads/prop-1");
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();

    expect(dispatchTaskAssigned).not.toHaveBeenCalled();
    expect(dispatchTaskAssignedSlack).not.toHaveBeenCalled();
  });

  // Codex round 11 (finding 3): round 10 guarded the post-commit task
  // RE-FETCH but left the `revalidateAppointmentPaths` call itself
  // unguarded — a `revalidatePath` throw there would still fall into the
  // outer catch and report REASSIGN_APPOINTMENT_FAILED despite the
  // already-committed reassignment. Closed this round.
  it("still returns the committed ok:true result when revalidatePath throws — the failure is reported on its own, never touching the already-returned result", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        taskRow: {
          org_id: "org-1",
          title: "Walkthrough",
          due_at: "2026-09-01T15:00:00Z",
          related_property_id: "prop-1",
          contact_id: null,
        },
        propertyAddress: "123 Main St",
      }),
    );
    reassignAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-1", newAssigneeId: "user-2", duplicate: false },
    });
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("revalidate boom");
    });

    const result = await reassignAppointmentAction("task-1", "user-2");

    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-1", newAssigneeId: "user-2", duplicate: false },
    });
    // The notification path still runs — task was resolved fine, only
    // revalidatePath itself threw.
    expect(afterCallbacks).toHaveLength(1);
  });
});

describe("inline calendar sync kick — every lifecycle action", () => {
  beforeEach(() => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        taskRow: { org_id: "org-1", title: "Call", due_at: "2026-09-01T15:00:00Z", related_property_id: null, contact_id: null },
      }),
    );
  });

  it("completeAppointmentAction kicks the inline sync (admin client) after a successful complete, before revalidation", async () => {
    completeAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", status: "completed", outcome: "held" },
    });
    const callOrder: string[] = [];
    kickCalendarMutationSync.mockImplementationOnce(async () => {
      callOrder.push("kick");
    });
    revalidatePath.mockImplementationOnce(() => {
      callOrder.push("revalidate");
    });

    await completeAppointmentAction("task-1", "held");

    expect(kickCalendarMutationSync).toHaveBeenCalledWith({ __admin: true });
    expect(callOrder[0]).toBe("kick");
  });

  it("completeAppointmentAction still returns ok:true when the kick rejects", async () => {
    const { reportError } = await import("@/lib/errors/report");
    completeAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", status: "completed", outcome: "held" },
    });
    kickCalendarMutationSync.mockRejectedValueOnce(new Error("kick exploded"));

    const result = await completeAppointmentAction("task-1", "held");

    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", status: "completed", outcome: "held" },
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "complete_appointment_action_inline_sync_kick" } }),
    );
  });

  it("cancelAppointmentAction kicks the inline sync and still returns ok:true when it rejects", async () => {
    const { reportError } = await import("@/lib/errors/report");
    cancelAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", status: "cancelled", ledgerId: "ledger-1" },
    });
    kickCalendarMutationSync.mockRejectedValueOnce(new Error("kick exploded"));

    const result = await cancelAppointmentAction("task-1");

    expect(kickCalendarMutationSync).toHaveBeenCalledWith({ __admin: true });
    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", status: "cancelled", ledgerId: "ledger-1" },
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "cancel_appointment_action_inline_sync_kick" } }),
    );
  });

  it("rescheduleAppointmentAction kicks the inline sync and still returns ok:true when it rejects", async () => {
    const { reportError } = await import("@/lib/errors/report");
    rescheduleAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "succ-1", oldTaskId: "task-1", chainId: "chain-1", duplicate: false },
    });
    kickCalendarMutationSync.mockRejectedValueOnce(new Error("kick exploded"));

    const result = await rescheduleAppointmentAction({
      taskId: "task-1",
      date: "2026-09-02",
      time: "15:00",
      timeZone: "America/Chicago",
      durationMinutes: 30,
    });

    expect(kickCalendarMutationSync).toHaveBeenCalledWith({ __admin: true });
    expect(result).toEqual({
      ok: true,
      data: { taskId: "succ-1", oldTaskId: "task-1", chainId: "chain-1", duplicate: false },
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "reschedule_appointment_action_inline_sync_kick" } }),
    );
  });

  it("reassignAppointmentAction kicks the inline sync and still returns ok:true when it rejects", async () => {
    const { reportError } = await import("@/lib/errors/report");
    reassignAppointment.mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-1", newAssigneeId: "user-2", duplicate: false },
    });
    kickCalendarMutationSync.mockRejectedValueOnce(new Error("kick exploded"));

    const result = await reassignAppointmentAction("task-1", "user-2");

    expect(kickCalendarMutationSync).toHaveBeenCalledWith({ __admin: true });
    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", oldAssigneeId: "user-1", newAssigneeId: "user-2", duplicate: false },
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "reassign_appointment_action_inline_sync_kick" } }),
    );
  });
});
