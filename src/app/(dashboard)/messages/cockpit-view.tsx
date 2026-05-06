"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Messages" }]}
        title="Messages"
        description="Live conversations on the Inbox tab; queued bulk sends on the Outbox tab. Both flow through the same SMS provider; consent and quiet-hours are checked on every send."
      />

      <Tabs
        value={activeTab}
        onValueChange={(v) => setTab(String(v))}
      >
        <TabsList>
          <TabsTrigger value="inbox" data-testid="tab-inbox">
            Inbox
            {threads.some((t) => t.unreadCount > 0) ? (
              <span className="bg-primary text-primary-foreground ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px]">
                {threads.reduce((n, t) => n + t.unreadCount, 0)}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="outbox" data-testid="tab-outbox">
            Outbox
            {queued.length > 0 ? (
              <span className="bg-secondary text-secondary-foreground ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px]">
                {queued.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="inbox">
          <div className="mt-4 flex flex-col gap-3">
            <InboxFilters
              active={filter}
              unknownCount={unknownActiveCount}
              unreadCount={threads.filter((t) => t.unreadCount > 0).length}
              showAssignmentChips={currentUserId !== null}
            />

            {showThreadList && (
              <div
                className="grid h-[calc(100vh-260px)] min-h-[500px] grid-cols-[minmax(280px,360px)_1fr] gap-4"
                data-testid="inbox-cockpit-grid"
              >
                <InboxThreadList
                  initial={threads}
                  selectedContactId={threadDetail?.contactId ?? null}
                  assigneeEmails={assigneeEmails}
                  currentUserId={currentUserId}
                />
                <InboxDetail
                  data={threadDetail}
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
        </TabsContent>

        <TabsContent value="outbox">
          <div className="mt-4">
            <QueueStatsBanner initialStats={queueStats} />
            <QueuePanel initial={queued} />
          </div>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
