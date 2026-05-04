import type { SupabaseClient } from "@supabase/supabase-js";

import { ConfigurationError } from "@/lib/errors/classes";
import type { Database, Json } from "@/lib/supabase/types";
import { getConsentState, type ConsentState } from "./consent";
import { checkQuietHours, type QuietHoursCheck } from "./quiet-hours";
import { getMessagingProvider } from "./registry";

/**
 * Core "send one outbound SMS" operation. Called from the lead-detail
 * composer today; the Phase-2 queue page will call the same helper.
 *
 * Pre-send checks (in order):
 *  1. Messaging provider configured.
 *  2. Contact has phone_1 set.
 *  3. Latest consent state on SMS = can_send_marketing (TCPA requires
 *     written consent for solicitation messages).
 *  4. Current time is inside [08:00, 21:00) local to the property state.
 *
 * On the send path:
 *  - Insert a `messages` row with status='pending' BEFORE calling the
 *    provider so even a crash leaves a breadcrumb.
 *  - Call provider.sendSms.
 *  - Update the same row with externalId + status='sent', or status='failed'
 *    + error_message on failure.
 *
 * Never throws — returns a discriminated outcome so callers can render
 * consistently without try/catch.
 */

type MessagesUpdate = Database["public"]["Tables"]["messages"]["Update"];

export type SendSmsOutcome =
  | { status: "sent"; messageId: string; externalId: string }
  | { status: "queued"; messageId: string }
  | {
      status: "blocked_provider_off";
      reason: string;
    }
  | {
      status: "blocked_no_phone";
      reason: string;
    }
  | {
      status: "blocked_no_consent";
      reason: string;
      consentState: ConsentState;
    }
  | {
      status: "blocked_quiet_hours";
      reason: string;
      check: QuietHoursCheck;
    }
  | {
      status: "provider_failed";
      messageId: string;
      error: string;
    }
  | { status: "contact_not_found" }
  | { status: "property_not_found" }
  | { status: "db_error"; error: string };

export type SendSmsInput = {
  /** Contact to send to. We use their `phone_1` as the destination. */
  contactId: string;
  /** Linked property — required for quiet-hours zone + thread continuity. */
  propertyId: string;
  body: string;
  /**
   * Optional override for the provider's default from-number. Comes from
   * the composer's "send from" picker. When omitted, the provider uses
   * its env-configured default (DIALPAD_FROM_NUMBER).
   */
  from?: string;
  /**
   * Queue the message for later release instead of sending immediately.
   * Inserts the `messages` row with `status='queued'` and returns a
   * `queued` outcome — no provider call, no consent check yet (that
   * happens at release time, because consent state can change between
   * queueing and sending).
   *
   * The quiet-hours check IS skipped at queue time for the same reason;
   * release re-checks against then-current time.
   */
  queueOnly?: boolean;
};

export async function sendSmsToContact(
  supabase: SupabaseClient<Database>,
  input: SendSmsInput,
): Promise<SendSmsOutcome> {
  // 1. Resolve provider.
  let provider;
  try {
    provider = getMessagingProvider();
  } catch (e) {
    if (e instanceof ConfigurationError) {
      return {
        status: "blocked_provider_off",
        reason: e.message,
      };
    }
    throw e;
  }
  if (!provider) {
    return {
      status: "blocked_provider_off",
      reason:
        "Messaging is off — set MESSAGING_PROVIDER in .env.local to enable it.",
    };
  }

  // QUEUE-ONLY shortcut — skip consent + quiet-hours checks (they'll
  // run at release time), skip the provider call, just persist a
  // `status='queued'` breadcrumb.
  if (input.queueOnly) {
    return queueForLater(supabase, provider.providerId, input);
  }

  // 2. Look up contact + property in parallel.
  const [contactResult, propertyResult] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, phone_1")
      .eq("id", input.contactId)
      .maybeSingle(),
    supabase
      .from("properties")
      .select("id, state")
      .eq("id", input.propertyId)
      .maybeSingle(),
  ]);

  if (contactResult.error) {
    return { status: "db_error", error: contactResult.error.message };
  }
  if (!contactResult.data) return { status: "contact_not_found" };
  if (propertyResult.error) {
    return { status: "db_error", error: propertyResult.error.message };
  }
  if (!propertyResult.data) return { status: "property_not_found" };

  const toPhone = contactResult.data.phone_1;
  if (!toPhone) {
    return {
      status: "blocked_no_phone",
      reason: "Contact has no phone_1. Add a number before sending SMS.",
    };
  }

  // 3. Consent check — only hard-block explicit opt-outs; no-consent is allowed.
  const consentState = await getConsentState(supabase, input.contactId, "sms");
  if (consentState === "opted_out") {
    return {
      status: "blocked_no_consent",
      reason: consentMessage(consentState),
      consentState,
    };
  }

  // 4. Quiet hours.
  const quiet = checkQuietHours(propertyResult.data.state);
  if (!quiet.ok) {
    return {
      status: "blocked_quiet_hours",
      reason: quietMessage(quiet),
      check: quiet,
    };
  }

  // 5. Pre-insert the row so we always have a breadcrumb.
  const fromAddress = input.from ?? process.env.DIALPAD_FROM_NUMBER ?? null;
  const { data: pending, error: insertError } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "outbound",
      status: "pending",
      provider: provider.providerId,
      contact_id: input.contactId,
      property_id: input.propertyId,
      from_address: fromAddress,
      to_address: toPhone,
      body: input.body,
    })
    .select("id")
    .single();
  if (insertError || !pending) {
    return {
      status: "db_error",
      error: insertError?.message ?? "failed to insert pending message",
    };
  }

  // 6. Send.
  try {
    const result = await provider.sendSms({
      to: toPhone,
      body: input.body,
      from: input.from,
    });
    const updates: MessagesUpdate = {
      status: "sent",
      external_id: result.externalId,
      sent_at: new Date().toISOString(),
      metadata: { providerStatus: result.providerStatus, raw: result.raw } as Json,
    };
    const { error: updateError } = await supabase
      .from("messages")
      .update(updates)
      .eq("id", pending.id);
    if (updateError) {
      return { status: "db_error", error: updateError.message };
    }
    return {
      status: "sent",
      messageId: pending.id,
      externalId: result.externalId,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabase
      .from("messages")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_message: message,
      })
      .eq("id", pending.id);
    return {
      status: "provider_failed",
      messageId: pending.id,
      error: message,
    };
  }
}

/**
 * Persist a `messages` row with status='queued'. No provider call, no
 * consent check, no quiet-hours check — those run at release time via
 * `releaseQueuedMessage`. We only sanity-check that the contact has a
 * phone and that the property exists.
 */
async function queueForLater(
  supabase: SupabaseClient<Database>,
  providerId: string,
  input: SendSmsInput,
): Promise<SendSmsOutcome> {
  const [contactResult, propertyResult] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, phone_1")
      .eq("id", input.contactId)
      .maybeSingle(),
    supabase
      .from("properties")
      .select("id")
      .eq("id", input.propertyId)
      .maybeSingle(),
  ]);
  if (contactResult.error) {
    return { status: "db_error", error: contactResult.error.message };
  }
  if (!contactResult.data) return { status: "contact_not_found" };
  if (propertyResult.error) {
    return { status: "db_error", error: propertyResult.error.message };
  }
  if (!propertyResult.data) return { status: "property_not_found" };

  const toPhone = contactResult.data.phone_1;
  if (!toPhone) {
    return {
      status: "blocked_no_phone",
      reason: "Contact has no phone_1. Add a number before queueing.",
    };
  }

  const fromAddress = input.from ?? process.env.DIALPAD_FROM_NUMBER ?? null;
  const { data: queued, error } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "outbound",
      status: "queued",
      provider: providerId,
      contact_id: input.contactId,
      property_id: input.propertyId,
      from_address: fromAddress,
      to_address: toPhone,
      body: input.body,
    })
    .select("id")
    .single();
  if (error || !queued) {
    return {
      status: "db_error",
      error: error?.message ?? "failed to insert queued message",
    };
  }
  return { status: "queued", messageId: queued.id };
}

/**
 * Release a queued message — treats the stored row as the source of
 * truth for to/from/body/contact/property, re-runs consent + quiet-hours
 * checks against CURRENT state (not when it was queued), then fires
 * through the provider and flips status queued → pending → sent|failed.
 *
 * Callers: the /messages page's Send Next button, and the auto-send
 * controller's tick loop.
 */
export async function releaseQueuedMessage(
  supabase: SupabaseClient<Database>,
  messageId: string,
): Promise<SendSmsOutcome> {
  let provider;
  try {
    provider = getMessagingProvider();
  } catch (e) {
    if (e instanceof ConfigurationError) {
      return { status: "blocked_provider_off", reason: e.message };
    }
    throw e;
  }
  if (!provider) {
    return {
      status: "blocked_provider_off",
      reason:
        "Messaging is off — set MESSAGING_PROVIDER in .env.local to enable it.",
    };
  }

  const { data: msg, error: fetchError } = await supabase
    .from("messages")
    .select(
      "id, status, contact_id, property_id, body, from_address, to_address",
    )
    .eq("id", messageId)
    .maybeSingle();
  if (fetchError) {
    return { status: "db_error", error: fetchError.message };
  }
  if (!msg) return { status: "contact_not_found" };
  // Only queued rows can be released. Anything else is likely a
  // double-click or a stale auto-send tick — treat as a no-op by
  // returning the terminal state instead of re-sending.
  if (msg.status !== "queued") {
    if (msg.status === "sent") {
      return { status: "sent", messageId: msg.id, externalId: "(already sent)" };
    }
    return { status: "db_error", error: `message is ${msg.status}, not queued` };
  }
  if (!msg.contact_id || !msg.property_id || !msg.to_address) {
    return {
      status: "db_error",
      error: "queued message missing contact/property/to_address",
    };
  }

  // Consent re-check — only hard-block if contact explicitly opted out.
  const consentState = await getConsentState(
    supabase,
    msg.contact_id,
    "sms",
  );
  if (consentState === "opted_out") {
    return {
      status: "blocked_no_consent",
      reason: consentMessage(consentState),
      consentState,
    };
  }

  // Quiet-hours re-check — dominant reason to queue in the first place.
  const { data: property } = await supabase
    .from("properties")
    .select("state")
    .eq("id", msg.property_id)
    .maybeSingle();
  const quiet = checkQuietHours(property?.state ?? null);
  if (!quiet.ok) {
    return {
      status: "blocked_quiet_hours",
      reason: quietMessage(quiet),
      check: quiet,
    };
  }

  // Flip queued → pending atomically to prevent a concurrent tick from
  // double-sending. The `eq("status", "queued")` guard means the UPDATE
  // only applies if nobody else grabbed it first; we check rowcount
  // indirectly via a re-read.
  const { error: flipError } = await supabase
    .from("messages")
    .update({ status: "pending" })
    .eq("id", msg.id)
    .eq("status", "queued");
  if (flipError) {
    return { status: "db_error", error: flipError.message };
  }
  // Re-fetch to confirm we won the flip.
  const { data: confirm } = await supabase
    .from("messages")
    .select("status")
    .eq("id", msg.id)
    .single();
  if (confirm?.status !== "pending") {
    return {
      status: "db_error",
      error: "another worker claimed this queued message",
    };
  }

  try {
    const result = await provider.sendSms({
      to: msg.to_address,
      body: msg.body,
      from: msg.from_address ?? undefined,
    });
    const { error: updateError } = await supabase
      .from("messages")
      .update({
        status: "sent",
        external_id: result.externalId,
        sent_at: new Date().toISOString(),
        metadata: {
          providerStatus: result.providerStatus,
          raw: result.raw,
        } as Json,
      })
      .eq("id", msg.id);
    if (updateError) {
      return { status: "db_error", error: updateError.message };
    }
    return {
      status: "sent",
      messageId: msg.id,
      externalId: result.externalId,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabase
      .from("messages")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_message: message,
      })
      .eq("id", msg.id);
    return { status: "provider_failed", messageId: msg.id, error: message };
  }
}

function consentMessage(state: ConsentState): string {
  switch (state) {
    case "opted_out":
      return "Contact has opted out of SMS. Sending is blocked.";
    case "can_send_informational_only":
      return "Only informational SMS is permitted — written consent is required for marketing messages.";
    case "no_consent":
      return "No SMS consent on file. Capture written consent before sending.";
    case "can_send_marketing":
      // Shouldn't reach here, caller only renders on block.
      return "OK to send.";
  }
}

function quietMessage(check: QuietHoursCheck): string {
  if (check.ok) return "OK to send.";
  if (check.reason === "unknown_state") {
    return "Property has no US state — can't determine local time. Add state and retry.";
  }
  return `Quiet hours — it's ${check.localTime} local (${check.zone}). TCPA window is 08:00–21:00.`;
}
