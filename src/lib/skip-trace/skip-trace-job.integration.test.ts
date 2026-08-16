import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { MockSkipTraceProvider } from "./providers/mock";
import { persistSkipTraceResult } from "./persist-result";
import {
  finalizeSkipTraceFromBatch,
  runSkipTraceEnrichment,
} from "./skip-trace-job";
import type { SkipTraceResult } from "./types";

const supabase = createTestClient();

async function getOrgId(): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .eq("name", "BMH Group")
    .single();
  return data!.id;
}

async function seedProperty(opts: {
  address: string;
  city?: string;
  state?: string;
  withContact?: boolean;
  cassStatus?: "verified" | "unverified";
}): Promise<{ propertyId: string; contactId: string | null }> {
  const orgId = await getOrgId();
  let contactId: string | null = null;
  if (opts.withContact) {
    const { data: contact } = await supabase
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "Existing",
        last_name: "Owner",
      })
      .select("id")
      .single();
    contactId = contact!.id;
  }
  const { data: property } = await supabase
    .from("properties")
    .insert({
      org_id: orgId,
      address: opts.address,
      city: opts.city ?? "Kansas City",
      state: opts.state ?? "MO",
      status: "new_lead",
      homeowner_contact_id: contactId,
      cass_status: opts.cassStatus === undefined ? "verified" : opts.cassStatus,
    })
    .select("id")
    .single();
  return { propertyId: property!.id, contactId };
}

async function createPendingJob(propertyIds: string[]): Promise<string> {
  const orgId = await getOrgId();
  const { data } = await supabase
    .from("jobs")
    .insert({
      type: "skip_trace",
      provider: "tracerfy",
      status: "queued",
      org_id: orgId,
      total_items: propertyIds.length,
      title: "Test skip-trace job",
      input_params: { property_ids: propertyIds },
    })
    .select("id")
    .single();
  return data!.id;
}

describe("runSkipTraceEnrichment (integration, mock provider)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    MockSkipTraceProvider.reset();
    vi.restoreAllMocks();
  });

  it("rechecks a claimed job after a homeowner opts out and makes no provider call", async () => {
    const { propertyId, contactId } = await seedProperty({
      address: "1 Provider Boundary Opt Out Ln",
      withContact: true,
    });
    const jobId = await createPendingJob([propertyId]);
    const organizationId = await getOrgId();
    const lookup = vi.spyOn(MockSkipTraceProvider.prototype, "lookupSingle");
    const submit = vi.spyOn(MockSkipTraceProvider.prototype, "submitBatch");

    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: organizationId,
      propertyIds: [propertyId],
      beforeProviderEligibilityCheck: async () => {
        const { error } = await supabase
          .from("contacts")
          .update({ sms_opted_out: true })
          .eq("id", contactId!);
        if (error) throw error;
      },
    });

    expect(lookup).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    const { data: job } = await supabase
      .from("jobs")
      .select("status, total_items, input_params, result_summary")
      .eq("id", jobId)
      .single();
    expect(job?.status).toBe("canceled");
    expect(job?.total_items).toBe(0);
    expect(
      (job?.input_params as { property_ids: string[] }).property_ids,
    ).toEqual([]);
    expect(job?.result_summary).toMatchObject({
      eligibility_exclusions: { total: 1, by_reason: { dnc: 1 } },
      submit_phase: "canceled_before_provider",
    });
  });

  it("refuses a runner job and property from another organization", async () => {
    const { propertyId } = await seedProperty({
      address: "1 Wrong Org Runner Ln",
    });
    const jobId = await createPendingJob([propertyId]);
    const lookup = vi.spyOn(MockSkipTraceProvider.prototype, "lookupSingle");
    const submit = vi.spyOn(MockSkipTraceProvider.prototype, "submitBatch");

    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: crypto.randomUUID(),
      propertyIds: [propertyId],
    });

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

  it("fails closed for an org-A job cross-wired to a valid org-B property", async () => {
    const { data: orgB, error: orgError } = await supabase
      .from("organizations")
      .insert({ name: `Runner Tenant B ${crypto.randomUUID()}` })
      .select("id")
      .single();
    if (orgError || !orgB) throw orgError ?? new Error("org B missing");
    const { data: property, error: propertyError } = await supabase
      .from("properties")
      .insert({
        org_id: orgB.id,
        address: "1 Cross Wired Tenant Ln",
        state: "MO",
        status: "prospect",
        cass_status: "verified",
        skip_trace_disabled: false,
      })
      .select("id")
      .single();
    if (propertyError || !property) {
      throw propertyError ?? new Error("org B property missing");
    }
    const defaultProperty = await seedProperty({ address: "1 Org A Job Ln" });
    const jobId = await createPendingJob([defaultProperty.propertyId]);
    const lookup = vi.spyOn(MockSkipTraceProvider.prototype, "lookupSingle");
    const submit = vi.spyOn(MockSkipTraceProvider.prototype, "submitBatch");

    const result = await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: orgB.id,
      propertyIds: [property.id],
    });

    expect(result).toEqual({ claimed: false });
    expect(lookup).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await supabase.from("organizations").delete().eq("id", orgB.id);
  });

  it("allows only one concurrent direct sync runner to reach the provider", async () => {
    const { propertyId } = await seedProperty({
      address: "1 Sync Claim Race Ln",
    });
    const jobId = await createPendingJob([propertyId]);
    const lookup = vi.spyOn(MockSkipTraceProvider.prototype, "lookupSingle");
    const params = {
      jobId,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    };

    const outcomes = await Promise.all([
      runSkipTraceEnrichment(supabase, params),
      runSkipTraceEnrichment(supabase, params),
    ]);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((outcome) => "claimed" in outcome)).toHaveLength(1);
  });

  it("canonicalizes duplicate direct-runner ids before claim and processing", async () => {
    const { propertyId } = await seedProperty({
      address: "1 Duplicate Runner Ln",
    });
    const jobId = await createPendingJob([propertyId]);
    const lookup = vi.spyOn(MockSkipTraceProvider.prototype, "lookupSingle");

    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: [propertyId, propertyId],
    });

    expect(lookup).toHaveBeenCalledTimes(1);
    const { data: job } = await supabase
      .from("jobs")
      .select("status, total_items, processed_items, succeeded_items")
      .eq("id", jobId)
      .single();
    expect(job).toMatchObject({
      status: "completed",
      total_items: 1,
      processed_items: 1,
      succeeded_items: 1,
    });
    const { count } = await supabase
      .from("job_items")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .eq("property_id", propertyId);
    expect(count).toBe(1);
  });

  it("allows only one concurrent direct batch runner to reach the provider", async () => {
    const first = await seedProperty({ address: "1 Batch Claim Race Ln" });
    const second = await seedProperty({ address: "2 Batch Claim Race Ln" });
    const propertyIds = [first.propertyId, second.propertyId];
    const jobId = await createPendingJob(propertyIds);
    const submit = vi.spyOn(MockSkipTraceProvider.prototype, "submitBatch");
    const params = { jobId, orgId: await getOrgId(), propertyIds };

    const outcomes = await Promise.all([
      runSkipTraceEnrichment(supabase, params),
      runSkipTraceEnrichment(supabase, params),
    ]);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((outcome) => "claimed" in outcome)).toHaveLength(1);
  });

  it("audits kill-switch, CASS, and deletion changes made during preparation", async () => {
    const disabled = await seedProperty({ address: "1 Prep Disabled Ln" });
    const unverified = await seedProperty({ address: "2 Prep CASS Ln" });
    const deleted = await seedProperty({ address: "3 Prep Deleted Ln" });
    const propertyIds = [
      disabled.propertyId,
      unverified.propertyId,
      deleted.propertyId,
    ];
    const jobId = await createPendingJob(propertyIds);
    const lookup = vi.spyOn(MockSkipTraceProvider.prototype, "lookupSingle");
    const submit = vi.spyOn(MockSkipTraceProvider.prototype, "submitBatch");

    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds,
      beforeProviderEligibilityCheck: async () => {
        await supabase
          .from("properties")
          .update({ skip_trace_disabled: true })
          .eq("id", disabled.propertyId);
        await supabase
          .from("properties")
          .update({ cass_status: "unverified" })
          .eq("id", unverified.propertyId);
        await supabase
          .from("properties")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", deleted.propertyId);
      },
    });

    expect(lookup).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    const { data: job } = await supabase
      .from("jobs")
      .select("status, result_summary")
      .eq("id", jobId)
      .single();
    expect(job?.status).toBe("canceled");
    expect(job?.result_summary).toMatchObject({
      eligibility_exclusions: {
        requested: 3,
        eligible: 0,
        total: 3,
        by_reason: {
          skip_trace_disabled: 1,
          cass_unverified: 1,
          not_found_or_wrong_org: 1,
        },
      },
    });
  });

  it("rechecks a partial batch after its summary checkpoint", async () => {
    const keepA = await seedProperty({ address: "1 Batch Boundary Keep Ln" });
    const keepB = await seedProperty({ address: "2 Batch Boundary Keep Ln" });
    const suppress = await seedProperty({ address: "3 Batch Boundary DNC Ln" });
    const propertyIds = [
      keepA.propertyId,
      keepB.propertyId,
      suppress.propertyId,
    ];
    const jobId = await createPendingJob(propertyIds);
    const submit = vi.spyOn(MockSkipTraceProvider.prototype, "submitBatch");

    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds,
      beforeBatchProviderEligibilityCheck: async () => {
        await supabase
          .from("properties")
          .update({ outreach_dispo: "dnc" })
          .eq("id", suppress.propertyId);
      },
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      submit.mock.calls[0]?.[0].map((input) => input.propertyId).sort(),
    ).toEqual([keepA.propertyId, keepB.propertyId].sort());
  });

  it("makes no batch provider call when all rows suppress after the summary checkpoint", async () => {
    const first = await seedProperty({
      address: "1 Batch Boundary All DNC Ln",
    });
    const second = await seedProperty({
      address: "2 Batch Boundary All DNC Ln",
    });
    const propertyIds = [first.propertyId, second.propertyId];
    const jobId = await createPendingJob(propertyIds);
    const submit = vi.spyOn(MockSkipTraceProvider.prototype, "submitBatch");

    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds,
      beforeBatchProviderEligibilityCheck: async () => {
        await supabase
          .from("properties")
          .update({ outreach_dispo: "dnc" })
          .in("id", propertyIds);
      },
    });

    expect(submit).not.toHaveBeenCalled();
    const { data: job } = await supabase
      .from("jobs")
      .select("status, result_summary")
      .eq("id", jobId)
      .single();
    expect(job?.status).toBe("canceled");
    expect(job?.result_summary).toMatchObject({
      eligibility_exclusions: { eligible: 0, total: 2, by_reason: { dnc: 2 } },
    });
  });

  it("sync path: 1 property, hit → contact created + populated, job completes", async () => {
    const { propertyId } = await seedProperty({ address: "1 Default Ln" });
    const jobId = await createPendingJob([propertyId]);

    const result = await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    });
    expect("pending" in result).toBe(false);

    // Property should now have a homeowner contact with phone_1.
    const { data: prop } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", propertyId)
      .single();
    expect(prop!.homeowner_contact_id).not.toBeNull();
    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1, email")
      .eq("id", prop!.homeowner_contact_id!)
      .single();
    expect(contact!.phone_1).toBe("+18165550199");
    expect(contact!.email).toBe("mock@example.com");

    const { data: job } = await supabase
      .from("jobs")
      .select("status, succeeded_items, result_summary")
      .eq("id", jobId)
      .single();
    expect(job!.status).toBe("completed");
    expect(job!.succeeded_items).toBe(1);
  });

  it("MISS prefix → no_match, no phones written, job completes", async () => {
    const { propertyId, contactId } = await seedProperty({
      address: "MISS — no data",
      withContact: true,
    });
    const jobId = await createPendingJob([propertyId]);

    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    });

    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1")
      .eq("id", contactId!)
      .single();
    expect(contact!.phone_1).toBeNull();

    const { data: job } = await supabase
      .from("jobs")
      .select("status, result_summary")
      .eq("id", jobId)
      .single();
    expect(job!.status).toBe("completed");
    expect(
      (job!.result_summary as { no_match?: number } | null)?.no_match,
    ).toBe(1);
  });

  it("DNC prefix → phone is dropped (defensive belt), job completes with no_match-like behavior", async () => {
    const { propertyId, contactId } = await seedProperty({
      address: "DNC — only dnc number",
      withContact: true,
    });
    const jobId = await createPendingJob([propertyId]);

    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    });

    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1, phone_2, phone_3")
      .eq("id", contactId!)
      .single();
    // The DNC phone should not have been written.
    expect(contact!.phone_1).toBeNull();
    expect(contact!.phone_2).toBeNull();
    expect(contact!.phone_3).toBeNull();
  });

  it("a provider DNC phone ratchets do_not_contact=true on the contact, not just drops the number (Codex PR #310 finding 4)", async () => {
    const { propertyId, contactId } = await seedProperty({
      address: "600 Dnc Ratchet Ln",
      withContact: true,
    });

    const result: SkipTraceResult = {
      propertyId,
      hit: true,
      persons: [
        {
          firstName: "Owner",
          lastName: "Six",
          phones: [
            { number: "+18165550600", type: "Mobile", dnc: false, rank: 1 },
            { number: "+18165550601", type: "Mobile", dnc: true, rank: 2 },
          ],
          emails: [],
          isOwner: true,
        },
      ],
      creditsDeducted: 1,
      raw: {},
    };

    await persistSkipTraceResult(supabase, await getOrgId(), result);

    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1, phone_2, phone_3, do_not_contact")
      .eq("id", contactId!)
      .single();
    // The clean mobile is kept; the DNC-flagged number never lands in a
    // slot; the contact-level flag is ratcheted regardless.
    expect(contact!.phone_1).toBe("+18165550600");
    expect(contact!.phone_2).toBeNull();
    expect(contact!.phone_3).toBeNull();
    expect(contact!.do_not_contact).toBe(true);
  });

  it("finds + ratchets an existing contact via a LOWER-ranked DNC phone, not just the top-ranked one (Codex round-4 finding)", async () => {
    // The provider returns 2 phones for this owner: rank 1 is a clean,
    // brand-new number nobody has; rank 2 is DNC-flagged and already
    // belongs to a DIFFERENT existing contact. resolveContactByPhone()
    // previously checked only the top-ranked phone (rank 1 → miss), so it
    // fell through to insert a brand-new contact — a suppressed duplicate
    // — while the real contact (holding the DNC number) stayed callable.
    const orgId = await getOrgId();
    const { data: existingContact } = await supabase
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "Existing",
        last_name: "Owner",
        phone_1: "+18165550620",
        phone_1_type: "mobile",
      })
      .select("id")
      .single();

    const { propertyId } = await seedProperty({
      address: "620 Dnc Rank Ln",
      withContact: false,
    });

    const result: SkipTraceResult = {
      propertyId,
      hit: true,
      persons: [
        {
          firstName: "Owner",
          lastName: "Eight",
          phones: [
            { number: "+18165550621", type: "Mobile", dnc: false, rank: 1 },
            { number: "+18165550620", type: "Mobile", dnc: true, rank: 2 },
          ],
          emails: [],
          isOwner: true,
        },
      ],
      creditsDeducted: 1,
      raw: {},
    };

    await persistSkipTraceResult(supabase, orgId, result);

    // Reused the EXISTING contact — no duplicate created — and ratcheted it.
    const { count: contactCount } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId);
    expect(contactCount).toBe(1);

    const { data: contact } = await supabase
      .from("contacts")
      .select("id, do_not_contact")
      .eq("id", existingContact!.id)
      .single();
    expect(contact!.do_not_contact).toBe(true);

    const { data: property } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", propertyId)
      .single();
    expect(property!.homeowner_contact_id).toBe(existingContact!.id);
  });

  it("never clears an already-suppressed contact when a later skip-trace hit carries no DNC phone (one-way ratchet)", async () => {
    const { propertyId, contactId } = await seedProperty({
      address: "610 Dnc Ratchet Ln",
      withContact: true,
    });
    await supabase
      .from("contacts")
      .update({ do_not_contact: true })
      .eq("id", contactId!);

    const result: SkipTraceResult = {
      propertyId,
      hit: true,
      persons: [
        {
          firstName: "Owner",
          lastName: "Seven",
          phones: [
            { number: "+18165550610", type: "Mobile", dnc: false, rank: 1 },
          ],
          emails: [],
          isOwner: true,
        },
      ],
      creditsDeducted: 1,
      raw: {},
    };

    await persistSkipTraceResult(supabase, await getOrgId(), result);

    const { data: contact } = await supabase
      .from("contacts")
      .select("do_not_contact")
      .eq("id", contactId!)
      .single();
    expect(contact!.do_not_contact).toBe(true);
  });

  it("async path: 3 properties → batch submitted, job stays running with provider_run_id", async () => {
    const props = await Promise.all([
      seedProperty({ address: "10 Async Ln" }),
      seedProperty({ address: "20 Async Ln" }),
      seedProperty({ address: "30 Async Ln" }),
    ]);
    const ids = props.map((p) => p.propertyId);
    const jobId = await createPendingJob(ids);

    const out = await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: ids,
    });
    expect("pending" in out).toBe(true);

    const { data: job } = await supabase
      .from("jobs")
      .select("status, provider_run_id")
      .eq("id", jobId)
      .single();
    expect(job!.status).toBe("running");
    expect(job!.provider_run_id).toBeTruthy();
  });

  it("async path: does not submit a second provider batch after a queue id is already saved", async () => {
    const props = await Promise.all([
      seedProperty({ address: "11 Duplicate Submit Ln" }),
      seedProperty({ address: "22 Duplicate Submit Ln" }),
    ]);
    const ids = props.map((p) => p.propertyId);
    const jobId = await createPendingJob(ids);
    await supabase
      .from("jobs")
      .update({
        status: "running",
        provider_run_id: "already-submitted-q",
      })
      .eq("id", jobId);

    const out = await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: ids,
    });
    expect("pending" in out).toBe(false);

    const provider = new MockSkipTraceProvider();
    expect(await provider.pollBatch("mock-queue-1")).toBeNull();

    const { data: job } = await supabase
      .from("jobs")
      .select("provider_run_id, result_summary")
      .eq("id", jobId)
      .single();
    expect(job!.provider_run_id).toBe("already-submitted-q");
    expect(job!.result_summary).toBeNull();
  });

  it("async path: queue-id persistence race requires manual reconciliation", async () => {
    const props = await Promise.all([
      seedProperty({ address: "33 Queue Race Ln" }),
      seedProperty({ address: "44 Queue Race Ln" }),
    ]);
    const ids = props.map((p) => p.propertyId);
    const jobId = await createPendingJob(ids);
    const originalSubmitBatch = MockSkipTraceProvider.prototype.submitBatch;
    MockSkipTraceProvider.prototype.submitBatch = async function (inputs) {
      const ticket = await originalSubmitBatch.call(this, inputs);
      await supabase
        .from("jobs")
        .update({ provider_run_id: "winner-q" })
        .eq("id", jobId);
      return ticket;
    };

    try {
      const out = await runSkipTraceEnrichment(supabase, {
        jobId,
        orgId: await getOrgId(),
        propertyIds: ids,
      });
      expect("pending" in out).toBe(false);
    } finally {
      MockSkipTraceProvider.prototype.submitBatch = originalSubmitBatch;
    }

    const { data: job } = await supabase
      .from("jobs")
      .select("status, provider_run_id, error_class, result_summary")
      .eq("id", jobId)
      .single();
    expect(job!.status).toBe("canceled");
    expect(job!.provider_run_id).toBe("winner-q");
    expect(job!.error_class).toBe("submission_unknown");
    expect(job!.result_summary).toMatchObject({
      submit_phase: "submission_unknown",
      manual_reconciliation_required: true,
      provider_queue_id_for_reconciliation: "mock-queue-1",
    });
  });

  it("finalizeSkipTraceFromBatch persists results + completes the job", async () => {
    const props = await Promise.all([
      seedProperty({ address: "100 Batch Ln" }),
      seedProperty({ address: "200 Batch Ln" }),
    ]);
    const ids = props.map((p) => p.propertyId);
    const jobId = await createPendingJob(ids);

    // Kick off the async path.
    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: ids,
    });

    // Simulate the provider returning results.
    const fakeResults: SkipTraceResult[] = ids.map((id) => ({
      propertyId: id,
      hit: true,
      persons: [
        {
          firstName: "Batch",
          lastName: "Owner",
          phones: [
            { number: "+18165550111", type: "Mobile", dnc: false, rank: 1 },
          ],
          emails: [],
          isOwner: true,
        },
      ],
      creditsDeducted: 1,
      raw: {},
    }));

    await finalizeSkipTraceFromBatch(supabase, {
      jobId,
      results: fakeResults,
    });

    const { data: job } = await supabase
      .from("jobs")
      .select("status, succeeded_items")
      .eq("id", jobId)
      .single();
    expect(job!.status).toBe("completed");
    expect(job!.succeeded_items).toBe(2);

    // Each property should now have a contact with the same phone.
    // Bonus: both properties should resolve to the SAME contact, since
    // the same phone resolves to one row by the global unique index.
    const contactIds = new Set<string>();
    for (const id of ids) {
      const { data: prop } = await supabase
        .from("properties")
        .select("homeowner_contact_id")
        .eq("id", id)
        .single();
      expect(prop!.homeowner_contact_id).not.toBeNull();
      const { data: c } = await supabase
        .from("contacts")
        .select("phone_1")
        .eq("id", prop!.homeowner_contact_id!)
        .single();
      expect(c!.phone_1).toBe("+18165550111");
      contactIds.add(prop!.homeowner_contact_id!);
    }
    expect(contactIds.size).toBe(1);
  });

  it("second finalize loses the claim: returns null, writes no duplicate items", async () => {
    // 2026-06-12: the sweep cron fires every minute while a 4K-row
    // finalize takes several — overlapping finalizers quadruple-wrote
    // job_items. The running→finalizing claim makes finalize re-entrant.
    const { propertyId } = await seedProperty({ address: "55 Claim Ln" });
    const jobId = await createPendingJob([propertyId]);
    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    });
    // The 1-miss path runs sync; force the job back to running with a
    // provider_run_id so it looks like a pending batch.
    await supabase
      .from("jobs")
      .update({ status: "running", provider_run_id: "claim-test-q" })
      .eq("id", jobId);

    const fakeResults: SkipTraceResult[] = [
      {
        propertyId,
        hit: false,
        persons: [],
        creditsDeducted: 0,
        raw: {},
      },
    ];

    const first = await finalizeSkipTraceFromBatch(supabase, {
      jobId,
      results: fakeResults,
    });
    expect(first).not.toBeNull();

    const { count: itemsAfterFirst } = await supabase
      .from("job_items")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId);

    // Job is terminal now — a late webhook / overlapping tick must
    // no-op instead of re-applying results.
    const second = await finalizeSkipTraceFromBatch(supabase, {
      jobId,
      results: fakeResults,
    });
    expect(second).toBeNull();

    const { count: itemsAfterSecond } = await supabase
      .from("job_items")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId);
    expect(itemsAfterSecond).toBe(itemsAfterFirst);
  });

  it("resumed finalize skips already-itemized properties and reconciles counters from the ledger", async () => {
    // A finalizer killed by the platform's max-duration leaves partial
    // job_items behind and the claim-revert never runs (2026-06-12).
    // The sweep rescues the job back to 'running'; the next finalize
    // pass must skip rows a dead pass already persisted and compute
    // terminal counters from job_items, not memory.
    const props = await Promise.all([
      seedProperty({ address: "61 Resume Ln" }),
      seedProperty({ address: "62 Resume Ln" }),
      seedProperty({ address: "63 Resume Ln" }),
    ]);
    const ids = props.map((p) => p.propertyId);
    const jobId = await createPendingJob(ids);
    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: ids,
    });

    // Simulate the dead pass: one property already has a success item
    // (must be skipped), one has a TRANSIENT error item (must be retried
    // — its stale row deleted and reprocessed to success).
    await supabase.from("job_items").insert([
      {
        job_id: jobId,
        property_id: ids[0],
        status: "success",
        output_payload: { phones_added: 1 },
      },
      {
        job_id: jobId,
        property_id: ids[2],
        status: "error",
        error_class: "database",
        error_message: "transient hiccup from the dead pass",
      },
    ]);
    // Rescue path: job back to running with the batch still pending.
    await supabase
      .from("jobs")
      .update({ status: "running", provider_run_id: "resume-test-q" })
      .eq("id", jobId);

    const fakeResults: SkipTraceResult[] = ids.map((id) => ({
      propertyId: id,
      hit: true,
      persons: [
        {
          firstName: "Resume",
          lastName: "Owner",
          phones: [
            { number: "+18165550161", type: "Mobile", dnc: false, rank: 1 },
          ],
          emails: [],
          isOwner: true,
        },
      ],
      creditsDeducted: 1,
      raw: {},
    }));

    const out = await finalizeSkipTraceFromBatch(supabase, {
      jobId,
      results: fakeResults,
    });
    expect(out).not.toBeNull();

    // Exactly one item per property — the success skip untouched, the
    // transient error replaced by a fresh outcome, no duplicates.
    const { data: items } = await supabase
      .from("job_items")
      .select("property_id, status, error_class")
      .eq("job_id", jobId);
    expect(items).toHaveLength(3);
    expect(new Set(items!.map((i) => i.property_id)).size).toBe(3);
    const retried = items!.find((i) => i.property_id === ids[2]);
    expect(retried!.status).toBe("success");
    expect(retried!.error_class).toBeNull();

    // Counters reconciled from the ledger: all three count as matched.
    const { data: job } = await supabase
      .from("jobs")
      .select("status, succeeded_items, failed_items")
      .eq("id", jobId)
      .single();
    expect(job!.status).toBe("completed");
    expect(job!.succeeded_items).toBe(3);
    expect(job!.failed_items).toBe(0);
  });

  it("shared owner name with no phones: second persist reuses the name-only contact instead of colliding", async () => {
    // contacts_person_name_key is a partial unique index on
    // (lower(last), lower(first)) WHERE phone_1 IS NULL AND email IS
    // NULL. An owner who returns no usable phones leaves a name-only
    // contact; persisting a second property for the same owner used to
    // die on the insert (624 rows on 2026-06-12).
    const a = await seedProperty({ address: "71 Sameowner St" });
    const b = await seedProperty({ address: "72 Sameowner St" });
    const orgId = await getOrgId();

    const nameOnlyResult = (propertyId: string): SkipTraceResult => ({
      propertyId,
      hit: true,
      persons: [
        {
          firstName: "Landlord",
          lastName: "Manyhouses",
          phones: [],
          emails: [],
          isOwner: true,
        },
      ],
      creditsDeducted: 2,
      raw: {},
    });

    const first = await persistSkipTraceResult(
      supabase,
      orgId,
      nameOnlyResult(a.propertyId),
    );
    expect(first.status).toBe("matched");

    const second = await persistSkipTraceResult(
      supabase,
      orgId,
      nameOnlyResult(b.propertyId),
    );
    expect(second.status).toBe("matched");
    expect(second.contactId).toBe(first.contactId);

    // Both properties point at the one shared contact.
    const { data: props } = await supabase
      .from("properties")
      .select("id, homeowner_contact_id")
      .in("id", [a.propertyId, b.propertyId]);
    expect(new Set(props!.map((p) => p.homeowner_contact_id)).size).toBe(1);
  });

  it("phone owned by another contact degrades gracefully: names land, phone skipped", async () => {
    // contacts_phone_1_key is global — a returned number that already
    // belongs to a different contact must not sink the whole update.
    const a = await seedProperty({ address: "81 Phoneclash Ave" });
    const b = await seedProperty({
      address: "82 Phoneclash Ave",
      withContact: true,
    });
    const orgId = await getOrgId();

    const sharedPhone = "+18165550777";
    const withPhone = (propertyId: string, name: string): SkipTraceResult => ({
      propertyId,
      hit: true,
      persons: [
        {
          firstName: name,
          lastName: "Owner",
          phones: [
            { number: sharedPhone, type: "Mobile", dnc: false, rank: 1 },
          ],
          emails: [],
          isOwner: true,
        },
      ],
      creditsDeducted: 2,
      raw: {},
    });

    // First persist claims the phone on property A's new contact.
    const first = await persistSkipTraceResult(
      supabase,
      orgId,
      withPhone(a.propertyId, "Alpha"),
    );
    expect(first.phonesAdded).toBe(1);

    // Property B already HAS a contact (import-created), so the
    // phone-reuse pre-resolve is skipped and the update path hits the
    // unique index. It must degrade (skip the phone), not throw.
    const second = await persistSkipTraceResult(
      supabase,
      orgId,
      withPhone(b.propertyId, "Beta"),
    );
    expect(second.status).toBe("matched");
    expect(second.phonesAdded).toBe(0);
  });

  it("cache hit on second run: no provider call, contact unchanged", async () => {
    const { propertyId } = await seedProperty({ address: "Cache Test Ln" });

    // First run: populates the cache.
    const job1 = await createPendingJob([propertyId]);
    await runSkipTraceEnrichment(supabase, {
      jobId: job1,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    });

    // Second run on the same property → cache hit.
    const job2 = await createPendingJob([propertyId]);
    await runSkipTraceEnrichment(supabase, {
      jobId: job2,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    });

    const { data: job2Row } = await supabase
      .from("jobs")
      .select("status, result_summary")
      .eq("id", job2)
      .single();
    expect(job2Row!.status).toBe("completed");
    const summary = job2Row!.result_summary as {
      cached_hits?: number;
      api_hits?: number;
    } | null;
    expect(summary?.cached_hits).toBe(1);
    expect(summary?.api_hits).toBe(0);
  });

  it("normalizes provider-returned phones to E.164 before persisting", async () => {
    // RAW prefix → mock returns bare "8167416576" (Tracerfy's actual shape)
    const { propertyId } = await seedProperty({ address: "RAW phone test" });
    const jobId = await createPendingJob([propertyId]);

    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    });

    const { data: prop } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", propertyId)
      .single();
    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1")
      .eq("id", prop!.homeowner_contact_id!)
      .single();
    expect(contact!.phone_1).toBe("+18167416576");
  });

  it("dedupes phones: re-running on a contact whose phone_1 already matches doesn't fill phone_2", async () => {
    const { propertyId, contactId } = await seedProperty({
      address: "Dedupe Test Ln",
      withContact: true,
    });
    // Pre-populate phone_1 with the same number the mock will return.
    await supabase
      .from("contacts")
      .update({ phone_1: "+18165550199", phone_1_type: "mobile" })
      .eq("id", contactId!);

    const jobId = await createPendingJob([propertyId]);
    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    });

    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1, phone_2, phone_3")
      .eq("id", contactId!)
      .single();
    expect(contact!.phone_1).toBe("+18165550199");
    expect(contact!.phone_2).toBeNull();
    expect(contact!.phone_3).toBeNull();
  });

  it("promotes a newly traced mobile into slot 1 when slot 1 holds a classified landline", async () => {
    const { propertyId, contactId } = await seedProperty({
      address: "Promotion Test Ln",
      withContact: true,
    });
    // Contact already carries a known landline in slot 1 (e.g. from a
    // CSV import + carrier lookup). The mock provider returns a Mobile
    // (+18165550199); persist must put the mobile in slot 1 — every
    // send path texts slot 1 and hard-blocks landlines.
    await supabase
      .from("contacts")
      .update({ phone_1: "+18165550155", phone_1_type: "landline" })
      .eq("id", contactId!);

    const jobId = await createPendingJob([propertyId]);
    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    });

    const { data: contact } = await supabase
      .from("contacts")
      .select(
        "phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type",
      )
      .eq("id", contactId!)
      .single();
    expect(contact!.phone_1).toBe("+18165550199");
    expect(contact!.phone_1_type).toBe("mobile");
    expect(contact!.phone_2).toBe("+18165550155");
    expect(contact!.phone_2_type).toBe("landline");
    expect(contact!.phone_3).toBeNull();
  });

  it("drops unlabeled provider phones (hard rule) instead of failing the write on the 080 trigger", async () => {
    const { propertyId, contactId } = await seedProperty({
      address: "UNTYPED Hard Rule Ln",
      withContact: true,
    });

    const jobId = await createPendingJob([propertyId]);
    await runSkipTraceEnrichment(supabase, {
      jobId,
      orgId: await getOrgId(),
      propertyIds: [propertyId],
    });

    // Mock UNTYPED prefix returns one Unknown-typed phone (rank 1) and
    // one Mobile (rank 2). The unlabeled number must be dropped — not
    // packed with type 'unknown', which the 080 trigger rejects and
    // would sink the whole finalize.
    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1, phone_1_type, phone_2")
      .eq("id", contactId!)
      .single();
    expect(contact!.phone_1).toBe("+18165550105");
    expect(contact!.phone_1_type).toBe("mobile");
    expect(contact!.phone_2).toBeNull();

    const { data: job } = await supabase
      .from("jobs")
      .select("status")
      .eq("id", jobId)
      .single();
    expect(job!.status).toBe("completed");
  });

  // ---------------------------------------------------------------
  // Address-matching: Tracerfy silently dedupes batch input by
  // address and doesn't reliably round-trip our `external_id`. The
  // runner builds an `address -> propertyIds[]` ledger at submit
  // time and finalize fans each result row out to every property in
  // its bucket. Without this, ~21/50 inputs in production silently
  // dropped on a real D4D import.
  // ---------------------------------------------------------------
  describe("address fan-out (multi-property + missing rows)", () => {
    it("two properties at the same address: submit dedups, both finalize from one result row", async () => {
      const a = await seedProperty({ address: "1 Shared Address Ln" });
      const b = await seedProperty({ address: "1 Shared Address Ln" });
      const ids = [a.propertyId, b.propertyId];
      const jobId = await createPendingJob(ids);

      // Async path → submitBatch → map stored on the job.
      const out = await runSkipTraceEnrichment(supabase, {
        jobId,
        orgId: await getOrgId(),
        propertyIds: ids,
      });
      expect("pending" in out).toBe(true);

      // Verify the job stored a single submission for two properties.
      const { data: jobAfterSubmit } = await supabase
        .from("jobs")
        .select("provider_run_id, result_summary")
        .eq("id", jobId)
        .single();
      const submitSummary = jobAfterSubmit!.result_summary as {
        unique_addresses_submitted?: number;
        address_to_property_ids?: Record<string, string[]>;
      } | null;
      expect(submitSummary?.unique_addresses_submitted).toBe(1);
      const buckets = Object.values(
        submitSummary?.address_to_property_ids ?? {},
      );
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toEqual(expect.arrayContaining(ids));

      // Drive the mock provider's pollBatch the way the cron sweep
      // would: pull the queue we already submitted, then finalize.
      // The mock echoes the input address as `matchedAddress`, so
      // finalize fans the row out to BOTH properties.
      const provider = new MockSkipTraceProvider();
      const results = await provider.pollBatch(
        jobAfterSubmit!.provider_run_id!,
      );
      expect(results).not.toBeNull();
      expect(results).toHaveLength(1);

      await finalizeSkipTraceFromBatch(supabase, {
        jobId,
        results: results!,
      });

      // Both properties should now have a homeowner contact populated.
      const { data: props } = await supabase
        .from("properties")
        .select("id, homeowner_contact_id")
        .in("id", ids);
      for (const p of props ?? []) {
        expect(p.homeowner_contact_id).not.toBeNull();
      }

      const { data: jobRow } = await supabase
        .from("jobs")
        .select("status, succeeded_items, failed_items")
        .eq("id", jobId)
        .single();
      expect(jobRow!.status).toBe("completed");
      // Both properties counted as succeeded — fan-out preserves the
      // count even though only one result row came back.
      expect(jobRow!.succeeded_items).toBe(2);
      expect(jobRow!.failed_items).toBe(0);

      // Per-property job_items should exist for both properties.
      const { data: items } = await supabase
        .from("job_items")
        .select("property_id, status")
        .eq("job_id", jobId);
      const itemPropertyIds = (items ?? []).map((i) => i.property_id);
      expect(itemPropertyIds).toEqual(expect.arrayContaining(ids));
    });

    it("submitted address whose row never returns: writes per-property error item", async () => {
      const a = await seedProperty({ address: "10 Returned Ln" });
      const b = await seedProperty({ address: "20 Missing Ln" });
      const ids = [a.propertyId, b.propertyId];
      const jobId = await createPendingJob(ids);

      await runSkipTraceEnrichment(supabase, {
        jobId,
        orgId: await getOrgId(),
        propertyIds: ids,
      });

      // Finalize with ONLY the result for the first address. The
      // second one is silently absent from the provider response —
      // exactly the production failure mode that masked 21 of 50
      // inputs.
      await finalizeSkipTraceFromBatch(supabase, {
        jobId,
        results: [
          {
            propertyId: "",
            matchedAddress: {
              address: "10 Returned Ln",
              city: "Kansas City",
              state: "MO",
            },
            hit: true,
            persons: [
              {
                firstName: "Returned",
                lastName: "Owner",
                phones: [
                  {
                    number: "+18165550141",
                    type: "Mobile",
                    dnc: false,
                    rank: 1,
                  },
                ],
                emails: [],
                isOwner: true,
              },
            ],
            creditsDeducted: 1,
            raw: {},
          },
        ],
      });

      // First property: success item.
      const { data: itemsA } = await supabase
        .from("job_items")
        .select("status, error_message")
        .eq("job_id", jobId)
        .eq("property_id", a.propertyId);
      expect(itemsA).toHaveLength(1);
      expect(itemsA![0].status).toBe("success");

      // Second property: error item flagging the provider gap.
      // Runnable fixture rows default to CASS-verified, so a missing
      // provider row means the vendor genuinely returned no owner data.
      const { data: itemsB } = await supabase
        .from("job_items")
        .select("status, error_class, error_message")
        .eq("job_id", jobId)
        .eq("property_id", b.propertyId);
      expect(itemsB).toHaveLength(1);
      expect(itemsB![0].status).toBe("error");
      expect(itemsB![0].error_class).toBe("provider_no_data");
      expect(itemsB![0].error_message).toMatch(/no owner data/i);

      const { data: jobRow } = await supabase
        .from("jobs")
        .select("status, failed_items, succeeded_items")
        .eq("id", jobId)
        .single();
      expect(jobRow!.failed_items).toBe(1);
      expect(jobRow!.succeeded_items).toBe(1);
      // failed > 0 and matched > 0 → partial.
      expect(jobRow!.status).toBe("partial");
    });

    it("result row whose address matches none of the submitted buckets is logged but doesn't break the batch", async () => {
      // Need at least 2 misses to take the async path so submitBatch
      // fires and the address map is recorded.
      const a = await seedProperty({ address: "42 Real Ln" });
      const b = await seedProperty({ address: "43 Real Ln" });
      const ids = [a.propertyId, b.propertyId];
      const jobIdMulti = await createPendingJob(ids);

      await runSkipTraceEnrichment(supabase, {
        jobId: jobIdMulti,
        orgId: await getOrgId(),
        propertyIds: ids,
      });

      // One real match + one wild result with an address we never sent.
      await finalizeSkipTraceFromBatch(supabase, {
        jobId: jobIdMulti,
        results: [
          {
            propertyId: "",
            matchedAddress: {
              address: "42 Real Ln",
              city: "Kansas City",
              state: "MO",
            },
            hit: true,
            persons: [
              {
                firstName: "Real",
                lastName: "Owner",
                phones: [
                  {
                    number: "+18165550161",
                    type: "Mobile",
                    dnc: false,
                    rank: 1,
                  },
                ],
                emails: [],
                isOwner: true,
              },
            ],
            creditsDeducted: 1,
            raw: {},
          },
          {
            propertyId: "",
            matchedAddress: {
              address: "999 Wrong Ln",
              city: "Kansas City",
              state: "MO",
            },
            hit: true,
            persons: [],
            creditsDeducted: 1,
            raw: {},
          },
        ],
      });

      // Job should still finalize without throwing.
      const { data: jobRow } = await supabase
        .from("jobs")
        .select("status")
        .eq("id", jobIdMulti)
        .single();
      expect(["completed", "partial"]).toContain(jobRow!.status);

      // The matched property gets a real success row.
      const { data: itemsA } = await supabase
        .from("job_items")
        .select("status")
        .eq("job_id", jobIdMulti)
        .eq("property_id", a.propertyId);
      expect(itemsA![0].status).toBe("success");
    });

    it("rejects a forged org-A result map that points at an org-B property", async () => {
      const orgAId = await getOrgId();
      const { data: orgB, error: orgError } = await supabase
        .from("organizations")
        .insert({ name: `Finalize Tenant B ${crypto.randomUUID()}` })
        .select("id")
        .single();
      if (orgError || !orgB) throw orgError ?? new Error("org B missing");

      const { data: foreignProperty, error: propertyError } = await supabase
        .from("properties")
        .insert({
          org_id: orgB.id,
          address: "99 Forged Tenant Ave",
          city: "Kansas City",
          state: "MO",
          status: "new_lead",
          cass_status: "verified",
        })
        .select("id")
        .single();
      if (propertyError || !foreignProperty) {
        throw propertyError ?? new Error("org B property missing");
      }

      const a = await seedProperty({ address: "97 Org A Submit Ave" });
      const b = await seedProperty({ address: "98 Org A Submit Ave" });
      const jobId = await createPendingJob([a.propertyId, b.propertyId]);
      await runSkipTraceEnrichment(supabase, {
        jobId,
        orgId: orgAId,
        propertyIds: [a.propertyId, b.propertyId],
      });

      const { data: job, error: jobError } = await supabase
        .from("jobs")
        .select("result_summary")
        .eq("id", jobId)
        .single();
      if (jobError || !job) throw jobError ?? new Error("job missing");
      const prior = (job.result_summary ?? {}) as Record<string, unknown>;
      const { error: forgeError } = await supabase
        .from("jobs")
        .update({
          result_summary: {
            ...prior,
            address_to_property_ids: {
              "99 forged tenant ave|kansas city|mo": [foreignProperty.id],
            },
          },
        })
        .eq("id", jobId);
      if (forgeError) throw forgeError;

      const { error: directCrossTenantError } = await supabase
        .from("job_items")
        .insert({
          job_id: jobId,
          property_id: foreignProperty.id,
          status: "pending",
        });
      expect(directCrossTenantError?.message).toMatch(
        /JOB_ITEM_PROPERTY_ORG_MISMATCH/i,
      );

      await expect(
        finalizeSkipTraceFromBatch(supabase, {
          jobId,
          results: [
            {
              propertyId: foreignProperty.id,
              matchedAddress: {
                address: "99 Forged Tenant Ave",
                city: "Kansas City",
                state: "MO",
              },
              hit: true,
              persons: [
                {
                  firstName: "Foreign",
                  lastName: "Owner",
                  phones: [
                    {
                      number: "+18165550990",
                      type: "Mobile",
                      dnc: false,
                      rank: 1,
                    },
                  ],
                  emails: [],
                  isOwner: true,
                },
              ],
              creditsDeducted: 1,
              raw: {},
            },
          ],
        }),
      ).rejects.toThrow(/outside job organization/i);

      const { data: unchanged } = await supabase
        .from("properties")
        .select("homeowner_contact_id")
        .eq("id", foreignProperty.id)
        .single();
      expect(unchanged?.homeowner_contact_id).toBeNull();
      const { count: foreignContacts } = await supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgB.id);
      expect(foreignContacts).toBe(0);
      const { count: leakedCacheRows } = await supabase
        .from("skip_trace_cache")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgAId)
        .eq("address_normalized", "99 forged tenant ave|kansas city|mo");
      expect(leakedCacheRows).toBe(0);
      const { data: returnedJob } = await supabase
        .from("jobs")
        .select("status")
        .eq("id", jobId)
        .single();
      expect(returnedJob?.status).toBe("running");
    });

    it("rejects a forged foreign property even when the provider returns no result", async () => {
      const orgAId = await getOrgId();
      const { data: orgB, error: orgError } = await supabase
        .from("organizations")
        .insert({ name: `Missing Result Tenant B ${crypto.randomUUID()}` })
        .select("id")
        .single();
      if (orgError || !orgB) throw orgError ?? new Error("org B missing");

      const { data: foreignProperty, error: propertyError } = await supabase
        .from("properties")
        .insert({
          org_id: orgB.id,
          address: "100 Missing Foreign Result Ave",
          city: "Kansas City",
          state: "MO",
          status: "new_lead",
          cass_status: "verified",
        })
        .select("id")
        .single();
      if (propertyError || !foreignProperty) {
        throw propertyError ?? new Error("org B property missing");
      }

      const a = await seedProperty({ address: "101 Org A Missing Submit Ave" });
      const b = await seedProperty({ address: "102 Org A Missing Submit Ave" });
      const jobId = await createPendingJob([a.propertyId, b.propertyId]);
      await runSkipTraceEnrichment(supabase, {
        jobId,
        orgId: orgAId,
        propertyIds: [a.propertyId, b.propertyId],
      });

      const { data: job, error: jobError } = await supabase
        .from("jobs")
        .select("result_summary")
        .eq("id", jobId)
        .single();
      if (jobError || !job) throw jobError ?? new Error("job missing");
      const prior = (job.result_summary ?? {}) as Record<string, unknown>;
      const { error: forgeError } = await supabase
        .from("jobs")
        .update({
          result_summary: {
            ...prior,
            address_to_property_ids: {
              "100 missing foreign result ave|kansas city|mo": [
                foreignProperty.id,
              ],
            },
          },
        })
        .eq("id", jobId);
      if (forgeError) throw forgeError;

      await expect(
        finalizeSkipTraceFromBatch(supabase, {
          jobId,
          results: [],
        }),
      ).rejects.toThrow(/outside job organization/i);

      const { count: foreignItems } = await supabase
        .from("job_items")
        .select("id", { count: "exact", head: true })
        .eq("job_id", jobId)
        .eq("property_id", foreignProperty.id);
      expect(foreignItems).toBe(0);
      const { data: unchanged } = await supabase
        .from("properties")
        .select("homeowner_contact_id")
        .eq("id", foreignProperty.id)
        .single();
      expect(unchanged?.homeowner_contact_id).toBeNull();
      const { count: foreignContacts } = await supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgB.id);
      expect(foreignContacts).toBe(0);
      const { count: leakedCacheRows } = await supabase
        .from("skip_trace_cache")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgAId)
        .eq(
          "address_normalized",
          "100 missing foreign result ave|kansas city|mo",
        );
      expect(leakedCacheRows).toBe(0);
      const { data: returnedJob } = await supabase
        .from("jobs")
        .select("status")
        .eq("id", jobId)
        .single();
      expect(returnedJob?.status).toBe("running");
    });
  });

  // ---------------------------------------------------------------
  // Error classification: every error item gets a categorized
  // error_class so the UI + retry logic can distinguish terminal
  // (provider_no_data, address_unverified) from retryable
  // (provider_transient). Ambiguous provider outcomes are terminal
  // submission_unknown rows requiring manual reconciliation. Caching branches
  // on this — verified-no-data caches a negative; unverified does not.
  // ---------------------------------------------------------------
  describe("error_class categorization on missing-from-batch rows", () => {
    async function setCassStatus(
      propertyId: string,
      status: "verified" | "unverified",
    ): Promise<void> {
      const { error } = await supabase
        .from("properties")
        .update({ cass_status: status })
        .eq("id", propertyId);
      if (error) throw error;
    }

    it("CASS-verified property + no provider row → error_class='provider_no_data' AND cache row written", async () => {
      const a = await seedProperty({ address: "1 Returned Verified Ln" });
      const b = await seedProperty({ address: "2 No-Data Verified Ln" });
      await setCassStatus(b.propertyId, "verified");
      const ids = [a.propertyId, b.propertyId];
      const jobId = await createPendingJob(ids);

      await runSkipTraceEnrichment(supabase, {
        jobId,
        orgId: await getOrgId(),
        propertyIds: ids,
      });

      // Finalize with only the FIRST row; the verified b is silently absent.
      await finalizeSkipTraceFromBatch(supabase, {
        jobId,
        results: [
          {
            propertyId: "",
            matchedAddress: {
              address: "1 Returned Verified Ln",
              city: "Kansas City",
              state: "MO",
            },
            hit: true,
            persons: [
              {
                firstName: "Returned",
                lastName: "Owner",
                phones: [
                  {
                    number: "+18165550181",
                    type: "Mobile",
                    dnc: false,
                    rank: 1,
                  },
                ],
                emails: [],
                isOwner: true,
              },
            ],
            creditsDeducted: 1,
            raw: {},
          },
        ],
      });

      const { data: itemB } = await supabase
        .from("job_items")
        .select("status, error_class, error_message")
        .eq("job_id", jobId)
        .eq("property_id", b.propertyId)
        .single();
      expect(itemB!.status).toBe("error");
      expect(itemB!.error_class).toBe("provider_no_data");
      expect(itemB!.error_message).toMatch(/no owner data/i);

      // Cache row should exist for the verified address so subsequent
      // runs hit cache and don't re-pay the vendor. normalizeAddress
      // lowercases, so the assertion matches the lower form.
      const { data: cacheRows } = await supabase
        .from("skip_trace_cache")
        .select("address_normalized, match_count")
        .eq("provider", "mock");
      const cacheAddrs = (cacheRows ?? []).map((r) => r.address_normalized);
      expect(cacheAddrs.some((a) => a.includes("2 no-data verified"))).toBe(
        true,
      );
    });

    it("CASS-unverified property + no provider row → error_class='address_unverified' AND no cache row", async () => {
      const a = await seedProperty({ address: "10 Returned Unverified Ln" });
      const b = await seedProperty({
        address: "20 No-Data Unverified Ln",
        cassStatus: "unverified",
      });
      // The runner blocks unverified rows before provider spend.
      const ids = [a.propertyId, b.propertyId];
      const jobId = await createPendingJob(ids);

      await runSkipTraceEnrichment(supabase, {
        jobId,
        orgId: await getOrgId(),
        propertyIds: ids,
      });

      await finalizeSkipTraceFromBatch(supabase, {
        jobId,
        results: [
          {
            propertyId: "",
            matchedAddress: {
              address: "10 Returned Unverified Ln",
              city: "Kansas City",
              state: "MO",
            },
            hit: true,
            persons: [
              {
                firstName: "Real",
                lastName: "Owner",
                phones: [
                  {
                    number: "+18165550182",
                    type: "Mobile",
                    dnc: false,
                    rank: 1,
                  },
                ],
                emails: [],
                isOwner: true,
              },
            ],
            creditsDeducted: 1,
            raw: {},
          },
        ],
      });

      const { data: itemB } = await supabase
        .from("job_items")
        .select("status, error_class, error_message")
        .eq("job_id", jobId)
        .eq("property_id", b.propertyId)
        .single();
      expect(itemB!.status).toBe("error");
      expect(itemB!.error_class).toBe("address_unverified");
      expect(itemB!.error_message).toMatch(/CASS|verify/i);

      // No cache row for the unverified address — its normalized key
      // will change once CASS runs, so caching the negative would go
      // stale.
      const { data: cacheRows } = await supabase
        .from("skip_trace_cache")
        .select("address_normalized")
        .eq("provider", "mock");
      const cacheAddrs = (cacheRows ?? []).map((r) => r.address_normalized);
      expect(cacheAddrs.some((a) => a.includes("20 no-data unverified"))).toBe(
        false,
      );
    });

    it("regression: successful match still writes status=success and no error_class", async () => {
      const { propertyId } = await seedProperty({ address: "1 Happy Path Ln" });
      const jobId = await createPendingJob([propertyId]);

      await runSkipTraceEnrichment(supabase, {
        jobId,
        orgId: await getOrgId(),
        propertyIds: [propertyId],
      });

      const { data: items } = await supabase
        .from("job_items")
        .select("status, error_class")
        .eq("job_id", jobId);
      expect(items).toHaveLength(1);
      expect(items![0].status).toBe("success");
      expect(items![0].error_class).toBeNull();
    });
  });
});
