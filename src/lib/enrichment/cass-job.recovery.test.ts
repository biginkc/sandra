import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyPropertyAddress = vi.hoisted(() => vi.fn());
vi.mock("./verify-property", () => ({ verifyPropertyAddress }));
vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchJobCompleted: vi.fn(),
}));

import { runCassChunk, type CassJobSummary } from "./cass-job";

function summary(): CassJobSummary {
  return {
    total: 1,
    verified: 0,
    invalid: 0,
    ambiguous: 0,
    cacheHits: 0,
    failed: 0,
    providerOff: 0,
    dncSkipped: 0,
    retryableFailures: 0,
    savedResultFailures: 0,
    manualReconciliation: 0,
  };
}

function client() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn(() => ({
    eq: vi.fn().mockResolvedValue({ error: null }),
  }));
  return {
    supabase: {
      from: vi.fn((table: string) => {
        if (table === "job_items") return { upsert };
        if (table === "jobs") return { update };
        throw new Error(`unexpected table ${table}`);
      }),
    },
    upsert,
  };
}

describe("CASS recovery item ledger", () => {
  beforeEach(() => verifyPropertyAddress.mockReset());

  it("makes a saved provider result retryable and records an idempotent item key", async () => {
    verifyPropertyAddress.mockResolvedValue({
      status: "provider_persist_failed",
      propertyId: "property-1",
      error: "database unavailable",
      verified: {
        standardized: "1 Main St",
        cassStatus: "verified",
        components: {},
        raw: {},
      },
    });
    const { supabase, upsert } = client();

    const result = await runCassChunk(supabase as never, {
      jobId: "job-1",
      propertyIds: ["property-1"],
      processedBefore: 0,
      summary: summary(),
      expectedOrgId: "org-1",
    });

    expect(result).toMatchObject({
      failed: 1,
      retryableFailures: 1,
      savedResultFailures: 1,
      manualReconciliation: 0,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        item_key: "property-1",
        status: "error",
        error_class: "provider_persist_failed",
      }),
      { onConflict: "job_id,item_key" },
    );
  });

  it("keeps an uncertain submission manual-only", async () => {
    verifyPropertyAddress.mockResolvedValue({
      status: "submission_unknown",
      propertyId: "property-1",
      error: "connection closed",
    });
    const { supabase, upsert } = client();

    const result = await runCassChunk(supabase as never, {
      jobId: "job-1",
      propertyIds: ["property-1"],
      processedBefore: 0,
      summary: summary(),
      expectedOrgId: "org-1",
    });

    expect(result).toMatchObject({
      failed: 1,
      retryableFailures: 0,
      manualReconciliation: 1,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        error_class: "submission_unknown",
      }),
      { onConflict: "job_id,item_key" },
    );
  });

  it("does not advertise a durable provider no-result as retryable", async () => {
    verifyPropertyAddress.mockResolvedValue({
      status: "no_result",
      propertyId: "property-1",
    });
    const { supabase, upsert } = client();

    const result = await runCassChunk(supabase as never, {
      jobId: "job-1",
      propertyIds: ["property-1"],
      processedBefore: 0,
      summary: summary(),
      expectedOrgId: "org-1",
    });

    expect(result.retryableFailures).toBe(0);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        error_class: "provider_no_result",
      }),
      { onConflict: "job_id,item_key" },
    );
  });
});
