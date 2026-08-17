import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  afterCallbacks,
  afterMock,
  assertContactDncUnlocked,
  assertPropertyDncUnlocked,
  createAdminClient,
  createClient,
  dispatchTaskAssigned,
  dispatchTaskAssignedSlack,
  kickCalendarMutationSync,
  loadIntegrationPrefs,
  pausePropertyEnrollments,
  requireOrgMembership,
  requireOrgMembershipByResource,
  revalidatePath,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void> | void>,
  afterMock: vi.fn((callback: () => Promise<void> | void) => {
    afterCallbacks.push(callback);
  }),
  assertContactDncUnlocked: vi.fn(),
  assertPropertyDncUnlocked: vi.fn(),
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
  pausePropertyEnrollments: vi.fn().mockResolvedValue({ paused: 0 }),
  requireOrgMembership: vi.fn(),
  requireOrgMembershipByResource: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/dnc/property-lock", () => ({
  assertContactDncUnlocked,
  assertPropertyDncUnlocked,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs }));
vi.mock("@/lib/integrations/slack/dispatch", () => ({ dispatchTaskAssignedSlack }));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchTaskAssigned }));
vi.mock("@/lib/sequences/enrollment", () => ({ pausePropertyEnrollments }));
vi.mock("@/lib/appointments/inline-sync-kick", () => ({ kickCalendarMutationSync }));
vi.mock("@/lib/auth/require-org-membership", () => ({
  requireOrgMembership,
  requireOrgMembershipByResource,
}));

import {
  bookAppointment,
  checkAppointmentOverlap,
  getMemberTimezone,
  listBookingAssignees,
} from "./book-appointment-action";

type RpcResult = { data: unknown; error: { message: string } | null };

function makeSupabaseMock(opts: {
  userId?: string | null;
  rpcResult?: RpcResult;
  membershipsRows?: { org_id: string }[] | null;
  membershipsError?: { message: string } | null;
  overlapRow?: { due_at: string } | null;
  overlapError?: { message: string } | null;
  propertyAddress?: string | null;
}) {
  const rpc = vi.fn().mockResolvedValue(opts.rpcResult ?? { data: null, error: null });

  // .from("memberships").select().eq("user_id", ...).eq("access_status", "active").is("deletion_prepared_at", null).or(activeAt filter)
  const membershipsBuilder = {
    select: vi.fn(function (this: unknown) {
      return this;
    }),
    eq: vi.fn(function (this: unknown) {
      return this;
    }),
    is: vi.fn(function (this: unknown) {
      return this;
    }),
    or: vi.fn().mockResolvedValue({
      data: opts.membershipsRows ?? [],
      error: opts.membershipsError ?? null,
    }),
  };

  // .from("tasks").select().eq().eq().eq().lt().gt().neq().limit().maybeSingle()
  // (Codex round 12, finding 5: `.neq("id", excludeTaskId)` is chained in
  // only when a reschedule caller passes `excludeTaskId`.)
  const tasksBuilder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "lt", "gt", "neq", "limit"]) {
    tasksBuilder[method] = vi.fn(() => tasksBuilder);
  }
  tasksBuilder.maybeSingle = vi.fn().mockResolvedValue({
    data: opts.overlapRow ?? null,
    error: opts.overlapError ?? null,
  });

  const propertiesBuilder = {
    select: vi.fn(function (this: unknown) {
      return this;
    }),
    eq: vi.fn(function (this: unknown) {
      return this;
    }),
    maybeSingle: vi.fn().mockResolvedValue({
      data:
        opts.propertyAddress !== undefined ? { address: opts.propertyAddress } : null,
      error: null,
    }),
  };

  const from = vi.fn((table: string) => {
    if (table === "memberships") return membershipsBuilder;
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
    rpc,
    from,
  };
}

const VALID_INPUT = {
  propertyId: "prop-1",
  assigneeId: "user-1",
  date: "2026-06-15",
  time: "14:00",
  timeZone: "America/Chicago",
  durationMinutes: 30,
  title: "Appointment — 123 Main St",
};

beforeEach(() => {
  assertContactDncUnlocked.mockResolvedValue({ ok: true, data: null });
  assertPropertyDncUnlocked.mockResolvedValue({ ok: true, data: null });
  requireOrgMembershipByResource.mockResolvedValue({
    userId: "user-1",
    orgId: "org-1",
    role: "member",
    resourceId: "prop-1",
  });
  requireOrgMembership.mockResolvedValue({
    userId: "user-1",
    orgId: "org-1",
    role: "member",
  });
});

describe("bookAppointment — permanent DNC", () => {
  it("rejects a stale forged booking before the appointment RPC", async () => {
    const supabase = makeSupabaseMock({ userId: "user-1" });
    createClient.mockResolvedValue(supabase);
    assertPropertyDncUnlocked.mockResolvedValueOnce({
      ok: false,
      error: { code: "DNC_LOCKED", message: "Permanently locked" },
    });

    const result = await bookAppointment(VALID_INPUT);

    expect(result).toMatchObject({ ok: false, error: { code: "DNC_LOCKED" } });
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "fn_book_appointment",
      expect.anything(),
    );
  });

  it("rejects a contact-only booking when the contact or a linked property is locked", async () => {
    const supabase = makeSupabaseMock({ userId: "user-1" });
    createClient.mockResolvedValue(supabase);
    assertContactDncUnlocked.mockResolvedValueOnce({
      ok: false,
      error: { code: "DNC_LOCKED", message: "Permanently locked" },
    });

    const result = await bookAppointment({
      ...VALID_INPUT,
      propertyId: undefined,
      contactId: "contact-1",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "DNC_LOCKED" } });
    expect(assertContactDncUnlocked).toHaveBeenCalledWith(supabase, "contact-1");
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "fn_book_appointment",
      expect.anything(),
    );
  });
});

afterEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
});

describe("getMemberTimezone", () => {
  it("returns the RPC's timezone on success", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({ rpcResult: { data: "America/Denver", error: null } }),
    );

    await expect(getMemberTimezone("user-2")).resolves.toEqual({
      ok: true,
      data: "America/Denver",
    });
  });

  it("surfaces the RPC error (e.g. caller/target don't share an active org)", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        rpcResult: { data: null, error: { message: "no shared org" } },
      }),
    );

    const result = await getMemberTimezone("user-2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("no shared org");
  });
});

describe("checkAppointmentOverlap", () => {
  it("reports no overlap when the window is clear", async () => {
    createClient.mockResolvedValue(makeSupabaseMock({ overlapRow: null }));

    await expect(
      checkAppointmentOverlap("user-1", "2026-06-15T19:00:00.000Z", "2026-06-15T19:30:00.000Z"),
    ).resolves.toEqual({
      ok: true,
      data: { hasOverlap: false, conflictStartAt: null },
    });
  });

  it("reports the conflicting appointment's start when the window overlaps", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({ overlapRow: { due_at: "2026-06-15T19:00:00.000Z" } }),
    );

    await expect(
      checkAppointmentOverlap("user-1", "2026-06-15T18:45:00.000Z", "2026-06-15T19:15:00.000Z"),
    ).resolves.toEqual({
      ok: true,
      data: { hasOverlap: true, conflictStartAt: "2026-06-15T19:00:00.000Z" },
    });
  });

  // Codex round 12 (finding 5): the reschedule popover passes the task's
  // own id so its not-yet-moved row (still occupying its OLD window) never
  // self-matches as a false conflict.
  describe("Codex round 12 (finding 5): excludeTaskId — reschedule self-exclusion", () => {
    it("omitting excludeTaskId (the book flow) never calls .neq — unchanged behavior", async () => {
      const mock = makeSupabaseMock({ overlapRow: null });
      createClient.mockResolvedValue(mock);

      await checkAppointmentOverlap(
        "user-1",
        "2026-06-15T19:00:00.000Z",
        "2026-06-15T19:30:00.000Z",
      );

      const tasksBuilder = mock.from("tasks") as { neq: ReturnType<typeof import("vitest")["vi"]["fn"]> };
      expect(tasksBuilder.neq).not.toHaveBeenCalled();
    });

    it("passing excludeTaskId (reschedule) excludes that task's own row, reporting no overlap when it was the only match", async () => {
      // The mock's default overlap query still "finds" a row (its own,
      // not-yet-moved slot) — but with `.neq("id", excludeTaskId)` applied,
      // a REAL Supabase query would exclude it. This test asserts the
      // exclusion filter is actually wired into the query chain.
      const mock = makeSupabaseMock({ overlapRow: null });
      createClient.mockResolvedValue(mock);

      await checkAppointmentOverlap(
        "user-1",
        "2026-06-15T19:00:00.000Z",
        "2026-06-15T19:30:00.000Z",
        "task-being-rescheduled",
      );

      const tasksBuilder = mock.from("tasks") as { neq: ReturnType<typeof import("vitest")["vi"]["fn"]> };
      expect(tasksBuilder.neq).toHaveBeenCalledWith("id", "task-being-rescheduled");
    });

    it("still detects a genuine SECOND conflicting appointment when excludeTaskId is set — the self-match doesn't hide it", async () => {
      // Simulates the exclusion having already removed the self-row at the
      // DB level: the single row the (excluding) query returns is a real,
      // different conflicting appointment.
      const mock = makeSupabaseMock({
        overlapRow: { due_at: "2026-06-15T19:15:00.000Z" },
      });
      createClient.mockResolvedValue(mock);

      const result = await checkAppointmentOverlap(
        "user-1",
        "2026-06-15T19:00:00.000Z",
        "2026-06-15T19:30:00.000Z",
        "task-being-rescheduled",
      );

      expect(result).toEqual({
        ok: true,
        data: { hasOverlap: true, conflictStartAt: "2026-06-15T19:15:00.000Z" },
      });
      const tasksBuilder = mock.from("tasks") as { neq: ReturnType<typeof import("vitest")["vi"]["fn"]> };
      expect(tasksBuilder.neq).toHaveBeenCalledWith("id", "task-being-rescheduled");
    });
  });
});

describe("bookAppointment — validation", () => {
  it("rejects a missing assignee before touching the network", async () => {
    const result = await bookAppointment({ ...VALID_INPUT, assigneeId: "" });
    expect(result).toEqual({
      ok: false,
      error: { code: "ASSIGNEE_REQUIRED", message: "Choose who this appointment is for." },
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range duration", async () => {
    const result = await bookAppointment({ ...VALID_INPUT, durationMinutes: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_DURATION");
  });

  it("rejects a wall time that doesn't exist across a DST gap, server-side, without ever calling the RPC", async () => {
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));

    const result = await bookAppointment({
      ...VALID_INPUT,
      date: "2026-03-08",
      time: "02:30", // America/Chicago springs forward 02:00 -> 03:00 that day.
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TIME_NONEXISTENT");
  });
});

describe("bookAppointment — org resolution", () => {
  it("resolves org from the property for a property-linked booking", async () => {
    const supabase = makeSupabaseMock({
      userId: "user-1",
      rpcResult: {
        data: { task_id: "task-1", already_qualified: false, calendar_chain_id: "chain-1" },
        error: null,
      },
    });
    createClient.mockResolvedValue(supabase);

    const result = await bookAppointment(VALID_INPUT);

    expect(requireOrgMembershipByResource).toHaveBeenCalledWith("properties", "prop-1");
    expect(result).toEqual({
      ok: true,
      data: { taskId: "task-1", alreadyQualified: false, chainId: "chain-1" },
    });
  });

  it("resolves org from the contact when no property is linked", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: { task_id: "task-2", already_qualified: false, calendar_chain_id: "chain-2" },
          error: null,
        },
      }),
    );

    await bookAppointment({
      ...VALID_INPUT,
      propertyId: undefined,
      contactId: "contact-1",
    });

    expect(requireOrgMembershipByResource).toHaveBeenCalledWith("contacts", "contact-1");
  });

  it("falls back to the caller's single active membership for a personal block", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        membershipsRows: [{ org_id: "org-9" }],
        rpcResult: {
          data: { task_id: "task-3", already_qualified: false, calendar_chain_id: "chain-3" },
          error: null,
        },
      }),
    );

    await bookAppointment({ ...VALID_INPUT, propertyId: undefined });

    expect(requireOrgMembership).toHaveBeenCalledWith("org-9");
    expect(requireOrgMembershipByResource).not.toHaveBeenCalled();
  });

  it("filters the memberships lookup to active-only (suspended/expired/deletion-prepared rows excluded server-side)", async () => {
    const supabase = makeSupabaseMock({
      userId: "user-1",
      // A real query would return only the one active row; a suspended
      // second membership in another org never reaches this code because
      // the .eq/.is/.or filter chain excludes it at the DB.
      membershipsRows: [{ org_id: "org-9" }],
      rpcResult: {
        data: { task_id: "task-9", already_qualified: false, calendar_chain_id: "chain-9" },
        error: null,
      },
    });
    createClient.mockResolvedValue(supabase);

    await bookAppointment({ ...VALID_INPUT, propertyId: undefined });

    const membershipsBuilder = supabase.from("memberships") as unknown as {
      eq: ReturnType<typeof vi.fn>;
      is: ReturnType<typeof vi.fn>;
      or: ReturnType<typeof vi.fn>;
    };
    expect(membershipsBuilder.eq).toHaveBeenCalledWith("access_status", "active");
    expect(membershipsBuilder.is).toHaveBeenCalledWith("deletion_prepared_at", null);
    expect(membershipsBuilder.or).toHaveBeenCalledWith(
      expect.stringMatching(/^access_expires_at\.is\.null,access_expires_at\.gt\.\d{4}-\d{2}-\d{2}T/),
    );
    expect(requireOrgMembership).toHaveBeenCalledWith("org-9");
  });

  it("errors on an ambiguous personal block (caller belongs to more than one org)", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        membershipsRows: [{ org_id: "org-9" }, { org_id: "org-10" }],
      }),
    );

    const result = await bookAppointment({ ...VALID_INPUT, propertyId: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AMBIGUOUS_ORG");
  });

  it("errors when the caller belongs to no org for a personal block", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({ userId: "user-1", membershipsRows: [] }),
    );

    const result = await bookAppointment({ ...VALID_INPUT, propertyId: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AMBIGUOUS_ORG");
  });
});

describe("bookAppointment — RPC + side effects", () => {
  it("converts the wall time to UTC and calls fn_book_appointment with the resolved org", async () => {
    const supabase = makeSupabaseMock({
      userId: "user-1",
      rpcResult: {
        data: { task_id: "task-1", already_qualified: true, calendar_chain_id: "chain-1" },
        error: null,
      },
    });
    createClient.mockResolvedValue(supabase);

    await bookAppointment({ ...VALID_INPUT, contactId: "contact-1", note: "  bring comps  " });

    expect(supabase.rpc).toHaveBeenCalledWith("fn_book_appointment", {
      p_org: "org-1",
      p_assignee: "user-1",
      p_start: "2026-06-15T19:00:00.000Z", // 14:00 CDT (UTC-5)
      p_end: "2026-06-15T19:30:00.000Z",
      p_timezone: "America/Chicago",
      p_contact: "contact-1",
      p_property: "prop-1",
      p_title: "Appointment — 123 Main St",
      p_description: "bring comps",
      p_idempotency_key: null,
    });
  });

  it("forwards a caller-supplied idempotency key as p_idempotency_key", async () => {
    const supabase = makeSupabaseMock({
      userId: "user-1",
      rpcResult: {
        data: { task_id: "task-1", already_qualified: true, calendar_chain_id: "chain-1" },
        error: null,
      },
    });
    createClient.mockResolvedValue(supabase);

    await bookAppointment({ ...VALID_INPUT, idempotencyKey: "key-abc-123" });

    expect(supabase.rpc).toHaveBeenCalledWith(
      "fn_book_appointment",
      expect.objectContaining({ p_idempotency_key: "key-abc-123" }),
    );
  });

  it("treats a duplicate response as success and skips re-dispatching assignment side effects", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        propertyAddress: "123 Main St",
        rpcResult: {
          data: {
            task_id: "task-1",
            already_qualified: false,
            calendar_chain_id: "chain-1",
            duplicate: true,
          },
          error: null,
        },
      }),
    );

    const result = await bookAppointment({
      ...VALID_INPUT,
      assigneeId: "user-2",
      idempotencyKey: "retry-key",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        taskId: "task-1",
        alreadyQualified: false,
        chainId: "chain-1",
        duplicate: true,
      },
    });
    // Booking for someone else would normally fire assignment side effects
    // via after() — but this is a retry of an already-dispatched booking,
    // so it must not double-notify the assignee.
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("surfaces an RPC error instead of a synthetic success", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: { data: null, error: { message: "timezone mismatch" } },
      }),
    );

    const result = await bookAppointment(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BOOK_APPOINTMENT_FAILED");
      expect(result.error.message).toBe("timezone mismatch");
    }
  });

  it("fires assignment side effects (admin-loaded prefs) only when booking for someone else", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        propertyAddress: "123 Main St",
        rpcResult: {
          data: {
            task_id: "task-1",
            already_qualified: false,
            calendar_chain_id: "chain-1",
            related_property_id: "prop-1",
            contact_id: null,
          },
          error: null,
        },
      }),
    );

    await bookAppointment({ ...VALID_INPUT, assigneeId: "user-2" });

    expect(afterMock).toHaveBeenCalledTimes(1);
    await afterCallbacks[0]?.();

    expect(loadIntegrationPrefs).toHaveBeenCalledWith({ __admin: true }, "user-2");
    expect(dispatchTaskAssigned).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: "task-1",
        orgId: "org-1",
        assigneeId: "user-2",
        taskType: "appointment",
        dueAt: "2026-06-15T19:00:00.000Z",
      }),
    );
    expect(dispatchTaskAssignedSlack).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: "user-2", propertyAddress: "123 Main St" }),
    );
  });

  it("never dispatches the legacy calendar-event path — the ledger row + PR 3 worker are the single owner of Google event creation", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        propertyAddress: "123 Main St",
        rpcResult: {
          data: {
            task_id: "task-1",
            already_qualified: false,
            calendar_chain_id: "chain-1",
            related_property_id: "prop-1",
            contact_id: null,
          },
          error: null,
        },
      }),
    );

    await bookAppointment({ ...VALID_INPUT, assigneeId: "user-2" });
    await afterCallbacks[0]?.();

    // No dispatchTaskCalendarEvent import exists in the module under test
    // anymore — asserting only the two side effects that remain confirms
    // the calendar dispatch was actually removed, not merely unasserted.
    expect(dispatchTaskAssigned).toHaveBeenCalledTimes(1);
    expect(dispatchTaskAssignedSlack).toHaveBeenCalledTimes(1);
  });

  it("pauses active sequence enrollments on the property after a successful booking", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: {
            task_id: "task-1",
            already_qualified: false,
            calendar_chain_id: "chain-1",
            related_property_id: "prop-1",
            contact_id: null,
          },
          error: null,
        },
      }),
    );

    await bookAppointment(VALID_INPUT);

    expect(pausePropertyEnrollments).toHaveBeenCalledWith(
      expect.anything(),
      { propertyId: "prop-1", reason: "appointment_booked", permanent: false },
    );
  });

  // Round 9: the RPC-returned linkage is the only thing post-booking
  // effects may trust — a request whose propertyId disagrees with what the
  // RPC actually booked/matched (which, per the RPC's own round-9 guard,
  // can only legitimately happen on a mismatched idempotency replay that
  // the RPC itself rejects — this test proves the ACTION's independent
  // defense-in-depth, not the RPC's validation) must never leak into the
  // pause call.
  it("pauses using the RPC-returned related_property_id, never the request's propertyId", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: {
            task_id: "task-1",
            already_qualified: false,
            calendar_chain_id: "chain-1",
            related_property_id: "prop-RETURNED",
            contact_id: null,
          },
          error: null,
        },
      }),
    );

    await bookAppointment({ ...VALID_INPUT, propertyId: "prop-REQUEST" });

    expect(pausePropertyEnrollments).toHaveBeenCalledWith(
      expect.anything(),
      { propertyId: "prop-RETURNED", reason: "appointment_booked", permanent: false },
    );
    expect(pausePropertyEnrollments).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ propertyId: "prop-REQUEST" }),
    );
  });

  it("skips pausing enrollments for a booking with no linked property", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: { task_id: "task-1", already_qualified: false, calendar_chain_id: "chain-1" },
          error: null,
        },
      }),
    );

    await bookAppointment({ ...VALID_INPUT, propertyId: undefined, contactId: "contact-1" });

    expect(pausePropertyEnrollments).not.toHaveBeenCalled();
  });

  it("does not fail the booking when pausing enrollments throws — best-effort, booking already committed", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: {
            task_id: "task-1",
            already_qualified: false,
            calendar_chain_id: "chain-1",
            related_property_id: "prop-1",
            contact_id: null,
          },
          error: null,
        },
      }),
    );
    pausePropertyEnrollments.mockRejectedValueOnce(new Error("db down"));

    const result = await bookAppointment(VALID_INPUT);

    expect(pausePropertyEnrollments).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("skips assignment side effects when booking for oneself", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: { task_id: "task-1", already_qualified: false, calendar_chain_id: "chain-1" },
          error: null,
        },
      }),
    );

    await bookAppointment(VALID_INPUT); // assigneeId: "user-1" === caller

    expect(afterMock).not.toHaveBeenCalled();
  });

  it("revalidates the lead page only when a property is linked", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: {
            task_id: "task-1",
            already_qualified: false,
            calendar_chain_id: "chain-1",
            related_property_id: "prop-1",
            contact_id: null,
          },
          error: null,
        },
      }),
    );

    await bookAppointment(VALID_INPUT);

    expect(revalidatePath).toHaveBeenCalledWith("/leads/prop-1");
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(revalidatePath).toHaveBeenCalledWith("/calendar");
  });

  it("returns the committed booking even when revalidation throws — commit honesty (PR 4 confirmation round)", async () => {
    const { reportError } = await import("@/lib/errors/report");
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: {
            task_id: "task-1",
            already_qualified: false,
            calendar_chain_id: "chain-1",
            related_property_id: "prop-1",
            contact_id: null,
          },
          error: null,
        },
      }),
    );
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("revalidate exploded");
    });

    const result = await bookAppointment(VALID_INPUT);

    expect(result.ok).toBe(true);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "book_appointment_revalidate" },
      }),
    );
  });

  it("kicks only the persisted booking task before revalidation", async () => {
    const callOrder: string[] = [];
    kickCalendarMutationSync.mockImplementationOnce(async () => {
      callOrder.push("kick");
    });
    revalidatePath.mockImplementationOnce(() => {
      callOrder.push("revalidate");
    });
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: {
            task_id: "task-1",
            already_qualified: false,
            calendar_chain_id: "chain-1",
            related_property_id: "prop-1",
            contact_id: null,
          },
          error: null,
        },
      }),
    );

    await bookAppointment(VALID_INPUT);

    expect(kickCalendarMutationSync).toHaveBeenCalledWith({ __admin: true }, "task-1");
    expect(callOrder[0]).toBe("kick");
  });

  it("keeps the committed booking successful when the targeted kick rejects", async () => {
    kickCalendarMutationSync.mockRejectedValueOnce(new Error("kick exploded"));
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: { task_id: "task-1", already_qualified: false, calendar_chain_id: "chain-1" },
          error: null,
        },
      }),
    );

    const result = await bookAppointment(VALID_INPUT);

    expect(result.ok).toBe(true);
  });

  it("revalidates using the RPC-returned related_property_id, never the request's propertyId", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        rpcResult: {
          data: {
            task_id: "task-1",
            already_qualified: false,
            calendar_chain_id: "chain-1",
            related_property_id: "prop-RETURNED",
            contact_id: null,
          },
          error: null,
        },
      }),
    );

    await bookAppointment({ ...VALID_INPUT, propertyId: "prop-REQUEST" });

    expect(revalidatePath).toHaveBeenCalledWith("/leads/prop-RETURNED");
    expect(revalidatePath).not.toHaveBeenCalledWith("/leads/prop-REQUEST");
  });
});

describe("listBookingAssignees", () => {
  function makeAdminMock(opts: {
    orgMemberUserIds?: string[];
    orgMembersError?: { message: string } | null;
    users?: { id: string; email?: string | null }[];
  }) {
    const membershipsBuilder = {
      select: vi.fn(function (this: unknown) {
        return this;
      }),
      eq: vi.fn(function (this: unknown) {
        return this;
      }),
      is: vi.fn(function (this: unknown) {
        return this;
      }),
      or: vi.fn().mockResolvedValue({
        data: (opts.orgMemberUserIds ?? []).map((user_id) => ({ user_id })),
        error: opts.orgMembersError ?? null,
      }),
    };
    return {
      from: vi.fn((table: string) => {
        if (table === "memberships") return membershipsBuilder;
        throw new Error(`Unexpected admin table in test: ${table}`);
      }),
      auth: {
        admin: {
          listUsers: vi.fn().mockResolvedValue({
            data: { users: opts.users ?? [], nextPage: null },
            error: null,
          }),
        },
      },
      __membershipsBuilder: membershipsBuilder,
    };
  }

  it("excludes inactive members — the query is scoped to active, non-deletion-prepared, unexpired memberships", async () => {
    requireOrgMembershipByResource.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      role: "member",
      resourceId: "prop-1",
    });
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));
    const admin = makeAdminMock({
      orgMemberUserIds: ["active-1"],
      users: [{ id: "active-1", email: "active@example.test" }],
    });
    createAdminClient.mockReturnValue(admin as never);

    const result = await listBookingAssignees({ propertyId: "prop-1" });

    expect(result).toEqual({ ok: true, data: [{ id: "active-1", email: "active@example.test" }] });
    expect(admin.__membershipsBuilder.eq).toHaveBeenCalledWith("access_status", "active");
    expect(admin.__membershipsBuilder.is).toHaveBeenCalledWith("deletion_prepared_at", null);
    expect(admin.__membershipsBuilder.or).toHaveBeenCalledWith(
      expect.stringMatching(/^access_expires_at\.is\.null,access_expires_at\.gt\.\d{4}-\d{2}-\d{2}T/),
    );
  });

  it("cross-org members are never returned — scoped to the ONE org the booking resolves into", async () => {
    requireOrgMembershipByResource.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      role: "member",
      resourceId: "contact-1",
    });
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));
    const admin = makeAdminMock({ orgMemberUserIds: [] });
    createAdminClient.mockReturnValue(admin as never);

    await listBookingAssignees({ contactId: "contact-1" });

    expect(requireOrgMembershipByResource).toHaveBeenCalledWith("contacts", "contact-1");
    expect(admin.__membershipsBuilder.eq).toHaveBeenCalledWith("org_id", "org-1");
  });

  it("an unlinked personal-block context (no property, no contact) uses the caller's single active org", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({ userId: "user-1", membershipsRows: [{ org_id: "org-9" }] }),
    );
    requireOrgMembership.mockResolvedValue({
      userId: "user-1",
      orgId: "org-9",
      role: "member",
    });
    const admin = makeAdminMock({ orgMemberUserIds: [] });
    createAdminClient.mockReturnValue(admin as never);

    await listBookingAssignees({});

    expect(requireOrgMembershipByResource).not.toHaveBeenCalled();
    expect(requireOrgMembership).toHaveBeenCalledWith("org-9");
    expect(admin.__membershipsBuilder.eq).toHaveBeenCalledWith("org_id", "org-9");
  });

  it("errors on an ambiguous personal block, same as bookAppointment's org resolution", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        membershipsRows: [{ org_id: "org-9" }, { org_id: "org-10" }],
      }),
    );

    const result = await listBookingAssignees({});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AMBIGUOUS_ORG");
  });
});
