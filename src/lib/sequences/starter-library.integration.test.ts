import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { enrollLead } from "./enrollment";
import { getSequenceImpact } from "./impact";
import { seedStarterLibrary, STARTER_SEQUENCES } from "./starter-library";

const supabase = createTestClient();

async function getOrgId(): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error("no org");
  return data.id;
}

describe("seedStarterLibrary (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("seeds the 4 starter sequences for a clean org", async () => {
    const orgId = await getOrgId();
    const { created, skipped } = await seedStarterLibrary(supabase, orgId);
    expect(created).toBe(STARTER_SEQUENCES.length);
    expect(skipped).toBe(0);

    const { data } = await supabase
      .from("sequences")
      .select("name")
      .eq("org_id", orgId)
      .order("name");
    const names = (data ?? []).map((s) => s.name).sort();
    expect(names).toEqual(
      [
        "Dead lead requalify",
        "First touch new lead",
        "Nurture cold lead",
        "Nurture not-interested",
      ].sort(),
    );
  });

  it("is idempotent — a second call skips existing names", async () => {
    const orgId = await getOrgId();
    await seedStarterLibrary(supabase, orgId);
    const second = await seedStarterLibrary(supabase, orgId);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(STARTER_SEQUENCES.length);
  });

  it("seeds the expected number of steps per starter sequence", async () => {
    const orgId = await getOrgId();
    await seedStarterLibrary(supabase, orgId);

    for (const starter of STARTER_SEQUENCES) {
      const { data: seq } = await supabase
        .from("sequences")
        .select("id")
        .eq("org_id", orgId)
        .ilike("name", starter.name)
        .single();
      const { count } = await supabase
        .from("sequence_steps")
        .select("*", { count: "exact", head: true })
        .eq("sequence_id", seq!.id);
      expect(count).toBe(starter.steps.length);
    }
  });
});

describe("getSequenceImpact (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("reports total_enrolled and scheduled_next_7d correctly", async () => {
    const orgId = await getOrgId();
    const { data: seq } = await supabase
      .from("sequences")
      .insert({ org_id: orgId, name: "Impact" })
      .select("id")
      .single();
    await supabase.from("sequence_steps").insert({
      sequence_id: seq!.id,
      step_index: 0,
      delay_after_previous_minutes: 0,
      action_type: "send_sms",
      template_body: "hi",
    });

    // Seed 3 leads, enroll all; then pause one. Expect 3 enrolled, 2 scheduled-7d.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { data: contact } = await supabase
        .from("contacts")
        .insert({
          phone_1: `+1816555${String(2000 + i).padStart(4, "0")}`,
          phone_1_type: "mobile",
        })
        .select("id")
        .single();
      await supabase.from("consent_events").insert({
        contact_id: contact!.id,
        channel: "sms",
        event_type: "opt_in_marketing_written",
        source: "seed",
      });
      const { data: prop } = await supabase
        .from("properties")
        .insert({
          address: `${i} Impact St`,
          state: "MO",
          status: "new_lead",
          homeowner_contact_id: contact!.id,
        })
        .select("id")
        .single();
      ids.push(prop!.id);
      const res = await enrollLead(supabase, {
        sequenceId: seq!.id,
        propertyId: prop!.id,
      });
      if (res.status !== "enrolled") throw new Error(`enroll failed: ${res.status}`);
    }

    // Pause the last one — drops scheduled_next_7d but still counts toward
    // total_enrolled (paused can be resumed).
    await supabase
      .from("sequence_enrollments")
      .update({ status: "paused", pause_reason: "inbound_reply" })
      .eq("property_id", ids[2]);

    const impact = await getSequenceImpact(supabase, seq!.id);
    expect(impact.total_enrolled).toBe(3);
    expect(impact.scheduled_next_7d).toBe(2);
  });

  it("returns zeros when the sequence has no enrollments", async () => {
    const orgId = await getOrgId();
    const { data: seq } = await supabase
      .from("sequences")
      .insert({ org_id: orgId, name: "Empty" })
      .select("id")
      .single();
    const impact = await getSequenceImpact(supabase, seq!.id);
    expect(impact).toEqual({ total_enrolled: 0, scheduled_next_7d: 0 });
  });
});
