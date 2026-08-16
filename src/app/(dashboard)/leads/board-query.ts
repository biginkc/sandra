import type { SupabaseClient } from "@supabase/supabase-js";

import { STATUS_ORDER } from "./board-config";
import type { InboundAttentionFilter, InboundOwnershipFilter } from "./inbound-filters";
import type { PropertyStatus } from "./actions";
import type { Database } from "@/lib/supabase/types";
import { truncateMessagePreview } from "../properties/prospects-query";
import type { UrgencyFilter } from "./urgency";

export const LEADS_COLUMN_PAGE_SIZE = 20;

export type LeadBoardCursor = { dueAt: string | null; id: string };

export type LeadBoardFilters = {
  search: string;
  ownership: InboundOwnershipFilter;
  motivation: "hot" | "warm" | "cold" | "unset" | "all";
  urgency: UrgencyFilter;
  attention: InboundAttentionFilter | null;
  hotOnly: boolean;
  noActiveSequence: boolean;
  skipTraced: boolean | null;
};

export type LeadBoardLead = Pick<
  Database["public"]["Views"]["leads_board"]["Row"],
  | "id" | "address" | "city" | "state" | "zip" | "market" | "status"
  | "is_vacant" | "cass_status" | "absentee_flag" | "assigned_user_id"
  | "motivation_level" | "outreach_dispo" | "has_unread" | "next_task_id"
  | "next_task_title" | "next_task_due_at"
> & {
  homeowner: {
    first_name: string | null;
    last_name: string | null;
    entity_name: string | null;
  } | null;
  homeowner_sms_opted_out: boolean | null;
  homeowner_sms_opted_out_at: string | null;
};

export type ListMembership = { listId: string; name: string; color: string | null };
export type CustomTag = { tagId: string; name: string; color: string | null };
export type LastMessage = {
  direction: "inbound" | "outbound";
  body: string;
  createdAt: string;
};

export type LeadBoardData = {
  leads: LeadBoardLead[];
  totals: Record<PropertyStatus, number>;
  baselineTotals: Record<PropertyStatus, number> | null;
  urgencyCounts: Record<UrgencyFilter, number> | null;
  nextCursors: Partial<Record<PropertyStatus, LeadBoardCursor>>;
  hasMore: Partial<Record<PropertyStatus, boolean>>;
  snapshotGenerations: Partial<Record<PropertyStatus, string>>;
  unreadPropertyIds: string[];
  listMemberships: Record<string, ListMembership[]>;
  customTags: Record<string, CustomTag[]>;
  lastMessageByPropertyId: Record<string, LastMessage>;
};

export type LeadBoardQueryContext = {
  currentUserId: string;
  assigneeId: string | null;
  unassigned: boolean;
  dayStart: string;
  dayEnd: string;
};

function rpcFilters(filters: LeadBoardFilters, context: LeadBoardQueryContext) {
  return {
    p_assignee_id: context.assigneeId,
    p_unassigned: context.unassigned,
    p_search_tokens: filters.search.trim().toLowerCase().split(/\s+/).filter(Boolean),
    p_motivation: filters.motivation,
    p_attention: filters.attention,
    p_hot_only: filters.hotOnly,
    p_no_active_sequence: filters.noActiveSequence,
    p_skip_traced: filters.skipTraced,
    p_day_start: context.dayStart,
    p_day_end: context.dayEnd,
  };
}

async function fetchStage(
  supabase: SupabaseClient<Database>,
  stage: PropertyStatus,
  filters: LeadBoardFilters,
  context: LeadBoardQueryContext,
  cursor: LeadBoardCursor | null,
): Promise<{
  rows: LeadBoardLead[];
  total: number;
  nextCursor: LeadBoardCursor | null;
  hasMore: boolean;
  snapshotGeneration: string | null;
}> {
  if (filters.hotOnly && stage !== "interested" && stage !== "offer_sent") {
    return { rows: [], total: 0, nextCursor: null, hasMore: false, snapshotGeneration: null };
  }
  if (context.unassigned && (stage === "closed" || stage === "dead")) {
    return { rows: [], total: 0, nextCursor: null, hasMore: false, snapshotGeneration: null };
  }
  const { data, error } = await supabase.rpc("get_leads_board_page", {
    ...rpcFilters(filters, context),
    p_status: stage,
    p_urgency: filters.urgency,
    p_cursor_due_at: cursor?.dueAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: LEADS_COLUMN_PAGE_SIZE + 1,
  });
  if (error) throw new Error(`Lead page failed for ${stage}: ${error.message}`);
  const result = data?.[0] as (typeof data extends Array<infer Row> ? Row : never) & {
    snapshot_generation?: string | null;
  } | undefined;
  const rawRows = Array.isArray(result?.rows) ? result.rows : [];
  const fetched = rawRows as unknown as Array<LeadBoardLead & {
    last_message_direction: string | null;
    last_message_body: string | null;
    last_message_created_at: string | null;
  }>;
  const hasMore = fetched.length > LEADS_COLUMN_PAGE_SIZE;
  const kept = fetched.slice(0, LEADS_COLUMN_PAGE_SIZE);
  const last = kept.at(-1);
  return {
    rows: kept,
    total: Number(result?.total_count ?? 0),
    hasMore,
    snapshotGeneration: result?.snapshot_generation ?? null,
    nextCursor: hasMore && last ? { dueAt: last.next_task_due_at, id: last.id } : null,
  };
}

async function fetchUrgencyCounts(
  supabase: SupabaseClient<Database>,
  filters: LeadBoardFilters,
  context: LeadBoardQueryContext,
): Promise<Record<UrgencyFilter, number>> {
  const { data, error } = await supabase.rpc("get_leads_board_urgency_counts", {
    ...rpcFilters(filters, context),
  });
  if (error) throw new Error(`Lead urgency counts failed: ${error.message}`);
  const counts = data?.[0];
  return {
    all: Number(counts?.all_count ?? 0),
    overdue: Number(counts?.overdue_count ?? 0),
    today: Number(counts?.today_count ?? 0),
    scheduled: Number(counts?.scheduled_count ?? 0),
    none: Number(counts?.no_action_count ?? 0),
  };
}

async function fetchBaselineStageTotals(
  supabase: SupabaseClient<Database>,
): Promise<Record<PropertyStatus, number>> {
  const { data, error } = await supabase.rpc("get_leads_board_stage_counts");
  if (error) throw new Error(`Lead stage counts failed: ${error.message}`);
  const totals = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0])) as Record<PropertyStatus, number>;
  for (const row of data ?? []) {
    if (STATUS_ORDER.includes(row.status as PropertyStatus)) {
      totals[row.status as PropertyStatus] = Number(row.total_count);
    }
  }
  return totals;
}

async function fetchCardDecorations(
  supabase: SupabaseClient<Database>,
  rows: Array<LeadBoardLead & {
    last_message_direction?: string | null;
    last_message_body?: string | null;
    last_message_created_at?: string | null;
  }>,
): Promise<Pick<LeadBoardData, "listMemberships" | "customTags" | "lastMessageByPropertyId">> {
  const ids = rows.map((row) => row.id);
  const membershipRows: Array<{
    property_id: string;
    list_id: string;
    lists: { name: string; color: string | null; archived_at: string | null } | null;
  }> = [];
  const tagRows: Array<{
    property_id: string;
    tag_id: string;
    tags: { name: string; color: string | null; category: string } | null;
  }> = [];
  for (let start = 0; start < ids.length; start += 50) {
    const chunk = ids.slice(start, start + 50);
    const [{ data: memberships, error: membershipsError }, { data: tags, error: tagsError }] =
      await Promise.all([
        supabase
          .from("property_lists")
          .select("property_id, list_id, lists!property_lists_list_id_fkey(name, color, archived_at)")
          .in("property_id", chunk),
        supabase
          .from("property_tags")
          .select("property_id, tag_id, tags!property_tags_tag_id_fkey(name, color, category)")
          .in("property_id", chunk),
      ]);
    // Badges are optional decoration. Preserve the core cards and exact board
    // counts if either bounded auxiliary lookup fails, matching the prior
    // board's fail-soft behavior for list/tag metadata.
    if (!membershipsError) {
      membershipRows.push(...((memberships ?? []) as unknown as typeof membershipRows));
    }
    if (!tagsError) {
      tagRows.push(...((tags ?? []) as unknown as typeof tagRows));
    }
  }

  const listMemberships: Record<string, ListMembership[]> = {};
  for (const row of membershipRows) {
    if (!row.lists || row.lists.archived_at) continue;
    (listMemberships[row.property_id] ??= []).push({
      listId: row.list_id,
      name: row.lists.name,
      color: row.lists.color,
    });
  }
  const customTags: Record<string, CustomTag[]> = {};
  for (const row of tagRows) {
    if (!row.tags || row.tags.category !== "custom") continue;
    (customTags[row.property_id] ??= []).push({
      tagId: row.tag_id,
      name: row.tags.name,
      color: row.tags.color,
    });
  }
  const lastMessageByPropertyId: Record<string, LastMessage> = {};
  for (const row of rows) {
    const preview = truncateMessagePreview(row.last_message_body ?? null);
    if (!preview || !row.last_message_created_at) continue;
    lastMessageByPropertyId[row.id] = {
      direction: row.last_message_direction === "inbound" ? "inbound" : "outbound",
      body: preview,
      createdAt: row.last_message_created_at,
    };
  }
  return { listMemberships, customTags, lastMessageByPropertyId };
}

export async function fetchLeadBoardData(
  supabase: SupabaseClient<Database>,
  filters: LeadBoardFilters,
  context: LeadBoardQueryContext,
  cursors: Partial<Record<PropertyStatus, LeadBoardCursor | null>> = {},
  statuses: readonly PropertyStatus[] = STATUS_ORDER,
): Promise<LeadBoardData> {
  const pages = await Promise.all(
    statuses.map(async (status) => ({
      status,
      page: await fetchStage(supabase, status, filters, context, cursors[status] ?? null),
    })),
  );
  const leads = pages.flatMap(({ page }) => page.rows);
  const totals = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0])) as Record<PropertyStatus, number>;
  const nextCursors: Partial<Record<PropertyStatus, LeadBoardCursor>> = {};
  const hasMore: Partial<Record<PropertyStatus, boolean>> = {};
  const snapshotGenerations: Partial<Record<PropertyStatus, string>> = {};
  for (const { status, page } of pages) {
    totals[status] = page.total;
    hasMore[status] = page.hasMore;
    if (page.snapshotGeneration) snapshotGenerations[status] = page.snapshotGeneration;
    if (page.nextCursor) nextCursors[status] = page.nextCursor;
  }
  const includeFacets = statuses.length === STATUS_ORDER.length;
  const [decorations, urgencyCounts, baselineTotals] = await Promise.all([
    fetchCardDecorations(supabase, leads),
    includeFacets ? fetchUrgencyCounts(supabase, filters, context) : Promise.resolve(null),
    includeFacets ? fetchBaselineStageTotals(supabase) : Promise.resolve(null),
  ]);
  return {
    leads,
    totals,
    baselineTotals,
    urgencyCounts,
    nextCursors,
    hasMore,
    snapshotGenerations,
    unreadPropertyIds: leads.filter((lead) => lead.has_unread).map((lead) => lead.id),
    ...decorations,
  };
}
