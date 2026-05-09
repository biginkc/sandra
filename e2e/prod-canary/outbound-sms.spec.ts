import { expect, test } from "@playwright/test";

import {
  deleteCanaryContactsByLastName,
  deleteCanaryPropertiesByAddress,
  insertCanaryProspect,
  pollUntil,
  requireCanarySmsRecipient,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

test("production canary sends a real outbound SMS from a canary lead", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);

  const env = requireProdCanaryEnv();
  const recipient = requireCanarySmsRecipient();
  const supabase = requireProdCanarySupabase();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const address = `${env.label} SMS ${token} 801 Provider St`;
  const contactLastName = `PROD-CANARY SMS ${token}`;
  const body = `${env.label} outbound SMS ${token}`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddress(supabase, address);
  await deleteCanaryContactsByLastName(supabase, contactLastName);

  try {
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .insert({
        first_name: "PROD-CANARY",
        last_name: contactLastName,
        phone_1: recipient,
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
        status: "new_lead",
        // Hawaii keeps this send-now canary inside TCPA quiet-hour windows
        // during late-night Central manual runs.
        state: "HI",
      },
    });

    const { error: consentError } = await supabase.from("consent_events").insert({
      contact_id: contact!.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: env.label,
    });
    expect(consentError).toBeNull();

    await page.goto(`/leads/${lead.id}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: address })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("button", { name: "Send SMS" }).click();
    await expect(page.getByRole("dialog", { name: "Send SMS" })).toBeVisible();
    await expect(page.getByLabel("Send from")).not.toHaveValue("", {
      timeout: 20_000,
    });
    await page.getByLabel("Message").fill(body);
    await page.getByRole("button", { name: "Send now" }).click();

    const message = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("messages")
          .select("id, body, direction, status, to_address, property_id, contact_id")
          .eq("property_id", lead.id)
          .eq("contact_id", contact!.id)
          .eq("body", body)
          .maybeSingle();
        expect(error).toBeNull();
        if (!data || data.status !== "sent") return null;
        return data;
      },
      { label: "real outbound canary SMS persisted as sent", timeoutMs: 45_000 },
    );
    expect(message.direction).toBe("outbound");
    expect(message.to_address).toBe(recipient);

    await page.reload();
    await expect(page.getByTestId("messages-thread")).toContainText(body, {
      timeout: 20_000,
    });
  } finally {
    await deleteCanaryPropertiesByAddress(supabase, address);
    await deleteCanaryContactsByLastName(supabase, contactLastName);
  }
});
