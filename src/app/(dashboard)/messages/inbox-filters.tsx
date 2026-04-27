"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";

export type InboxFilter = "all" | "unknown" | "dismissed";

type Props = {
  active: InboxFilter;
  unknownCount: number;
};

/**
 * Filter chips above the inbox thread list. Phase 2: All / Unknown /
 * Dismissed. (Phase 3 will add Unread + Mine + Unassigned.)
 */
export function InboxFilters({ active, unknownCount }: Props) {
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
