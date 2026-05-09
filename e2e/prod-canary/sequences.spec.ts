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

test("production canary verifies sequence tick delivery and lead-thread UI", async ({
  page,
}, testInfo) => {
  test.setTimeout(7 * 60_000);

  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const recipient = requireCanarySmsRecipient();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const address = `${env.label} Sequence ${token} 1301 Tick Dr`;
  const contactLastName = `PROD-CANARY SEQUENCE ${token}`;
  const sequenceName = `${env.label} Sequence ${token}`;
  const body = `${env.label} sequence SMS ${token} Reply STOP.`;
  let sequenceId: string | null = null;
  let stepId: string | null = null;
  let enrollmentId: string | null = null;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddress(supabase, address);
  await deleteCanaryContactsByLastName(supabase, contactLastName);

  try {
    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .single();
    expect(orgError).toBeNull();
    expect(org?.id).toBeTruthy();

    const { data: sequence, error: sequenceError } = await supabase
      .from("sequences")
      .insert({
        org_id: org!.id,
        name: sequenceName,
        description: `Created by production Playwright canary ${env.runId}`,
        active: true,
        append_opt_out: false,
      })
      .select("id")
      .single();
    expect(sequenceError).toBeNull();
    expect(sequence?.id).toBeTruthy();
    sequenceId = sequence!.id;

    const { data: step, error: stepError } = await supabase
      .from("sequence_steps")
      .insert({
        sequence_id: sequenceId,
        step_index: 0,
        action_type: "send_sms",
        delay_after_previous_minutes: 0,
        template_body: body,
      })
      .select("id")
      .single();
    expect(stepError).toBeNull();
    expect(step?.id).toBeTruthy();
    stepId = step!.id;

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
        // Hawaii keeps the send-now sequence canary inside TCPA quiet-hour
        // windows during late-night Central manual runs.
        state: "HI",
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

    const { data: enrollment, error: enrollmentError } = await supabase
      .from("sequence_enrollments")
      .insert({
        org_id: org!.id,
        sequence_id: sequenceId,
        property_id: lead.id,
        contact_id: contact!.id,
        current_step_index: 0,
        status: "active",
        next_run_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    expect(enrollmentError).toBeNull();
    expect(enrollment?.id).toBeTruthy();
    enrollmentId = enrollment!.id;

    const sentMessage = await pollUntil(
      async () => {
        const [{ data: message, error: messageError }, { data: enrollmentState }] =
          await Promise.all([
            supabase
              .from("messages")
              .select("id, body, direction, status, to_address")
              .eq("property_id", lead.id)
              .eq("contact_id", contact!.id)
              .eq("body", body)
              .maybeSingle(),
            supabase
              .from("sequence_enrollments")
              .select("status, completed_at")
              .eq("id", enrollmentId!)
              .single(),
          ]);
        expect(messageError).toBeNull();
        if (
          message?.direction === "outbound" &&
          message.status === "sent" &&
          message.to_address === recipient &&
          enrollmentState?.status === "completed"
        ) {
          return message;
        }
        return null;
      },
      {
        intervalMs: 15_000,
        label: "production sequence tick delivery",
        timeoutMs: 6 * 60_000,
      },
    );
    expect(sentMessage.body).toBe(body);

    await page.goto(`/leads/${lead.id}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: address })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("messages-thread")).toContainText(body, {
      timeout: 20_000,
    });
  } finally {
    if (enrollmentId) {
      await supabase.from("sequence_enrollments").delete().eq("id", enrollmentId);
    }
    if (stepId) {
      await supabase.from("sequence_steps").delete().eq("id", stepId);
    }
    if (sequenceId) {
      await supabase.from("sequences").delete().eq("id", sequenceId);
    }
    await deleteCanaryPropertiesByAddress(supabase, address);
    await deleteCanaryContactsByLastName(supabase, contactLastName);
  }
});
