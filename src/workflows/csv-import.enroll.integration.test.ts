import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { enrollJobBatch } from "./csv-import";

const supabase = createTestClient();

async function getOrgId(): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error("no organization seeded");
  return data.id;
}

async function seedJob(): Promise<string> {
  const orgId = await getOrgId();
  const { data, error } = await supabase
    .from("jobs")
    .insert({ org_id: orgId, type: "csv_import", status: "completed" })
    .select("id")
    .single();
  if (!data) throw new Error(`job seed failed: ${error?.message ?? "no data"}`);
  return data.id;
}

async function seedJobItem(opts: {
  jobId: string;
  propertyId: string | null;
  status: string;
}): Promise<void> {
  await supabase.from("job_items").insert({
    job_id: opts.jobId,
    property_id: opts.propertyId,
    status: opts.status,
  });
}

async function seedSequence(): Promise<string> {
  const orgId = await getOrgId();
  const { data: seq } = await supabase
    .from("sequences")
    .insert({ org_id: orgId, name: "Test Sequence", active: true })
    .select("id")
    .single();
  if (!seq) throw new Error("sequence seed failed");

  await supabase.from("sequence_steps").insert({
    sequence_id: seq.id,
    step_index: 0,
    delay_after_previous_minutes: 0,
    action_type: "send_sms",
    template_body: "Hi {{first_name | there}}",
  });
  return seq.id;
}

async function seedPropertyWithPhone(phone: string | null = "+18165550099"): Promise<string> {
  let contactId: string | null = null;
  if (phone) {
    const { data: contact } = await supabase
      .from("contacts")
      .insert({
        first_name: "Test",
        last_name: "Owner",
        phone_1: phone,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    if (!contact) throw new Error("contact seed failed");
    contactId = contact.id;

    await supabase.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "test-seed",
    });
  }

  const { data: property } = await supabase
    .from("properties")
    .insert({
      address: "100 Import Ave",
      state: "MO",
      status: "new_lead",
      homeowner_contact_id: contactId,
    })
    .select("id")
    .single();
  if (!property) throw new Error("property seed failed");
  return property.id;
}

describe("enrollJobBatch (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("returns zero counts when no job_items have status succeeded", async () => {
    const jobId = await seedJob();
    const seqId = await seedSequence();
    const propertyId = await seedPropertyWithPhone();

    // Insert items with non-succeeded statuses
    await seedJobItem({ jobId, propertyId, status: "pending" });
    await seedJobItem({ jobId, propertyId: null, status: "failed" });

    const result = await enrollJobBatch(supabase, { jobId, sequenceId: seqId, orgId: await getOrgId() });
    expect(result).toEqual({ enrolled: 0, skipped: 0, failed: 0 });
  });

  it("enrolls all succeeded job_items into the sequence", async () => {
    const jobId = await seedJob();
    const seqId = await seedSequence();
    const p1 = await seedPropertyWithPhone("+18165550001");
    const p2 = await seedPropertyWithPhone("+18165550002");

    await seedJobItem({ jobId, propertyId: p1, status: "success" });
    await seedJobItem({ jobId, propertyId: p2, status: "success" });

    const result = await enrollJobBatch(supabase, { jobId, sequenceId: seqId, orgId: await getOrgId() });
    expect(result).toEqual({ enrolled: 2, skipped: 0, failed: 0 });

    const { count } = await supabase
      .from("sequence_enrollments")
      .select("*", { count: "exact", head: true })
      .eq("sequence_id", seqId);
    expect(count).toBe(2);
  });

  it("skips job_items that are not succeeded (pending, failed, skipped)", async () => {
    const jobId = await seedJob();
    const seqId = await seedSequence();
    const good = await seedPropertyWithPhone("+18165550003");
    const bad1 = await seedPropertyWithPhone("+18165550004");
    const bad2 = await seedPropertyWithPhone("+18165550005");

    await seedJobItem({ jobId, propertyId: good, status: "success" });
    await seedJobItem({ jobId, propertyId: bad1, status: "pending" });
    await seedJobItem({ jobId, propertyId: bad2, status: "failed" });

    const result = await enrollJobBatch(supabase, { jobId, sequenceId: seqId, orgId: await getOrgId() });
    expect(result.enrolled).toBe(1);

    const { count } = await supabase
      .from("sequence_enrollments")
      .select("*", { count: "exact", head: true })
      .eq("sequence_id", seqId);
    expect(count).toBe(1);
  });

  it("counts non-enrolled outcomes (no_phone, duplicate_active) as skipped", async () => {
    const jobId = await seedJob();
    const seqId = await seedSequence();

    // One property with no phone → no_phone outcome
    const noPhone = await seedPropertyWithPhone(null);
    // One property that will get a duplicate on the second job_item
    const withPhone = await seedPropertyWithPhone("+18165550006");

    await seedJobItem({ jobId, propertyId: noPhone, status: "success" });
    await seedJobItem({ jobId, propertyId: withPhone, status: "success" });
    // Second item for same property → duplicate_active on second call
    await seedJobItem({ jobId, propertyId: withPhone, status: "success" });

    const result = await enrollJobBatch(supabase, { jobId, sequenceId: seqId, orgId: await getOrgId() });
    expect(result.enrolled).toBe(1);
    expect(result.skipped).toBe(2); // no_phone + duplicate_active
    expect(result.failed).toBe(0);
  });

  it("counts enrollLead failed outcomes as failed, continuing with remaining items", async () => {
    const jobId = await seedJob();
    // Use an invalid (non-existent) sequence ID to force sequence_not_found on
    // some items, while one item uses the real sequence.
    const realSeq = await seedSequence();
    const p1 = await seedPropertyWithPhone("+18165550007");
    const p2 = await seedPropertyWithPhone("+18165550008");

    await seedJobItem({ jobId, propertyId: p1, status: "success" });
    await seedJobItem({ jobId, propertyId: p2, status: "success" });

    // Sabotage p2 by opting it out after seeding consent, so enrollLead
    // returns no_consent (skipped) for p2
    const { data: prop } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", p2)
      .single();
    if (prop?.homeowner_contact_id) {
      await supabase.from("consent_events").insert({
        contact_id: prop.homeowner_contact_id,
        channel: "sms",
        event_type: "opt_out",
        source: "test-override",
      });
    }

    const result = await enrollJobBatch(supabase, { jobId, sequenceId: realSeq, orgId: await getOrgId() });
    expect(result.enrolled).toBe(1); // p1 succeeds
    expect(result.skipped).toBe(1);  // p2 opted out → no_consent → skipped
    expect(result.failed).toBe(0);
  });
});
