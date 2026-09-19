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
  resolveAuthUserId,
  resolvePrimaryMembershipOrgId,
} from "./support";

test("production Messages keeps a signed inbound reply in its owned conversation", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const userId = await resolveAuthUserId(supabase, env.email);
  const orgId = await resolvePrimaryMembershipOrgId(supabase, userId);
  const crmNumber = requireDialpadWebhookTarget();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const phone = `+1555${Date.now().toString().slice(-7)}`;
  const address = `${env.label} Messages ${token} 903 Webhook Ave`;
  const lastName = `PROD-CANARY THREAD ${token}`;
  const outboundBody = `${env.label} thread context ${token}`;
  const inboundBody = `${env.label} signed inbound reply ${token}`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddress(supabase, address);
  await deleteCanaryContactsByLastName(supabase, lastName);
  try {
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "PROD-CANARY",
        last_name: lastName,
        phone_1: phone,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    expect(contactError).toBeNull();
    expect(contact).not.toBeNull();

    const lead = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: {
        org_id: orgId,
        ai_responder_disabled: true,
        homeowner_contact_id: contact!.id,
        status: "new_lead",
      },
    });
    const { error: assignmentError } = await supabase
      .from("properties")
      .update({ assigned_user_id: userId })
      .eq("id", lead.id)
      .eq("org_id", orgId);
    expect(assignmentError).toBeNull();

    // This context row is fixture data, not evidence that an SMS was sent.
    // The provider-backed outbound test is separate.
    const { data: context, error: contextError } = await supabase
      .from("messages")
      .insert({
        org_id: orgId,
        channel: "sms",
        direction: "outbound",
        status: "sent",
        from_address: crmNumber,
        to_address: phone,
        body: outboundBody,
        contact_id: contact!.id,
        property_id: lead.id,
      })
      .select("id,conversation_id")
      .single();
    expect(contextError).toBeNull();
    expect(context?.conversation_id).toBeTruthy();

    const status = await fireSignedDialpadInbound({
      baseURL: env.baseURL,
      id: `${env.runId}-messages-reply`,
      fromNumber: phone,
      toNumber: crmNumber,
      text: inboundBody,
    });
    expect(status).toBe(200);
    const reply = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("messages")
          .select("id,direction,status,conversation_id,property_id,contact_id")
          .eq("org_id", orgId)
          .eq("body", inboundBody)
          .maybeSingle();
        expect(error).toBeNull();
        return data;
      },
      { label: "signed inbound reply attributed", timeoutMs: 45_000 },
    );
    expect(reply.direction).toBe("inbound");
    expect(reply.status).toBe("received");
    expect(reply.property_id).toBe(lead.id);
    expect(reply.contact_id).toBe(contact!.id);
    expect(reply.conversation_id).toBe(context!.conversation_id);

    await page.goto(`/messages?thread=${reply.conversation_id}`);
    await expect(page).not.toHaveURL(/\/login/);
    const detail = page.getByTestId("inbox-detail-panel");
    await expect(detail).toContainText(outboundBody, { timeout: 20_000 });
    await expect(detail).toContainText(inboundBody);
    await page.reload();
    await expect(page.getByTestId("inbox-detail-panel")).toContainText(inboundBody, {
      timeout: 20_000,
    });
  } finally {
    await deleteCanaryPropertiesByAddress(supabase, address);
    await deleteCanaryContactsByLastName(supabase, lastName);
  }
});
