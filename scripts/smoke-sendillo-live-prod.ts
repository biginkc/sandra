#!/usr/bin/env tsx
/**
 * Live Sendillo cutover canary.
 *
 * Modes:
 * - thread: queue + release a real outbound via Sandra's live Sendillo send
 *   path while a controlled Dialpad number replies at the same time; prove
 *   both rows land on one conversation id / one property thread.
 * - help|dnc|stop: send a real SMS from a controlled Dialpad number into
 *   Sendillo's live sender, then replay the exact captured Sendillo payload
 *   against Sandra's live route to prove idempotency.
 *
 * This is intentionally prod-only and cleans up its own seeded CRM rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { env, pollUntil, prodSupabase } from "./canary-helpers";
import type { Database, Json } from "../src/lib/supabase/types";

type Mode = "thread" | "help" | "dnc" | "stop";
type SendModule = {
  sendSmsToContact: (
    supabase: SupabaseClient<Database>,
    input: {
      contactId: string;
      propertyId: string;
      body: string;
      queueOnly?: boolean;
      metadata?: Json | null;
    },
  ) => Promise<
    | { status: "queued"; messageId: string }
    | { status: "sent"; messageId: string; externalId: string }
    | { status: string; reason?: string; error?: string }
  >;
  releaseQueuedMessage: (
    supabase: SupabaseClient<Database>,
    messageId: string,
  ) => Promise<
    | { status: "sent"; messageId: string; externalId: string }
    | { status: string; reason?: string; error?: string }
  >;
};

type CleanupIds = {
  contactId: string | null;
  propertyId: string | null;
  sequenceId: string | null;
  sequenceStepId: string | null;
  sequenceEnrollmentId: string | null;
  messageIds: string[];
  webhookExternalIds: string[];
};

type SeededEntities = {
  orgId: string;
  userId: string;
  contactId: string;
  propertyId: string;
};

type ThreadResult = {
  mode: "thread";
  tag: string;
  queuedMessageId: string;
  outboundMessageId: string;
  outboundExternalId: string;
  inboundMessageId: string;
  inboundExternalId: string;
  conversationId: string;
  propertyId: string;
  contactId: string;
  webhookEventId: string;
  dialpadMessageId: string;
};

type KeywordResult = {
  mode: "help" | "dnc" | "stop";
  tag: string;
  inboundMessageId: string;
  inboundExternalId: string;
  propertyId: string;
  contactId: string;
  conversationId: string | null;
  webhookEventId: string;
  webhookReplayStatus: number;
  dialpadMessageId: string;
  proof: Record<string, unknown>;
};

const mode = parseMode(process.env.SENDILLO_LIVE_MODE);
const ts = Date.now();
const tag = `PROD-CANARY-SENDILLO-LIVE-${mode.toUpperCase()}-${ts}`;
const sendilloFrom = requirePhone(
  env.SENDILLO_FROM_NUMBER,
  "SENDILLO_FROM_NUMBER",
);
const dialpadReplyFrom = requirePhone(
  env.DIALPAD_REPLY_FROM ?? env.DIALPAD_FROM_NUMBER ?? "+18168920833",
  "DIALPAD_REPLY_FROM",
);
const prodEmail = requireString(env.PROD_EMAIL, "PROD_EMAIL");
const dialpadApiKey = requireString(env.DIALPAD_API_KEY, "DIALPAD_API_KEY");
const prodBaseUrl = env.PROD_BASE_URL ?? "https://sandra.bmhgroupkc.com";
const keepCanaryRows = process.env.KEEP_CANARY_ROWS === "1";

async function loadSendModule(): Promise<SendModule> {
  const loaded = (await import("../src/lib/messaging/send")) as Record<
    string,
    unknown
  > & {
    default?: Record<string, unknown>;
  };
  const candidate =
    loaded.default && typeof loaded.default === "object"
      ? (loaded.default as Record<string, unknown>)
      : (loaded as Record<string, unknown>);

  const sendSmsToContact = candidate.sendSmsToContact;
  const releaseQueuedMessage = candidate.releaseQueuedMessage;
  if (
    typeof sendSmsToContact !== "function" ||
    typeof releaseQueuedMessage !== "function"
  ) {
    throw new Error("Could not load Sandra send helpers for the live canary.");
  }

  return {
    sendSmsToContact: sendSmsToContact as SendModule["sendSmsToContact"],
    releaseQueuedMessage: releaseQueuedMessage as SendModule["releaseQueuedMessage"],
  };
}

function parseMode(raw: string | undefined): Mode {
  switch ((raw ?? "thread").toLowerCase()) {
    case "thread":
    case "help":
    case "dnc":
    case "stop":
      return raw?.toLowerCase() as Mode;
    default:
      throw new Error(
        `SENDILLO_LIVE_MODE must be one of thread|help|dnc|stop. Got ${raw ?? "<missing>"}.`,
      );
  }
}

function requireString(
  value: string | undefined,
  name: string,
): string {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requirePhone(
  value: string | undefined,
  name: string,
): string {
  if (!value || !/^\+\d{10,15}$/.test(value)) {
    throw new Error(`${name} must be a valid E.164 number. Got ${value ?? "<missing>"}.`);
  }
  return value;
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
  userId: string,
): Promise<string> {
  const explicitOrgId = env.PROD_ORG_ID;
  if (explicitOrgId) return explicitOrgId;

  const { data, error } = await client
    .from("memberships")
    .select("org_id")
    .eq("user_id", userId);
  if (error) {
    throw new Error(`Could not resolve canary org membership: ${error.message}`);
  }

  const orgIds = Array.from(new Set((data ?? []).map((row) => row.org_id)));
  if (orgIds.length !== 1) {
    throw new Error(
      `Could not resolve a single production org for canary user ${userId}. Set PROD_ORG_ID explicitly.`,
    );
  }
  return orgIds[0];
}

async function seedCoreEntities(
  supabase: SupabaseClient<Database>,
  ids: CleanupIds,
): Promise<SeededEntities> {
  const userId = await resolveCanaryUserId(supabase, prodEmail);
  const orgId = await resolveOrgId(supabase, userId);

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      org_id: orgId,
      first_name: "PROD-CANARY",
      last_name: tag,
      phone_1: dialpadReplyFrom,
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
      address: `${tag} 1 Sendillo Way`,
      // Use a west-of-CT state so the live outbound canary still runs when
      // we are past 9 PM in Kansas City, without weakening Sandra's quiet-hours gate.
      state: "HI",
      status: "new_lead",
      homeowner_contact_id: contact.id,
      assigned_user_id: userId,
      ai_responder_disabled: true,
    })
    .select("id")
    .single();
  if (propertyError || !property) {
    throw propertyError ?? new Error("Could not seed canary property.");
  }
  ids.propertyId = property.id;

  return {
    orgId,
    userId,
    contactId: contact.id,
    propertyId: property.id,
  };
}

async function seedConsent(
  supabase: SupabaseClient<Database>,
  contactId: string,
): Promise<void> {
  const { error } = await supabase.from("consent_events").insert({
    contact_id: contactId,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: tag,
  });
  if (error) throw error;
}

async function seedSequenceEnrollment(
  supabase: SupabaseClient<Database>,
  ids: CleanupIds,
  orgId: string,
  contactId: string,
  propertyId: string,
): Promise<void> {
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
      property_id: propertyId,
      contact_id: contactId,
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

async function sendDialpadSms(input: {
  from: string;
  to: string;
  text: string;
}): Promise<string> {
  const response = await fetch("https://dialpad.com/api/v2/sms", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${dialpadApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from_number: input.from,
      to_numbers: [input.to],
      text: input.text,
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Dialpad ${response.status}: ${raw || response.statusText}`);
  }

  const parsed = safeParseJson(raw);
  const id =
    (parsed && typeof parsed === "object" && "id" in parsed
      ? String((parsed as Record<string, unknown>).id)
      : null) ??
    (parsed && typeof parsed === "object" && "message_id" in parsed
      ? String((parsed as Record<string, unknown>).message_id)
      : null);
  if (!id) {
    throw new Error("Dialpad send succeeded but response had no message id.");
  }
  return id;
}

async function runThreadMode(
  supabase: SupabaseClient<Database>,
  ids: CleanupIds,
): Promise<ThreadResult> {
  const send = await loadSendModule();
  const seeded = await seedCoreEntities(supabase, ids);
  await seedConsent(supabase, seeded.contactId);

  const outboundBody = `${tag} outbound`;
  const replyBody = `${tag} reply`;

  const queued = await send.sendSmsToContact(supabase, {
    contactId: seeded.contactId,
    propertyId: seeded.propertyId,
    body: outboundBody,
    queueOnly: true,
    metadata: { canary: tag, mode },
  });
  if (queued.status !== "queued") {
    throw new Error(`Expected queued outcome, got ${JSON.stringify(queued)}.`);
  }
  if (!("messageId" in queued)) {
    throw new Error("Queued outcome was missing messageId.");
  }
  const queuedMessageId = queued.messageId;
  ids.messageIds.push(queuedMessageId);

  const [release, dialpadMessageId] = await Promise.all([
    send.releaseQueuedMessage(supabase, queuedMessageId),
    sendDialpadSms({
      from: dialpadReplyFrom,
      to: sendilloFrom,
      text: replyBody,
    }),
  ]);
  if (release.status !== "sent") {
    throw new Error(`Expected sent release outcome, got ${JSON.stringify(release)}.`);
  }

  const outbound = await pollUntil(
    async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, status, provider, external_id, property_id, contact_id, conversation_id")
        .eq("id", queuedMessageId)
        .maybeSingle();
      if (error) throw error;
      if (!data || data.status !== "sent" || !data.external_id || !data.conversation_id) {
        return null;
      }
      return data;
    },
    { label: "Sendillo outbound release persistence", timeoutMs: 90_000, intervalMs: 2_000 },
  );

  const inbound = await pollUntil(
    async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, status, provider, external_id, property_id, contact_id, conversation_id")
        .eq("channel", "sms")
        .eq("direction", "inbound")
        .eq("provider", "sendillo")
        .eq("body", replyBody)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data || !data.external_id || !data.conversation_id) return null;
      return data;
    },
    { label: "Sendillo live inbound reply persistence", timeoutMs: 90_000, intervalMs: 2_000 },
  );
  ids.messageIds.push(inbound.id);
  ids.webhookExternalIds.push(inbound.external_id!);

  if (
    outbound.provider !== "sendillo" ||
    inbound.provider !== "sendillo" ||
    outbound.property_id !== seeded.propertyId ||
    inbound.property_id !== seeded.propertyId ||
    outbound.contact_id !== seeded.contactId ||
    inbound.contact_id !== seeded.contactId
  ) {
    throw new Error(
      `Unexpected message row shape: ${JSON.stringify({
        outbound,
        inbound,
      })}`,
    );
  }

  if (outbound.conversation_id !== inbound.conversation_id) {
    throw new Error(
      `Thread split detected: outbound ${outbound.conversation_id}, inbound ${inbound.conversation_id}.`,
    );
  }

  const threadRows = await pollUntil(
    async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, conversation_id")
        .in("id", [outbound.id, inbound.id]);
      if (error) throw error;
      if (!data || data.length !== 2) return null;
      const distinct = new Set(data.map((row) => row.conversation_id));
      return distinct.size === 1 ? data : null;
    },
    { label: "single conversation id across outbound + inbound", timeoutMs: 20_000, intervalMs: 1_000 },
  );
  if (threadRows.length !== 2) {
    throw new Error("Expected exactly two canary message rows on the thread.");
  }

  const webhookEvent = await pollUntil(
    async () => {
      const { data, error } = await supabase
        .from("webhook_events")
        .select("id, processing_status, external_id")
        .eq("provider", "sendillo")
        .eq("event_type", "sms_inbound")
        .eq("external_id", inbound.external_id!)
        .maybeSingle();
      if (error) throw error;
      if (!data || data.processing_status !== "processed") return null;
      return data;
    },
    { label: "processed Sendillo inbound webhook event", timeoutMs: 45_000, intervalMs: 1_000 },
  );

  return {
    mode: "thread",
    tag,
    queuedMessageId,
    outboundMessageId: outbound.id,
    outboundExternalId: outbound.external_id!,
    inboundMessageId: inbound.id,
    inboundExternalId: inbound.external_id!,
    conversationId: outbound.conversation_id!,
    propertyId: seeded.propertyId,
    contactId: seeded.contactId,
    webhookEventId: webhookEvent.id,
    dialpadMessageId,
  };
}

function keywordBody(currentMode: "help" | "dnc" | "stop"): string {
  switch (currentMode) {
    case "help":
      return "HELP";
    case "dnc":
      return `${tag} do not contact me`;
    case "stop":
      return "STOP";
  }
}

async function replaySendilloPayload(payload: Json): Promise<number> {
  const webhookSecret = requireString(
    env.SENDILLO_WEBHOOK_SECRET,
    "SENDILLO_WEBHOOK_SECRET",
  );
  const response = await fetch(`${prodBaseUrl}/api/webhooks/sendillo/sms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sendillo-webhook-secret": webhookSecret,
    },
    body: JSON.stringify(payload),
  });
  return response.status;
}

async function runKeywordMode(
  supabase: SupabaseClient<Database>,
  ids: CleanupIds,
  currentMode: "help" | "dnc" | "stop",
): Promise<KeywordResult> {
  const seeded = await seedCoreEntities(supabase, ids);
  await seedConsent(supabase, seeded.contactId);
  if (currentMode === "stop" || currentMode === "dnc") {
    await seedSequenceEnrollment(
      supabase,
      ids,
      seeded.orgId,
      seeded.contactId,
      seeded.propertyId,
    );
  }

  const body = keywordBody(currentMode);
  const dialpadMessageId = await sendDialpadSms({
    from: dialpadReplyFrom,
    to: sendilloFrom,
    text: body,
  });

  const inbound = await pollUntil(
    async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, external_id, property_id, contact_id, conversation_id")
        .eq("channel", "sms")
        .eq("direction", "inbound")
        .eq("provider", "sendillo")
        .eq("body", body)
        .eq("contact_id", seeded.contactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data?.external_id) return null;
      return data;
    },
    { label: `Sendillo ${currentMode} inbound persistence`, timeoutMs: 90_000, intervalMs: 2_000 },
  );
  ids.messageIds.push(inbound.id);
  ids.webhookExternalIds.push(inbound.external_id!);

  const webhookEvent = await pollUntil(
    async () => {
      const { data, error } = await supabase
        .from("webhook_events")
        .select("id, external_id, payload, processing_status")
        .eq("provider", "sendillo")
        .eq("event_type", "sms_inbound")
        .eq("external_id", inbound.external_id!)
        .maybeSingle();
      if (error) throw error;
      if (!data || data.processing_status !== "processed") return null;
      return data;
    },
    { label: `Sendillo ${currentMode} webhook event`, timeoutMs: 45_000, intervalMs: 1_000 },
  );

  const proof = await verifyKeywordSideEffects(
    supabase,
    currentMode,
    seeded,
    inbound.id,
  );

  const replayStatus = await replaySendilloPayload(webhookEvent.payload);
  if (replayStatus !== 200) {
    throw new Error(`Replay returned ${replayStatus}, expected 200.`);
  }

  await verifyReplayStability(
    supabase,
    currentMode,
    seeded.contactId,
    seeded.propertyId,
    inbound.id,
    inbound.external_id!,
  );

  return {
    mode: currentMode,
    tag,
    inboundMessageId: inbound.id,
    inboundExternalId: inbound.external_id!,
    propertyId: seeded.propertyId,
    contactId: seeded.contactId,
    conversationId: inbound.conversation_id,
    webhookEventId: webhookEvent.id,
    webhookReplayStatus: replayStatus,
    dialpadMessageId,
    proof,
  };
}

async function verifyKeywordSideEffects(
  supabase: SupabaseClient<Database>,
  currentMode: "help" | "dnc" | "stop",
  seeded: SeededEntities,
  inboundMessageId: string,
): Promise<Record<string, unknown>> {
  return pollUntil(
    async () => {
      const [{ data: contact }, { data: property }, { data: notifications }] =
        await Promise.all([
          supabase
            .from("contacts")
            .select("sms_opted_out")
            .eq("id", seeded.contactId)
            .single(),
          supabase
            .from("properties")
            .select("outreach_dispo")
            .eq("id", seeded.propertyId)
            .single(),
          supabase
            .from("notifications")
            .select("id")
            .eq("entity_type", "message")
            .eq("entity_id", inboundMessageId),
        ]);

      const [{ data: helpRows }, { data: optOutRows }, enrollmentResult] =
        await Promise.all([
          supabase
            .from("consent_events")
            .select("id")
            .eq("contact_id", seeded.contactId)
            .eq("event_type", "help_request"),
          supabase
            .from("consent_events")
            .select("id")
            .eq("contact_id", seeded.contactId)
            .eq("event_type", "opt_out"),
          idsHasEnrollment(seeded)
            ? supabase
                .from("sequence_enrollments")
                .select("status")
                .eq("contact_id", seeded.contactId)
                .order("enrolled_at", { ascending: false })
                .limit(1)
                .maybeSingle()
            : Promise.resolve({
                data: null as { status: string } | null,
                error: null as { message: string } | null,
              }),
        ]);
      if (enrollmentResult.error) {
        throw new Error(enrollmentResult.error.message);
      }
      const enrollment = enrollmentResult.data;

      const notificationCount = notifications?.length ?? 0;
      const helpCount = helpRows?.length ?? 0;
      const optOutCount = optOutRows?.length ?? 0;
      const enrollmentStatus = enrollment?.status ?? null;

      if (currentMode === "help") {
        if (
          contact?.sms_opted_out === false &&
          helpCount === 1 &&
          optOutCount === 0 &&
          notificationCount === 0
        ) {
          return {
            smsOptedOut: contact.sms_opted_out,
            helpRequestCount: helpCount,
            optOutCount,
            notificationCount,
          };
        }
        return null;
      }

      if (
        contact?.sms_opted_out === true &&
        optOutCount === 1 &&
        notificationCount === 0 &&
        (enrollmentStatus === "opted_out" || enrollmentStatus === "paused")
      ) {
        if (currentMode === "dnc") {
          if (property?.outreach_dispo !== "dnc") return null;
          return {
            smsOptedOut: contact.sms_opted_out,
            optOutCount,
            outreachDispo: property.outreach_dispo,
            enrollmentStatus,
            notificationCount,
          };
        }
        return {
          smsOptedOut: contact.sms_opted_out,
          optOutCount,
          enrollmentStatus,
          notificationCount,
        };
      }

      return null;
    },
    { label: `Sendillo ${currentMode} side effects`, timeoutMs: 90_000, intervalMs: 2_000 },
  );
}

function idsHasEnrollment(_seeded: SeededEntities): boolean {
  return mode === "dnc" || mode === "stop";
}

async function verifyReplayStability(
  supabase: SupabaseClient<Database>,
  currentMode: "help" | "dnc" | "stop",
  contactId: string,
  propertyId: string,
  messageId: string,
  externalId: string,
): Promise<void> {
  await pollUntil(
    async () => {
      const [{ data: messageRows }, { data: notificationRows }, { data: webhookRows }] =
        await Promise.all([
          supabase
            .from("messages")
            .select("id")
            .eq("channel", "sms")
            .eq("direction", "inbound")
            .eq("provider", "sendillo")
            .eq("external_id", externalId),
          supabase
            .from("notifications")
            .select("id")
            .eq("entity_type", "message")
            .eq("entity_id", messageId),
          supabase
            .from("webhook_events")
            .select("id")
            .eq("provider", "sendillo")
            .eq("event_type", "sms_inbound")
            .eq("external_id", externalId),
        ]);

      const [helpRows, optOutRows] = await Promise.all([
        currentMode === "help"
          ? supabase
              .from("consent_events")
              .select("id")
              .eq("contact_id", contactId)
              .eq("event_type", "help_request")
          : Promise.resolve({ data: [] as { id: string }[] }),
        currentMode === "help"
          ? Promise.resolve({ data: [] as { id: string }[] })
          : supabase
              .from("consent_events")
              .select("id")
              .eq("contact_id", contactId)
              .eq("event_type", "opt_out"),
      ]);

      if ((messageRows?.length ?? 0) !== 1) return null;
      if ((notificationRows?.length ?? 0) !== 0) return null;
      if ((webhookRows?.length ?? 0) !== 1) return null;
      if (currentMode === "help" && (helpRows.data?.length ?? 0) !== 1) return null;
      if (currentMode !== "help" && (optOutRows.data?.length ?? 0) !== 1) return null;

      if (currentMode === "dnc") {
        const { data: property } = await supabase
          .from("properties")
          .select("outreach_dispo")
          .eq("id", propertyId)
          .single();
        if (property?.outreach_dispo !== "dnc") return null;
      }

      return true;
    },
    { label: `Sendillo ${currentMode} replay stability`, timeoutMs: 30_000, intervalMs: 1_000 },
  );
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function cleanup(
  client: SupabaseClient<Database>,
  ids: CleanupIds,
): Promise<void> {
  async function runDelete(
    runner: () => Promise<{ error: { message: string } | null }>,
  ) {
    try {
      await runner();
    } catch {
      // best-effort prod cleanup
    }
  }

  if (ids.messageIds.length > 0) {
    await runDelete(async () =>
      client
        .from("notifications")
        .delete()
        .eq("entity_type", "message")
        .in("entity_id", ids.messageIds),
    );
  }
  if (ids.sequenceEnrollmentId) {
    await runDelete(async () =>
      client.from("sequence_enrollments").delete().eq("id", ids.sequenceEnrollmentId!),
    );
  }
  if (ids.sequenceStepId) {
    await runDelete(async () =>
      client.from("sequence_steps").delete().eq("id", ids.sequenceStepId!),
    );
  }
  if (ids.sequenceId) {
    await runDelete(async () =>
      client.from("sequences").delete().eq("id", ids.sequenceId!),
    );
  }
  if (ids.webhookExternalIds.length > 0) {
    await runDelete(async () =>
      client
        .from("webhook_events")
        .delete()
        .eq("provider", "sendillo")
        .eq("event_type", "sms_inbound")
        .in("external_id", ids.webhookExternalIds),
    );
  }
  if (ids.propertyId) {
    await runDelete(async () =>
      client.from("messages").delete().eq("property_id", ids.propertyId!),
    );
    await runDelete(async () =>
      client.from("properties").delete().eq("id", ids.propertyId!),
    );
  }
  if (ids.contactId) {
    await runDelete(async () =>
      client.from("consent_events").delete().eq("contact_id", ids.contactId!),
    );
    await runDelete(async () =>
      client.from("contacts").delete().eq("id", ids.contactId!),
    );
  }
}

async function main(): Promise<void> {
  const supabase = prodSupabase();
  const ids: CleanupIds = {
    contactId: null,
    propertyId: null,
    sequenceId: null,
    sequenceStepId: null,
    sequenceEnrollmentId: null,
    messageIds: [],
    webhookExternalIds: [],
  };

  try {
    const result =
      mode === "thread"
        ? await runThreadMode(supabase, ids)
        : await runKeywordMode(supabase, ids, mode);

    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (!keepCanaryRows) {
      await cleanup(supabase, ids);
    }
  }
}

main().catch((error) => {
  const formattedError =
    error instanceof Error
      ? error.message
      : (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();
  console.error(
    JSON.stringify(
      {
        status: "FAIL",
        mode,
        tag,
        error: formattedError,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
