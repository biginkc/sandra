import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const testClient = createTestClient();
const { start } = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

vi.mock("workflow/api", () => ({
  start,
}));

process.env.ADMIN_EMAILS = "jarrad@bmhgroupkc.com";

let currentEmail: string | null = "jarrad@bmhgroupkc.com";
let currentUserId: string | null = null;
vi.spyOn(testClient.auth, "getUser").mockImplementation(async () =>
  ({
    data: {
      user: currentEmail
        ? ({ id: currentUserId, email: currentEmail } as never)
        : null,
    },
    error: null,
  }) as never,
);

import { retryFailedSkipTraceItems } from "./actions";

async function getOrgId(): Promise<string> {
  const { data } = await testClient
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  return data!.id;
}

async function seedProperty(address: string): Promise<string> {
  const { data, error } = await testClient
    .from("properties")
    .insert({ address, state: "MO", status: "prospect" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed property failed");
  return data.id;
}

async function seedJob(opts: {
  type: string;
  status: string;
  propertyIds: string[];
  failedItems?: number;
}): Promise<string> {
  const orgId = await getOrgId();
  const { data, error } = await testClient
    .from("jobs")
    .insert({
      type: opts.type,
      status: opts.status,
      org_id: orgId,
      provider: opts.type === "skip_trace" ? "tracerfy" : null,
      total_items: opts.propertyIds.length,
      processed_items: opts.propertyIds.length,
      failed_items: opts.failedItems ?? 0,
      title: `Test ${opts.type} job`,
      input_params: { property_ids: opts.propertyIds },
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed job failed");
  return data.id;
}

async function seedJobItems(
  jobId: string,
  items: {
    propertyId: string;
    status: "success" | "error" | "skipped";
    errorClass?: string;
  }[],
): Promise<void> {
  if (items.length === 0) return;
  const rows = items.map((i) => ({
    job_id: jobId,
    property_id: i.propertyId,
    status: i.status,
    error_class: i.errorClass ?? null,
    error_message: i.status === "error" ? "boom" : null,
  }));
  const { error } = await testClient.from("job_items").insert(rows);
  if (error) throw error;
}

describe("retryFailedSkipTraceItems (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    start.mockReset();
    start.mockResolvedValue({ runId: "test-run" });
    currentEmail = "jarrad@bmhgroupkc.com";
    currentUserId = null;
  });

  it("partial post-#59 job: retries only errored property_ids", async () => {
    const p1 = await seedProperty("1 Main St");
    const p2 = await seedProperty("2 Main St");
    const p3 = await seedProperty("3 Main St");
    const jobId = await seedJob({
      type: "skip_trace",
      status: "partial",
      propertyIds: [p1, p2, p3],
      failedItems: 1,
    });
    await seedJobItems(jobId, [
      { propertyId: p1, status: "success" },
      { propertyId: p2, status: "error" },
      { propertyId: p3, status: "skipped" },
    ]);

    const result = await retryFailedSkipTraceItems(jobId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(1);

    const { data: child } = await testClient
      .from("jobs")
      .select("type, status, parent_job_id, input_params, total_items")
      .eq("id", result.data.childJobId)
      .single();
    expect(child?.type).toBe("skip_trace");
    expect(child?.parent_job_id).toBe(jobId);
    expect(child?.total_items).toBe(1);
    const ids = (child?.input_params as { property_ids: string[] })
      .property_ids;
    expect(ids).toEqual([p2]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.any(Function), [
      { jobId: result.data.childJobId },
    ]);
  });

  it("returns the retry child when workflow enqueue fails so cron can recover it", async () => {
    const p1 = await seedProperty("1 Retry Enqueue Failure St");
    const jobId = await seedJob({
      type: "skip_trace",
      status: "failed",
      propertyIds: [p1],
      failedItems: 1,
    });
    await seedJobItems(jobId, [
      { propertyId: p1, status: "error", errorClass: "provider_transient" },
    ]);
    start.mockRejectedValueOnce(new Error("workflow enqueue down"));

    const result = await retryFailedSkipTraceItems(jobId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data: child } = await testClient
      .from("jobs")
      .select("status, provider_run_id")
      .eq("id", result.data.childJobId)
      .single();
    expect(child?.status).toBe("queued");
    expect(child?.provider_run_id).toBeNull();
  });

  it("pre-#59 failed job (0 items): falls back to input_params.property_ids", async () => {
    const p1 = await seedProperty("10 Recovery Rd");
    const p2 = await seedProperty("11 Recovery Rd");
    const jobId = await seedJob({
      type: "skip_trace",
      status: "failed",
      propertyIds: [p1, p2],
      failedItems: 2,
    });
    // No job_items inserted — mirrors the pre-#59 production state
    // where Tracerfy results couldn't be fanned out per-property.

    const result = await retryFailedSkipTraceItems(jobId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(2);

    const { data: child } = await testClient
      .from("jobs")
      .select("input_params")
      .eq("id", result.data.childJobId)
      .single();
    const ids = new Set(
      (child?.input_params as { property_ids: string[] }).property_ids,
    );
    expect(ids).toEqual(new Set([p1, p2]));
  });

  it("rejects non-skip_trace job types with JOB_WRONG_TYPE", async () => {
    const p1 = await seedProperty("1 Wrong Type Ln");
    const jobId = await seedJob({
      type: "cass_dsf2_ncoa",
      status: "failed",
      propertyIds: [p1],
      failedItems: 1,
    });
    const result = await retryFailedSkipTraceItems(jobId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("JOB_WRONG_TYPE");
  });

  it("rejects non-failed/non-partial status with JOB_WRONG_STATUS", async () => {
    const p1 = await seedProperty("1 Done St");
    const jobId = await seedJob({
      type: "skip_trace",
      status: "completed",
      propertyIds: [p1],
    });
    const result = await retryFailedSkipTraceItems(jobId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("JOB_WRONG_STATUS");
  });

  it("rejects with NO_PROPERTY_IDS when items + input_params.property_ids both empty", async () => {
    const orgId = await getOrgId();
    const { data } = await testClient
      .from("jobs")
      .insert({
        type: "skip_trace",
        status: "failed",
        org_id: orgId,
        provider: "tracerfy",
        total_items: 0,
        title: "Empty job",
        input_params: { property_ids: [] },
      })
      .select("id")
      .single();
    const jobId = data!.id;

    const result = await retryFailedSkipTraceItems(jobId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NO_PROPERTY_IDS");
  });

  it("concurrency guard: rejects RETRY_IN_FLIGHT when a child is queued/running", async () => {
    const p1 = await seedProperty("1 Concurrent Ave");
    const parentId = await seedJob({
      type: "skip_trace",
      status: "failed",
      propertyIds: [p1],
      failedItems: 1,
    });
    // Seed an in-flight child manually.
    const orgId = await getOrgId();
    await testClient.from("jobs").insert({
      type: "skip_trace",
      status: "running",
      org_id: orgId,
      parent_job_id: parentId,
      provider: "tracerfy",
      total_items: 1,
      title: "In-flight retry",
      input_params: { property_ids: [p1] },
    });

    const result = await retryFailedSkipTraceItems(parentId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RETRY_IN_FLIGHT");
  });

  it("non-admin caller is rejected with FORBIDDEN", async () => {
    const p1 = await seedProperty("1 Forbidden St");
    const jobId = await seedJob({
      type: "skip_trace",
      status: "failed",
      propertyIds: [p1],
      failedItems: 1,
    });

    currentEmail = "va@bmhgroupkc.com";
    const result = await retryFailedSkipTraceItems(jobId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
  });

  it("links child via parent_job_id and returns childJobId", async () => {
    const p1 = await seedProperty("1 Linked St");
    const jobId = await seedJob({
      type: "skip_trace",
      status: "failed",
      propertyIds: [p1],
      failedItems: 1,
    });
    const result = await retryFailedSkipTraceItems(jobId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: child } = await testClient
      .from("jobs")
      .select("parent_job_id")
      .eq("id", result.data.childJobId)
      .single();
    expect(child?.parent_job_id).toBe(jobId);
  });

  // ---------------------------------------------------------------
  // Category-aware retry resolution: only items with retryable
  // error_classes get re-submitted to the vendor. Terminal classes
  // (provider_no_data, address_unverified) are excluded so the user
  // can't accidentally pay for guaranteed-fail lookups.
  // ---------------------------------------------------------------
  describe("retry resolution by error_class", () => {
    it("retries provider_transient + provider_unknown, excludes provider_no_data + address_unverified", async () => {
      const a = await seedProperty("1 Transient St");
      const b = await seedProperty("2 Unknown St");
      const c = await seedProperty("3 NoData St");
      const d = await seedProperty("4 Unverified St");
      const jobId = await seedJob({
        type: "skip_trace",
        status: "partial",
        propertyIds: [a, b, c, d],
        failedItems: 4,
      });
      await seedJobItems(jobId, [
        { propertyId: a, status: "error", errorClass: "provider_transient" },
        { propertyId: b, status: "error", errorClass: "provider_unknown" },
        { propertyId: c, status: "error", errorClass: "provider_no_data" },
        { propertyId: d, status: "error", errorClass: "address_unverified" },
      ]);

      const result = await retryFailedSkipTraceItems(jobId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.total).toBe(2);

      const { data: child } = await testClient
        .from("jobs")
        .select("input_params")
        .eq("id", result.data.childJobId)
        .single();
      const ids = new Set(
        (child!.input_params as { property_ids: string[] }).property_ids,
      );
      expect(ids).toEqual(new Set([a, b]));
    });

    it("returns NO_RETRYABLE_ITEMS when every error is terminal", async () => {
      const a = await seedProperty("1 Terminal St");
      const b = await seedProperty("2 Terminal St");
      const jobId = await seedJob({
        type: "skip_trace",
        status: "failed",
        propertyIds: [a, b],
        failedItems: 2,
      });
      await seedJobItems(jobId, [
        { propertyId: a, status: "error", errorClass: "provider_no_data" },
        { propertyId: b, status: "error", errorClass: "address_unverified" },
      ]);

      const result = await retryFailedSkipTraceItems(jobId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NO_RETRYABLE_ITEMS");
    });

    it("treats legacy null error_class as retryable (back-compat)", async () => {
      const p1 = await seedProperty("1 Legacy St");
      const jobId = await seedJob({
        type: "skip_trace",
        status: "failed",
        propertyIds: [p1],
        failedItems: 1,
      });
      await seedJobItems(jobId, [
        { propertyId: p1, status: "error" }, // null error_class
      ]);

      const result = await retryFailedSkipTraceItems(jobId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.total).toBe(1);
    });

    it("treats legacy 'provider' error_class as retryable (back-compat)", async () => {
      const p1 = await seedProperty("1 Legacy Provider St");
      const jobId = await seedJob({
        type: "skip_trace",
        status: "failed",
        propertyIds: [p1],
        failedItems: 1,
      });
      await seedJobItems(jobId, [
        { propertyId: p1, status: "error", errorClass: "provider" },
      ]);

      const result = await retryFailedSkipTraceItems(jobId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.total).toBe(1);
    });
  });
});
