"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import { SkipTracePreflightDialog } from "@/components/skip-trace-preflight-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatFullAddress,
  type EngagementState,
  type FilterBlock,
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
  FILTER_NAVIGATION_START_EVENT,
  type FilterNavigationStartDetail,
} from "./_components/use-filter-state";

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
import { getAllMatchingProspectIds } from "./actions";
import { BatchCreateModal } from "./batch-create-modal";
import { BulkSmsModal } from "./bulk-sms-modal";
import { BulkTagModal } from "./bulk-tag-modal";

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
  currentUserId: string | null;
  canDelete: boolean;
  /** Rendered into the header subhead so the count stays right next to the title. */
  headerCount: string;
  /** Current URL state — drives the search input + sort header indicators. */
  search: string;
  sort: SortableColumn;
  dir: SortDirection;
  /** Plan 09 v1 filter source-of-truth — the canonical block stack the
   *  page already filtered the rows by. Passed through to the
   *  cross-page select-all handler so getAllMatchingProspectIds runs the
   *  same SQL chain via Plan 04's applyFilters. The 5-chip
   *  ParsedProspectsFilters previously on this prop is GONE; the chips
   *  themselves moved into the FilterDrawer's per-block components. */
  blockStack: FilterBlock[];
  /** Raw `?filters=` URL param (the encoded JSON) — preserved verbatim
   *  on pagination / sort / search nav so the user's filter state isn't
   *  silently dropped when they click "page 3". Null when no filters are
   *  active in the URL. */
  filtersParam: string | null;
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
  currentUserId,
  canDelete,
  headerCount,
  search,
  sort,
  dir,
  blockStack,
  filtersParam,
  total,
  pageSize,
  page,
  totalPages,
}: Props) {
  const router = useRouter();
  const blockStackKey = JSON.stringify(blockStack);
  const selectionScopeKey = `${search}\u0000${sort}\u0000${dir}\u0000${blockStackKey}`;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [showBatchCreate, setShowBatchCreate] = useState(false);
  const [showBulkSms, setShowBulkSms] = useState(false);
  const [showBulkTag, setShowBulkTag] = useState(false);
  const [skipTracePreflightIds, setSkipTracePreflightIds] = useState<string[]>(
    [],
  );
  const [filterNavPending, setFilterNavPending] = useState(false);
  const [filterNavTargetKey, setFilterNavTargetKey] = useState<string | null>(
    null,
  );
  const filterNavFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Cross-page select-all mode. The stored key marks the exact
  // search/sort/filter scope that produced the selected id set. When the
  // page scope changes, the selected ids may survive as manual picks, but
  // they no longer claim to represent "all matching" for the new scope.
  const [selectAllMatchingKey, setSelectAllMatchingKey] = useState<string | null>(
    null,
  );
  const selectAllMatching = selectAllMatchingKey === selectionScopeKey;
  const selectionScopeStale =
    selectAllMatchingKey !== null && selectAllMatchingKey !== selectionScopeKey;
  const selectedInScope = useMemo(
    () => (selectionScopeStale ? new Set<string>() : selected),
    [selected, selectionScopeStale],
  );

  // URL-state machine — extracted into the shared hook in Phase 1.
  // Mode: "ssr" because /properties is a server-rendered page; the hook
  // wraps router.replace in startTransition and exposes navPending so
  // the table dims during the SSR roundtrip. The hook also owns the
  // 250ms search debounce, the searchDebounce ref cleanup, and the
  // 150ms minimum-skeleton floor.
  //
  // Plan 09: filter URL state moved to ?filters=<encoded-json>; the
  // drawer + useFilterState own filter shape now. The table's URL
  // state machine still drives page/sort/dir/search — but pagination /
  // sort / search-nav must NOT silently drop the active ?filters=
  // param. We pass `filtersParam` through `buildFilterParams` so the
  // hook re-emits it on every URL it builds.
  const ts = useTableUrlState<Record<string, never>>({
    basePath: "/properties",
    parsed: {
      page: 1,
      search: search.length === 0 ? null : search,
      sort,
      dir,
      filters: {} as Record<string, never>,
    },
    mode: "ssr",
    config: {
      defaultSort: "created_at",
      defaultDir: "desc",
      sortableColumns: ["address", "market", "created_at"],
      buildFilterParams: (_filters, sp) => {
        // Preserve the v1 ?filters= state across pagination/sort/search nav.
        // The hook strips defaults / empty values from the SearchParams it
        // builds; without this re-emit, paginating from page 1→2 of a
        // filtered view would land you on an unfiltered page 2.
        if (filtersParam) sp.set("filters", filtersParam);
      },
    },
  });
  const navPending = ts.navPending || filterNavPending;
  // `totalPages` is now sourced from server-rendered props (Plan 01.5-04 contract).
  // showingFrom/showingTo are still computed client-side from `total + pageSize + page`
  // because they're a display-only derivation; the server doesn't need to ship them.
  const showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const showingTo = Math.min(page * pageSize, total);

  useEffect(() => {
    const showFilterSkeleton = (event: Event) => {
      const targetKey =
        event instanceof CustomEvent &&
        typeof (event as CustomEvent<FilterNavigationStartDetail>).detail
          ?.blocksKey === "string"
          ? (event as CustomEvent<FilterNavigationStartDetail>).detail.blocksKey
          : null;
      setFilterNavPending(true);
      setFilterNavTargetKey(targetKey);
      if (filterNavFallbackTimer.current) {
        clearTimeout(filterNavFallbackTimer.current);
      }
      filterNavFallbackTimer.current = setTimeout(() => {
        setFilterNavPending(false);
        setFilterNavTargetKey(null);
      }, 5_000);
    };

    window.addEventListener(FILTER_NAVIGATION_START_EVENT, showFilterSkeleton);
    return () => {
      window.removeEventListener(
        FILTER_NAVIGATION_START_EVENT,
        showFilterSkeleton,
      );
      if (filterNavFallbackTimer.current) {
        clearTimeout(filterNavFallbackTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!filterNavPending) return;
    if (filterNavTargetKey != null && filterNavTargetKey !== blockStackKey) {
      return;
    }

    const timer = setTimeout(() => {
      setFilterNavPending(false);
      setFilterNavTargetKey(null);
      if (filterNavFallbackTimer.current) {
        clearTimeout(filterNavFallbackTimer.current);
        filterNavFallbackTimer.current = null;
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [blockStackKey, filterNavPending, filterNavTargetKey]);

  const onSelectAllAcrossPages = () => {
    startTransition(async () => {
      const result = await callAction(
        getAllMatchingProspectIds({
          search: search.length === 0 ? null : search,
          blockStack,
        }),
        { fallbackMessage: "Could not select all matching prospects" },
      );
      if (result.ok) {
        setSelected(new Set(result.data));
        setSelectAllMatchingKey(selectionScopeKey);
      }
    });
  };

  const onClearAllSelection = () => {
    setSelected(new Set());
    setSelectAllMatchingKey(null);
  };

  const allSelected = useMemo(
    () =>
      prospects.length > 0 && prospects.every((p) => selectedInScope.has(p.id)),
    [prospects, selectedInScope],
  );
  const someSelected = selectedInScope.size > 0 && !allSelected;

  const toggleAll = () => {
    setSelectAllMatchingKey(null);
    setSelected(() => {
      if (allSelected) return new Set();
      return new Set(prospects.map((p) => p.id));
    });
  };

  const toggleOne = (id: string) => {
    setSelectAllMatchingKey(null);
    setSelected((prev) => {
      const next = selectionScopeStale ? new Set<string>() : new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedIds = () => Array.from(selectedInScope);

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
    setSelectAllMatchingKey(null);
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
        onClearAllSelection();
        router.refresh();
      }
    });
  };

  const handleSkipTrace = () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    setSkipTracePreflightIds(ids);
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

  const hasSelection = selectedInScope.size > 0;

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
              onClick={onClearAllSelection}
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
                      ? `Actions for ${selectedInScope.size} selected`
                      : "Actions (select prospects first)"
                  }
                >
                  Actions
                  {hasSelection ? ` (${selectedInScope.size})` : ""}
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
                  <DropdownMenuItem onClick={() => setShowBatchCreate(true)}>
                    Create dialer batch
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
                  <DropdownMenuItem onClick={() => setShowBulkTag(true)}>
                    Create/apply tag…
                  </DropdownMenuItem>
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

      {/* Unified toolbar — Plan 09 dropped the inline 5-chip cluster; the
       *  drawer + Quick Filters bar above the table own filter UI now.
       *  The search input is the only control here. The rounded-card
       *  container + flex behavior come from <TableToolbar>; the search
       *  markup + 250ms debounce come from <TableToolbarSearch>. */}
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
      </TableToolbar>

      <SelectAllBanner
        allOnPageSelected={allSelected}
        selectAllMatching={selectAllMatching}
        pageSize={prospects.length}
        total={total}
        selectedCount={selectedInScope.size}
        onSelectAllAcrossPages={onSelectAllAcrossPages}
        onClear={onClearAllSelection}
      />

      <BulkSmsModal
        open={showBulkSms}
        propertyIds={selectedIds()}
        onClose={() => setShowBulkSms(false)}
        onQueued={() => {
          onClearAllSelection();
          router.refresh();
        }}
      />
      <BulkTagModal
        open={showBulkTag}
        propertyIds={selectAllMatching ? [] : selectedIds()}
        filterArgs={
          selectAllMatching
            ? { search: search.length === 0 ? null : search, blockStack }
            : undefined
        }
        tags={tags}
        allMatching={selectAllMatching}
        totalCount={selectAllMatching ? total : selectedInScope.size}
        onClose={() => setShowBulkTag(false)}
        onApplied={(outcome) => finishBulk("Tagged", outcome)}
      />
      <BatchCreateModal
        open={showBatchCreate}
        onClose={() => setShowBatchCreate(false)}
        selectedIds={selectAllMatching ? undefined : selectedIds()}
        filterArgs={
          selectAllMatching
            ? { search: search.length === 0 ? null : search, blockStack }
            : undefined
        }
        totalCount={selectAllMatching ? total : selectedInScope.size}
      />
      <SkipTracePreflightDialog
        open={skipTracePreflightIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setSkipTracePreflightIds([]);
        }}
        propertyIds={skipTracePreflightIds}
        onFinished={() => {
          onClearAllSelection();
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
                const isChecked = selectedInScope.has(p.id);
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
          <span
            className="text-muted-foreground text-sm"
            data-testid="prospects-result-count"
          >
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
