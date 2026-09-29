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

  // The run table is the authoritative link for drip SMS: ordinary manual
  // messages have no campaign_id and must not become attribution candidates.
  const { data: enrollments, error: enrollmentError } = await supabase
    .from("sequence_enrollments")
    .select("id")
    .in("property_id", candidatePropertyIds);
  if (enrollmentError) {
    throw new Error(`findAttributedOutboundMessageId: ${enrollmentError.message}`);
  }

  let dripOutbounds: AttributableOutboundMessage[] = [];
  const enrollmentIds = (enrollments ?? []).map((row) => row.id);
  if (enrollmentIds.length > 0) {
    const { data: runs, error: runsError } = await supabase
      .from("sequence_step_runs")
      .select("message_id")
      .in("enrollment_id", enrollmentIds)
      .not("message_id", "is", null);
    if (runsError) {
      throw new Error(`findAttributedOutboundMessageId: ${runsError.message}`);
    }
    const messageIds = Array.from(new Set((runs ?? [])
      .map((run) => run.message_id)
      .filter((id): id is string => id !== null)));
    if (messageIds.length > 0) {
      const { data: dripMessages, error: dripError } = await supabase
        .from("messages")
        .select("id, sent_at, created_at")
        .in("id", messageIds)
        .eq("channel", "sms")
        .eq("direction", "outbound")
        .eq("contact_id", input.contactId)
        .in("property_id", candidatePropertyIds)
        .in("status", ["sent", "delivered"]);
      if (dripError) {
        throw new Error(`findAttributedOutboundMessageId: ${dripError.message}`);
      }
      dripOutbounds = dripMessages ?? [];
    }
  }

  const newestOutbound = [...(data ?? []), ...dripOutbounds]
    .sort(compareOutboundRecency)[0];

  return newestOutbound?.id ?? null;
}
