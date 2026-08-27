import type { SupabaseClient } from "@supabase/supabase-js";

import {
  findLatestAuthoritativeSmsRoute,
} from "@/lib/messages/sms-parties";
import type { AiDispositionReview } from "@/lib/messages/list-threads";
import {
  computeConsentState,
  type ConsentState,
} from "@/lib/messaging/consent";
import { resolveSmsConversationOrg } from "@/lib/messages/threading";
import { isSmsPhoneSuppressed } from "@/lib/messaging/opt-out-phone";
import {
  selectSmsPhoneByNumber,
  type SmsPhoneChoice,
} from "@/lib/messaging/sms-phone";
import type { Database } from "@/lib/supabase/types";

export type InboxDetail = {
  /** The conversation UUID — same value as `conversationId`; kept as the
   *  field name the cockpit keys selection on. */
  threadId: string;
  conversationId: string;
  contactId: string;
  contactName: string | null;
  /** Actual customer-side phone on the latest SMS in this conversation. */
  threadCustomerPhone: string | null;
  /** Actual Sandra/business-side phone on the latest SMS in this conversation. */
  threadBusinessPhone: string | null;
  /** Backward-compatible alias for threadCustomerPhone. */
  contactPhone: string | null;
  /** Saved contact phone that matches the open thread, safe for replying. */
  replyToPhone: string | null;
  /** Exact saved slot classification for the open thread phone. */
  replyToPhoneLineType: SmsPhoneChoice["lineType"] | null;
  propertyId: string | null;
  propertyAddress: string | null;
  homeownerContactId: string | null;
  agentContactId: string | null;
  /** auth.users.id of the property's current assignee, or null. */
  assigneeId: string | null;
  /** Pipeline position — used to show/hide the dispo bar. */
  propertyStatus: string | null;
  /** Current outreach disposition, if any. */
  outreachDispo: string | null;
  /** Current conversation-scoped Sandra AI disposition awaiting review. */
  aiDispositionReview: AiDispositionReview | null;
  /** Existing contact-level suppression fields. These are channel/contact
   * restrictions, not proof that the property has the permanent DNC lock. */
  contactDoNotContact: boolean;
  contactSmsOptedOut: boolean;
  /** Canonical consent-event state. Null means the authoritative read failed. */
  smsConsentState: ConsentState | null;
  /** Durable phone-level suppression. Null means the authoritative read failed. */
  phoneSuppressed: boolean | null;
  /** Convenience bit for a fail-closed operator surface. */
  smsSafetyReadFailed: boolean;
  /** The only field that makes the entire property permanently read-only. */
  isDncLocked: boolean;
  initialMessages: Database["public"]["Tables"]["messages"]["Row"][];
};

/**
 * Server-side fetch for the side-panel: latest 100 messages for a
 * conversation plus enough contact + property metadata to render the
 * composer. Takes a CANONICAL conversation UUID — stale URL formats are
 * translated upstream by `canonicalizeThreadId`. Returns null when the
 * conversation has no messages (stale URL pointing at nothing).
 */
export async function fetchInboxDetail(
  supabase: SupabaseClient<Database>,
  conversationId: string,
): Promise<InboxDetail | null> {
  const conversationOrgId = await resolveSmsConversationOrg(
    supabase,
    conversationId,
  );
  if (!conversationOrgId) return null;

  const [messagesRes, reviewRes] = await Promise.all([
    supabase
      .from("messages")
      .select("*")
      .eq("channel", "sms")
      .eq("conversation_id", conversationId)
      .eq("org_id", conversationOrgId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("ai_disposition_reviews")
      .select(
        "id, property_id, status, disposition, ai_reason, source_inbound_message_id, created_at",
      )
      .eq("org_id", conversationOrgId)
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .maybeSingle(),
  ]);
  if (messagesRes.error) {
    throw new Error(`fetchInboxDetail messages: ${messagesRes.error.message}`);
  }
  if (reviewRes.error) {
    throw new Error(`fetchInboxDetail AI review: ${reviewRes.error.message}`);
  }
  const newestMessages = messagesRes.data;
  if (!newestMessages || newestMessages.length === 0) return null;

  if (newestMessages.some((message) => message.org_id !== conversationOrgId)) {
    throw new Error(
      "fetchInboxDetail isolation: conversation spans multiple organizations",
    );
  }

  const messages = [...newestMessages].reverse();

  const contactId = messages.find(
    (message) => message.contact_id !== null,
  )?.contact_id;
  if (!contactId) return null;

  // A pending Sandra review can legitimately point at an older source message
  // outside the 100-message display window. Prefer that review's property so
  // the queue item always opens with the controls needed to resolve it.
  const propertyId =
    reviewRes.data?.property_id ??
    [...messages].reverse().find((message) => message.property_id !== null)
      ?.property_id ??
    null;
  const sourceMessageInWindow = reviewRes.data
    ? messages.find(
        (message) => message.id === reviewRes.data!.source_inbound_message_id,
      )
    : null;

  const [contactRes, propertyRes, sourceMessageRes] = await Promise.all([
    supabase
      .from("contacts")
      .select(
        "org_id, first_name, last_name, entity_name, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out",
      )
      .eq("id", contactId)
      .eq("org_id", conversationOrgId)
      .maybeSingle(),
    propertyId
      ? supabase
          .from("properties")
          .select(
            "address, city, state, homeowner_contact_id, agent_contact_id, assigned_user_id, status, outreach_dispo, is_dnc_locked",
          )
          .eq("id", propertyId)
          .eq("org_id", conversationOrgId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    reviewRes.data && !sourceMessageInWindow
      ? supabase
          .from("messages")
          .select("id, body")
          .eq("id", reviewRes.data.source_inbound_message_id)
          .eq("org_id", conversationOrgId)
          .eq("conversation_id", conversationId)
          .eq("channel", "sms")
          .eq("direction", "inbound")
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (contactRes.error) {
    throw new Error(`fetchInboxDetail contact: ${contactRes.error.message}`);
  }
  if (propertyRes.error) {
    throw new Error(`fetchInboxDetail property: ${propertyRes.error.message}`);
  }
  if (sourceMessageRes.error) {
    throw new Error(
      `fetchInboxDetail AI review source: ${sourceMessageRes.error.message}`,
    );
  }
  const c = contactRes.data;
  const p = propertyRes.data;
  const authoritativeRoute = findLatestAuthoritativeSmsRoute(messages);
  const parties = authoritativeRoute?.parties ?? {
    customerPhone: null,
    businessPhone: null,
  };
  const replyPhoneChoice = selectSmsPhoneByNumber(c, parties.customerPhone);
  const replyToPhone =
    replyPhoneChoice?.lineType === "landline"
      ? null
      : (replyPhoneChoice?.phone ?? null);
  let smsConsentState: ConsentState | null = null;
  let phoneSuppressed: boolean | null = null;
  if (c) {
    const consentResult = await supabase
      .from("consent_events")
      .select("event_type, occurred_at")
      .eq("contact_id", contactId)
      .eq("org_id", conversationOrgId)
      .eq("channel", "sms")
      .order("occurred_at", { ascending: false })
      .limit(20);
    smsConsentState = consentResult.error
      ? null
      : computeConsentState(consentResult.data ?? []);
    phoneSuppressed = parties.customerPhone
      ? await isSmsPhoneSuppressed(
          supabase,
          parties.customerPhone,
          conversationOrgId,
        )
          .then((value) => value)
          .catch(() => null)
      : false;
  }

  return {
    threadId: conversationId,
    conversationId,
    contactId,
    contactName: c
      ? (c.entity_name ??
        ([c.first_name, c.last_name].filter(Boolean).join(" ") || null))
      : null,
    threadCustomerPhone: parties.customerPhone,
    threadBusinessPhone: parties.businessPhone,
    contactPhone: parties.customerPhone,
    replyToPhone,
    replyToPhoneLineType: replyPhoneChoice?.lineType ?? null,
    propertyId,
    propertyAddress: p
      ? [p.address, p.city, p.state].filter(Boolean).join(", ")
      : null,
    homeownerContactId: p?.homeowner_contact_id ?? null,
    agentContactId: p?.agent_contact_id ?? null,
    assigneeId: p?.assigned_user_id ?? null,
    propertyStatus: p?.status ?? null,
    outreachDispo: p?.outreach_dispo ?? null,
    aiDispositionReview: reviewRes.data
      ? {
          id: reviewRes.data.id,
          status: "pending",
          disposition: reviewRes.data.disposition,
          reason: reviewRes.data.ai_reason,
          sourceInboundMessageId:
            reviewRes.data.source_inbound_message_id,
          sourceMessageBody:
            sourceMessageInWindow?.body ?? sourceMessageRes.data?.body ?? null,
          createdAt: reviewRes.data.created_at,
        }
      : null,
    contactDoNotContact: c?.do_not_contact ?? false,
    contactSmsOptedOut: c?.sms_opted_out ?? false,
    smsConsentState,
    phoneSuppressed,
    smsSafetyReadFailed: smsConsentState === null || phoneSuppressed === null,
    isDncLocked: p?.is_dnc_locked ?? false,
    initialMessages: messages,
  };
}
