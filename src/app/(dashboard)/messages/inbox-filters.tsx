"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";

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
    <div className="flex flex-wrap items-center gap-1" data-testid="inbox-filters">
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
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      data-testid={testId}
      data-active={active || undefined}
    >
      <span>{label}</span>
      {badge ? (
        <span className="bg-background text-foreground ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px]">
          {badge}
        </span>
      ) : null}
    </Button>
  );
}
