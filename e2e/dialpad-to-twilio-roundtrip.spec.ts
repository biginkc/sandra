import { test, expect } from "@playwright/test";

import { adminClient, resetTenantTables, seedProspects } from "./fixtures";

/**
 * Tier 1 end-to-end verification: Dialpad actually delivered the SMS.
 *
 * SKIPPED until real Twilio numbers + auth are provisioned. To enable:
 *   1. Buy ≥1 Twilio number in the test project.
 *   2. Configure its Messaging Webhook → `${PREVIEW_URL}/api/webhooks/test-receiver`.
 *   3. Set env in the Playwright runner:
 *        TWILIO_TEST_TO_NUMBER=+1...        (the Twilio number to receive)
 *        TWILIO_AUTH_TOKEN=<from console>   (used by the receiver to verify)
 *   4. Replace `test.skip` with `test`.
 *
 * When enabled, this asserts that a message our app sent via Dialpad
 * was actually received at the Twilio number — closing the last gap
 * that mock/integration tests can't cover ("did the carrier deliver?").
 */

test.skip("Dialpad → Twilio round-trip: body we sent matches body Twilio received", async ({
  request,
  baseURL,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);

  const twilioTo = process.env.TWILIO_TEST_TO_NUMBER;
  if (!twilioTo) throw new Error("TWILIO_TEST_TO_NUMBER not set");

  // Seed a contact + property + outbound so our app can send to Twilio.
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Twilio",
      last_name: "Probe",
      phone_1: twilioTo,
    })
    .select("id")
    .single();
  const [prop] = await seedProspects(admin, 1, "TWILIO");
  await admin
    .from("properties")
    .update({ homeowner_contact_id: contact!.id })
    .eq("id", prop.id);

  // Capture + consent: the test assumes we've pre-seeded a written
  // opt-in for the Twilio probe contact in the test project (add
  // a consent_event once in a bootstrap script).
  await admin.from("consent_events").insert({
    contact_id: contact!.id,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: "twilio_probe_bootstrap",
  });

  // Send via the same server action the lead detail uses. The unique
  // body lets us disambiguate on the receiver side.
  const body = `Roundtrip probe ${Date.now()}`;
  await request.post(`${baseURL}/api/dev/send-to-property`, {
    data: { propertyId: prop.id, body },
  });

  // Poll test_sms_log until Twilio posts the inbound webhook to our
  // test-receiver and we persist it.
  await expect(async () => {
    const { data } = await admin
      .from("test_sms_log")
      .select("body, to_number")
      .eq("to_number", twilioTo)
      .order("received_at", { ascending: false })
      .limit(1);
    expect(data).toHaveLength(1);
    expect(data![0].body).toBe(body);
  }).toPass({ timeout: 90_000 });
});
