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

  it("second finalize loses the claim: returns null, writes no duplicate items", async () => {
    // 2026-06-12: the sweep cron fires every minute while a 4K-row
    // finalize takes several — overlapping finalizers quadruple-wrote
    // job_items. The running→finalizing claim makes finalize re-entrant.
    const { propertyId } = await seedProperty({ address: "55 Claim Ln" });
    const jobId = await createPendingJob([propertyId]);
    await runSkipTraceEnrichment(supabase, {
      jobId,
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
    ]);
    const ids = props.map((p) => p.propertyId);
    const jobId = await createPendingJob(ids);
    await runSkipTraceEnrichment(supabase, { jobId, propertyIds: ids });

    // Simulate the dead pass: one property already has a success item.
    await supabase.from("job_items").insert({
      job_id: jobId,
      property_id: ids[0],
      status: "success",
      output_payload: { phones_added: 1 },
    });
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

    // Exactly one item per property — the pre-existing one untouched.
    const { data: items } = await supabase
      .from("job_items")
      .select("property_id, status")
      .eq("job_id", jobId);
    expect(items).toHaveLength(2);
    expect(new Set(items!.map((i) => i.property_id)).size).toBe(2);

    // Counters reconciled from the ledger: both rows count as matched.
    const { data: job } = await supabase
      .from("jobs")
      .select("status, succeeded_items, failed_items")
      .eq("id", jobId)
      .single();
    expect(job!.status).toBe("completed");
    expect(job!.succeeded_items).toBe(2);
    expect(job!.failed_items).toBe(0);
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

  it("normalizes provider-returned phones to E.164 before persisting", async () => {
    // RAW prefix → mock returns bare "8167416576" (Tracerfy's actual shape)
    const { propertyId } = await seedProperty({ address: "RAW phone test" });
    const jobId = await createPendingJob([propertyId]);

    await runSkipTraceEnrichment(supabase, {
      jobId,
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
      const buckets = Object.values(submitSummary?.address_to_property_ids ?? {});
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toEqual(expect.arrayContaining(ids));

      // Drive the mock provider's pollBatch the way the cron sweep
      // would: pull the queue we already submitted, then finalize.
      // The mock echoes the input address as `matchedAddress`, so
      // finalize fans the row out to BOTH properties.
      const provider = new MockSkipTraceProvider();
      const results = await provider.pollBatch(jobAfterSubmit!.provider_run_id!);
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
                  { number: "+18165550141", type: "Mobile", dnc: false, rank: 1 },
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
      // Default seedProperty leaves cass_status null → classifier
      // treats the missing-row case as `address_unverified` (we can't
      // confirm "no data" without a clean address). Tests below
      // cover the cass_status='verified' branch where it becomes
      // `provider_no_data`.
      const { data: itemsB } = await supabase
        .from("job_items")
        .select("status, error_class, error_message")
        .eq("job_id", jobId)
        .eq("property_id", b.propertyId);
      expect(itemsB).toHaveLength(1);
      expect(itemsB![0].status).toBe("error");
      expect(itemsB![0].error_class).toBe("address_unverified");
      expect(itemsB![0].error_message).toMatch(/CASS|verify/i);

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
                  { number: "+18165550161", type: "Mobile", dnc: false, rank: 1 },
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
  });

  // ---------------------------------------------------------------
  // Error classification: every error item gets a categorized
  // error_class so the UI + retry logic can distinguish terminal
  // (provider_no_data, address_unverified) from retryable
  // (provider_transient, provider_unknown). Caching also branches
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

      await runSkipTraceEnrichment(supabase, { jobId, propertyIds: ids });

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
                  { number: "+18165550181", type: "Mobile", dnc: false, rank: 1 },
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
      const b = await seedProperty({ address: "20 No-Data Unverified Ln" });
      // b's cass_status remains null → treated as unverified.
      const ids = [a.propertyId, b.propertyId];
      const jobId = await createPendingJob(ids);

      await runSkipTraceEnrichment(supabase, { jobId, propertyIds: ids });

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
                  { number: "+18165550182", type: "Mobile", dnc: false, rank: 1 },
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
      expect(
        cacheAddrs.some((a) => a.includes("20 no-data unverified")),
      ).toBe(false);
    });

    it("regression: successful match still writes status=success and no error_class", async () => {
      const { propertyId } = await seedProperty({ address: "1 Happy Path Ln" });
      const jobId = await createPendingJob([propertyId]);

      await runSkipTraceEnrichment(supabase, {
        jobId,
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
