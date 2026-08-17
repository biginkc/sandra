import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadIntegrationPrefs: vi.fn(),
  getDayBoundsInZone: vi.fn(),
}));

vi.mock("@/lib/integrations/prefs", () => ({
  loadIntegrationPrefs: mocks.loadIntegrationPrefs,
}));
vi.mock("@/lib/time/zoned", () => ({
  getDayBoundsInZone: mocks.getDayBoundsInZone,
}));

let queuedData: unknown[] | null = [];
let queuedError: { message: string; code?: string } | null = null;
// Column-list string passed to each `.select(...)` call, in call order —
// lets safety tests prove no reduced-column retry silently drops DNC state.
let selectCalls: string[] = [];

function makeBuilder(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  builder.select = (columns: string) => {
    selectCalls.push(columns);
    return builder;
  };
  builder.eq = () => builder;
  builder.order = () =>
    Promise.resolve({ data: queuedData, error: queuedError });
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn(() => makeBuilder()),
  })),
}));

import { fetchMyTasks, type MyTasksResult } from "./queries";

function expectTaskLoadSuccess(
  result: MyTasksResult,
): asserts result is Extract<MyTasksResult, { status: "success" }> {
  expect(result.status).toBe("success");
  if (result.status !== "success") {
    throw new Error("Expected task load to succeed");
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  queuedData = [];
  queuedError = null;
  selectCalls = [];
  mocks.loadIntegrationPrefs.mockResolvedValue({
    slackEnabled: true,
    calendarEnabled: true,
    timezone: "America/Chicago",
  });
  // Zone-local "today" fixed to 2026-05-09 for these tests — the real
  // helper (owned by another lane) does the DST-safe wall-time math.
  mocks.getDayBoundsInZone.mockReturnValue({
    dayStart: new Date("2026-05-09T05:00:00.000Z"),
    dayEnd: new Date("2026-05-10T05:00:00.000Z"),
  });
});

describe("fetchMyTasks", () => {
  it("buckets rows into overdue / today / upcoming using the assignee's zone-local day", async () => {
    queuedData = [
      {
        id: "t-overdue",
        type: "follow_up",
        title: "Call back",
        due_at: "2026-05-08T20:00:00.000Z", // before dayStart
        related_property_id: "prop-1",
        contact_id: null,
        properties: {
          address: "1 Main St",
          city: "KC",
          state: "MO",
          deleted_at: null,
          is_dnc_locked: true,
        },
      },
      {
        id: "t-today",
        type: "follow_up",
        title: "Follow up",
        due_at: "2026-05-09T15:00:00.000Z", // within [dayStart, dayEnd)
        related_property_id: "prop-2",
        contact_id: null,
        properties: {
          address: "2 Main St",
          city: "KC",
          state: "MO",
          deleted_at: null,
        },
      },
      {
        id: "t-upcoming",
        type: "custom",
        title: "Later",
        due_at: "2026-05-11T15:00:00.000Z", // on/after dayEnd
        related_property_id: null,
        contact_id: "contact-1",
        properties: null,
        task_contact: { do_not_contact: false },
      },
    ];

    const result = await fetchMyTasks("user-1");
    expectTaskLoadSuccess(result);

    expect(result.overdue.map((r) => r.id)).toEqual(["t-overdue"]);
    expect(result.overdue[0].is_dnc_locked).toBe(true);
    expect(result.today.map((r) => r.id)).toEqual(["t-today"]);
    expect(result.today[0].is_dnc_locked).toBe(false);
    expect(result.upcoming.map((r) => r.id)).toEqual(["t-upcoming"]);
    expect(result.upcoming[0].is_dnc_locked).toBe(false);
    expect(result.timezone).toBe("America/Chicago");
  });

  it("degrades a property-less row (left join) to null property fields instead of dropping it", async () => {
    queuedData = [
      {
        id: "t-personal",
        type: "custom",
        title: "Block time",
        due_at: "2026-05-09T15:00:00.000Z",
        related_property_id: null,
        contact_id: null,
        properties: null,
      },
    ];

    const result = await fetchMyTasks("user-1");
    expectTaskLoadSuccess(result);
    expect(result.today).toHaveLength(1);
    expect(result.today[0]).toMatchObject({
      property_id: null,
      contact_id: null,
      address: null,
      city: null,
      state: null,
      is_dnc_locked: false,
    });
  });

  it("treats a soft-deleted property as no property rather than dropping the task", async () => {
    queuedData = [
      {
        id: "t-deleted-prop",
        type: "follow_up",
        title: "Stale",
        due_at: "2026-05-09T15:00:00.000Z",
        related_property_id: "prop-3",
        contact_id: null,
        properties: {
          address: "3 Main St",
          city: "KC",
          state: "MO",
          deleted_at: "2026-05-01T00:00:00.000Z",
        },
      },
    ];

    const result = await fetchMyTasks("user-1");
    expectTaskLoadSuccess(result);
    expect(result.today[0].property_id).toBeNull();
    expect(result.today[0].address).toBeNull();
  });

  it("preserves a property DNC lock even when its display fields are too malformed to link", async () => {
    queuedData = [
      {
        id: "t-locked-malformed",
        type: "appointment",
        title: "Historical appointment",
        due_at: "2026-05-09T15:00:00.000Z",
        related_property_id: "prop-locked",
        contact_id: null,
        properties: {
          address: null,
          city: "KC",
          state: "MO",
          deleted_at: null,
          is_dnc_locked: true,
        },
      },
    ];

    const result = await fetchMyTasks("user-1");
    expectTaskLoadSuccess(result);
    expect(result.today[0]).toMatchObject({
      property_id: null,
      address: null,
      is_dnc_locked: true,
    });
  });

  it("locks lifecycle controls for the exact task contact's permanent DNC", async () => {
    queuedData = [
      {
        id: "t-contact-dnc",
        type: "appointment",
        title: "Contact-only appointment",
        due_at: "2026-05-09T15:00:00.000Z",
        related_property_id: null,
        contact_id: "contact-dnc",
        properties: null,
        task_contact: { do_not_contact: true },
      },
    ];

    const result = await fetchMyTasks("user-1");
    expectTaskLoadSuccess(result);
    expect(result.today[0]).toMatchObject({
      property_id: null,
      contact_id: "contact-dnc",
      is_dnc_locked: true,
    });
    expect(selectCalls[0]).toContain(
      "task_contact:contacts!tasks_contact_org_fkey(do_not_contact)",
    );
  });

  it("fails closed when an expected property or contact safety join is missing", async () => {
    queuedData = [
      {
        id: "t-missing-property-join",
        type: "follow_up",
        title: "Missing property relation",
        due_at: "2026-05-09T15:00:00.000Z",
        related_property_id: "prop-missing",
        contact_id: null,
        properties: null,
        task_contact: null,
      },
      {
        id: "t-missing-contact-join",
        type: "appointment",
        title: "Missing contact relation",
        due_at: "2026-05-09T16:00:00.000Z",
        related_property_id: null,
        contact_id: "contact-missing",
        properties: null,
        task_contact: null,
      },
    ];

    const result = await fetchMyTasks("user-1");
    expectTaskLoadSuccess(result);
    expect(result.today.map((row) => row.is_dnc_locked)).toEqual([true, true]);
  });

  it("returns an explicit failure on a query error instead of empty buckets", async () => {
    queuedData = null;
    queuedError = { message: "boom" };

    const result = await fetchMyTasks("user-1");
    expect(result).toEqual({
      status: "failure",
      timezone: "America/Chicago",
    });
  });

  it("resolves day boundaries from the assignee's own timezone pref", async () => {
    mocks.loadIntegrationPrefs.mockResolvedValue({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Denver",
    });
    queuedData = [];

    const result = await fetchMyTasks("user-1");
    expectTaskLoadSuccess(result);

    expect(mocks.loadIntegrationPrefs).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(mocks.getDayBoundsInZone).toHaveBeenCalledWith(
      expect.any(Date),
      "America/Denver",
    );
    expect(result.timezone).toBe("America/Denver");
  });

  it("passes prefs.timezone straight through to the returned timezone field, even when it's the fallback", async () => {
    // Malformed persisted timezones are normalized inside loadIntegrationPrefs
    // itself (see src/lib/integrations/prefs.test.ts) — by the time fetchMyTasks
    // sees it, a garbage value has already become "America/Chicago". This just
    // asserts fetchMyTasks doesn't re-derive or drop the value; it forwards
    // whatever loadIntegrationPrefs resolved to.
    mocks.loadIntegrationPrefs.mockResolvedValue({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Chicago",
    });
    queuedData = [];

    const result = await fetchMyTasks("user-1");
    expectTaskLoadSuccess(result);

    expect(result.timezone).toBe("America/Chicago");
  });

  it("fails closed on a pre-schema 42703 instead of retrying without DNC safety fields", async () => {
    queuedData = null;
    queuedError = {
      message: "column tasks.contact_id does not exist",
      code: "42703",
    };

    const result = await fetchMyTasks("user-1");

    expect(selectCalls).toHaveLength(1);
    expect(result).toEqual({
      status: "failure",
      timezone: "America/Chicago",
    });
  });

  it("does not retry and returns failure when the first select fails with a non-42703 error", async () => {
    queuedData = null;
    queuedError = { message: "connection reset", code: "57P01" };

    const result = await fetchMyTasks("user-1");

    expect(selectCalls).toHaveLength(1);
    expect(result).toEqual({
      status: "failure",
      timezone: "America/Chicago",
    });
  });

  it("fails closed instead of dropping contact safety when the relationship cannot resolve", async () => {
    queuedData = null;
    queuedError = {
      message: "Could not find a relationship for tasks_contact_org_fkey",
      code: "PGRST200",
    };

    const result = await fetchMyTasks("user-1");

    expect(selectCalls).toHaveLength(1);
    expect(result).toEqual({
      status: "failure",
      timezone: "America/Chicago",
    });
  });
});
