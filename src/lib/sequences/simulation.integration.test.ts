import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import {
  clearPendingMockReplies,
  getMockMessageLog,
  getPendingMockReplies,
  registerMockPersona,
  resetMockState,
  type MockPersona,
} from "@/lib/messaging/providers/mock";
import { runSequenceTick } from "@/app/api/cron/sequence-tick/route";

import { enrollLead } from "./enrollment";

const supabase = createTestClient();

// Start virtual clock at a UTC moment where every US zone is in the
// [08:00, 21:00) send window — see route.integration.test.ts for the
// same anchor.
const T0 = new Date("2026-04-23T18:00:00Z");

async function getOrgId(): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error("no org");
  return data.id;
}

async function seedThreeStepSequence(name: string): Promise<string> {
  const orgId = await getOrgId();
  const { data: seq } = await supabase
    .from("sequences")
    .insert({ org_id: orgId, name, append_opt_out: true })
    .select("id")
    .single();
  const stepDelays = [0, 60 * 24, 60 * 24 * 7]; // 0, +24h, +7d
  for (let i = 0; i < stepDelays.length; i++) {
    await supabase.from("sequence_steps").insert({
      sequence_id: seq!.id,
      step_index: i,
      delay_after_previous_minutes: stepDelays[i],
      action_type: "send_sms",
      template_body: `Step ${i} for {{property_address}}`,
    });
  }
  return seq!.id;
}

type SeededLead = { propertyId: string; contactId: string; phone: string };

async function seedLeadBatch(
  count: number,
  opts: { personaFor?: (i: number) => MockPersona | null; phonePrefix?: string } = {},
): Promise<SeededLead[]> {
  const prefix = opts.phonePrefix ?? "+1817555";
  const leads: SeededLead[] = [];
  for (let i = 0; i < count; i++) {
    const phone = `${prefix}${String(1000 + i).padStart(4, "0")}`;
    const { data: contact } = await supabase
      .from("contacts")
      .insert({ first_name: `Lead${i}`, phone_1: phone })
      .select("id")
      .single();
    await supabase.from("consent_events").insert({
      contact_id: contact!.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "sim-seed",
    });
    const { data: prop } = await supabase
      .from("properties")
      .insert({
        address: `${i} Sim St`,
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contact!.id,
      })
      .select("id")
      .single();
    leads.push({ propertyId: prop!.id, contactId: contact!.id, phone });

    const persona = opts.personaFor?.(i) ?? null;
    if (persona) registerMockPersona(phone, persona);
  }
  return leads;
}

/**
 * Drain the mock's pending-reply queue and post each one to the
 * Dialpad inbound webhook. This closes the loop: persona-driven
 * "seller reply" → webhook → pause enrollments.
 *
 * Returns the count of replies that were drained + posted.
 */
async function drainPendingReplies(): Promise<{
  drained: number;
  statuses: number[];
}> {
  const { POST: webhookPost } = await import(
    "@/app/api/webhooks/dialpad/sms/route"
  );
  const pending = getPendingMockReplies();
  const statuses: number[] = [];
  for (const reply of pending) {
    const res = await webhookPost(
      new Request("https://test.invalid/api/webhooks/dialpad/sms", {
        method: "POST",
        headers: {
          "x-mock-signature": "valid",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          externalId: reply.id,
          from: reply.from,
          to: reply.to,
          body: reply.body,
        }),
      }),
    );
    statuses.push(res.status);
  }
  // Clear ONLY the replies we actually drained. Future-scheduled replies
  // (e.g. responder at +1h when we drain opt_outer STOPs at +2s) must
  // stay in the queue for a later drain.
  clearPendingMockReplies(pending.map((r) => r.id));
  return { drained: pending.length, statuses };
}

describe("Sequences scaled simulation (integration)", () => {
  beforeEach(async () => {
    // Webhook's createServiceRoleClient() reads NEXT_PUBLIC_SUPABASE_URL.
    // In integration we point it at the test project — mirror the
    // pattern used in the Dialpad webhook integration test.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.TEST_SUPABASE_URL;

    await resetTenantTables(supabase);
    resetMockState();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("N=10 leads through a 3-step sequence with 0/24h/7d delays — every step fires for every lead at the right simulated time", async () => {
    // 10 leads × 3 steps × 1 DB-round-trip-per-send is enough to prove
    // fan-out without turning the test into a 5-minute affair.
    const seqId = await seedThreeStepSequence("Scale-10");
    const leads = await seedLeadBatch(10);
    for (const l of leads) {
      const r = await enrollLead(supabase, {
        sequenceId: seqId,
        propertyId: l.propertyId,
      });
      if (r.status !== "enrolled") throw new Error(`enroll failed: ${r.status}`);
    }

    // Step 0 (delay 0) should fire for all 10 on first tick.
    let r = await runSequenceTick(supabase);
    expect(r.outcomes.sent).toBe(10);
    expect(getMockMessageLog().filter((m) => m.body.startsWith("Step 0"))).toHaveLength(10);

    // Advance 23h — still not due for step 1.
    vi.setSystemTime(new Date(T0.getTime() + 23 * 60 * 60_000));
    r = await runSequenceTick(supabase);
    expect(r.processed).toBe(0);

    // Advance to t=+25h — step 1 due. But we're at 19:00 UTC now which
    // is still inside the send window for all US zones.
    vi.setSystemTime(new Date(T0.getTime() + 25 * 60 * 60_000));
    r = await runSequenceTick(supabase);
    expect(r.outcomes.sent).toBe(10);
    expect(getMockMessageLog().filter((m) => m.body.startsWith("Step 1"))).toHaveLength(10);

    // Advance past step 1's fire time + 7d delay. step 1 fired at
    // T0+25h, so step 2 is due at T0+25h+7d = T0+8d+1h. Advance to
    // T0+9d to be safely past.
    vi.setSystemTime(new Date(T0.getTime() + 9 * 24 * 60 * 60_000));
    r = await runSequenceTick(supabase);
    expect(r.outcomes.sent).toBe(10);
    expect(getMockMessageLog().filter((m) => m.body.startsWith("Step 2"))).toHaveLength(10);

    // All enrollments should be completed.
    const { data: enrollments } = await supabase
      .from("sequence_enrollments")
      .select("status")
      .eq("sequence_id", seqId);
    expect(enrollments).toHaveLength(10);
    for (const e of enrollments ?? []) {
      expect(e.status).toBe("completed");
    }
  }, 90_000);

  it("mixed cohort personas (responders pause, opt_outers opt out, ignorers complete)", async () => {
    const seqId = await seedThreeStepSequence("Mixed-personas");
    // 5 responders, 5 opt_outers, 5 ignorers — smaller than 40/40/20
    // for test wall-clock, but exercises every code path.
    const leads = await seedLeadBatch(15, {
      personaFor: (i) => {
        if (i < 5) return "responder";
        if (i < 10) return "opt_outer";
        return "ignorer";
      },
    });
    for (const l of leads) {
      await enrollLead(supabase, {
        sequenceId: seqId,
        propertyId: l.propertyId,
      });
    }

    // Step 0 — all 15 receive.
    await runSequenceTick(supabase);
    expect(getMockMessageLog()).toHaveLength(15);

    // Advance 2s — opt_outers' STOP replies fire (scheduled +1s in mock).
    vi.setSystemTime(new Date(T0.getTime() + 2000));
    const stopDrain = await drainPendingReplies();
    // Defensive: each STOP should have returned 200 from the webhook.
    expect(stopDrain.statuses.every((s) => s === 200)).toBe(true);
    expect(stopDrain.drained).toBeGreaterThanOrEqual(5);

    // Opt-outers should now be in opted_out status.
    const { data: optedOuts } = await supabase
      .from("sequence_enrollments")
      .select("status, property_id")
      .eq("sequence_id", seqId)
      .eq("status", "opted_out");
    expect(optedOuts).toHaveLength(5);

    // Snapshot enrollment state before responder drain.
    const { data: preEnr } = await supabase
      .from("sequence_enrollments")
      .select("property_id, status")
      .eq("sequence_id", seqId)
      .eq("status", "active");
    // Of the original 15, 5 are opted_out now → 10 active (5 responders + 5 ignorers).
    expect(preEnr).toHaveLength(10);

    // Advance 1h+2s — responder replies fire (scheduled +1h).
    vi.setSystemTime(new Date(T0.getTime() + 60 * 60_000 + 2000));
    const replyDrain = await drainPendingReplies();
    expect(replyDrain.statuses.every((s) => s === 200)).toBe(true);
    expect(replyDrain.drained).toBe(5);

    // Debug: verify that the responders actually had outbound messages
    // the webhook could thread back to (the pause depends on recent
    // outbound for the contact → property_id lookup).
    const responderContactIds = leads.slice(0, 5).map((l) => l.contactId);
    const { data: outbounds } = await supabase
      .from("messages")
      .select("contact_id, property_id")
      .in("contact_id", responderContactIds)
      .eq("direction", "outbound");
    expect(outbounds).toHaveLength(5);
    for (const o of outbounds ?? []) {
      expect(o.property_id).not.toBeNull();
    }

    // Responders should now be paused with reason='inbound_reply'.
    const { data: paused } = await supabase
      .from("sequence_enrollments")
      .select("status, pause_reason")
      .eq("sequence_id", seqId)
      .eq("status", "paused");
    expect(paused).toHaveLength(5);
    for (const p of paused ?? []) {
      expect(p.pause_reason).toBe("inbound_reply");
    }

    // Advance to t=+25h — only ignorers remain active. They proceed to step 1.
    vi.setSystemTime(new Date(T0.getTime() + 25 * 60 * 60_000));
    const r = await runSequenceTick(supabase);
    expect(r.outcomes.sent).toBe(5);

    // Advance past step 2's fire time — same 7d-from-step-1-fire math
    // as the N=25 test above (step 2 due at T0+8d+1h; advance to +9d).
    vi.setSystemTime(new Date(T0.getTime() + 9 * 24 * 60 * 60_000));
    await runSequenceTick(supabase);

    // Only ignorers completed all 3 steps (and thus the whole sequence).
    const { data: completed } = await supabase
      .from("sequence_enrollments")
      .select("status")
      .eq("sequence_id", seqId)
      .eq("status", "completed");
    expect(completed).toHaveLength(5);
  }, 60_000);

  it("every SMS body includes either a template-rendered opt_out variable or an auto-appended STOP phrase", async () => {
    const seqId = await seedThreeStepSequence("Opt-out-coverage");
    const leads = await seedLeadBatch(10);
    for (const l of leads) {
      await enrollLead(supabase, {
        sequenceId: seqId,
        propertyId: l.propertyId,
      });
    }
    await runSequenceTick(supabase);
    const log = getMockMessageLog();
    expect(log).toHaveLength(10);
    for (const m of log) {
      // The step bodies don't include STOP or {{opt_out}}, so the
      // send path should have auto-appended a rotated phrase.
      expect(/STOP/i.test(m.body)).toBe(true);
    }
  }, 30_000);
});
