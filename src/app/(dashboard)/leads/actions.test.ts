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
  getCallerMemberships,
  loadOrgTeamMembers,
  recordLeadEvent,
  recordLeadEvents,
  revalidatePath,
  validateActiveAssigneeForProperties,
  verifyPropertyAddress,
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
  getCallerMemberships: vi.fn(),
  loadOrgTeamMembers: vi.fn(),
  recordLeadEvent: vi.fn(),
  recordLeadEvents: vi.fn(),
  revalidatePath: vi.fn(),
  validateActiveAssigneeForProperties: vi.fn(),
  verifyPropertyAddress: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("@/lib/dnc/property-lock", () => ({
  assertPropertyDncUnlocked,
  DNC_LOCKED_MESSAGE:
    "This property is permanently locked Do Not Contact and is read-only.",
  partitionPropertyDncLocks: vi.fn(async (_client, ids: string[]) => ({
    ok: true,
    data: { unlocked: ids, locked: [], missing: [] },
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient,
}));

vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships }));
vi.mock("@/lib/auth/team-roster", () => ({ loadOrgTeamMembers }));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: {
    ADDRESS_VERIFIED: "address_verified",
    MOTIVATION_CHANGED: "motivation_changed",
    REVERTED_TO_PROSPECT: "reverted_to_prospect",
    STATUS_CHANGED: "status_changed",
    LIST_ADDED: "list_added",
  },
  recordLeadEvent,
  recordLeadEvents,
}));

vi.mock("@/lib/enrichment/verify-property", () => ({
  verifyPropertyAddress,
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
  listPropertyOrgUsers,
  markMessagesReadForThread,
  updatePropertyStatus,
  updateLeadAssignee,
  verifyLeadAddress,
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
  listResult?: StubResult<{ id: string; name: string; org_id: string }>;
}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue(opts.user),
    },
    from: vi.fn((table: string) => {
      if (table === "lists") {
        const result = opts.listResult ?? {
          data: { id: "list-1", name: "Test list", org_id: "org-1" },
          error: null,
        };
        const builder = {
          select: vi.fn(),
          eq: vi.fn(),
          maybeSingle: vi.fn().mockResolvedValue(result),
        };
        builder.select.mockReturnValue(builder);
        builder.eq.mockReturnValue(builder);
        return builder;
      }
      if (table === "properties") {
        return {
          select: () => ({
            in: () => Promise.resolve(opts.lookupResult),
          }),
        };
      }
      if (table === "property_lists") {
        const membershipBuilder = {
          eq: vi.fn(),
          in: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
        membershipBuilder.eq.mockReturnValue(membershipBuilder);
        return {
          select: vi.fn(() => membershipBuilder),
          upsert: (
            rows: UpsertCapture["rows"],
            options: { onConflict?: string; ignoreDuplicates?: boolean },
          ) => {
            opts.capture.rows.push(...rows);
            opts.capture.options = options;
            return {
              select: vi.fn().mockResolvedValue({
                data:
                  opts.upsertResult.error === null
                    ? rows.map((row) => ({ property_id: row.property_id }))
                    : opts.upsertResult.data,
                error: opts.upsertResult.error,
              }),
            };
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
  recordLeadEvent.mockReset().mockResolvedValue(undefined);
  recordLeadEvents.mockReset().mockResolvedValue(undefined);
  revalidatePath.mockReset();
  validateActiveAssigneeForProperties.mockReset();
  validateActiveAssigneeForProperties.mockResolvedValue({
    ok: true,
    propertyOrgIds: new Map([["property-1", "org-1"]]),
  });
  verifyPropertyAddress.mockReset();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("verifyLeadAddress activity", () => {
  it("records the persisted CASS verdict without copying address data", async () => {
    const propertyLookup = {
      select: vi.fn(() => propertyLookup),
      eq: vi.fn(() => propertyLookup),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { org_id: "org-1" },
        error: null,
      }),
    };
    createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
          error: null,
        }),
      },
      from: vi.fn((table: string) => {
        if (table === "properties") return propertyLookup;
        throw new Error(`unexpected table ${table}`);
      }),
    });
    verifyPropertyAddress.mockResolvedValue({
      status: "verified",
      propertyId: "property-1",
      cacheHit: false,
      verified: {
        cassStatus: "verified",
        standardized: "123 Main St, Kansas City, MO 64111",
        isVacant: false,
        components: {},
        raw: {},
      },
    });

    const result = await verifyLeadAddress("property-1");

    expect(result).toMatchObject({
      ok: true,
      data: { cassStatus: "verified", cacheHit: false },
    });
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      actorType: "user",
      actorId: "user-1",
      eventType: "address_verified",
      payload: { cass_status: "verified", cache_hit: false },
    });
    expect(JSON.stringify(recordLeadEvent.mock.calls)).not.toContain(
      "123 Main",
    );
  });

  it("does not record an event when the provider result was not persisted", async () => {
    const propertyLookup = {
      select: vi.fn(() => propertyLookup),
      eq: vi.fn(() => propertyLookup),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { org_id: "org-1" },
        error: null,
      }),
    };
    createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
          error: null,
        }),
      },
      from: vi.fn(() => propertyLookup),
    });
    verifyPropertyAddress.mockResolvedValue({
      status: "provider_persist_failed",
      propertyId: "property-1",
      error: "database unavailable",
      verified: {
        cassStatus: "verified",
        standardized: "123 Main St",
        components: {},
        raw: {},
      },
    });

    const result = await verifyLeadAddress("property-1");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VERIFICATION_FAILED" },
    });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("requires a resolved user before checking or paying to verify", async () => {
    createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: { message: "auth unavailable" },
        }),
      },
      from: vi.fn(),
    });

    const result = await verifyLeadAddress("property-1");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "AUTH_REQUIRED" },
    });
    expect(assertPropertyDncUnlocked).not.toHaveBeenCalled();
    expect(verifyPropertyAddress).not.toHaveBeenCalled();
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });
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

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_ASSIGNEE" },
    });
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

    const result = await assignLeadsBulk(
      ["property-a", "property-b"],
      "stale-user",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_ASSIGNEE" },
    });
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
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "00000000-0000-4000-8000-000000000001" } },
        }),
      },
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
        message:
          "This property is permanently locked Do Not Contact and is read-only.",
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
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      actorType: "user",
      actorId: "00000000-0000-4000-8000-000000000001",
      eventType: "status_changed",
      payload: { from: "new_lead", to: "contacted" },
    });
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
    expect(recordLeadEvent).not.toHaveBeenCalled();
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
      ignoreDuplicates: true,
    });
    expect(recordLeadEvents).toHaveBeenCalledTimes(1);
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

    const result = await addPropertiesToListBulk(["p1", "p-missing"], "list-1");

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

  it("rejects a suspended assignee before creating or dispatching a task", async () => {
    createClient.mockResolvedValue(
      makeLeadTaskSupabase({
        property: { id: "prop-1", org_id: "org-1", address: "123 Main" },
        actorMembership: { user_id: "actor-1" },
      }),
    );
    createAdminClient.mockReturnValue(
      makeLeadTaskAdmin({
        assigneeMembership: {
          user_id: "former-1",
          access_status: "suspended",
          access_expires_at: null,
          deletion_prepared_at: null,
        },
      }),
    );

    const result = await createLeadTaskAction("prop-1", {
      type: "follow_up",
      dueAt: "2026-06-20T15:00:00.000Z",
      assigneeId: "former-1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ASSIGNEE_NOT_ACTIVE");
    expect(createTask).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
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

describe("listPropertyOrgUsers", () => {
  it("uses the compatibility-aware caller membership result for the property workspace", async () => {
    const propertyBuilder = {
      select: vi.fn(() => propertyBuilder),
      eq: vi.fn(() => propertyBuilder),
      maybeSingle: vi.fn(async () => ({
        data: { org_id: "org-property" },
        error: null,
      })),
    };
    createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "actor-1" } } })),
      },
      from: vi.fn((table: string) => {
        if (table !== "properties") throw new Error(`unexpected table ${table}`);
        return propertyBuilder;
      }),
    });
    getCallerMemberships.mockResolvedValue([
      { user_id: "actor-1", org_id: "org-property", role: "member" },
    ]);
    loadOrgTeamMembers.mockResolvedValue([
      {
        id: "actor-1",
        email: "actor@example.test",
        displayName: "Active Agent",
        isActive: true,
      },
    ]);

    const result = await listPropertyOrgUsers("property-1");

    expect(result.ok).toBe(true);
    expect(getCallerMemberships).toHaveBeenCalledTimes(1);
    expect(loadOrgTeamMembers).toHaveBeenCalledWith("org-property");
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
  assigneeMembership: {
    user_id: string;
    access_status?: string | null;
    access_expires_at?: string | null;
    deletion_prepared_at?: string | null;
  } | null;
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

async function flushAfterCallbacks() {
  const callbacks = [...afterCallbacks];
  afterCallbacks.length = 0;
  await Promise.all(callbacks.map((callback) => callback()));
}
