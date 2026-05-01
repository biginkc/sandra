"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDownIcon, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildProspectsHref,
  type EngagementState,
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
  setMotivationBulk,
  verifyPropertiesBulk,
  type BulkOutcome,
} from "../leads/actions";
import { requestSkipTrace } from "@/lib/skip-trace/actions";

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
};

const MOTIVATION_OPTIONS: {
  value: "hot" | "warm" | "cold" | null;
  label: string;
  dot: string;
}[] = [
  { value: "hot", label: "Hot", dot: "bg-red-500" },
  { value: "warm", label: "Warm", dot: "bg-amber-500" },
  { value: "cold", label: "Cold", dot: "bg-blue-500" },
  { value: null, label: "Clear", dot: "bg-transparent border border-muted-foreground" },
];

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
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  // Local search input state — lets the user type without a server roundtrip
  // every keystroke. Synced to the URL on a 250ms debounce. We do NOT mirror
  // `search` into local state on parent re-renders; the input is uncontrolled
  // (defaultValue) so router.refresh + new ?search= props don't clobber the
  // user's current keystrokes mid-edit.
  const [searchInput, setSearchInput] = useState(search);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, []);

  const onSearchChange = (next: string) => {
    setSearchInput(next);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      const trimmed = next.trim();
      router.replace(
        `/properties${buildProspectsHref({
          page: 1,
          search: trimmed.length === 0 ? null : trimmed,
          sort,
          dir,
        })}`,
        { scroll: false },
      );
    }, 250);
  };

  const onClearSearch = () => {
    setSearchInput("");
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    router.replace(
      `/properties${buildProspectsHref({ page: 1, search: null, sort, dir })}`,
      { scroll: false },
    );
  };

  /** Click a sortable column header. Same column flips dir; new column
   *  resets to ascending (so the row a user "clicks toward" is the one
   *  they expect to see at the top). Resets to page 1. */
  const onSortClick = (column: SortableColumn) => {
    const nextDir: SortDirection =
      sort === column ? (dir === "asc" ? "desc" : "asc") : "asc";
    router.replace(
      `/properties${buildProspectsHref({
        page: 1,
        search: search.length === 0 ? null : search,
        sort: column,
        dir: nextDir,
      })}`,
      { scroll: false },
    );
  };

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

  const handleSetMotivation = (level: "hot" | "warm" | "cold" | null) => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    startTransition(async () => {
      const result = await callAction(setMotivationBulk(ids, level), {
        fallbackMessage: "Could not set motivation",
      });
      if (result.ok) {
        finishBulk(level ? `Set ${level}` : "Cleared motivation on", result.data);
      }
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
                    Qualify selected
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
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      Set motivation…
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-40">
                      {MOTIVATION_OPTIONS.map((m) => (
                        <DropdownMenuItem
                          key={m.label}
                          onClick={() => handleSetMotivation(m.value)}
                          className="gap-2"
                        >
                          <span className={`size-2 rounded-full ${m.dot}`} />
                          {m.label}
                        </DropdownMenuItem>
                      ))}
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

      <div className="relative max-w-sm">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          type="text"
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search address…"
          aria-label="Search prospects by address"
          data-testid="prospects-search"
          className="pr-9 pl-9"
        />
        {searchInput.length > 0 && (
          <button
            type="button"
            onClick={onClearSearch}
            aria-label="Clear search"
            data-testid="prospects-search-clear"
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded p-1"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      <div className="border-border rounded-md border">
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
              <SortableHeader column="address" sort={sort} dir={dir} onClick={onSortClick}>
                Address
              </SortableHeader>
              <SortableHeader column="city" sort={sort} dir={dir} onClick={onSortClick}>
                City
              </SortableHeader>
              <SortableHeader column="state" sort={sort} dir={dir} onClick={onSortClick}>
                State
              </SortableHeader>
              <SortableHeader column="zip" sort={sort} dir={dir} onClick={onSortClick}>
                ZIP
              </SortableHeader>
              <SortableHeader column="market" sort={sort} dir={dir} onClick={onSortClick}>
                Market
              </SortableHeader>
              <SortableHeader column="cass_status" sort={sort} dir={dir} onClick={onSortClick}>
                CASS
              </SortableHeader>
              <SortableHeader column="is_vacant" sort={sort} dir={dir} onClick={onSortClick}>
                Vacant
              </SortableHeader>
              <TableHead>Engagement</TableHead>
              <TableHead>Last message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prospects.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={10}
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
                    <TableCell className="font-medium">{p.address}</TableCell>
                    <TableCell>{p.city ?? "—"}</TableCell>
                    <TableCell>{p.state}</TableCell>
                    <TableCell>{p.zip ?? "—"}</TableCell>
                    <TableCell>{p.market ?? "—"}</TableCell>
                    <TableCell>
                      <CassStatusIndicator status={p.cass_status} />
                    </TableCell>
                    <TableCell>
                      {p.is_vacant === true
                        ? "Yes"
                        : p.is_vacant === false
                          ? "No"
                          : "—"}
                    </TableCell>
                    <TableCell>
                      <EngagementBadge state={p.engagement} />
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
      </div>
    </>
  );
}

/**
 * Clickable column header. Same column flips dir; new column resets
 * to ascending. Active column shows an up/down arrow; inactive columns
 * show a subtle two-way arrow so the affordance is visible without
 * dominating.
 */
function SortableHeader({
  column,
  sort,
  dir,
  onClick,
  children,
}: {
  column: SortableColumn;
  sort: SortableColumn;
  dir: SortDirection;
  onClick: (col: SortableColumn) => void;
  children: React.ReactNode;
}) {
  const isActive = sort === column;
  const Icon = isActive ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className="select-none">
      <button
        type="button"
        onClick={() => onClick(column)}
        aria-sort={
          isActive ? (dir === "asc" ? "ascending" : "descending") : "none"
        }
        data-testid={`prospects-sort-${column}`}
        className={`hover:text-foreground flex items-center gap-1 text-left ${
          isActive ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        <span>{children}</span>
        <Icon className="size-3 opacity-70" aria-hidden />
      </button>
    </TableHead>
  );
}

/**
 * Engagement pill — keys off the property's most-recent message direction.
 * "none" renders a transparent placeholder so the column has a stable width
 * even on rows that have never been contacted.
 */
function EngagementBadge({ state }: { state: EngagementState }) {
  if (state === "none") {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
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

/**
 * CASS status indicator — color-coded so the skip-trace eligibility of
 * each row is readable at a glance. Tooltip explains what each status
 * means in human terms (skip-trace ready / pending / blocked).
 *
 * `verified` is the only status where skip-trace will pay vendor
 * credits productively; everything else either blocks the call (per
 * the pre-flight gate) or means the address is unusable.
 */
function CassStatusIndicator({ status }: { status: string }) {
  const meta = (() => {
    switch (status) {
      case "verified":
        return {
          label: "Verified",
          dot: "bg-emerald-500",
          tooltip: "USPS-verified — skip-trace ready.",
        };
      case "unverified":
        return {
          label: "Unverified",
          dot: "bg-amber-500",
          tooltip: "Not yet CASS-verified. Run address verification before skip-trace to avoid wasting credits.",
        };
      case "invalid":
        return {
          label: "Invalid",
          dot: "bg-red-500",
          tooltip: "USPS rejected this address. Skip-trace will not work.",
        };
      case "ambiguous":
        return {
          label: "Ambiguous",
          dot: "bg-orange-500",
          tooltip: "Multiple matches at USPS — needs manual disambiguation.",
        };
      default:
        return {
          label: status,
          dot: "bg-muted",
          tooltip: status,
        };
    }
  })();
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      title={meta.tooltip}
    >
      <span className={`size-2 rounded-full ${meta.dot}`} aria-hidden />
      <span className="text-foreground">{meta.label}</span>
    </span>
  );
}
