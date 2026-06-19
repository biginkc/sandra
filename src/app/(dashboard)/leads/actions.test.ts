import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  afterCallbacks,
  afterMock,
  createAdminClient,
  createClient,
  createTask,
  dispatchTaskAssigned,
  dispatchTaskAssignedSlack,
  dispatchTaskCalendarEvent,
  loadIntegrationPrefs,
  revalidatePath,
} = vi.hoisted(() => ({
    afterCallbacks: [] as Array<() => Promise<void> | void>,
    afterMock: vi.fn((callback: () => Promise<void> | void) => {
      afterCallbacks.push(callback);
    }),
    createAdminClient: vi.fn(),
    createClient: vi.fn(),
    createTask: vi.fn(),
    dispatchTaskAssigned: vi.fn(),
    dispatchTaskAssignedSlack: vi.fn(),
    dispatchTaskCalendarEvent: vi.fn(),
    loadIntegrationPrefs: vi.fn(async () => ({
      slackEnabled: false,
      calendarEnabled: false,
      timezone: "America/Chicago",
    })),
    revalidatePath: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("next/server", () => ({
  after: afterMock,
}));

vi.mock("@/lib/integrations/google/dispatch", () => ({
  dispatchTaskCalendarEvent,
}));

vi.mock("@/lib/integrations/prefs", () => ({
  loadIntegrationPrefs,
}));

vi.mock("@/lib/integrations/slack/dispatch", () => ({
  dispatchTaskAssignedSlack,
}));

vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchPropertyAssigned: vi.fn(),
  dispatchTaskAssigned,
}));

vi.mock("@/lib/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tasks")>();
  return {
    ...actual,
    createTask,
  };
});

import { addPropertiesToListBulk, createLeadTaskAction, listOrgUsers } from "./actions";

type StubResult<T> = {
  data: T | null;
  error: { code?: string; message: string } | null;
};

type UpsertCapture = {
  rows: Array<{
    org_id: string;
    property_id: string;
    list_id: string;
    last_added_at: string;
    last_added_by: string | null;
  }>;
  options: { onConflict?: string; ignoreDuplicates?: boolean } | null;
};

function makeSupabase(opts: {
  lookupResult: StubResult<{ id: string; org_id: string }[]>;
  upsertResult: StubResult<null>;
  user: StubResult<{ user: { id: string } | null }>;
  capture: UpsertCapture;
}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue(opts.user),
    },
    from: vi.fn((table: string) => {
      if (table === "properties") {
        return {
          select: () => ({
            in: () => Promise.resolve(opts.lookupResult),
          }),
        };
      }
      if (table === "property_lists") {
        return {
          upsert: (
            rows: UpsertCapture["rows"],
            options: { onConflict?: string; ignoreDuplicates?: boolean },
          ) => {
            opts.capture.rows.push(...rows);
            opts.capture.options = options;
            return Promise.resolve(opts.upsertResult);
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

beforeEach(() => {
  afterCallbacks.length = 0;
  createClient.mockReset();
  createAdminClient.mockReset();
  createTask.mockReset();
  dispatchTaskAssigned.mockReset();
  dispatchTaskAssignedSlack.mockReset();
  dispatchTaskCalendarEvent.mockReset();
  loadIntegrationPrefs.mockClear();
  loadIntegrationPrefs.mockResolvedValue({
    slackEnabled: false,
    calendarEnabled: false,
    timezone: "America/Chicago",
  });
  revalidatePath.mockReset();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("addPropertiesToListBulk", () => {
  it("no-ops when the property id list is empty", async () => {
    const result = await addPropertiesToListBulk([], "list-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ succeeded: 0, skipped: 0, failed: [] });
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("upserts one row per property with matching org_id and list_id", async () => {
    const capture: UpsertCapture = { rows: [], options: null };
    createClient.mockResolvedValue(
      makeSupabase({
        lookupResult: {
          data: [
            { id: "p1", org_id: "org-1" },
            { id: "p2", org_id: "org-1" },
            { id: "p3", org_id: "org-1" },
          ],
          error: null,
        },
        upsertResult: { data: null, error: null },
        user: { data: { user: { id: "user-42" } }, error: null },
        capture,
      }),
    );

    const result = await addPropertiesToListBulk(
      ["p1", "p2", "p3"],
      "list-pkc",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.succeeded).toBe(3);
      expect(result.data.failed).toEqual([]);
    }

    expect(capture.rows).toHaveLength(3);
    expect(capture.rows.map((r) => r.property_id).sort()).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    for (const row of capture.rows) {
      expect(row.list_id).toBe("list-pkc");
      expect(row.org_id).toBe("org-1");
      expect(row.last_added_by).toBe("user-42");
      expect(typeof row.last_added_at).toBe("string");
    }
    expect(capture.options).toEqual({
      onConflict: "property_id,list_id",
      ignoreDuplicates: false,
    });
  });

  it("records ids the lookup did not return as failed entries", async () => {
    const capture: UpsertCapture = { rows: [], options: null };
    createClient.mockResolvedValue(
      makeSupabase({
        lookupResult: {
          data: [{ id: "p1", org_id: "org-1" }],
          error: null,
        },
        upsertResult: { data: null, error: null },
        user: { data: { user: null }, error: null },
        capture,
      }),
    );

    const result = await addPropertiesToListBulk(
      ["p1", "p-missing"],
      "list-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.succeeded).toBe(1);
      expect(result.data.failed).toEqual([
        { propertyId: "p-missing", message: "Property not found" },
      ]);
    }
    expect(capture.rows).toHaveLength(1);
    expect(capture.rows[0].last_added_by).toBeNull();
  });

  it("returns ADD_TO_LIST_FAILED when the lookup query errors", async () => {
    const capture: UpsertCapture = { rows: [], options: null };
    createClient.mockResolvedValue(
      makeSupabase({
        lookupResult: {
          data: null,
          error: { code: "42501", message: "permission denied" },
        },
        upsertResult: { data: null, error: null },
        user: { data: { user: { id: "u-1" } }, error: null },
        capture,
      }),
    );

    const result = await addPropertiesToListBulk(["p1"], "list-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ADD_TO_LIST_FAILED");
      expect(result.error.message).toMatch(/permission denied/);
    }
    expect(capture.rows).toHaveLength(0);
  });
});

describe("createLeadTaskAction", () => {
  it("rejects assignees who are not members of the lead org", async () => {
    createClient.mockResolvedValue(
      makeLeadTaskSupabase({
        property: { id: "prop-1", org_id: "org-1", address: "123 Main" },
        actorMembership: { user_id: "actor-1" },
      }),
    );
    createAdminClient.mockReturnValue(
      makeLeadTaskAdmin({ assigneeMembership: null }),
    );

    const result = await createLeadTaskAction("prop-1", {
      type: "follow_up",
      dueAt: "2026-06-20T15:00:00.000Z",
      assigneeId: "outside-user",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ASSIGNEE_NOT_IN_ORG");
    }
    expect(createTask).not.toHaveBeenCalled();
  });

  it("creates a lead task only after assignee membership is verified", async () => {
    createClient.mockResolvedValue(
      makeLeadTaskSupabase({
        property: { id: "prop-1", org_id: "org-1", address: "123 Main" },
        actorMembership: { user_id: "actor-1" },
      }),
    );
    createAdminClient.mockReturnValue(
      makeLeadTaskAdmin({ assigneeMembership: { user_id: "assignee-1" } }),
    );
    createTask.mockResolvedValue({
      ok: true,
      data: { id: "task-1", assignee_id: "assignee-1" },
    });

    const result = await createLeadTaskAction("prop-1", {
      type: "callback",
      dueAt: "2026-06-20T15:00:00.000Z",
      assigneeId: "assignee-1",
    });

    expect(result.ok).toBe(true);
    expect(createTask).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      assigneeId: "assignee-1",
      relatedPropertyId: "prop-1",
      type: "callback",
      title: "Callback 123 Main",
      dueAt: "2026-06-20T15:00:00.000Z",
      createdBy: "actor-1",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/leads/prop-1");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("fans out notifications for tasks assigned to a teammate", async () => {
    createClient.mockResolvedValue(
      makeLeadTaskSupabase({
        property: { id: "prop-1", org_id: "org-1", address: "123 Main" },
        actorMembership: { user_id: "actor-1" },
      }),
    );
    createAdminClient.mockReturnValue(
      makeLeadTaskAdmin({ assigneeMembership: { user_id: "assignee-1" } }),
    );
    createTask.mockResolvedValue({
      ok: true,
      data: { id: "task-1", assignee_id: "assignee-1" },
    });
    loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Denver",
    });

    const result = await createLeadTaskAction("prop-1", {
      type: "follow_up",
      dueAt: "2026-06-20T15:00:00.000Z",
      assigneeId: "assignee-1",
    });

    expect(result.ok).toBe(true);
    expect(afterMock).toHaveBeenCalledTimes(1);

    await flushAfterCallbacks();

    expect(dispatchTaskAssigned).toHaveBeenCalledWith(expect.anything(), {
      taskId: "task-1",
      orgId: "org-1",
      assigneeId: "assignee-1",
      taskTitle: "Follow up on 123 Main",
      taskType: "follow_up",
      dueAt: "2026-06-20T15:00:00.000Z",
      propertyAddress: "123 Main",
    });
    expect(dispatchTaskAssignedSlack).toHaveBeenCalledWith({
      taskId: "task-1",
      assigneeId: "assignee-1",
      taskTitle: "Follow up on 123 Main",
      taskType: "follow_up",
      dueAt: "2026-06-20T15:00:00.000Z",
      propertyAddress: "123 Main",
      deepLink: "https://app.test/leads/prop-1",
      timezone: "America/Denver",
      slackEnabled: true,
    });
    expect(dispatchTaskCalendarEvent).toHaveBeenCalledWith({
      taskId: "task-1",
      assigneeId: "assignee-1",
      taskTitle: "Follow up on 123 Main",
      propertyAddress: "123 Main",
      dueAt: "2026-06-20T15:00:00.000Z",
      timezone: "America/Denver",
      deepLink: "https://app.test/leads/prop-1",
      calendarEnabled: true,
    });
  });

  it("does not schedule notification fan-out for self-assigned tasks", async () => {
    createClient.mockResolvedValue(
      makeLeadTaskSupabase({
        property: { id: "prop-1", org_id: "org-1", address: "123 Main" },
        actorMembership: { user_id: "actor-1" },
      }),
    );
    createAdminClient.mockReturnValue(
      makeLeadTaskAdmin({ assigneeMembership: { user_id: "actor-1" } }),
    );
    createTask.mockResolvedValue({
      ok: true,
      data: { id: "task-1", assignee_id: "actor-1" },
    });

    const result = await createLeadTaskAction("prop-1", {
      type: "callback",
      dueAt: "2026-06-20T15:00:00.000Z",
      assigneeId: "actor-1",
    });

    expect(result.ok).toBe(true);
    expect(afterMock).not.toHaveBeenCalled();
    expect(dispatchTaskAssigned).not.toHaveBeenCalled();
    expect(dispatchTaskAssignedSlack).not.toHaveBeenCalled();
    expect(dispatchTaskCalendarEvent).not.toHaveBeenCalled();
  });
});

describe("listOrgUsers", () => {
  it("returns only auth users who belong to the caller's orgs", async () => {
    createClient.mockResolvedValue(makeListUsersSupabase());
    createAdminClient.mockReturnValue(
      makeListUsersAdmin([
        {
          data: {
            users: [
              { id: "member-2", email: "z@example.test" },
              { id: "outside", email: "outside@example.test" },
            ],
            nextPage: 2,
          },
          error: null,
        },
        {
          data: {
            users: [{ id: "member-1", email: "a@example.test" }],
            nextPage: null,
          },
          error: null,
        },
      ]),
    );

    const result = await listOrgUsers();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        { id: "member-1", email: "a@example.test" },
        { id: "member-2", email: "z@example.test" },
      ]);
    }
  });
});

function makeLeadTaskSupabase(opts: {
  property: { id: string; org_id: string; address: string } | null;
  actorMembership: { user_id: string } | null;
}) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: "actor-1" } },
      })),
    },
    from: vi.fn((table: string) => {
      if (table === "properties") {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({
            data: opts.property,
            error: null,
          })),
        };
        return builder;
      }
      if (table === "memberships") {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({
            data: opts.actorMembership,
            error: null,
          })),
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

function makeLeadTaskAdmin(opts: {
  assigneeMembership: { user_id: string } | null;
}) {
  return {
    from: vi.fn((table: string) => {
      if (table !== "memberships") throw new Error(`unexpected table ${table}`);
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn(async () => ({
          data: opts.assigneeMembership,
          error: null,
        })),
      };
      return builder;
    }),
  };
}

function makeListUsersSupabase() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: "actor-1" } },
      })),
    },
    from: vi.fn((table: string) => {
      if (table !== "memberships") throw new Error(`unexpected table ${table}`);
      return {
        select: vi.fn(() => ({
          eq: vi.fn(async () => ({
            data: [{ org_id: "org-1" }],
            error: null,
          })),
        })),
      };
    }),
  };
}

function makeListUsersAdmin(
  userPages: Array<{
    data: { users: Array<{ id: string; email: string }>; nextPage: number | null };
    error: null;
  }>,
) {
  const listUsers = vi.fn(async () => userPages.shift()!);
  return {
    from: vi.fn((table: string) => {
      if (table !== "memberships") throw new Error(`unexpected table ${table}`);
      return {
        select: vi.fn(() => ({
          in: vi.fn(async () => ({
            data: [{ user_id: "member-1" }, { user_id: "member-2" }],
            error: null,
          })),
        })),
      };
    }),
    auth: {
      admin: { listUsers },
    },
  };
}

async function flushAfterCallbacks() {
  const callbacks = [...afterCallbacks];
  afterCallbacks.length = 0;
  await Promise.all(callbacks.map((callback) => callback()));
}
