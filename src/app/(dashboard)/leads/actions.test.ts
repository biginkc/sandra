import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  afterCallbacks,
  afterMock,
  assertPropertyDncUnlocked,
  createAdminClient,
  createClient,
  createTask,
  dispatchTaskAssigned,
  dispatchTaskAssignedSlack,
  dispatchTaskCalendarEvent,
  loadIntegrationPrefs,
  revalidatePath,
  validateActiveAssigneeForProperties,
} = vi.hoisted(() => ({
    afterCallbacks: [] as Array<() => Promise<void> | void>,
    afterMock: vi.fn((callback: () => Promise<void> | void) => {
      afterCallbacks.push(callback);
    }),
    assertPropertyDncUnlocked: vi.fn(),
    createAdminClient: vi.fn(),
    createClient: vi.fn(),
    createTask: vi.fn(),
    dispatchTaskAssigned: vi.fn(),
    dispatchTaskAssignedSlack: vi.fn(),
    dispatchTaskCalendarEvent: vi.fn(),
    loadIntegrationPrefs: vi.fn(async (_client?: unknown, _userId?: string) => ({
      slackEnabled: false,
      calendarEnabled: false,
      timezone: "America/Chicago",
    })),
    revalidatePath: vi.fn(),
    validateActiveAssigneeForProperties: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("@/lib/dnc/property-lock", () => ({
  assertPropertyDncUnlocked,
  DNC_LOCKED_MESSAGE: "This property is permanently locked Do Not Contact and is read-only.",
  partitionPropertyDncLocks: vi.fn(async (_client, ids: string[]) => ({
    ok: true,
    data: { unlocked: ids, locked: [], missing: [] },
  })),
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

vi.mock("./assignment-safety", () => ({ validateActiveAssigneeForProperties }));

import {
  addPropertiesToListBulk,
  assignLeadsBulk,
  createLeadTaskAction,
  getPropertyNeighbors,
  listOrgUsers,
  markMessagesReadForThread,
  updatePropertyStatus,
  updateLeadAssignee,
} from "./actions";

type NeighborFixture = {
  id: string;
  created_at: string;
  status: string;
  is_dnc_locked: boolean;
  deleted_at: string | null;
};

function makeNeighborClient(fixtures: NeighborFixture[]) {
  return {
    from: vi.fn((table: string) => {
      if (table !== "properties") throw new Error(`unexpected table ${table}`);
      let rows = [...fixtures];
      const builder = {
        select: () => builder,
        eq: (column: keyof NeighborFixture, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        neq: (column: keyof NeighborFixture, value: unknown) => {
          rows = rows.filter((row) => row[column] !== value);
          return builder;
        },
        is: (column: keyof NeighborFixture, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        gt: (column: keyof NeighborFixture, value: unknown) => {
          rows = rows.filter((row) => String(row[column]) > String(value));
          return builder;
        },
        lt: (column: keyof NeighborFixture, value: unknown) => {
          rows = rows.filter((row) => String(row[column]) < String(value));
          return builder;
        },
        order: (
          column: keyof NeighborFixture,
          { ascending }: { ascending: boolean },
        ) => {
          rows.sort((a, b) => {
            const comparison = String(a[column]).localeCompare(
              String(b[column]),
            );
            return ascending ? comparison : -comparison;
          });
          return builder;
        },
        limit: (count: number) => {
          rows = rows.slice(0, count);
          return builder;
        },
        single: () =>
          Promise.resolve({
            data: rows[0] ?? null,
            error: rows[0] ? null : {},
          }),
        maybeSingle: () =>
          Promise.resolve({ data: rows[0] ?? null, error: null }),
      };
      return builder;
    }),
  };
}

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
  assertPropertyDncUnlocked.mockReset();
  assertPropertyDncUnlocked.mockResolvedValue({ ok: true, data: null });
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
  validateActiveAssigneeForProperties.mockReset();
  validateActiveAssigneeForProperties.mockResolvedValue({
    ok: true,
    propertyOrgIds: new Map([["property-1", "org-1"]]),
  });
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("getPropertyNeighbors historical collection", () => {
  const base = {
    is_dnc_locked: true,
    deleted_at: null,
  } as const;

  it("keeps locked prospect history in Prospects and skips locked lead history", async () => {
    createClient.mockResolvedValue(
      makeNeighborClient([
        {
          ...base,
          id: "current-prospect",
          created_at: "2026-08-10T00:00:00.000Z",
          status: "prospect",
        },
        {
          ...base,
          id: "nearer-newer-locked-lead",
          created_at: "2026-08-11T00:00:00.000Z",
          status: "interested",
        },
        {
          ...base,
          id: "newer-locked-prospect",
          created_at: "2026-08-12T00:00:00.000Z",
          status: "prospect",
        },
        {
          ...base,
          id: "nearer-older-locked-lead",
          created_at: "2026-08-09T00:00:00.000Z",
          status: "closed",
        },
        {
          ...base,
          id: "older-locked-prospect",
          created_at: "2026-08-08T00:00:00.000Z",
          status: "prospect",
        },
      ]),
    );

    await expect(
      getPropertyNeighbors("current-prospect", "prospect"),
    ).resolves.toEqual({
      prevId: "newer-locked-prospect",
      nextId: "older-locked-prospect",
    });
  });

  it("keeps locked lead history in Leads and skips locked prospect history", async () => {
    createClient.mockResolvedValue(
      makeNeighborClient([
        {
          ...base,
          id: "current-lead",
          created_at: "2026-08-10T00:00:00.000Z",
          status: "interested",
        },
        {
          ...base,
          id: "nearer-newer-locked-prospect",
          created_at: "2026-08-11T00:00:00.000Z",
          status: "prospect",
        },
        {
          ...base,
          id: "newer-locked-lead",
          created_at: "2026-08-12T00:00:00.000Z",
          status: "closed",
        },
        {
          ...base,
          id: "nearer-older-locked-prospect",
          created_at: "2026-08-09T00:00:00.000Z",
          status: "prospect",
        },
        {
          ...base,
          id: "older-locked-lead",
          created_at: "2026-08-08T00:00:00.000Z",
          status: "dead",
        },
      ]),
    );

    await expect(getPropertyNeighbors("current-lead", "lead")).resolves.toEqual(
      {
        prevId: "newer-locked-lead",
        nextId: "older-locked-lead",
      },
    );
  });
});

describe("lead assignment membership gate", () => {
  it("rejects a forged single-lead assignee before writing", async () => {
    const supabase = { from: vi.fn() };
    createClient.mockResolvedValue(supabase);
    validateActiveAssigneeForProperties.mockResolvedValueOnce({
      ok: false,
      code: "INVALID_ASSIGNEE",
      message: "Choose an active teammate.",
    });

    const result = await updateLeadAssignee("property-1", "forged-user");

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ASSIGNEE" } });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("rejects a mixed-org bulk assignee before any update or notification", async () => {
    const supabase = { from: vi.fn(), auth: { getUser: vi.fn() } };
    createClient.mockResolvedValue(supabase);
    validateActiveAssigneeForProperties.mockResolvedValueOnce({
      ok: false,
      code: "INVALID_ASSIGNEE",
      message: "Target is not active in every workspace.",
    });

    const result = await assignLeadsBulk(["property-a", "property-b"], "stale-user");

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ASSIGNEE" } });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.auth.getUser).not.toHaveBeenCalled();
  });
});

describe("markMessagesReadForThread — permanent DNC", () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";

  function readThreadClient(propertyIds: Array<string | null>) {
    let call = 0;
    const eqCalls: Array<[string, unknown]> = [];
    const from = vi.fn(() => {
      call += 1;
      const result = Promise.resolve({
        data:
          call === 1
            ? propertyIds.map((property_id) => ({ property_id }))
            : null,
        error: null,
      });
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const method of ["select", "eq", "not", "update", "is"]) {
        builder[method] = chain;
      }
      builder.eq = (column: string, value: unknown) => {
        eqCalls.push([column, value]);
        return builder;
      };
      builder.then = result.then.bind(result);
      return builder;
    });
    return {
      from,
      rpc: vi.fn().mockResolvedValue({ data: "org-1", error: null }),
      eqCalls,
    };
  }

  it("rejects a locked conversation before changing read state", async () => {
    const supabase = readThreadClient(["locked-property"]);
    createClient.mockResolvedValue(supabase);
    assertPropertyDncUnlocked.mockResolvedValueOnce({
      ok: false,
      error: { code: "DNC_LOCKED", message: "Permanently locked" },
    });

    const result = await markMessagesReadForThread(conversationId);

    expect(result).toMatchObject({ ok: false, error: { code: "DNC_LOCKED" } });
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("rejects a mixed conversation when any linked property is locked", async () => {
    const supabase = readThreadClient(["open-property", "locked-property"]);
    createClient.mockResolvedValue(supabase);
    assertPropertyDncUnlocked
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "DNC_LOCKED", message: "Permanently locked" },
      });

    const result = await markMessagesReadForThread(conversationId);

    expect(result).toMatchObject({ ok: false, error: { code: "DNC_LOCKED" } });
    expect(assertPropertyDncUnlocked).toHaveBeenCalledTimes(2);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("still marks an unlinked conversation read", async () => {
    const supabase = readThreadClient([null]);
    createClient.mockResolvedValue(supabase);

    await expect(markMessagesReadForThread(conversationId)).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(assertPropertyDncUnlocked).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(supabase.eqCalls.filter(([column]) => column === "org_id")).toEqual([
      ["org_id", "org-1"],
      ["org_id", "org-1"],
    ]);
  });

  it("fails closed before any read-state mutation when tenant resolution is ambiguous", async () => {
    const supabase = readThreadClient([null]);
    supabase.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "SMS_CONVERSATION_ORG_AMBIGUOUS" },
    });
    createClient.mockResolvedValue(supabase);

    const result = await markMessagesReadForThread(conversationId);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "MARK_READ_FAILED" },
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("updatePropertyStatus", () => {
  function mockStatusUpdate(
    result: StubResult<{ id: string; status: string }>,
    currentResult: StubResult<{ id: string; status: string }> = {
      data: null,
      error: null,
    },
  ) {
    const maybeSingle = vi.fn().mockResolvedValue(result);
    const select = vi.fn(() => ({ maybeSingle }));
    const builder = { eq: vi.fn(), select };
    builder.eq.mockReturnValue(builder);
    const update = vi.fn(() => builder);
    const currentMaybeSingle = vi.fn().mockResolvedValue(currentResult);
    const currentBuilder = { eq: vi.fn(), maybeSingle: currentMaybeSingle };
    currentBuilder.eq.mockReturnValue(currentBuilder);
    const currentSelect = vi.fn(() => currentBuilder);
    createClient.mockResolvedValue({
      from: vi.fn(() => ({ update, select: currentSelect })),
    });
    return {
      update,
      eq: builder.eq,
      select,
      maybeSingle,
      currentSelect,
      currentMaybeSingle,
    };
  }

  it("rejects a forged stage move when the property became permanently DNC", async () => {
    const chain = mockStatusUpdate({ data: null, error: null });
    assertPropertyDncUnlocked.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "DNC_LOCKED",
        message: "This property is permanently locked Do Not Contact and is read-only.",
      },
    });

    const result = await updatePropertyStatus(
      "property-1",
      "contacted",
      "new_lead",
    );

    expect(result).toMatchObject({ ok: false, error: { code: "DNC_LOCKED" } });
    expect(chain.update).not.toHaveBeenCalled();
  });

  it("returns the persisted row only after the selected status is read back", async () => {
    const chain = mockStatusUpdate({
      data: { id: "property-1", status: "contacted" },
      error: null,
    });

    const result = await updatePropertyStatus(
      "property-1",
      "contacted",
      "new_lead",
    );

    expect(result).toEqual({
      ok: true,
      data: { propertyId: "property-1", status: "contacted" },
    });
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "contacted" }),
    );
    expect(chain.eq).toHaveBeenCalledWith("id", "property-1");
    expect(chain.eq).toHaveBeenCalledWith("status", "new_lead");
    expect(chain.select).toHaveBeenCalledWith("id, status");
  });

  it("returns the authoritative current stage when a stale update matched no row", async () => {
    mockStatusUpdate(
      { data: null, error: null },
      { data: { id: "property-1", status: "interested" }, error: null },
    );

    const result = await updatePropertyStatus(
      "property-1",
      "contacted",
      "new_lead",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STATUS_CONFLICT");
      expect(result.error.details).toEqual({ currentStatus: "interested" });
    }
  });

  it("fails when the persisted read-back does not match the requested stage", async () => {
    mockStatusUpdate({
      data: { id: "property-1", status: "new_lead" },
      error: null,
    });

    const result = await updatePropertyStatus(
      "property-1",
      "contacted",
      "new_lead",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STATUS_UPDATE_NOT_SAVED");
    }
  });

  it("keeps a zero-row move idempotent when another client already saved the target", async () => {
    mockStatusUpdate(
      { data: null, error: null },
      { data: { id: "property-1", status: "contacted" }, error: null },
    );

    const result = await updatePropertyStatus(
      "property-1",
      "contacted",
      "new_lead",
    );

    expect(result).toEqual({
      ok: true,
      data: { propertyId: "property-1", status: "contacted" },
    });
  });
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
      endAt: undefined,
      timezone: "America/Denver",
      deepLink: "https://app.test/leads/prop-1",
      calendarEnabled: true,
    });
  });

  it("loads teammate prefs via the admin client, not the cookie client", async () => {
    const cookieSupabase = makeLeadTaskSupabase({
      property: { id: "prop-1", org_id: "org-1", address: "123 Main" },
      actorMembership: { user_id: "actor-1" },
    });
    createClient.mockResolvedValue(cookieSupabase);
    const adminClient = makeLeadTaskAdmin({
      assigneeMembership: { user_id: "assignee-1" },
    });
    createAdminClient.mockReturnValue(adminClient);
    createTask.mockResolvedValue({
      ok: true,
      data: { id: "task-1", assignee_id: "assignee-1" },
    });
    loadIntegrationPrefs.mockImplementation(async (client: unknown) => {
      if (client === adminClient) {
        return {
          slackEnabled: false,
          calendarEnabled: false,
          timezone: "America/Denver",
        };
      }
      return {
        slackEnabled: true,
        calendarEnabled: true,
        timezone: "America/Chicago",
      };
    });

    const result = await createLeadTaskAction("prop-1", {
      type: "follow_up",
      dueAt: "2026-06-20T15:00:00.000Z",
      assigneeId: "assignee-1",
    });

    expect(result.ok).toBe(true);
    await flushAfterCallbacks();

    expect(loadIntegrationPrefs).toHaveBeenCalledWith(
      adminClient,
      "assignee-1",
    );
    expect(loadIntegrationPrefs).not.toHaveBeenCalledWith(
      cookieSupabase,
      "assignee-1",
    );
    expect(dispatchTaskAssignedSlack).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: "America/Denver",
        slackEnabled: false,
      }),
    );
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
