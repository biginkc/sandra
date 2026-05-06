"use client";

import { MessageSquarePlusIcon, PlusIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

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

type Props = {
  activeTab: "inbox" | "outbox";
  filter: InboxFilter;
  threads: Thread[];
  queued: QueuedRow[];
  threadDetail: InboxDetailData | null;
  unknownSenders: UnknownSender[];
  unknownActiveCount: number;
  /** auth.users.id → email map for assignee badges. */
  assigneeEmails: Record<string, string>;
  /** auth.users.id of the current viewer. */
  currentUserId: string | null;
  /** First-paint queue stats — banner above the Outbox table polls + refreshes from here. */
  queueStats: QueueStats;
};

const THREAD_FILTERS = new Set<InboxFilter>(["all", "mine", "unassigned", "unread"]);

export function CockpitView({
  activeTab,
  filter,
  threads,
  queued,
  threadDetail,
  unknownSenders,
  unknownActiveCount,
  assigneeEmails,
  currentUserId,
  queueStats,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

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

  // The thread query param updates instantly on click (router.replace),
  // but threadDetail comes from the next RSC render. While that round-
  // trip is in flight, urlThread !== threadDetail.contactId. Use that
  // mismatch as the "loading a thread" signal so the detail panel can
  // surface a skeleton instead of stale bubbles from the previous click.
  const urlThread = searchParams.get("thread");
  const isLoadingThread =
    urlThread !== null && urlThread !== (threadDetail?.contactId ?? null);

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
          messages-cockpit design. State stays in the URL like before. */}
      <div
        role="tablist"
        aria-label="Inbox / Outbox"
        className="mt-6 flex gap-6 border-b border-border"
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
          count={queued.length}
          active={activeTab === "outbox"}
          onClick={() => setTab("outbox")}
          testId="tab-outbox"
        />
      </div>

      {activeTab === "inbox" ? (
        <div className="mt-4 flex flex-col gap-4">
          <InboxFilters
            active={filter}
            unknownCount={unknownActiveCount}
            unreadCount={threads.filter((t) => t.unreadCount > 0).length}
            showAssignmentChips={currentUserId !== null}
          />

          {showThreadList && (
            <div
              className="grid h-[calc(100vh-260px)] min-h-[500px] grid-cols-[minmax(280px,360px)_1fr] gap-6"
              data-testid="inbox-cockpit-grid"
            >
              <InboxThreadList
                initial={threads}
                selectedContactId={urlThread ?? threadDetail?.contactId ?? null}
                currentUserId={currentUserId}
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
        <div className="mt-4">
          <QueueStatsBanner initialStats={queueStats} />
          <QueuePanel initial={queued} />
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
  active,
  onClick,
  testId,
}: {
  label: string;
  count: number;
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
      <span
        className={`px-2 py-0.5 text-[10px] rounded-full font-bold ${
          active
            ? "bg-primary text-primary-foreground"
            : "bg-[#f5f5f4] text-[#78716c] border border-[#e5e1df]"
        }`}
      >
        {count}
      </span>
    </button>
  );
}
