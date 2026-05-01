"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { SortableHeader } from "@/components/table/sortable-header";
import {
  TableToolbar,
  TableToolbarFilterPill,
  TableToolbarSearch,
} from "@/components/table/table-toolbar";
import {
  useTableUrlState,
  type ParsedTableSearch,
  type SortDirection,
  type UseTableUrlStateReturn,
} from "@/components/table/use-table-url-state";

import { ListRowActions } from "./list-row-actions";

const LISTS_SORTABLE_COLUMNS = ["name", "members", "created_at"] as const;
type ListsSortableColumn = (typeof LISTS_SORTABLE_COLUMNS)[number];

export type ListsFilters = { archived: boolean };

export type ListRow = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  archived_at: string | null;
  created_at: string;
  system_managed: boolean;
  members: number;
};

type Props = {
  rows: ListRow[];
  parsed: ParsedTableSearch<ListsFilters>;
  total: number;
};

const BUILD_CONFIG = {
  defaultSort: "name" as const,
  defaultDir: "asc" as SortDirection,
  sortableColumns: LISTS_SORTABLE_COLUMNS,
  buildFilterParams: (filters: Partial<ListsFilters>, sp: URLSearchParams) => {
    if (filters.archived) sp.set("archived", "1");
  },
};

/**
 * Client island for the /lists table. Consumes useTableUrlState({ mode: "ssr" })
 * + the Phase 1 toolbar / sort-header primitives. Server component
 * (lists/page.tsx) parses + drills `parsed` here so the toolbar's
 * defaultValue, the active-sort indicator, and the archived pill all
 * read from the URL on every render.
 */
export function ListsTable({ rows, parsed, total: _total }: Props) {
  const ts = useTableUrlState<ListsFilters>({
    basePath: "/lists",
    parsed,
    mode: "ssr",
    config: BUILD_CONFIG,
  });

  const onToggleArchived = () => {
    ts.navigate(
      `/lists${ts.buildHref({
        page: 1,
        // Only forward search if it's non-empty — debouncedSearch's
        // null-collapse mirrors this so the URL stays clean when the
        // user toggles archived without an active search.
        search: ts.search === "" ? null : ts.search,
        sort: ts.sort,
        dir: ts.dir,
        filters: { archived: !parsed.filters.archived },
      })}`,
    );
  };

  return (
    <>
      <TableToolbar
        state={
          ts as unknown as UseTableUrlStateReturn<Record<string, unknown>>
        }
      >
        <TableToolbarSearch
          ariaLabel="Search lists by name"
          placeholder="Search lists…"
          testId="lists-search"
        />
        <TableToolbarFilterPill
          active={parsed.filters.archived}
          onClick={onToggleArchived}
          testId="lists-filter-archived"
        >
          {parsed.filters.archived ? "Showing archived" : "Show archived"}
        </TableToolbarFilterPill>
      </TableToolbar>

      <div
        className="border-border rounded-md border"
        data-pending={ts.navPending}
        data-testid="lists-table-container"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader<ListsSortableColumn>
                column="name"
                current={ts.sort}
                dir={ts.dir}
                onClick={(col) => ts.onSort(col)}
                testIdPrefix="lists"
              >
                Name
              </SortableHeader>
              <TableHead>Description</TableHead>
              <SortableHeader<ListsSortableColumn>
                column="members"
                current={ts.sort}
                dir={ts.dir}
                onClick={(col) => ts.onSort(col)}
                testIdPrefix="lists"
              >
                Members
              </SortableHeader>
              <SortableHeader<ListsSortableColumn>
                column="created_at"
                current={ts.sort}
                dir={ts.dir}
                onClick={(col) => ts.onSort(col)}
                testIdPrefix="lists"
              >
                Created
              </SortableHeader>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ts.navPending ? (
              // Skeleton rows during search / sort / filter navigation.
              // Match the visible row count (or 5 minimum) so the table
              // doesn't snap-resize when results come back. Mirrors the
              // prospects-table convention.
              Array.from({ length: Math.max(rows.length, 5) }).map((_, i) => (
                <TableRow
                  key={`skeleton-${i}`}
                  data-testid="lists-skeleton-row"
                >
                  <TableCell>
                    <Skeleton className="h-4 w-48" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-72" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-12" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-8 w-20" />
                  </TableCell>
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-muted-foreground py-8 text-center"
                >
                  {ts.search.length > 0
                    ? `No lists match "${ts.search}".`
                    : parsed.filters.archived
                      ? "No archived lists."
                      : "No lists yet. Create one above or set a list name on the next CSV import."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="secondary"
                        style={
                          r.color
                            ? {
                                backgroundColor: `${r.color}22`,
                                color: r.color,
                                borderColor: `${r.color}55`,
                              }
                            : undefined
                        }
                      >
                        {r.name}
                      </Badge>
                      {r.system_managed ? (
                        <Badge
                          variant="outline"
                          className="text-muted-foreground text-[10px] tracking-wide uppercase"
                          title="System-managed list — pre-populated, can't be archived"
                        >
                          System
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {r.description || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {r.members}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDistanceToNow(new Date(r.created_at), {
                      addSuffix: true,
                    })}
                  </TableCell>
                  <TableCell className="text-right">
                    <ListRowActions
                      id={r.id}
                      name={r.name}
                      archived={!!r.archived_at}
                      systemManaged={r.system_managed}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
