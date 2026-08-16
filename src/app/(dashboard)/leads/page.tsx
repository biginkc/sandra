import Image from "next/image";
import Link from "next/link";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { LEAD_SOURCES } from "@/lib/leads/create";
import { createClient } from "@/lib/supabase/server";
import { getDayBoundsInZone } from "@/lib/time/zoned";

import { AddLeadDialog } from "./add-lead-dialog";
import { listOrgUsers } from "./actions";
import { fetchLeadBoardData, type LeadBoardFilters } from "./board-query";
import { Kanban } from "./kanban";
import { LeadsLoadError } from "./load-error";
import { resolveInboundLeadFilters } from "./inbound-filters";

export const metadata = { title: "Leads · Sandra CRM" };

type LeadsSearchParams = {
  status?: string;
  assignee?: string;
  unassigned?: string;
  no_active_sequence?: string;
  skip_traced?: string;
  stale?: string;
  sequence_ended?: string;
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<LeadsSearchParams>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const [teamResult, { data: counties }] = await Promise.all([
    listOrgUsers(),
    supabase.from("counties").select("market").order("state").order("name"),
  ]);
  const teamMembers = teamResult.ok ? teamResult.data : [];
  const inboundFilters = resolveInboundLeadFilters(params, {
    currentUserId: user?.id ?? null,
    teammateIds: teamMembers.map((member) => member.id),
  });
  const filters: LeadBoardFilters = {
    search: "",
    ownership: inboundFilters.ownership,
    motivation: "all",
    urgency: "all",
    attention: inboundFilters.attention,
    hotOnly: params.status === "hot",
    noActiveSequence: params.no_active_sequence === "true",
    skipTraced:
      params.skip_traced === "false" ? false : params.skip_traced === "true" ? true : null,
  };
  const assigneeId =
    inboundFilters.ownership === "mine"
      ? user?.id ?? null
      : inboundFilters.ownership !== "all" && inboundFilters.ownership !== "unassigned"
        ? inboundFilters.ownership
        : null;
  const { dayStart, dayEnd } = getDayBoundsInZone(new Date(), "America/Chicago");
  let board = null;
  let loadFailed = false;
  try {
    board = await fetchLeadBoardData(supabase, filters, {
      currentUserId: user?.id ?? "",
      assigneeId,
      unassigned: inboundFilters.ownership === "unassigned",
      dayStart: dayStart.toISOString(),
      dayEnd: dayEnd.toISOString(),
    });
  } catch {
    loadFailed = true;
  }

  const assigneeEmails = Object.fromEntries(teamMembers.map((member) => [member.id, member.email]));
  const markets = Array.from(new Set((counties ?? []).map((county) => county.market).filter(Boolean)));
  const activeFilter = describeFilter(params);
  const hasInboundFilter =
    inboundFilters.ownership !== "all" ||
    inboundFilters.attention !== null ||
    filters.hotOnly || filters.noActiveSequence || filters.skipTraced !== null;
  const totalLeads = board ? Object.values(board.totals).reduce((sum, count) => sum + count, 0) : 0;
  const renderedAt = new Date();

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Leads" }]}
        title="Leads"
        description="Drag to move leads through the pipeline."
        actions={
          <AddLeadDialog
            markets={markets}
            sources={Array.from(LEAD_SOURCES)}
            teamMembers={teamMembers}
            currentUserId={user?.id ?? null}
          />
        }
      />

      {activeFilter ? (
        <div className="border-border bg-muted/40 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm">
          <span className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">Filter</span>
          <span className="text-foreground font-bold">{activeFilter.label}</span>
          {activeFilter.note ? <span className="text-muted-foreground">— {activeFilter.note}</span> : null}
          <Link href="/leads" className="text-foreground ml-auto text-xs font-bold underline-offset-4 hover:underline">
            Clear filter
          </Link>
        </div>
      ) : null}

      {loadFailed || !board ? (
        <LeadsLoadError />
      ) : totalLeads > 0 || hasInboundFilter ? (
        <Kanban
          key={JSON.stringify(params)}
          initialLeads={board.leads}
          initialTotals={board.totals}
          initialBaselineTotals={board.baselineTotals ?? board.totals}
          initialUrgencyCounts={board.urgencyCounts ?? {
            all: totalLeads, overdue: 0, today: 0, scheduled: 0, none: 0,
          }}
          initialNextCursors={board.nextCursors}
          initialHasMore={board.hasMore}
          initialFilters={filters}
          dayStart={dayStart.toISOString()}
          dayEnd={dayEnd.toISOString()}
          unreadPropertyIds={board.unreadPropertyIds}
          assigneeEmails={assigneeEmails}
          teamMembers={teamMembers}
          currentUserId={user?.id ?? null}
          listMemberships={board.listMemberships}
          customTags={board.customTags}
          lastMessageByPropertyId={board.lastMessageByPropertyId}
          initialOwnership={inboundFilters.ownership}
          initialAttentionFilter={inboundFilters.attention}
          hasInboundFilter={hasInboundFilter}
          inboundScopeLabel={activeFilter?.label ?? null}
          renderedAt={renderedAt.toISOString()}
        />
      ) : (
        <div className="border-border bg-card flex min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed p-8 text-center">
          <Image src="/brand/mascot.svg" alt="Sandra" width={150} height={150} className="mb-4 h-32 w-auto" />
          <h2 className="text-lg font-bold">No leads in the pipeline yet</h2>
          <p className="text-muted-foreground mt-2 max-w-md text-sm">Add a lead to start working the pipeline.</p>
          <div className="mt-5">
            <AddLeadDialog
              markets={markets}
              sources={Array.from(LEAD_SOURCES)}
              teamMembers={teamMembers}
              currentUserId={user?.id ?? null}
            />
          </div>
        </div>
      )}
    </Page>
  );
}

function describeFilter(params: LeadsSearchParams): { label: string; note?: string } | null {
  if (params.status === "hot") return { label: "Hot leads", note: "interested + offer sent" };
  if (params.no_active_sequence === "true") return { label: "Not in a sequence" };
  if (params.skip_traced === "false") return { label: "Not skip-traced", note: "no phone numbers gathered yet" };
  if (params.skip_traced === "true") return { label: "Skip-traced" };
  return null;
}
