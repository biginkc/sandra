import type { SupabaseClient } from "@supabase/supabase-js";

import {
  deriveSmsParties,
  findMatchingSavedContactPhone,
} from "@/lib/messages/sms-parties";
import {
  computeConsentState,
  type ConsentState,
} from "@/lib/messaging/consent";
import { resolveSmsConversationOrg } from "@/lib/messages/threading";
import { isSmsPhoneSuppressed } from "@/lib/messaging/opt-out-phone";
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

  const { data: newestMessages, error } = await supabase
    .from("messages")
    .select("*")
    .eq("channel", "sms")
    .eq("conversation_id", conversationId)
    .eq("org_id", conversationOrgId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    throw new Error(`fetchInboxDetail messages: ${error.message}`);
  }
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

  const propertyId =
    [...messages].reverse().find((message) => message.property_id !== null)
      ?.property_id ?? null;

  const [contactRes, propertyRes] = await Promise.all([
    supabase
      .from("contacts")
      .select(
        "org_id, first_name, last_name, entity_name, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out",
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
  ]);

  if (contactRes.error) {
    throw new Error(`fetchInboxDetail contact: ${contactRes.error.message}`);
  }
  if (propertyRes.error) {
    throw new Error(`fetchInboxDetail property: ${propertyRes.error.message}`);
  }

  const c = contactRes.data;
  const p = propertyRes.data;
  const latestMessage = messages[messages.length - 1];
  const parties = deriveSmsParties(latestMessage);
  const replyToPhone = findMatchingSavedContactPhone(c, parties.customerPhone);
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
    propertyId,
    propertyAddress: p
      ? [p.address, p.city, p.state].filter(Boolean).join(", ")
      : null,
    homeownerContactId: p?.homeowner_contact_id ?? null,
    agentContactId: p?.agent_contact_id ?? null,
    assigneeId: p?.assigned_user_id ?? null,
    propertyStatus: p?.status ?? null,
    outreachDispo: p?.outreach_dispo ?? null,
    contactDoNotContact: c?.do_not_contact ?? false,
    contactSmsOptedOut: c?.sms_opted_out ?? false,
    smsConsentState,
    phoneSuppressed,
    smsSafetyReadFailed: smsConsentState === null || phoneSuppressed === null,
    isDncLocked: p?.is_dnc_locked ?? false,
    initialMessages: messages,
  };
}
