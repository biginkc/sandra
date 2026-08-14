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

function makeBuilder(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
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

import { fetchMyTasks } from "./queries";

beforeEach(() => {
  vi.clearAllMocks();
  queuedData = [];
  queuedError = null;
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
});
