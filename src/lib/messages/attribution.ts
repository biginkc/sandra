import type { SupabaseClient } from "@supabase/supabase-js";

import { listCandidatePropertyThreadsForInboundContact } from "@/lib/messages/threading";
import type { Database } from "@/lib/supabase/types";

type AttributableOutboundMessage = {
  id: string;
  sent_at: string | null;
  created_at: string;
};

function outboundRecencyValue(message: AttributableOutboundMessage): number {
  return Date.parse(message.sent_at ?? message.created_at);
}

function compareOutboundRecency(
  left: AttributableOutboundMessage,
  right: AttributableOutboundMessage,
): number {
  const outboundDelta = outboundRecencyValue(right) - outboundRecencyValue(left);
  if (outboundDelta !== 0) return outboundDelta;

  return Date.parse(right.created_at) - Date.parse(left.created_at);
}

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
    .select("id, sent_at, created_at")
    .eq("channel", "sms")
    .eq("direction", "outbound")
    .eq("contact_id", input.contactId)
    .in("property_id", candidatePropertyIds)
    .not("campaign_id", "is", null)
    .in("status", ["sent", "delivered"])
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`findAttributedOutboundMessageId: ${error.message}`);
  }

  const newestOutbound = [...(data ?? [])].sort(compareOutboundRecency)[0];

  return newestOutbound?.id ?? null;
}
