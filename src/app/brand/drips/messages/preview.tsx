"use client";

import Image from "next/image";

import { DashboardSidebar } from "@/components/dashboard-sidebar";
import { PageHeader } from "@/components/page-header";
import { InboxDetail } from "@/app/(dashboard)/messages/inbox-detail";
import { InboxFilters } from "@/app/(dashboard)/messages/inbox-filters";
import { InboxThreadList } from "@/app/(dashboard)/messages/inbox-thread-list";

import { brandCantStartDetail, brandDetail, brandThread, brandTimestamp } from "./_fixture";

export function DripMessagesPreview({ cantStart = false }: { cantStart?: boolean }) {
  const thread = cantStart ? { ...brandThread, dripName: "Current seller check-in", dripReplied: false } : brandThread;
  return <div className="flex h-screen min-h-[900px] bg-[#f5f5f4]" data-testid="drips-messages-preview">
    <aside className="nav-field flex w-48 shrink-0 flex-col" aria-label="Preview navigation">
      <div className="mb-4 flex justify-center px-5 pt-5 pb-3"><Image src="/brand/sandra-logo-home.svg" alt="Sandra" width={112} height={114} /></div>
      <DashboardSidebar activePathname="/messages" showCalculators showMyLeads showRecordings />
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between bg-[#14213c] px-5 text-xs text-white"><span>Team　　Webhooks　　AI responder</span><span>Search properties, owners, texts　　　 Sign out</span></div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4">
        <PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Messages" }]} title="Messages" description="Live conversations on the Inbox tab; queued bulk sends on the Outbox tab." />
        <div className="border-b border-stone-200 pb-2 text-sm font-semibold">Inbox <span className="rounded-full bg-stone-900 px-1.5 py-0.5 text-[10px] text-white">4</span><span className="ml-5 font-normal text-stone-500">Outbox</span></div>
        <InboxFilters active="all" filterCounts={{ all: 4, mine: 1, unassigned: 3, unknown: 0, dismissed: 0, unread: 1, escalated: 0, dispo: 0, needs_outcome: 0, drip_replied: 1 }} showAssignmentChips hideDnc hiddenDncCount={0} pendingChange={null} completedChange={null} errorMessage={null} onFilterChange={() => {}} onHideDncChange={() => {}} />
        <div className="grid min-h-0 flex-1 grid-cols-[270px_minmax(0,1fr)] gap-3">
          <InboxThreadList initial={[thread]} selectedThreadId={thread.threadId} currentUserId={null} onSelectThread={() => {}} nowMs={brandTimestamp} />
          <InboxDetail data={cantStart ? brandCantStartDetail : brandDetail} assigneeEmails={{}} currentUserId={null} nowMs={brandTimestamp}
            previewFailedStart={cantStart ? { reason: "Already in a drip", sequenceId: "00000000-0000-4000-8000-000000000006", saved: true } : undefined} />
        </div>
      </div>
    </div>
  </div>;
}
