"use client";

import { useRouter, useSearchParams } from "next/navigation";

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
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const setFilter = (next: InboxFilter) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (next === "all") sp.delete("filter");
    else sp.set("filter", next);
    sp.delete("thread"); // clear selection when switching filters
    sp.delete("inboxPage");
    const qs = sp.toString();
    router.replace(qs ? `/messages?${qs}` : "/messages");
  };

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
        active={active === "unread"}
        count={filterCounts.unread}
        onClick={() => setFilter("unread")}
        testId="filter-unread"
      />
      <FilterChip
        label="Needs Outcome"
        active={active === "needs_outcome"}
        count={filterCounts.needs_outcome}
        onClick={() => setFilter("needs_outcome")}
        testId="filter-needs-outcome"
      />
      {showAssignmentChips && (
        <>
          <FilterChip
            label="Mine"
            active={active === "mine"}
            count={filterCounts.mine}
            onClick={() => setFilter("mine")}
            testId="filter-mine"
          />
          <FilterChip
            label="Escalated"
            icon="mascot"
            active={active === "escalated"}
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
          active={active === "escalated"}
          count={filterCounts.escalated}
          onClick={() => setFilter("escalated")}
          testId="filter-escalated"
        />
      ) : null}
      <FilterChip
        label="Dispo"
        icon="mascot"
        active={active === "dispo"}
        count={filterCounts.dispo}
        onClick={() => setFilter("dispo")}
        testId="filter-dispo"
      />
      {showAssignmentChips && (
        <FilterChip
          label="Unassigned"
          active={active === "unassigned"}
          count={filterCounts.unassigned}
          onClick={() => setFilter("unassigned")}
          testId="filter-unassigned"
        />
      )}
      <FilterChip
        label="All"
        active={active === "all"}
        count={filterCounts.all}
        onClick={() => setFilter("all")}
        testId="filter-all"
      />
      <FilterChip
        label="Unknown"
        active={active === "unknown"}
        count={filterCounts.unknown}
        onClick={() => setFilter("unknown")}
        testId="filter-unknown"
      />
      <FilterChip
        label="Dismissed"
        active={active === "dismissed"}
        count={filterCounts.dismissed}
        onClick={() => setFilter("dismissed")}
        testId="filter-dismissed"
      />
      <DncToggle
        hideDnc={hideDnc}
        hiddenDncCount={hiddenDncCount}
        onToggle={toggleHideDnc}
      />
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
  onClick,
  count,
  testId,
}: {
  label: string;
  icon?: "mascot";
  active: boolean;
  onClick: () => void;
  count?: number;
  testId: string;
}) {
  const showCount = typeof count === "number" && count > 0;
  const ariaLabel = showCount ? `${label} (${count})` : label;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
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
