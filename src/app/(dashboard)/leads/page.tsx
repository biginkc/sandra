import Image from "next/image";
import Link from "next/link";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { LEAD_SOURCES } from "@/lib/leads/create";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

import { AddLeadDialog } from "./add-lead-dialog";
import { listOrgUsers } from "./actions";
import { Kanban } from "./kanban";
import { LeadsLoadError } from "./load-error";
import {
  deriveAttentionLeadIds,
  executeInboundScopedLeadQuery,
  resolveInboundLeadFilters,
  type InboundScopedLeadQuery,
} from "./inbound-filters";
import { truncateMessagePreview } from "../properties/prospects-query";

export const metadata = {
  title: "Leads · Sandra CRM",
};

type LeadsSearchParams = {
  status?: string;
  assignee?: string;
  unassigned?: string;
  no_active_sequence?: string;
  skip_traced?: string;
  stale?: string;
  sequence_ended?: string;
};

const LEAD_PAGE_SIZE = 500;
const LEAD_SELECT = `id, address, city, state, zip, market, status, is_vacant, cass_status, absentee_flag, assigned_user_id, motivation_level, outreach_dispo, homeowner, has_unread`;

type LeadRow = Pick<
  Database["public"]["Tables"]["properties"]["Row"],
  | "id"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "market"
  | "status"
  | "is_vacant"
  | "cass_status"
  | "absentee_flag"
  | "assigned_user_id"
  | "motivation_level"
  | "outreach_dispo"
> & {
  homeowner: Pick<
    Database["public"]["Tables"]["contacts"]["Row"],
    "first_name" | "last_name" | "entity_name"
  > | null;
  has_unread: boolean;
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<LeadsSearchParams>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Resolve validated dashboard entry filters before loading the board. The
  // assignee queues must be narrowed in Postgres before the 500-card cap;
  // applying them only in Kanban can silently omit older matching leads.
  const [teamResult, { data: counties }] = await Promise.all([
    listOrgUsers(),
    supabase
      .from("counties")
      .select("market")
      .order("state", { ascending: true })
      .order("name", { ascending: true }),
  ]);
  const teamMembers = teamResult.ok ? teamResult.data : [];
  const inboundFilters = resolveInboundLeadFilters(params, {
    currentUserId: user?.id ?? null,
    teammateIds: teamMembers.map((member) => member.id),
  });

  // Embed the homeowner contact via the FK column so we can search on name
  // and entity. PostgREST aliases the relation as `homeowner` and returns
  // null when no contact is linked. Multi-FK to `contacts` requires the
  // explicit FK constraint name; the `:contacts!fkey` form disambiguates
  // homeowner_contact_id from agent_contact_id.
  // Prospects live on /properties (the data-lake surface) and are promoted
  // into the kanban via qualifyLead(). Filter them out server-side so the
  // kanban query returns only workable pipeline leads.
  // The view performs the skip-trace anti-join in Postgres.  It avoids both
  // unbounded cache reads and an URL-sized property-id/address list.
  const leadTable = params.skip_traced === "false" ? "leads_unskip_traced" : "leads_board";
  let q = supabase
    .from(leadTable)
    .select(LEAD_SELECT)
    .neq("status", "prospect")
    .is("deleted_at", null)
    // Hide leads that were dispositioned dead — but only while they're
    // still pre-traction (new_lead/contacted). `outreach_dispo` is a
    // separate axis from `status` (migration 045) and setOutreachDispo()
    // never touches `status`, so without this filter a lead marked
    // wrong-number / not-interested / DNC stays in the kanban forever.
    // Without the status guard, though, the filter would also hide real
    // deal progress — e.g. under_contract + a stale `dnc` dispo, or
    // offer_sent + `not_interested` — since dispo can be set (or left
    // stale) independent of how far the deal has actually moved. Once a
    // lead has advanced past contacted, deal status is the source of
    // truth and outreach_dispo no longer hides it.
    // Keep nurture + callback_requested (live follow-ups) and any lead
    // never dispositioned (outreach_dispo IS NULL) — the explicit is.null
    // disjunct is required because Postgres `NOT IN` drops NULL rows.
    .or(
      "outreach_dispo.is.null,outreach_dispo.not.in.(wrong_number,bad_number,not_interested,opted_out,dnc),status.not.in.(new_lead,contacted)",
    );

  // Dashboard click-through: hot leads (interested + offer_sent).
  if (params.status === "hot") {
    q = q.in("status", ["interested", "offer_sent"]);
  }

  // Dashboard click-through: leads not in a sequence right now.
  // Two-step: pull active enrollment property_ids, then exclude them.
  if (params.no_active_sequence === "true") {
    const { data: enrolled } = await supabase
      .from("sequence_enrollments")
      .select("property_id")
      .eq("status", "active");
    const ids = (enrolled ?? [])
      .map((r) => r.property_id)
      .filter((v): v is string => Boolean(v));
    if (ids.length > 0) {
      q = q.not("id", "in", `(${ids.join(",")})`);
    }
  }

  const { data: fetchedLeads, error } = await executeInboundScopedLeadQuery(
    q as unknown as InboundScopedLeadQuery<LeadRow>,
    inboundFilters.ownership,
    user?.id ?? null,
    LEAD_PAGE_SIZE + 1,
  );
  const wasTruncated = (fetchedLeads?.length ?? 0) > LEAD_PAGE_SIZE;
  const leads = (fetchedLeads ?? []).slice(0, LEAD_PAGE_SIZE) as LeadRow[];
  const activeFilter = describeFilter(params);

  const assigneeEmails = Object.fromEntries(
    teamMembers.map((member) => [member.id, member.email]),
  );
  const markets = Array.from(
    new Set((counties ?? []).map((county) => county.market).filter(Boolean)),
  );
  const hasInboundFilter =
    inboundFilters.ownership !== "all" || inboundFilters.attention !== null;

  // `has_unread` is computed by the board view, so this page does not issue an
  // unbounded messages query or send a 500-id URL to PostgREST.
  const visibleLeadIds = leads.map((l) => l.id);
  const shownPropertyIds = visibleLeadIds;
  const lastMessagesPromise = shownPropertyIds.length
    ? supabase
        .from("messages")
        .select("property_id, direction, body, created_at")
        .in("property_id", shownPropertyIds)
        .order("created_at", { ascending: false })
    : Promise.resolve({
        data: [] as {
          property_id: string | null;
          direction: string;
          body: string | null;
          created_at: string;
        }[],
        error: null,
      });
  const membershipsPromise = shownPropertyIds.length
    ? supabase
        .from("property_lists")
        .select("property_id, list_id, lists!property_lists_list_id_fkey(name, color, archived_at)")
        .in("property_id", shownPropertyIds)
    : Promise.resolve({ data: [] as never[] });
  const tagsPromise = shownPropertyIds.length
    ? supabase
        .from("property_tags")
        .select("property_id, tag_id, tags!property_tags_tag_id_fkey(name, color, category)")
        .in("property_id", shownPropertyIds)
    : Promise.resolve({ data: [] as never[] });
  const completedEnrollmentsPromise =
    shownPropertyIds.length && inboundFilters.attention === "sequence_ended"
      ? supabase
          .from("sequence_enrollments")
          .select("property_id, completed_at")
          .in("property_id", shownPropertyIds)
          .eq("status", "completed")
          .not("completed_at", "is", null)
      : Promise.resolve({
          data: [] as { property_id: string | null; completed_at: string | null }[],
          error: null,
        });
  const [
    { data: lastMsgRows, error: lastMessagesError },
    { data: memberships },
    { data: pTags },
    { data: completedEnrollments, error: completedEnrollmentsError },
  ] = await Promise.all([
    lastMessagesPromise,
    membershipsPromise,
    tagsPromise,
    completedEnrollmentsPromise,
  ]);
  const renderedAt = new Date();
  const attentionLeadIds = deriveAttentionLeadIds({
    leads,
    messages: lastMsgRows ?? [],
    completedEnrollments: completedEnrollments ?? [],
    now: renderedAt,
  });
  const attentionLoadFailed =
    inboundFilters.attention !== null &&
    Boolean(
      lastMessagesError ||
        (inboundFilters.attention === "sequence_ended" &&
          completedEnrollmentsError),
    );
  const unreadPropertyIds = new Set<string>();
  for (const lead of leads) {
    if (lead.has_unread) unreadPropertyIds.add(lead.id);
  }

  // Latest message per property in the visible kanban — drives the
  // italic-quoted preview under each lead card. Same shape as the
  // prospects table's last-message column. Single batched query, then
  // walk in JS taking the first row per property_id (ordered desc).
  const lastMessageByPropertyId: Record<
    string,
    { direction: "inbound" | "outbound"; body: string; createdAt: string }
  > = {};
  for (const m of lastMsgRows ?? []) {
    if (!m.property_id) continue;
    if (lastMessageByPropertyId[m.property_id] !== undefined) continue;
    const preview = truncateMessagePreview(m.body ?? null);
    if (preview) {
      lastMessageByPropertyId[m.property_id] = {
        direction: m.direction === "inbound" ? "inbound" : "outbound",
        body: preview,
        createdAt: m.created_at,
      };
    }
  }

  // List memberships for the shown properties. One query, then group in
  // JS — PostgREST embedded resource with a filter would need the FK name
  // dance, and a flat join is simpler. The kanban card renders up to 3
  // list name badges and a "3 lists" stack chip.
  const listMembershipsByProperty = new Map<
    string,
    { listId: string; name: string; color: string | null }[]
  >();
  for (const m of memberships ?? []) {
    // Exclude archived lists — memberships stay in the table, but the
    // card shouldn't advertise a cohort that's been retired.
    const list = m.lists as
      | { name: string; color: string | null; archived_at: string | null }
      | null;
    if (!list || list.archived_at) continue;
    const arr = listMembershipsByProperty.get(m.property_id) ?? [];
    arr.push({ listId: m.list_id, name: list.name, color: list.color });
    listMembershipsByProperty.set(m.property_id, arr);
  }
  // Serialize to a plain object for the client component boundary.
  const listMemberships: Record<
    string,
    { listId: string; name: string; color: string | null }[]
  > = {};
  for (const [k, v] of listMembershipsByProperty) listMemberships[k] = v;

  // Custom-category tags per property — only this category shows on the
  // lead card. Auto-applied tags (source, uploaded, skip-trace, etc.)
  // are noise on a compact card; VAs see them on the lead detail.
  const customTagsByProperty = new Map<
    string,
    { tagId: string; name: string; color: string | null }[]
  >();
  for (const r of pTags ?? []) {
    const tag = r.tags as
      | { name: string; color: string | null; category: string }
      | null;
    if (!tag || tag.category !== "custom") continue;
    const arr = customTagsByProperty.get(r.property_id) ?? [];
    arr.push({ tagId: r.tag_id, name: tag.name, color: tag.color });
    customTagsByProperty.set(r.property_id, arr);
  }
  const customTags: Record<
    string,
    { tagId: string; name: string; color: string | null }[]
  > = {};
  for (const [k, v] of customTagsByProperty) customTags[k] = v;

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Leads" }]}
        title="Leads"
        description={
          <>
            Drag to move leads through the pipeline.
            {leads.length ? (
              <>
                {" · Showing the latest "}
                {leads.length}
                {wasTruncated ? " of 500+" : ""} of your lead pool.
              </>
            ) : null}
          </>
        }
        actions={
          <AddLeadDialog
            markets={markets}
            sources={Array.from(LEAD_SOURCES)}
            teamMembers={teamMembers}
            currentUserId={user?.id ?? null}
          />
        }
      />

      {activeFilter && (
        <div className="border-border bg-muted/40 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm">
          <span className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
            Filter
          </span>
          <span className="text-foreground font-bold">{activeFilter.label}</span>
          {activeFilter.note && (
            <span className="text-muted-foreground">— {activeFilter.note}</span>
          )}
          <Link
            href="/leads"
            className="text-foreground ml-auto text-xs font-bold underline-offset-4 hover:underline"
          >
            Clear filter
          </Link>
        </div>
      )}

      {error || attentionLoadFailed ? (
        <LeadsLoadError />
      ) : leads.length > 0 || hasInboundFilter ? (
        <Kanban
          key={JSON.stringify(params)}
          initialLeads={leads}
          unreadPropertyIds={Array.from(unreadPropertyIds)}
          assigneeEmails={assigneeEmails}
          teamMembers={teamMembers}
          currentUserId={user?.id ?? null}
          listMemberships={listMemberships}
          customTags={customTags}
          lastMessageByPropertyId={lastMessageByPropertyId}
          attentionLeadIds={attentionLeadIds}
          initialOwnership={inboundFilters.ownership}
          initialAttentionFilter={inboundFilters.attention}
          hasInboundFilter={hasInboundFilter}
          renderedAt={renderedAt.toISOString()}
        />
      ) : (
        <div className="border-border bg-card flex min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed p-8 text-center">
          {activeFilter ? (
            <>
              <h2 className="text-lg font-bold">No leads match this view</h2>
              <p className="text-muted-foreground mt-2 max-w-md text-sm">
                Clear the dashboard filter to return to the full pipeline.
              </p>
              <Link
                href="/leads"
                className="bg-primary text-primary-foreground mt-5 inline-flex h-11 items-center justify-center rounded-full px-8 text-sm font-bold"
              >
                Clear filter
              </Link>
            </>
          ) : (
            <>
              <Image
                src="/brand/mascot.svg"
                alt="Sandra"
                width={150}
                height={150}
                className="mb-4 h-32 w-auto"
              />
              <h2 className="text-lg font-bold">No leads in the pipeline yet</h2>
              <p className="text-muted-foreground mt-2 max-w-md text-sm">
                Add a lead to start working the pipeline.
              </p>
              <div className="mt-5">
                <AddLeadDialog
                  markets={markets}
                  sources={Array.from(LEAD_SOURCES)}
                  teamMembers={teamMembers}
                  currentUserId={user?.id ?? null}
                />
              </div>
            </>
          )}
        </div>
      )}
    </Page>
  );
}

function describeFilter(
  params: LeadsSearchParams,
): { label: string; note?: string } | null {
  if (params.status === "hot") {
    return { label: "Hot leads", note: "interested + offer sent" };
  }
  if (params.no_active_sequence === "true") {
    return { label: "Not in a sequence" };
  }
  if (params.skip_traced === "false") {
    return { label: "Not skip-traced", note: "no phone numbers gathered yet" };
  }
  return null;
}
