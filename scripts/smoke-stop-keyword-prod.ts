#!/usr/bin/env tsx
/**
 * STOP-keyword TCPA canary.
 *
 * The most important compliance signal we have. If STOP handling
 * silently breaks, BMH keeps texting people who opted out — TCPA
 * violations are $500-$1500 per text.
 *
 * Flow:
 *   1. Seed throwaway contact + property + opt-in consent.
 *   2. Seed an active sequence enrollment so we can verify it pauses.
 *   3. Forge an inbound with body "STOP".
 *   4. POST forged JWT to /api/webhooks/dialpad/sms.
 *   5. Poll for: latest consent_event = opt_out, contact.sms_opted_out = true,
 *      sequence_enrollments.status = opted_out.
 *   6. Clean up.
 *
 * Cost per run: $0 (no Claude, no outbound — STOP just toggles flags).
 */

import {
  env,
  fireInboundWebhook,
  pollUntil,
  prodSupabase,
} from "./canary-helpers";

const TS = Date.now();
const TAG = `CANARY-STOP-${TS}`;
const PHONE = `+1555${String(TS).slice(-7)}`;
const CRM_NUMBER = env.DIALPAD_FROM_NUMBER ?? "+18162804181";

async function main(): Promise<void> {
  const supabase = prodSupabase();
  let contactId: string | null = null;
  let propertyId: string | null = null;
  let sequenceId: string | null = null;
  let stepId: string | null = null;
  let enrollmentId: string | null = null;

  // Single-tenant assumption holds for BMH today.
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  if (!org) throw new Error("no organizations row in prod");

  try {
    // ---- Seed contact + property + consent --------------------------------
    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .insert({
        first_name: "Canary",
        last_name: TAG,
        phone_1: PHONE,
      })
      .select("id")
      .single();
    if (contactErr || !contact) throw contactErr ?? new Error("contact seed failed");
    contactId = contact.id;

    const { data: property, error: propErr } = await supabase
      .from("properties")
      .insert({
        address: `${TAG} Way`,
        state: "MO",
        homeowner_contact_id: contactId,
        status: "new_lead",
      })
      .select("id")
      .single();
    if (propErr || !property) throw propErr ?? new Error("property seed failed");
    propertyId = property.id;

    await supabase.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: TAG,
    });

    // ---- Seed an active sequence enrollment -------------------------------
    const { data: seq, error: seqErr } = await supabase
      .from("sequences")
      .insert({
        org_id: org.id,
        name: TAG,
        active: true,
        append_opt_out: false,
      })
      .select("id")
      .single();
    if (seqErr || !seq) throw seqErr ?? new Error("sequence seed failed");
    sequenceId = seq.id;

    const { data: step, error: stepErr } = await supabase
      .from("sequence_steps")
      .insert({
        sequence_id: sequenceId,
        step_index: 0,
        action_type: "send_sms",
        delay_after_previous_minutes: 0,
        template_body: `${TAG} step`,
      })
      .select("id")
      .single();
    if (stepErr || !step) throw stepErr ?? new Error("step seed failed");
    stepId = step.id;

    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const { data: enrollment, error: enrollErr } = await supabase
      .from("sequence_enrollments")
      .insert({
        org_id: org.id,
        sequence_id: sequenceId,
        property_id: propertyId,
        contact_id: contactId,
        current_step_index: 0,
        status: "active",
        next_run_at: future, // far enough out it can't fire mid-canary
      })
      .select("id")
      .single();
    if (enrollErr || !enrollment) throw enrollErr ?? new Error("enrollment seed failed");
    enrollmentId = enrollment.id;

    // ---- Fire STOP inbound ------------------------------------------------
    const status = await fireInboundWebhook({
      id: `${TAG}-stop`,
      from_number: PHONE,
      to_number: CRM_NUMBER,
      text: "STOP",
      timestamp: new Date().toISOString(),
    });
    if (status !== 200) {
      throw new Error(`Webhook returned ${status}, expected 200`);
    }

    // ---- Poll for the three opt-out side effects --------------------------
    type Verdict = {
      latestConsentEvent: string;
      smsOptedOut: boolean;
      enrollmentStatus: string;
    };
    const verdict = await pollUntil<Verdict>(
      async () => {
        const [{ data: consent }, { data: c }, { data: e }] = await Promise.all([
          supabase
            .from("consent_events")
            .select("event_type")
            .eq("contact_id", contactId!)
            .order("occurred_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("contacts")
            .select("sms_opted_out")
            .eq("id", contactId!)
            .single(),
          supabase
            .from("sequence_enrollments")
            .select("status")
            .eq("id", enrollmentId!)
            .single(),
        ]);
        if (
          consent?.event_type === "opt_out" &&
          c?.sms_opted_out === true &&
          (e?.status === "opted_out" || e?.status === "paused")
        ) {
          return {
            latestConsentEvent: consent.event_type,
            smsOptedOut: c.sms_opted_out,
            enrollmentStatus: e.status,
          };
        }
        return null;
      },
      { intervalMs: 2_000, timeoutMs: 30_000, label: "STOP side effects" },
    );

    console.log(
      `✓ STOP keyword: consent=${verdict.latestConsentEvent}, ` +
        `sms_opted_out=${verdict.smsOptedOut}, enrollment=${verdict.enrollmentStatus}`,
    );
  } finally {
    // ---- Cleanup ----------------------------------------------------------
    if (enrollmentId) {
      await supabase
        .from("sequence_enrollments")
        .delete()
        .eq("id", enrollmentId);
    }
    if (stepId) {
      await supabase.from("sequence_steps").delete().eq("id", stepId);
    }
    if (sequenceId) {
      await supabase.from("sequences").delete().eq("id", sequenceId);
    }
    if (propertyId) {
      await supabase.from("messages").delete().eq("property_id", propertyId);
      await supabase.from("properties").delete().eq("id", propertyId);
    }
    if (contactId) {
      await supabase.from("consent_events").delete().eq("contact_id", contactId);
      await supabase.from("contacts").delete().eq("id", contactId);
    }
  }
}

main().catch((err) => {
  console.error("STOP keyword canary FAILED:", err);
  process.exit(1);
});
