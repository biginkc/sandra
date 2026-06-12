import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { listThreads, type ListThreadsOpts } from "@/lib/messages/list-threads";
import { listUnknownSenders } from "@/lib/messages/list-unknown-senders";

import { markMessagesReadForThread } from "../leads/actions";

import { getQueueStats, type QueueStats } from "./actions";
import { CockpitView } from "./cockpit-view";
import { fetchInboxDetail } from "./inbox-detail-data";
import { type InboxFilter } from "./inbox-filters";
import { type QueuedRow } from "./queue-panel";

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
 *      Filters: All (default), Mine (Phase 3), Unassigned (Phase 3),
 *      Unknown (Phase 2), Dismissed (Phase 2).
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
  const activeTab = sp.tab === "outbox" ? "outbox" : "inbox";
  const filter: InboxFilter =
    sp.filter === "unknown"
      ? "unknown"
      : sp.filter === "dismissed"
        ? "dismissed"
        : sp.filter === "mine"
          ? "mine"
          : sp.filter === "unassigned"
            ? "unassigned"
            : sp.filter === "unread"
              ? "unread"
              : "all";
  // DNC toggle — ON by default per feedback-f E1. Only `?hideDnc=0` flips
  // it off so we can keep clean URLs the rest of the time.
  const hideDnc = sp.hideDnc !== "0";
  const selectedThreadId = sp.thread ?? null;

  const supabase = await createClient();
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser();

  // Resolve the threads-list options based on the active filter.
  const threadOpts: ListThreadsOpts = {};
  if (filter === "mine" && currentUser) threadOpts.assigneeId = currentUser.id;
  if (filter === "unassigned") threadOpts.unassignedOnly = true;
  if (filter === "unread") threadOpts.unreadOnly = true;

  // Fetch everything in parallel. The thread list + unknown active count
  // are needed regardless of which filter is active (badge counts on the
  // tab + filter chips). Other queries are conditional on the filter.
  const [
    threads,
    queuedResult,
    threadDetail,
    unknownActive,
    unknownAll,
    queueStatsResult,
  ] = await Promise.all([
    listThreads(supabase, threadOpts),
    supabase
      .from("messages")
      .select(
        `id, body, from_address, to_address, created_at, property_id, contact_id,
           property:properties(id, address, city, state),
           contact:contacts(id, first_name, last_name, entity_name, phone_1)`,
      )
      .eq("status", "queued")
      .order("scheduled_for", { ascending: true })
      .limit(100),
    isThreadFilter(filter) && selectedThreadId
      ? fetchInboxDetail(supabase, selectedThreadId)
      : Promise.resolve(null),
    listUnknownSenders(supabase, {}),
    filter === "dismissed"
      ? listUnknownSenders(supabase, { includeDismissed: true })
      : Promise.resolve([]),
    getQueueStats(),
  ]);

  // Banner still renders if first-paint stats fail — the client-side poll
  // will retry every 30s.
  const queueStats: QueueStats = queueStatsResult.ok
    ? queueStatsResult.data
    : EMPTY_QUEUE_STATS;

  // Hydrate assignee emails for whichever assignee ids appear on the
  // visible threads. One auth.admin.listUsers call covers the whole page.
  const assigneeEmails: Record<string, string> = {};
  const assigneeIds = new Set<string>();
  for (const t of threads) {
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

  const queued: QueuedRow[] = (queuedResult.data ?? []).map((r) => ({
    id: r.id,
    body: r.body,
    fromAddress: r.from_address,
    toAddress: r.to_address,
    createdAt: r.created_at,
    propertyId: r.property_id,
    contactId: r.contact_id,
    propertyAddress: r.property
      ? [r.property.address, r.property.city, r.property.state]
          .filter(Boolean)
          .join(", ")
      : null,
    contactName: r.contact
      ? (r.contact.entity_name ??
        ([r.contact.first_name, r.contact.last_name]
          .filter(Boolean)
          .join(" ") ||
          null))
      : null,
    contactPhone: r.contact?.phone_1 ?? null,
  }));

  if (isThreadFilter(filter) && threadDetail) {
    await markMessagesReadForThread(threadDetail.threadId);
  }

  const unknownSenders =
    filter === "dismissed"
      ? unknownAll.filter((s) => s.isDismissed)
      : unknownActive;

  // Noise toggle: when on (default), opted-out threads AND Jitter test
  // traffic (canary/rehearsal fixtures) are stripped from the visible
  // list — one switch, both kinds of noise (Jarrad, 2026-06-12). Hidden
  // count reported back to the toggle.
  const isNoise = (t: (typeof threads)[number]) =>
    t.isOptedOut || t.isTestTraffic;
  const hiddenDncCount = hideDnc ? threads.filter(isNoise).length : 0;
  const visibleThreads = hideDnc
    ? threads.filter((t) => !isNoise(t))
    : threads;

  return (
    <CockpitView
      activeTab={activeTab}
      filter={filter}
      threads={visibleThreads}
      queued={queued}
      selectedThreadId={selectedThreadId}
      threadDetail={threadDetail}
      unknownSenders={unknownSenders}
      unknownActiveCount={unknownActive.length}
      assigneeEmails={assigneeEmails}
      currentUserId={currentUser?.id ?? null}
      queueStats={queueStats}
      hideDnc={hideDnc}
      hiddenDncCount={hiddenDncCount}
    />
  );
}

/** Filter values that show the thread list (vs the unknown bucket). */
function isThreadFilter(f: InboxFilter): boolean {
  return f === "all" || f === "mine" || f === "unassigned" || f === "unread";
}
