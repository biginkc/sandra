import type { SupabaseClient } from "@supabase/supabase-js";

import { listCandidatePropertyThreadsForInboundContact } from "@/lib/messages/threading";
import type { Database } from "@/lib/supabase/types";

export async function findAttributedOutboundMessageId(
  supabase: SupabaseClient<Database>,
  input: {
    contactId: string | null;
    toPhone?: string | null;
    propertyId?: string | null;
    conversationId?: string | null;
  },
): Promise<string | null> {
  if (!input.contactId) return null;

  const candidateThreads = await listCandidatePropertyThreadsForInboundContact(
    supabase,
    {
      contactId: input.contactId,
      toPhone: input.toPhone,
    },
  );
  const candidatePropertyIds = Array.from(
    new Set(candidateThreads.map((candidate) => candidate.propertyId)),
  );

  if (candidatePropertyIds.length === 0) {
    return null;
  }

  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .eq("channel", "sms")
    .eq("direction", "outbound")
    .eq("contact_id", input.contactId)
    .in("property_id", candidatePropertyIds)
    .not("campaign_id", "is", null)
    .in("status", ["sent", "delivered"])
    .order("sent_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`findAttributedOutboundMessageId: ${error.message}`);
  }

  return data?.id ?? null;
}
