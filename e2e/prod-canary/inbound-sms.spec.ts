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

test("production canary renders a signed inbound SMS webhook in the lead thread", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);

  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const crmNumber = requireDialpadWebhookTarget();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const phone = `+1555${Date.now().toString().slice(-7)}`;
  const address = `${env.label} Inbound ${token} 901 Webhook Ave`;
  const contactLastName = `PROD-CANARY INBOUND ${token}`;
  const body = `${env.label} inbound SMS ${token}`;
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
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    expect(contactError).toBeNull();
    expect(contact?.id).toBeTruthy();

    const lead = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: {
        ai_responder_disabled: true,
        homeowner_contact_id: contact!.id,
        status: "new_lead",
      },
    });

    const { error: outboundError } = await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      from_address: crmNumber,
      to_address: phone,
      body: `${env.label} outbound context ${token}`,
      contact_id: contact!.id,
      property_id: lead.id,
    });
    expect(outboundError).toBeNull();

    const status = await fireSignedDialpadInbound({
      baseURL: env.baseURL,
      id: `${env.runId}-inbound`,
      fromNumber: phone,
      toNumber: crmNumber,
      text: body,
    });
    expect(status).toBe(200);

    const message = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("messages")
          .select(
            "id, body, direction, status, from_address, to_address, property_id, contact_id",
          )
          .eq("property_id", lead.id)
          .eq("contact_id", contact!.id)
          .eq("body", body)
          .maybeSingle();
        expect(error).toBeNull();
        if (!data) return null;
        return data;
      },
      { label: "signed inbound canary SMS persisted", timeoutMs: 45_000 },
    );
    expect(message.direction).toBe("inbound");
    expect(message.status).toBe("received");
    expect(message.from_address).toBe(phone);
    expect(message.to_address).toBe(crmNumber);

    await page.goto(`/leads/${lead.id}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: address })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("messages-thread")).toContainText(body, {
      timeout: 20_000,
    });
  } finally {
    await deleteCanaryPropertiesByAddress(supabase, address);
    await deleteCanaryContactsByLastName(supabase, contactLastName);
  }
});
