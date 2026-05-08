import { Suspense } from "react";

import { Page } from "@/components/page";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { getCallerMemberships } from "@/lib/auth/memberships";
import { createAdminClient } from "@/lib/supabase/admin";
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


const PAGE_SIZE = 50;

type PropertyQueryRow = {
  id: string;
  address: string;
  city: string | null;
  state: string;
  zip: string | null;
  market: string | null;
  cass_status: string;
  is_vacant: boolean | null;
  created_at: string;
  outreach_dispo: string | null;
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
];
// cass_status — fixed CASS taxonomy used throughout the app.
const CASS_STATUSES = ["verified", "unverified", "invalid", "ambiguous"];
// properties.source — migration 053_lead_sources_for_format_helper.sql.
// Mirror of LEAD_SOURCES in src/lib/leads/create.ts; the CHECK constraint
// is the floor, the registry is the wall.
const SOURCES = [
  "dealmachine",
  "propstream",
  "titlepro",
  "reisift",
  "agent_outreach",
  "driving_for_dollars",
  "referral",
  "cold_call",
  "sms",
  "web_form",
  "direct_mail",
];

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
  const orgId = memberships[0]?.org_id ?? "";

  // Plan 09 — base properties query. Per the gotchas in 05-09-PLAN.md, when
  // the block stack contains a pipeline_status block we DROP the hardcoded
  // .eq("status","prospect") so that block's values fully define the active
  // status set (e.g., a saved preset that filters to "lead | contract | closed"
  // shouldn't be ANDed with "prospect" → empty).
  const hasPipelineStatusBlock = blockStack.some(
    (b) => b.kind === "pipeline_status",
  );
  const propertyListSelect = filterSelectFragment(blockStack);
  const propertiesSelect = [
    "id, address, city, state, zip, market, cass_status, is_vacant, created_at, outreach_dispo",
    propertyListSelect,
  ]
    .filter(Boolean)
    .join(", ");

  let query = supabase
    .from("properties")
    .select(propertiesSelect, { count: "exact" })
    .is("deleted_at", null);
  if (!hasPipelineStatusBlock) {
    query = query.eq("status", "prospect");
  }
  if (search) {
    query = query.ilike("address", `%${search}%`);
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
  const { data: propertyRows, count, error } = await query
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: true })
    .range(from, to);
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
    return {
      id: p.id,
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
    };
  });

  // ---------------------------------------------------------------
  // BlockOptionsContext data — feeds the per-block pickers in the drawer.
  // 9 distinct fields; six come from existing queries (lists, tags,
  // markets, assignees → teamMembers, states from a distinct scan, and
  // CASS), three from hardcoded enum lists mirroring CHECK constraints.
  // ---------------------------------------------------------------

  // Markets list — from counties (D-07), already used by the legacy chip.
  const { data: countyRows } = await supabase
    .from("counties")
    .select("market")
    .order("market", { ascending: true });
  const markets: string[] = (countyRows ?? []).map((c) => c.market);

  // Distinct states — pulled live from properties so the picker only
  // surfaces options the org actually has data in. RLS scopes to org.
  const { data: stateRows } = await supabase
    .from("properties")
    .select("state")
    .is("deleted_at", null)
    .not("state", "is", null);
  const states: string[] = Array.from(
    new Set((stateRows ?? []).map((r) => r.state).filter(Boolean) as string[]),
  ).sort();

  // Active lists — feeds Add to list/Remove from list bulk submenus and
  // the list-block picker in the drawer.
  const { data: listRows } = await supabase
    .from("lists")
    .select("id, name, color, archived_at, system_managed")
    .is("archived_at", null)
    .order("system_managed", { ascending: false })
    .order("name", { ascending: true });
  const lists: ListOption[] = (listRows ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color,
  }));

  // Custom-category tags only — Feature 3's strict journey-marker model
  // forbids applying source / uploaded / skip-trace tags by hand.
  const { data: tagRows } = await supabase
    .from("tags")
    .select("id, name, color")
    .eq("category", "custom")
    .eq("system_managed", false)
    .order("name", { ascending: true });
  const tags: TagOption[] = (tagRows ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
  }));

  // Team members for the Assign submenu + assignee block picker.
  // Admin-only API; non-fatal on failure (the picker just renders empty).
  let teamMembers: TeamMemberOption[] = [];
  try {
    const admin = createAdminClient();
    const { data: usersPage } = await admin.auth.admin.listUsers({
      perPage: 200,
    });
    teamMembers = (usersPage?.users ?? [])
      .filter((u) => !!u.email)
      .map((u) => ({ id: u.id, email: u.email as string }))
      .sort((a, b) => a.email.localeCompare(b.email));
  } catch {
    // Leave teamMembers empty — submenu renders a subtle empty state.
  }

  const isAdmin = isAdminEmail(user?.email);

  // Saved presets for the PresetDropdown topSlot — full set the user can
  // reach (base + their own, starred or not). The QuickFiltersBar fetches
  // its own narrower set (is_base OR (mine AND starred)) for the inline
  // chip row above the table.
  const { data: presetRows } = await supabase
    .from("saved_filters")
    .select("id, name, filters_json, starred, is_base")
    .eq("org_id", orgId)
    .order("is_base", { ascending: false })
    .order("name", { ascending: true });
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
    assignees: teamMembers,
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
        const { count: c } = await supabase
          .from("properties")
          .select("id", { count: "exact", head: true })
          .eq("status", "prospect")
          .is("deleted_at", null)
          .eq("cass_status", s);
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
      ? "No prospects yet. Import a CSV to fill the data lake."
      : `Showing ${showingFrom}–${showingTo} of ${total} prospect${total === 1 ? "" : "s"}${cassBreakdown}. Qualify a prospect to move it into the leads pipeline.`;

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

        <ActiveFiltersChips />

        <ProspectsTable
          prospects={prospects}
          lists={lists}
          tags={tags}
          teamMembers={teamMembers}
          currentUserId={user?.id ?? null}
          canDelete={isAdmin}
          headerCount={headerCount}
          search={search ?? ""}
          sort={sort}
          dir={dir}
          blockStack={blockStack}
          filtersParam={rawFiltersParam}
          total={total}
          pageSize={PAGE_SIZE}
          page={page}
          totalPages={totalPages}
        />
      </BlockOptionsProvider>
    </Page>
  );
}
