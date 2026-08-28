"use client";

import { MessageSquarePlusIcon, PlusIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import type { Thread } from "@/lib/messages/list-threads";
import type { UnknownSender } from "@/lib/messages/list-unknown-senders";

import type { QueueStats } from "./actions";
import { InboxDetail } from "./inbox-detail";
import { type InboxDetail as InboxDetailData } from "./inbox-detail-data";
import {
  InboxFilters,
  type InboxFilter,
  type InboxFilterCounts,
  type PendingInboxChange,
} from "./inbox-filters";
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
  filterCounts: InboxFilterCounts;
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
  /** Server-filtered Inbox page metadata. */
  inboxPage?: number;
  inboxPageSize?: number;
  inboxTotal?: number;
  /** First Outbox page failed to load. Never present this as an empty queue. */
  queueLoadFailed?: boolean;
  /** Queue summary failed; zeroes are fallback data, not confirmed counts. */
  queueStatsFailed?: boolean;
  /** Request-scoped clock so SSR and hydration render identical relative times. */
  nowMs: number;
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
const LIVE_CLOCK_INTERVAL_MS = 30_000;

export function CockpitView({
  activeTab,
  filter,
  threads,
  queued,
  queuedHasMore = false,
  selectedThreadId = null,
  threadDetail,
  unknownSenders,
  filterCounts,
  assigneeEmails,
  currentUserId,
  queueStats,
  hideDnc,
  hiddenDncCount,
  inboxPage = 1,
  inboxPageSize = 200,
  inboxTotal = threads.length,
  queueLoadFailed = false,
  queueStatsFailed = false,
  nowMs,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const liveNowMs = useLiveNow(nowMs);
  const inboxTotalPages = Math.max(Math.ceil(inboxTotal / inboxPageSize), 1);
  const [pendingInboxChange, setPendingInboxChange] =
    useState<PendingInboxChange | null>(null);
  const [completedInboxChange, setCompletedInboxChange] =
    useState<PendingInboxChange | null>(null);

  // One live stats source for the Outbox tab badge + the stats banner,
  // so the two never show different numbers. Seeds from the server
  // first-paint stats and keeps polling while visible so the Outbox
  // badge stays current even when the operator is parked on Inbox.
  const [liveQueueStatsFailed, setLiveQueueStatsFailed] =
    useState(queueStatsFailed);
  const [lastServerQueueStatsFailed, setLastServerQueueStatsFailed] =
    useState(queueStatsFailed);
  const [lastQueueStatsSuccessAt, setLastQueueStatsSuccessAt] = useState<
    string | null
  >(queueStatsFailed ? null : "server-snapshot");
  const [queueStatsRefreshSignal, setQueueStatsRefreshSignal] = useState(0);
  if (lastServerQueueStatsFailed !== queueStatsFailed) {
    setLastServerQueueStatsFailed(queueStatsFailed);
    setLiveQueueStatsFailed(queueStatsFailed);
    if (!queueStatsFailed) setLastQueueStatsSuccessAt("server-snapshot");
  }
  const handleQueueStatsRefreshSuccess = useCallback((refreshedAt: string) => {
    setLiveQueueStatsFailed(false);
    setLastQueueStatsSuccessAt(refreshedAt);
  }, []);
  const handleQueueStatsRefreshFailure = useCallback(
    () => setLiveQueueStatsFailed(true),
    [],
  );
  const liveQueueStats = useQueueStats(queueStats, {
    refreshSignal: queueStatsRefreshSignal,
    onRefreshSuccess: handleQueueStatsRefreshSuccess,
    onRefreshFailure: handleQueueStatsRefreshFailure,
  });

  const setTab = (next: string) => {
    setPendingInboxChange(null);
    setCompletedInboxChange(null);
    const sp = new URLSearchParams(searchParams.toString());
    if (next === "inbox") {
      sp.delete("tab");
    } else {
      sp.set("tab", next);
    }
    const qs = sp.toString();
    router.replace(qs ? `/messages?${qs}` : "/messages");
  };
  const setInboxPage = useCallback(
    (nextPage: number) => {
      setPendingInboxChange(null);
      setCompletedInboxChange(null);
      const sp = new URLSearchParams(searchParams.toString());
      if (nextPage <= 1) sp.delete("inboxPage");
      else sp.set("inboxPage", String(nextPage));
      sp.delete("thread");
      const qs = sp.toString();
      router.replace(qs ? `/messages?${qs}` : "/messages");
    },
    [router, searchParams],
  );
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
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
  const serverSelectedThreadId =
    selectedThreadId ?? threadDetail?.threadId ?? null;
  const previousServerSelection = useRef(serverSelectedThreadId);
  const [mobileShowsDetail, setMobileShowsDetail] = useState(
    serverSelectedThreadId !== null,
  );
  const [focusReturnThreadId, setFocusReturnThreadId] = useState<string | null>(
    null,
  );

  const handleSelectThread = useCallback(
    (threadId: string) => {
      setPendingInboxChange(null);
      setCompletedInboxChange(null);
      setPendingThreadId(threadId);
      setMobileShowsDetail(true);
      setFocusReturnThreadId(null);
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("thread", threadId);
      router.replace(`/messages?${sp.toString()}`, { scroll: false });
    },
    [searchParams, router],
  );

  useEffect(() => {
    if (previousServerSelection.current === serverSelectedThreadId) return;
    previousServerSelection.current = serverSelectedThreadId;
    setMobileShowsDetail(serverSelectedThreadId !== null);
  }, [serverSelectedThreadId]);

  const handleBackToList = useCallback(() => {
    setPendingInboxChange(null);
    setCompletedInboxChange(null);
    const returningThreadId =
      pendingThreadId ?? threadDetail?.threadId ?? selectedThreadId ?? null;
    setPendingThreadId(null);
    setMobileShowsDetail(false);
    setFocusReturnThreadId(returningThreadId);
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete("thread");
    const qs = sp.toString();
    router.replace(qs ? `/messages?${qs}` : "/messages", { scroll: false });
    router.refresh();
  }, [
    pendingThreadId,
    router,
    searchParams,
    selectedThreadId,
    threadDetail?.threadId,
  ]);

  useEffect(() => {
    if (mobileShowsDetail || !focusReturnThreadId) return;
    const timeout = window.setTimeout(() => {
      const previousRow = document.getElementById(
        `inbox-thread-option-${focusReturnThreadId}`,
      );
      const firstVisibleRow = document.querySelector<HTMLElement>(
        '[data-testid="inbox-thread-list"] button',
      );
      const emptyList = document.querySelector<HTMLElement>(
        '[data-testid="inbox-empty"]',
      );
      (previousRow ?? firstVisibleRow ?? emptyList)?.focus();
      setFocusReturnThreadId(null);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [focusReturnThreadId, mobileShowsDetail]);

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
  }, [
    pendingThreadId,
    router,
    searchParams,
    selectedThreadId,
    threadDetail?.threadId,
  ]);

  // Skeleton shows when the user has clicked a thread that the server
  // hasn't returned yet. Same-thread re-clicks: pendingContactId
  // matches threadDetail.contactId already → no skeleton.
  const isLoadingThread =
    pendingThreadId !== null && selectedThreadId !== pendingThreadId;

  const handleInboxFilterChange = useCallback(
    (next: InboxFilter) => {
      if (
        (pendingInboxChange?.kind === "filter" &&
          pendingInboxChange.value === next) ||
        (pendingInboxChange === null && next === filter)
      ) {
        return;
      }

      setPendingInboxChange({ kind: "filter", value: next });
      setCompletedInboxChange(null);
      setPendingThreadId(null);
      setMobileShowsDetail(false);
      const sp = new URLSearchParams(searchParams.toString());
      if (next === "all") sp.delete("filter");
      else sp.set("filter", next);
      sp.delete("thread");
      sp.delete("inboxPage");
      const qs = sp.toString();
      router.replace(qs ? `/messages?${qs}` : "/messages");
    },
    [filter, pendingInboxChange, router, searchParams],
  );

  const handleHideDncChange = useCallback(
    (nextHideDnc: boolean) => {
      if (
        pendingInboxChange?.kind === "hideDnc" &&
        pendingInboxChange.value === nextHideDnc
      ) {
        return;
      }

      setPendingInboxChange({ kind: "hideDnc", value: nextHideDnc });
      setCompletedInboxChange(null);
      setPendingThreadId(null);
      setMobileShowsDetail(false);
      const sp = new URLSearchParams(searchParams.toString());
      if (nextHideDnc) sp.delete("hideDnc");
      else sp.set("hideDnc", "0");
      sp.delete("thread");
      sp.delete("inboxPage");
      const qs = sp.toString();
      router.replace(qs ? `/messages?${qs}` : "/messages");
    },
    [pendingInboxChange, router, searchParams],
  );

  useEffect(() => {
    if (pendingInboxChange === null) return undefined;
    const settled =
      pendingInboxChange.kind === "filter"
        ? pendingInboxChange.value === filter
        : pendingInboxChange.value === hideDnc;
    if (!settled) return undefined;
    const timeout = window.setTimeout(() => {
      setPendingInboxChange(null);
      setCompletedInboxChange(pendingInboxChange);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [filter, hideDnc, pendingInboxChange]);

  useEffect(() => {
    const cancelPendingOnHistoryNavigation = () => {
      setPendingInboxChange(null);
      setCompletedInboxChange(null);
    };
    window.addEventListener("popstate", cancelPendingOnHistoryNavigation);
    return () =>
      window.removeEventListener("popstate", cancelPendingOnHistoryNavigation);
  }, []);

  const isFilterPending = pendingInboxChange !== null;

  return (
    <Page className="pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-8">
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Messages" }]}
        title="Messages"
        description="Live conversations on the Inbox tab; queued bulk sends on the Outbox tab."
        actions={
          <button
            type="button"
            data-testid="messages-new-message"
            onClick={() => router.push(`/leads?compose=1`)}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[12px] font-bold text-primary-foreground transition-opacity hover:opacity-90"
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
        aria-orientation="horizontal"
        onKeyDown={handleTabKeyDown}
        className="flex gap-6 border-b border-border"
      >
        <TabButton
          label="Inbox"
          count={inboxTotal}
          active={activeTab === "inbox"}
          onClick={() => setTab("inbox")}
          testId="tab-inbox"
        />
        <TabButton
          label="Outbox"
          stats={liveQueueStats}
          statsUnavailable={liveQueueStatsFailed}
          active={activeTab === "outbox"}
          onClick={() => setTab("outbox")}
          testId="tab-outbox"
        />
      </div>

      {activeTab === "inbox" ? (
        <div
          id="messages-inbox-panel"
          role="tabpanel"
          aria-labelledby="messages-inbox-tab"
          className="flex flex-col gap-4"
        >
          <InboxFilters
            active={filter}
            filterCounts={filterCounts}
            showAssignmentChips={currentUserId !== null}
            hideDnc={hideDnc}
            hiddenDncCount={hiddenDncCount}
            pendingChange={pendingInboxChange}
            completedChange={completedInboxChange}
            onFilterChange={handleInboxFilterChange}
            onHideDncChange={handleHideDncChange}
          />

          <div
            aria-busy={isFilterPending}
            inert={isFilterPending}
            className={`rounded-lg transition-shadow duration-150 motion-reduce:transition-none ${
              isFilterPending ? "cursor-wait ring-1 ring-primary/20" : "ring-0"
            }`}
            data-testid="inbox-filter-results"
          >
            {showThreadList && (
              <div
                className="grid min-h-[500px] grid-cols-1 gap-3 md:h-[calc(100vh-260px)] md:grid-cols-[minmax(280px,360px)_1fr] md:gap-6"
                data-testid="inbox-cockpit-grid"
              >
                <div
                  className={`${mobileShowsDetail ? "hidden" : "block"} min-h-0 md:block`}
                  data-testid="inbox-list-view"
                >
                  <div className="flex h-full min-h-0 flex-col gap-2">
                    <div className="min-h-0 flex-1">
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
                        emptyMessage={emptyInboxMessage(
                          filter,
                          hiddenDncCount,
                        )}
                        nowMs={liveNowMs}
                      />
                    </div>
                    {inboxTotalPages > 1 ? (
                      <nav
                        aria-label="Inbox pages"
                        className="flex min-h-11 items-center justify-between gap-2 text-xs text-muted-foreground"
                        data-testid="inbox-pagination"
                      >
                        <button
                          type="button"
                          className="min-h-11 rounded-md border px-3 font-semibold disabled:opacity-40"
                          disabled={inboxPage <= 1}
                          onClick={() => setInboxPage(inboxPage - 1)}
                        >
                          Previous
                        </button>
                        <span className="text-center" aria-live="polite">
                          Page {inboxPage} of {inboxTotalPages} ·{" "}
                          {inboxTotal.toLocaleString()} conversations
                        </span>
                        <button
                          type="button"
                          className="min-h-11 rounded-md border px-3 font-semibold disabled:opacity-40"
                          disabled={inboxPage >= inboxTotalPages}
                          onClick={() => setInboxPage(inboxPage + 1)}
                        >
                          Next
                        </button>
                      </nav>
                    ) : null}
                  </div>
                </div>
                <div
                  className={`${mobileShowsDetail ? "block" : "hidden"} min-h-0 md:block`}
                  data-testid="inbox-detail-view"
                >
                  <InboxDetail
                    data={threadDetail}
                    isLoading={isLoadingThread}
                    assigneeEmails={assigneeEmails}
                    currentUserId={currentUserId}
                    onBackToList={handleBackToList}
                    nowMs={liveNowMs}
                  />
                </div>
              </div>
            )}

            {filter === "unknown" && (
              <UnknownSenderList
                senders={unknownSenders}
                showRestore={false}
                nowMs={liveNowMs}
              />
            )}

            {filter === "dismissed" && (
              <UnknownSenderList
                senders={unknownSenders}
                showRestore={true}
                nowMs={liveNowMs}
              />
            )}
          </div>
        </div>
      ) : (
        <div
          id="messages-outbox-panel"
          role="tabpanel"
          aria-labelledby="messages-outbox-tab"
        >
          <QueueStatsBanner
            stats={liveQueueStats}
            loadFailed={liveQueueStatsFailed}
            lastSuccessfulAt={lastQueueStatsSuccessAt}
            onRetry={() => setQueueStatsRefreshSignal((current) => current + 1)}
            nowMs={liveNowMs}
          />
          <QueuePanel
            initial={queued}
            initialHasMore={queuedHasMore}
            totalQueued={liveQueueStats.queued}
            initialLoadFailed={queueLoadFailed}
            nowMs={liveNowMs}
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
        className="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-2xl transition-transform hover:scale-105"
      >
        <MessageSquarePlusIcon className="h-6 w-6" />
      </button>
    </Page>
  );
}

function useLiveNow(seedNowMs: number): number {
  const [clock, setClock] = useState({ seedNowMs, value: seedNowMs });
  if (clock.seedNowMs !== seedNowMs) {
    setClock({ seedNowMs, value: seedNowMs });
  }

  useEffect(() => {
    const tick = () => {
      setClock((current) => ({
        ...current,
        value: Math.max(current.value, Date.now()),
      }));
    };
    const intervalId = window.setInterval(tick, LIVE_CLOCK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return clock.value;
}

function TabButton({
  label,
  count,
  stats,
  statsUnavailable = false,
  active,
  onClick,
  testId,
}: {
  label: string;
  /** Simple count pill (Inbox). */
  count?: number;
  /** Queue figures: queued · sent out today (green) · failed today (red) (Outbox). */
  stats?: QueueStats;
  /** The server failed to establish first-paint totals. Do not render its
   * zero fallback as though those counts were confirmed. */
  statsUnavailable?: boolean;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`messages-${label.toLowerCase()}-tab`}
      aria-controls={`messages-${label.toLowerCase()}-panel`}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-testid={testId}
      onClick={onClick}
      className={`-mb-px flex min-h-11 items-center gap-2 border-b-2 pb-2 text-[14px] font-bold transition-colors ${
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
      {statsUnavailable ? (
        <span
          className="text-destructive text-[11px] font-bold"
          title="Queue totals unavailable; retrying automatically"
          data-testid={`${testId}-stats-unavailable`}
        >
          Unavailable
        </span>
      ) : stats ? (
        <span
          className="flex items-center gap-1.5 text-[11px] font-bold"
          title={`${stats.queued} queued${stats.paused > 0 ? ` · ${stats.paused} paused` : ""} · ${stats.sentOutToday} sent out today · ${stats.failedToday} failed today`}
          data-testid={`${testId}-stats`}
        >
          {/* Queued inherits the tab text color; sent/failed keep their
              status colors in both active and inactive states. */}
          <span>{stats.queued}</span>
          {stats.paused > 0 ? (
            <>
              <span className="text-[#a8a29e]">·</span>
              <span className="text-amber-600">{stats.paused}</span>
            </>
          ) : null}
          <span className="text-[#a8a29e]">·</span>
          <span className="text-emerald-600">{stats.sentOutToday}</span>
          <span className="text-[#a8a29e]">·</span>
          <span className="text-red-600">{stats.failedToday}</span>
        </span>
      ) : null}
    </button>
  );
}

function emptyInboxMessage(
  filter: InboxFilter,
  hiddenDncCount: number,
): string {
  if (filter === "all" && hiddenDncCount === 0) {
    return "No conversations yet. Inbound messages will appear here.";
  }
  if (hiddenDncCount > 0) {
    return `No conversations under this filter. ${hiddenDncCount} restricted or test ${hiddenDncCount === 1 ? "thread is" : "threads are"} hidden.`;
  }
  return "No conversations under this filter. Try a different filter.";
}
