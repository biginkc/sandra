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
    case "dispo":
      return raw;
    case "handled":
      return "dispo";
    case "needs_outcome":
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
    f === "escalated" ||
    f === "dispo" ||
    f === "needs_outcome"
  );
}

export function normalizeInboxFilterForUser(
  filter: InboxFilter,
  currentUserId: string | null,
): InboxFilter {
  if (!currentUserId && (filter === "mine" || filter === "unassigned")) {
    return "all";
  }
  return filter;
}
