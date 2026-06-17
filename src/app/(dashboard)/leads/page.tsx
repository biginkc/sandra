import Link from "next/link";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { Kanban } from "./kanban";
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

  // Embed the homeowner contact via the FK column so we can search on name
  // and entity. PostgREST aliases the relation as `homeowner` and returns
  // null when no contact is linked. Multi-FK to `contacts` requires the
  // explicit FK constraint name; the `:contacts!fkey` form disambiguates
  // homeowner_contact_id from agent_contact_id.
  // Prospects live on /properties (the data-lake surface) and are promoted
  // into the kanban via qualifyLead(). Filter them out server-side so the
  // kanban query returns only workable pipeline leads.
  let q = supabase
    .from("properties")
    .select(
      `id, address, city, state, zip, market, status, is_vacant, cass_status, absentee_flag, assigned_user_id, motivation_level,
       homeowner:contacts!properties_homeowner_contact_id_fkey(first_name, last_name, entity_name)`,
    )
    .neq("status", "prospect")
    .is("deleted_at", null)
    // Hide leads that were dispositioned dead. Disposition writes
    // `outreach_dispo` but never reverts `status`, so without this filter a
    // lead marked wrong-number / not-interested / DNC stays in the kanban
    // forever. Keep nurture + callback_requested (live follow-ups) and any
    // lead never dispositioned (outreach_dispo IS NULL) — the explicit
    // is.null disjunct is required because Postgres `NOT IN` drops NULL rows.
    .or(
      "outreach_dispo.is.null,outreach_dispo.not.in.(wrong_number,bad_number,not_interested,opted_out,dnc)",
    );

  // Dashboard click-through: hot leads (interested + offer_sent).
  if (params.status === "hot") {
    q = q.in("status", ["interested", "offer_sent"]);
  }

  // Dashboard click-through: assignee filter. "me" resolves to current user.
  const assigneeId = params.assignee === "me" ? user?.id : params.assignee;
  if (assigneeId) {
    q = q.eq("assigned_user_id", assigneeId);
  }

  // Dashboard click-through: unassigned leads.
  if (params.unassigned === "true") {
    q = q.is("assigned_user_id", null);
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

  // Dashboard click-through: leads with no skip-trace cache row for their
  // address — the "phone numbers gathering" gap. Two-step: collect traced
  // property ids (UUIDs), then exclude them. Going via id (not the raw
  // address) keeps the not-in clause safe regardless of address content.
  if (params.skip_traced === "false") {
    const { data: tracedAddresses } = await supabase
      .from("skip_trace_cache")
      .select("address_normalized");
    const addrs = (tracedAddresses ?? [])
      .map((r) => r.address_normalized)
      .filter((v): v is string => Boolean(v));
    if (addrs.length > 0) {
      const { data: tracedProps } = await supabase
        .from("properties")
        .select("id")
        .in("address_normalized", addrs);
      const tracedIds = (tracedProps ?? []).map((p) => p.id);
      if (tracedIds.length > 0) {
        q = q.not("id", "in", `(${tracedIds.join(",")})`);
      }
    }
  }

  const { data: leads, error } = await q
    .order("created_at", { ascending: false })
    .limit(500);
  const activeFilter = describeFilter(params);

  // Which properties have any unread inbound messages? One tiny query against
  // the partial index `idx_messages_unread_inbound`, deduped to a Set that
  // the kanban uses to render a red dot on the card.
  const { data: unreadRows } = await supabase
    .from("messages")
    .select("property_id")
    .eq("direction", "inbound")
    .is("read_at", null)
    .not("property_id", "is", null);
  const unreadPropertyIds = new Set<string>();
  for (const r of unreadRows ?? []) {
    if (r.property_id) unreadPropertyIds.add(r.property_id);
  }

  // Latest message per property in the visible kanban — drives the
  // italic-quoted preview under each lead card. Same shape as the
  // prospects table's last-message column. Single batched query, then
  // walk in JS taking the first row per property_id (ordered desc).
  const visibleLeadIds = (leads ?? []).map((l) => l.id);
  const lastMessageByPropertyId: Record<string, string> = {};
  if (visibleLeadIds.length > 0) {
    const { data: lastMsgRows } = await supabase
      .from("messages")
      .select("property_id, body, created_at")
      .in("property_id", visibleLeadIds)
      .order("created_at", { ascending: false });
    for (const m of lastMsgRows ?? []) {
      if (!m.property_id) continue;
      if (lastMessageByPropertyId[m.property_id] !== undefined) continue;
      const preview = truncateMessagePreview(m.body ?? null);
      if (preview) lastMessageByPropertyId[m.property_id] = preview;
    }
  }

  // List memberships for the shown properties. One query, then group in
  // JS — PostgREST embedded resource with a filter would need the FK name
  // dance, and a flat join is simpler. The kanban card renders up to 3
  // list name badges and a "3 lists" stack chip.
  const shownPropertyIds = (leads ?? []).map((l) => l.id);
  const listMembershipsByProperty = new Map<
    string,
    { listId: string; name: string; color: string | null }[]
  >();
  if (shownPropertyIds.length > 0) {
    const { data: memberships } = await supabase
      .from("property_lists")
      .select("property_id, list_id, lists!property_lists_list_id_fkey(name, color, archived_at)")
      .in("property_id", shownPropertyIds);
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
  if (shownPropertyIds.length > 0) {
    const { data: pTags } = await supabase
      .from("property_tags")
      .select("property_id, tag_id, tags!property_tags_tag_id_fkey(name, color, category)")
      .in("property_id", shownPropertyIds);
    for (const r of pTags ?? []) {
      const tag = r.tags as
        | { name: string; color: string | null; category: string }
        | null;
      if (!tag || tag.category !== "custom") continue;
      const arr = customTagsByProperty.get(r.property_id) ?? [];
      arr.push({ tagId: r.tag_id, name: tag.name, color: tag.color });
      customTagsByProperty.set(r.property_id, arr);
    }
  }
  const customTags: Record<
    string,
    { tagId: string; name: string; color: string | null }[]
  > = {};
  for (const [k, v] of customTagsByProperty) customTags[k] = v;

  // Resolve assignee ids → emails (for the "assigned: bob@…" chip). Admin
  // client batches all users in one call. Non-fatal on failure.
  const assigneeEmails: Record<string, string> = {};
  const assigneeIds = new Set<string>();
  for (const l of leads ?? []) {
    if (l.assigned_user_id) assigneeIds.add(l.assigned_user_id);
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
      // Ignore — ids still render, just without pretty labels.
    }
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Leads" }]}
        title="Leads"
        description={
          <>
            Drag to move leads through the pipeline.
            {leads?.length ? (
              <> · Showing the latest {leads.length} of your lead pool.</>
            ) : null}
          </>
        }
        actions={
          <Link href="/import" className={buttonVariants()}>
            Import CSV
          </Link>
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

      {error ? (
        <div className="text-destructive text-sm">
          Failed to load leads: {error.message}
        </div>
      ) : leads && leads.length > 0 ? (
        <Kanban
          initialLeads={leads}
          unreadPropertyIds={Array.from(unreadPropertyIds)}
          assigneeEmails={assigneeEmails}
          currentUserId={user?.id ?? null}
          listMemberships={listMemberships}
          customTags={customTags}
          lastMessageByPropertyId={lastMessageByPropertyId}
        />
      ) : (
        <div className="text-muted-foreground border-border rounded-md border border-dashed p-8 text-center text-sm">
          {activeFilter
            ? `No leads match "${activeFilter.label}". Clear the filter to see all leads.`
            : "No leads yet. Import a CSV to fill the pipeline."}
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
  if (params.assignee === "me") return { label: "Assigned to me" };
  if (params.assignee) {
    return { label: `Assigned to ${params.assignee.slice(0, 8)}…` };
  }
  if (params.unassigned === "true") return { label: "Unassigned" };
  if (params.no_active_sequence === "true") {
    return { label: "Not in a sequence" };
  }
  if (params.skip_traced === "false") {
    return { label: "Not skip-traced", note: "no phone numbers gathered yet" };
  }
  if (params.stale === "true") {
    return {
      label: "Stale conversations",
      note: "filter coming soon — showing all leads",
    };
  }
  if (params.sequence_ended === "true") {
    return {
      label: "Sequences ended without follow-up",
      note: "filter coming soon — showing all leads",
    };
  }
  return null;
}
