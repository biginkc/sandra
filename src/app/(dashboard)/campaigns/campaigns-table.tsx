"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import Link from "next/link";

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
import { Badge } from "@/components/ui/badge";
import {
  DataTableFooter,
  DataTableShell,
} from "@/components/ui/data-table-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { CampaignRowActions } from "./campaign-row-actions";

const CAMPAIGNS_SORTABLE_COLUMNS = ["name", "status", "created_at"] as const;
type CampaignsSortableColumn = (typeof CAMPAIGNS_SORTABLE_COLUMNS)[number];

export type CampaignsFilters = { archived: boolean };

export type CampaignRow = {
  id: string;
  name: string;
  status: "active" | "launching" | "paused" | "completed" | "archived";
  archived_at: string | null;
  created_at: string;
  audienceSummary: string;
  bodyPreview: string;
  pace_seconds: number | null;
  skip_if_contacted: boolean;
  recipientCount: number;
};

type Props = {
  rows: CampaignRow[];
  parsed: ParsedTableSearch<CampaignsFilters>;
  total: number;
};

const BUILD_CONFIG = {
  defaultSort: "created_at" as const,
  defaultDir: "desc" as SortDirection,
  sortableColumns: CAMPAIGNS_SORTABLE_COLUMNS,
  buildFilterParams: (
    filters: Partial<CampaignsFilters>,
    sp: URLSearchParams,
  ) => {
    if (filters.archived) sp.set("archived", "1");
  },
};

function statusBadgeVariant(status: CampaignRow["status"]): "secondary" | "outline" {
  return status === "completed" || status === "archived" ? "outline" : "secondary";
}

function statusClassName(status: CampaignRow["status"]): string {
  switch (status) {
    case "launching":
      return "border-amber-300 bg-amber-50 text-amber-800";
    case "completed":
      return "border-emerald-300 bg-emerald-50 text-emerald-800";
    case "paused":
      return "border-slate-300 bg-slate-100 text-slate-700";
    case "archived":
      return "text-muted-foreground";
    default:
      return "";
  }
}

export function CampaignsTable({ rows, parsed, total }: Props) {
  const ts = useTableUrlState<CampaignsFilters>({
    basePath: "/campaigns",
    parsed,
    mode: "ssr",
    config: BUILD_CONFIG,
  });

  const onToggleArchived = () => {
    ts.navigate(
      `/campaigns${ts.buildHref({
        page: 1,
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
          ariaLabel="Search campaigns by name"
          placeholder="Search campaigns…"
          testId="campaigns-search"
        />
        <TableToolbarFilterPill
          active={parsed.filters.archived}
          onClick={onToggleArchived}
          testId="campaigns-filter-archived"
        >
          {parsed.filters.archived ? "Showing archived" : "Show archived"}
        </TableToolbarFilterPill>
      </TableToolbar>

      <DataTableShell
        data-pending={ts.navPending}
        data-testid="campaigns-table-container"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader<CampaignsSortableColumn>
                column="name"
                current={ts.sort}
                dir={ts.dir}
                onClick={(column) => ts.onSort(column)}
                testIdPrefix="campaigns"
              >
                Name
              </SortableHeader>
              <TableHead>Audience</TableHead>
              <TableHead>Message</TableHead>
              <SortableHeader<CampaignsSortableColumn>
                column="status"
                current={ts.sort}
                dir={ts.dir}
                onClick={(column) => ts.onSort(column)}
                testIdPrefix="campaigns"
              >
                Status
              </SortableHeader>
              <SortableHeader<CampaignsSortableColumn>
                column="created_at"
                current={ts.sort}
                dir={ts.dir}
                onClick={(column) => ts.onSort(column)}
                testIdPrefix="campaigns"
              >
                Created
              </SortableHeader>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ts.navPending ? (
              Array.from({ length: Math.max(rows.length, 5) }).map((_, index) => (
                <TableRow
                  key={`campaign-skeleton-${index}`}
                  data-testid="campaigns-skeleton-row"
                >
                  <TableCell>
                    <Skeleton className="h-4 w-40" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-48" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-56" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="ml-auto h-8 w-28" />
                  </TableCell>
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-muted-foreground py-8 text-center"
                >
                  {ts.search.length > 0
                    ? `No campaigns match "${ts.search}".`
                    : parsed.filters.archived
                      ? "No archived campaigns."
                      : "No campaigns yet. Build one above before you launch SMS."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <Link
                        href={`/campaigns/${row.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {row.name}
                      </Link>
                      {row.recipientCount > 0 ? (
                        <span className="text-muted-foreground text-xs">
                          Frozen recipients: {row.recipientCount.toLocaleString()}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {row.audienceSummary}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="text-sm">{row.bodyPreview}</span>
                      <span className="text-muted-foreground text-xs">
                        Pace: {row.pace_seconds ?? 18}s
                        {row.skip_if_contacted ? " · Skip contacted" : ""}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={statusBadgeVariant(row.status)}
                      className={statusClassName(row.status)}
                    >
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDistanceToNow(new Date(row.created_at), {
                      addSuffix: true,
                    })}
                  </TableCell>
                  <TableCell className="text-right">
                    <CampaignRowActions
                      id={row.id}
                      name={row.name}
                      status={row.status}
                      archived={Boolean(row.archived_at)}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <DataTableFooter>
          <span className="text-muted-foreground text-sm">
            {total.toLocaleString()} {total === 1 ? "campaign" : "campaigns"}
          </span>
        </DataTableFooter>
      </DataTableShell>
    </>
  );
}
