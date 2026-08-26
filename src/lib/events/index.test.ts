import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

import {
  LEAD_EVENT_TYPES,
  recordLeadEvent,
  recordLeadEvents,
} from "./index";

function makeAdmin(options?: {
  properties?: Array<{ id: string; org_id: string }>;
  propertyError?: { message: string } | null;
  insertError?: { message: string } | null;
  lookupThrows?: Error;
  insertThrows?: Error;
  propertiesForIds?: (ids: string[]) => Array<{ id: string; org_id: string }>;
}) {
  const propertyIn = vi.fn(async (_column: string, ids: string[]) => {
    if (options?.lookupThrows) throw options.lookupThrows;
    return {
      data:
        options?.propertiesForIds?.(ids) ??
        options?.properties ??
        [{ id: "property-1", org_id: "org-1" }],
      error: options?.propertyError ?? null,
    };
  });
  const propertySelect = vi.fn(() => ({ in: propertyIn }));
  const eventInsert = vi.fn(async (rows: unknown[]) => {
    void rows;
    if (options?.insertThrows) throw options.insertThrows;
    return { error: options?.insertError ?? null };
  });
  const from = vi.fn((table: string) => {
    if (table === "properties") return { select: propertySelect };
    if (table === "lead_events") return { insert: eventInsert };
    throw new Error(`Unexpected table: ${table}`);
  });
  return { client: { from }, eventInsert, from, propertyIn };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.createAdminClient.mockReset();
});

describe("lead event vocabulary", () => {
  it("keeps canonical notes and calls out of the ledger vocabulary", () => {
    const values = Object.values(LEAD_EVENT_TYPES);
    expect(values).not.toContain("note_added");
    expect(values).not.toContain("call_logged");
    expect(values).not.toContain("contact_updated");
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("recordLeadEvents", () => {
  it("does nothing for an empty batch without creating an admin client", async () => {
    await expect(recordLeadEvents([])).resolves.toBeUndefined();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("resolves org ownership and inserts a batch once", async () => {
    const admin = makeAdmin({
      properties: [
        { id: "property-1", org_id: "org-1" },
        { id: "property-2", org_id: "org-2" },
      ],
    });
    mocks.createAdminClient.mockReturnValue(admin.client);

    await recordLeadEvents([
      {
        propertyId: "property-1",
        actorType: "user",
        actorId: "user-1",
        eventType: LEAD_EVENT_TYPES.STATUS_CHANGED,
        payload: { from: "new_lead", to: "contacted" },
      },
      {
        propertyId: "property-2",
        actorType: "system",
        eventType: LEAD_EVENT_TYPES.LEAD_CREATED,
        sourceType: "properties.created",
        sourceId: "source-2",
      },
    ]);

    expect(admin.propertyIn).toHaveBeenCalledWith("id", [
      "property-1",
      "property-2",
    ]);
    expect(admin.eventInsert).toHaveBeenCalledTimes(1);
    expect(admin.eventInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        org_id: "org-1",
        property_id: "property-1",
        actor_type: "user",
        actor_id: "user-1",
        event_type: "status_changed",
        payload: { from: "new_lead", to: "contacted" },
      }),
      expect.objectContaining({
        org_id: "org-2",
        property_id: "property-2",
        actor_type: "system",
        actor_id: null,
        source_type: "properties.created",
        source_id: "source-2",
      }),
    ]);
  });

  it("skips unresolved properties while preserving truthful rows", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin = makeAdmin({
      properties: [{ id: "property-1", org_id: "org-1" }],
    });
    mocks.createAdminClient.mockReturnValue(admin.client);

    await recordLeadEvents([
      {
        propertyId: "missing-property",
        actorType: "system",
        eventType: LEAD_EVENT_TYPES.LEAD_CREATED,
      },
      {
        propertyId: "property-1",
        actorType: "system",
        eventType: LEAD_EVENT_TYPES.QUALIFIED,
      },
    ]);

    expect(admin.eventInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        property_id: "property-1",
        event_type: "qualified",
      }),
    ]);
    expect(log).toHaveBeenCalledWith(
      "[lead-events] skipped unresolved properties",
      { requestedCount: 2, skippedCount: 1 },
    );
  });

  it("chunks property ownership lookups without splitting the event insert", async () => {
    const inputs = Array.from({ length: 251 }, (_, index) => ({
      propertyId: `property-${index}`,
      actorType: "system" as const,
      eventType: LEAD_EVENT_TYPES.QUALIFIED,
    }));
    const admin = makeAdmin({
      propertiesForIds: (ids) =>
        ids.map((id) => ({ id, org_id: `org-${id}` })),
    });
    mocks.createAdminClient.mockReturnValue(admin.client);

    await recordLeadEvents(inputs);

    expect(admin.propertyIn).toHaveBeenCalledTimes(2);
    expect(admin.propertyIn.mock.calls[0]?.[1]).toHaveLength(250);
    expect(admin.propertyIn.mock.calls[1]?.[1]).toHaveLength(1);
    expect(admin.eventInsert).toHaveBeenCalledTimes(1);
    expect(admin.eventInsert.mock.calls[0]?.[0]).toHaveLength(251);
  });

  it("never throws when admin-client creation fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("missing server credentials");
    });

    await expect(
      recordLeadEvent({
        propertyId: "property-1",
        actorType: "system",
        eventType: LEAD_EVENT_TYPES.LEAD_CREATED,
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "[lead-events] append failed",
      expect.objectContaining({ stage: "client", requestedCount: 1 }),
    );
  });

  it("never throws when property lookup returns or throws an error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const admin of [
      makeAdmin({ propertyError: { message: "properties unavailable" } }),
      makeAdmin({ lookupThrows: new Error("lookup crashed") }),
    ]) {
      mocks.createAdminClient.mockReturnValueOnce(admin.client);
      await expect(
        recordLeadEvent({
          propertyId: "property-1",
          actorType: "system",
          eventType: LEAD_EVENT_TYPES.LEAD_CREATED,
        }),
      ).resolves.toBeUndefined();
      expect(admin.eventInsert).not.toHaveBeenCalled();
    }
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("never throws when the lead_events insert returns or throws an error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const admin of [
      makeAdmin({ insertError: { message: "relation lead_events_missing" } }),
      makeAdmin({ insertThrows: new Error("insert crashed") }),
    ]) {
      mocks.createAdminClient.mockReturnValueOnce(admin.client);
      await expect(
        recordLeadEvent({
          propertyId: "property-1",
          actorType: "system",
          eventType: LEAD_EVENT_TYPES.LEAD_CREATED,
          payload: { privateBody: "must never be logged" },
        }),
      ).resolves.toBeUndefined();
    }
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("must never be logged");
  });

  it("does not attempt an insert when no requested property resolves", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin = makeAdmin({ properties: [] });
    mocks.createAdminClient.mockReturnValue(admin.client);

    await recordLeadEvent({
      propertyId: "missing-property",
      actorType: "system",
      eventType: LEAD_EVENT_TYPES.LEAD_CREATED,
    });

    expect(admin.eventInsert).not.toHaveBeenCalled();
  });
});
