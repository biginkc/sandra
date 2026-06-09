import type { SupabaseClient } from "@supabase/supabase-js";

import { buildThreadId, parseThreadId } from "@/lib/messages/threading";
import type { Database } from "@/lib/supabase/types";

export type InboxDetail = {
  threadId: string;
  conversationId: string | null;
  contactId: string;
  contactName: string | null;
  contactPhone: string | null;
  propertyId: string | null;
  propertyAddress: string | null;
  /** auth.users.id of the property's current assignee, or null. */
  assigneeId: string | null;
  /** Pipeline position — used to show/hide the dispo bar. */
  propertyStatus: string | null;
  /** Current outreach disposition, if any. */
  outreachDispo: string | null;
  initialMessages: Database["public"]["Tables"]["messages"]["Row"][];
};

/**
 * Server-side fetch for the side-panel: latest 100 messages for this
 * contact's most-active thread plus enough contact + property metadata
 * to render the composer. Returns null if the contact has no messages
 * (likely a stale URL).
 */
export async function fetchInboxDetail(
  supabase: SupabaseClient<Database>,
  threadId: string,
): Promise<InboxDetail | null> {
  let parsed = parseThreadId(threadId);
  let resolvedThreadId = threadId;

  if (parsed.kind === "contact") {
    const fallbackThreadId = await resolveConcreteThreadIdForContact(
      supabase,
      parsed.contactId,
    );
    if (!fallbackThreadId) return null;
    resolvedThreadId = fallbackThreadId;
    parsed = parseThreadId(fallbackThreadId);
  }

  let query = supabase
    .from("messages")
    .select("*")
    .eq("channel", "sms")
    .order("created_at", { ascending: true })
    .limit(100);

  if (parsed.kind === "conversation") {
    query = query.eq("conversation_id", parsed.conversationId);
  } else if (parsed.kind === "legacy") {
    query = query.eq("contact_id", parsed.contactId);
    query =
      parsed.propertyId === null
        ? query.is("property_id", null)
        : query.eq("property_id", parsed.propertyId);
  } else {
    query = query.eq("contact_id", parsed.contactId);
  }

  const { data: messages, error } = await query;
  if (error || !messages || messages.length === 0) return null;

  const contactId =
    messages.find((message) => message.contact_id !== null)?.contact_id ??
    (parsed.kind !== "conversation" ? parsed.contactId : null);
  if (!contactId) return null;

  const propertyId = messages[messages.length - 1].property_id;
  const conversationId = messages[messages.length - 1].conversation_id;

  const [contactRes, propertyRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("first_name, last_name, entity_name, phone_1")
      .eq("id", contactId)
      .maybeSingle(),
    propertyId
      ? supabase
          .from("properties")
          .select("address, city, state, assigned_user_id, status, outreach_dispo")
          .eq("id", propertyId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const c = contactRes.data;
  const p = propertyRes.data;

  return {
    threadId: resolvedThreadId,
    conversationId,
    contactId,
    contactName: c
      ? (c.entity_name ??
        ([c.first_name, c.last_name].filter(Boolean).join(" ") || null))
      : null,
    contactPhone: c?.phone_1 ?? null,
    propertyId,
    propertyAddress: p
      ? [p.address, p.city, p.state].filter(Boolean).join(", ")
      : null,
    assigneeId: p?.assigned_user_id ?? null,
    propertyStatus: p?.status ?? null,
    outreachDispo: p?.outreach_dispo ?? null,
    initialMessages: messages,
  };
}

async function resolveConcreteThreadIdForContact(
  supabase: SupabaseClient<Database>,
  contactId: string,
): Promise<string | null> {
  const { data: messages, error } = await supabase
    .from("messages")
    .select("conversation_id, property_id, created_at")
    .eq("channel", "sms")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error || !messages || messages.length === 0) return null;

  const uniqueThreadIds = Array.from(
    new Set(
      messages.map((message) =>
        buildThreadId(message.conversation_id, contactId, message.property_id),
      ),
    ),
  );
  if (uniqueThreadIds.length !== 1) {
    return null;
  }
  return uniqueThreadIds[0] ?? null;
}
