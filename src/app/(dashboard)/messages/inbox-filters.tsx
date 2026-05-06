"use client";

import { useRouter, useSearchParams } from "next/navigation";

export type InboxFilter =
  | "all"
  | "mine"
  | "unassigned"
  | "unknown"
  | "dismissed"
  | "unread";

type Props = {
  active: InboxFilter;
  unknownCount: number;
  unreadCount: number;
  /** Hide Mine + Unassigned chips when no auth user is on the request. */
  showAssignmentChips: boolean;
};

/**
 * Filter chips above the inbox thread list. Phase 2 introduced All /
 * Unknown / Dismissed. Phase 3 added Mine + Unassigned for per-user
 * assignment workflow.
 */
export function InboxFilters({
  active,
  unknownCount,
  unreadCount,
  showAssignmentChips,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const setFilter = (next: InboxFilter) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (next === "all") sp.delete("filter");
    else sp.set("filter", next);
    sp.delete("thread"); // clear selection when switching filters
    const qs = sp.toString();
    router.replace(qs ? `/messages?${qs}` : "/messages");
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="inbox-filters">
      <FilterChip
        label="All"
        active={active === "all"}
        onClick={() => setFilter("all")}
        testId="filter-all"
      />
      {showAssignmentChips && (
        <>
          <FilterChip
            label="Mine"
            active={active === "mine"}
            onClick={() => setFilter("mine")}
            testId="filter-mine"
          />
          <FilterChip
            label="Unassigned"
            active={active === "unassigned"}
            onClick={() => setFilter("unassigned")}
            testId="filter-unassigned"
          />
        </>
      )}
      <FilterChip
        label="Unread"
        active={active === "unread"}
        badge={unreadCount > 0 ? String(unreadCount) : undefined}
        onClick={() => setFilter("unread")}
        testId="filter-unread"
      />
      <FilterChip
        label="Unknown"
        active={active === "unknown"}
        badge={unknownCount > 0 ? String(unknownCount) : undefined}
        onClick={() => setFilter("unknown")}
        testId="filter-unknown"
      />
      <FilterChip
        label="Dismissed"
        active={active === "dismissed"}
        onClick={() => setFilter("dismissed")}
        testId="filter-dismissed"
      />
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  badge,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active || undefined}
      className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-bold transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "border border-[#e5e1df] text-[#78716c] hover:bg-[#f5f5f4] hover:text-[#1c1917]"
      }`}
    >
      <span>{label}</span>
      {badge ? (
        <span
          className={`font-bold ${
            active ? "text-primary-foreground" : "text-[#1c1917]"
          }`}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}
