import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("turns a unique-address insert race into an explicit duplicate before contact creation", async () => {
    responseQueue = [
      { data: null, error: null },
      {
        data: null,
        error: {
          code: "23505",
          message: "duplicate key value violates unique constraint",
        },
      },
      {
        data: { id: "prop-race-winner", homeowner_contact_id: null },
        error: null,
      },
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
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
        phoneDropped: null,
      },
    });
    expect(calls.filter((call) => call.table === "contacts")).toHaveLength(0);
  });

  it("cleans the claimed property and new contact after attach failure so retry can succeed", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: { id: "prop-new" }, error: null },
      { data: null, error: null },
      { data: { id: "contact-new" }, error: null },
      { data: null, error: null },
      { data: { id: "prop-new" }, error: null },
      { data: { id: "contact-new" }, error: null },
      { data: null, error: null },
      { data: { id: "prop-retry" }, error: null },
      { data: null, error: null },
      { data: { id: "contact-retry" }, error: null },
      { data: { id: "prop-retry" }, error: null },
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        source: "referral",
        property: { address: "11 Attach Race Way", state: "MO" },
        contact: { first_name: "New", last_name: "Owner" },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL");
    expect(
      calls.some(
        (call) => call.table === "properties" && call.op === "delete",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.table === "contacts" && call.op === "delete",
      ),
    ).toBe(true);

    const retry = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        source: "referral",
        property: { address: "11 Attach Race Way", state: "MO" },
        contact: { first_name: "New", last_name: "Owner" },
      },
    );
    expect(retry).toEqual({
      ok: true,
      data: {
        propertyId: "prop-retry",
        wasDuplicate: false,
        contactId: "contact-retry",
        phoneDropped: null,
      },
    });
  });

  it("cleans the claimed property after contact creation fails so retry can succeed", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: { id: "prop-contact-failure" }, error: null },
      { data: null, error: null },
      { data: null, error: { message: "contact insert failed" } },
      { data: { id: "prop-contact-failure" }, error: null },
      { data: null, error: null },
      { data: { id: "prop-retry" }, error: null },
      { data: null, error: null },
      { data: { id: "contact-retry" }, error: null },
      { data: { id: "prop-retry" }, error: null },
    ];

    const first = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        source: "referral",
        property: { address: "12 Contact Failure Way", state: "MO" },
        contact: { first_name: "New", last_name: "Owner" },
      },
    );
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("INTERNAL");
    expect(
      calls.some(
        (call) => call.table === "properties" && call.op === "delete",
      ),
    ).toBe(true);

    const retry = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        source: "referral",
        property: { address: "12 Contact Failure Way", state: "MO" },
        contact: { first_name: "New", last_name: "Owner" },
      },
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.data.wasDuplicate).toBe(false);
  });

  it("returns repair-needed when compensating property cleanup cannot be verified", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: { id: "prop-repair" }, error: null },
      { data: null, error: null },
      { data: null, error: { message: "contact insert failed" } },
      { data: null, error: { message: "property delete failed" } },
    ];

    const result = await createLead(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        source: "referral",
        property: { address: "13 Repair Way", state: "MO" },
        contact: { first_name: "New", last_name: "Owner" },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPAIR_REQUIRED");
      expect(result.error.message).toContain("prop-repair");
    }
  });
});
