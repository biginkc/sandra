import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { MockSkipTraceProvider } from "./providers/mock";
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
    .limit(1)
    .single();
  return data!.id;
}

async function seedProperty(opts: {
  address: string;
  city?: string;
  state?: string;
  withContact?: boolean;
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
      address: opts.address,
      city: opts.city ?? "Kansas City",
      state: opts.state ?? "MO",
      status: "new_lead",
      homeowner_contact_id: contactId,
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
      status: "pending_approval",
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
  });

  it("sync path: 1 property, hit → contact created + populated, job completes", async () => {
    const { propertyId } = await seedProperty({ address: "1 Default Ln" });
    const jobId = await createPendingJob([propertyId]);

    const result = await runSkipTraceEnrichment(supabase, {
      jobId,
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

  it("finalizeSkipTraceFromBatch persists results + completes the job", async () => {
    const props = await Promise.all([
      seedProperty({ address: "100 Batch Ln" }),
      seedProperty({ address: "200 Batch Ln" }),
    ]);
    const ids = props.map((p) => p.propertyId);
    const jobId = await createPendingJob(ids);

    // Kick off the async path.
    await runSkipTraceEnrichment(supabase, { jobId, propertyIds: ids });

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

  it("cache hit on second run: no provider call, contact unchanged", async () => {
    const { propertyId } = await seedProperty({ address: "Cache Test Ln" });

    // First run: populates the cache.
    const job1 = await createPendingJob([propertyId]);
    await runSkipTraceEnrichment(supabase, {
      jobId: job1,
      propertyIds: [propertyId],
    });

    // Second run on the same property → cache hit.
    const job2 = await createPendingJob([propertyId]);
    await runSkipTraceEnrichment(supabase, {
      jobId: job2,
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

  it("dedupes phones: re-running on a contact whose phone_1 already matches doesn't fill phone_2", async () => {
    const { propertyId, contactId } = await seedProperty({
      address: "Dedupe Test Ln",
      withContact: true,
    });
    // Pre-populate phone_1 with the same number the mock will return.
    await supabase
      .from("contacts")
      .update({ phone_1: "+18165550199" })
      .eq("id", contactId!);

    const jobId = await createPendingJob([propertyId]);
    await runSkipTraceEnrichment(supabase, {
      jobId,
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
});
