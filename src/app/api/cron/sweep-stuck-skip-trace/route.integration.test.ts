import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import { MockSkipTraceProvider } from "@/lib/skip-trace/providers/mock";

const { start } = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock("workflow/api", () => ({
  start,
}));

import { runSweep } from "./route";

const supabase = createTestClient();

const ORIGINAL_PROVIDER_ENV = process.env.SKIP_TRACE_PROVIDER;

beforeEach(async () => {
  await resetTenantTables(supabase);
  MockSkipTraceProvider.reset();
  start.mockReset();
  start.mockResolvedValue({ runId: "test-run" });
  process.env.SKIP_TRACE_PROVIDER = "mock";
});

afterEach(() => {
  if (ORIGINAL_PROVIDER_ENV === undefined) {
    delete process.env.SKIP_TRACE_PROVIDER;
  } else {
    process.env.SKIP_TRACE_PROVIDER = ORIGINAL_PROVIDER_ENV;
  }
});

async function getOrgId(): Promise<string> {
  return getCanonicalTestOrgId(supabase);
}

async function seedRunningSkipTraceJob(opts: {
  queueId: string;
  startedMinutesAgo: number;
  propertyAddress?: string;
}): Promise<{ jobId: string; propertyId: string }> {
  const orgId = await getOrgId();
  const { data: prop } = await supabase
    .from("properties")
    .insert({
      org_id: orgId,
      address: opts.propertyAddress ?? "1 Main St",
      state: "MO",
    })
    .select("id, address, city, state, zip")
    .single();
  if (!prop) throw new Error("seed property failed");

  // Register the queue with the mock provider so pollBatch returns
  // results for it.
  const provider = new MockSkipTraceProvider();
  await provider.submitBatch([
    {
      propertyId: prop.id,
      address: prop.address,
      city: prop.city ?? "",
      state: prop.state,
    },
  ]);
  // The mock auto-generates queue ids, but we want to match opts.queueId
  // so we plant it manually via the public reset/submit cycle:
  MockSkipTraceProvider.reset();
  const ticket = await new MockSkipTraceProvider().submitBatch([
    {
      propertyId: prop.id,
      address: prop.address,
      city: prop.city ?? "",
      state: prop.state,
    },
  ]);

  const startedAt = new Date(
    Date.now() - opts.startedMinutesAgo * 60 * 1000,
  ).toISOString();

  const { data: job } = await supabase
    .from("jobs")
    .insert({
      org_id: orgId,
      type: "skip_trace",
      status: "running",
      total_items: 1,
      provider: "mock",
      provider_run_id: ticket.queueId,
      started_at: startedAt,
      worker_heartbeat_at: startedAt,
      input_params: { property_ids: [prop.id] },
    })
    .select("id")
    .single();
  if (!job) throw new Error("seed job failed");

  return { jobId: job.id, propertyId: prop.id };
}

describe("runSweep — sweep-stuck-skip-trace cron", () => {
  it("finalizes a stuck running job whose batch is complete at the provider", async () => {
    const { jobId } = await seedRunningSkipTraceJob({
      queueId: "ignored", // mock auto-generates
      startedMinutesAgo: 10,
    });

    const result = await runSweep(supabase);
    expect(result.candidates).toBe(1);
    expect(result.finalized).toBe(1);
    expect(result.errors).toBe(0);

    // Job should have moved out of `running`
    const { data: after } = await supabase
      .from("jobs")
      .select("status, completed_at")
      .eq("id", jobId)
      .single();
    expect(["completed", "partial", "failed"]).toContain(after!.status);
    expect(after!.completed_at).not.toBeNull();
  });

  it("leaves a job alone when it's younger than the min-age-before-sweep window", async () => {
    // Started 30s ago — way under the 2-min cutoff
    const { jobId } = await seedRunningSkipTraceJob({
      queueId: "fresh",
      startedMinutesAgo: 0,
    });

    const result = await runSweep(supabase);
    expect(result.candidates).toBe(0);
    expect(result.finalized).toBe(0);

    const { data: after } = await supabase
      .from("jobs")
      .select("status")
      .eq("id", jobId)
      .single();
    expect(after!.status).toBe("running");
  });

  it("reclaims stale skip_trace jobs without a provider_run_id", async () => {
    const orgId = await getOrgId();
    const { data: prop } = await supabase
      .from("properties")
      .insert({
        org_id: orgId,
        address: "1 Reclaim St",
        state: "MO",
        cass_status: "verified",
      })
      .select("id")
      .single();
    if (!prop) throw new Error("seed property failed");
    const startedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: job } = await supabase
      .from("jobs")
      .insert({
        org_id: orgId,
        type: "skip_trace",
        status: "running",
        total_items: 1,
        // provider_run_id intentionally null — sweep should restart submit
        started_at: startedAt,
        worker_heartbeat_at: startedAt,
        input_params: { property_ids: [prop.id] },
      })
      .select("id")
      .single();

    const result = await runSweep(supabase);
    expect(result.candidates).toBe(1);
    expect(result.unsubmitted_reclaimed).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.any(Function), [
      { jobId: job!.id, orgId },
    ]);

    const { data: after } = await supabase
      .from("jobs")
      .select("status, worker_heartbeat_at")
      .eq("id", job!.id)
      .single();
    expect(after!.status).toBe("running");
  });

  it("reclaims a stale job that crashed in the recoverable pre-provider phase", async () => {
    const orgId = await getOrgId();
    const startedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: job } = await supabase
      .from("jobs")
      .insert({
        org_id: orgId,
        type: "skip_trace",
        status: "running",
        total_items: 1,
        provider_run_id: null,
        started_at: startedAt,
        worker_heartbeat_at: startedAt,
        input_params: { property_ids: ["placeholder"] },
        result_summary: { submit_phase: "prepared" },
      })
      .select("id")
      .single();

    const result = await runSweep(supabase);

    expect(result.unsubmitted_reclaimed).toBe(1);
    expect(start).toHaveBeenCalledWith(expect.any(Function), [
      { jobId: job!.id, orgId },
    ]);
  });

  it("does not reclaim a stale job at the ambiguous paid-call boundary", async () => {
    const orgId = await getOrgId();
    const startedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await supabase.from("jobs").insert({
      org_id: orgId,
      type: "skip_trace",
      status: "running",
      total_items: 1,
      provider_run_id: null,
      started_at: startedAt,
      worker_heartbeat_at: startedAt,
      input_params: { property_ids: ["placeholder"] },
      result_summary: { submit_phase: "submitting" },
    });

    const result = await runSweep(supabase);

    expect(result.unsubmitted_reclaimed).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  it("reclaims stale queued never-submitted skip_trace jobs with null heartbeat", async () => {
    const orgId = await getOrgId();
    const createdAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: job } = await supabase
      .from("jobs")
      .insert({
        org_id: orgId,
        type: "skip_trace",
        status: "queued",
        created_at: createdAt,
        total_items: 1,
        provider_run_id: null,
        worker_heartbeat_at: null,
        input_params: { property_ids: ["placeholder"] },
      })
      .select("id")
      .single();

    const result = await runSweep(supabase);
    expect(result.candidates).toBe(1);
    expect(result.unsubmitted_reclaimed).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.any(Function), [
      { jobId: job!.id, orgId },
    ]);

    const { data: after } = await supabase
      .from("jobs")
      .select("status, worker_heartbeat_at")
      .eq("id", job!.id)
      .single();
    expect(after!.status).toBe("queued");
  });

  it("does not reclaim fresh queued never-submitted skip_trace jobs with null heartbeat", async () => {
    const orgId = await getOrgId();
    const { data: job } = await supabase
      .from("jobs")
      .insert({
        org_id: orgId,
        type: "skip_trace",
        status: "queued",
        total_items: 1,
        provider_run_id: null,
        worker_heartbeat_at: null,
        input_params: { property_ids: ["placeholder"] },
      })
      .select("id")
      .single();

    const result = await runSweep(supabase);
    expect(result.candidates).toBe(0);
    expect(result.unsubmitted_reclaimed).toBe(0);
    expect(start).not.toHaveBeenCalled();

    const { data: after } = await supabase
      .from("jobs")
      .select("status, worker_heartbeat_at")
      .eq("id", job!.id)
      .single();
    expect(after!.status).toBe("queued");
    expect(after!.worker_heartbeat_at).toBeNull();
  });

  it("ignores non-skip_trace job types", async () => {
    const orgId = await getOrgId();
    const startedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: csv } = await supabase
      .from("csv_imports")
      .insert({
        org_id: orgId,
        filename: "x.csv",
        source: "generic",
        market: "Kansas City",
      })
      .select("id")
      .single();
    const { data: job } = await supabase
      .from("jobs")
      .insert({
        org_id: orgId,
        type: "csv_import",
        status: "running",
        total_items: 1,
        provider_run_id: "irrelevant",
        related_import_id: csv!.id,
        started_at: startedAt,
      })
      .select("id")
      .single();

    const result = await runSweep(supabase);
    expect(result.candidates).toBe(0);

    const { data: after } = await supabase
      .from("jobs")
      .select("status")
      .eq("id", job!.id)
      .single();
    expect(after!.status).toBe("running");
  });
});
