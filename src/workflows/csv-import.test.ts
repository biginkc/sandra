import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { reviewContractJson } from "@/lib/csv/dataset-contract";

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

const { processIngestChunkMock, finalizeIngestionMock, prepareIngestionMock } =
  vi.hoisted(() => ({
    processIngestChunkMock: vi.fn(),
    finalizeIngestionMock: vi.fn(),
    prepareIngestionMock: vi.fn(),
  }));

vi.mock("@/lib/csv/ingest", () => ({
  finalizeIngestion: finalizeIngestionMock,
  prepareIngestion: prepareIngestionMock,
  processIngestChunk: processIngestChunkMock,
}));

vi.mock("@/lib/enrichment/cass-job", () => ({
  selectCassEligibleProperties: vi.fn().mockResolvedValue([]),
  createCassChildJob: vi.fn(),
  runCassEnrichment: vi.fn(),
  getAutotriggerCap: vi.fn().mockReturnValue(0),
}));

vi.mock("@/lib/sequences/enrollment", () => ({ enrollLead: vi.fn() }));

import { csvImportWorkflow, type CsvImportWorkflowParams } from "./csv-import";

type CallRecord = {
  table: string;
  selectArgs?: unknown[];
  filters: Array<{ op: string; args: unknown[] }>;
};

let calls: CallRecord[] = [];
let csvImportRow: { county_id: string | null } = { county_id: null };
let rpcCalls: Array<{ name: string; args: unknown }> = [];

function makeBuilder(record: CallRecord) {
  const thenable = {
    then(
      onFulfilled: (v: { data: unknown; error: null }) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) {
      if (record.table === "csv_imports") {
        return Promise.resolve({
          data: {
            ...csvImportRow,
            storage_path: baseParams.storagePath,
            source: baseParams.source,
            market: baseParams.market,
            dataset_sha256: baseParams.datasetSha256,
          },
          error: null,
        }).then(onFulfilled, onRejected);
      }
      if (
        record.table === "jobs" &&
        record.selectArgs?.[0]?.toString().includes("related_import_id")
      ) {
        return Promise.resolve({
          data: {
            id: baseParams.jobId,
            org_id: baseParams.orgId,
            type: "csv_import",
            related_import_id: baseParams.csvImportId,
          },
          error: null,
        }).then(onFulfilled, onRejected);
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
            text: () => Promise.resolve(csvBody),
          },
          error: null,
        }),
      }),
    },
    rpc: vi.fn((name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: {}, error: null });
    }),
  };
}

beforeEach(() => {
  createAdminClient.mockReset();
  processIngestChunkMock.mockReset();
  prepareIngestionMock.mockReset();
  prepareIngestionMock.mockResolvedValue({ autoTagIds: [] });
  finalizeIngestionMock.mockReset();
  finalizeIngestionMock.mockResolvedValue(undefined);
  processIngestChunkMock.mockResolvedValue({
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  });
  calls = [];
  rpcCalls = [];
  csvImportRow = { county_id: null };
});

afterEach(() => {
  vi.clearAllMocks();
});

const datasetSha256 =
  "a31d3d3ecb2bd1ea03234e3dceacedbcf4758b5742da29afe6146d15b8f6d2e6";
const mapping = { address: "Address" };
const reviewContractSha256 = createHash("sha256")
  .update(
    reviewContractJson({
      datasetSha256,
      mapping,
      source: "dealmachine",
      countyId: "recovered-county-id",
      totalRows: 1,
      dncRows: 0,
      smsConsent: false,
      sequenceId: null,
      classifyLineTypes: false,
      requestCass: false,
      requestSkipTrace: false,
    }),
  )
  .digest("hex");

const baseParams = {
  jobId: "job-recovery",
  csvImportId: "import-recovery",
  orgId: "org-1",
  storagePath: "org-1/import.csv",
  source: "dealmachine",
  market: "Buchanan County MO",
  mapping,
  listId: null,
  userId: null,
  datasetSha256,
  reviewContractSha256,
  datasetVersion: 2,
  expectedTotalRows: 1,
  expectedDncRows: 0,
  requestSkipTrace: false,
} satisfies Omit<CsvImportWorkflowParams, "countyId">;

describe("csvImportWorkflow — defensive recovery (params.countyId null)", () => {
  it("re-reads csv_imports.county_id when params.countyId is null", async () => {
    csvImportRow = { county_id: "recovered-county-id" };
    createAdminClient.mockReturnValue(makeSupabase("Address\n"));

    await csvImportWorkflow({
      ...baseParams,
      countyId: null,
    });

    // The recovery branch must have queried csv_imports for county_id
    // filtered by the supplied csvImportId.
    const recoveryCall = calls.find((c) => c.table === "csv_imports");
    expect(recoveryCall).toBeDefined();
    expect(recoveryCall!.selectArgs?.[0]?.toString()).toContain("county_id");
    expect(recoveryCall!.filters).toContainEqual({
      op: "eq",
      args: ["id", baseParams.csvImportId],
    });
  });

  it("still validates authoritative import identity when params.countyId is non-null", async () => {
    createAdminClient.mockReturnValue(makeSupabase("Address\n"));
    const countyId = "fresh-county-id";
    csvImportRow = { county_id: countyId };
    const countyReviewContractSha256 = createHash("sha256")
      .update(
        reviewContractJson({
          datasetSha256,
          mapping,
          source: "dealmachine",
          countyId,
          totalRows: 1,
          dncRows: 0,
          smsConsent: false,
          sequenceId: null,
          classifyLineTypes: false,
          requestCass: false,
          requestSkipTrace: false,
        }),
      )
      .digest("hex");

    await csvImportWorkflow({
      ...baseParams,
      countyId,
      reviewContractSha256: countyReviewContractSha256,
    });

    // The read is deliberate: it prevents a forged workflow payload from
    // crossing jobs/imports/organizations even when countyId is present.
    const recoverySelects = calls.filter(
      (c) =>
        c.table === "csv_imports" &&
        c.selectArgs?.[0]?.toString().includes("county_id"),
    );
    expect(recoverySelects).toHaveLength(1);
  });

  it("checkpoints an exhausted failure before prepare", async () => {
    const supabase = makeSupabase("Address\n");
    supabase.storage.from = () => ({
      download: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: "storage down" } }),
    });
    csvImportRow = { county_id: "recovered-county-id" };
    createAdminClient.mockReturnValue(supabase);

    await expect(
      csvImportWorkflow({ ...baseParams, countyId: null }),
    ).rejects.toThrow("storage down");
    expect(
      rpcCalls.some((call) => call.name === "fail_csv_import_workflow"),
    ).toBe(true);
  });

  it("checkpoints an exhausted failure in a row chunk", async () => {
    csvImportRow = { county_id: "recovered-county-id" };
    createAdminClient.mockReturnValue(makeSupabase("Address\n"));
    processIngestChunkMock.mockRejectedValue(new Error("chunk database down"));

    await expect(
      csvImportWorkflow({ ...baseParams, countyId: null }),
    ).rejects.toThrow("chunk database down");
    expect(
      rpcCalls.some((call) => call.name === "fail_csv_import_workflow"),
    ).toBe(true);
  });

  it("checkpoints an exhausted failure during finalization", async () => {
    csvImportRow = { county_id: "recovered-county-id" };
    createAdminClient.mockReturnValue(makeSupabase("Address\n"));
    finalizeIngestionMock.mockRejectedValue(new Error("final checkpoint down"));

    await expect(
      csvImportWorkflow({ ...baseParams, countyId: null }),
    ).rejects.toThrow("final checkpoint down");
    expect(
      rpcCalls.some((call) => call.name === "fail_csv_import_workflow"),
    ).toBe(true);
  });
});
