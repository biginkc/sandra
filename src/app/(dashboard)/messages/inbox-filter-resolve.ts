import { type ListThreadsOpts } from "@/lib/messages/list-threads";

import { type InboxFilter } from "./inbox-filters";

/**
 * Pure resolvers for the Messages inbox filter, extracted from the page
 * Server Component so the URL → query-options hop is unit-testable without
 * standing up an async RSC + Supabase. The page wires these together.
 */

/** Map the raw `?filter=` URL value to a known InboxFilter, defaulting to "all". */
export function parseInboxFilter(raw: string | undefined): InboxFilter {
  switch (raw) {
    case "unknown":
    case "dismissed":
    case "mine":
    case "unassigned":
    case "unread":
    case "escalated":
      return raw;
    default:
      return "all";
  }
}

/** Filter values that show the thread list (vs the unknown bucket). */
export function isThreadFilter(f: InboxFilter): boolean {
  return (
    f === "all" ||
    f === "mine" ||
    f === "unassigned" ||
    f === "unread" ||
    f === "escalated"
  );
}

/**
 * Translate the active filter into `listThreads` query options.
 *
 * - `mine` scopes to the current user's assignments (no-op when signed out).
 * - `unassigned` returns only unowned threads.
 * - `unread` returns unread-only, pinning the open thread via
 *   `includeThreadId` so read-on-open doesn't yank it mid-view.
 * - `escalated` returns only threads the AI handed off
 *   (properties.needs_human_attention).
 */
export function buildThreadOpts(
  filter: InboxFilter,
  ctx: { currentUserId: string | null; canonicalThreadId: string | null },
): ListThreadsOpts {
  const opts: ListThreadsOpts = {};
  if (filter === "mine" && ctx.currentUserId) {
    opts.assigneeId = ctx.currentUserId;
  }
  if (filter === "unassigned") opts.unassignedOnly = true;
  if (filter === "unread") {
    opts.unreadOnly = true;
    if (ctx.canonicalThreadId) opts.includeThreadId = ctx.canonicalThreadId;
  }
  if (filter === "escalated") opts.escalatedOnly = true;
  return opts;
}
