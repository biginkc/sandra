import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { Kanban } from "./kanban";

export const metadata = {
  title: "Leads · Sandra CRM",
};

export default async function LeadsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Embed the homeowner contact via the FK column so we can search on name
  // and entity. PostgREST aliases the relation as `homeowner` and returns
  // null when no contact is linked. Multi-FK to `contacts` requires the
  // explicit FK constraint name; the `:contacts!fkey` form disambiguates
  // homeowner_contact_id from agent_contact_id.
  const { data: leads, error } = await supabase
    .from("properties")
    .select(
      `id, address, city, state, zip, market, status, is_vacant, cass_status, absentee_flag, assigned_user_id, motivation_level,
       homeowner:contacts!properties_homeowner_contact_id_fkey(first_name, last_name, entity_name)`,
    )
    .order("created_at", { ascending: false })
    .limit(500);

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
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-muted-foreground text-sm">
            Drag to move leads through the pipeline.
            {leads?.length ? (
              <> · Showing the latest {leads.length} of your lead pool.</>
            ) : null}
          </p>
        </div>
        <Link href="/import" className={buttonVariants()}>
          Import CSV
        </Link>
      </div>

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
        />
      ) : (
        <div className="text-muted-foreground border-border rounded-md border border-dashed p-8 text-center text-sm">
          No leads yet. Import a CSV to fill the pipeline.
        </div>
      )}
    </div>
  );
}
