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
// Set by the 42703-retry tests to hand back a *different* response per
// `.from("tasks")` call (first select fails, legacy retry succeeds). null
// (the default) preserves the single-response behavior every other test
// relies on: every call resolves from queuedData/queuedError.
let queuedResponses:
  | Array<{ data: unknown[] | null; error: { message: string; code?: string } | null }>
  | null = null;
// Column-list string passed to each `.select(...)` call, in call order —
// lets the retry tests assert the legacy select really dropped contact_id.
let selectCalls: string[] = [];

function makeBuilder(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  builder.select = (columns: string) => {
    selectCalls.push(columns);
    return builder;
  };
  builder.eq = () => builder;
  builder.order = () => {
    if (queuedResponses && queuedResponses.length > 0) {
      return Promise.resolve(queuedResponses.shift()!);
    }
    return Promise.resolve({ data: queuedData, error: queuedError });
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn(() => makeBuilder()),
  })),
}));

import { fetchMyTasks } from "./queries";

beforeEach(() => {
  vi.clearAllMocks();
  queuedData = [];
  queuedError = null;
  queuedResponses = null;
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
      },
    ];

    const result = await fetchMyTasks("user-1");

    expect(result.overdue.map((r) => r.id)).toEqual(["t-overdue"]);
    expect(result.today.map((r) => r.id)).toEqual(["t-today"]);
    expect(result.upcoming.map((r) => r.id)).toEqual(["t-upcoming"]);
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
    expect(result.today).toHaveLength(1);
    expect(result.today[0]).toMatchObject({
      property_id: null,
      contact_id: null,
      address: null,
      city: null,
      state: null,
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
    expect(result.today[0].property_id).toBeNull();
    expect(result.today[0].address).toBeNull();
  });

  it("returns empty buckets on a query error", async () => {
    queuedData = null;
    queuedError = { message: "boom" };

    const result = await fetchMyTasks("user-1");
    expect(result).toEqual({
      overdue: [],
      today: [],
      upcoming: [],
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

    expect(result.timezone).toBe("America/Chicago");
  });

  it("retries with the legacy column list on 42703 (undefined column, pre-migration schema) and shows tasks instead of the false all-caught-up state", async () => {
    queuedResponses = [
      {
        data: null,
        error: { message: 'column tasks.contact_id does not exist', code: "42703" },
      },
      {
        data: [
          {
            id: "t-legacy",
            type: "follow_up",
            title: "Pre-migration row",
            due_at: "2026-05-09T15:00:00.000Z", // within [dayStart, dayEnd)
            related_property_id: "prop-1",
            properties: {
              address: "1 Main St",
              city: "KC",
              state: "MO",
              deleted_at: null,
            },
          },
        ],
        error: null,
      },
    ];

    const result = await fetchMyTasks("user-1");

    expect(selectCalls).toHaveLength(2);
    expect(selectCalls[1]).not.toContain("contact_id");

    expect(result.today).toHaveLength(1);
    expect(result.today[0]).toMatchObject({
      id: "t-legacy",
      contact_id: null,
      address: "1 Main St",
      city: "KC",
      state: "MO",
    });
  });

  it("does not retry and returns empty buckets when the first select fails with a non-42703 error", async () => {
    queuedData = null;
    queuedError = { message: "connection reset", code: "57P01" };

    const result = await fetchMyTasks("user-1");

    expect(selectCalls).toHaveLength(1);
    expect(result).toEqual({
      overdue: [],
      today: [],
      upcoming: [],
      timezone: "America/Chicago",
    });
  });
});
