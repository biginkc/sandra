#!/usr/bin/env tsx
/**
 * Sendillo webhook prod smoke.
 *
 * Purpose:
 * - Prove Sandra's live Sendillo inbound route accepts a Sendillo-shaped JSON
 *   webhook with the shared-secret header.
 * - Prove the inbound persists onto the expected canary lead thread.
 * - Prove exact-replay of the same webhook does not duplicate the message or
 *   the owner notification.
 * - In STOP mode, prove opt-out side effects remain intact on the Sendillo
 *   route itself.
 *
 * This does NOT prove Sendillo account-level webhook ownership. It proves the
 * Sandra side is live and behaving correctly when hit directly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  env,
  fireSendilloInboundWebhook,
  pollUntil,
  prodSupabase,
} from "./canary-helpers";
import type { Database } from "../src/lib/supabase/types";

const mode = process.env.SENDILLO_SMOKE_MODE === "stop" ? "stop" : "regular";
const ts = Date.now();
const tag = `PROD-CANARY-SENDILLO-${mode.toUpperCase()}-${ts}`;
const phone = `+1555${String(ts).slice(-7)}`;
function requireSendilloFromNumber(): string {
  const value = env.SENDILLO_FROM_NUMBER;
  if (!value || !/^\+\d{10,15}$/.test(value)) {
    throw new Error(
      `SENDILLO_FROM_NUMBER must be set to an E.164 number. Got ${value ?? "<missing>"}`,
    );
  }
  return value;
}

function requireProdEmail(): string {
  const email = env.PROD_EMAIL;
  if (!email) {
    throw new Error("PROD_EMAIL is required to resolve the canary assignee.");
  }
  return email;
}

async function resolveCanaryUserId(
  client: SupabaseClient<Database>,
  email: string,
): Promise<string> {
  const { data, error } = await client.auth.admin.listUsers();
  if (error) {
    throw new Error(`Could not list production auth users: ${error.message}`);
  }

  const user = data.users.find(
    (candidate) => candidate.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!user) {
    throw new Error(`Could not resolve production canary user for ${email}.`);
  }
  return user.id;
}

async function resolveOrgId(
  client: SupabaseClient<Database>,
  canaryUserId: string,
): Promise<string> {
  const explicitOrgId = env.PROD_ORG_ID;
  if (explicitOrgId) {
    return explicitOrgId;
  }

  const { data, error } = await client
    .from("memberships")
    .select("org_id")
    .eq("user_id", canaryUserId);
  if (error) {
    throw new Error(`Could not resolve canary org membership: ${error.message}`);
  }

  const orgIds = Array.from(new Set((data ?? []).map((row) => row.org_id)));
  if (orgIds.length !== 1) {
    throw new Error(
      `Could not resolve a single production org for canary user ${canaryUserId}. Set PROD_ORG_ID explicitly.`,
    );
  }
  return orgIds[0];
}

async function cleanup(
  client: SupabaseClient<Database>,
  ids: {
    externalId: string;
    messageIds: string[];
    propertyId: string | null;
    contactId: string | null;
    sequenceEnrollmentId: string | null;
    sequenceStepId: string | null;
    sequenceId: string | null;
  },
): Promise<void> {
  const cleanupErrors: string[] = [];
  async function runDelete(
    label: string,
    runner: () => PromiseLike<{ error: { message: string } | null }>,
  ) {
    const { error } = await runner();
    if (error) cleanupErrors.push(`${label}: ${error.message}`);
  }

  if (ids.messageIds.length > 0) {
    await runDelete("notifications", () =>
      client
        .from("notifications")
        .delete()
        .eq("entity_type", "message")
        .in("entity_id", ids.messageIds),
    );
  }
  if (ids.sequenceEnrollmentId) {
    const sequenceEnrollmentId = ids.sequenceEnrollmentId;
    await runDelete("sequence_enrollments", () =>
      client
        .from("sequence_enrollments")
        .delete()
        .eq("id", sequenceEnrollmentId),
    );
  }
  if (ids.sequenceStepId) {
    const sequenceStepId = ids.sequenceStepId;
    await runDelete("sequence_steps", () =>
      client.from("sequence_steps").delete().eq("id", sequenceStepId),
    );
  }
  if (ids.sequenceId) {
    const sequenceId = ids.sequenceId;
    await runDelete("sequences", () =>
      client.from("sequences").delete().eq("id", sequenceId),
    );
  }
  await runDelete("webhook_events", () =>
    client
      .from("webhook_events")
      .delete()
      .eq("provider", "sendillo")
      .eq("event_type", "sms_inbound")
      .eq("external_id", ids.externalId),
  );
  if (ids.propertyId) {
    const propertyId = ids.propertyId;
    await runDelete("messages", () =>
      client.from("messages").delete().eq("property_id", propertyId),
    );
    await runDelete("properties", () =>
      client.from("properties").delete().eq("id", propertyId),
    );
  }
  if (ids.contactId) {
    const contactId = ids.contactId;
    await runDelete("consent_events", () =>
      client.from("consent_events").delete().eq("contact_id", contactId),
    );
    await runDelete("contacts", () =>
      client.from("contacts").delete().eq("id", contactId),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new Error(`cleanup failed: ${cleanupErrors.join("; ")}`);
  }
}

async function main(): Promise<void> {
  const supabase = prodSupabase();
  const prodEmail = requireProdEmail();
  const sendilloFrom = requireSendilloFromNumber();
  const canaryUserId = await resolveCanaryUserId(supabase, prodEmail);
  const orgId = await resolveOrgId(supabase, canaryUserId);
  const body = mode === "stop" ? "STOP" : `${tag} inbound replay-safe proof`;
  const externalId = `${tag}-message`;
  const ids = {
    externalId,
    messageIds: [] as string[],
    propertyId: null as string | null,
    contactId: null as string | null,
    sequenceEnrollmentId: null as string | null,
    sequenceStepId: null as string | null,
    sequenceId: null as string | null,
  };

  try {
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "PROD-CANARY",
        last_name: tag,
        phone_1: phone,
      })
      .select("id")
      .single();
    if (contactError || !contact) {
      throw contactError ?? new Error("Could not seed canary contact.");
    }
    ids.contactId = contact.id;

    const { data: property, error: propertyError } = await supabase
      .from("properties")
      .insert({
        org_id: orgId,
        address: `${tag} 1 Webhook Way`,
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contact.id,
        assigned_user_id: canaryUserId,
        ai_responder_disabled: true,
      })
      .select("id")
      .single();
    if (propertyError || !property) {
      throw propertyError ?? new Error("Could not seed canary property.");
    }
    ids.propertyId = property.id;

    if (mode === "stop") {
      const { error: consentError } = await supabase.from("consent_events").insert({
        contact_id: contact.id,
        channel: "sms",
        event_type: "opt_in_marketing_written",
        source: tag,
      });
      if (consentError) throw consentError;

      const { data: sequence, error: sequenceError } = await supabase
        .from("sequences")
        .insert({
          org_id: orgId,
          name: tag,
          active: true,
          append_opt_out: false,
        })
        .select("id")
        .single();
      if (sequenceError || !sequence) {
        throw sequenceError ?? new Error("Could not seed canary sequence.");
      }
      ids.sequenceId = sequence.id;

      const { data: step, error: stepError } = await supabase
        .from("sequence_steps")
        .insert({
          sequence_id: sequence.id,
          step_index: 0,
          action_type: "send_sms",
          delay_after_previous_minutes: 0,
          template_body: `${tag} step`,
        })
        .select("id")
        .single();
      if (stepError || !step) {
        throw stepError ?? new Error("Could not seed canary sequence step.");
      }
      ids.sequenceStepId = step.id;

      const { data: enrollment, error: enrollmentError } = await supabase
        .from("sequence_enrollments")
        .insert({
          org_id: orgId,
          sequence_id: sequence.id,
          property_id: property.id,
          contact_id: contact.id,
          current_step_index: 0,
          status: "active",
          next_run_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        })
        .select("id")
        .single();
      if (enrollmentError || !enrollment) {
        throw enrollmentError ?? new Error("Could not seed canary enrollment.");
      }
      ids.sequenceEnrollmentId = enrollment.id;
    }

    const { error: anchorError } = await supabase.from("messages").insert({
      org_id: orgId,
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "sendillo",
      external_id: `${tag}-anchor`,
      from_address: sendilloFrom,
      to_address: phone,
      body: `${tag} outbound anchor`,
      contact_id: contact.id,
      property_id: property.id,
      metadata: { canary_anchor: tag },
    });
    if (anchorError) throw anchorError;

    const status = await fireSendilloInboundWebhook({
      data: {
        messageId: externalId,
        from: phone,
        to: sendilloFrom,
        body,
        type: "SMS",
        receivedAt: new Date().toISOString(),
      },
    });
    if (status !== 200) {
      throw new Error(`Sendillo webhook returned ${status}, expected 200.`);
    }

    const message = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("messages")
          .select(
            "id, provider, direction, status, external_id, body, property_id, contact_id, conversation_id",
          )
          .eq("external_id", externalId)
          .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        return data;
      },
      { label: `Sendillo ${mode} inbound persistence`, timeoutMs: 45_000 },
    );
    ids.messageIds.push(message.id);

    if (
      message.provider !== "sendillo" ||
      message.direction !== "inbound" ||
      message.status !== "received" ||
      message.property_id !== property.id ||
      message.contact_id !== contact.id
    ) {
      throw new Error(
        `Unexpected inbound row shape: ${JSON.stringify({
          provider: message.provider,
          direction: message.direction,
          status: message.status,
          property_id: message.property_id,
          contact_id: message.contact_id,
        })}`,
      );
    }

    if (mode === "regular") {
      const notification = await pollUntil(
        async () => {
          const { data, error } = await supabase
            .from("notifications")
            .select("id, event_type, entity_id, user_id")
            .eq("event_type", "owner_message_added")
            .eq("entity_id", message.id)
            .eq("user_id", canaryUserId);
          if (error) throw error;
          return data && data.length === 1 ? data[0] : null;
        },
        { label: "owner_message_added notification", timeoutMs: 45_000 },
      );
      if (notification.entity_id !== message.id) {
        throw new Error("owner_message_added notification targeted the wrong message.");
      }
    } else {
      const verdict = await pollUntil(
        async () => {
          const [{ data: latestConsent }, { data: contactRow }, { data: enrollmentRow }] =
            await Promise.all([
              supabase
                .from("consent_events")
                .select("id, event_type")
                .eq("contact_id", contact.id)
                .order("occurred_at", { ascending: false })
                .limit(1)
                .maybeSingle(),
              supabase
                .from("contacts")
                .select("sms_opted_out")
                .eq("id", contact.id)
                .single(),
              supabase
                .from("sequence_enrollments")
                .select("status")
                .eq("id", ids.sequenceEnrollmentId!)
                .single(),
            ]);

          if (
            latestConsent?.event_type === "opt_out" &&
            contactRow?.sms_opted_out === true &&
            (enrollmentRow?.status === "opted_out" ||
              enrollmentRow?.status === "paused")
          ) {
            return {
              consentId: latestConsent.id,
              consent: latestConsent.event_type,
              smsOptedOut: contactRow.sms_opted_out,
              enrollment: enrollmentRow.status,
            };
          }
          return null;
        },
        { label: "Sendillo STOP side effects", timeoutMs: 45_000 },
      );

      const { data: optOutRows, error: optOutError } = await supabase
        .from("consent_events")
        .select("id")
        .eq("contact_id", contact.id)
        .eq("event_type", "opt_out");
      if (optOutError) throw optOutError;
      if (optOutRows.length !== 1) {
        throw new Error(
          `Expected one opt_out row after Sendillo STOP, found ${optOutRows.length}.`,
        );
      }
      if (verdict.consent !== "opt_out" || verdict.smsOptedOut !== true) {
        throw new Error("STOP verdict was incomplete after first delivery.");
      }
    }

    const replayStatus = await fireSendilloInboundWebhook({
      data: {
        messageId: externalId,
        from: phone,
        to: sendilloFrom,
        body,
        type: "SMS",
        receivedAt: new Date().toISOString(),
      },
    });
    if (replayStatus !== 200) {
      throw new Error(`Sendillo replay returned ${replayStatus}, expected 200.`);
    }

    await pollUntil(
      async () => {
        const [{ data: messages, error: messageError }, { data: notifications, error: notificationError }] =
          await Promise.all([
            supabase
              .from("messages")
              .select("id")
              .eq("external_id", externalId),
            supabase
              .from("notifications")
              .select("id")
              .eq("event_type", "owner_message_added")
              .eq("entity_id", message.id)
              .eq("user_id", canaryUserId),
          ]);
        if (messageError) throw messageError;
        if (notificationError) throw notificationError;

        const messageCount = messages?.length ?? 0;
        const notificationCount = notifications?.length ?? 0;
        if (mode === "regular") {
          if (messageCount === 1 && notificationCount === 1) {
            return true;
          }
        } else {
          if (messageCount === 1 && notificationCount === 0) {
            return true;
          }
        }
        return null;
      },
      { label: `Sendillo ${mode} replay stability`, timeoutMs: 20_000 },
    );

    if (mode === "stop") {
      const { data: optOutRows, error: optOutError } = await supabase
        .from("consent_events")
        .select("id")
        .eq("contact_id", contact.id)
        .eq("event_type", "opt_out");
      if (optOutError) throw optOutError;
      if (optOutRows.length !== 1) {
        throw new Error(
          `Expected one opt_out row after replayed Sendillo STOP, found ${optOutRows.length}.`,
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          mode,
          status: "PASS",
          externalId,
          messageId: message.id,
          conversationId: message.conversation_id,
          propertyId: property.id,
          contactId: contact.id,
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanup(supabase, ids);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        mode,
        status: "FAIL",
        error: formatError(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
