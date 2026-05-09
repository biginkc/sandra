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

test("production canary verifies STOP opt-out side effects and UI blocking", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);

  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const crmNumber = requireDialpadWebhookTarget();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const phone = `+1555${Date.now().toString().slice(-7)}`;
  const address = `${env.label} STOP ${token} 1001 Suppression Way`;
  const contactLastName = `PROD-CANARY STOP ${token}`;
  const sequenceName = `${env.label} STOP sequence ${token}`;
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
        ai_responder_disabled: true,
        homeowner_contact_id: contact!.id,
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

    const { error: outboundError } = await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "internal",
      external_id: `${env.runId}-stop-outbound-anchor`,
      from_address: crmNumber,
      to_address: phone,
      body: `${env.label} STOP outbound anchor ${token}`,
      contact_id: contact!.id,
      property_id: lead.id,
    });
    expect(outboundError).toBeNull();

    const { data: sequence, error: sequenceError } = await supabase
      .from("sequences")
      .insert({
        org_id: org!.id,
        name: sequenceName,
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
        template_body: `${env.label} STOP sequence step ${token}`,
      })
      .select("id")
      .single();
    expect(stepError).toBeNull();
    expect(step?.id).toBeTruthy();
    stepId = step!.id;

    const { data: enrollment, error: enrollmentError } = await supabase
      .from("sequence_enrollments")
      .insert({
        org_id: org!.id,
        sequence_id: sequenceId,
        property_id: lead.id,
        contact_id: contact!.id,
        current_step_index: 0,
        status: "active",
        next_run_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    expect(enrollmentError).toBeNull();
    expect(enrollment?.id).toBeTruthy();
    enrollmentId = enrollment!.id;

    const status = await fireSignedDialpadInbound({
      baseURL: env.baseURL,
      id: `${env.runId}-stop`,
      fromNumber: phone,
      toNumber: crmNumber,
      text: "STOP",
    });
    expect(status).toBe(200);

    const verdict = await pollUntil(
      async () => {
        const [{ data: latestConsent }, { data: optedOutContact }, { data: pausedEnrollment }, { data: message }] =
          await Promise.all([
            supabase
              .from("consent_events")
              .select("event_type")
              .eq("contact_id", contact!.id)
              .order("occurred_at", { ascending: false })
              .limit(1)
              .maybeSingle(),
            supabase
              .from("contacts")
              .select("sms_opted_out")
              .eq("id", contact!.id)
              .single(),
            supabase
              .from("sequence_enrollments")
              .select("status")
              .eq("id", enrollmentId!)
              .single(),
            supabase
              .from("messages")
              .select("id, body, direction, status")
              .eq("property_id", lead.id)
              .eq("contact_id", contact!.id)
              .eq("body", "STOP")
              .maybeSingle(),
          ]);

        if (
          latestConsent?.event_type === "opt_out" &&
          optedOutContact?.sms_opted_out === true &&
          (pausedEnrollment?.status === "opted_out" ||
            pausedEnrollment?.status === "paused") &&
          message?.direction === "inbound" &&
          message.status === "received"
        ) {
          return {
            consent: latestConsent.event_type,
            enrollment: pausedEnrollment.status,
            messageId: message.id,
            smsOptedOut: optedOutContact.sms_opted_out,
          };
        }
        return null;
      },
      { label: "STOP opt-out side effects", timeoutMs: 45_000 },
    );
    expect(verdict).toMatchObject({
      consent: "opt_out",
      smsOptedOut: true,
    });

    await page.goto(`/leads/${lead.id}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: address })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("messages-thread")).toContainText("STOP", {
      timeout: 20_000,
    });

    await page.getByLabel("Reply to this lead").fill(`${env.label} blocked send ${token}`);
    await page.getByTestId("inline-reply-send").click();
    await expect(page.getByText("Blocked: no consent")).toBeVisible({
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
