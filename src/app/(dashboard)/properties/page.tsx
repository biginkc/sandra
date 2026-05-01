import Link from "next/link";

import { Page } from "@/components/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  ProspectsTable,
  type ListOption,
  type ProspectRow,
  type TagOption,
  type TeamMemberOption,
} from "./prospects-table";
import {
  buildProspectsHref,
  computeEngagement,
  parseProspectsSearch,
  truncateMessagePreview,
  type ParsedProspectsFilters,
  type SortableColumn,
  type SortDirection,
} from "./prospects-query";

function buildPageHref(
  page: number,
  search: string | null,
  sort: SortableColumn,
  dir: SortDirection,
  filters: ParsedProspectsFilters,
): string {
  return buildProspectsHref({ page, search, sort, dir, filters });
}

const PAGE_SIZE = 50;

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
    vacant?: string;
    cass?: string;
    engagement?: string;
    market?: string;
    assignee?: string;
  }>;
}) {
  const parsed = parseProspectsSearch(await searchParams);
  const { page, search, sort, dir, filters } = parsed;

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Engagement filter is the only derived one — it requires a
  // pre-fetch against the messages table to find property_ids whose
  // most-recent message direction matches the filter. Done up front so
  // the .in("id", …) chain composes cleanly with the rest of the query.
  let engagementFilteredIds: string[] | null = null;
  if (filters.engagement === "contacted") {
    const { data: msgRows } = await supabase
      .from("messages")
      .select("property_id, direction, created_at")
      .not("property_id", "is", null)
      .order("created_at", { ascending: false });
    const seen = new Set<string>();
    const matched = new Set<string>();
    for (const m of msgRows ?? []) {
      if (!m.property_id || seen.has(m.property_id)) continue;
      seen.add(m.property_id);
      if (m.direction === "outbound") matched.add(m.property_id);
    }
    engagementFilteredIds = Array.from(matched);
    if (engagementFilteredIds.length === 0) {
      // Empty IN list would error or match-all depending on driver — short
      // circuit to "no rows" by ensuring the .in() never hits.
      engagementFilteredIds = ["__no_match__"];
    }
  }

  let query = supabase
    .from("properties")
    .select(
      "id, address, city, state, zip, market, cass_status, is_vacant, created_at",
      { count: "exact" },
    )
    .eq("status", "prospect")
    .is("deleted_at", null);

  if (search) {
    query = query.ilike("address", `%${search}%`);
  }
  if (filters.vacant) {
    query = query.eq("is_vacant", true);
  }
  if (filters.cass === "verified") {
    query = query.eq("cass_status", "verified");
  }
  if (filters.market) {
    query = query.eq("market", filters.market);
  }
  if (filters.assignee === "unassigned") {
    query = query.is("assigned_user_id", null);
  } else if (filters.assignee) {
    query = query.eq("assigned_user_id", filters.assignee);
  }
  if (engagementFilteredIds) {
    query = query.in("id", engagementFilteredIds);
  }

  // Stable secondary order on id breaks ties so pagination doesn't skip
  // or repeat rows when many rows share the primary sort value.
  const { data: properties, count, error } = await query
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: true })
    .range(from, to);

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showingFrom = total === 0 ? 0 : from + 1;
  const showingTo = Math.min(to + 1, total);

  // Latest message per property in the visible page — drives the
  // engagement pill ("contacted" / "replying") and the LAST MESSAGE
  // preview column. Single batched query, then take the most-recent
  // row per property in JS (Supabase JS doesn't expose DISTINCT ON).
  const pageIds = (properties ?? []).map((p) => p.id);
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

  const prospects: ProspectRow[] = (properties ?? []).map((p) => {
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
    };
  });

  // Active lists — feed the "Add to list" / "Remove from list" submenus.
  // Archived lists are hidden from the picker (they'd be a noisy confusion
  // vector); users can unarchive via /lists if they want them back.
  // Sort: system-managed first, then alphabetical — same rule as the
  // /lists page so VAs see the same order everywhere.
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

  // Team members for the Assign submenu. Admin-only API; non-fatal on
  // failure (the Assign submenu just renders empty).
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
        filters={filters}
        total={total}
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Page {page} of {totalPages}
          </div>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={`/properties${buildPageHref(page - 1, search, sort, dir, filters)}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                prefetch={false}
              >
                ← Prev
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled>
                ← Prev
              </Button>
            )}
            {page < totalPages ? (
              <Link
                href={`/properties${buildPageHref(page + 1, search, sort, dir, filters)}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                prefetch={false}
              >
                Next →
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Next →
              </Button>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
