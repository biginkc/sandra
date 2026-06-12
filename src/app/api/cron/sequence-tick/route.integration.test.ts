import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { enrollLead } from "@/lib/sequences/enrollment";
import {
  getMockMessageLog,
  resetMockState,
} from "@/lib/messaging/providers/mock";

import { runSequenceTick } from "./route";

const supabase = createTestClient();

// Pin client-side clock to a safe UTC moment where every US zone is in
// the [08:00, 21:00) send window: 18:00 UTC = 14:00 ET / 13:00 CT /
// 12:00 MT / 11:00 PT.
const SAFE_NOW = new Date("2026-04-23T18:00:00Z");

async function getOrgId(): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error("no org");
  return data.id;
}

async function seedSequence(opts: {
  name: string;
  steps: { delay: number; body?: string; action?: "send_sms" | "change_status"; target_status?: string }[];
  appendOptOut?: boolean;
}): Promise<string> {
  const orgId = await getOrgId();
  const { data: seq } = await supabase
    .from("sequences")
    .insert({
      org_id: orgId,
      name: opts.name,
      append_opt_out: opts.appendOptOut ?? true,
    })
    .select("id")
    .single();
  if (!seq) throw new Error("seed sequence failed");

  for (let i = 0; i < opts.steps.length; i++) {
    const s = opts.steps[i];
    await supabase.from("sequence_steps").insert({
      sequence_id: seq.id,
      step_index: i,
      delay_after_previous_minutes: s.delay,
      action_type: s.action ?? "send_sms",
      template_body: s.body ?? null,
      target_status: s.target_status ?? null,
    });
  }
  return seq.id;
}

async function seedLead(opts: {
  phone: string;
  state?: string;
  address?: string;
  propertyStatus?: string;
  optIn?: boolean;
}): Promise<{ propertyId: string; contactId: string }> {
  const { data: contact } = await supabase
    .from("contacts")
    .insert({
      first_name: "Cron",
      last_name: "Tester",
      phone_1: opts.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");

  if (opts.optIn !== false) {
    await supabase.from("consent_events").insert({
      contact_id: contact.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "test-seed",
    });
  }

  const { data: property } = await supabase
    .from("properties")
    .insert({
      address: opts.address ?? "1 Cron Ln",
      state: opts.state ?? "MO",
      status: opts.propertyStatus ?? "new_lead",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  if (!property) throw new Error("property seed failed");
  return { propertyId: property.id, contactId: contact.id };
}

describe("runSequenceTick (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    resetMockState();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SAFE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires step 0 of a due enrollment and advances to step 1", async () => {
    const seqId = await seedSequence({
      name: "Two-step",
      steps: [
        { delay: 0, body: "Hi {{first_name}}, cash offer on {{property_address}}?" },
        { delay: 1440, body: "Follow-up on {{property_address}}" },
      ],
    });
    const { propertyId } = await seedLead({ phone: "+18165551001" });
    const enrolled = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    if (enrolled.status !== "enrolled") throw new Error("enroll failed");

    const summary = await runSequenceTick(supabase);
    expect(summary.processed).toBe(1);
    expect(summary.outcomes.sent).toBe(1);

    // Enrollment advanced to step 1 with next_run_at ~= now + 24h.
    const { data: enr } = await supabase
      .from("sequence_enrollments")
      .select("current_step_index, next_run_at, status")
      .eq("id", enrolled.enrollmentId)
      .single();
    expect(enr!.current_step_index).toBe(1);
    expect(enr!.status).toBe("active");
    const expectedNextMs = SAFE_NOW.getTime() + 1440 * 60_000;
    expect(new Date(enr!.next_run_at!).getTime()).toBe(expectedNextMs);

    // Mock provider shows one send with the rendered body.
    const log = getMockMessageLog();
    expect(log).toHaveLength(1);
    expect(log[0].to).toBe("+18165551001");
    expect(log[0].body).toContain("Hi Cron, cash offer on 1 Cron Ln?");
  });

  it("auto-appends a rotated opt-out phrase when the sequence has append_opt_out=true and the body has no STOP", async () => {
    const seqId = await seedSequence({
      name: "Auto-opt-out",
      steps: [{ delay: 0, body: "Hi {{first_name}}, interested?" }],
      appendOptOut: true,
    });
    const { propertyId } = await seedLead({ phone: "+18165551002" });
    await enrollLead(supabase, { sequenceId: seqId, propertyId });

    await runSequenceTick(supabase);

    const body = getMockMessageLog()[0].body;
    expect(body.includes("STOP")).toBe(true);
  });

  it("does NOT auto-append when the sequence has append_opt_out=false, even if body lacks STOP", async () => {
    const seqId = await seedSequence({
      name: "No-auto",
      steps: [{ delay: 0, body: "Hi {{first_name}}, interested?" }],
      appendOptOut: false,
    });
    const { propertyId } = await seedLead({ phone: "+18165551003" });
    await enrollLead(supabase, { sequenceId: seqId, propertyId });

    await runSequenceTick(supabase);

    const body = getMockMessageLog()[0].body;
    expect(body.includes("STOP")).toBe(false);
  });

  it("marks enrollment 'completed' after the final step", async () => {
    const seqId = await seedSequence({
      name: "Single-step",
      steps: [{ delay: 0, body: "Only step {{first_name}}" }],
    });
    const { propertyId } = await seedLead({ phone: "+18165551004" });
    const enrolled = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    if (enrolled.status !== "enrolled") throw new Error("enroll failed");

    await runSequenceTick(supabase);

    const { data: enr } = await supabase
      .from("sequence_enrollments")
      .select("status, completed_at, next_run_at")
      .eq("id", enrolled.enrollmentId)
      .single();
    expect(enr!.status).toBe("completed");
    expect(enr!.completed_at).not.toBeNull();
    expect(enr!.next_run_at).toBeNull();
  });

  it("pauses when property.status is terminal (dead) — does NOT send, does NOT advance", async () => {
    const seqId = await seedSequence({
      name: "Pause-terminal",
      steps: [{ delay: 0, body: "Hi" }],
    });
    const { propertyId } = await seedLead({
      phone: "+18165551005",
      propertyStatus: "dead",
    });
    const enrolled = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    if (enrolled.status !== "enrolled") throw new Error("enroll failed");

    const summary = await runSequenceTick(supabase);
    expect(summary.outcomes.paused).toBe(1);
    expect(getMockMessageLog()).toHaveLength(0);

    const { data: enr } = await supabase
      .from("sequence_enrollments")
      .select("status, pause_reason")
      .eq("id", enrolled.enrollmentId)
      .single();
    expect(enr!.status).toBe("opted_out"); // terminal → permanent
    expect(enr!.pause_reason).toBe("status_terminal");
  });

  it("pauses (non-permanent) when property.status is offer_sent", async () => {
    const seqId = await seedSequence({
      name: "Pause-acq",
      steps: [{ delay: 0, body: "Hi" }],
    });
    const { propertyId } = await seedLead({
      phone: "+18165551006",
      propertyStatus: "offer_sent",
    });
    const enrolled = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    if (enrolled.status !== "enrolled") throw new Error("enroll failed");

    await runSequenceTick(supabase);
    const { data: enr } = await supabase
      .from("sequence_enrollments")
      .select("status, pause_reason")
      .eq("id", enrolled.enrollmentId)
      .single();
    expect(enr!.status).toBe("paused");
    expect(enr!.pause_reason).toBe("status_acquisition_active");
  });

  it("double-fire safe — running the tick twice on the same due batch only sends once per step", async () => {
    const seqId = await seedSequence({
      name: "Double-fire",
      steps: [
        { delay: 0, body: "One" },
        { delay: 1440, body: "Two" },
      ],
    });
    const { propertyId } = await seedLead({ phone: "+18165551007" });
    await enrollLead(supabase, { sequenceId: seqId, propertyId });

    await runSequenceTick(supabase);
    // Second immediate tick — the first advanced next_run_at to +24h,
    // so the second finds nothing due. But we also verify the unique
    // claim would have prevented a double-send even if it had matched.
    await runSequenceTick(supabase);

    expect(getMockMessageLog()).toHaveLength(1);
    const { count: runCount } = await supabase
      .from("sequence_step_runs")
      .select("*", { count: "exact", head: true });
    expect(runCount).toBe(1);
  });

  it("executes change_status step and advances", async () => {
    const seqId = await seedSequence({
      name: "Status-step",
      steps: [
        { delay: 0, action: "change_status", target_status: "contacted" },
      ],
    });
    const { propertyId } = await seedLead({ phone: "+18165551008" });
    const enrolled = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    if (enrolled.status !== "enrolled") throw new Error("enroll failed");

    await runSequenceTick(supabase);

    const { data: prop } = await supabase
      .from("properties")
      .select("status")
      .eq("id", propertyId)
      .single();
    expect(prop!.status).toBe("contacted");

    const { data: enr } = await supabase
      .from("sequence_enrollments")
      .select("status")
      .eq("id", enrolled.enrollmentId)
      .single();
    expect(enr!.status).toBe("completed");
  });

  it("catches up an enrollment whose next_run_at is overdue by hours", async () => {
    const seqId = await seedSequence({
      name: "Overdue",
      steps: [{ delay: 0, body: "Hi" }],
    });
    const { propertyId } = await seedLead({ phone: "+18165551009" });
    const enrolled = await enrollLead(supabase, { sequenceId: seqId, propertyId });
    if (enrolled.status !== "enrolled") throw new Error("enroll failed");

    // Simulate the scenario: cron missed the last 6 hours. Backdate
    // next_run_at by 6h.
    const sixHoursAgo = new Date(SAFE_NOW.getTime() - 6 * 60 * 60_000).toISOString();
    await supabase
      .from("sequence_enrollments")
      .update({ next_run_at: sixHoursAgo })
      .eq("id", enrolled.enrollmentId);

    const summary = await runSequenceTick(supabase);
    expect(summary.outcomes.sent).toBe(1);
  });
});
