"use client";

import { Loader2Icon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export type InboxFilter =
  | "all"
  | "mine"
  | "unassigned"
  | "unknown"
  | "dismissed"
  | "unread"
  | "escalated"
  | "dispo"
  | "needs_outcome";

export type InboxFilterCounts = Record<InboxFilter, number>;

type Props = {
  active: InboxFilter;
  filterCounts: InboxFilterCounts;
  /** Hide Mine + Unassigned chips when no auth user is on the request. */
  showAssignmentChips: boolean;
  /** True when DNC threads are currently hidden from the list. URL state:
   *  default (param absent) → hidden; `?hideDnc=0` → shown. */
  hideDnc: boolean;
  /** Count of DNC threads that the current filter set would have shown
   *  if the toggle were OFF. Surfaced as a tiny hint next to the toggle. */
  hiddenDncCount: number;
  /** Notifies the result region while a filter's server data is catching up. */
  onPendingChange?: (pending: boolean) => void;
};

const FILTER_LABELS: Record<InboxFilter, string> = {
  all: "All",
  mine: "Mine",
  unassigned: "No owner",
  unknown: "Unknown",
  dismissed: "Dismissed",
  unread: "Unread",
  escalated: "Escalated",
  dispo: "Sandra Dispo",
  needs_outcome: "Needs Outcome",
};

/**
 * Filter chips above the inbox thread list. Phase 2 introduced All /
 * Unknown / Dismissed. Phase 3 added Mine + Unassigned for per-user
 * assignment workflow.
 */
export function InboxFilters({
  active,
  filterCounts,
  showAssignmentChips,
  hideDnc,
  hiddenDncCount,
  onPendingChange,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pendingFilter, setPendingFilter] = useState<InboxFilter | null>(null);

  const setFilter = (next: InboxFilter) => {
    if (pendingFilter === null && next === active) return;
    if (next === pendingFilter) return;

    // This high-priority local update commits before the RSC request returns,
    // so a slow filter navigation always acknowledges the click immediately.
    setPendingFilter(next);
    onPendingChange?.(true);

    const sp = new URLSearchParams(searchParams.toString());
    if (next === "all") sp.delete("filter");
    else sp.set("filter", next);
    sp.delete("thread"); // clear selection when switching filters
    sp.delete("inboxPage");
    const qs = sp.toString();
    router.replace(qs ? `/messages?${qs}` : "/messages");
  };

  // `active` is server-resolved. Once it matches the requested filter, the
  // replacement rows have arrived and the pending feedback can disappear.
  useEffect(() => {
    if (pendingFilter === null || pendingFilter !== active) return undefined;
    const timeout = window.setTimeout(() => {
      setPendingFilter(null);
      onPendingChange?.(false);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [active, onPendingChange, pendingFilter]);

  const displayedActive = pendingFilter ?? active;

  const toggleHideDnc = () => {
    const sp = new URLSearchParams(searchParams.toString());
    if (hideDnc) {
      // Currently hidden -> show them. Set explicit hideDnc=0.
      sp.set("hideDnc", "0");
    } else {
      // Currently shown -> hide. Default state, so just remove the param.
      sp.delete("hideDnc");
    }
    sp.delete("thread");
    sp.delete("inboxPage");
    const qs = sp.toString();
    router.replace(qs ? `/messages?${qs}` : "/messages");
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="inbox-filters"
    >
      {/* Priority order: immediacy, outcome work, assignment, Sandra state,
         then the broader catch-all buckets. */}
      <FilterChip
        label="Unread"
        active={displayedActive === "unread"}
        pending={pendingFilter === "unread"}
        count={filterCounts.unread}
        onClick={() => setFilter("unread")}
        testId="filter-unread"
      />
      <FilterChip
        label="Needs Outcome"
        active={displayedActive === "needs_outcome"}
        pending={pendingFilter === "needs_outcome"}
        count={filterCounts.needs_outcome}
        onClick={() => setFilter("needs_outcome")}
        testId="filter-needs-outcome"
      />
      {showAssignmentChips && (
        <>
          <FilterChip
            label="Mine"
            active={displayedActive === "mine"}
            pending={pendingFilter === "mine"}
            count={filterCounts.mine}
            onClick={() => setFilter("mine")}
            testId="filter-mine"
          />
          <FilterChip
            label="Escalated"
            icon="mascot"
            active={displayedActive === "escalated"}
            pending={pendingFilter === "escalated"}
            count={filterCounts.escalated}
            onClick={() => setFilter("escalated")}
            testId="filter-escalated"
          />
        </>
      )}
      {!showAssignmentChips ? (
        <FilterChip
          label="Escalated"
          icon="mascot"
          active={displayedActive === "escalated"}
          pending={pendingFilter === "escalated"}
          count={filterCounts.escalated}
          onClick={() => setFilter("escalated")}
          testId="filter-escalated"
        />
      ) : null}
      <FilterChip
        label="Sandra Dispo"
        icon="mascot"
        active={displayedActive === "dispo"}
        pending={pendingFilter === "dispo"}
        count={filterCounts.dispo}
        onClick={() => setFilter("dispo")}
        testId="filter-dispo"
      />
      {showAssignmentChips && (
        <FilterChip
          label="No owner"
          active={displayedActive === "unassigned"}
          pending={pendingFilter === "unassigned"}
          count={filterCounts.unassigned}
          onClick={() => setFilter("unassigned")}
          testId="filter-unassigned"
        />
      )}
      <FilterChip
        label="All"
        active={displayedActive === "all"}
        pending={pendingFilter === "all"}
        count={filterCounts.all}
        onClick={() => setFilter("all")}
        testId="filter-all"
      />
      <FilterChip
        label="Unknown"
        active={displayedActive === "unknown"}
        pending={pendingFilter === "unknown"}
        count={filterCounts.unknown}
        onClick={() => setFilter("unknown")}
        testId="filter-unknown"
      />
      <FilterChip
        label="Dismissed"
        active={displayedActive === "dismissed"}
        pending={pendingFilter === "dismissed"}
        count={filterCounts.dismissed}
        onClick={() => setFilter("dismissed")}
        testId="filter-dismissed"
      />
      {active === "dispo" ? (
        <span
          className="ml-auto text-[12px] font-medium text-[#78716c]"
          data-testid="sandra-dispo-compliance-note"
        >
          Compliance reviews shown · tests hidden
        </span>
      ) : (
        <DncToggle
          hideDnc={hideDnc}
          hiddenDncCount={hiddenDncCount}
          onToggle={toggleHideDnc}
        />
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {pendingFilter
          ? `Loading ${FILTER_LABELS[pendingFilter]} messages`
          : ""}
      </span>
    </div>
  );
}

/**
 * Noise toggle ("Hide DNC & tests") — sits to the right of the filter
 * chips with ml-auto. ON: hides opted-out threads AND Jitter test
 * traffic (canary/rehearsal fixtures), with a "{N} hidden" hint.
 * OFF: label reads "Showing all".
 *
 * State persists via the `hideDnc` URL param (omit / "1" = ON,
 * "0" = OFF). Default is ON per feedback-f E1.
 */
function DncToggle({
  hideDnc,
  hiddenDncCount,
  onToggle,
}: {
  hideDnc: boolean;
  hiddenDncCount: number;
  onToggle: () => void;
}) {
  const label = hideDnc ? "Hide DNC & tests" : "Showing all";
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={hideDnc}
      data-testid="dnc-toggle"
      data-active={hideDnc || undefined}
      className="ml-auto inline-flex min-h-11 items-center gap-2 text-[12px] text-[#78716c] hover:text-[#1c1917]"
    >
      <span
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          hideDnc ? "bg-[#111827]" : "bg-[#e5e1df]"
        }`}
        data-testid="dnc-toggle-track"
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
            hideDnc ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </span>
      <span className="font-medium">{label}</span>
      {hideDnc && hiddenDncCount > 0 ? (
        <span
          className="text-[11px] text-[#a8a29e]"
          data-testid="dnc-toggle-count"
        >
          ({hiddenDncCount} hidden)
        </span>
      ) : null}
    </button>
  );
}

function FilterChip({
  label,
  icon,
  active,
  pending = false,
  onClick,
  count,
  testId,
}: {
  label: string;
  icon?: "mascot";
  active: boolean;
  pending?: boolean;
  onClick: () => void;
  count?: number;
  testId: string;
}) {
  const showCount = typeof count === "number" && count > 0;
  const countLabel = showCount ? `${label} (${count})` : label;
  const ariaLabel = pending ? `${countLabel}, loading` : countLabel;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      aria-busy={pending}
      data-testid={testId}
      data-active={active || undefined}
      className={`inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-1.5 text-[12px] font-bold transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "border border-[#e5e1df] text-[#78716c] hover:bg-[#f5f5f4] hover:text-[#1c1917]"
      }`}
    >
      {icon === "mascot" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/icon.png"
          alt=""
          aria-hidden="true"
          className="h-4 w-4 shrink-0"
        />
      ) : null}
      <span>{label}</span>
      {pending ? (
        <Loader2Icon
          className="h-3.5 w-3.5 shrink-0 animate-spin"
          aria-hidden="true"
          data-testid={`${testId}-spinner`}
        />
      ) : null}
      {showCount ? (
        <span
          data-testid={`${testId}-count`}
          className={`shrink-0 font-bold ${
            active ? "text-primary-foreground" : "text-[#1c1917]"
          }`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}
