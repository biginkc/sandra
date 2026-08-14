import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
}));

let queuedData: unknown[] | null = [];
let queuedError: { message: string; code?: string } | null = null;
let eqCalls: Array<[string, unknown]> = [];
let selectCalls: string[] = [];

function makeBuilder(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  builder.select = (columns: string) => {
    selectCalls.push(columns);
    return builder;
  };
  builder.eq = (col: string, val: unknown) => {
    eqCalls.push([col, val]);
    return builder;
  };
  builder.in = () => builder;
  builder.gte = () => builder;
  builder.lt = () => builder;
  builder.order = () => Promise.resolve({ data: queuedData, error: queuedError });
  return builder;
}

// .from("memberships").select().eq("org_id",…).eq("access_status","active")
// .is("deletion_prepared_at", null).or(activeAt filter) — mirrors
// `listBookingAssignees`'s predicate (book-appointment-action.test.ts).
let membershipRows: Array<{ user_id: string }> | null = [];
let membershipError: { message: string; code?: string } | null = null;
let membershipEqCalls: Array<[string, unknown]> = [];
let membershipIsCalls: Array<[string, unknown]> = [];
let membershipOrCalls: string[] = [];

function makeMembershipsBuilder(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = (col: string, val: unknown) => {
    membershipEqCalls.push([col, val]);
    return builder;
  };
  builder.is = (col: string, val: unknown) => {
    membershipIsCalls.push([col, val]);
    return builder;
  };
  builder.or = (filter: string) => {
    membershipOrCalls.push(filter);
    return Promise.resolve({ data: membershipRows, error: membershipError });
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn(() => makeBuilder()),
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    auth: { admin: { listUsers: mocks.listUsers } },
    from: vi.fn((table: string) => {
      if (table === "memberships") return makeMembershipsBuilder();
      throw new Error(`Unexpected admin table in test: ${table}`);
    }),
  })),
}));

import {
  fetchAssigneeEmails,
  fetchCalendarAppointments,
  fetchOrgAssigneeEmails,
} from "./queries";

beforeEach(() => {
  vi.clearAllMocks();
  queuedData = [];
  queuedError = null;
  eqCalls = [];
  selectCalls = [];
  membershipRows = [];
  membershipError = null;
  membershipEqCalls = [];
  membershipIsCalls = [];
  membershipOrCalls = [];
});

describe("fetchCalendarAppointments", () => {
  it("scopes to org + type='appointment' + open/completed status + the due_at window", async () => {
    queuedData = [];
    await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });

    expect(eqCalls).toContainEqual(["org_id", "org-1"]);
    expect(eqCalls).toContainEqual(["type", "appointment"]);
    expect(selectCalls[0]).toContain("properties(");
    expect(selectCalls[0]).toContain("contacts(");
  });

  it("adds an assignee_id filter only when assigneeId is supplied", async () => {
    queuedData = [];
    await fetchCalendarAppointments("org-1", {
      assigneeId: "user-1",
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });
    expect(eqCalls).toContainEqual(["assignee_id", "user-1"]);
  });

  it("maps a property-linked row and derives contact_name from entity_name first", async () => {
    queuedData = [
      {
        id: "t-1",
        title: "Walkthrough",
        description: "note",
        due_at: "2026-05-05T15:00:00.000Z",
        end_at: "2026-05-05T15:30:00.000Z",
        status: "open",
        outcome: null,
        assignee_id: "user-1",
        related_property_id: "prop-1",
        contact_id: "contact-1",
        properties: { address: "1 Main St", city: "KC", state: "MO", deleted_at: null },
        contacts: { first_name: "Jane", last_name: "Doe", entity_name: "Acme LLC" },
      },
    ];

    const result = await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "t-1",
      property_id: "prop-1",
      address: "1 Main St",
      contact_name: "Acme LLC",
    });
  });

  it("falls back to first/last name when entity_name is absent", async () => {
    queuedData = [
      {
        id: "t-2",
        title: "Call",
        description: null,
        due_at: "2026-05-05T15:00:00.000Z",
        end_at: "2026-05-05T15:30:00.000Z",
        status: "open",
        outcome: null,
        assignee_id: "user-1",
        related_property_id: null,
        contact_id: "contact-2",
        properties: null,
        contacts: { first_name: "Jane", last_name: "Doe", entity_name: null },
      },
    ];

    const result = await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });
    expect(result[0].contact_name).toBe("Jane Doe");
  });

  it("degrades a soft-deleted property to null property fields instead of dropping the row", async () => {
    queuedData = [
      {
        id: "t-3",
        title: "Stale link",
        description: null,
        due_at: "2026-05-05T15:00:00.000Z",
        end_at: "2026-05-05T15:30:00.000Z",
        status: "open",
        outcome: null,
        assignee_id: "user-1",
        related_property_id: "prop-3",
        contact_id: null,
        properties: {
          address: "3 Main St",
          city: "KC",
          state: "MO",
          deleted_at: "2026-05-01T00:00:00.000Z",
        },
        contacts: null,
      },
    ];

    const result = await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });
    expect(result[0].property_id).toBeNull();
    expect(result[0].address).toBeNull();
  });

  it("treats a personal block (no property, no contact) as null/null rather than dropping it", async () => {
    queuedData = [
      {
        id: "t-4",
        title: "Block time",
        description: null,
        due_at: "2026-05-05T15:00:00.000Z",
        end_at: "2026-05-05T15:30:00.000Z",
        status: "open",
        outcome: null,
        assignee_id: "user-1",
        related_property_id: null,
        contact_id: null,
        properties: null,
        contacts: null,
      },
    ];

    const result = await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });
    expect(result[0]).toMatchObject({
      property_id: null,
      contact_id: null,
      contact_name: null,
    });
  });

  it("returns an empty array on a query error", async () => {
    queuedData = null;
    queuedError = { message: "boom" };

    const result = await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });
    expect(result).toEqual([]);
  });
});

describe("fetchAssigneeEmails", () => {
  it("returns an empty map without calling listUsers when no ids are requested", async () => {
    const result = await fetchAssigneeEmails([]);
    expect(result).toEqual({});
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it("filters listUsers results down to the requested ids", async () => {
    mocks.listUsers.mockResolvedValueOnce({
      data: {
        users: [
          { id: "user-1", email: "a@example.com" },
          { id: "user-2", email: "b@example.com" },
        ],
        nextPage: null,
      },
      error: null,
    });

    const result = await fetchAssigneeEmails(["user-1"]);
    expect(result).toEqual({ "user-1": "a@example.com" });
  });

  it("paginates through listUsers until nextPage is null", async () => {
    mocks.listUsers
      .mockResolvedValueOnce({
        data: { users: [{ id: "user-1", email: "a@example.com" }], nextPage: 2 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { users: [{ id: "user-2", email: "b@example.com" }], nextPage: null },
        error: null,
      });

    const result = await fetchAssigneeEmails(["user-1", "user-2"]);
    expect(result).toEqual({ "user-1": "a@example.com", "user-2": "b@example.com" });
    expect(mocks.listUsers).toHaveBeenCalledTimes(2);
  });

  it("returns an empty map on a listUsers error", async () => {
    mocks.listUsers.mockResolvedValueOnce({
      data: null,
      error: { message: "boom" },
    });
    const result = await fetchAssigneeEmails(["user-1"]);
    expect(result).toEqual({});
  });
});

describe("fetchOrgAssigneeEmails", () => {
  it("returns emails for every active org membership, independent of any appointment rows (Codex round 1)", async () => {
    // A teammate with zero appointments this week still appears — this
    // query never touches `tasks`/`appointments`, only `memberships`.
    membershipRows = [{ user_id: "user-1" }, { user_id: "rep-2" }];
    mocks.listUsers.mockResolvedValueOnce({
      data: {
        users: [
          { id: "user-1", email: "owner@bmh.com" },
          { id: "rep-2", email: "rep2@bmh.com" },
        ],
        nextPage: null,
      },
      error: null,
    });

    const result = await fetchOrgAssigneeEmails("org-1");
    expect(result).toEqual({ "user-1": "owner@bmh.com", "rep-2": "rep2@bmh.com" });
  });

  it("scopes to the org and to active, non-deletion-prepared, unexpired memberships", async () => {
    membershipRows = [];
    await fetchOrgAssigneeEmails("org-1");

    expect(membershipEqCalls).toContainEqual(["org_id", "org-1"]);
    expect(membershipEqCalls).toContainEqual(["access_status", "active"]);
    expect(membershipIsCalls).toContainEqual(["deletion_prepared_at", null]);
    expect(membershipOrCalls[0]).toMatch(/^access_expires_at\.is\.null,access_expires_at\.gt\./);
  });

  it("keeps the full roster available even when the current week's appointments are empty (decoupled from `fetchCalendarAppointments`)", async () => {
    queuedData = [];
    membershipRows = [{ user_id: "rep-2" }];
    mocks.listUsers.mockResolvedValueOnce({
      data: { users: [{ id: "rep-2", email: "rep2@bmh.com" }], nextPage: null },
      error: null,
    });

    const appointments = await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });
    expect(appointments).toEqual([]);

    const result = await fetchOrgAssigneeEmails("org-1");
    expect(result).toEqual({ "rep-2": "rep2@bmh.com" });
  });

  it("returns an empty map on a memberships query error", async () => {
    membershipRows = null;
    membershipError = { message: "boom" };

    const result = await fetchOrgAssigneeEmails("org-1");
    expect(result).toEqual({});
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });
});
