"use client";

import { MessageSquarePlusIcon, PlusIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import type { Thread } from "@/lib/messages/list-threads";
import type { UnknownSender } from "@/lib/messages/list-unknown-senders";

import type { QueueStats } from "./actions";
import { InboxDetail } from "./inbox-detail";
import { type InboxDetail as InboxDetailData } from "./inbox-detail-data";
import { InboxFilters, type InboxFilter } from "./inbox-filters";
import { InboxThreadList } from "./inbox-thread-list";
import { QueuePanel, type QueuedRow } from "./queue-panel";
import { QueueStatsBanner } from "./queue-stats-banner";
import { UnknownSenderList } from "./unknown-sender-list";
import { useQueueStats } from "./use-queue-stats";

type Props = {
  activeTab: "inbox" | "outbox";
  filter: InboxFilter;
  threads: Thread[];
  queued: QueuedRow[];
  /** True when more queued rows exist beyond the first server page. */
  queuedHasMore?: boolean;
  /** Server-resolved URL thread param. Used to distinguish "still fetching"
   *  from "fetch completed but there is no matching thread detail." */
  selectedThreadId?: string | null;
  threadDetail: InboxDetailData | null;
  unknownSenders: UnknownSender[];
  unknownActiveCount: number;
  needsOutcomeCount: number;
  unreadCount: number;
  /** auth.users.id → email map for assignee badges. */
  assigneeEmails: Record<string, string>;
  /** auth.users.id of the current viewer. */
  currentUserId: string | null;
  /** First-paint queue stats — banner above the Outbox table polls + refreshes from here. */
  queueStats: QueueStats;
  /** True when DNC threads are currently hidden. URL: omit / hideDnc=1 → hidden. */
  hideDnc: boolean;
  /** Count of DNC threads under the current filter that the toggle is hiding. */
  hiddenDncCount: number;
};

const THREAD_FILTERS = new Set<InboxFilter>([
  "all",
  "mine",
  "unassigned",
  "unread",
  "escalated",
  "dispo",
  "needs_outcome",
]);

export function CockpitView({
  activeTab,
  filter,
  threads,
  queued,
  queuedHasMore = false,
  selectedThreadId = null,
  threadDetail,
  unknownSenders,
  unknownActiveCount,
  needsOutcomeCount,
  unreadCount,
  assigneeEmails,
  currentUserId,
  queueStats,
  hideDnc,
  hiddenDncCount,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // One live stats source for the Outbox tab badge + the stats banner,
  // so the two never show different numbers. Seeds from the server
  // first-paint stats; polls every 30s while visible, but only while
  // the Outbox tab is active — Inbox dwellers shouldn't generate
  // stats-query load (5 DB reads/poll) for a banner they can't see.
  const liveQueueStats = useQueueStats(queueStats, {
    enabled: activeTab === "outbox",
  });

  const setTab = (next: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (next === "inbox") {
      sp.delete("tab");
    } else {
      sp.set("tab", next);
    }
    const qs = sp.toString();
    router.replace(qs ? `/messages?${qs}` : "/messages");
  };

  const showThreadList = THREAD_FILTERS.has(filter);
  // Track which contactId the user is currently navigating *to*. The
  // setState here is a synchronous high-priority update so the next
  // render commits BEFORE the RSC round-trip completes — which is what
  // lets the detail panel show a skeleton instead of stale bubbles
  // from the previous selection. Using useTransition would be cleaner
  // semantically, but React's concurrent mode keeps the old tree
  // visible during transitions, so isPending never flips in the tree
  // the user is looking at.
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      setPendingThreadId(threadId);
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("thread", threadId);
      router.replace(`/messages?${sp.toString()}`);
    },
    [searchParams, router],
  );

  // Clear the pending marker once the server data catches up — that's
  // when the skeleton can disappear and the real panel or empty state
  // can mount. The server-selected id is load-bearing here: client
  // searchParams update immediately on click, but this prop updates only
  // after the RSC payload has returned.
  useEffect(() => {
    if (pendingThreadId !== null && selectedThreadId === pendingThreadId) {
      const timeout = window.setTimeout(() => setPendingThreadId(null), 0);
      return () => window.clearTimeout(timeout);
    }
    return undefined;
  }, [pendingThreadId, selectedThreadId]);

  useEffect(() => {
    if (
      pendingThreadId !== null ||
      !selectedThreadId ||
      !threadDetail?.threadId ||
      selectedThreadId === threadDetail.threadId
    ) {
      return;
    }

    const sp = new URLSearchParams(searchParams.toString());
    sp.set("thread", threadDetail.threadId);
    router.replace(`/messages?${sp.toString()}`);
  }, [pendingThreadId, router, searchParams, selectedThreadId, threadDetail?.threadId]);

  // Skeleton shows when the user has clicked a thread that the server
  // hasn't returned yet. Same-thread re-clicks: pendingContactId
  // matches threadDetail.contactId already → no skeleton.
  const isLoadingThread =
    pendingThreadId !== null && selectedThreadId !== pendingThreadId;

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Messages" }]}
        title="Messages"
        description="Live conversations on the Inbox tab; queued bulk sends on the Outbox tab."
        actions={
          <button
            type="button"
            data-testid="messages-new-message"
            onClick={() => router.push(`/leads?compose=1`)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[12px] font-bold text-primary-foreground transition-opacity hover:opacity-90"
          >
            <PlusIcon className="h-4 w-4" />
            New Message
          </button>
        }
      />

      {/* Underline tabs — replaces the shadcn Tabs to match the Stitch
          messages-cockpit design. State stays in the URL like before.
          No mt-* here: the parent <Page> contributes gap-8 between
          children already; adding a margin would compound. */}
      <div
        role="tablist"
        aria-label="Inbox / Outbox"
        className="flex gap-6 border-b border-border"
      >
        <TabButton
          label="Inbox"
          count={threads.length}
          active={activeTab === "inbox"}
          onClick={() => setTab("inbox")}
          testId="tab-inbox"
        />
        <TabButton
          label="Outbox"
          stats={liveQueueStats}
          active={activeTab === "outbox"}
          onClick={() => setTab("outbox")}
          testId="tab-outbox"
        />
      </div>

      {activeTab === "inbox" ? (
        <div className="flex flex-col gap-4">
          <InboxFilters
            active={filter}
            unknownCount={unknownActiveCount}
            needsOutcomeCount={needsOutcomeCount}
            unreadCount={unreadCount}
            showAssignmentChips={currentUserId !== null}
            hideDnc={hideDnc}
            hiddenDncCount={hiddenDncCount}
          />

          {showThreadList && (
            <div
              className="grid h-[calc(100vh-260px)] min-h-[500px] grid-cols-[minmax(280px,360px)_1fr] gap-6"
              data-testid="inbox-cockpit-grid"
            >
              <InboxThreadList
                initial={threads}
                selectedThreadId={
                  pendingThreadId ??
                  threadDetail?.threadId ??
                  selectedThreadId ??
                  null
                }
                currentUserId={currentUserId}
                onSelectThread={handleSelectThread}
              />
              <InboxDetail
                data={threadDetail}
                isLoading={isLoadingThread}
                assigneeEmails={assigneeEmails}
                currentUserId={currentUserId}
              />
            </div>
          )}

          {filter === "unknown" && (
            <UnknownSenderList senders={unknownSenders} showRestore={false} />
          )}

          {filter === "dismissed" && (
            <UnknownSenderList senders={unknownSenders} showRestore={true} />
          )}
        </div>
      ) : (
        <div>
          <QueueStatsBanner stats={liveQueueStats} />
          <QueuePanel
            initial={queued}
            initialHasMore={queuedHasMore}
            totalQueued={liveQueueStats.queued}
          />
        </div>
      )}

      {/* Contextual FAB — quick "compose new message" entry from anywhere
          on the page. Routes through the leads index compose flow rather
          than opening a modal here, so we don't duplicate consent /
          quiet-hours UX. */}
      <button
        type="button"
        aria-label="Compose new message"
        data-testid="messages-fab"
        onClick={() => router.push(`/leads?compose=1`)}
        className="fixed bottom-6 right-6 w-14 h-14 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-2xl hover:scale-105 transition-transform z-40"
      >
        <MessageSquarePlusIcon className="h-6 w-6" />
      </button>
    </Page>
  );
}

function TabButton({
  label,
  count,
  stats,
  active,
  onClick,
  testId,
}: {
  label: string;
  /** Simple count pill (Inbox). */
  count?: number;
  /** Queue figures: queued · sent today (green) · failed today (red) (Outbox). */
  stats?: QueueStats;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testId}
      onClick={onClick}
      className={`pb-2 -mb-px flex items-center gap-2 text-[14px] font-bold border-b-2 transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-[#78716c] hover:text-[#1c1917]"
      }`}
    >
      {label}
      {count !== undefined && (
        <span
          className={`px-2 py-0.5 text-[10px] rounded-full font-bold ${
            active
              ? "bg-primary text-primary-foreground"
              : "bg-[#f5f5f4] text-[#78716c] border border-[#e5e1df]"
          }`}
        >
          {count}
        </span>
      )}
      {stats && (
        <span
          className="flex items-center gap-1.5 text-[11px] font-bold"
          title={`${stats.queued} queued · ${stats.sentToday} sent today · ${stats.failedToday} failed today`}
          data-testid={`${testId}-stats`}
        >
          {/* Queued inherits the tab text color; sent/failed keep their
              status colors in both active and inactive states. */}
          <span>{stats.queued}</span>
          <span className="text-[#a8a29e]">·</span>
          <span className="text-emerald-600">{stats.sentToday}</span>
          <span className="text-[#a8a29e]">·</span>
          <span className="text-red-600">{stats.failedToday}</span>
        </span>
      )}
    </button>
  );
}
