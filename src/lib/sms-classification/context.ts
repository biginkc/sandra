import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../supabase/types";
import type { JevThreadMessage } from "./providers/jev-gateway";

const THREAD_WINDOW = 15;

/**
 * Two-way thread state for a Jev classification: last `THREAD_WINDOW`
 * messages, BOTH directions, chronological. Confirmed by the 2026-09-20
 * live-eval session that inbound-only context scored ~22% accuracy vs.
 * 41-64% with two-way context — one-word inbound replies ("Who dis", "No")
 * are unjudgeable without the outbound message they're answering.
 *
 * Reuses the same `messages` query shape as
 * `ai-responder/dispatch.ts:loadConversation` (property/conversation
 * filter, `created_at` ordering, current-inbound exclusion) rather than
 * inventing a new one — only the window size and the kept `direction`
 * label differ, since `loadConversation` collapses direction into a
 * Claude role (`user`/`assistant`) that Jev doesn't need.
 */
export async function buildTwoWayThreadState(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    contactId: string;
    conversationId: string | null;
    excludeMessageId: string | null;
    /** Root review of dbbb12e6 (jev-root-autoapply-review.md, finding 3):
     *  excluding the current inbound BY ID stops it appearing twice, but
     *  does nothing to stop a DIFFERENT message — inbound or outbound —
     *  that arrives on this same thread WHILE Jev is still evaluating
     *  (context build + HTTP latency) from leaking into "prior" context
     *  purely because the query happened to run after it landed. Passing
     *  the source inbound message's OWN stored `created_at` restricts
     *  the query to that instant, so later activity genuinely cannot
     *  contaminate an earlier evaluation regardless of query timing. */
    sourceCreatedAt: string | null;
  },
): Promise<JevThreadMessage[]> {
  let query = supabase
    .from("messages")
    .select("direction, body, created_at")
    .eq("property_id", args.propertyId)
    .order("created_at", { ascending: false })
    .limit(THREAD_WINDOW);
  query = args.conversationId
    ? query.eq("conversation_id", args.conversationId)
    : query.eq("contact_id", args.contactId);
  if (args.excludeMessageId) query = query.neq("id", args.excludeMessageId);
  if (args.sourceCreatedAt) query = query.lte("created_at", args.sourceCreatedAt);

  const { data } = await query;
  const rows = (data ?? []).slice().reverse(); // chronological, oldest first
  return rows.map((r) => ({
    direction: r.direction === "inbound" ? "inbound" : "outbound",
    body: r.body ?? "",
    sentAt: r.created_at,
  }));
}
