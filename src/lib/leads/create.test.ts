import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const eventMocks = vi.hoisted(() => ({ recordLeadEvent: vi.fn() }));

vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { LEAD_CREATED: "lead_created" },
  recordLeadEvent: eventMocks.recordLeadEvent,
}));

// `createLead` is the shared write path used by the lead-import webhook
// and the manual entry form. The unit test here verifies the new D-04
// behavior: `input.property.county_id` flows into the property insert
// alongside `market`. The full dedup / contact-resolve / address-norm
// surface is covered by `create.integration.test.ts` against a real
// Postgres — this file is scoped to the new invariant.

vi.mock("@/lib/csv/normalize", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/csv/normalize")
  >("@/lib/csv/normalize");
  return actual;
});

import { createLead } from "./create";

const ORG_ID = "00000000-0000-0000-0000-000000000bbb";

type Response = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

type CallRecord = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  insertPayload?: unknown;
  filters: Array<{ op: string; args: unknown[] }>;
};

let responseQueue: Response[] = [];
let calls: CallRecord[] = [];

function makeBuilder(record: CallRecord): Record<string, unknown> {
  const builder: Record<string, unknown> = {};

  const thenable = {
    then(
      onFulfilled: (v: Response) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) {
      const resp = responseQueue.shift();
      if (!resp) {
        return Promise.reject(
          new Error(
            `create.test: no mock response queued for ${record.table}.${record.op}`,
          ),
        ).then(onFulfilled, onRejected);
      }
      return Promise.resolve(resp).then(onFulfilled, onRejected);
    },
  };

  builder.select = () => builder;
  builder.insert = (payload: unknown) => {
    record.insertPayload = payload;
    record.op = "insert";
    return builder;
  };
  builder.update = (payload: unknown) => {
    record.insertPayload = payload;
    record.op = "update";
    return builder;
  };
  builder.delete = () => {
    record.op = "delete";
    return builder;
  };
  builder.eq = (...args: unknown[]) => {
    record.filters.push({ op: "eq", args });
    return builder;
  };
  builder.ilike = (...args: unknown[]) => {
    record.filters.push({ op: "ilike", args });
    return builder;
  };
  builder.is = (...args: unknown[]) => {
    record.filters.push({ op: "is", args });
    return builder;
  };
  builder.limit = () => builder;
  builder.single = () => thenable;
  builder.maybeSingle = () => thenable;
  builder.then = thenable.then;

  return builder;
}

function makeSupabase() {
  return {
    from: vi.fn((table: string) => {
      const record: CallRecord = { table, op: "select", filters: [] };
      calls.push(record);
      return makeBuilder(record);
    }),
  };
}

beforeEach(() => {
  responseQueue = [];
  calls = [];
  eventMocks.recordLeadEvent.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createLead — phase 02 D-04 county_id pass-through", () => {
  it("includes county_id and market on the property insert when both supplied", async () => {
    // address dedup: no existing property → triggers the insert path.
    responseQueue = [
      { data: null, error: null }, // properties.select(addr_norm).maybeSingle → null
      { data: { id: "prop-new" }, error: null }, // properties.insert(...).select.single
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: ORG_ID,
        source: "referral",
        property: {
          address: "999 Lake Drive",
          state: "MO",
          market: "Buchanan County MO",
          county_id: "buchanan-county-id",
        },
        assignedUserId: "teammate-id",
        motivationLevel: "hot",
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const propertyInsert = calls.find(
      (c) => c.table === "properties" && c.op === "insert",
    );
    expect(propertyInsert).toBeDefined();
    const payload = propertyInsert!.insertPayload as Record<string, unknown>;
    expect(payload.market).toBe("Buchanan County MO");
    expect(payload.county_id).toBe("buchanan-county-id");
    expect(payload.assigned_user_id).toBe("teammate-id");
    expect(payload.motivation_level).toBe("hot");
    expect(eventMocks.recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "prop-new",
      actorType: "system",
      eventType: "lead_created",
      payload: { source: "referral" },
      sourceType: "properties.created",
      sourceId: "prop-new",
    });
  });

  it("sets county_id to null when not supplied (webhook payloads etc.)", async () => {
    responseQueue = [
      { data: null, error: null }, // address dedup miss
      { data: { id: "prop-new-2" }, error: null }, // insert
    ];

    await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: ORG_ID,
        source: "web_form",
        property: {
          address: "1 Webhook Way",
          state: "KS",
          // No market, no county_id — webhook shape.
        },
      },
    );

    const propertyInsert = calls.find(
      (c) => c.table === "properties" && c.op === "insert",
    );
    expect(propertyInsert).toBeDefined();
    const payload = propertyInsert!.insertPayload as Record<string, unknown>;
    expect(payload.county_id).toBeNull();
    // Existing market behavior unchanged: null when not supplied.
    expect(payload.market).toBeNull();
  });

  it("resolves the homeowner before inserting one complete property row", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: "contact-complete" }, error: null },
      { data: { id: "prop-complete" }, error: null },
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: ORG_ID,
        source: "referral",
        property: { address: "9 Complete Way", state: "MO" },
        contact: { first_name: "Ready", last_name: "Owner" },
      },
    );

    expect(result.ok).toBe(true);
    const inserts = calls.filter((call) => call.op === "insert");
    expect(inserts.map((call) => call.table)).toEqual(["contacts", "properties"]);
    expect(inserts[1]?.insertPayload).toEqual(
      expect.objectContaining({ homeowner_contact_id: "contact-complete" }),
    );
    expect(calls.some((call) => call.op === "update")).toBe(false);
  });

  it("turns a unique-address insert race into an explicit duplicate before contact creation", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: "contact-race-loser" }, error: null },
      {
        data: null,
        error: {
          code: "23505",
          message: "duplicate key value violates unique constraint",
        },
      },
      {
        data: { id: "prop-race-winner" },
        error: null,
      },
      { data: null, error: null },
      { data: { id: "contact-race-loser" }, error: null },
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: ORG_ID,
        source: "referral",
        property: { address: "10 Race Way", state: "MO" },
        contact: { first_name: "Would", last_name: "Orphan" },
      },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        propertyId: "prop-race-winner",
        wasDuplicate: true,
        contactId: null,
        phoneUnverified: false,
      },
    });
    expect(
      calls.some(
        (call) => call.table === "contacts" && call.op === "delete",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.table === "properties" && call.op === "delete",
      ),
    ).toBe(false);
  });

  it("does not expose a property when contact creation fails", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: { message: "contact insert failed" } },
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: ORG_ID,
        source: "referral",
        property: { address: "10 Contact First Way", state: "MO" },
        contact: { first_name: "Fail", last_name: "Before property" },
      },
    );

    expect(result.ok).toBe(false);
    expect(
      calls.some(
        (call) => call.table === "properties" && call.op === "insert",
      ),
    ).toBe(false);
  });

  it("cleans only its new unreferenced contact after property insert failure so retry can succeed", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: "contact-new" }, error: null },
      { data: null, error: { message: "property insert failed" } },
      { data: null, error: null },
      { data: { id: "contact-new" }, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: "contact-retry" }, error: null },
      { data: { id: "prop-retry" }, error: null },
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: ORG_ID,
        source: "referral",
        property: { address: "11 Insert Failure Way", state: "MO" },
        contact: { first_name: "New", last_name: "Owner" },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INSERT_FAILED");
    expect(
      calls.some(
        (call) => call.table === "properties" && call.op === "delete",
      ),
    ).toBe(false);
    expect(
      calls.some(
        (call) => call.table === "contacts" && call.op === "delete",
      ),
    ).toBe(true);

    const retry = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: ORG_ID,
        source: "referral",
        property: { address: "11 Insert Failure Way", state: "MO" },
        contact: { first_name: "New", last_name: "Owner" },
      },
    );
    expect(retry).toEqual({
      ok: true,
      data: {
        propertyId: "prop-retry",
        wasDuplicate: false,
        contactId: "contact-retry",
        phoneUnverified: false,
      },
    });
  });

  it("never cleans a reused contact when the property insert fails", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: { id: "contact-existing" }, error: null },
      { data: null, error: { message: "property insert failed" } },
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: ORG_ID,
        source: "referral",
        property: { address: "12 Reused Contact Way", state: "MO" },
        contact: { first_name: "New", last_name: "Owner" },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INSERT_FAILED");
    expect(calls.some((call) => call.table === "contacts" && call.op === "delete")).toBe(false);
  });

  it("returns repair-needed when new-contact cleanup cannot be verified", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: "contact-repair" }, error: null },
      { data: null, error: { message: "property insert failed" } },
      { data: null, error: null },
      { data: null, error: { message: "contact delete failed" } },
      { data: { id: "contact-repair" }, error: null },
      { data: null, error: null },
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: ORG_ID,
        source: "referral",
        property: { address: "13 Repair Way", state: "MO" },
        contact: { first_name: "New", last_name: "Owner" },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPAIR_REQUIRED");
      expect(result.error.message).toContain("contact-repair");
    }
  });

  it("scopes every property and contact read/write to the requested organization", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: { id: "contact-org" }, error: null },
      { data: { id: "prop-org" }, error: null },
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: ORG_ID,
        source: "referral",
        property: { address: "14 Tenant Safe Way", state: "MO" },
        contact: { email: "same@example.test" },
      } as Parameters<typeof createLead>[1],
    );

    expect(result.ok).toBe(true);
    for (const call of calls) {
      if (call.table !== "properties" && call.table !== "contacts") continue;
      if (call.op === "insert") {
        expect(call.insertPayload).toEqual(expect.objectContaining({ org_id: ORG_ID }));
      } else {
        expect(call.filters).toContainEqual({ op: "eq", args: ["org_id", ORG_ID] });
      }
    }
  });
});
