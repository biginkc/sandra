"use client";

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

export type PendingInboxChange =
  | { kind: "filter"; value: InboxFilter; resetList?: boolean }
  | { kind: "hideDnc"; value: boolean };

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
  pendingChange: PendingInboxChange | null;
  completedChange: PendingInboxChange | null;
  errorMessage: string | null;
  onFilterChange: (filter: InboxFilter) => void;
  onHideDncChange: (hideDnc: boolean) => void;
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
  pendingChange,
  completedChange,
  errorMessage,
  onFilterChange,
  onHideDncChange,
}: Props) {
  const pendingFilter =
    pendingChange?.kind === "filter" ? pendingChange.value : null;
  const pendingHideDnc = pendingChange?.kind === "hideDnc";
  const controlsPending = pendingChange !== null;
  const displayedActive = pendingFilter ?? active;
  const displayedHideDnc =
    pendingChange?.kind === "hideDnc" ? pendingChange.value : hideDnc;

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
        interactionDisabled={controlsPending}
        count={filterCounts.unread}
        onClick={() => onFilterChange("unread")}
        testId="filter-unread"
      />
      <FilterChip
        label="Needs Outcome"
        active={displayedActive === "needs_outcome"}
        pending={pendingFilter === "needs_outcome"}
        interactionDisabled={controlsPending}
        count={filterCounts.needs_outcome}
        onClick={() => onFilterChange("needs_outcome")}
        testId="filter-needs-outcome"
      />
      {showAssignmentChips && (
        <>
          <FilterChip
            label="Mine"
            active={displayedActive === "mine"}
            pending={pendingFilter === "mine"}
            interactionDisabled={controlsPending}
            count={filterCounts.mine}
            onClick={() => onFilterChange("mine")}
            testId="filter-mine"
          />
          <FilterChip
            label="Escalated"
            icon="mascot"
            active={displayedActive === "escalated"}
            pending={pendingFilter === "escalated"}
            interactionDisabled={controlsPending}
            count={filterCounts.escalated}
            onClick={() => onFilterChange("escalated")}
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
          interactionDisabled={controlsPending}
          count={filterCounts.escalated}
          onClick={() => onFilterChange("escalated")}
          testId="filter-escalated"
        />
      ) : null}
      <FilterChip
        label="Sandra Dispo"
        icon="mascot"
        active={displayedActive === "dispo"}
        pending={pendingFilter === "dispo"}
        interactionDisabled={controlsPending}
        count={filterCounts.dispo}
        onClick={() => onFilterChange("dispo")}
        testId="filter-dispo"
      />
      {showAssignmentChips && (
        <FilterChip
          label="No owner"
          active={displayedActive === "unassigned"}
          pending={pendingFilter === "unassigned"}
          interactionDisabled={controlsPending}
          count={filterCounts.unassigned}
          onClick={() => onFilterChange("unassigned")}
          testId="filter-unassigned"
        />
      )}
      <FilterChip
        label="All"
        active={displayedActive === "all"}
        pending={pendingFilter === "all"}
        interactionDisabled={controlsPending}
        count={filterCounts.all}
        onClick={() => onFilterChange("all")}
        testId="filter-all"
      />
      <FilterChip
        label="Unknown"
        active={displayedActive === "unknown"}
        pending={pendingFilter === "unknown"}
        interactionDisabled={controlsPending}
        count={filterCounts.unknown}
        onClick={() => onFilterChange("unknown")}
        testId="filter-unknown"
      />
      <FilterChip
        label="Dismissed"
        active={displayedActive === "dismissed"}
        pending={pendingFilter === "dismissed"}
        interactionDisabled={controlsPending}
        count={filterCounts.dismissed}
        onClick={() => onFilterChange("dismissed")}
        testId="filter-dismissed"
      />
      {displayedActive === "dispo" ? (
        <span
          className="ml-auto text-[12px] font-medium text-[#78716c]"
          data-testid="sandra-dispo-compliance-note"
        >
          Compliance reviews shown · tests hidden
        </span>
      ) : (
        <DncToggle
          hideDnc={displayedHideDnc}
          hiddenDncCount={hiddenDncCount}
          pending={pendingHideDnc}
          interactionDisabled={controlsPending}
          onToggle={() => onHideDncChange(!displayedHideDnc)}
        />
      )}
      {errorMessage ? (
        <span
          className="text-[12px] font-semibold text-destructive"
          role="alert"
        >
          {errorMessage}
        </span>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {pendingFilter
          ? `Loading ${FILTER_LABELS[pendingFilter]} messages`
          : pendingHideDnc
            ? "Updating DNC visibility"
            : completedChange?.kind === "filter"
              ? `${FILTER_LABELS[completedChange.value]} messages loaded`
              : completedChange?.kind === "hideDnc"
                ? "DNC visibility updated"
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
  pending,
  interactionDisabled,
  onToggle,
}: {
  hideDnc: boolean;
  hiddenDncCount: number;
  pending: boolean;
  interactionDisabled: boolean;
  onToggle: () => void;
}) {
  const label = hideDnc ? "Hide DNC & tests" : "Showing all";
  return (
    <button
      type="button"
      onClick={interactionDisabled ? undefined : onToggle}
      role="switch"
      aria-checked={hideDnc}
      aria-busy={pending}
      aria-disabled={interactionDisabled}
      data-testid="dnc-toggle"
      data-active={hideDnc || undefined}
      className={`relative ml-auto inline-flex min-h-11 items-center gap-2 text-[12px] text-[#78716c] ${
        interactionDisabled
          ? "cursor-default opacity-50"
          : "hover:text-[#1c1917]"
      }`}
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
  interactionDisabled,
  onClick,
  count,
  testId,
}: {
  label: string;
  icon?: "mascot";
  active: boolean;
  pending?: boolean;
  interactionDisabled: boolean;
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
      onClick={interactionDisabled ? undefined : onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      aria-busy={pending}
      aria-disabled={interactionDisabled}
      data-testid={testId}
      data-active={active || undefined}
      data-loading-muted={interactionDisabled && !active ? "true" : undefined}
      className={`relative inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-1.5 text-[12px] font-bold transition-colors ${
        active
          ? `bg-primary text-primary-foreground ${
              interactionDisabled ? "cursor-default" : ""
            }`
          : `border border-[#e5e1df] text-[#78716c] ${
              interactionDisabled
                ? "cursor-default bg-[#f5f5f4] text-[#a8a29e]"
                : "hover:bg-[#f5f5f4] hover:text-[#1c1917]"
            }`
      }`}
    >
      {icon === "mascot" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/icon.png"
          alt=""
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 ${
            interactionDisabled && !active ? "opacity-40" : ""
          }`}
        />
      ) : null}
      <span>{label}</span>
      {showCount ? (
        <span
          data-testid={`${testId}-count`}
          className={`shrink-0 font-bold ${
            active
              ? "text-primary-foreground"
              : interactionDisabled
                ? "text-[#a8a29e]"
                : "text-[#1c1917]"
          }`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}
