import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be hoisted so the module under test sees the mocks at
// import time (not after vi.mock has been registered).
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
const { after } = vi.hoisted(() => ({ after: vi.fn() }));
const { start } = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("next/server", () => ({
  // The implementation is fire-and-forget — for these unit tests we
  // capture the callback synchronously so we can assert it was issued
  // (or not). We do NOT execute the inner workflow.start() — that's
  // what the workflow's own integration test covers.
  after: (fn: () => Promise<void>) => after(fn),
}));

vi.mock("workflow/api", () => ({
  start,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

vi.mock("@/lib/csv/dataset", () => ({
  buildReviewContractSha256: vi.fn().mockResolvedValue("b".repeat(64)),
}));

import { createImportJob } from "./actions";

/**
 * `createImportJob` (post phase 02) makes these sequential supabase
 * calls in the happy path:
 *
 *   0. auth.getUser()                                                  → user
 *   1. from('memberships').select('org_id, role')                         → resolve insert org
 *   2. from('counties').select('id, market').eq('id', countyId).single() → T-02-03-01 validation
 *   3. from('csv_imports').insert(...).select('id, org_id').single()
 *   4. (optional) from('lists') for resolveOrCreateList — skipped here (listName=null)
 *   5. from('jobs').insert(...).select('id').single()
 *
 * The mock builder records each operation so each test can assert what
 * was sent. Tests push per-call responses in order.
 */

type SingleResponse = {
  data: unknown;
  error: { message: string } | null;
};

type CallRecord = {
  table: string;
  op: "select" | "insert" | "update";
  selectArgs?: unknown[];
  insertPayload?: unknown;
  filters: Array<{ op: string; args: unknown[] }>;
};

let responseQueue: SingleResponse[] = [];
let calls: CallRecord[] = [];

function makeBuilder(record: CallRecord): Record<string, unknown> {
  const builder: Record<string, unknown> = {};

  const thenable = {
    then(
      onFulfilled: (value: SingleResponse) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      const resp = responseQueue.shift();
      if (!resp) {
        return Promise.reject(
          new Error(
            `actions.test: no mock response queued for ${record.table}.${record.op}`,
          ),
        ).then(onFulfilled, onRejected);
      }
      return Promise.resolve(resp).then(onFulfilled, onRejected);
    },
  };

  builder.select = (...args: unknown[]) => {
    record.selectArgs = args;
    record.op = record.op === "insert" ? "insert" : "select";
    return builder;
  };
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
  builder.single = () => thenable;
  builder.maybeSingle = () => thenable;
  builder.then = thenable.then;

  return builder;
}

function makeSupabase() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-123" } },
      }),
    },
    from: vi.fn((table: string) => {
      const record: CallRecord = { table, op: "select", filters: [] };
      calls.push(record);
      return makeBuilder(record);
    }),
  };
}

beforeEach(() => {
  createClient.mockReset();
  after.mockReset();
  start.mockReset();
  responseQueue = [];
  calls = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

const baseParams = {
  filename: "deals.csv",
  source: "dealmachine" as const,
  market: "Buchanan County MO", // free string from wizard — server reconciles
  countyId: "11111111-1111-1111-1111-111111111111",
  listName: null,
  mapping: { address: "Address" },
  storagePath: "org-1/import-2026.csv",
  totalRows: 42,
  smsConsent: false,
  sequenceId: null,
  classifyLineTypes: false,
  requestCass: false,
  requestSkipTrace: false,
  maxEstimatedChargeUsd: 0,
  datasetSha256: "a".repeat(64),
  reviewContractSha256: "b".repeat(64),
  datasetVersion: 2,
  dncRows: 0,
};

describe("createImportJob — T-02-03-01 mitigation", () => {
  const membershipResponse = {
    data: [{ org_id: "org-1", role: "owner" }],
    error: null,
  };

  it("queries counties for the supplied countyId before any csv_imports insert", async () => {
    // Happy path: counties row exists, csv_imports + jobs both succeed.
    responseQueue = [
      // 1. memberships.select(...)
      membershipResponse,
      // 2. counties.select(...).eq(id).single()
      {
        data: { id: baseParams.countyId, market: "Buchanan County MO" },
        error: null,
      },
      // 3. csv_imports.insert(...).select.single()
      {
        data: { id: "import-1", org_id: "org-1" },
        error: null,
      },
      // 4. jobs.insert(...).select.single()
      { data: { id: "job-1" }, error: null },
    ];
    createClient.mockResolvedValue(makeSupabase());

    const result = await createImportJob(baseParams);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.jobId).toBe("job-1");

    const countiesCall = calls.find((c) => c.table === "counties");
    expect(countiesCall).toBeDefined();
    expect(countiesCall!.filters).toContainEqual({
      op: "eq",
      args: ["id", baseParams.countyId],
    });

    // The csv_imports insert must run AFTER the counties read.
    const csvImportCall = calls.find((c) => c.table === "csv_imports");
    expect(csvImportCall).toBeDefined();
    expect(calls.indexOf(csvImportCall!)).toBeGreaterThan(
      calls.findIndex((c) => c.table === "counties"),
    );
  });

  it("uses county.market (NOT params.market) when persisting csv_imports", async () => {
    // Stage a counties row whose market differs from what the client sent.
    // The action MUST trust the DB row, not the client string.
    responseQueue = [
      membershipResponse,
      {
        data: {
          id: baseParams.countyId,
          // Server-side canonical value:
          market: "Buchanan County MO",
        },
        error: null,
      },
      { data: { id: "import-1", org_id: "org-1" }, error: null },
      { data: { id: "job-1" }, error: null },
    ];
    createClient.mockResolvedValue(makeSupabase());

    await createImportJob({ ...baseParams, market: "I LIED Bogus Market" });

    // The csv_imports insert payload must contain the server-derived
    // market AND the FK to the resolved county.
    const csvCall = calls.find((c) => c.table === "csv_imports");
    expect(csvCall).toBeDefined();
    const payload = csvCall!.insertPayload as Record<string, unknown>;
    expect(payload.market).toBe("Buchanan County MO");
    expect(payload.county_id).toBe(baseParams.countyId);
    expect(payload.org_id).toBe("org-1");
    // jobs insert mirrors the same canonical strings.
    const jobCall = calls.find((c) => c.table === "jobs");
    const jobPayload = jobCall!.insertPayload as Record<string, unknown>;
    expect(jobPayload.org_id).toBe("org-1");
    const inputParams = jobPayload.input_params as Record<string, unknown>;
    expect(inputParams.market).toBe("Buchanan County MO");
    expect(inputParams.countyId).toBe(baseParams.countyId);
  });

  it("returns INVALID_COUNTY and inserts NOTHING when the countyId is unknown", async () => {
    // counties.select returns no row.
    responseQueue = [membershipResponse, { data: null, error: null }];
    createClient.mockResolvedValue(makeSupabase());

    const result = await createImportJob({
      ...baseParams,
      countyId: "00000000-0000-0000-0000-000000000000",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_COUNTY");
    expect(result.error.message).toBe("Invalid county");

    // No csv_imports / jobs writes occurred.
    expect(calls.find((c) => c.table === "csv_imports")).toBeUndefined();
    expect(calls.find((c) => c.table === "jobs")).toBeUndefined();
    // No workflow start was queued.
    expect(after).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("returns INVALID_COUNTY when the counties query errors (e.g. cross-org RLS reject)", async () => {
    responseQueue = [
      membershipResponse,
      // RLS-denied / not-found shape from the postgrest builder.
      { data: null, error: { message: "no rows returned" } },
    ];
    createClient.mockResolvedValue(makeSupabase());

    const result = await createImportJob(baseParams);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_COUNTY");
  });

  it("fails closed instead of choosing an arbitrary organization membership", async () => {
    responseQueue = [{
      data: [
        { org_id: "org-1", role: "owner" },
        { org_id: "org-2", role: "member" },
      ],
      error: null,
    }];
    createClient.mockResolvedValue(makeSupabase());

    const result = await createImportJob(baseParams);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ORG_SELECTION_REQUIRED");
    expect(calls.find((call) => call.table === "csv_imports")).toBeUndefined();
  });

  it("rejects a storage object outside the resolved organization prefix", async () => {
    responseQueue = [membershipResponse];
    createClient.mockResolvedValue(makeSupabase());

    const result = await createImportJob({
      ...baseParams,
      storagePath: "org-2/reviewed.csv",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("IMPORT_STORAGE_SCOPE_MISMATCH");
    expect(calls.find((call) => call.table === "csv_imports")).toBeUndefined();
  });

  it("threads countyId into the workflow start payload", async () => {
    responseQueue = [
      membershipResponse,
      {
        data: { id: baseParams.countyId, market: "Buchanan County MO" },
        error: null,
      },
      { data: { id: "import-1", org_id: "org-1" }, error: null },
      { data: { id: "job-1" }, error: null },
    ];
    createClient.mockResolvedValue(makeSupabase());

    await createImportJob(baseParams);

    // `after()` was called with a callback that invokes `start()`.
    // Drain it synchronously to read the payload.
    expect(after).toHaveBeenCalledTimes(1);
    const cb = after.mock.calls[0][0] as () => Promise<void>;
    await cb();
    expect(start).toHaveBeenCalledTimes(1);
    const startArgs = start.mock.calls[0][1] as unknown as Array<
      Record<string, unknown>
    >;
    const wfPayload = startArgs[0];
    expect(wfPayload.market).toBe("Buchanan County MO");
    expect(wfPayload.countyId).toBe(baseParams.countyId);
  });
});
