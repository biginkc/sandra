#!/usr/bin/env tsx
/**
 * Sequences V1 — full-stack production smoke.
 *
 * Proves the pipe end-to-end in prod:
 *   1. Seeds a throwaway sequence (1 step, 0 delay, send_sms) in prod Supabase.
 *   2. Seeds a contact with phone_1 from the allowlisted canary receiver.
 *   3. Seeds a consent_events opt_in + a property linked to the contact.
 *   4. Creates an active enrollment with next_run_at = now.
 *   5. Waits up to 6 minutes for the Vercel sequence-tick cron to fire.
 *   6. Polls `test_sms_log` for the exact body + from/to route + signature
 *      verification.
 *   7. Cleans up: deletes only the created sequence, step, enrollment,
 *      property, consent events, messages, and contact.
 *
 * Cost: ~$0.005 for one outbound SMS + pennies for Twilio inbound.
 */

import { prodSupabase, resolveCanarySmsReceiverFromEnv } from "./canary-helpers";

const supabase = prodSupabase();
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const UNIQUE_BODY = `PROD-SMOKE ${TS}`;
const RECEIVER_PHONE = resolveCanarySmsReceiverFromEnv();
const RUN_STARTED_AT = new Date().toISOString();

interface SmokeFixtureIds {
  seqId: string | null;
  stepId: string | null;
  enrollmentId: string | null;
  propertyId: string | null;
  contactId: string | null;
}

async function main(): Promise<void> {
  const fixtureIds: SmokeFixtureIds = {
    seqId: null,
    stepId: null,
    enrollmentId: null,
    propertyId: null,
    contactId: null,
  };

  try {
    console.log(`[smoke] start ${TS}`);

    // Resolve org
    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .single();
    if (!org) throw new Error("no organization in prod");

    // Seed sequence
    const { data: seq, error: seqErr } = await supabase
      .from("sequences")
      .insert({
        org_id: org.id,
        name: `SMOKE TEST — safe to delete ${TS}`,
        description: "One-off prod smoke; script deletes this when it exits",
        append_opt_out: false,
      })
      .select("id")
      .single();
    if (seqErr || !seq) throw seqErr ?? new Error("seq insert failed");
    fixtureIds.seqId = seq.id;
    console.log(`[smoke] seq    ${seq.id}`);

    const { data: step, error: stepErr } = await supabase
      .from("sequence_steps")
      .insert({
        sequence_id: seq.id,
        step_index: 0,
        delay_after_previous_minutes: 0,
        action_type: "send_sms",
        template_body: `${UNIQUE_BODY} — Reply STOP.`,
      })
      .select("id")
      .single();
    if (stepErr || !step) throw stepErr ?? new Error("step insert failed");
    fixtureIds.stepId = step.id;

    // Seed contact + consent
    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .insert({
        first_name: "Smoke",
        last_name: "Prod",
        phone_1: RECEIVER_PHONE,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    if (contactErr || !contact) throw contactErr ?? new Error("contact insert failed");
    fixtureIds.contactId = contact.id;

    const consentErr = await supabase.from("consent_events").insert({
      contact_id: contact.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "e2e-prod-smoke",
    });
    if (consentErr.error) throw consentErr.error;

    // Seed property
    const { data: property, error: propErr } = await supabase
      .from("properties")
      .insert({
        address: `E2E PROD SMOKE ${TS}`,
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contact.id,
      })
      .select("id")
      .single();
    if (propErr || !property) throw propErr ?? new Error("property insert failed");
    fixtureIds.propertyId = property.id;
    console.log(`[smoke] prop   ${property.id}`);

    // Enroll (next_run_at = now so the next cron tick picks it up)
    const { data: enrollment, error: enrErr } = await supabase
      .from("sequence_enrollments")
      .insert({
        org_id: org.id,
        sequence_id: seq.id,
        property_id: property.id,
        contact_id: contact.id,
        status: "active",
        current_step_index: 0,
        next_run_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (enrErr || !enrollment) throw enrErr ?? new Error("enrollment insert failed");
    fixtureIds.enrollmentId = enrollment.id;
    console.log(`[smoke] enrol  ${enrollment.id}`);

    console.log("[smoke] waiting up to 6 min for the Vercel cron to fire");

    const deadline = Date.now() + 6 * 60_000;
    const expectedBody = `${UNIQUE_BODY} — Reply STOP.`;
    let receiverLogId: string | null = null;
    while (Date.now() < deadline) {
      const { data: outbound } = await supabase
        .from("messages")
        .select("from_address, to_address")
        .eq("property_id", property.id)
        .eq("direction", "outbound")
        .eq("body", expectedBody)
        .maybeSingle();

      if (outbound?.from_address && outbound.to_address === RECEIVER_PHONE) {
        const { data: rows } = await supabase
          .from("test_sms_log")
          .select("id")
          .eq("provider", "twilio")
          .eq("from_number", outbound.from_address)
          .eq("to_number", outbound.to_address)
          .eq("signature_verified", true)
          .eq("body", expectedBody)
          .gte("received_at", RUN_STARTED_AT)
          .limit(1);

        if (rows && rows.length > 0) {
          receiverLogId = rows[0].id;
          break;
        }
      }

      await new Promise((r) => setTimeout(r, 15_000));
      process.stdout.write(".");
    }
    process.stdout.write("\n");

    if (!receiverLogId) {
      throw new Error("FAILED — no matching test_sms_log row for exact route/body/signature_verified.");
    }

    console.log(`[smoke] PASS    test_sms_log row ${receiverLogId}`);

    const { data: after } = await supabase
      .from("sequence_enrollments")
      .select("status")
      .eq("id", enrollment.id)
      .single();
    if (!after) throw new Error("Enrollment row disappeared before final status read");
    if (after.status !== "completed") {
      throw new Error(`Enrollment did not complete: ${after.status}`);
    }
    console.log(`[smoke]         enrollment.status = ${after.status}`);
  } finally {
    await cleanup(fixtureIds);
    console.log("[smoke] cleaned");
  }
}

async function cleanup(ids: SmokeFixtureIds): Promise<void> {
  const errors: Array<string> = [];

  if (ids.stepId) {
    const { error: runErr } = await supabase
      .from("sequence_step_runs")
      .delete()
      .eq("step_id", ids.stepId);
    if (runErr) errors.push(`sequence_step_runs for step ${ids.stepId}: ${runErr.message}`);
  }

  if (ids.enrollmentId) {
    const { error } = await supabase
      .from("sequence_enrollments")
      .delete()
      .eq("id", ids.enrollmentId);
    if (error) errors.push(`sequence_enrollments ${ids.enrollmentId}: ${error.message}`);
  }

  if (ids.stepId) {
    const { error: stepErr } = await supabase
      .from("sequence_steps")
      .delete()
      .eq("id", ids.stepId);
    if (stepErr) errors.push(`sequence_steps ${ids.stepId}: ${stepErr.message}`);
  }

  if (ids.seqId) {
    const { error } = await supabase.from("sequences").delete().eq("id", ids.seqId);
    if (error) errors.push(`sequences ${ids.seqId}: ${error.message}`);
  }

  if (ids.contactId) {
    const { error: consentError } = await supabase
      .from("consent_events")
      .delete()
      .eq("contact_id", ids.contactId);
    if (consentError) errors.push(`consent_events for ${ids.contactId}: ${consentError.message}`);

    const { error: messageError } = await supabase
      .from("messages")
      .delete()
      .eq("contact_id", ids.contactId);
    if (messageError) errors.push(`messages for ${ids.contactId}: ${messageError.message}`);
  }

  if (ids.propertyId) {
    const { error } = await supabase.from("properties").delete().eq("id", ids.propertyId);
    if (error) errors.push(`properties ${ids.propertyId}: ${error.message}`);
  }

  if (ids.contactId) {
    const { error } = await supabase.from("contacts").delete().eq("id", ids.contactId);
    if (error) errors.push(`contacts ${ids.contactId}: ${error.message}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

main()
  .catch((err: unknown) => {
    console.error("[smoke] ERROR", err);
    process.exit(1);
  });
