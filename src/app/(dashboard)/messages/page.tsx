import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { listThreads } from "@/lib/messages/list-threads";
import { listUnknownSenders } from "@/lib/messages/list-unknown-senders";
import { canonicalizeThreadId } from "@/lib/messages/threading";
import { redirect } from "next/navigation";

import { markMessagesReadForThread } from "../leads/actions";

import { getQueueStats, listQueuedPage, type QueueStats } from "./actions";
import { CockpitView } from "./cockpit-view";
import {
  isThreadFilter,
  normalizeInboxFilterForUser,
  parseInboxFilter,
  resolveVisibleThreadState,
} from "./inbox-filter-resolve";
import { fetchInboxDetail } from "./inbox-detail-data";

const EMPTY_QUEUE_STATS: QueueStats = {
  queued: 0,
  sentToday: 0,
  failedToday: 0,
  nextScheduledFor: null,
  lastScheduledFor: null,
};

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Messages · Sandra CRM",
};

/**
 * Cockpit page — two tabs:
 *
 *   1. Inbox  (default) — Slack/iPhone-style conversation list with a
 *      side-panel detail view. Click a thread, reply inline, sends
 *      immediately via the existing send-now path. Replaces the Dialpad
 *      app for live conversation work.
 *
 *      Filters: All (default), Unread, Needs Outcome, Mine, Escalated,
 *      Dispo, Unassigned, Unknown, Dismissed.
 *
 *   2. Outbox — the legacy queue panel: drafts waiting to release with
 *      cadence (Send Next / Auto-send). Unchanged.
 *
 * State (active tab, filter, selected thread) lives in the URL query
 * string so cockpit URLs are shareable.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    thread?: string;
    filter?: string;
    hideDnc?: string;
  }>;
}) {
  const sp = await searchParams;
  if (sp.filter === "handled") {
    const canonical = new URLSearchParams();
    if (sp.tab) canonical.set("tab", sp.tab);
    if (sp.thread) canonical.set("thread", sp.thread);
    canonical.set("filter", "dispo");
    if (sp.hideDnc) canonical.set("hideDnc", sp.hideDnc);
    redirect(`/messages?${canonical.toString()}`);
  }

  const activeTab = sp.tab === "outbox" ? "outbox" : "inbox";
  const filter = parseInboxFilter(sp.filter);
  // DNC toggle — ON by default per feedback-f E1. Only `?hideDnc=0` flips
  // it off so we can keep clean URLs the rest of the time.
  const hideDnc = sp.hideDnc !== "0";
  const selectedThreadId = sp.thread ?? null;

  const supabase = await createClient();
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser();
  const currentUserId = currentUser?.id ?? null;
  const effectiveFilter = normalizeInboxFilterForUser(filter, currentUserId);

  // Translate whatever the URL carries (canonical conversation UUID, or a
  // stale legacy/bare-contact link) into the one true conversation id.
  // Everything downstream — thread pin, detail fetch, mark-read — deals
  // in canonical ids only.
  const canonicalThreadId =
    isThreadFilter(effectiveFilter) && selectedThreadId
      ? await canonicalizeThreadId(supabase, selectedThreadId)
      : null;

  // Fetch everything in parallel. The thread list + unknown active count
  // are needed regardless of which filter is active (badge counts on the
  // tab + filter chips). Other queries are conditional on the filter.
  const [
    allThreads,
    queuedResult,
    threadDetail,
    unknownActive,
    unknownAll,
    queueStatsResult,
  ] = await Promise.all([
    listThreads(supabase, {}),
    listQueuedPage(null),
    canonicalThreadId
      ? fetchInboxDetail(supabase, canonicalThreadId)
      : Promise.resolve(null),
    listUnknownSenders(supabase, {}),
    effectiveFilter === "dismissed"
      ? listUnknownSenders(supabase, { includeDismissed: true })
      : Promise.resolve([]),
    getQueueStats(),
  ]);

  const {
    threads: visibleThreads,
    unreadCount,
    needsOutcomeCount,
    hiddenDncCount,
  } = resolveVisibleThreadState(allThreads, effectiveFilter, {
    currentUserId,
    canonicalThreadId,
    hideDnc,
  });

  // Banner still renders if first-paint stats fail — the client-side poll
  // will retry every 30s.
  const queueStats: QueueStats = queueStatsResult.ok
    ? queueStatsResult.data
    : EMPTY_QUEUE_STATS;

  // Hydrate assignee emails for whichever assignee ids appear on the
  // visible threads. One auth.admin.listUsers call covers the whole page.
  const assigneeEmails: Record<string, string> = {};
  const assigneeIds = new Set<string>();
  for (const t of visibleThreads) {
    if (t.assigneeId) assigneeIds.add(t.assigneeId);
  }
  if (assigneeIds.size > 0) {
    try {
      const admin = createAdminClient();
      const { data: usersPage } = await admin.auth.admin.listUsers({
        perPage: 200,
      });
      for (const u of usersPage?.users ?? []) {
        if (u.email && assigneeIds.has(u.id)) {
          assigneeEmails[u.id] = u.email;
        }
      }
    } catch {
      // ids still render — pretty labels are best-effort.
    }
  }

  const queuedPage = queuedResult.ok
    ? queuedResult.data
    : { rows: [], hasMore: false };

  if (isThreadFilter(effectiveFilter) && threadDetail) {
    await markMessagesReadForThread(threadDetail.threadId);
  }

  const unknownSenders =
    effectiveFilter === "dismissed"
      ? unknownAll.filter((s) => s.isDismissed)
      : unknownActive;

  return (
    <CockpitView
      activeTab={activeTab}
      filter={effectiveFilter}
      threads={visibleThreads}
      queued={queuedPage.rows}
      queuedHasMore={queuedPage.hasMore}
      selectedThreadId={selectedThreadId}
      threadDetail={threadDetail}
      unknownSenders={unknownSenders}
      unknownActiveCount={unknownActive.length}
      needsOutcomeCount={needsOutcomeCount}
      unreadCount={unreadCount}
      assigneeEmails={assigneeEmails}
      currentUserId={currentUserId}
      queueStats={queueStats}
      hideDnc={hideDnc}
      hiddenDncCount={hiddenDncCount}
    />
  );
}
