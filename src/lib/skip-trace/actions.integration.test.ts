import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import { MockSkipTraceProvider } from "./providers/mock";

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

import {
  approveSkipTraceJob,
  preflightSkipTrace,
  requestSkipTrace,
} from "./actions";

async function seedProperty(opts: {
  address: string;
  cassStatus?: "verified" | "unverified" | "invalid" | "ambiguous";
  killSwitch?: boolean;
}): Promise<string> {
  const insert: Record<string, unknown> = {
    address: opts.address,
    state: "MO",
    status: "prospect",
    skip_trace_disabled: opts.killSwitch ?? false,
  };
  if (opts.cassStatus) insert.cass_status = opts.cassStatus;
  const { data, error } = await testClient
    .from("properties")
    .insert(insert as never)
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed property failed");
  return data.id;
}

async function attachHomeowner(
  propertyId: string,
  suffix: string,
): Promise<string> {
  const { data: property, error: propertyError } = await testClient
    .from("properties")
    .select("org_id")
    .eq("id", propertyId)
    .single();
  if (propertyError || !property) {
    throw propertyError ?? new Error("property lookup failed");
  }
  const { data: contact, error: contactError } = await testClient
    .from("contacts")
    .insert({
      org_id: property.org_id,
      first_name: `Approval ${suffix}`,
      last_name: "Owner",
      phone_1: `+1816555${suffix.padStart(4, "0")}`,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactError || !contact) {
    throw contactError ?? new Error("contact insert failed");
  }
  const { error: linkError } = await testClient
    .from("properties")
    .update({ homeowner_contact_id: contact.id })
    .eq("id", propertyId);
  if (linkError) throw linkError;
  return contact.id;
}

describe("requestSkipTrace pre-flight gates (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    process.env.SKIP_TRACE_PROVIDER = "mock";
    MockSkipTraceProvider.reset();
    start.mockReset();
    start.mockResolvedValue({ runId: "test-run" });
    currentEmail = "jarrad@bmhgroupkc.com";
    currentUserId = null;
  });

  afterEach(() => {
    MockSkipTraceProvider.reset();
  });

  it("happy path: all CASS-verified, no kill-switch — every id lands in input_params", async () => {
    const ids = await Promise.all([
      seedProperty({ address: "1 Verified Ln", cassStatus: "verified" }),
      seedProperty({ address: "2 Verified Ln", cassStatus: "verified" }),
    ]);

    const result = await requestSkipTrace(ids);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: job } = await testClient
      .from("jobs")
      .select("org_id, input_params, title")
      .eq("id", result.data.jobId!)
      .single();
    const input = (job!.input_params as { property_ids: string[] })
      .property_ids;
    expect(new Set(input)).toEqual(new Set(ids));
    // No skipped suffix on the happy path.
    expect(job!.title).not.toMatch(/skipped/i);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.any(Function), [
      { jobId: result.data.jobId, orgId: job!.org_id },
    ]);
  });

  it("keeps admin request successful when workflow enqueue fails after job create", async () => {
    const id = await seedProperty({
      address: "1 Recoverable Start Failure Ln",
      cassStatus: "verified",
    });
    start.mockRejectedValueOnce(new Error("workflow enqueue down"));

    const result = await requestSkipTrace([id]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("queued");
    const { data: job } = await testClient
      .from("jobs")
      .select("status, provider_run_id, worker_heartbeat_at")
      .eq("id", result.data.jobId!)
      .single();
    expect(job?.status).toBe("queued");
    expect(job?.provider_run_id).toBeNull();
  });

  it("preflight prices a single eligible row at 5 Tracefy credits", async () => {
    const id = await seedProperty({
      address: "1 Single Ln",
      cassStatus: "verified",
    });

    const result = await preflightSkipTrace([id]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eligible).toBe(1);
    expect(result.data.tracefyCreditsRequired).toBe(5);
    expect(result.data.tracefyCreditsAvailable).toBe(10_000);
    expect(result.data.canLaunchSkipTrace).toBe(true);
  });

  it("preflight prices batch eligible rows at 1 Tracefy credit per row", async () => {
    const ids = await Promise.all([
      seedProperty({ address: "1 Batch Ln", cassStatus: "verified" }),
      seedProperty({ address: "2 Batch Ln", cassStatus: "verified" }),
      seedProperty({ address: "3 Needs Cass Ln", cassStatus: "unverified" }),
    ]);

    const result = await preflightSkipTrace(ids);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eligible).toBe(2);
    expect(result.data.cassUnverified).toBe(1);
    expect(result.data.tracefyCreditsRequired).toBe(2);
    expect(result.data.estimatedCassVerificationCostUsd).toBeCloseTo(0.03);
  });

  it("preflight prices split batches including a one-row tail at Tracefy single-lookup cost", async () => {
    const rows = Array.from({ length: 4_001 }, (_, index) => ({
      address: `${index + 1} Split Credit Ln`,
      state: "MO",
      status: "prospect",
      skip_trace_disabled: false,
      cass_status: "verified",
    }));
    const { data, error } = await testClient
      .from("properties")
      .insert(rows as never)
      .select("id");
    if (error || !data) throw error ?? new Error("bulk seed failed");

    const result = await preflightSkipTrace(data.map((row) => row.id));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eligible).toBe(4_001);
    expect(result.data.tracefyCreditsRequired).toBe(4_005);

    const launch = await requestSkipTrace(data.map((row) => row.id));
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("preflight reports CASS status separately from skip-trace eligibility", async () => {
    const activeVerified = await seedProperty({
      address: "1 Active Verified Ln",
      cassStatus: "verified",
    });
    const activeUnverified = await seedProperty({
      address: "2 Active Unverified Ln",
      cassStatus: "unverified",
    });
    const disabledVerified = await seedProperty({
      address: "3 Disabled Verified Ln",
      cassStatus: "verified",
      killSwitch: true,
    });
    const disabledUnverified = await seedProperty({
      address: "4 Disabled Unverified Ln",
      cassStatus: "unverified",
      killSwitch: true,
    });

    const result = await preflightSkipTrace([
      activeVerified,
      activeUnverified,
      disabledVerified,
      disabledUnverified,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.requested).toBe(4);
    expect(result.data.cassVerified).toBe(2);
    expect(result.data.cassUnverified).toBe(2);
    expect(result.data.eligible).toBe(1);
    expect(result.data.killSwitchSkipped).toBe(2);
    expect(result.data.cassVerificationPropertyIds).toEqual([activeUnverified]);
    expect(result.data.estimatedCassVerificationCostUsd).toBeCloseTo(0.03);
    expect(result.data.tracefyCreditsRequired).toBe(5);
  });

  it("filters out CASS-unverified properties before sending to vendor", async () => {
    const verified = await seedProperty({
      address: "1 Pass Ln",
      cassStatus: "verified",
    });
    const unverified = await seedProperty({
      address: "2 Block Ln",
      cassStatus: "unverified",
    });
    const nullStatus = await seedProperty({ address: "3 Null Ln" });

    const result = await requestSkipTrace([verified, unverified, nullStatus]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eligible).toBe(1);
    expect(result.data.cassSkipped).toBe(2);

    const { data: job } = await testClient
      .from("jobs")
      .select("input_params, title")
      .eq("id", result.data.jobId!)
      .single();
    const input = (job!.input_params as { property_ids: string[] })
      .property_ids;
    expect(input).toEqual([verified]);
    expect(job!.title).toMatch(/2 need.* CASS/i);
  });

  it("blocks requestSkipTrace when Tracefy credits are insufficient at final launch", async () => {
    const ids = await Promise.all([
      seedProperty({ address: "1 Low Credit Ln", cassStatus: "verified" }),
      seedProperty({ address: "2 Low Credit Ln", cassStatus: "verified" }),
    ]);
    MockSkipTraceProvider.setBalance(1);

    const preflight = await preflightSkipTrace(ids);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    expect(preflight.data.tracefyCreditStatus).toBe("insufficient");
    expect(preflight.data.canLaunchSkipTrace).toBe(false);

    const result = await requestSkipTrace(ids);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("blocks requestSkipTrace when Tracefy balance cannot be confirmed", async () => {
    const id = await seedProperty({
      address: "1 Balance Error Ln",
      cassStatus: "verified",
    });
    MockSkipTraceProvider.failBalance();

    const preflight = await preflightSkipTrace([id]);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    expect(preflight.data.tracefyCreditStatus).toBe("unavailable");
    expect(preflight.data.canLaunchSkipTrace).toBe(false);

    const result = await requestSkipTrace([id]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TRACEFY_CREDITS_UNAVAILABLE");
  });

  it("post-CASS recompute keeps invalid and ambiguous rows ineligible", async () => {
    const invalid = await seedProperty({
      address: "1 Invalid Ln",
      cassStatus: "unverified",
    });
    const ambiguous = await seedProperty({
      address: "2 Ambiguous Ln",
      cassStatus: "unverified",
    });

    await testClient
      .from("properties")
      .update({ cass_status: "invalid" })
      .eq("id", invalid);
    await testClient
      .from("properties")
      .update({ cass_status: "ambiguous" })
      .eq("id", ambiguous);

    const result = await preflightSkipTrace([invalid, ambiguous]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eligible).toBe(0);
    expect(result.data.cassUnverified).toBe(2);
    expect(result.data.canLaunchSkipTrace).toBe(false);
  });

  it("reports none_eligible (not an error) when every property needs CASS", async () => {
    const ids = await Promise.all([
      seedProperty({ address: "1 Block Ln", cassStatus: "unverified" }),
      seedProperty({ address: "2 Block Ln", cassStatus: "unverified" }),
    ]);

    const result = await requestSkipTrace(ids);
    // A normal "verify the addresses first" state, surfaced as a success
    // outcome so the UI renders info — never a red failure toast.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("none_eligible");
    expect(result.data.jobId).toBeNull();
    expect(result.data.eligible).toBe(0);
    expect(result.data.cassSkipped).toBe(2);
    expect(result.data.killSwitchSkipped).toBe(0);
  });

  it("regression: reports none_eligible when every property is kill-switched and none need CASS", async () => {
    const ids = await Promise.all([
      seedProperty({
        address: "1 Off Ln",
        cassStatus: "verified",
        killSwitch: true,
      }),
      seedProperty({
        address: "2 Off Ln",
        cassStatus: "verified",
        killSwitch: true,
      }),
    ]);

    const result = await requestSkipTrace(ids);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("none_eligible");
    expect(result.data.killSwitchSkipped).toBe(2);
    expect(result.data.cassSkipped).toBe(0);
  });

  it("reports none_eligible with both counts when both gates trip together", async () => {
    const killed = await seedProperty({
      address: "1 Off Ln",
      cassStatus: "verified",
      killSwitch: true,
    });
    const unverified = await seedProperty({
      address: "2 Block Ln",
      cassStatus: "unverified",
    });

    const result = await requestSkipTrace([killed, unverified]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("none_eligible");
    expect(result.data.eligible).toBe(0);
    expect(result.data.killSwitchSkipped).toBe(1);
    expect(result.data.cassSkipped).toBe(1);
  });

  it("includes both skipped counts in the title when they apply together", async () => {
    const verified = await seedProperty({
      address: "1 Pass Ln",
      cassStatus: "verified",
    });
    const killed = await seedProperty({
      address: "2 Off Ln",
      cassStatus: "verified",
      killSwitch: true,
    });
    const unverified = await seedProperty({
      address: "3 Block Ln",
      cassStatus: "unverified",
    });

    const result = await requestSkipTrace([verified, killed, unverified]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eligible).toBe(1);
    expect(result.data.cassSkipped).toBe(1);
    expect(result.data.killSwitchSkipped).toBe(1);

    const { data: job } = await testClient
      .from("jobs")
      .select("title, input_params")
      .eq("id", result.data.jobId!)
      .single();
    expect(job!.title).toMatch(/1 kill-switched/);
    expect(job!.title).toMatch(/1 need.* CASS/i);
    const input = (job!.input_params as { property_ids: string[] })
      .property_ids;
    expect(input).toEqual([verified]);
  });

  it("blocks stale pending approval when Tracefy credits are no longer sufficient", async () => {
    const verified = await seedProperty({
      address: "1 Pending Approval Ln",
      cassStatus: "verified",
    });
    const { data: prop } = await testClient
      .from("properties")
      .select("org_id")
      .eq("id", verified)
      .single();
    const { data: job, error } = await testClient
      .from("jobs")
      .insert({
        type: "skip_trace",
        provider: "tracerfy",
        status: "pending_approval",
        org_id: prop!.org_id,
        total_items: 1,
        title: "Pending skip trace",
        input_params: { property_ids: [verified] },
      })
      .select("id")
      .single();
    if (error || !job) throw error ?? new Error("seed job failed");
    MockSkipTraceProvider.setBalance(4);

    const result = await approveSkipTraceJob(job.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("refuses a pending job of another type without changing or starting it", async () => {
    const verified = await seedProperty({
      address: "1 Wrong Job Type Ln",
      cassStatus: "verified",
    });
    const { data: prop } = await testClient
      .from("properties")
      .select("org_id")
      .eq("id", verified)
      .single();
    const { data: job, error } = await testClient
      .from("jobs")
      .insert({
        type: "cass_refresh",
        provider: "internal",
        status: "pending_approval",
        org_id: prop!.org_id,
        total_items: 1,
        title: "Not a skip-trace job",
        input_params: { property_ids: [verified] },
      })
      .select("id")
      .single();
    if (error || !job) throw error ?? new Error("seed job failed");

    const result = await approveSkipTraceJob(job.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    const { data: after } = await testClient
      .from("jobs")
      .select("status")
      .eq("id", job.id)
      .single();
    expect(after?.status).toBe("pending_approval");
    expect(start).not.toHaveBeenCalled();
  });

  it("claims a pending skip-trace approval once when two approvals race", async () => {
    const verified = await seedProperty({
      address: "1 Approval Race Ln",
      cassStatus: "verified",
    });
    const { data: prop } = await testClient
      .from("properties")
      .select("org_id")
      .eq("id", verified)
      .single();
    const { data: job, error } = await testClient
      .from("jobs")
      .insert({
        type: "skip_trace",
        provider: "tracerfy",
        status: "pending_approval",
        org_id: prop!.org_id,
        total_items: 1,
        title: "Pending skip trace",
        input_params: { property_ids: [verified] },
      })
      .select("id")
      .single();
    if (error || !job) throw error ?? new Error("seed job failed");

    const results = await Promise.all([
      approveSkipTraceJob(job.id),
      approveSkipTraceJob(job.id),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const rejected = results.find((result) => !result.ok);
    expect(rejected?.ok).toBe(false);
    if (rejected?.ok === false) {
      expect(rejected.error.code).toBe("APPROVAL_ALREADY_CLAIMED");
    }
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.any(Function), [
      { jobId: job.id, orgId: prop!.org_id },
    ]);
  });

  it("removes a newly DNC property before approval and records the exclusion", async () => {
    currentEmail = "va@example.com";
    const keep = await seedProperty({
      address: "1 Approval Keep Ln",
      cassStatus: "verified",
    });
    const suppress = await seedProperty({
      address: "2 Approval Suppress Ln",
      cassStatus: "verified",
    });
    const suppressContact = await attachHomeowner(suppress, "0211");
    const requested = await requestSkipTrace([keep, suppress]);
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.data.jobId) return;

    const { error: dncError } = await testClient
      .from("contacts")
      .update({ do_not_contact: true })
      .eq("id", suppressContact);
    if (dncError) throw dncError;

    currentEmail = "jarrad@bmhgroupkc.com";
    const approved = await approveSkipTraceJob(requested.data.jobId);
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.data).toMatchObject({ status: "queued", excluded: 1 });
    }

    const { data: job } = await testClient
      .from("jobs")
      .select("status, total_items, title, input_params, result_summary")
      .eq("id", requested.data.jobId)
      .single();
    expect(job?.status).toBe("queued");
    expect(job?.total_items).toBe(1);
    expect(job?.title).toBe(
      "Skip trace 1 property · 1 excluded before provider submission",
    );
    expect(
      (job?.input_params as { property_ids: string[] }).property_ids,
    ).toEqual([keep]);
    expect(job?.result_summary).toMatchObject({
      eligibility_exclusions: { total: 1, by_reason: { dnc: 1 } },
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("cancels an all-suppressed pending job without balance lookup or workflow start", async () => {
    currentEmail = "va@example.com";
    const suppress = await seedProperty({
      address: "1 Approval All Suppressed Ln",
      cassStatus: "verified",
    });
    const suppressContact = await attachHomeowner(suppress, "0212");
    const requested = await requestSkipTrace([suppress]);
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.data.jobId) return;

    const balanceSpy = vi.spyOn(MockSkipTraceProvider.prototype, "getBalance");
    const { error: dncError } = await testClient
      .from("contacts")
      .update({ sms_opted_out: true })
      .eq("id", suppressContact);
    if (dncError) throw dncError;

    currentEmail = "jarrad@bmhgroupkc.com";
    const approved = await approveSkipTraceJob(requested.data.jobId);
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.data).toMatchObject({ status: "canceled", excluded: 1 });
    }

    const { data: job } = await testClient
      .from("jobs")
      .select("status, total_items, title, input_params, result_summary")
      .eq("id", requested.data.jobId)
      .single();
    expect(job?.status).toBe("canceled");
    expect(job?.total_items).toBe(0);
    expect(job?.title).toBe(
      "Skip trace 0 properties · 1 excluded before provider submission",
    );
    expect(
      (job?.input_params as { property_ids: string[] }).property_ids,
    ).toEqual([]);
    expect(job?.result_summary).toMatchObject({
      eligibility_exclusions: { total: 1, by_reason: { dnc: 1 } },
    });
    expect(balanceSpy).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    balanceSpy.mockRestore();
  });

  it("deduplicates forged duplicate ids before approval audit and launch", async () => {
    const propertyId = await seedProperty({
      address: "1 Duplicate Approval Ln",
      cassStatus: "verified",
    });
    const { data: property } = await testClient
      .from("properties")
      .select("org_id")
      .eq("id", propertyId)
      .single();
    const { data: job, error } = await testClient
      .from("jobs")
      .insert({
        type: "skip_trace",
        provider: "tracerfy",
        status: "pending_approval",
        org_id: property!.org_id,
        total_items: 2,
        title: "Forged duplicate ids",
        input_params: { property_ids: [propertyId, propertyId] },
      })
      .select("id")
      .single();
    if (error || !job) throw error ?? new Error("job seed failed");

    const approved = await approveSkipTraceJob(job.id);

    expect(approved).toMatchObject({
      ok: true,
      data: { status: "queued", excluded: 0 },
    });
    const { data: after } = await testClient
      .from("jobs")
      .select("total_items, input_params, result_summary")
      .eq("id", job.id)
      .single();
    expect(after?.total_items).toBe(1);
    expect(
      (after?.input_params as { property_ids: string[] }).property_ids,
    ).toEqual([propertyId]);
    expect(after?.result_summary).toMatchObject({
      eligibility_exclusions: { requested: 1, eligible: 1, total: 0 },
    });
  });

  it("keeps approval successful when workflow enqueue fails after claim", async () => {
    const verified = await seedProperty({
      address: "1 Approval Start Failure Ln",
      cassStatus: "verified",
    });
    const { data: prop } = await testClient
      .from("properties")
      .select("org_id")
      .eq("id", verified)
      .single();
    const { data: job, error } = await testClient
      .from("jobs")
      .insert({
        type: "skip_trace",
        provider: "tracerfy",
        status: "pending_approval",
        org_id: prop!.org_id,
        total_items: 1,
        title: "Pending skip trace",
        input_params: { property_ids: [verified] },
      })
      .select("id")
      .single();
    if (error || !job) throw error ?? new Error("seed job failed");
    start.mockRejectedValueOnce(new Error("workflow enqueue down"));

    const result = await approveSkipTraceJob(job.id);

    expect(result.ok).toBe(true);
    const { data: after } = await testClient
      .from("jobs")
      .select("status, provider_run_id")
      .eq("id", job.id)
      .single();
    expect(after?.status).toBe("queued");
    expect(after?.provider_run_id).toBeNull();
  });
});
