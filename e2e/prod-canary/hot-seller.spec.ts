import { expect, test } from "@playwright/test";

import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { hotHandoffKey } from "@/lib/hot-sellers/hot";


import {
  deleteCanaryConsentBySource,
  deleteCanaryContactsByLastName,
  deleteCanaryPropertiesByAddress,
  fireSignedDialpadInbound,
  getOrCreateCanarySmsRecipientContact,
  insertCanaryProspect,
  pollUntil,
  requireCanarySmsRecipient,
  requireDialpadWebhookTarget,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

/**
 * Messages v2 PR 2: one canary hot text → the lead is on My Leads under the
 * org's owner (Jarrad) and his Slack DM + text delivery rows are `sent`.
 *
 * Disabled by default. Runs only with RUN_PROD_CANARIES=1 AND
 * RUN_HOT_SELLER_CANARY=1, and only after the owner has switched on
 * jev_outcome_thresholds.new_lead.automation_enabled (see the PR body). It
 * sends ONE real Slack DM and ONE real text to the owner (that is the point),
 * and no text to the canary seller.
 */
test("production canary: a hot seller text is handed to the owner with Slack + SMS", async ({}, testInfo) => {
  test.skip(process.env.RUN_HOT_SELLER_CANARY !== "1", "Set RUN_HOT_SELLER_CANARY=1 to run (sends a real Slack DM + text to the owner).");
  test.setTimeout(12 * 60_000);

  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  // hold_alert_deliveries is not in the generated types.
  type DeliveryRow = { channel: string; status: string; recipient_user_id: string };
  const deliveries = () =>
    (supabase as unknown as LooseSupabase).from("hold_alert_deliveries");
  const crmNumber = requireDialpadWebhookTarget();
  const phone = requireCanarySmsRecipient();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const address = `${env.label} HOT ${token} 1202 Offer Ct`;
  const contactLastName = `PROD-CANARY HOT ${token}`;
  let contactId: string | null = null;
  let createdContact = false;
  const alertKeys: string[] = [];
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddress(supabase, address);
  await deleteCanaryContactsByLastName(supabase, contactLastName);

  try {
    const contact = await getOrCreateCanarySmsRecipientContact(supabase, { firstName: "PROD-CANARY", lastName: contactLastName, phone });
    contactId = contact.id;
    createdContact = contact.created;
    const lead = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: { homeowner_contact_id: contact.id, state: "MO", status: "prospect" },
    });

    const { data: owners, error: ownerError } = await supabase.from("memberships").select("user_id").eq("role", "owner");
    expect(ownerError).toBeNull();
    expect(owners).toHaveLength(1);
    const ownerId = owners![0].user_id;

    const { error: anchorError } = await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "internal",
      body: `${env.label} hot-seller outbound anchor`,
      contact_id: contact.id,
      property_id: lead.id,
      from_address: crmNumber,
      to_address: phone,
      metadata: { canary_anchor: env.runId },
    });
    expect(anchorError).toBeNull();

    const status = await fireSignedDialpadInbound({
      baseURL: env.baseURL,
      id: `${env.runId}-hot-seller`,
      fromNumber: phone,
      toNumber: crmNumber,
      text: "Yes, what would you offer me for the house?",
    });
    expect(status).toBe(200);

    await pollUntil(
      async () => {
        const { data } = await supabase.from("properties").select("status, assigned_user_id").eq("id", lead.id).single();
        return data?.status === "new_lead" && data.assigned_user_id === ownerId ? data : null;
      },
      { label: "hot seller assigned to the owner", timeoutMs: 90_000 },
    );
    const { data: events } = await supabase
      .from("lead_events")
      .select("id, source_id")
      .eq("property_id", lead.id)
      .eq("event_type", "assigned")
      .eq("source_type", "hot_seller_handoff");
    expect(events).toHaveLength(1);
    const alertKey = hotHandoffKey(events![0].source_id as string);
    alertKeys.push(alertKey);

    // The alert cron runs on its own schedule; wait for both deliveries.
    const rows = await pollUntil(
      async () => {
        const { data: raw } = await deliveries()
          .select("channel, status, recipient_user_id")
          .eq("hold_key", alertKey);
        const data = (raw ?? []) as unknown as DeliveryRow[];
        const sent = data.filter((r) => r.status === "sent" && r.recipient_user_id === ownerId);
        return sent.some((r) => r.channel === "slack") && sent.some((r) => r.channel === "sms") ? data : null;
      },
      { label: "owner Slack + SMS delivery rows sent", timeoutMs: 10 * 60_000 },
    );
    expect(rows!.filter((r) => r.channel === "slack")).toHaveLength(1);
    expect(rows!.filter((r) => r.channel === "sms")).toHaveLength(1);

    const { data: outbound } = await supabase
      .from("messages")
      .select("id")
      .eq("property_id", lead.id)
      .eq("direction", "outbound")
      .neq("provider", "internal");
    expect(outbound ?? []).toHaveLength(0);
  } finally {
    for (const key of alertKeys) await deliveries().delete().eq("hold_key", key);
    await deleteCanaryPropertiesByAddress(supabase, address);
    if (contactId) await deleteCanaryConsentBySource(supabase, { contactId, source: env.label });
    if (createdContact) await deleteCanaryContactsByLastName(supabase, contactLastName);
  }
});
