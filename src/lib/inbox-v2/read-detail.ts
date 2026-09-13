import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { fetchInboxDetail } from "@/app/(dashboard)/messages/inbox-detail-data";
import { resolveSmsConversationOrg } from "@/lib/messages/threading";
import { encodeHistoryCursor, validateInboxReadRequest, type InboxReadRequest, type InboxReadResponse } from "./read-contract";

// Deliberately excludes provider payload/metadata, org IDs and unrelated message columns.
const HISTORY_COLUMNS = "id,created_at,channel,direction,body,status,read_at,sent_at,delivered_at,failed_at,from_address,to_address";

/** Candidate-1 experiment. Use an ordinary authenticated client and session-derived org.
 * Reuses the existing context reader unchanged (including its extra latest-100 history read).
 * No mutation, mark-read, service client, cache or platform-specific projection is involved.
 */
export async function readInboxDetail(
  client: SupabaseClient<Database>,
  orgId: string,
  request: InboxReadRequest,
): Promise<InboxReadResponse> {
  // Revalidate before any raw PostgREST grammar, even for direct/internal callers.
  const checked = validateInboxReadRequest({ conversationId: request.conversationId,
    pageSize: request.pageSize, cursor: request.before ? encodeHistoryCursor(request.conversationId, request.before) : null });
  if (!checked.ok) throw new Error("Invalid Inbox read request");
  const { conversationId, before, pageSize } = checked.value;
  const resolvedOrg = await resolveSmsConversationOrg(client, conversationId);
  if (!resolvedOrg || resolvedOrg !== orgId) return { status: "unavailable", conversationId };

  let historyQuery = client.from("messages").select(HISTORY_COLUMNS)
    .eq("org_id", orgId).eq("conversation_id", conversationId).eq("channel", "sms")
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(pageSize + 1);
  if (before) historyQuery = historyQuery.or(
    `created_at.lt."${before.createdAt}",and(created_at.eq."${before.createdAt}",id.lt.${before.id})`,
  );
  const contextRead = fetchInboxDetail(client, conversationId).then(context => ({ context, completedAt: new Date().toISOString() }));
  const [history, contextResult, inbound] = await Promise.all([
    historyQuery,
    contextRead,
    client.from("messages").select("id,created_at")
      .eq("org_id", orgId).eq("conversation_id", conversationId).eq("channel", "sms").eq("direction", "inbound")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1),
  ]);
  if (history.error || inbound.error) throw new Error("Inbox detail unavailable");
  const detail = contextResult.context;
  if (!detail) return { status: "unavailable", conversationId };
  if (detail.conversationId !== conversationId || detail.threadId !== conversationId) throw new Error("Inbox detail identity mismatch");
  const { initialMessages: _history, conversationId: _conversationId, threadId: _threadId, ...context } = detail;
  // Explicit destructuring keeps the old reader's broad history out of the response.
  void _history; void _conversationId; void _threadId;
  const rows = history.data ?? [];
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  const newestInbound = inbound.data?.[0];
  return {
    status: "ready", conversationId, context, messages: [...page].reverse(),
    nextCursor: rows.length > pageSize && last ? encodeHistoryCursor(conversationId, { id: last.id, createdAt: last.created_at }) : null,
    freshness: { contextReadCompletedAt: contextResult.completedAt,
      latestInbound: newestInbound ? { id: newestInbound.id, createdAt: newestInbound.created_at } : null },
  };
}
