import { Suspense } from "react";

import { Page } from "@/components/page";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { getCallerMemberships } from "@/lib/auth/memberships";
import {
  loadOrgTeamMembers,
  loadTeamMembersForOrgs,
} from "@/lib/auth/team-roster";
import { createClient } from "@/lib/supabase/server";
import {
  applyFilters,
  filterSelectFragment,
} from "@/lib/prospects/filter-to-supabase";

import {
  ProspectsTable,
  type ListOption,
  type ProspectRow,
  type TagOption,
  type TeamMemberOption,
} from "./prospects-table";
import {
  computeEngagement,
  parseProspectsSearch,
  truncateMessagePreview,
} from "./prospects-query";
import { FilterDrawer } from "./_components/filter-drawer";
import QuickFiltersBar from "./_components/quick-filters-bar";
import { ActiveFiltersChips } from "./_components/active-filters-chips";
import { PresetDropdown } from "./_components/preset-dropdown";
import { SavePresetInline } from "./_components/save-preset-inline";
import { type BlockOptions } from "./_components/blocks/_block-shell";
import { BlockOptionsProvider } from "./_components/block-options-provider";
import { renderBlock } from "./_components/blocks/registry";
import type { Preset } from "./_components/quick-filter-chip";
import { getDayBoundsInZone } from "@/lib/time/zoned";
import { LEAD_SOURCES } from "@/lib/leads/sources";

const PAGE_SIZE = 50;

type PropertyQueryRow = {
  id: string;
  org_id: string;
  address: string;
  city: string | null;
  state: string;
  zip: string | null;
  market: string | null;
  cass_status: string;
  is_vacant: boolean | null;
  created_at: string;
  status: string;
  is_dnc_locked: boolean;
  outreach_dispo: string | null;
  source_import_id: string | null;
  source_imported_at: string | null;
  homeowner?: Array<{
    phone_1: string | null;
    phone_2: string | null;
    phone_3: string | null;
    do_not_contact: boolean;
    sms_opted_out: boolean;
  }> | null;
  list_filter?: Array<{ list_id: string }>;
  list_exclusion?: Array<{ list_id: string }>;
  contact_messages?: Array<unknown>;
  attempted_outbound?: Array<unknown>;
  attempted_inbound?: Array<unknown>;
  replied_messages?: Array<unknown>;
};

// Hardcoded enum sources — these match the CHECK constraints in the
// migrations referenced inline. The drawer surfaces them through
// BlockOptionsContext; if a migration adds new enum values, update here.
//
// pipeline_status — migration 014_prospect_status.sql.
const PIPELINE_STATUSES = [
  "prospect",
  "new_lead",
  "contacted",
  "interested",
  "offer_sent",
  "offer_declined",
  "under_contract",
  "closed",
  "dead",
];
// motivation_level — migration 013_motivation_level.sql.
const MOTIVATION_LEVELS = ["hot", "warm", "cold"];
// outreach_dispo — migration 045_outreach_dispo.sql.
const OUTREACH_DISPOS = [
  "wrong_number",
  "bad_number",
  "not_interested",
  "opted_out",
  "dnc",
  "nurture",
  "callback_requested",
  "needs_sequence",
];
// cass_status — fixed CASS taxonomy used throughout the app.
const CASS_STATUSES = ["verified", "unverified", "invalid", "ambiguous"];
// properties.source — migration 053_lead_sources_for_format_helper.sql.
// Mirror of LEAD_SOURCES in src/lib/leads/create.ts; the CHECK constraint
// is the floor, the registry is the wall.
const SOURCES = [...LEAD_SOURCES];

export const metadata = {
  title: "Prospects · Sandra CRM",
};

export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    search?: string;
    sort?: string;
    dir?: string;
    /** Plan 09 v1 filter state — encoded { v: 1, blocks: [...] }. */
    filters?: string;
    /** Legacy chip params — Plan 09 back-compat path. Translated into the
     *  block stack only when ?filters= is absent. */
    vacant?: string;
    cass?: string;
    engagement?: string;
    market?: string;
    assignee?: string;
    imported?: string;
  }>;
}) {
  const rawSearchParams = await searchParams;
  const parsed = parseProspectsSearch(rawSearchParams);
  const { page, search, sort, dir, blockStack } = parsed;
  const rawFiltersParam = rawSearchParams.filters ?? null;

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // orgId resolution — Sandra is single-org currently (BMH), so the first
  // (and only) membership for the caller is the working assumption. RLS on
  // saved_filters and the prospects query enforces scoping; this value is
  // primarily for the QuickFiltersBar / FilterDrawer / SavePresetInline /
  // PresetDropdown components, which all need an orgId prop to scope the
  // saved_filters reads + writes.
  const memberships = await getCallerMemberships();
  const orgIds = memberships.map((membership) => membership.org_id);
  const orgId = orgIds[0] ?? "";

  // Plan 09 — base properties query. Per the gotchas in 05-09-PLAN.md, when
  // the block stack contains a pipeline_status block we DROP the hardcoded
  // .eq("status","prospect") so that block's values fully define the active
  // status set (e.g., a saved preset that filters to "lead | contract | closed"
  // shouldn't be ANDed with "prospect" → empty).
  const propertiesPromise = (async () => {
    const hasPipelineStatusBlock = blockStack.some(
      (b) => b.kind === "pipeline_status",
    );
    const propertyListSelect = filterSelectFragment(blockStack);
    const propertiesSelect = [
      "id, org_id, address, city, state, zip, market, cass_status, is_vacant, created_at, status, is_dnc_locked, outreach_dispo, source_import_id, source_imported_at, homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)",
      propertyListSelect,
    ]
      .filter(Boolean)
      .join(", ");

    let query = supabase
      .from("properties")
      .select(propertiesSelect, { count: "exact" })
      .is("deleted_at", null);
    if (!hasPipelineStatusBlock) {
      query = query.or("status.eq.prospect,is_dnc_locked.eq.true");
    }
    if (search) {
      query = query.ilike("address", `%${search}%`);
    }
    if (rawSearchParams.imported === "today") {
      const { dayStart, dayEnd } = getDayBoundsInZone(
        new Date(),
        "America/Chicago",
      );
      query = query
        .not("source_import_id", "is", null)
        .gte("source_imported_at", dayStart.toISOString())
        .lt("source_imported_at", dayEnd.toISOString());
    }
    // Plan 04 translator — applies all 23 block kinds (vacancy / cass /
    // engagement / market / assignee / source / state / motivation_level /
    // pipeline_status / outreach_dispo / list / tag / list_count / beds /
    // baths / year_built / estimated_value / equity_pct / absentee /
    // created_date / has_unread_inbound / needs_human_attention /
    // has_open_tasks). Single source of truth for the Supabase filter
    // chain — the page no longer hand-rolls per-chip predicates.
    query = (await applyFilters(query, blockStack, supabase)).builder;

    // Stable secondary order on id breaks ties so pagination doesn't skip
    // or repeat rows when many rows share the primary sort value.
    return {
      query: query
        .order(sort, { ascending: dir === "asc" })
        .order("id", { ascending: true })
        .range(from, to),
    };
  })();

  // These option reads do not depend on the paginated property rows. Keep
  // them in one latency wave with the properties query; this is the page's
  // largest set of independent top-level reads.
  const optionsPromise = Promise.all([
    supabase
      .from("counties")
      .select("market")
      .order("market", { ascending: true }),
    supabase
      .from("properties")
      .select("state")
      .is("deleted_at", null)
      .not("state", "is", null),
    supabase
      .from("lists")
      .select("id, name, color, archived_at, system_managed")
      .is("archived_at", null)
      .order("system_managed", { ascending: false })
      .order("name", { ascending: true }),
    supabase
      .from("tags")
      .select("id, name, color")
      .eq("category", "custom")
      .eq("system_managed", false)
      .order("name", { ascending: true }),
    Promise.all(
      orgIds.map(async (orgId) => ({
        orgId,
        members: await loadOrgTeamMembers(orgId),
      })),
    ),
    loadTeamMembersForOrgs(orgIds, { includeInactiveMembers: true }),
    supabase
      .from("saved_filters")
      .select("id, name, filters_json, starred, is_base")
      .eq("org_id", orgId)
      .order("is_base", { ascending: false })
      .order("name", { ascending: true }),
  ]);

  const [
    { query: propertyQuery },
    [
      countyResult,
      stateResult,
      listResult,
      tagResult,
      activeTeamRosters,
      assigneeFilterMembers,
      presetResult,
    ],
  ] = await Promise.all([propertiesPromise, optionsPromise]);
  const { data: propertyRows, count, error } = await propertyQuery;
  // Relationship embeds above are select-only filter helpers; the table
  // consumes only property columns, but the optional fields remain typed so
  // future readers can see why the select may include list_filter/list_exclusion.
  const properties = (propertyRows ?? []) as unknown as PropertyQueryRow[];

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showingFrom = total === 0 ? 0 : from + 1;
  const showingTo = Math.min(to + 1, total);

  // Latest message per property in the visible page — drives the
  // engagement pill ("contacted" / "replying") and the LAST MESSAGE
  // preview column. Single batched query, then take the most-recent
  // row per property in JS (Supabase JS doesn't expose DISTINCT ON).
  const pageIds = properties.map((p) => p.id);
  const latestByPropertyId = new Map<
    string,
    { direction: "inbound" | "outbound"; body: string | null }
  >();
  if (pageIds.length > 0) {
    const { data: msgRows } = await supabase
      .from("messages")
      .select("property_id, direction, body, created_at")
      .in("property_id", pageIds)
      .order("created_at", { ascending: false });
    for (const m of msgRows ?? []) {
      if (!m.property_id) continue;
      // Already ordered desc — first row per property_id is the latest.
      if (!latestByPropertyId.has(m.property_id)) {
        latestByPropertyId.set(m.property_id, {
          direction: m.direction as "inbound" | "outbound",
          body: m.body ?? null,
        });
      }
    }
  }

  const prospects: ProspectRow[] = properties.map((p) => {
    const latest = latestByPropertyId.get(p.id) ?? null;
    const homeowner = Array.isArray(p.homeowner) ? p.homeowner[0] : p.homeowner;
    return {
      id: p.id,
      org_id: p.org_id,
      address: p.address,
      city: p.city,
      state: p.state,
      zip: p.zip,
      market: p.market,
      cass_status: p.cass_status,
      is_vacant: p.is_vacant,
      created_at: p.created_at,
      engagement: computeEngagement(latest),
      last_message_preview: truncateMessagePreview(latest?.body ?? null),
      outreach_dispo: p.outreach_dispo ?? null,
      imported_at: p.source_imported_at,
      dnc_reason: p.is_dnc_locked
        ? "Permanent Do Not Contact lock. This record is read-only."
        : null,
      channel_restriction:
        !p.is_dnc_locked && homeowner?.sms_opted_out ? "SMS opted out" : null,
    };
  });

  // ---------------------------------------------------------------
  // BlockOptionsContext data — feeds the per-block pickers in the drawer.
  // 9 distinct fields; six come from existing queries (lists, tags,
  // markets, assignees → teamMembers, states from a distinct scan, and
  // CASS), three from hardcoded enum lists mirroring CHECK constraints.
  // ---------------------------------------------------------------

  // Markets list — from counties (D-07), already used by the legacy chip.
  const { data: countyRows } = countyResult;
  const markets: string[] = (countyRows ?? []).map((c) => c.market);

  // Distinct states — pulled live from properties so the picker only
  // surfaces options the org actually has data in. RLS scopes to org.
  const { data: stateRows } = stateResult;
  const states: string[] = Array.from(
    new Set((stateRows ?? []).map((r) => r.state).filter(Boolean) as string[]),
  ).sort();

  // Active lists — feeds Add to list/Remove from list bulk submenus and
  // the list-block picker in the drawer.
  const { data: listRows } = listResult;
  const lists: ListOption[] = (listRows ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color,
  }));

  // Custom-category tags only — Feature 3's strict journey-marker model
  // forbids applying source / uploaded / skip-trace tags by hand.
  const { data: tagRows } = tagResult;
  const tags: TagOption[] = (tagRows ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
  }));

  // Assignment is active-only. Filtering keeps former memberships visible
  // so their existing records remain reachable.
  const teamMembersByOrg = Object.fromEntries(
    activeTeamRosters.map(({ orgId, members }) => [orgId, members]),
  );
  const teamMembers: TeamMemberOption[] = Array.from(
    new Map(
      activeTeamRosters
        .flatMap(({ members }) => members)
        .map((member) => [member.id, member]),
    ).values(),
  );

  const isAdmin = isAdminEmail(user?.email);

  // Saved presets for the PresetDropdown topSlot — full set the user can
  // reach (base + their own, starred or not). The QuickFiltersBar fetches
  // its own narrower set (is_base OR (mine AND starred)) for the inline
  // chip row above the table.
  const { data: presetRows } = presetResult;
  const presets = (presetRows ?? []) as Preset[];

  // BlockOptions widens `color: string | null` → `color?: string` per the
  // _block-shell contract. Map nulls to undefined so the discriminated
  // optional matches; the drawer just renders no color swatch in that case.
  const blockOptions: BlockOptions = {
    lists: lists.map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color ?? undefined,
    })),
    tags: tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color ?? undefined,
    })),
    markets,
    states,
    assignees: assigneeFilterMembers,
    sources: SOURCES,
    pipelineStatuses: PIPELINE_STATUSES,
    motivationLevels: MOTIVATION_LEVELS,
    outreachDispos: OUTREACH_DISPOS,
    cassStatuses: CASS_STATUSES,
  };

  // Cross-page CASS breakdown — shown in the header subhead so the
  // operator can see at a glance how many prospects are skip-trace
  // ready (verified) vs blocked behind address verification. Per-row
  // dots in the table show the same on individual rows.
  const cassStats = await (async () => {
    if (total === 0) return null;
    const counts = await Promise.all(
      ["verified", "unverified", "invalid", "ambiguous"].map(async (s) => {
        const hasPipelineStatusBlock = blockStack.some(
          (block) => block.kind === "pipeline_status",
        );
        const propertyListSelect = filterSelectFragment(blockStack);
        const countSelect = ["id", propertyListSelect]
          .filter(Boolean)
          .join(", ");
        let countQuery = supabase
          .from("properties")
          .select(countSelect, { count: "exact", head: true })
          .is("deleted_at", null)
          .eq("cass_status", s);
        if (!hasPipelineStatusBlock) {
          countQuery = countQuery.or(
            "status.eq.prospect,is_dnc_locked.eq.true",
          );
        }
        if (search) {
          countQuery = countQuery.ilike("address", `%${search}%`);
        }
        if (rawSearchParams.imported === "today") {
          const { dayStart, dayEnd } = getDayBoundsInZone(
            new Date(),
            "America/Chicago",
          );
          countQuery = countQuery
            .not("source_import_id", "is", null)
            .gte("source_imported_at", dayStart.toISOString())
            .lt("source_imported_at", dayEnd.toISOString());
        }
        countQuery = (await applyFilters(countQuery, blockStack, supabase))
          .builder;
        const { count: c } = await countQuery;
        return [s, c ?? 0] as const;
      }),
    );
    return Object.fromEntries(counts) as Record<
      "verified" | "unverified" | "invalid" | "ambiguous",
      number
    >;
  })();

  const cassBreakdown = cassStats
    ? ` · ${cassStats.verified.toLocaleString()} CASS verified · ${cassStats.unverified.toLocaleString()} unverified${cassStats.invalid > 0 ? ` · ${cassStats.invalid.toLocaleString()} invalid` : ""}${cassStats.ambiguous > 0 ? ` · ${cassStats.ambiguous.toLocaleString()} ambiguous` : ""}`
    : "";

  const headerCount =
    total === 0
      ? "Imported properties appear in Prospects for review before promotion to Leads. No prospects yet."
      : `Imported properties appear in Prospects for review before promotion to Leads. Showing ${showingFrom}–${showingTo} of ${total} prospect${total === 1 ? "" : "s"}${cassBreakdown}.`;

  return (
    <Page>
      {error ? (
        <div className="text-destructive text-sm">
          Failed to load prospects: {error.message}
        </div>
      ) : null}

      <BlockOptionsProvider value={blockOptions}>
        {/* Drawer trigger + Quick Filter chips share a row above the table. */}
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <FilterDrawer
            orgId={orgId}
            renderBlock={renderBlock}
            topSlot={<PresetDropdown orgId={orgId} presets={presets} />}
            footerSlot={
              <SavePresetInline orgId={orgId} currentBlocks={blockStack} />
            }
          />
          <Suspense
            fallback={
              <span className="text-xs text-muted-foreground">
                Loading Quick Filters…
              </span>
            }
          >
            <QuickFiltersBar
              orgId={orgId}
              currentFilterStateRaw={rawFiltersParam}
            />
          </Suspense>
        </div>

        <ActiveFiltersChips orgId={orgId} currentBlocks={blockStack} />

        <ProspectsTable
          orgId={orgId}
          prospects={prospects}
          lists={lists}
          tags={tags}
          teamMembers={teamMembers}
          teamMembersByOrg={teamMembersByOrg}
          currentUserId={user?.id ?? null}
          canDelete={isAdmin}
          headerCount={headerCount}
          search={search ?? ""}
          sort={sort}
          dir={dir}
          blockStack={blockStack}
          filtersParam={rawFiltersParam}
          importedParam={rawSearchParams.imported === "today" ? "today" : null}
          total={total}
          pageSize={PAGE_SIZE}
          page={page}
          totalPages={totalPages}
        />
      </BlockOptionsProvider>
    </Page>
  );
}
