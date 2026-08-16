import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { MockSkipTraceProvider } from "@/lib/skip-trace/providers/mock";
import type { Json } from "@/lib/supabase/types";

import { skipTraceSubmitWorkflow } from "./skip-trace-submit";

const supabase = createTestClient();

async function orgId(): Promise<string> {
  const { data, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("name", "BMH Group")
    .single();
  if (error || !data) throw error ?? new Error("organization missing");
  return data.id;
}

async function seedProperty(
  suffix: string,
): Promise<{ propertyId: string; contactId: string }> {
  const organizationId = await orgId();
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      org_id: organizationId,
      first_name: `Submit ${suffix}`,
      last_name: "Owner",
      phone_1: `+1816556${suffix.padStart(4, "0")}`,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactError || !contact) {
    throw contactError ?? new Error("contact insert failed");
  }
  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .insert({
      org_id: organizationId,
      address: `${Number(suffix)} Submit Safety Ln`,
      city: "Kansas City",
      state: "MO",
      status: "prospect",
      cass_status: "verified",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  if (propertyError || !property) {
    throw propertyError ?? new Error("property insert failed");
  }
  return { propertyId: property.id, contactId: contact.id };
}

async function seedQueuedJob(
  propertyIds: string[],
  priorEligibilityAudit?: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      org_id: await orgId(),
      type: "skip_trace",
      provider: "tracerfy",
      status: "queued",
      total_items: propertyIds.length,
      title: "Submit safety test",
      input_params: {
        property_ids: propertyIds,
        ...(priorEligibilityAudit
          ? { eligibility_exclusions: priorEligibilityAudit }
          : {}),
      } as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("job insert failed");
  return data.id;
}

describe("skipTraceSubmitWorkflow DNC recheck (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    process.env.SKIP_TRACE_PROVIDER = "mock";
    MockSkipTraceProvider.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    MockSkipTraceProvider.reset();
  });

  it("removes a property suppressed after queueing before the provider call", async () => {
    const keep = await seedProperty("0311");
    const suppress = await seedProperty("0312");
    const jobId = await seedQueuedJob([keep.propertyId, suppress.propertyId]);
    const { error } = await supabase
      .from("contacts")
      .update({ do_not_contact: true })
      .eq("id", suppress.contactId);
    if (error) throw error;
    const lookup = vi.spyOn(MockSkipTraceProvider.prototype, "lookupSingle");

    const outcome = await skipTraceSubmitWorkflow({ jobId, orgId: await orgId() });

    expect(outcome.status).toBe("submitted");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[0].propertyId).toBe(keep.propertyId);
    const { data: job } = await supabase
      .from("jobs")
      .select("status, total_items, input_params, result_summary")
      .eq("id", jobId)
      .single();
    expect(job?.total_items).toBe(1);
    expect((job?.input_params as { property_ids: string[] }).property_ids).toEqual([
      keep.propertyId,
    ]);
    expect(job?.result_summary).toMatchObject({
      eligibility_exclusions: { total: 1, by_reason: { dnc: 1 } },
    });
  });

  it("preserves approval exclusions while adding a submit-time exclusion", async () => {
    const keep = await seedProperty("0313");
    const suppress = await seedProperty("0314");
    const jobId = await seedQueuedJob(
      [keep.propertyId, suppress.propertyId],
      {
        checked_at: "2026-08-15T00:00:00.000Z",
        requested: 3,
        eligible: 2,
        total: 1,
        by_reason: {
          dnc: 1,
          skip_trace_disabled: 0,
          cass_unverified: 0,
          not_found_or_wrong_org: 0,
        },
      },
    );
    const { error } = await supabase
      .from("contacts")
      .update({ do_not_contact: true })
      .eq("id", suppress.contactId);
    if (error) throw error;

    await skipTraceSubmitWorkflow({ jobId, orgId: await orgId() });

    const { data: job } = await supabase
      .from("jobs")
      .select("result_summary")
      .eq("id", jobId)
      .single();
    expect(job?.result_summary).toMatchObject({
      eligibility_exclusions: {
        requested: 3,
        eligible: 1,
        total: 2,
        by_reason: { dnc: 2 },
      },
    });
  });

  it("cancels when every queued property is suppressed without any paid provider call", async () => {
    const suppress = await seedProperty("0321");
    const jobId = await seedQueuedJob([suppress.propertyId]);
    const { error } = await supabase
      .from("contacts")
      .update({ sms_opted_out: true })
      .eq("id", suppress.contactId);
    if (error) throw error;
    const lookup = vi.spyOn(MockSkipTraceProvider.prototype, "lookupSingle");
    const submit = vi.spyOn(MockSkipTraceProvider.prototype, "submitBatch");

    const outcome = await skipTraceSubmitWorkflow({ jobId, orgId: await orgId() });

    expect(outcome).toMatchObject({ status: "canceled", excluded: 1 });
    expect(lookup).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    const { data: job } = await supabase
      .from("jobs")
      .select("status, total_items, input_params, result_summary")
      .eq("id", jobId)
      .single();
    expect(job?.status).toBe("canceled");
    expect(job?.total_items).toBe(0);
    expect((job?.input_params as { property_ids: string[] }).property_ids).toEqual([]);
    expect(job?.result_summary).toMatchObject({
      submit_phase: "canceled_before_provider",
      eligibility_exclusions: { total: 1, by_reason: { dnc: 1 } },
    });
  });

  it("allows only one concurrent durable claimant to submit the batch", async () => {
    const first = await seedProperty("0331");
    const second = await seedProperty("0332");
    const jobId = await seedQueuedJob([first.propertyId, second.propertyId]);
    const submit = vi.spyOn(MockSkipTraceProvider.prototype, "submitBatch");
    const organizationId = await orgId();

    const outcomes = await Promise.all([
      skipTraceSubmitWorkflow({ jobId, orgId: organizationId }),
      skipTraceSubmitWorkflow({ jobId, orgId: organizationId }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "submitted")).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1);
    const { data: job } = await supabase
      .from("jobs")
      .select("status, provider_run_id")
      .eq("id", jobId)
      .single();
    expect(job?.status).toBe("running");
    expect(job?.provider_run_id).toBeTruthy();
  });

  it("refuses a job id paired with the wrong organization before provider access", async () => {
    const property = await seedProperty("0341");
    const jobId = await seedQueuedJob([property.propertyId]);
    const lookup = vi.spyOn(MockSkipTraceProvider.prototype, "lookupSingle");
    const submit = vi.spyOn(MockSkipTraceProvider.prototype, "submitBatch");

    await expect(
      skipTraceSubmitWorkflow({ jobId, orgId: crypto.randomUUID() }),
    ).rejects.toThrow(`job ${jobId} not found`);
    expect(lookup).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    const { data: job } = await supabase
      .from("jobs")
      .select("status, provider_run_id")
      .eq("id", jobId)
      .single();
    expect(job?.status).toBe("queued");
    expect(job?.provider_run_id).toBeNull();
  });
});
