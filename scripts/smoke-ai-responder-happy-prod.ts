#!/usr/bin/env tsx
/**
 * AI responder happy-path canary.
 *
 * Proves the AI auto-reply pipe end-to-end in prod:
 *   1. Seed a throwaway contact + property (status=new_lead) + opt-in consent.
 *   2. Forge an inbound SMS with a benign body that should pass every
 *      safety gate (no escalation keywords, no dollar amounts).
 *   3. POST the forged JWT to /api/webhooks/dialpad/sms.
 *   4. Poll `messages` for the AI-drafted outbound (metadata.generated_by
 *      = 'ai_responder_v1') for up to 30s.
 *   5. Assert: the outbound exists, property.needs_human_attention is
 *      false (no escalation), no AI escalation reason set.
 *   6. Clean up: delete the messages, the property, the consent event,
 *      the contact.
 *
 * Cost per run: 1 Anthropic call (~$0.001) + 1 Dialpad outbound (~$0.005).
 * Daily run = ~$0.18/month.
 */

import {
  env,
  fireInboundWebhook,
  resolveCanarySmsReceiverFromEnv,
  pollUntil,
  prodSupabase,
  resolveActiveAiResponderOrgId,
} from "./canary-helpers";

const TS = Date.now();
const TAG = `CANARY-AI-HAPPY-${TS}`;
const CANARY_RUN_STARTED_AT = new Date().toISOString();
const RECEIVER_PHONE = resolveCanarySmsReceiverFromEnv();
const CRM_NUMBER = env.DIALPAD_FROM_NUMBER ?? "+18162804181";
const BENIGN_BODY = "yes I'd like to hear more about selling my property";

/**
 * The seeded property is in MO (America/Chicago). The AI responder
 * config has business_hours_only=true in prod, so outside the
 * 08:00-21:00 window the AI correctly skips with reason
 * "outside_business_hours" — no auto-reply will land. Detect that
 * here and exit clean rather than fail the canary.
 *
 * The scheduled cron fires at 14:30 UTC = 09:30 Central, well inside
 * the window. This guard protects manual `workflow_dispatch` runs
 * fired late at night.
 */
function withinChicagoBusinessHours(): boolean {
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
    10,
  );
  return hour >= 8 && hour < 21;
}

async function main(): Promise<void> {
  if (!withinChicagoBusinessHours()) {
    console.log(
      "Skipping AI happy-path canary — outside 08:00-21:00 America/Chicago. " +
        "AI responder's business_hours_only flag would prevent the auto-reply " +
        "and this canary would falsely fail.",
    );
    process.exit(0);
  }
  const supabase = prodSupabase();
  let contactId: string | null = null;
  let propertyId: string | null = null;

  try {
    const orgId = await resolveActiveAiResponderOrgId(supabase);

    // ---- Seed --------------------------------------------------------------
    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "Canary",
        last_name: TAG,
        phone_1: RECEIVER_PHONE,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    if (contactErr || !contact) throw contactErr ?? new Error("contact seed failed");
    contactId = contact.id;

    const { data: property, error: propErr } = await supabase
      .from("properties")
      .insert({
        org_id: orgId,
        address: `${TAG} Way`,
        state: "MO",
        homeowner_contact_id: contactId,
        status: "new_lead",
      })
      .select("id")
      .single();
    if (propErr || !property) throw propErr ?? new Error("property seed failed");
    propertyId = property.id;

    const { error: consentErr } = await supabase.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: TAG,
    });
    if (consentErr) throw consentErr;

    const { error: anchorErr } = await supabase.from("messages").insert({
      org_id: orgId,
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "internal",
      body: `${TAG} outbound anchor`,
      contact_id: contactId,
      property_id: propertyId,
      from_address: CRM_NUMBER,
      to_address: RECEIVER_PHONE,
      metadata: { canary_anchor: TAG },
    });
    if (anchorErr) throw anchorErr;

    // ---- Fire inbound webhook ---------------------------------------------
    const status = await fireInboundWebhook({
      id: `${TAG}-inbound`,
      from_number: RECEIVER_PHONE,
      to_number: CRM_NUMBER,
      text: BENIGN_BODY,
      timestamp: new Date().toISOString(),
    });
    if (status !== 200) {
      throw new Error(`Webhook returned ${status}, expected 200`);
    }

    // ---- Poll for the AI auto-reply ---------------------------------------
    type Reply = {
      id: string;
      from_address: string | null;
      to_address: string | null;
      body: string;
      metadata: unknown;
      status: string;
    };
    const aiReply = await pollUntil<Reply>(
      async () => {
        const { data } = await supabase
          .from("messages")
          .select("id, body, metadata, status, from_address, to_address")
          .eq("property_id", propertyId!)
          .eq("direction", "outbound")
          .contains("metadata", { generated_by: "ai_responder_v1" })
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return data ? (data as Reply) : null;
      },
      { intervalMs: 2_000, timeoutMs: 30_000, label: "AI auto-reply" },
    );

    const meta = aiReply.metadata as { generated_by?: string };
    if (meta?.generated_by !== "ai_responder_v1") {
      throw new Error(
        `Outbound exists but generated_by=${meta?.generated_by}, expected ai_responder_v1`,
      );
    }
    if (aiReply.status !== "sent") {
      throw new Error(
        `AI outbound status=${aiReply.status}, expected sent`,
      );
    }

    if (!aiReply.from_address || !aiReply.to_address) {
      throw new Error("AI outbound row missing from/to addresses.");
    }
    if (aiReply.from_address !== CRM_NUMBER || aiReply.to_address !== RECEIVER_PHONE) {
      throw new Error("AI outbound route does not match the owned canary sender/receiver.");
    }

    const receiverLogRow = await pollUntil<{ id: string }>(
      async () => {
        const { data } = await supabase
          .from("test_sms_log")
          .select("id, received_at")
          .eq("provider", "twilio")
          .eq("from_number", aiReply.from_address!)
          .eq("to_number", aiReply.to_address!)
          .eq("signature_verified", true)
          .eq("body", aiReply.body)
          .gte("received_at", CANARY_RUN_STARTED_AT)
          .maybeSingle();
        return data ? (data as { id: string }) : null;
      },
      { intervalMs: 2_000, timeoutMs: 30_000, label: "receiver test_sms_log proof" },
    );
    if (!receiverLogRow?.id) {
      throw new Error("Receiver-side proof missing in test_sms_log for AI outbound body.");
    }

    // ---- Assert no escalation ---------------------------------------------
    const { data: prop } = await supabase
      .from("properties")
      .select("needs_human_attention, last_ai_escalation_reason")
      .eq("id", propertyId)
      .single();
    if (prop?.needs_human_attention) {
      throw new Error(
        `Property flagged for human attention; reason=${prop.last_ai_escalation_reason}`,
      );
    }

    console.log(`✓ AI responder happy path: ${aiReply.id}`);
  } finally {
    // ---- Cleanup ----------------------------------------------------------
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
  console.error("AI responder canary FAILED:", err);
  process.exit(1);
});
