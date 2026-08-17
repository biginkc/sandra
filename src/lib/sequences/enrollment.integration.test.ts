import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

import {
  enrollLead,
  pausePropertyEnrollments,
  resumeEnrollment,
} from "./enrollment";

const supabase = createTestClient();

async function getOrgId(): Promise<string> {
  return getCanonicalTestOrgId(supabase);
}

async function seedSequence(opts: {
  name: string;
  steps: { delay: number; body: string }[];
  active?: boolean;
  archived?: boolean;
  appendOptOut?: boolean;
}): Promise<string> {
  const orgId = await getOrgId();
  const { data: seq } = await supabase
    .from("sequences")
    .insert({
      org_id: orgId,
      name: opts.name,
      active: opts.active ?? true,
      archived_at: opts.archived ? new Date().toISOString() : null,
      append_opt_out: opts.appendOptOut ?? true,
    })
    .select("id")
    .single();
  if (!seq) throw new Error("seed sequence failed");

  for (let i = 0; i < opts.steps.length; i++) {
    await supabase.from("sequence_steps").insert({
      sequence_id: seq.id,
      step_index: i,
      delay_after_previous_minutes: opts.steps[i].delay,
      action_type: "send_sms",
      template_body: opts.steps[i].body,
    });
  }
  return seq.id;
}

async function seedPropertyWithConsent(opts: {
  phone?: string | null;
  optIn?: boolean;
  address?: string;
  state?: string;
}): Promise<{ propertyId: string; contactId: string | null }> {
  let contactId: string | null = null;
  if (opts.phone) {
    const { data: contact } = await supabase
      .from("contacts")
      .insert({
        first_name: "Enrollee",
        last_name: "Test",
        phone_1: opts.phone,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    if (!contact) throw new Error("contact seed failed");
    contactId = contact.id;

    if (opts.optIn !== false) {
      await supabase.from("consent_events").insert({
        contact_id: contactId,
        channel: "sms",
        event_type: "opt_in_marketing_written",
        source: "test-seed",
      });
    } else {
      await supabase.from("consent_events").insert({
        contact_id: contactId,
        channel: "sms",
        event_type: "opt_out",
        source: "test-seed",
      });
    }
  }

  const { data: property } = await supabase
    .from("properties")
    .insert({
      address: opts.address ?? "123 Enroll Ln",
      state: opts.state ?? "MO",
      status: "new_lead",
      homeowner_contact_id: contactId,
    })
    .select("id")
    .single();
  if (!property) throw new Error("property seed failed");
  return { propertyId: property.id, contactId };
}

describe("enrollLead (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("enrolls a lead: creates a row with current_step=0 and next_run_at ~= now", async () => {
    const seqId = await seedSequence({
      name: "Happy-path",
      steps: [{ delay: 0, body: "Hi {{first_name}}" }],
    });
    const { propertyId } = await seedPropertyWithConsent({
      phone: "+18165550001",
    });

    const outcome = await enrollLead(supabase, {
      sequenceId: seqId,
      propertyId,
    });
    expect(outcome.status).toBe("enrolled");

    const { data: row } = await supabase
      .from("sequence_enrollments")
      .select("status, current_step_index, next_run_at")
      .eq("sequence_id", seqId)
      .eq("property_id", propertyId)
      .single();
    expect(row).toMatchObject({ status: "active", current_step_index: 0 });
    // next_run_at should be within a few seconds of now for delay=0.
    const diffMs = Math.abs(
      new Date(row!.next_run_at!).getTime() - Date.now(),
    );
    expect(diffMs).toBeLessThan(5000);
  });

  it("rejects a lead with no homeowner contact / phone", async () => {
    const seqId = await seedSequence({
      name: "NoPhone",
      steps: [{ delay: 0, body: "x" }],
    });
    const { propertyId } = await seedPropertyWithConsent({}); // no phone

    const outcome = await enrollLead(supabase, {
      sequenceId: seqId,
      propertyId,
    });
    expect(outcome.status).toBe("no_phone");
  });

  it("rejects a lead whose contact is opted out", async () => {
    const seqId = await seedSequence({
      name: "OptedOut",
      steps: [{ delay: 0, body: "x" }],
    });
    const { propertyId } = await seedPropertyWithConsent({
      phone: "+18165550002",
      optIn: false,
    });

    const outcome = await enrollLead(supabase, {
      sequenceId: seqId,
      propertyId,
    });
    expect(outcome.status).toBe("no_consent");
  });

  it("prevents a second active enrollment on the same (sequence, property) pair", async () => {
    const seqId = await seedSequence({
      name: "Duplicate",
      steps: [{ delay: 0, body: "x" }],
    });
    const { propertyId } = await seedPropertyWithConsent({
      phone: "+18165550003",
    });

    const first = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    expect(first.status).toBe("enrolled");

    const second = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    expect(second.status).toBe("duplicate_active");
  });

  it("rejects enrollment on an archived sequence", async () => {
    const seqId = await seedSequence({
      name: "Archived",
      steps: [{ delay: 0, body: "x" }],
      archived: true,
    });
    const { propertyId } = await seedPropertyWithConsent({
      phone: "+18165550004",
    });

    const outcome = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    expect(outcome.status).toBe("sequence_inactive");
  });

  it("rejects enrollment on a sequence with zero steps", async () => {
    const orgId = await getOrgId();
    const { data: seq } = await supabase
      .from("sequences")
      .insert({ org_id: orgId, name: "NoSteps" })
      .select("id")
      .single();
    const { propertyId } = await seedPropertyWithConsent({
      phone: "+18165550005",
    });

    const outcome = await enrollLead(supabase, {
      sequenceId: seq!.id,
      propertyId,
    });
    expect(outcome.status).toBe("no_steps");
  });

  it("unique-active partial index allows re-enrollment after the first completes", async () => {
    const seqId = await seedSequence({
      name: "ReEnroll",
      steps: [{ delay: 0, body: "x" }],
    });
    const { propertyId } = await seedPropertyWithConsent({
      phone: "+18165550006",
    });

    const first = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    expect(first.status).toBe("enrolled");
    // Mark first as completed to free the unique slot.
    await supabase
      .from("sequence_enrollments")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", (first as { enrollmentId: string }).enrollmentId);

    const second = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    expect(second.status).toBe("enrolled");
  });
});

describe("pausePropertyEnrollments (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("pauses all active enrollments on a property with the given reason", async () => {
    const seqA = await seedSequence({
      name: "SeqA",
      steps: [{ delay: 0, body: "a" }],
    });
    const seqB = await seedSequence({
      name: "SeqB",
      steps: [{ delay: 0, body: "b" }],
    });
    const { propertyId } = await seedPropertyWithConsent({
      phone: "+18165550020",
    });
    await enrollLead(supabase, { sequenceId: seqA, propertyId });
    await enrollLead(supabase, { sequenceId: seqB, propertyId });

    const outcome = await pausePropertyEnrollments(supabase, {
      propertyId,
      reason: "inbound_reply",
    });
    expect(outcome.paused).toBe(2);

    const { data } = await supabase
      .from("sequence_enrollments")
      .select("status, pause_reason")
      .eq("property_id", propertyId);
    for (const row of data ?? []) {
      expect(row.status).toBe("paused");
      expect(row.pause_reason).toBe("inbound_reply");
    }
  });

  it("flips to opted_out permanently when permanent=true", async () => {
    const seqId = await seedSequence({
      name: "PermPause",
      steps: [{ delay: 0, body: "x" }],
    });
    const { propertyId } = await seedPropertyWithConsent({
      phone: "+18165550021",
    });
    await enrollLead(supabase, { sequenceId: seqId, propertyId });

    await pausePropertyEnrollments(supabase, {
      propertyId,
      reason: "consent_revoked",
      permanent: true,
    });

    const { data } = await supabase
      .from("sequence_enrollments")
      .select("status, pause_reason, next_run_at")
      .eq("property_id", propertyId)
      .single();
    expect(data!.status).toBe("opted_out");
    expect(data!.pause_reason).toBe("consent_revoked");
    expect(data!.next_run_at).toBeNull();
  });
});

describe("resumeEnrollment (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("flips paused back to active and recalculates next_run_at", async () => {
    const seqId = await seedSequence({
      name: "Resume",
      steps: [{ delay: 0, body: "a" }, { delay: 1440, body: "b" }],
    });
    const { propertyId } = await seedPropertyWithConsent({
      phone: "+18165550030",
    });
    const enrolled = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    if (enrolled.status !== "enrolled") throw new Error("enroll failed");

    await pausePropertyEnrollments(supabase, {
      propertyId,
      reason: "inbound_reply",
    });

    const resumed = await resumeEnrollment(supabase, enrolled.enrollmentId);
    expect(resumed.status).toBe("resumed");

    const { data } = await supabase
      .from("sequence_enrollments")
      .select("status, pause_reason, next_run_at")
      .eq("id", enrolled.enrollmentId)
      .single();
    expect(data!.status).toBe("active");
    expect(data!.pause_reason).toBeNull();
    expect(data!.next_run_at).not.toBeNull();
  });

  it("does nothing for an enrollment that isn't paused", async () => {
    const seqId = await seedSequence({
      name: "NoOp",
      steps: [{ delay: 0, body: "x" }],
    });
    const { propertyId } = await seedPropertyWithConsent({
      phone: "+18165550031",
    });
    const enrolled = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    if (enrolled.status !== "enrolled") throw new Error("enroll failed");

    const outcome = await resumeEnrollment(supabase, enrolled.enrollmentId);
    expect(outcome.status).toBe("not_paused");
  });
});
