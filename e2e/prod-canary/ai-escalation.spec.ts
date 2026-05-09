import { expect, test } from "@playwright/test";

import {
  deleteCanaryContactsByLastName,
  deleteCanaryPropertiesByAddress,
  fireSignedDialpadInbound,
  insertCanaryProspect,
  pollUntil,
  requireDialpadWebhookTarget,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

test("production canary verifies AI responder escalation without outbound send", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);

  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const crmNumber = requireDialpadWebhookTarget();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const phone = `+1555${Date.now().toString().slice(-7)}`;
  const address = `${env.label} AI Escalation ${token} 1201 Safety Ln`;
  const contactLastName = `PROD-CANARY AI ESC ${token}`;
  const inboundBody = "what's your offer for the property?";
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddress(supabase, address);
  await deleteCanaryContactsByLastName(supabase, contactLastName);

  try {
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .insert({
        first_name: "PROD-CANARY",
        last_name: contactLastName,
        phone_1: phone,
      })
      .select("id")
      .single();
    expect(contactError).toBeNull();
    expect(contact?.id).toBeTruthy();

    const lead = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: {
        homeowner_contact_id: contact!.id,
        state: "MO",
        status: "new_lead",
      },
    });

    const { error: consentError } = await supabase.from("consent_events").insert({
      contact_id: contact!.id,
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
      body: `${env.label} AI escalation outbound anchor`,
      contact_id: contact!.id,
      property_id: lead.id,
      from_address: crmNumber,
      to_address: phone,
      metadata: { canary_anchor: env.runId },
    });
    expect(anchorError).toBeNull();

    const status = await fireSignedDialpadInbound({
      baseURL: env.baseURL,
      id: `${env.runId}-ai-escalation`,
      fromNumber: phone,
      toNumber: crmNumber,
      text: inboundBody,
    });
    expect(status).toBe(200);

    const escalation = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("properties")
          .select("needs_human_attention, last_ai_escalation_reason")
          .eq("id", lead.id)
          .single();
        expect(error).toBeNull();
        if (data?.needs_human_attention) return data;
        return null;
      },
      { label: "AI responder escalation state", timeoutMs: 45_000 },
    );
    expect(escalation.last_ai_escalation_reason).toContain("keyword");

    const { data: outboundMessages, error: outboundError } = await supabase
      .from("messages")
      .select("id, body, metadata")
      .eq("property_id", lead.id)
      .eq("contact_id", contact!.id)
      .eq("direction", "outbound")
      .contains("metadata", { generated_by: "ai_responder_v1" });
    expect(outboundError).toBeNull();
    expect(outboundMessages ?? []).toHaveLength(0);

    await page.goto(`/leads/${lead.id}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: address })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("messages-thread")).toContainText(inboundBody, {
      timeout: 20_000,
    });
    await expect(
      page.getByText("The AI responder escalated this conversation"),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await deleteCanaryPropertiesByAddress(supabase, address);
    await deleteCanaryContactsByLastName(supabase, contactLastName);
  }
});
