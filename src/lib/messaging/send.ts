import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { ConfigurationError, ProviderError } from "@/lib/errors/classes";
import { ensureConversationIdForThread } from "@/lib/messages/threading";
import type { Database, Json } from "@/lib/supabase/types";
import { reconcileStoredStatusEvents } from "./status-events";
import { getConsentState, type ConsentState } from "./consent";
import { checkQuietHours, type QuietHoursCheck } from "./quiet-hours";
import {
  getSenderInventoryState,
  loadCampaignDeliverySettings,
  providerSupportsSenderInventory,
  type SenderInventoryState,
} from "./delivery";
import { isSmsPhoneSuppressed } from "./opt-out-phone";
import { getMessagingProvider } from "./registry";
import { selectBestSmsPhone, selectSmsPhoneByNumber } from "./sms-phone";
import { evaluateSuppression, type SuppressionDecision } from "./suppression";

/**
 * Core "send one outbound SMS" operation. Called from the lead-detail
 * composer today; the Phase-2 queue page will call the same helper.
 *
 * Pre-send checks (in order):
 *  1. Messaging provider configured.
 *  2. Contact has at least one usable saved phone.
 *  3. Latest consent state on SMS is not an explicit opt-out.
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

const LANDLINE_BLOCK_REASON =
  "Contact only has landline numbers — SMS can't be delivered. Call or mail instead.";
export const PROVIDER_PENDING_STALE_MS = 15 * 60_000;
const PROVIDER_TRANSIENT_DEFER_MS = 5 * 60_000;
const PROVIDER_TRANSIENT_MAX_DEFER_ATTEMPTS = 3;

export type SendSmsOutcome =
  | { status: "sent"; messageId: string; externalId: string }
  | { status: "queued"; messageId: string }
  | { status: "paused"; messageId: string }
  | {
      status: "blocked_provider_off";
      reason: string;
    }
  | {
      status: "blocked_no_phone";
      reason: string;
    }
  | {
      status: "blocked_landline";
      reason: string;
    }
  | {
      status: "blocked_terminal_dispo";
      reason: string;
      source: Extract<SuppressionDecision, { suppressed: true }>["source"];
      outreachDispo?: string | null;
      consentState?: ConsentState | null;
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
      status: "blocked_not_due";
      messageId: string;
      retryAt: string;
    }
  | {
      status: "blocked_campaign_paused";
      messageId?: string;
      reason: string;
    }
  | {
      status: "provider_failed";
      messageId: string;
      error: string;
    }
  | {
      status: "provider_deferred";
      messageId: string;
      error: string;
      attempt: number;
      retryAt: string;
    }
  | { status: "contact_not_found" }
  | { status: "property_not_found" }
  | { status: "db_error"; error: string };

export type SendSmsInput = {
  /** Contact to send to. We prefer a saved mobile across phone_1/2/3. */
  contactId: string;
  /** Linked property — required for quiet-hours zone + thread continuity. */
  propertyId: string;
  body: string;
  /**
   * Optional explicit from-number. Inventory-aware providers validate this
   * against the approved sender catalog before any provider call.
   */
  from?: string;
  /**
   * Optional override for the recipient phone. Used by Messages when the
   * visible conversation is on a saved secondary contact phone. The value
   * must match phone_1/2/3 or the send is blocked before provider use.
   */
  to?: string;
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
  scheduledFor?: Date | null;
  metadata?: Json | null;
  campaignId?: string | null;
  /**
   * Reply/automation paths must be sender-sticky: prior inbound business
   * number, then campaign Delivery snapshot, then fail instead of falling
   * back to a provider/env default.
   */
  requireStickyFrom?: boolean;
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

  const campaignPause = await blockIfCampaignPaused(
    supabase,
    input.campaignId,
  );
  if (campaignPause) return campaignPause;

  // 2. Look up contact + property in parallel.
  const [contactResult, propertyResult] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out")
      .eq("id", input.contactId)
      .maybeSingle(),
    supabase
      .from("properties")
      .select("id, org_id, state, outreach_dispo")
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

  const consentState = await getConsentState(supabase, input.contactId, "sms");
  const suppression = evaluateSuppression({
    outreachDispo: propertyResult.data.outreach_dispo,
    consentState,
    doNotContact: contactResult.data.do_not_contact,
    smsOptedOut: contactResult.data.sms_opted_out,
  });
  if (suppression.suppressed) {
    return blockedTerminalDispo(suppression);
  }

  const destination = input.to
    ? selectSmsPhoneByNumber(contactResult.data, input.to)
    : selectBestSmsPhone(contactResult.data);
  if (!destination) {
    return {
      status: "blocked_no_phone",
      reason: input.to
        ? "Selected thread phone is not saved on this contact. Resolve the contact phone before replying."
        : "Contact has no phone number. Add one before sending SMS.",
    };
  }
  if (destination.lineType === "landline") {
    return { status: "blocked_landline", reason: LANDLINE_BLOCK_REASON };
  }
  try {
    if (
      await isSmsPhoneSuppressed(
        supabase,
        destination.phone,
        propertyResult.data.org_id,
      )
    ) {
      return blockedTerminalDispo({
        suppressed: true,
        source: "phone_suppression",
        outreachDispo: propertyResult.data.outreach_dispo,
        consentState,
        reason: "Phone number is suppressed from SMS.",
      });
    }
  } catch (e) {
    return {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // 3. Consent check — only hard-block explicit opt-outs; no-consent is allowed.
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
  let conversationId: string;
  try {
    conversationId = await ensureConversationIdForThread(
      supabase,
      input.contactId,
      input.propertyId,
    );
  } catch (e) {
    return {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const normalizedToPhone = normalizePhone(destination.phone) ?? destination.phone;
  const fromResolution = await resolveOutboundFromAddress(supabase, {
    provider,
    orgId: propertyResult.data.org_id,
    contactId: input.contactId,
    propertyId: input.propertyId,
    toAddress: normalizedToPhone,
    explicitFrom: input.from,
    campaignId: input.campaignId,
    requireStickyFrom: input.requireStickyFrom ?? false,
  });
  if (!fromResolution.ok) return fromResolution.outcome;
  const fromAddress = fromResolution.fromAddress;
  const inputMetadata =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : null;
  const pendingAt = new Date().toISOString();
  const { data: pending, error: insertError } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "outbound",
      status: "pending",
      provider: provider.providerId,
      campaign_id: input.campaignId ?? null,
      contact_id: input.contactId,
      property_id: input.propertyId,
      conversation_id: conversationId,
      from_address: fromAddress,
      to_address: normalizedToPhone,
      body: input.body,
      metadata: {
        ...(inputMetadata ?? {}),
        providerAttempt: {
          pendingAt,
          maxPendingMs: PROVIDER_PENDING_STALE_MS,
        },
      } as Json,
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
      to: destination.phone,
      body: input.body,
      from: fromAddress ?? undefined,
    });
    const updates: MessagesUpdate = {
      status: "sent",
      external_id: result.externalId,
      sent_at: new Date().toISOString(),
      metadata: {
        ...(inputMetadata ?? {}),
        providerStatus: result.providerStatus,
        raw: result.raw,
      } as Json,
    };
    const { error: updateError } = await supabase
      .from("messages")
      .update(updates)
      .eq("id", pending.id);
    if (updateError) {
      return { status: "db_error", error: updateError.message };
    }
    await reconcileStoredStatusEvents(
      supabase,
      provider.providerId,
      result.externalId,
    );
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
        metadata: {
          ...(inputMetadata ?? {}),
          providerAttempt: {
            pendingAt,
            maxPendingMs: PROVIDER_PENDING_STALE_MS,
            terminal: true,
          },
        } as Json,
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
  const [contactResult, propertyResult, consentState] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out")
      .eq("id", input.contactId)
      .maybeSingle(),
    supabase
      .from("properties")
      .select("id, org_id, outreach_dispo")
      .eq("id", input.propertyId)
      .maybeSingle(),
    getConsentState(supabase, input.contactId, "sms"),
  ]);
  if (contactResult.error) {
    return { status: "db_error", error: contactResult.error.message };
  }
  if (!contactResult.data) return { status: "contact_not_found" };
  if (propertyResult.error) {
    return { status: "db_error", error: propertyResult.error.message };
  }
  if (!propertyResult.data) return { status: "property_not_found" };

  const suppression = evaluateSuppression({
    outreachDispo: propertyResult.data.outreach_dispo,
    consentState,
    doNotContact: contactResult.data.do_not_contact,
    smsOptedOut: contactResult.data.sms_opted_out,
  });
  if (suppression.suppressed) {
    return blockedTerminalDispo(suppression);
  }

  const destination = input.to
    ? selectSmsPhoneByNumber(contactResult.data, input.to)
    : selectBestSmsPhone(contactResult.data);
  if (!destination) {
    return {
      status: "blocked_no_phone",
      reason: input.to
        ? "Selected thread phone is not saved on this contact. Resolve the contact phone before queueing."
        : "Contact has no phone number. Add one before queueing.",
    };
  }
  if (destination.lineType === "landline") {
    return { status: "blocked_landline", reason: LANDLINE_BLOCK_REASON };
  }
  try {
    if (
      await isSmsPhoneSuppressed(
        supabase,
        destination.phone,
        propertyResult.data.org_id,
      )
    ) {
      return blockedTerminalDispo({
        suppressed: true,
        source: "phone_suppression",
        outreachDispo: propertyResult.data.outreach_dispo,
        consentState,
        reason: "Phone number is suppressed from SMS.",
      });
    }
  } catch (e) {
    return {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  let conversationId: string;
  try {
    conversationId = await ensureConversationIdForThread(
      supabase,
      input.contactId,
      input.propertyId,
    );
  } catch (e) {
    return {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const normalizedToPhone = normalizePhone(destination.phone) ?? destination.phone;
  const provider = getMessagingProvider();
  if (!provider || provider.providerId !== providerId) {
    return {
      status: "blocked_provider_off",
      reason: "Messaging provider changed while queueing this SMS.",
    };
  }
  const fromResolution = await resolveOutboundFromAddress(supabase, {
    provider,
    orgId: propertyResult.data.org_id,
    contactId: input.contactId,
    propertyId: input.propertyId,
    toAddress: normalizedToPhone,
    explicitFrom: input.from,
    campaignId: input.campaignId,
    requireStickyFrom: input.requireStickyFrom ?? false,
  });
  if (!fromResolution.ok) return fromResolution.outcome;
  const fromAddress = fromResolution.fromAddress;
  const campaignPause = await campaignIsPaused(supabase, input.campaignId);
  if (campaignPause.error) {
    return { status: "db_error", error: campaignPause.error };
  }
  const queuedStatus = campaignPause.paused ? "paused" : "queued";
  const scheduledFor = input.scheduledFor?.toISOString() ?? null;
  const { data: queued, error } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "outbound",
      status: queuedStatus,
      provider: providerId,
      campaign_id: input.campaignId ?? null,
      contact_id: input.contactId,
      property_id: input.propertyId,
      conversation_id: conversationId,
      from_address: fromAddress,
      to_address: normalizedToPhone,
      body: input.body,
      scheduled_for: campaignPause.paused ? null : scheduledFor,
      metadata: campaignPause.paused
        ? addCampaignPauseMetadata(
            input.metadata ?? null,
            new Date().toISOString(),
            scheduledFor,
          )
        : input.metadata ?? null,
    })
    .select("id")
    .single();
  if (error || !queued) {
    return {
      status: "db_error",
      error: error?.message ?? "failed to insert queued message",
    };
  }
  return { status: queuedStatus, messageId: queued.id };
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
      "id, status, provider, org_id, campaign_id, contact_id, property_id, body, from_address, to_address, scheduled_for, metadata",
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
  const campaignPause = await pauseQueuedMessageIfCampaignPaused(
    supabase,
    msg.id,
    msg.campaign_id,
    msg.metadata,
    msg.scheduled_for,
  );
  if (campaignPause) return campaignPause;
  if (msg.scheduled_for && new Date(msg.scheduled_for).getTime() > Date.now()) {
    return {
      status: "blocked_not_due",
      messageId: msg.id,
      retryAt: msg.scheduled_for,
    };
  }
  if (!msg.contact_id || !msg.property_id || !msg.to_address) {
    return {
      status: "db_error",
      error: "queued message missing contact/property/to_address",
    };
  }
  if (msg.provider !== provider.providerId) {
    const error =
      `queued message belongs to provider ${msg.provider ?? "unknown"}, current provider is ${provider.providerId}`;
    await failQueuedMessage(supabase, msg.id, error);
    return {
      status: "db_error",
      error,
    };
  }
  // Sender guard: the row must send from the sender it was queued with,
  // and that sender must be in the synced approved inventory — never an
  // env-default fallback. Unknown/inactive senders fail the row loudly;
  // empty/never-synced inventory is deferred so first deploys do not
  // terminally kill every queued row before the first catalog sync.
  if (providerSupportsSenderInventory(provider)) {
    if (!msg.from_address) {
      const error =
        `queued message is missing from_address; Delivery sender is required for provider ${provider.providerId}`;
      return deferQueuedMessage(supabase, msg.id, error, msg.metadata);
    }

    let inventory: SenderInventoryState;
    try {
      inventory = await getSenderInventoryState(
        supabase,
        msg.org_id,
        provider.providerId,
        msg.from_address,
      );
    } catch (e) {
      return {
        status: "db_error",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if (inventory.state !== "approved") {
      if (inventory.state === "empty") {
        const error =
          `queued message sender ${msg.from_address} is blocked because no approved sender inventory has been synced for provider ${provider.providerId}`;
        return deferQueuedMessage(supabase, msg.id, error, msg.metadata);
      }
      const senderState =
        inventory.state === "inactive" ? "no longer active" : "not";
      const error =
        `queued message sender ${msg.from_address} is ${senderState} ` +
        `in the approved ${provider.providerId} sender inventory`;
      await failQueuedMessage(supabase, msg.id, error);
      return {
        status: "db_error",
        error,
      };
    }
  }

  // Line-type re-check — a number can get classified landline between
  // queue and release (cache backfill, lookup providers), and slot
  // promotion can move a queued-to landline OUT of phone_1 (slot 2/3),
  // so the destination must be checked against EVERY current slot, not
  // just slot 1. Fail permanently rather than blocking so the auto-send
  // tick doesn't retry it forever.
  const [consentState, releaseContactResult, propertyResult] = await Promise.all([
    getConsentState(supabase, msg.contact_id, "sms"),
    supabase
      .from("contacts")
      .select(
        "phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out",
      )
      .eq("id", msg.contact_id)
      .maybeSingle(),
    supabase
      .from("properties")
      .select("org_id, state, outreach_dispo")
      .eq("id", msg.property_id)
      .maybeSingle(),
  ]);
  if (releaseContactResult.error) {
    return { status: "db_error", error: releaseContactResult.error.message };
  }
  if (propertyResult.error) {
    return { status: "db_error", error: propertyResult.error.message };
  }

  const suppression = evaluateSuppression({
    outreachDispo: propertyResult.data?.outreach_dispo ?? null,
    consentState,
    doNotContact: releaseContactResult.data?.do_not_contact ?? null,
    smsOptedOut: releaseContactResult.data?.sms_opted_out ?? null,
  });
  if (suppression.suppressed) {
    const outcome = blockedTerminalDispo(suppression);
    await failQueuedMessage(supabase, msg.id, outcome.reason);
    return outcome;
  }
  try {
    if (
      await isSmsPhoneSuppressed(
        supabase,
        msg.to_address,
        propertyResult.data?.org_id ?? msg.org_id,
      )
    ) {
      const outcome = blockedTerminalDispo({
        suppressed: true,
        source: "phone_suppression",
        outreachDispo: propertyResult.data?.outreach_dispo ?? null,
        consentState,
        reason: "Phone number is suppressed from SMS.",
      });
      await failQueuedMessage(supabase, msg.id, outcome.reason);
      return outcome;
    }
  } catch (e) {
    return {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (consentState === "opted_out") {
    await failQueuedMessage(supabase, msg.id, consentMessage(consentState));
    return {
      status: "blocked_no_consent",
      reason: consentMessage(consentState),
      consentState,
    };
  }

  const releaseContact = releaseContactResult.data;
  if (releaseContact) {
    const slots: [string | null, string][] = [
      [releaseContact.phone_1, releaseContact.phone_1_type],
      [releaseContact.phone_2, releaseContact.phone_2_type],
      [releaseContact.phone_3, releaseContact.phone_3_type],
    ];
    const destinationIsLandline = slots.some(
      ([number, type]) =>
        type === "landline" &&
        number &&
        (normalizePhone(number) ?? number) === msg.to_address,
    );
    if (destinationIsLandline) {
      await failQueuedMessage(supabase, msg.id, LANDLINE_BLOCK_REASON);
      return { status: "blocked_landline", reason: LANDLINE_BLOCK_REASON };
    }
  }

  // Quiet-hours re-check — dominant reason to queue in the first place.
  const quiet = checkQuietHours(propertyResult.data?.state ?? null);
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
  const currentMetadata =
    msg.metadata && typeof msg.metadata === "object" && !Array.isArray(msg.metadata)
      ? msg.metadata
      : null;
  const pendingAt = new Date().toISOString();
  const { data: claimed, error: flipError } = await supabase
    .from("messages")
    .update({
      status: "pending",
      metadata: {
        ...(currentMetadata ?? {}),
        providerAttempt: {
          pendingAt,
          maxPendingMs: PROVIDER_PENDING_STALE_MS,
        },
      } as Json,
    })
    .eq("id", msg.id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (flipError) {
    return { status: "db_error", error: flipError.message };
  }
  if (!claimed) {
    return {
      status: "db_error",
      error: "another worker claimed this queued message",
    };
  }

  const postClaimPause = await campaignIsPaused(supabase, msg.campaign_id);
  if (postClaimPause.error) {
    return { status: "db_error", error: postClaimPause.error };
  }
  if (postClaimPause.paused) {
    const { error: pauseClaimedError } = await supabase
      .from("messages")
      .update({
        status: "paused",
        scheduled_for: null,
        metadata: addCampaignPauseMetadata(
          {
            ...(currentMetadata ?? {}),
            providerAttempt: {
              pendingAt,
              maxPendingMs: PROVIDER_PENDING_STALE_MS,
            },
          } as Json,
          new Date().toISOString(),
          msg.scheduled_for,
        ),
      })
      .eq("id", msg.id)
      .eq("status", "pending");
    if (pauseClaimedError) {
      return { status: "db_error", error: pauseClaimedError.message };
    }
    return {
      status: "blocked_campaign_paused",
      messageId: msg.id,
      reason: "Campaign sends were paused before this SMS reached the provider. It was held until the campaign is resumed.",
    };
  }

  try {
    // Accepted race: an operator-triggered catalog sync can deactivate this
    // sender in the milliseconds after validation and before the provider call.
    // The queued row keeps the exact sender snapshot for audit/retry review.
    const result = await provider.sendSms({
      to: msg.to_address,
      body: msg.body,
      from: msg.from_address ?? undefined,
    });
    const { data: updated, error: updateError } = await supabase
      .from("messages")
      .update({
        status: "sent",
        external_id: result.externalId,
        sent_at: new Date().toISOString(),
        failed_at: null,
        error_message: null,
        metadata: {
          ...(currentMetadata ?? {}),
          providerStatus: result.providerStatus,
          raw: result.raw,
        } as Json,
      })
      .eq("id", msg.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (updateError) {
      return { status: "db_error", error: updateError.message };
    }
    if (!updated) {
      return {
        status: "db_error",
        error: "queued message changed while marking sent",
      };
    }
    await reconcileStoredStatusEvents(
      supabase,
      provider.providerId,
      result.externalId,
    );
    return {
      status: "sent",
      messageId: msg.id,
      externalId: result.externalId,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const retry = buildProviderRetryUpdate(e, currentMetadata);
    if (retry.defer) {
      const pauseForRetry = await campaignIsPaused(supabase, msg.campaign_id);
      if (pauseForRetry.error) {
        return { status: "db_error", error: pauseForRetry.error };
      }
      const retryMetadata = pauseForRetry.paused
        ? addCampaignPauseMetadata(
            retry.metadata,
            new Date().toISOString(),
            retry.retryAt,
          )
        : retry.metadata;
      const { data: deferred, error: deferError } = await supabase
        .from("messages")
        .update({
          status: pauseForRetry.paused ? "paused" : "queued",
          scheduled_for: pauseForRetry.paused ? null : retry.retryAt,
          error_message: message,
          metadata: retryMetadata,
        })
        .eq("id", msg.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (deferError) {
        return { status: "db_error", error: deferError.message };
      }
      if (!deferred) {
        return {
          status: "db_error",
          error: "queued message changed while scheduling provider retry",
        };
      }
      return {
        status: "provider_deferred",
        messageId: msg.id,
        error: message,
        attempt: retry.attempt,
        retryAt: retry.retryAt,
      };
    }

    const { data: failed, error: failError } = await supabase
      .from("messages")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_message: retry.errorMessage,
        metadata: retry.metadata,
      })
      .eq("id", msg.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (failError) {
      return { status: "db_error", error: failError.message };
    }
    if (!failed) {
      return {
        status: "db_error",
        error: "queued message changed while marking provider failure",
      };
    }
    return { status: "provider_failed", messageId: msg.id, error: message };
  }
}

function readMetadataRecord(metadata: Json | null): Record<string, unknown> | null {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : null;
}

function addCampaignPauseMetadata(
  metadata: Json | null,
  pausedAt: string,
  previousScheduledFor: string | null,
): Json {
  const baseMetadata = readMetadataRecord(metadata) ?? {};
  return {
    ...baseMetadata,
    campaignPause: {
      pausedAt,
      previousScheduledFor,
      reason: "operator_pause",
    },
  } as Json;
}

async function campaignIsPaused(
  supabase: SupabaseClient<Database>,
  campaignId: string | null | undefined,
): Promise<{ paused: boolean; error: string | null }> {
  if (!campaignId) return { paused: false, error: null };
  const { data, error } = await supabase
    .from("campaigns")
    .select("status")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) return { paused: false, error: error.message };
  return { paused: data?.status === "paused", error: null };
}

async function blockIfCampaignPaused(
  supabase: SupabaseClient<Database>,
  campaignId: string | null | undefined,
): Promise<Extract<SendSmsOutcome, { status: "blocked_campaign_paused" | "db_error" }> | null> {
  const paused = await campaignIsPaused(supabase, campaignId);
  if (paused.error) return { status: "db_error", error: paused.error };
  if (!paused.paused) return null;
  return {
    status: "blocked_campaign_paused",
    reason: "Campaign sends are paused. Resume the campaign before sending or queueing more SMS.",
  };
}

async function pauseQueuedMessageIfCampaignPaused(
  supabase: SupabaseClient<Database>,
  messageId: string,
  campaignId: string | null,
  metadata: Json | null,
  previousScheduledFor: string | null,
): Promise<Extract<SendSmsOutcome, { status: "blocked_campaign_paused" | "db_error" | "sent" }> | null> {
  const paused = await campaignIsPaused(supabase, campaignId);
  if (paused.error) return { status: "db_error", error: paused.error };
  if (!paused.paused) return null;

  const { error } = await supabase
    .from("messages")
    .update({
      status: "paused",
      scheduled_for: null,
      metadata: addCampaignPauseMetadata(
        metadata,
        new Date().toISOString(),
        previousScheduledFor,
      ),
    })
    .eq("id", messageId)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (error) return { status: "db_error", error: error.message };

  const { data: latest, error: latestError } = await supabase
    .from("messages")
    .select("id, status, external_id")
    .eq("id", messageId)
    .maybeSingle();
  if (latestError) return { status: "db_error", error: latestError.message };
  if (latest?.status === "sent") {
    return {
      status: "sent",
      messageId,
      externalId: latest.external_id ?? "(already sent)",
    };
  }
  if (latest?.status === "pending") {
    return {
      status: "db_error",
      error: "queued message was already claimed before it could be paused",
    };
  }

  return {
    status: "blocked_campaign_paused",
    messageId,
    reason: "Campaign sends are paused. This queued SMS was held until the campaign is resumed.",
  };
}

function buildProviderRetryUpdate(
  error: unknown,
  currentMetadata: Record<string, unknown> | null,
):
  | {
      defer: true;
      attempt: number;
      retryAt: string;
      metadata: Json;
    }
  | {
      defer: false;
      errorMessage: string;
      metadata: Json;
    } {
  const message = error instanceof Error ? error.message : String(error);
  const previous = readProviderRetryMetadata(currentMetadata);
  const transient = isTransientProviderError(error);
  const attempt = previous.attempts + 1;
  const now = new Date();
  const baseMetadata = currentMetadata ?? {};
  const providerRetry = {
    attempts: attempt,
    lastError: message,
    lastAttemptAt: now.toISOString(),
    transient,
    maxDeferAttempts: PROVIDER_TRANSIENT_MAX_DEFER_ATTEMPTS,
  };

  if (transient && attempt <= PROVIDER_TRANSIENT_MAX_DEFER_ATTEMPTS) {
    const retryAt = new Date(
      now.getTime() + PROVIDER_TRANSIENT_DEFER_MS * attempt,
    ).toISOString();
    return {
      defer: true,
      attempt,
      retryAt,
      metadata: {
        ...baseMetadata,
        providerRetry: {
          ...providerRetry,
          nextRetryAt: retryAt,
        },
      } as Json,
    };
  }

  return {
    defer: false,
    errorMessage:
      transient && attempt > PROVIDER_TRANSIENT_MAX_DEFER_ATTEMPTS
        ? `${message} (provider retry cap reached after ${previous.attempts} deferred attempts).`
        : message,
    metadata: {
      ...baseMetadata,
      providerRetry: {
        ...providerRetry,
        terminal: true,
      },
    } as Json,
  };
}

function readProviderRetryMetadata(
  metadata: Record<string, unknown> | null,
): { attempts: number } {
  const retry = metadata?.providerRetry;
  if (!retry || typeof retry !== "object" || Array.isArray(retry)) {
    return { attempts: 0 };
  }
  const attempts = (retry as Record<string, unknown>).attempts;
  return {
    attempts:
      typeof attempts === "number" && Number.isInteger(attempts) ? attempts : 0,
  };
}

function isTransientProviderError(error: unknown): boolean {
  if (error instanceof ProviderError) {
    const status = error.details?.status;
    if (
      typeof status === "number" &&
      (status === 408 || status === 425 || status === 429 || status >= 500)
    ) {
      return true;
    }
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    /carrier blocked|unknown recipient|unknown number|invalid (recipient|phone|number)|opted out|unsubscribed/.test(
      message,
    )
  ) {
    return false;
  }
  return /\b429\b|rate limit|too many requests|timeout|timed out|abort|network|fetch failed|econn|etimedout|temporar|5\d\d/.test(
    message,
  );
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

function blockedTerminalDispo(
  decision: Extract<SuppressionDecision, { suppressed: true }>,
): Extract<SendSmsOutcome, { status: "blocked_terminal_dispo" }> {
  return {
    status: "blocked_terminal_dispo",
    reason: decision.reason,
    source: decision.source,
    outreachDispo: decision.outreachDispo ?? null,
    consentState: decision.consentState ?? null,
  };
}

type ResolvedProvider = NonNullable<ReturnType<typeof getMessagingProvider>>;

type ResolveFromArgs = {
  provider: ResolvedProvider;
  orgId: string;
  contactId: string;
  propertyId: string;
  toAddress: string;
  explicitFrom?: string | null;
  campaignId?: string | null;
  requireStickyFrom: boolean;
};

type ResolveFromResult =
  | { ok: true; fromAddress: string | null }
  | { ok: false; outcome: SendSmsOutcome };

async function resolveOutboundFromAddress(
  supabase: SupabaseClient<Database>,
  args: ResolveFromArgs,
): Promise<ResolveFromResult> {
  const supportsInventory = providerSupportsSenderInventory(args.provider);
  let fromAddress: string | null = null;

  if (args.explicitFrom && args.explicitFrom.trim()) {
    fromAddress = normalizePhone(args.explicitFrom) ?? args.explicitFrom.trim();
  } else {
    try {
      fromAddress = await loadLatestInboundBusinessNumber(supabase, {
        contactId: args.contactId,
        propertyId: args.propertyId,
        toAddress: args.toAddress,
      });
    } catch (e) {
      return {
        ok: false,
        outcome: {
          status: "db_error",
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }

    if (!fromAddress && args.campaignId) {
      try {
        const delivery = await loadCampaignDeliverySettings(
          supabase,
          args.campaignId,
        );
        fromAddress = delivery.fromAddress ?? delivery.senderNumber;
      } catch (e) {
        return {
          ok: false,
          outcome: {
            status: "db_error",
            error: e instanceof Error ? e.message : String(e),
          },
        };
      }
    }

    if (!fromAddress && (!args.requireStickyFrom || !supportsInventory)) {
      const fallback = args.provider.getDefaultFromNumber?.() ?? null;
      fromAddress = fallback ? normalizePhone(fallback) ?? fallback : null;
    }
  }

  if (supportsInventory) {
    if (!fromAddress) {
      return {
        ok: false,
        outcome: {
          status: "db_error",
          error:
            "No sticky sending number found for this SMS. Reply from the business number the contact last texted, choose an approved sender, or configure campaign Delivery.",
        },
      };
    }

    let inventory: SenderInventoryState;
    try {
      inventory = await getSenderInventoryState(
        supabase,
        args.orgId,
        args.provider.providerId,
        fromAddress,
      );
    } catch (e) {
      return {
        ok: false,
        outcome: {
          status: "db_error",
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
    if (inventory.state !== "approved") {
      const detail =
        inventory.state === "empty"
          ? "no approved sender inventory has been synced"
          : inventory.state === "inactive"
            ? "the sender is no longer active"
            : "the sender is not in the approved sender inventory";
      return {
        ok: false,
        outcome: {
          status: "db_error",
          error: `Cannot send from ${fromAddress}: ${detail} for provider ${args.provider.providerId}.`,
        },
      };
    }
  }

  return { ok: true, fromAddress };
}

async function loadLatestInboundBusinessNumber(
  supabase: SupabaseClient<Database>,
  args: {
    contactId: string;
    propertyId: string;
    toAddress: string;
  },
): Promise<string | null> {
  const normalizedTo = normalizePhone(args.toAddress) ?? args.toAddress;
  let query = supabase
    .from("messages")
    .select("to_address")
    .eq("channel", "sms")
    .eq("direction", "inbound")
    .eq("contact_id", args.contactId)
    .eq("property_id", args.propertyId)
    .not("to_address", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (normalizedTo) {
    query = query.eq("from_address", normalizedTo);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`latest inbound sender lookup failed: ${error.message}`);
  }
  const raw = data?.[0]?.to_address ?? null;
  return raw ? normalizePhone(raw) ?? raw : null;
}

/**
 * Terminal-fail a queued message (status-guarded so a row another
 * worker claimed or sent is never touched). Exported for the
 * sequence-tick cron, which fails opted-out rows instead of leaving
 * them eternally queued.
 */
export async function failQueuedMessage(
  supabase: SupabaseClient<Database>,
  messageId: string,
  errorMessage: string,
): Promise<void> {
  await supabase
    .from("messages")
    .update({
      status: "failed",
      failed_at: new Date().toISOString(),
      error_message: errorMessage,
    })
    .eq("id", messageId)
    .eq("status", "queued");
}

async function deferQueuedMessage(
  supabase: SupabaseClient<Database>,
  messageId: string,
  errorMessage: string,
  metadata: Json | null,
): Promise<Extract<SendSmsOutcome, { status: "provider_deferred" | "db_error" }>> {
  const retryAt = new Date(Date.now() + PROVIDER_TRANSIENT_DEFER_MS).toISOString();
  const currentMetadata = readMetadataRecord(metadata) ?? {};
  const { error } = await supabase
    .from("messages")
    .update({
      status: "queued",
      scheduled_for: retryAt,
      error_message: errorMessage,
      metadata: {
        ...currentMetadata,
        senderGuard: {
          deferredAt: new Date().toISOString(),
          reason: errorMessage,
          nextRetryAt: retryAt,
        },
      } as Json,
    })
    .eq("id", messageId)
    .eq("status", "queued");
  if (error) return { status: "db_error", error: error.message };
  return {
    status: "provider_deferred",
    messageId,
    error: errorMessage,
    attempt: 0,
    retryAt,
  };
}
