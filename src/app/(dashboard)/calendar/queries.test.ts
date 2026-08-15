import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
}));

let queuedData: unknown[] | null = [];
let queuedError: { message: string; code?: string } | null = null;
let queuedResponses: { data: unknown; error: unknown }[] = [];
let eqCalls: Array<[string, unknown]> = [];
let selectCalls: string[] = [];
let orderCalls: Array<[string, unknown]> = [];
let limitCalls: number[] = [];
let inCalls: Array<[string, unknown]> = [];

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
  builder.in = (col: string, val: unknown) => {
    inCalls.push([col, val]);
    return builder;
  };
  builder.gte = () => builder;
  builder.lt = () => builder;
  builder.order = (col: string, opts: unknown) => {
    orderCalls.push([col, opts]);
    return builder;
  };
  builder.limit = (n: number) => {
    limitCalls.push(n);
    // Per-call FIFO first (multi-window month fetches need distinct
    // responses per query), falling back to the shared single-response
    // queue every pre-existing test uses.
    if (queuedResponses.length > 0) {
      return Promise.resolve(queuedResponses.shift()!);
    }
    return Promise.resolve({ data: queuedData, error: queuedError });
  };
  return builder;
}

// .from("memberships").select().eq("org_id",…).eq("access_status","active")
// .is("deletion_prepared_at", null).or(activeAt filter).order("user_id")
// .limit(n) — mirrors `listBookingAssignees`'s predicate
// (book-appointment-action.test.ts).
let membershipRows: Array<{ user_id: string }> | null = [];
let membershipError: { message: string; code?: string } | null = null;
let membershipEqCalls: Array<[string, unknown]> = [];
let membershipIsCalls: Array<[string, unknown]> = [];
let membershipOrCalls: string[] = [];
let membershipOrderCalls: Array<[string, unknown]> = [];
let membershipLimitCalls: number[] = [];

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
    return builder;
  };
  builder.order = (col: string, opts: unknown) => {
    membershipOrderCalls.push([col, opts]);
    return builder;
  };
  builder.limit = (n: number) => {
    membershipLimitCalls.push(n);
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
  fetchCalendarAppointmentsForWindows,
  fetchOrgRoster,
} from "./queries";

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset (not just clear) drops unconsumed mockResolvedValueOnce
  // queues — early-exit code paths consume fewer responses than tests
  // enqueue, and leftovers must never leak into the next test.
  mocks.listUsers.mockReset();
  queuedData = [];
  queuedError = null;
  queuedResponses = [];
  eqCalls = [];
  selectCalls = [];
  orderCalls = [];
  limitCalls = [];
  inCalls = [];
  membershipRows = [];
  membershipError = null;
  membershipEqCalls = [];
  membershipIsCalls = [];
  membershipOrCalls = [];
  membershipOrderCalls = [];
  membershipLimitCalls = [];
});

function appointmentRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "t-1",
    title: "Walkthrough",
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
    ...overrides,
  };
}

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

  // Migration 20260816090000 (cancel chain visibility fix): a reschedule ->
  // cancel chain now flips its predecessor row(s) from
  // status=completed/outcome=rescheduled to status=cancelled/
  // outcome=cancelled, specifically SO THAT they fall outside this status
  // filter and stop rendering as a stale "Rescheduled" card forever. This
  // test doesn't (and can't, given this file's mock `.in()` doesn't
  // actually filter `queuedData`) prove server-side exclusion — the real
  // proof is the DB-level integration suite
  // (20260816090000_cancel_chain_visibility.integration.test.ts, which
  // asserts the predecessor's row status/outcome directly). What this test
  // pins is that the query still asks for EXACTLY `["open", "completed"]`
  // and nothing wider (e.g. "cancelled") — the one invariant a chain whose
  // predecessor is now cancelled actually depends on to stop rendering.
  it("filters to status IN (open, completed) — the same filter a chain-cancelled reschedule predecessor now falls outside of", async () => {
    queuedData = [];
    await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });

    expect(inCalls).toContainEqual(["status", ["open", "completed"]]);
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
        properties: {
          address: "1 Main St",
          city: "KC",
          state: "MO",
          deleted_at: null,
        },
        contacts: {
          first_name: "Jane",
          last_name: "Doe",
          entity_name: "Acme LLC",
        },
      },
    ];

    const result = await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
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
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.rows[0].contact_name).toBe("Jane Doe");
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
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.rows[0].property_id).toBeNull();
    expect(result.rows[0].address).toBeNull();
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
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.rows[0]).toMatchObject({
      property_id: null,
      contact_id: null,
      contact_name: null,
    });
  });

  it("returns ok:true with an empty rows array for a genuinely empty week", async () => {
    queuedData = [];

    const result = await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });
    expect(result).toEqual({ ok: true, rows: [] });
  });

  it("returns ok:false (never a bare empty array) on a query error — distinguishable from a genuinely empty week", async () => {
    queuedData = null;
    queuedError = { message: "boom" };

    const result = await fetchCalendarAppointments("org-1", {
      weekStartUtc: "2026-05-03T05:00:00.000Z",
      weekEndUtc: "2026-05-10T05:00:00.000Z",
    });
    expect(result).toEqual({ ok: false });
  });

  describe("single-statement read (Codex round 6 — replaces keyset pagination)", () => {
    const CAP = 900;

    it("sorts by due_at then id for a deterministic row order, in exactly ONE round trip", async () => {
      queuedData = [appointmentRow()];
      await fetchCalendarAppointments("org-1", {
        weekStartUtc: "2026-05-03T05:00:00.000Z",
        weekEndUtc: "2026-05-10T05:00:00.000Z",
      });

      expect(orderCalls).toEqual([
        ["due_at", { ascending: true }],
        ["id", { ascending: true }],
      ]);
      expect(limitCalls).toEqual([CAP + 1]);
    });

    it("returns every row up to and including the cap", async () => {
      queuedData = Array.from({ length: CAP }, (_, i) =>
        appointmentRow({ id: `t-${String(i).padStart(4, "0")}` }),
      );

      const result = await fetchCalendarAppointments("org-1", {
        weekStartUtc: "2026-05-03T05:00:00.000Z",
        weekEndUtc: "2026-05-10T05:00:00.000Z",
      });

      if (!result.ok) throw new Error("expected ok:true");
      expect(result.rows).toHaveLength(CAP);
    });

    it("fails closed (ok:false) when the (CAP+1)th row comes back, rather than silently truncating the week", async () => {
      queuedData = Array.from({ length: CAP + 1 }, (_, i) =>
        appointmentRow({ id: `t-${String(i).padStart(4, "0")}` }),
      );

      const result = await fetchCalendarAppointments("org-1", {
        weekStartUtc: "2026-05-03T05:00:00.000Z",
        weekEndUtc: "2026-05-10T05:00:00.000Z",
      });

      expect(result).toEqual({ ok: false });
      // Exactly one query — the cap check happens on the single response,
      // not via a second round trip.
      expect(limitCalls).toEqual([CAP + 1]);
    });

    it("is immune to a concurrent reschedule moving due_at across a would-be cursor (Codex round 6 — the anomaly this fix eliminates)", async () => {
      // A single query has no cursor for a concurrent write to straddle:
      // whatever `due_at` values the rows hold at the moment of the one
      // `SELECT`, that's the snapshot returned. Simulate a "just
      // rescheduled" row sitting anywhere in the ordered result and assert
      // it comes back exactly once, appearing in exactly ONE round trip.
      queuedData = [
        appointmentRow({ id: "t-early", due_at: "2026-05-03T06:00:00.000Z" }),
        appointmentRow({
          id: "t-rescheduled",
          due_at: "2026-05-03T06:00:01.000Z",
        }),
        appointmentRow({ id: "t-late", due_at: "2026-05-09T23:00:00.000Z" }),
      ];

      const result = await fetchCalendarAppointments("org-1", {
        weekStartUtc: "2026-05-03T05:00:00.000Z",
        weekEndUtc: "2026-05-10T05:00:00.000Z",
      });

      if (!result.ok) throw new Error("expected ok:true");
      const ids = result.rows.map((r) => r.id);
      expect(ids.filter((id) => id === "t-rescheduled")).toHaveLength(1);
      expect(limitCalls).toHaveLength(1);
    });
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

  // Full page of filler users (perPage = 200), each reporting nextPage: 1 —
  // reproduces the installed auth-js's mis-parse of multi-digit Link-header
  // pages (page 9 reports nextPage=1). Page numbers must still advance from
  // the caller's own local counter, never from this field.
  function fullFillerPage(
    pageNum: number,
    extra: Array<{ id: string; email: string }> = [],
  ) {
    const filler = Array.from({ length: 200 }, (_, i) => ({
      id: `filler-p${pageNum}-${i}`,
      email: `filler-p${pageNum}-${i}@example.com`,
    }));
    return { data: { users: [...filler, ...extra], nextPage: 1 }, error: null };
  }

  it("advances page numbers locally across a repeated nextPage:1 (9-to-10 boundary regression) and terminates on the short page without re-requesting page 1", async () => {
    for (let page = 1; page <= 9; page++) {
      mocks.listUsers.mockResolvedValueOnce(fullFillerPage(page));
    }
    mocks.listUsers.mockResolvedValueOnce({
      data: {
        users: [{ id: "user-final", email: "final@example.com" }],
        nextPage: 1,
      },
      error: null,
    });

    const result = await fetchAssigneeEmails(["user-final"]);
    expect(result).toEqual({ "user-final": "final@example.com" });
    expect(mocks.listUsers).toHaveBeenCalledTimes(10);

    const pagesRequested = mocks.listUsers.mock.calls.map(
      (call) => (call[0] as { page: number }).page,
    );
    expect(pagesRequested).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pagesRequested.filter((p) => p === 1)).toHaveLength(1);
  });

  it("stops after exactly one call when every needed id resolves on page 1", async () => {
    mocks.listUsers.mockResolvedValueOnce({
      data: {
        users: [
          { id: "user-1", email: "a@example.com" },
          { id: "user-2", email: "b@example.com" },
        ],
        nextPage: 1,
      },
      error: null,
    });

    const result = await fetchAssigneeEmails(["user-1", "user-2"]);
    expect(result).toEqual({
      "user-1": "a@example.com",
      "user-2": "b@example.com",
    });
    expect(mocks.listUsers).toHaveBeenCalledTimes(1);
  });

  it("stops at the MAX_AUTH_PAGES hard bound instead of hanging when pages never go short and identities never resolve", async () => {
    for (let page = 1; page <= 25; page++) {
      mocks.listUsers.mockResolvedValueOnce(fullFillerPage(page));
    }

    const result = await fetchAssigneeEmails(["user-never-found"]);
    expect(result).toEqual({});
    expect(mocks.listUsers).toHaveBeenCalledTimes(25);
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

describe("fetchOrgRoster", () => {
  it("returns the full roster with real labels for every active org membership, independent of any appointment rows (Codex round 1)", async () => {
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

    const result = await fetchOrgRoster("org-1");
    expect(result).toEqual({
      ok: true,
      labelsDegraded: false,
      roster: [
        { id: "user-1", label: "owner@bmh.com" },
        { id: "rep-2", label: "rep2@bmh.com" },
      ],
    });
  });

  it("scopes to the org and to active, non-deletion-prepared, unexpired memberships", async () => {
    membershipRows = [];
    await fetchOrgRoster("org-1");

    expect(membershipEqCalls).toContainEqual(["org_id", "org-1"]);
    expect(membershipEqCalls).toContainEqual(["access_status", "active"]);
    expect(membershipIsCalls).toContainEqual(["deletion_prepared_at", null]);
    expect(membershipOrCalls[0]).toMatch(
      /^access_expires_at\.is\.null,access_expires_at\.gt\./,
    );
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
    expect(appointments).toEqual({ ok: true, rows: [] });

    const result = await fetchOrgRoster("org-1");
    expect(result).toEqual({
      ok: true,
      labelsDegraded: false,
      roster: [{ id: "rep-2", label: "rep2@bmh.com" }],
    });
  });

  it("returns ok:false (identity failure) on a memberships query error, distinguishable from an org with no members", async () => {
    membershipRows = null;
    membershipError = { message: "boom" };

    const result = await fetchOrgRoster("org-1");
    expect(result).toEqual({ ok: false });
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it("keeps every identity with a fallback label and sets labelsDegraded when listUsers throws", async () => {
    membershipRows = [{ user_id: "user-1" }, { user_id: "rep-2" }];
    mocks.listUsers.mockImplementationOnce(() => {
      throw new Error("network boom");
    });

    const result = await fetchOrgRoster("org-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.labelsDegraded).toBe(true);
    expect(result.roster).toEqual([
      { id: "user-1", label: "Teammate (user-1)" },
      { id: "rep-2", label: "Teammate (rep-2)" },
    ]);
    // No identity dropped even though every label failed.
    expect(result.roster.map((r) => r.id)).toEqual(["user-1", "rep-2"]);
  });

  it("keeps every identity with a fallback label and sets labelsDegraded on partial pagination failure", async () => {
    membershipRows = [{ user_id: "user-1" }, { user_id: "rep-2" }];
    mocks.listUsers
      .mockResolvedValueOnce({
        data: {
          users: [{ id: "user-1", email: "owner@bmh.com" }],
          nextPage: 2,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } });

    const result = await fetchOrgRoster("org-1");
    expect(result).toEqual({
      ok: true,
      labelsDegraded: true,
      roster: [
        { id: "user-1", label: "owner@bmh.com" },
        { id: "rep-2", label: "Teammate (rep-2)" },
      ],
    });
  });

  it("keeps the identity with a fallback label and sets labelsDegraded when a member has no email on auth.users", async () => {
    membershipRows = [{ user_id: "user-1" }, { user_id: "rep-2" }];
    mocks.listUsers.mockResolvedValueOnce({
      data: {
        users: [
          { id: "user-1", email: "owner@bmh.com" },
          { id: "rep-2", email: null },
        ],
        nextPage: null,
      },
      error: null,
    });

    const result = await fetchOrgRoster("org-1");
    expect(result).toEqual({
      ok: true,
      labelsDegraded: true,
      roster: [
        { id: "user-1", label: "owner@bmh.com" },
        { id: "rep-2", label: "Teammate (rep-2)" },
      ],
    });
  });

  describe("single-statement read (Codex round 6 — replaces keyset pagination)", () => {
    const CAP = 400;
    const userId = (i: number) => `user-${String(i).padStart(4, "0")}`;

    it("orders by user_id for a deterministic row order, in exactly ONE round trip", async () => {
      membershipRows = [{ user_id: "user-1" }];
      await fetchOrgRoster("org-1");
      expect(membershipOrderCalls).toEqual([["user_id", { ascending: true }]]);
      expect(membershipLimitCalls).toEqual([CAP + 1]);
    });

    it("returns every membership up to and including the cap", async () => {
      membershipRows = Array.from({ length: CAP }, (_, i) => ({
        user_id: userId(i),
      }));

      const result = await fetchOrgRoster("org-1");
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.roster).toHaveLength(CAP);
    });

    it("fails closed (ok:false) when the (CAP+1)th membership comes back, rather than silently truncating the roster", async () => {
      membershipRows = Array.from({ length: CAP + 1 }, (_, i) => ({
        user_id: userId(i),
      }));

      const result = await fetchOrgRoster("org-1");
      expect(result).toEqual({ ok: false });
      expect(membershipLimitCalls).toEqual([CAP + 1]);
      // A capped-out identity load never falls through to resolving labels.
      expect(mocks.listUsers).not.toHaveBeenCalled();
    });
  });
});

describe("fetchCalendarAppointmentsForWindows (month view)", () => {
  const WINDOWS = [
    { startUtc: "2026-08-02T05:00:00.000Z", endUtc: "2026-08-09T05:00:00.000Z" },
    { startUtc: "2026-08-09T05:00:00.000Z", endUtc: "2026-08-16T05:00:00.000Z" },
  ];

  it("concatenates per-window rows in window order (disjoint ranges, no dedup needed)", async () => {
    queuedResponses = [
      { data: [appointmentRow({ id: "w1-a", due_at: "2026-08-03T15:00:00.000Z" })], error: null },
      { data: [appointmentRow({ id: "w2-a", due_at: "2026-08-10T15:00:00.000Z" })], error: null },
    ];
    const result = await fetchCalendarAppointmentsForWindows("org-1", {
      windows: WINDOWS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows.map((r) => r.id)).toEqual(["w1-a", "w2-a"]);
    }
  });

  it("fails closed when ANY window's query fails", async () => {
    queuedResponses = [
      { data: [appointmentRow({ id: "w1-a" })], error: null },
      { data: null, error: { message: "boom", code: "XX000" } },
    ];
    const result = await fetchCalendarAppointmentsForWindows("org-1", {
      windows: WINDOWS,
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed when a single window exceeds the per-week cap (same contract as week view)", async () => {
    const over = Array.from({ length: 901 }, (_, i) =>
      appointmentRow({ id: `t-${i}` }),
    );
    queuedResponses = [
      { data: over, error: null },
      { data: [appointmentRow({ id: "w2-a" })], error: null },
    ];
    const result = await fetchCalendarAppointmentsForWindows("org-1", {
      windows: WINDOWS,
    });
    expect(result.ok).toBe(false);
  });
});
