import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordLeadEvent, verifyPropertyAddress } = vi.hoisted(() => ({
  recordLeadEvent: vi.fn(),
  verifyPropertyAddress: vi.fn(),
}));
vi.mock("./verify-property", () => ({ verifyPropertyAddress }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { ADDRESS_VERIFIED: "address_verified" },
  recordLeadEvent,
}));
vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchJobCompleted: vi.fn(),
}));

import { runCassChunk, type CassJobSummary } from "./cass-job";

const JOB_ITEM_ID = "00000000-0000-4000-8000-000000000011";

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
  const single = vi.fn().mockResolvedValue({
    data: { id: JOB_ITEM_ID },
    error: null,
  });
  const select = vi.fn(() => ({ single }));
  const upsert = vi.fn(() => ({ select }));
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
  beforeEach(() => {
    verifyPropertyAddress.mockReset();
    recordLeadEvent.mockReset().mockResolvedValue(undefined);
  });

  it("records a successful persisted CASS verdict without address data", async () => {
    verifyPropertyAddress.mockResolvedValue({
      status: "stored_with_status",
      propertyId: "property-1",
      cacheHit: true,
      verified: {
        standardized: "1 Main St",
        cassStatus: "ambiguous",
        components: {},
        raw: {},
      },
    });
    const { supabase } = client();

    await runCassChunk(supabase as never, {
      jobId: "job-1",
      propertyIds: ["property-1"],
      processedBefore: 0,
      summary: summary(),
      expectedOrgId: "org-1",
    });

    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      actorType: "system",
      eventType: "address_verified",
      payload: {
        job_id: "job-1",
        cass_status: "ambiguous",
        cache_hit: true,
      },
      sourceType: "job_items.cass",
      sourceId: JOB_ITEM_ID,
    });
    expect(JSON.stringify(recordLeadEvent.mock.calls)).not.toContain(
      "1 Main St",
    );
  });

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
    expect(recordLeadEvent).not.toHaveBeenCalled();
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
    expect(recordLeadEvent).not.toHaveBeenCalled();
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
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });
});
