import Link from "next/link";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
// Import pure helpers from the .helpers module (NO "use client" directive)
// so this server component can call them during SSR without hitting Next.js's
// RSC client-reference boundary. The Plan 01-03 SUMMARY documents why importing
// from "@/components/table/use-table-url-state" (the 'use client' module)
// would crash on /lists with the same runtime error /properties hit.
import {
  buildTableHref,
  parseTableSearch,
  type SortDirection,
} from "@/components/table/use-table-url-state.helpers";
import { createClient } from "@/lib/supabase/server";

import { CreateListForm } from "./create-list-form";
import { ListsTable, type ListRow } from "./lists-table";

export const metadata = {
  title: "Lists · Sandra CRM",
};

export const LISTS_SORTABLE_COLUMNS = [
  "name",
  "members",
  "created_at",
] as const;
export type ListsSortableColumn = (typeof LISTS_SORTABLE_COLUMNS)[number];

export type ListsFilters = { archived: boolean };

const PAGE_SIZE = 50;

const LISTS_BUILD_CONFIG = {
  defaultSort: "name" as const,
  defaultDir: "asc" as SortDirection,
  buildFilterParams: (filters: Partial<ListsFilters>, sp: URLSearchParams) => {
    if (filters.archived) sp.set("archived", "1");
  },
};

export default async function ListsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    search?: string;
    sort?: string;
    dir?: string;
    archived?: string;
  }>;
}) {
  const raw = await searchParams;
  const parsed = parseTableSearch<ListsFilters>(raw, {
    sortableColumns: LISTS_SORTABLE_COLUMNS,
    defaultSort: "name",
    defaultDir: "asc",
    parseFilters: (r) => {
      const v = Array.isArray(r.archived) ? r.archived[0] : r.archived;
      return { archived: v === "1" || v === "true" };
    },
  });
  const { page, search, sort, dir, filters } = parsed;

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supabase = await createClient();

  // Build the base lists query. System-managed pinning is preserved as a
  // PRIMARY order (system-managed first), then the user's chosen sort,
  // then a stable id tie-breaker so pagination doesn't skip / repeat
  // rows when many lists share the sort value (Pitfall 7).
  //
  // We CAN'T use the chosen-sort directly when sort==="members" because
  // members is a derived count (not a column). For that case, we sort
  // by name in the DB and re-sort the page in JS after joining the
  // member counts. This is acceptable for the typical < 100 lists per
  // org (per RESEARCH line 678) — pagination by "members" only sorts
  // within the page.
  let listsQuery = supabase
    .from("lists")
    .select(
      "id, name, description, color, archived_at, created_at, system_managed",
      { count: "exact" },
    );

  if (search) {
    listsQuery = listsQuery.ilike("name", `%${search}%`);
  }
  if (filters.archived) {
    listsQuery = listsQuery.not("archived_at", "is", null);
  } else {
    listsQuery = listsQuery.is("archived_at", null);
  }

  // System-managed first (always); then user-chosen sort (when it's a real
  // DB column); then id for stable pagination. The members case is handled
  // in JS below.
  if (sort === "members") {
    listsQuery = listsQuery
      .order("system_managed", { ascending: false })
      .order("name", { ascending: true });
  } else {
    listsQuery = listsQuery
      .order("system_managed", { ascending: false })
      .order(sort, { ascending: dir === "asc" })
      .order("id", { ascending: true });
  }

  const { data: listsData, count, error } = await listsQuery.range(from, to);

  // Member counts for the visible page only (cheap; no N+1).
  const pageIds = (listsData ?? []).map((l) => l.id);
  const countsByList = new Map<string, number>();
  if (pageIds.length > 0) {
    const { data: countsData } = await supabase
      .from("property_lists")
      .select("list_id")
      .in("list_id", pageIds);
    for (const row of countsData ?? []) {
      countsByList.set(row.list_id, (countsByList.get(row.list_id) ?? 0) + 1);
    }
  }

  let rows: ListRow[] = (listsData ?? []).map((l) => ({
    ...l,
    members: countsByList.get(l.id) ?? 0,
  }));

  // Apply the JS sort for the members-count case (system-managed pin
  // is preserved by stable-sort: input is already system_managed-first,
  // and we never reorder across the system_managed boundary).
  if (sort === "members") {
    rows = rows.slice().sort((a, b) => {
      if (a.system_managed !== b.system_managed) {
        return a.system_managed ? -1 : 1;
      }
      const cmp = a.members - b.members;
      return dir === "asc" ? cmp : -cmp;
    });
  }

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function pageHref(targetPage: number): string {
    return `/lists${buildTableHref<ListsFilters>(
      { page: targetPage, search, sort, dir, filters },
      LISTS_BUILD_CONFIG,
    )}`;
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Lists" }]}
        title="Lists"
        description={
          <>
            Lists are named cohorts of properties. One list per kind-of-data —
            all Probate records to the <em>same</em> Probate list forever.
            Re-importing the same address into a <em>different</em> list is how
            you stack: a property on 3 lists is stronger motivation than any 1
            list.
          </>
        }
      />

      <CreateListForm />

      {error ? (
        <div className="text-destructive text-sm">
          Failed to load lists: {error.message}
        </div>
      ) : null}

      <ListsTable rows={rows} parsed={parsed} total={total} />

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Page {page} of {totalPages}
          </div>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={pageHref(page - 1)}
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
                href={pageHref(page + 1)}
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
