import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget: vi.fn().mockResolvedValue(undefined) }));

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
  recordLeadEvents,
  requireOrgMembership,
  requireOrgMembershipByResource,
  revalidatePath,
  schemaReady,
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
  recordLeadEvents: vi.fn().mockResolvedValue(undefined),
  requireOrgMembership: vi.fn(),
  requireOrgMembershipByResource: vi.fn(),
  revalidatePath: vi.fn(),
  schemaReady: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady }));
vi.mock("@/lib/dnc/property-lock", () => ({
  assertContactDncUnlocked,
  assertPropertyDncUnlocked,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs }));
vi.mock("@/lib/integrations/slack/dispatch", () => ({
  dispatchTaskAssignedSlack,
}));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchTaskAssigned }));
vi.mock("@/lib/sequences/enrollment", () => ({ pausePropertyEnrollments }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: {
    APPOINTMENT_BOOKED: "appointment_booked",
    QUALIFIED: "qualified",
  },
  recordLeadEvents,
}));
vi.mock("@/lib/appointments/inline-sync-kick", () => ({
  kickCalendarMutationSync,
}));
vi.mock("@/lib/auth/require-org-membership", () => ({
  requireOrgMembership,
  requireOrgMembershipByResource,
}));

import {
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
  const rpc = vi
    .fn()
    .mockResolvedValue(opts.rpcResult ?? { data: null, error: null });

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
        opts.propertyAddress !== undefined
          ? { address: opts.propertyAddress }
          : null,
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

beforeEach(() => {
  schemaReady.mockReset();
  schemaReady.mockResolvedValue(false);
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
      checkAppointmentOverlap(
        "user-1",
        "2026-06-15T19:00:00.000Z",
        "2026-06-15T19:30:00.000Z",
      ),
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
      checkAppointmentOverlap(
        "user-1",
        "2026-06-15T18:45:00.000Z",
        "2026-06-15T19:15:00.000Z",
      ),
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

      const tasksBuilder = mock.from("tasks") as {
        neq: ReturnType<(typeof import("vitest"))["vi"]["fn"]>;
      };
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

      const tasksBuilder = mock.from("tasks") as {
        neq: ReturnType<(typeof import("vitest"))["vi"]["fn"]>;
      };
      expect(tasksBuilder.neq).toHaveBeenCalledWith(
        "id",
        "task-being-rescheduled",
      );
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
      const tasksBuilder = mock.from("tasks") as {
        neq: ReturnType<(typeof import("vitest"))["vi"]["fn"]>;
      };
      expect(tasksBuilder.neq).toHaveBeenCalledWith(
        "id",
        "task-being-rescheduled",
      );
    });
  });
});

describe("listBookingAssignees", () => {
  function makeAdminMock(opts: {
    orgMembers?: Array<{
      user_id: string;
      access_status?: string | null;
      access_expires_at?: string | null;
      deletion_prepared_at?: string | null;
    }>;
    orgMembersError?: { message: string } | null;
    users?: {
      id: string;
      email?: string | null;
      app_metadata?: Record<string, unknown>;
      user_metadata?: Record<string, unknown>;
    }[];
  }) {
    const membershipsBuilder = {
      select: vi.fn(function (this: unknown) {
        return this;
      }),
      eq: vi.fn(function (this: unknown) {
        return this;
      }),
      order: vi.fn(function (this: unknown) {
        return this;
      }),
      limit: vi.fn().mockResolvedValue({
        data: opts.orgMembers ?? [],
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

  it("returns only active members with authoritative names", async () => {
    requireOrgMembershipByResource.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      role: "member",
      resourceId: "prop-1",
    });
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));
    const admin = makeAdminMock({
      orgMembers: [
        { user_id: "active-1", access_status: "active" },
        { user_id: "suspended-1", access_status: "suspended" },
        {
          user_id: "expired-1",
          access_status: "active",
          access_expires_at: "2020-01-01T00:00:00.000Z",
        },
        {
          user_id: "prepared-1",
          access_status: "active",
          deletion_prepared_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      users: [
        {
          id: "active-1",
          email: "active@example.test",
          app_metadata: { display_name: "Avery Agent" },
          user_metadata: { display_name: "User Editable" },
        },
      ],
    });
    createAdminClient.mockReturnValue(admin as never);

    const result = await listBookingAssignees({ propertyId: "prop-1" });

    expect(result).toEqual({
      ok: true,
      data: [
        {
          id: "active-1",
          email: "active@example.test",
          displayName: "Avery Agent",
          isActive: true,
        },
      ],
    });
    expect(admin.__membershipsBuilder.eq).toHaveBeenCalledWith(
      "org_id",
      "org-1",
    );
    expect(admin.__membershipsBuilder.limit).toHaveBeenCalledWith(401);
  });

  it("cross-org members are never returned — scoped to the ONE org the booking resolves into", async () => {
    requireOrgMembershipByResource.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      role: "member",
      resourceId: "contact-1",
    });
    createClient.mockResolvedValue(makeSupabaseMock({ userId: "user-1" }));
    const admin = makeAdminMock({ orgMembers: [] });
    createAdminClient.mockReturnValue(admin as never);

    await listBookingAssignees({ contactId: "contact-1" });

    expect(requireOrgMembershipByResource).toHaveBeenCalledWith(
      "contacts",
      "contact-1",
    );
    expect(admin.__membershipsBuilder.eq).toHaveBeenCalledWith(
      "org_id",
      "org-1",
    );
  });

  it("an unlinked personal-block context (no property, no contact) uses the caller's single active org", async () => {
    createClient.mockResolvedValue(
      makeSupabaseMock({
        userId: "user-1",
        membershipsRows: [{ org_id: "org-9" }],
      }),
    );
    requireOrgMembership.mockResolvedValue({
      userId: "user-1",
      orgId: "org-9",
      role: "member",
    });
    const admin = makeAdminMock({ orgMembers: [] });
    createAdminClient.mockReturnValue(admin as never);

    await listBookingAssignees({});

    expect(requireOrgMembershipByResource).not.toHaveBeenCalled();
    expect(requireOrgMembership).toHaveBeenCalledWith("org-9");
    expect(admin.__membershipsBuilder.eq).toHaveBeenCalledWith(
      "org_id",
      "org-9",
    );
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
