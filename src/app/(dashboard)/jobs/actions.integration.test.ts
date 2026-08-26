import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const testClient = createTestClient();
const { start } = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

vi.mock("workflow/api", () => ({
  start,
}));

// Server Actions register workflow dispatch after the response. Integration
// tests do not run inside a Next request scope, so keep the continuation
// registered but inert; this suite verifies the durable retry child itself.
vi.mock("next/server", () => ({
  after: vi.fn(),
}));

process.env.ADMIN_EMAILS = "jarrad@bmhgroupkc.com";

let currentEmail: string | null = "jarrad@bmhgroupkc.com";
let currentUserId: string | null = null;
vi.spyOn(testClient.auth, "getUser").mockImplementation(
  async () =>
    ({
      data: {
        user: currentEmail
          ? ({ id: currentUserId, email: currentEmail } as never)
          : null,
      },
      error: null,
    }) as never,
);

import { retryFailedCassItems, retryFailedSkipTraceItems } from "./actions";

async function getOrgId(): Promise<string> {
  return getCanonicalTestOrgId(testClient);
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

async function seedProperties(
  count: number,
  prefix: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; offset < count; offset += 400) {
    const size = Math.min(400, count - offset);
    const { data, error } = await testClient
      .from("properties")
      .insert(
        Array.from({ length: size }, (_, index) => ({
          address: `${prefix} ${offset + index}`,
          state: "MO",
          status: "prospect" as const,
        })),
      )
      .select("id");
    if (error || !data) throw error ?? new Error("seed properties failed");
    ids.push(...data.map((row) => row.id));
  }
  return ids;
}

async function seedJob(opts: {
  type: string;
  status: string;
  propertyIds: string[];
  failedItems?: number;
  inputParams?: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
  errorClass?: string;
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
      input_params: (opts.inputParams ?? {
        property_ids: opts.propertyIds,
      }) as never,
      result_summary: (opts.resultSummary ?? null) as never,
      error_class: opts.errorClass ?? null,
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
  for (let offset = 0; offset < items.length; offset += 400) {
    const rows = items.slice(offset, offset + 400).map((i) => ({
      job_id: jobId,
      property_id: i.propertyId,
      status: i.status,
      error_class: i.errorClass ?? null,
      error_message: i.status === "error" ? "boom" : null,
    }));
    const { error } = await testClient.from("job_items").insert(rows);
    if (error) throw error;
  }
}

describe("retryFailedSkipTraceItems (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    const orgId = await getOrgId();
    const { data: owner, error: ownerError } = await testClient
      .from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("role", "owner")
      .limit(1)
      .single();
    if (ownerError || !owner) {
      throw ownerError ?? new Error("test owner missing");
    }
    start.mockReset();
    start.mockResolvedValue({ runId: "test-run" });
    currentEmail = "jarrad@bmhgroupkc.com";
    currentUserId = owner.user_id;
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
      { jobId: result.data.childJobId, orgId: await getOrgId() },
    ]);
    const { data: events, error: eventError } = await testClient
      .from("lead_events")
      .select(
        "property_id, actor_type, actor_id, event_type, payload, source_type, source_id",
      )
      .eq("event_type", "skip_trace_requested")
      .eq("property_id", p2);
    expect(eventError).toBeNull();
    expect(events).toHaveLength(1);
    expect(events).toEqual([
      {
        property_id: p2,
        actor_type: "user",
        actor_id: currentUserId,
        event_type: "skip_trace_requested",
        payload: {
          job_id: result.data.childJobId,
          retry_of_job_id: jobId,
          batch_id: result.data.childJobId,
          batch_count: 1,
        },
        source_type: null,
        source_id: null,
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/Main St|boom|email|phone/i);
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
    const { data: events, error: eventError } = await testClient
      .from("lead_events")
      .select(
        "property_id, actor_type, actor_id, event_type, payload, source_type, source_id",
      )
      .eq("event_type", "skip_trace_requested")
      .eq("property_id", p1);
    expect(eventError).toBeNull();
    expect(events).toEqual([
      {
        property_id: p1,
        actor_type: "user",
        actor_id: currentUserId,
        event_type: "skip_trace_requested",
        payload: {
          job_id: result.data.childJobId,
          retry_of_job_id: jobId,
          batch_id: result.data.childJobId,
          batch_count: 1,
        },
        source_type: null,
        source_id: null,
      },
    ]);
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

  it("never applies the legacy fallback to a modern submission with an uncertain outcome", async () => {
    const p1 = await seedProperty("12 Modern Recovery Rd");
    const jobId = await seedJob({
      type: "skip_trace",
      status: "failed",
      propertyIds: [p1],
      failedItems: 1,
      inputParams: {
        property_ids: [p1],
        submission_attempt_token: "immutable-attempt-marker",
      },
      resultSummary: {
        submit_phase: "submission_unknown",
        manual_reconciliation_required: true,
      },
    });

    const result = await retryFailedSkipTraceItems(jobId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MANUAL_RECONCILIATION_REQUIRED");
    expect(start).not.toHaveBeenCalled();
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

  it("reuses an already queued retry child without enqueuing it twice", async () => {
    const p1 = await seedProperty("1 Concurrent Ave");
    const parentId = await seedJob({
      type: "skip_trace",
      status: "failed",
      propertyIds: [p1],
      failedItems: 1,
    });
    // Seed an in-flight child manually.
    const orgId = await getOrgId();
    const { data: existing } = await testClient
      .from("jobs")
      .insert({
        type: "skip_trace",
        status: "running",
        org_id: orgId,
        parent_job_id: parentId,
        provider: "tracerfy",
        total_items: 1,
        title: "In-flight retry",
        input_params: { property_ids: [p1] },
      })
      .select("id")
      .single();

    const result = await retryFailedSkipTraceItems(parentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.childJobId).toBe(existing?.id);
    expect(start).not.toHaveBeenCalled();
    const { count: eventCount } = await testClient
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "skip_trace_requested");
    expect(eventCount).toBe(0);
  });

  it("concurrent identical retries create one child and enqueue one provider workflow", async () => {
    const propertyId = await seedProperty("1 Atomic Retry Ave");
    const parentId = await seedJob({
      type: "skip_trace",
      status: "failed",
      propertyIds: [propertyId],
      failedItems: 1,
    });
    await seedJobItems(parentId, [
      { propertyId, status: "error", errorClass: "provider_transient" },
    ]);

    const [first, second] = await Promise.all([
      retryFailedSkipTraceItems(parentId),
      retryFailedSkipTraceItems(parentId),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.childJobId).toBe(second.data.childJobId);
    const { count, error } = await testClient
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("parent_job_id", parentId)
      .eq("type", "skip_trace");
    expect(error).toBeNull();
    expect(count).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    const { data: events, error: eventError } = await testClient
      .from("lead_events")
      .select(
        "property_id, actor_type, actor_id, event_type, payload, source_type, source_id",
      )
      .eq("event_type", "skip_trace_requested")
      .eq("property_id", propertyId);
    expect(eventError).toBeNull();
    expect(events).toHaveLength(1);
    expect(events).toEqual([
      {
        property_id: propertyId,
        actor_type: "user",
        actor_id: currentUserId,
        event_type: "skip_trace_requested",
        payload: {
          job_id: first.data.childJobId,
          retry_of_job_id: parentId,
          batch_id: first.data.childJobId,
          batch_count: 1,
        },
        source_type: null,
        source_id: null,
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /Atomic Retry|boom|email|phone/i,
    );
  });

  it("conserves all 1,001 retryable failure targets", async () => {
    const propertyIds = await seedProperties(1_001, "Scale Retry");
    const parentId = await seedJob({
      type: "skip_trace",
      status: "failed",
      propertyIds,
      failedItems: propertyIds.length,
    });
    await seedJobItems(
      parentId,
      propertyIds.map((propertyId) => ({
        propertyId,
        status: "error" as const,
        errorClass: "provider_transient",
      })),
    );

    const result = await retryFailedSkipTraceItems(parentId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(1_001);
    const { data: child, error } = await testClient
      .from("jobs")
      .select("input_params, total_items")
      .eq("id", result.data.childJobId)
      .single();
    expect(error).toBeNull();
    const childIds = (child?.input_params as { property_ids: string[] })
      .property_ids;
    expect(child?.total_items).toBe(1_001);
    expect(new Set(childIds)).toEqual(new Set(propertyIds));
  }, 60_000);

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
    const { count: childCount } = await testClient
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("parent_job_id", jobId);
    const { count: eventCount } = await testClient
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "skip_trace_requested");
    expect(childCount).toBe(0);
    expect(eventCount).toBe(0);
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

describe("retryFailedCassItems scale", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    start.mockReset();
    start.mockResolvedValue({ runId: "test-run" });
    currentEmail = "jarrad@bmhgroupkc.com";
    currentUserId = null;
  });

  it("conserves all 1,001 failed CASS targets in the authorized retry child", async () => {
    const propertyIds = await seedProperties(1_001, "CASS Scale Retry");
    const sourceJobId = await seedJob({
      type: "cass_dsf2_ncoa",
      status: "failed",
      propertyIds,
      failedItems: propertyIds.length,
    });
    await seedJobItems(
      sourceJobId,
      propertyIds.map((propertyId) => ({
        propertyId,
        status: "error" as const,
        errorClass: "database",
      })),
    );

    const result = await retryFailedCassItems(sourceJobId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(1_001);
    const { data: child, error } = await testClient
      .from("jobs")
      .select("input_params, total_items")
      .eq("id", result.data.childJobId)
      .single();
    expect(error).toBeNull();
    expect(child?.total_items).toBe(1_001);
    expect(
      new Set((child?.input_params as { property_ids: string[] }).property_ids),
    ).toEqual(new Set(propertyIds));
  }, 60_000);
});
