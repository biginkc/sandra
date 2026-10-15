"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Page numbers for the work queue (25 per page, design v8 section 6): previous / next plus numbered pages with
 * ellipses. Disabled while a page is loading. Renders nothing for a single page.
 */
export type WorkPaginationProps = {
  /** 1-based. */
  page: number;
  totalPages: number;
  /** A page read is in flight: every control is disabled. */
  loading?: boolean;
  onPageChange: (page: number) => void;
};

type Item = number | "gap-left" | "gap-right";

/** 1 2 3 4 5 … 20 | 1 … 9 10 11 … 20 | 1 … 16 17 18 19 20, never more than seven slots. */
export function pageItems(page: number, totalPages: number): Item[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, "gap-right", totalPages];
  if (page >= totalPages - 3) return [1, "gap-left", ...Array.from({ length: 5 }, (_, i) => totalPages - 4 + i)];
  return [1, "gap-left", page - 1, page, page + 1, "gap-right", totalPages];
}

export function WorkPagination({ page, totalPages, loading = false, onPageChange }: WorkPaginationProps) {
  if (totalPages <= 1) return null;
  const current = Math.min(Math.max(page, 1), totalPages);
  const go = (next: number) => {
    if (loading || next < 1 || next > totalPages || next === current) return;
    onPageChange(next);
  };
  const edge = "flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30";
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-center gap-2" data-testid="work-pagination" aria-busy={loading || undefined}>
      <button type="button" aria-label="Previous page" className={edge} disabled={loading || current <= 1} onClick={() => go(current - 1)}>
        <ChevronLeft className="size-4" aria-hidden="true" />
      </button>
      {pageItems(current, totalPages).map((item, index) =>
        typeof item === "string" ? (
          <span key={`${item}-${index}`} aria-hidden="true" data-testid="work-pagination-gap" className="flex size-8 items-center justify-center text-xs font-bold text-muted-foreground">…</span>
        ) : (
          <button
            key={item}
            type="button"
            aria-label={`Page ${item}`}
            aria-current={item === current ? "page" : undefined}
            disabled={loading}
            className={cn(
              "flex size-8 items-center justify-center rounded-full text-xs font-bold transition-colors disabled:pointer-events-none disabled:opacity-50",
              item === current ? "border border-foreground bg-foreground text-background" : "border border-border text-foreground hover:bg-secondary",
            )}
            onClick={() => go(item)}
          >
            {item}
          </button>
        ),
      )}
      <button type="button" aria-label="Next page" className={edge} disabled={loading || current >= totalPages} onClick={() => go(current + 1)}>
        <ChevronRight className="size-4" aria-hidden="true" />
      </button>
    </nav>
  );
}

/** Total pages for a result count at the given page size (never below 1). */
export function totalPagesFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
