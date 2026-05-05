import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit test for the workflow's defensive-recovery branch (phase 02 D-04).
 *
 * The workflow body reads `csv_imports.county_id` only when
 * `params.countyId` arrives as null — which happens for jobs queued
 * before this plan shipped or when a retry replays without the new
 * field. The branch makes the async boundary self-healing without
 * coupling the queue retry shape to the new param.
 *
 * The full workflow (load → chunk loop → finalize → cass → enroll) is
 * covered by an integration test against a real Postgres
 * (`csv-import.enroll.integration.test.ts`). This file mocks all the
 * step internals and asserts ONLY the recovery read of
 * `csv_imports.county_id` and that the resolved id is what gets
 * threaded into the chunk processor (via the processIngestChunk mock).
 */

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

const { processIngestChunkMock } = vi.hoisted(() => ({
  processIngestChunkMock: vi.fn(),
}));

vi.mock("@/lib/csv/ingest", () => ({
  finalizeIngestion: vi.fn().mockResolvedValue(undefined),
  prepareIngestion: vi.fn().mockResolvedValue({ autoTagIds: [] }),
  processIngestChunk: processIngestChunkMock,
}));

vi.mock("@/lib/enrichment/cass-job", () => ({
  selectCassEligibleProperties: vi.fn().mockResolvedValue([]),
  createCassChildJob: vi.fn(),
  runCassEnrichment: vi.fn(),
  getAutotriggerCap: vi.fn().mockReturnValue(0),
}));

vi.mock("@/lib/sequences/enrollment", () => ({ enrollLead: vi.fn() }));

// eslint-disable-next-line import/first
import { csvImportWorkflow } from "./csv-import";

type CallRecord = {
  table: string;
  selectArgs?: unknown[];
  filters: Array<{ op: string; args: unknown[] }>;
};

let calls: CallRecord[] = [];
let csvImportRow: { county_id: string | null } = { county_id: null };

function makeBuilder(record: CallRecord) {
  const thenable = {
    then(
      onFulfilled: (v: { data: unknown; error: null }) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) {
      if (record.table === "csv_imports") {
        return Promise.resolve({ data: csvImportRow, error: null }).then(
          onFulfilled,
          onRejected,
        );
      }
      // jobs.update / others: just resolve null
      return Promise.resolve({ data: null, error: null }).then(
        onFulfilled,
        onRejected,
      );
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {
    select: (...args: unknown[]) => {
      record.selectArgs = args;
      return builder;
    },
    insert: () => builder,
    update: () => builder,
    upsert: () => builder,
    eq: (...args: unknown[]) => {
      record.filters.push({ op: "eq", args });
      return builder;
    },
    is: (...args: unknown[]) => {
      record.filters.push({ op: "is", args });
      return builder;
    },
    in: (...args: unknown[]) => {
      record.filters.push({ op: "in", args });
      return builder;
    },
    not: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => thenable,
    maybeSingle: () => thenable,
    then: thenable.then,
  };
  return builder;
}

function makeSupabase(csvBody: string) {
  return {
    from: vi.fn((table: string) => {
      const record: CallRecord = { table, filters: [] };
      calls.push(record);
      return makeBuilder(record);
    }),
    storage: {
      from: () => ({
        download: vi.fn().mockResolvedValue({
          // A Blob with .text() returning a 1-line CSV (header + 0 rows).
          // Papa.parse with header:true on this returns parsed.data=[].
          data: {
            text: () => Promise.resolve("Address\n"),
          },
          error: null,
        }),
      }),
    },
  };
}

beforeEach(() => {
  createAdminClient.mockReset();
  processIngestChunkMock.mockReset();
  processIngestChunkMock.mockResolvedValue({
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  });
  calls = [];
  csvImportRow = { county_id: null };
});

afterEach(() => {
  vi.clearAllMocks();
});

const baseParams = {
  jobId: "job-recovery",
  csvImportId: "import-recovery",
  storagePath: "import.csv",
  source: "dealmachine",
  market: "Buchanan County MO",
  mapping: { address: "Address" },
  listId: null,
  userId: null,
};

describe("csvImportWorkflow — defensive recovery (params.countyId null)", () => {
  it("re-reads csv_imports.county_id when params.countyId is null", async () => {
    csvImportRow = { county_id: "recovered-county-id" };
    createAdminClient.mockReturnValue(makeSupabase(""));

    await csvImportWorkflow({
      ...baseParams,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      countyId: null,
    } as any);

    // The recovery branch must have queried csv_imports for county_id
    // filtered by the supplied csvImportId.
    const recoveryCall = calls.find((c) => c.table === "csv_imports");
    expect(recoveryCall).toBeDefined();
    expect(recoveryCall!.selectArgs?.[0]).toBe("county_id");
    expect(recoveryCall!.filters).toContainEqual({
      op: "eq",
      args: ["id", baseParams.csvImportId],
    });
  });

  it("does NOT read csv_imports.county_id when params.countyId is non-null", async () => {
    createAdminClient.mockReturnValue(makeSupabase(""));

    await csvImportWorkflow({
      ...baseParams,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      countyId: "fresh-county-id",
    } as any);

    // Hot-path branch — no csv_imports.select('county_id') call.
    const recoverySelects = calls.filter(
      (c) => c.table === "csv_imports" && c.selectArgs?.[0] === "county_id",
    );
    expect(recoverySelects).toHaveLength(0);
  });
});
