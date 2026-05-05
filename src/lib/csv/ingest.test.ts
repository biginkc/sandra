import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `processIngestChunk` is the workflow-level entry point. The unit test
// here verifies the countyId thread-through into the property insert.
// The full per-row dedup / contact / list / tag plumbing is covered by
// `ingest.integration.test.ts` against a real Postgres — this file is
// deliberately scoped to the new D-04 invariant.

vi.mock("./fips", () => ({
  // resolveFips reads `fips_codes` from the DB. For this unit test we
  // never need the real result — return a fixed string so the property
  // insert payload assertions stay stable.
  resolveFips: vi.fn().mockResolvedValue("29021"), // Buchanan County MO
}));

// eslint-disable-next-line import/first
import { processIngestChunk } from "./ingest";

type Response = { data: unknown; error: { message: string } | null };

type CallRecord = {
  table: string;
  op: "select" | "insert" | "upsert" | "update";
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
            `ingest.test: no mock response queued for ${record.table}.${record.op}`,
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
  builder.upsert = (payload: unknown) => {
    record.insertPayload = payload;
    record.op = "upsert";
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
  builder.in = (...args: unknown[]) => {
    record.filters.push({ op: "in", args });
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

describe("processIngestChunk → ingestRow countyId thread-through (phase 02 D-04)", () => {
  it("includes county_id alongside market on the property insert payload", async () => {
    // Single-row chunk; the wizard chose Buchanan County MO and threaded
    // the FK down through the workflow. The property insert MUST set
    // both market AND county_id together.
    const row = {
      Address: "123 Main St",
      State: "MO",
      Zip: "64015",
    };

    // processIngestChunk → validateRow (pure) → ingestRow
    //   ingestRow does not touch contacts (no homeowner/agent fields)
    //   then runs the dedup cascade — for a fresh address every cascade
    //   step queries for an existing match. None will be found here, so
    //   the worker reaches the property insert at line ~441.
    //
    // Sequence of mocked supabase calls in order:
    //   1. findExistingProperty: no fipsCode+apn → skip
    //      (no DB call because both keys would have to be present)
    //   2. findExistingProperty: zpid → null → skip (zpid absent)
    //   3. findExistingProperty: mlsNumber → null → skip (absent)
    //   4. findExistingProperty: addressNormalized → maybeSingle → null
    //   5. properties.insert(...).select.single → new id
    //   6. job_items.insert
    //   7. jobs.update (heartbeat / progress)
    responseQueue = [
      { data: null, error: null }, // 4. address dedup miss
      { data: { id: "prop-new" }, error: null }, // 5. property insert
      { data: null, error: null }, // 6. job_items insert
      { data: null, error: null }, // 7. jobs progress update
    ];

    await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        jobId: "job-1",
        csvImportId: "import-1",
        source: "dealmachine",
        market: "Buchanan County MO",
        countyId: "buchanan-county-id",
        mapping: {
          address: "Address",
          state: "State",
          zip: "Zip",
        },
        rows: [row],
        offset: 0,
        autoTagIds: [],
        listId: null,
        userId: null,
      },
    );

    const propertyInsert = calls.find(
      (c) => c.table === "properties" && c.op === "insert",
    );
    expect(propertyInsert).toBeDefined();
    const payload = propertyInsert!.insertPayload as Record<string, unknown>;
    expect(payload.market).toBe("Buchanan County MO");
    expect(payload.county_id).toBe("buchanan-county-id");
  });

  it("passes county_id=null straight through when the workflow params do not provide it", async () => {
    // Defensive recovery branch failed (csv_imports.county_id was also
    // null) — the worker must still ingest the row, leaving county_id
    // null on the property. market is the only fallback the row keeps.
    const row = {
      Address: "456 Elm Ave",
      State: "KS",
      Zip: "66101",
    };
    responseQueue = [
      { data: null, error: null }, // address dedup miss
      { data: { id: "prop-new-2" }, error: null }, // insert
      { data: null, error: null }, // job_items insert
      { data: null, error: null }, // jobs heartbeat
    ];

    await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        jobId: "job-1",
        csvImportId: "import-1",
        source: "dealmachine",
        market: "Johnson County KS",
        countyId: null,
        mapping: { address: "Address", state: "State", zip: "Zip" },
        rows: [row],
        offset: 0,
        autoTagIds: [],
        listId: null,
        userId: null,
      },
    );

    const propertyInsert = calls.find(
      (c) => c.table === "properties" && c.op === "insert",
    );
    expect(propertyInsert).toBeDefined();
    const payload = propertyInsert!.insertPayload as Record<string, unknown>;
    expect(payload.market).toBe("Johnson County KS");
    expect(payload.county_id).toBeNull();
  });
});
