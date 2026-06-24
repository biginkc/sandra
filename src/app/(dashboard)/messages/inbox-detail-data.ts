import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export type InboxDetail = {
  /** The conversation UUID — same value as `conversationId`; kept as the
   *  field name the cockpit keys selection on. */
  threadId: string;
  conversationId: string;
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
  const { data: messages, error } = await supabase
    .from("messages")
    .select("*")
    .eq("channel", "sms")
    .eq("conversation_id", conversationId)
    .neq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(100);
  if (error || !messages || messages.length === 0) return null;

  const contactId = messages.find(
    (message) => message.contact_id !== null,
  )?.contact_id;
  if (!contactId) return null;

  const propertyId =
    messages.find((message) => message.property_id !== null)?.property_id ??
    null;

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
    threadId: conversationId,
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
