"use client";

import { ChevronDownIcon, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { SortableHeader } from "@/components/table/sortable-header";
import {
  TableToolbar,
  TableToolbarSearch,
} from "@/components/table/table-toolbar";
import {
  useTableUrlState,
  type UseTableUrlStateReturn,
} from "@/components/table/use-table-url-state";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { CircularPagination } from "@/components/ui/circular-pagination";
import {
  DataTableFooter,
  DataTableShell,
} from "@/components/ui/data-table-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildProspectsFilterParams,
  buildProspectsHref,
  formatFullAddress,
  type EngagementState,
  type ParsedProspectsFilters,
  type SortableColumn,
  type SortDirection,
} from "./prospects-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { callAction } from "@/lib/errors/call-action";

import {
  addPropertiesToListBulk,
  applyTagBulk,
  assignLeadsBulk,
  deletePropertiesBulk,
  qualifyLeadsBulk,
  removePropertiesFromListBulk,
  verifyPropertiesBulk,
  type BulkOutcome,
} from "../leads/actions";
import { requestSkipTrace } from "@/lib/skip-trace/actions";
import { getAllMatchingProspectIds } from "./actions";
import { BulkSmsModal } from "./bulk-sms-modal";

export type ProspectRow = {
  id: string;
  address: string;
  city: string | null;
  state: string;
  zip: string | null;
  market: string | null;
  cass_status: string;
  is_vacant: boolean | null;
  created_at: string;
  /** Derived from the property's most recent message direction.
   *  "none" -> no badge rendered. */
  engagement: EngagementState;
  /** Truncated body of the property's most recent message; null when none. */
  last_message_preview: string | null;
  /** Outreach disposition, if manually set or auto-detected. */
  outreach_dispo: string | null;
};

export type ListOption = { id: string; name: string; color: string | null };
export type TagOption = { id: string; name: string; color: string | null };
export type TeamMemberOption = { id: string; email: string };

type Props = {
  prospects: ProspectRow[];
  lists: ListOption[];
  tags: TagOption[];
  teamMembers: TeamMemberOption[];
  /** Available markets — fetched server-side from the counties table
   *  in /properties/page.tsx and rendered in the Market filter pill.
   *  Per phase 02 D-07 the dropdown reads from counties; per
   *  feedback_no_usestate_mirror_of_server_props.md the table renders
   *  the prop directly with no useState mirror. */
  markets: string[];
  currentUserId: string | null;
  canDelete: boolean;
  /** Rendered into the header subhead so the count stays right next to the title. */
  headerCount: string;
  /** Current URL state — drives the search input + sort header indicators. */
  search: string;
  sort: SortableColumn;
  dir: SortDirection;
  filters: ParsedProspectsFilters;
  /** Total count across all pages matching the current filters — drives the
   *  "Select all N prospects" cross-page selection banner. */
  total: number;
  /** Rows per page — used to compute the "Showing X–Y of Z" footer bounds and to gate the cross-page select-all banner. */
  pageSize: number;
  /** Current page number (1-indexed) — server-rendered authoritative value from the URL `?page=` param. Drives `<CircularPagination currentPage>`. */
  page: number;
  /** Total page count — computed on the server as `Math.ceil(total / pageSize)`. Drives `<CircularPagination totalPages>` and gates the footer pagination strip. */
  totalPages: number;
};

function summarize(outcome: BulkOutcome, noun = "prospect"): string {
  const parts: string[] = [];
  if (outcome.succeeded > 0)
    parts.push(
      `${outcome.succeeded} ${noun}${outcome.succeeded === 1 ? "" : "s"}`,
    );
  if (outcome.skipped > 0) parts.push(`${outcome.skipped} skipped`);
  if (outcome.failed.length > 0) parts.push(`${outcome.failed.length} failed`);
  return parts.join(" · ") || "Done";
}

export function ProspectsTable({
  prospects,
  lists,
  tags,
  teamMembers,
  markets,
  currentUserId,
  canDelete,
  headerCount,
  search,
  sort,
  dir,
  filters,
  total,
  pageSize,
  page,
  totalPages,
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [showBulkSms, setShowBulkSms] = useState(false);
  // Cross-page select-all mode. When true, the user has explicitly
  // expanded their selection beyond the visible page to every property
  // matching the current filters. Bound to a Set<string> of all those
  // ids; the banner shows "All N selected · Clear" instead of the
  // page-level toggle. Resets to false on any filter / search change
  // since the matching count would no longer match what was selected.
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  // URL-state machine — extracted into the shared hook in Phase 1.
  // Mode: "ssr" because /properties is a server-rendered page; the hook
  // wraps router.replace in startTransition and exposes navPending so
  // the table dims during the SSR roundtrip. The hook also owns the
  // 250ms search debounce, the searchDebounce ref cleanup, and the
  // 150ms minimum-skeleton floor.
  const ts = useTableUrlState<ParsedProspectsFilters>({
    basePath: "/properties",
    parsed: {
      page: 1,
      search: search.length === 0 ? null : search,
      sort,
      dir,
      filters,
    },
    mode: "ssr",
    config: {
      defaultSort: "created_at",
      defaultDir: "desc",
      sortableColumns: ["address", "market", "created_at"],
      buildFilterParams: buildProspectsFilterParams,
    },
  });
  const navPending = ts.navPending;
  // `totalPages` is now sourced from server-rendered props (Plan 01.5-04 contract).
  // showingFrom/showingTo are still computed client-side from `total + pageSize + page`
  // because they're a display-only derivation; the server doesn't need to ship them.
  const showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const showingTo = Math.min(page * pageSize, total);

  // Filter / search / sort change → the previously-selected "all matching"
  // set is no longer a faithful representation of what currently matches,
  // so drop it. Selection itself isn't reset (existing behavior — user
  // might have intentional manual picks that survive a refilter).
  useEffect(() => {
    setSelectAllMatching(false);
  }, [
    search,
    sort,
    dir,
    filters.vacant,
    filters.cass,
    filters.engagement,
    filters.market,
    filters.assignee,
  ]);

  const onSelectAllAcrossPages = () => {
    startTransition(async () => {
      const result = await callAction(
        getAllMatchingProspectIds({
          search: search.length === 0 ? null : search,
          filters,
        }),
        { fallbackMessage: "Could not select all matching prospects" },
      );
      if (result.ok) {
        setSelected(new Set(result.data));
        setSelectAllMatching(true);
      }
    });
  };

  const onClearAllSelection = () => {
    setSelected(new Set());
    setSelectAllMatching(false);
  };

  /** Apply a partial change to the filter set, preserving everything else
   *  and resetting pagination. The resulting URL drops any filter param
   *  whose value is null/false/'' (handled by buildProspectsHref). */
  const updateFilters = (patch: Partial<ParsedProspectsFilters>) => {
    const nextFilters: ParsedProspectsFilters = { ...filters, ...patch };
    ts.navigate(
      `/properties${buildProspectsHref({
        page: 1,
        search: search.length === 0 ? null : search,
        sort,
        dir,
        filters: nextFilters,
      })}`,
    );
  };

  /** Reset every filter param at once. Preserves search/sort. Used by the
   *  "Clear filters" text link which only renders when at least one
   *  filter is active. */
  const clearAllFilters = () => {
    ts.navigate(
      `/properties${buildProspectsHref({
        page: 1,
        search: search.length === 0 ? null : search,
        sort,
        dir,
        filters: {
          vacant: false,
          cass: null,
          engagement: null,
          market: null,
          assignee: null,
        },
      })}`,
    );
  };

  const anyFilterActive =
    filters.vacant ||
    filters.cass !== null ||
    filters.engagement !== null ||
    filters.market !== null ||
    filters.assignee !== null;

  const allSelected = useMemo(
    () => prospects.length > 0 && selected.size === prospects.length,
    [selected.size, prospects.length],
  );
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = () => {
    setSelected((prev) => {
      if (prev.size === prospects.length) return new Set();
      return new Set(prospects.map((p) => p.id));
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedIds = () => Array.from(selected);

  /**
   * Shared post-action handler: show a toast, keep failed rows selected so
   * the VA can retry, drop the rest, refresh the server view.
   */
  const finishBulk = (
    verb: string,
    outcome: BulkOutcome,
    noun = "prospect",
  ) => {
    const summary = `${verb} ${summarize(outcome, noun)}`;
    if (outcome.failed.length > 0) {
      toast.warning(summary, { description: outcome.failed[0].message });
    } else {
      toast.success(summary);
    }
    const failedIds = new Set(outcome.failed.map((f) => f.propertyId));
    setSelected(failedIds);
    router.refresh();
  };

  const handleQualify = () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    startTransition(async () => {
      const result = await callAction(qualifyLeadsBulk(ids), {
        fallbackMessage: "Could not qualify selected prospects",
      });
      if (result.ok) {
        const { qualified, alreadyQualified, failed } = result.data;
        // qualifyLeadsBulk has a bespoke shape (qualified/alreadyQualified
        // counters). Map to BulkOutcome semantics for the shared helper.
        finishBulk("Qualified", {
          succeeded: qualified,
          skipped: alreadyQualified,
          failed,
        });
      }
    });
  };

  const handleAssign = (userId: string | null) => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    startTransition(async () => {
      const result = await callAction(assignLeadsBulk(ids, userId), {
        fallbackMessage: "Could not assign selected prospects",
      });
      if (result.ok) {
        finishBulk(userId ? "Assigned" : "Unassigned", result.data);
      }
    });
  };

  const handleAddToList = (listId: string) => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    startTransition(async () => {
      const result = await callAction(addPropertiesToListBulk(ids, listId), {
        fallbackMessage: "Could not add to list",
      });
      if (result.ok) finishBulk("Added", result.data);
    });
  };

  const handleRemoveFromList = (listId: string) => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    startTransition(async () => {
      const result = await callAction(
        removePropertiesFromListBulk(ids, listId),
        { fallbackMessage: "Could not remove from list" },
      );
      if (result.ok) finishBulk("Removed", result.data);
    });
  };

  const handleApplyTag = (tagId: string) => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    startTransition(async () => {
      const result = await callAction(applyTagBulk(ids, tagId), {
        fallbackMessage: "Could not apply tag",
      });
      if (result.ok) finishBulk("Tagged", result.data);
    });
  };

  const handleVerifyAddress = () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    startTransition(async () => {
      const result = await callAction(verifyPropertiesBulk(ids), {
        fallbackMessage: "Could not start verify job",
      });
      if (result.ok) {
        toast.success(
          `Verifying ${ids.length} address${ids.length === 1 ? "" : "es"} in the background`,
          { description: "Watch progress on /jobs" },
        );
        setSelected(new Set());
        router.refresh();
      }
    });
  };

  const handleSkipTrace = () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    if (ids.length > 500) {
      toast.error(
        `Cannot skip-trace more than 500 properties at once. Split into smaller batches.`,
      );
      return;
    }
    startTransition(async () => {
      const result = await callAction(requestSkipTrace(ids), {
        fallbackMessage: "Could not request skip trace",
      });
      if (result.ok) {
        if (result.data.status === "queued") {
          toast.success(
            `Skip-trace started for ${ids.length} propert${ids.length === 1 ? "y" : "ies"}`,
            { description: "Watch progress on /jobs" },
          );
        } else {
          toast.success(
            `Skip-trace request sent for ${ids.length} propert${ids.length === 1 ? "y" : "ies"}`,
            { description: "Admin will approve on /jobs" },
          );
        }
        setSelected(new Set());
        router.refresh();
      }
    });
  };

  const handleDelete = () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Delete ${ids.length} prospect${ids.length === 1 ? "" : "s"}? This is a soft-delete — an admin can recover from the database.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const result = await callAction(deletePropertiesBulk(ids), {
        fallbackMessage: "Could not delete prospects",
      });
      if (result.ok) {
        finishBulk("Deleted", result.data);
      }
    });
  };

  const hasLists = lists.length > 0;
  const hasTags = tags.length > 0;
  const hasTeam = teamMembers.length > 0;

  const hasSelection = selected.size > 0;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Prospects" }]}
        title="Prospects"
        description={headerCount}
        actions={
          <>
          {hasSelection ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={pending}
            >
              Clear
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant={hasSelection ? "default" : "outline"}
                  disabled={!hasSelection || pending}
                  aria-label={
                    hasSelection
                      ? `Actions for ${selected.size} selected`
                      : "Actions (select prospects first)"
                  }
                >
                  Actions
                  {hasSelection ? ` (${selected.size})` : ""}
                  <ChevronDownIcon className="ml-1 size-3.5" />
                </Button>
              }
            />
              <DropdownMenuContent align="end" className="w-56">
                {/* ------------- Advance ------------- */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Advance
                  </DropdownMenuLabel>
                  <DropdownMenuItem onClick={handleQualify}>
                    Promote to Lead
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={!hasTeam}>
                      Assign to…
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-56">
                      {hasTeam ? (
                        <>
                          <DropdownMenuItem
                            onClick={() => handleAssign(null)}
                          >
                            Unassign
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {teamMembers.map((m) => (
                            <DropdownMenuItem
                              key={m.id}
                              onClick={() => handleAssign(m.id)}
                            >
                              {m.id === currentUserId
                                ? `${m.email} (me)`
                                : m.email}
                            </DropdownMenuItem>
                          ))}
                        </>
                      ) : (
                        <DropdownMenuItem disabled>
                          No team members
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuGroup>

                  <DropdownMenuItem onClick={() => setShowBulkSms(true)}>
                    Bulk SMS
                  </DropdownMenuItem>

                <DropdownMenuSeparator />

                {/* ------------- Enrich ------------- */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Enrich
                  </DropdownMenuLabel>
                  <DropdownMenuItem onClick={handleVerifyAddress}>
                    Verify address (CASS)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleSkipTrace}>
                    Skip trace
                  </DropdownMenuItem>
                </DropdownMenuGroup>

                <DropdownMenuSeparator />

                {/* ------------- Organize ------------- */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Organize
                  </DropdownMenuLabel>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={!hasLists}>
                      Add to list…
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                      {hasLists ? (
                        lists.map((l) => (
                          <DropdownMenuItem
                            key={l.id}
                            onClick={() => handleAddToList(l.id)}
                          >
                            {l.color ? (
                              <span
                                className="mr-2 size-2.5 rounded-full"
                                style={{ backgroundColor: l.color }}
                              />
                            ) : null}
                            {l.name}
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <DropdownMenuItem disabled>No lists</DropdownMenuItem>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={!hasLists}>
                      Remove from list…
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                      {hasLists ? (
                        lists.map((l) => (
                          <DropdownMenuItem
                            key={l.id}
                            onClick={() => handleRemoveFromList(l.id)}
                          >
                            {l.name}
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <DropdownMenuItem disabled>No lists</DropdownMenuItem>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={!hasTags}>
                      Apply tag…
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                      {hasTags ? (
                        tags.map((t) => (
                          <DropdownMenuItem
                            key={t.id}
                            onClick={() => handleApplyTag(t.id)}
                          >
                            #{t.name}
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <DropdownMenuItem disabled>
                          No custom tags
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuGroup>

                <DropdownMenuSeparator />

                {/* ------------- Danger zone ------------- */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Danger zone
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={handleDelete}
                    disabled={!canDelete}
                    className="text-destructive focus:text-destructive"
                  >
                    Delete
                    {!canDelete ? (
                      <span className="text-muted-foreground ml-2 text-[10px] uppercase">
                        Admin only
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
          </DropdownMenu>
          <Link href="/import" className={buttonVariants()}>
            Import CSV
          </Link>
          </>
        }
      />

      {/* Unified toolbar — search + filter pills inside one rounded card,
       *  matching the /leads kanban toolbar so the two surfaces feel
       *  consistent. The search bar takes flexible width on the left;
       *  the filter row sits inline on the right, wrapping on narrow
       *  viewports. The rounded-card container + flex behavior come from
       *  <TableToolbar>; the search markup + 250ms debounce come from
       *  <TableToolbarSearch>. The filter cluster (<ProspectFilters>)
       *  stays domain-specific.
       */}
      <TableToolbar
        state={
          ts as unknown as UseTableUrlStateReturn<Record<string, unknown>>
        }
      >
        <TableToolbarSearch
          ariaLabel="Search prospects by address"
          placeholder="Search address…"
          testId="prospects-search"
        />

        <ProspectFilters
          filters={filters}
          teamMembers={teamMembers}
          markets={markets}
          onChange={updateFilters}
          anyActive={anyFilterActive}
          onClearAll={clearAllFilters}
        />
      </TableToolbar>

      <SelectAllBanner
        allOnPageSelected={allSelected}
        selectAllMatching={selectAllMatching}
        pageSize={prospects.length}
        total={total}
        selectedCount={selected.size}
        onSelectAllAcrossPages={onSelectAllAcrossPages}
        onClear={onClearAllSelection}
      />

      <BulkSmsModal
        open={showBulkSms}
        propertyIds={Array.from(selected)}
        onClose={() => setShowBulkSms(false)}
        onQueued={() => {
          setSelected(new Set());
          router.refresh();
        }}
      />

      <DataTableShell
        data-pending={navPending}
        data-testid="prospects-table-container"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all prospects on this page"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  className="size-4 cursor-pointer"
                />
              </TableHead>
              <SortableHeader
                column="address"
                current={ts.sort}
                dir={ts.dir}
                onClick={(col) => ts.onSort(col)}
                testIdPrefix="prospects"
              >
                Address
              </SortableHeader>
              <SortableHeader
                column="market"
                current={ts.sort}
                dir={ts.dir}
                onClick={(col) => ts.onSort(col)}
                testIdPrefix="prospects"
              >
                Market
              </SortableHeader>
              {/* Status column header is intentionally blank — pills speak for themselves. */}
              <TableHead aria-label="Status" />
              <TableHead>Last message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {navPending ? (
              // Skeleton rows during search / sort / filter navigation.
              // Match the visible row count (or 5 minimum) so the table
              // doesn't snap-resize when results come back.
              Array.from({ length: Math.max(prospects.length, 5) }).map(
                (_, i) => (
                  <TableRow
                    key={`skeleton-${i}`}
                    data-testid="prospects-skeleton-row"
                  >
                    <TableCell>
                      <Skeleton className="size-4 rounded" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-72" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Skeleton className="h-5 w-16 rounded-full" />
                        <Skeleton className="h-5 w-16 rounded-full" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-56" />
                    </TableCell>
                  </TableRow>
                ),
              )
            ) : prospects.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-muted-foreground py-8 text-center"
                >
                  {search.length > 0
                    ? `No prospects match "${search}". Try a different address.`
                    : "No prospects. Import a CSV to fill the data lake."}
                </TableCell>
              </TableRow>
            ) : (
              prospects.map((p) => {
                const isChecked = selected.has(p.id);
                return (
                  <TableRow
                    key={p.id}
                    data-selected={isChecked}
                    className="hover:bg-muted/50 cursor-pointer data-[selected=true]:bg-muted/40"
                    onClick={() => router.push(`/leads/${p.id}`)}
                  >
                    <TableCell
                      onClick={(e) => e.stopPropagation()}
                      className="cursor-default"
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.address}`}
                        checked={isChecked}
                        onChange={() => toggleOne(p.id)}
                        className="size-4 cursor-pointer"
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {formatFullAddress({
                        address: p.address,
                        city: p.city,
                        state: p.state,
                        zip: p.zip,
                      })}
                    </TableCell>
                    <TableCell>{p.market ?? "—"}</TableCell>
                    <TableCell>
                      <StatusPills
                        cass={p.cass_status}
                        isVacant={p.is_vacant}
                        engagement={p.engagement}
                        dispo={p.outreach_dispo}
                      />
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground max-w-[280px] truncate text-sm italic"
                      data-testid={`prospects-last-message-${p.id}`}
                    >
                      {p.last_message_preview ? (
                        <>&ldquo;{p.last_message_preview}&rdquo;</>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        <DataTableFooter>
          <span className="text-muted-foreground text-sm">
            {total === 0
              ? "No prospects"
              : `Showing ${showingFrom.toLocaleString()}–${showingTo.toLocaleString()} of ${total.toLocaleString()}`}
          </span>
          {totalPages > 1 && (
            <CircularPagination
              currentPage={page}
              totalPages={totalPages}
              onPageChange={(p) =>
                ts.navigate(
                  `${ts.basePath}${ts.buildHref({
                    page: p,
                    search: ts.search.length === 0 ? null : ts.search,
                    sort: ts.sort,
                    dir: ts.dir,
                    filters: ts.filters,
                  })}`,
                )
              }
            />
          )}
        </DataTableFooter>
      </DataTableShell>
    </>
  );
}

/**
 * Stacked status pills — single column merging CASS, Vacancy, and
 * Engagement signals into one visual cluster. Pill rules:
 *
 *   - CASS pill always renders (Verified / Unverified / Invalid / Ambiguous).
 *   - Vacant pill renders only when is_vacant === true (the negative
 *     case is silent — no signal, no noise).
 *   - Engagement pill renders only when there's a thread (Contacted /
 *     Replying); silent for fresh rows.
 *
 * Pills wrap horizontally on wide rows; on narrow widths flexbox stacks
 * them. Tooltip on each pill explains the rule in human terms.
 */
function StatusPills({
  cass,
  isVacant,
  engagement,
  dispo,
}: {
  cass: string;
  isVacant: boolean | null;
  engagement: EngagementState;
  dispo: string | null;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      <CassPill status={cass} />
      {isVacant === true ? <VacantPill /> : null}
      {engagement !== "none" ? <EngagementPill state={engagement} /> : null}
      {dispo ? <DispoPill dispo={dispo} /> : null}
    </div>
  );
}

const DISPO_PILL_META: Record<string, { label: string; className: string }> = {
  wrong_number: {
    label: "Wrong #",
    className: "bg-zinc-100 text-zinc-600 hover:bg-zinc-100",
  },
  bad_number: {
    label: "Bad #",
    className: "bg-zinc-100 text-zinc-600 hover:bg-zinc-100",
  },
  not_interested: {
    label: "Not interested",
    className: "bg-orange-100 text-orange-800 hover:bg-orange-100",
  },
  opted_out: {
    label: "Opted out",
    className: "bg-red-100 text-red-800 hover:bg-red-100",
  },
  dnc: {
    label: "Do not contact",
    className: "bg-red-100 text-red-800 hover:bg-red-100",
  },
  nurture: {
    label: "Nurture",
    className: "bg-blue-100 text-blue-800 hover:bg-blue-100",
  },
  callback_requested: {
    label: "Callback",
    className: "bg-purple-100 text-purple-800 hover:bg-purple-100",
  },
};

function DispoPill({ dispo }: { dispo: string }) {
  const meta = DISPO_PILL_META[dispo];
  if (!meta) return null;
  return (
    <Badge className={cn("text-[10px] font-medium", meta.className)}>
      {meta.label}
    </Badge>
  );
}

function CassPill({ status }: { status: string }) {
  const meta = (() => {
    switch (status) {
      case "verified":
        return {
          label: "Verified",
          className: "bg-emerald-100 text-emerald-900 hover:bg-emerald-100",
          tooltip: "USPS-verified — skip-trace ready.",
          testId: "cass-verified",
        };
      case "unverified":
        return {
          label: "Unverified",
          className: "bg-amber-100 text-amber-900 hover:bg-amber-100",
          tooltip:
            "Not yet CASS-verified. Run address verification before skip-trace to avoid wasting credits.",
          testId: "cass-unverified",
        };
      case "invalid":
        return {
          label: "Invalid",
          className: "bg-red-100 text-red-900 hover:bg-red-100",
          tooltip: "USPS rejected this address. Skip-trace will not work.",
          testId: "cass-invalid",
        };
      case "ambiguous":
        return {
          label: "Ambiguous",
          className: "bg-orange-100 text-orange-900 hover:bg-orange-100",
          tooltip: "Multiple matches at USPS — needs manual disambiguation.",
          testId: "cass-ambiguous",
        };
      default:
        return {
          label: status || "Unknown",
          className: "bg-muted text-muted-foreground",
          tooltip: status,
          testId: "cass-unknown",
        };
    }
  })();
  return (
    <Badge
      variant="secondary"
      className={meta.className}
      data-testid={meta.testId}
      title={meta.tooltip}
    >
      {meta.label}
    </Badge>
  );
}

function VacantPill() {
  return (
    <Badge
      variant="secondary"
      className="bg-yellow-100 text-yellow-900 hover:bg-yellow-100"
      data-testid="vacant-true"
      title="Marked vacant — high-priority wholesale signal."
    >
      Vacant
    </Badge>
  );
}

/**
 * Filter row above the table — three independent toggle buttons +
 * two single-select dropdowns. Each control mutates the URL via
 * router.replace, so state lives in the URL (shareable + bookmarkable +
 * back-button-correct). Active toggles render filled with an X to
 * remove; inactive render outlined.
 */
function ProspectFilters({
  filters,
  teamMembers,
  markets,
  onChange,
  anyActive,
  onClearAll,
}: {
  filters: ParsedProspectsFilters;
  teamMembers: TeamMemberOption[];
  markets: string[];
  onChange: (patch: Partial<ParsedProspectsFilters>) => void;
  anyActive: boolean;
  onClearAll: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterToggle
        active={filters.vacant}
        label="Vacant"
        testId="filter-vacant"
        onClick={() => onChange({ vacant: !filters.vacant })}
      />
      <FilterToggle
        active={filters.cass === "verified"}
        label="Verified"
        testId="filter-verified"
        onClick={() =>
          onChange({ cass: filters.cass === "verified" ? null : "verified" })
        }
      />
      <FilterToggle
        active={filters.engagement === "contacted"}
        label="Contacted"
        testId="filter-contacted"
        onClick={() =>
          onChange({
            engagement:
              filters.engagement === "contacted" ? null : "contacted",
          })
        }
      />

      <div className="ml-2 flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" data-testid="filter-market">
                Market: {filters.market ?? "Anywhere"}
                <ChevronDownIcon className="ml-1 size-3" />
              </Button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuItem
              onClick={() => onChange({ market: null })}
              data-testid="filter-market-any"
            >
              Anywhere
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {markets.map((m) => (
              <DropdownMenuItem
                key={m}
                onClick={() => onChange({ market: m })}
                data-testid={`filter-market-${m.replace(/\s+/g, "-")}`}
              >
                {m}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" data-testid="filter-assignee">
                Assignee: {assigneeLabel(filters.assignee, teamMembers)}
                <ChevronDownIcon className="ml-1 size-3" />
              </Button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuItem
              onClick={() => onChange({ assignee: null })}
              data-testid="filter-assignee-any"
            >
              Anyone
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onChange({ assignee: "unassigned" })}
              data-testid="filter-assignee-unassigned"
            >
              Unassigned
            </DropdownMenuItem>
            {teamMembers.length > 0 ? <DropdownMenuSeparator /> : null}
            {teamMembers.map((tm) => (
              <DropdownMenuItem
                key={tm.id}
                onClick={() => onChange({ assignee: tm.id })}
                data-testid={`filter-assignee-${tm.id}`}
              >
                {tm.email}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {anyActive && (
        <button
          type="button"
          onClick={onClearAll}
          data-testid="filter-clear-all"
          className="text-muted-foreground hover:text-foreground ml-2 text-sm underline-offset-2 hover:underline"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * Cross-page selection banner. Renders only when the user has selected
 * every visible row (so we know they're trying to "select all"). Two
 * states:
 *
 *   per-page mode: "All N on this page selected. Select all M prospects →"
 *   all-matching:  "All M selected across all pages. Clear"
 *
 * Hidden when nothing is selected, or when only some rows on the page
 * are selected (the row checkboxes carry that state instead).
 */
function SelectAllBanner({
  allOnPageSelected,
  selectAllMatching,
  pageSize,
  total,
  selectedCount,
  onSelectAllAcrossPages,
  onClear,
}: {
  allOnPageSelected: boolean;
  selectAllMatching: boolean;
  pageSize: number;
  total: number;
  selectedCount: number;
  onSelectAllAcrossPages: () => void;
  onClear: () => void;
}) {
  // Don't render when there's nothing useful to say.
  if (!allOnPageSelected && !selectAllMatching) return null;
  // No banner when there's only one page — page-select == matching-set.
  if (!selectAllMatching && total <= pageSize) return null;

  const fmt = (n: number) => n.toLocaleString();

  if (selectAllMatching) {
    return (
      <div
        data-testid="select-all-banner"
        data-mode="all-matching"
        className="bg-muted/40 flex items-center justify-between gap-3 rounded-md border px-4 py-2 text-sm"
      >
        <span>
          All <strong>{fmt(selectedCount)}</strong> prospects selected across
          all pages.
        </span>
        <button
          type="button"
          onClick={onClear}
          data-testid="select-all-clear"
          className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          Clear
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="select-all-banner"
      data-mode="per-page"
      className="bg-muted/40 flex items-center justify-between gap-3 rounded-md border px-4 py-2 text-sm"
    >
      <span>
        All <strong>{fmt(pageSize)}</strong> on this page selected.
      </span>
      <button
        type="button"
        onClick={onSelectAllAcrossPages}
        data-testid="select-all-across-pages"
        className="text-foreground font-medium underline-offset-2 hover:underline"
      >
        Select all {fmt(total)} prospects →
      </button>
    </div>
  );
}

function FilterToggle({
  active,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      data-testid={testId}
      data-active={active}
      className="gap-1"
    >
      {label}
      {active ? <X className="size-3" aria-hidden /> : null}
    </Button>
  );
}

function assigneeLabel(
  assignee: string | null,
  teamMembers: TeamMemberOption[],
): string {
  if (!assignee) return "Anyone";
  if (assignee === "unassigned") return "Unassigned";
  const tm = teamMembers.find((m) => m.id === assignee);
  return tm ? tm.email : "Selected";
}

function EngagementPill({ state }: { state: Exclude<EngagementState, "none"> }) {
  if (state === "replying") {
    return (
      <Badge
        variant="secondary"
        className="bg-amber-100 text-amber-900 hover:bg-amber-100"
        data-testid="engagement-replying"
        title="Their reply was last — your move."
      >
        Replying
      </Badge>
    );
  }
  return (
    <Badge
      variant="secondary"
      className="bg-sky-100 text-sky-900 hover:bg-sky-100"
      data-testid="engagement-contacted"
      title="Outbound message sent, no reply yet."
    >
      Contacted
    </Badge>
  );
}
