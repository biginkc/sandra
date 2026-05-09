#!/usr/bin/env tsx
/**
 * AI responder escalation canary.
 *
 * Proves the AI responder's safety escalation works end-to-end in prod:
 *   1. Seed throwaway contact + property + opt-in (same as happy path).
 *   2. Forge an inbound containing a price-ask keyword ("$200k") that
 *      should trip the tier-B keyword classifier and skip the Claude call.
 *   3. POST the forged JWT to /api/webhooks/dialpad/sms.
 *   4. Poll `properties.needs_human_attention` → true within 30s.
 *   5. Assert: NO outbound message was sent (the keyword classifier
 *      escalates BEFORE calling Claude or sending anything).
 *   6. Clean up.
 *
 * Cost per run: $0 (no Claude call, no Dialpad outbound — escalation
 * short-circuits both). Pure infra/wiring exercise.
 */

import {
  env,
  fireInboundWebhook,
  pollUntil,
  prodSupabase,
  resolveActiveAiResponderOrgId,
} from "./canary-helpers";

const TS = Date.now();
const TAG = `CANARY-AI-ESC-${TS}`;
const PHONE = `+1555${String(TS).slice(-7)}`;
const CRM_NUMBER = env.DIALPAD_FROM_NUMBER ?? "+18162804181";
// Body must contain a tier-B `price_offer` keyword (price/offer/how much/your offer)
// to trip the keyword classifier BEFORE the skip rules — keeps the
// canary independent of business-hours config.
const ESCALATION_BODY = "what's your offer for the property?";

async function main(): Promise<void> {
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
        phone_1: PHONE,
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

    await supabase.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: TAG,
    });

    const { error: anchorErr } = await supabase.from("messages").insert({
      org_id: orgId,
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "prod-canary",
      body: `${TAG} outbound anchor`,
      contact_id: contactId,
      property_id: propertyId,
      from_address: CRM_NUMBER,
      to_address: PHONE,
      metadata: { canary_anchor: TAG },
    });
    if (anchorErr) throw anchorErr;

    // ---- Fire inbound webhook ---------------------------------------------
    const status = await fireInboundWebhook({
      id: `${TAG}-inbound`,
      from_number: PHONE,
      to_number: CRM_NUMBER,
      text: ESCALATION_BODY,
      timestamp: new Date().toISOString(),
    });
    if (status !== 200) {
      throw new Error(`Webhook returned ${status}, expected 200`);
    }

    // ---- Poll for needs_human_attention -----------------------------------
    type Flag = {
      needs_human_attention: boolean;
      last_ai_escalation_reason: string | null;
    };
    const flagged = await pollUntil<Flag>(
      async () => {
        const { data } = await supabase
          .from("properties")
          .select("needs_human_attention, last_ai_escalation_reason")
          .eq("id", propertyId!)
          .single();
        if (data?.needs_human_attention) return data as Flag;
        return null;
      },
      { intervalMs: 2_000, timeoutMs: 30_000, label: "needs_human_attention=true" },
    );

    if (!flagged.last_ai_escalation_reason?.includes("keyword")) {
      throw new Error(
        `Escalated but reason=${flagged.last_ai_escalation_reason}, expected to include 'keyword'`,
      );
    }

    // ---- Assert NO outbound was sent --------------------------------------
    const { data: outbounds } = await supabase
      .from("messages")
      .select("id, body, metadata")
      .eq("property_id", propertyId)
      .eq("direction", "outbound")
      .contains("metadata", { generated_by: "ai_responder_v1" });
    if (outbounds && outbounds.length > 0) {
      throw new Error(
        `Expected no AI outbound after escalation, got ${outbounds.length}: ${JSON.stringify(outbounds)}`,
      );
    }

    console.log(
      `✓ AI responder escalation: reason=${flagged.last_ai_escalation_reason}`,
    );
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
  console.error("AI escalation canary FAILED:", err);
  process.exit(1);
});
