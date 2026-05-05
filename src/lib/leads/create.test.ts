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

// eslint-disable-next-line import/first
import { createLead } from "./create";

type Response = { data: unknown; error: { message: string } | null };

type CallRecord = {
  table: string;
  op: "select" | "insert" | "update";
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
});
