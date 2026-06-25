import {
  type ListThreadsOpts,
  type Thread,
} from "@/lib/messages/list-threads";

import {
  type InboxFilter,
  type InboxFilterCounts,
} from "./inbox-filters";

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

/**
 * Translate the active filter into `listThreads` query options.
 *
 * - `mine` scopes to the current user's assignments (no-op when signed out).
 * - `unassigned` returns only unowned threads.
 * - `unread` returns unread-only, pinning the open thread via
 *   `includeThreadId` so read-on-open doesn't yank it mid-view.
 * - `escalated` returns only threads Sandra handed off.
 * - `dispo` returns only threads with an applied outreach disposition.
 * - `needs_outcome` returns replied early-stage outreach threads that still
 *   lack an outreach outcome.
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
  if (filter === "dispo") opts.dispoOnly = true;
  if (filter === "needs_outcome") opts.needsOutcomeOnly = true;
  return opts;
}

export type VisibleThreadState = {
  threads: Thread[];
  filterCounts: InboxFilterCounts;
  hiddenDncCount: number;
};

function isInboxNoise(thread: Thread): boolean {
  return thread.isOptedOut || thread.isTestTraffic;
}

export function applyInboxThreadFilter(
  threads: Thread[],
  filter: InboxFilter,
  ctx: { currentUserId: string | null; canonicalThreadId: string | null },
): Thread[] {
  switch (filter) {
    case "mine":
      if (!ctx.currentUserId) return threads;
      return threads.filter((thread) => thread.assigneeId === ctx.currentUserId);
    case "unassigned":
      return threads.filter((thread) => !thread.assigneeId);
    case "unread":
      return threads.filter(
        (thread) =>
          thread.unreadCount > 0 || thread.threadId === ctx.canonicalThreadId,
      );
    case "escalated":
      return threads.filter((thread) => thread.aiResponderStatus === "escalated");
    case "dispo":
      return threads.filter((thread) => thread.outreachDispo !== null);
    case "needs_outcome":
      return threads.filter((thread) => thread.needsOutcome);
    case "unknown":
    case "dismissed":
      return [];
    case "all":
    default:
      return threads;
  }
}

export function resolveVisibleThreadState(
  allThreads: Thread[],
  filter: InboxFilter,
  ctx: {
    currentUserId: string | null;
    canonicalThreadId: string | null;
    hideDnc: boolean;
  },
): VisibleThreadState {
  const visibleAllThreads = ctx.hideDnc
    ? allThreads.filter((thread) => !isInboxNoise(thread))
    : allThreads;
  const filteredThreads = isThreadFilter(filter)
    ? applyInboxThreadFilter(allThreads, filter, ctx)
    : allThreads;
  const threads = ctx.hideDnc
    ? filteredThreads.filter((thread) => !isInboxNoise(thread))
    : filteredThreads;

  return {
    threads,
    filterCounts: buildThreadFilterCounts(
      visibleAllThreads,
      ctx.currentUserId,
    ),
    hiddenDncCount: ctx.hideDnc && isThreadFilter(filter)
      ? filteredThreads.filter((thread) => isInboxNoise(thread)).length
      : 0,
  };
}

function buildThreadFilterCounts(
  threads: Thread[],
  currentUserId: string | null,
): InboxFilterCounts {
  return {
    all: threads.length,
    mine: currentUserId
      ? threads.filter((thread) => thread.assigneeId === currentUserId).length
      : 0,
    unassigned: currentUserId
      ? threads.filter((thread) => !thread.assigneeId).length
      : 0,
    unread: threads.filter((thread) => thread.unreadCount > 0).length,
    escalated: threads.filter(
      (thread) => thread.aiResponderStatus === "escalated",
    ).length,
    dispo: threads.filter((thread) => thread.outreachDispo !== null).length,
    needs_outcome: threads.filter((thread) => thread.needsOutcome).length,
    unknown: 0,
    dismissed: 0,
  };
}
