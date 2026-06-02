import { expect, test } from "@playwright/test";

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

function withinChicagoBusinessHours(): boolean {
  const hour = Number.parseInt(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: "America/Chicago",
    }).format(new Date()),
    10,
  );
  return hour >= 8 && hour < 21;
}

test("production canary verifies AI responder happy path in the lead thread", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  test.skip(
    !withinChicagoBusinessHours(),
    "AI responder production config is business-hours only for America/Chicago.",
  );

  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const crmNumber = requireDialpadWebhookTarget();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const phone = requireCanarySmsRecipient();
  const address = `${env.label} AI ${token} 1101 Responder Ct`;
  const contactLastName = `PROD-CANARY AI ${token}`;
  const inboundBody = "yes I'd like to hear more about selling my property";
  let contactId: string | null = null;
  let createdContact = false;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddress(supabase, address);
  await deleteCanaryContactsByLastName(supabase, contactLastName);

  try {
    const contact = await getOrCreateCanarySmsRecipientContact(supabase, {
      firstName: "PROD-CANARY",
      lastName: contactLastName,
      phone,
    });
    contactId = contact.id;
    createdContact = contact.created;

    const lead = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: {
        homeowner_contact_id: contact.id,
        state: "MO",
        status: "new_lead",
      },
    });

    const { error: consentError } = await supabase.from("consent_events").insert({
      contact_id: contact.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: env.label,
    });
    expect(consentError).toBeNull();

    const { error: anchorError } = await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "internal",
      body: `${env.label} AI responder outbound anchor`,
      contact_id: contact.id,
      property_id: lead.id,
      from_address: crmNumber,
      to_address: phone,
      metadata: { canary_anchor: env.runId },
    });
    expect(anchorError).toBeNull();

    const status = await fireSignedDialpadInbound({
      baseURL: env.baseURL,
      id: `${env.runId}-ai-happy`,
      fromNumber: phone,
      toNumber: crmNumber,
      text: inboundBody,
    });
    expect(status).toBe(200);

    const aiReply = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("messages")
          .select("id, body, direction, status, metadata")
          .eq("property_id", lead.id)
          .eq("contact_id", contact.id)
          .eq("direction", "outbound")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        expect(error).toBeNull();
        const metadata = data?.metadata as { generated_by?: string } | null;
        if (
          data?.status === "sent" &&
          metadata?.generated_by === "ai_responder_v1"
        ) {
          return {
            body: data.body,
            id: data.id,
          };
        }
        return null;
      },
      { label: "AI responder outbound message", timeoutMs: 45_000 },
    );

    const { data: leadState, error: leadStateError } = await supabase
      .from("properties")
      .select("needs_human_attention, last_ai_escalation_reason")
      .eq("id", lead.id)
      .single();
    expect(leadStateError).toBeNull();
    expect(leadState?.needs_human_attention).toBe(false);
    expect(leadState?.last_ai_escalation_reason).toBeNull();

    await page.goto(`/leads/${lead.id}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: address })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("messages-thread")).toContainText(inboundBody, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("messages-thread")).toContainText(aiReply.body, {
      timeout: 20_000,
    });
  } finally {
    await deleteCanaryPropertiesByAddress(supabase, address);
    if (contactId) {
      await deleteCanaryConsentBySource(supabase, {
        contactId,
        source: env.label,
      });
    }
    if (createdContact) {
      await deleteCanaryContactsByLastName(supabase, contactLastName);
    }
  }
});
