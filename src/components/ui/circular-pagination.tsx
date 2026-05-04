// CircularPagination — circular page-number buttons + chevrons.
//
// Source: Stitch wholesale_real_estate_crm leads pipeline mockup (table footer).
// Used in: Sandra CRM (lead tables), Sandra University (lesson lists),
// Sandra Practice (recording history).

import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export interface CircularPaginationProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "onChange"> {
  /** Current page (1-indexed). */
  currentPage: number;
  /** Total number of pages. */
  totalPages: number;
  /** Called with the next page number when the user navigates. */
  onPageChange: (page: number) => void;
  /** Pages shown on either side of the current page. Default 1. */
  siblingCount?: number;
}

type PageItem = number | "ellipsis-left" | "ellipsis-right";

/** Build the list of page items (numbers + ellipsis sentinels) to render. */
function buildPageItems(
  currentPage: number,
  totalPages: number,
  siblingCount: number
): PageItem[] {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const left = Math.max(currentPage - siblingCount, 1);
  const right = Math.min(currentPage + siblingCount, totalPages);
  const showLeftEllipsis = left > 2;
  const showRightEllipsis = right < totalPages - 1;

  const items: PageItem[] = [1];
  if (showLeftEllipsis) items.push("ellipsis-left");
  for (let p = Math.max(left, 2); p <= Math.min(right, totalPages - 1); p++) {
    items.push(p);
  }
  if (showRightEllipsis) items.push("ellipsis-right");
  items.push(totalPages);
  return items;
}

/**
 * Circular pagination strip with chevrons and page numbers.
 *
 * @example
 * <CircularPagination
 *   currentPage={page}
 *   totalPages={24}
 *   onPageChange={setPage}
 * />
 */
export function CircularPagination({
  currentPage,
  totalPages,
  onPageChange,
  siblingCount = 1,
  className,
  ...props
}: CircularPaginationProps) {
  const items = buildPageItems(currentPage, totalPages, siblingCount);
  const atStart = currentPage <= 1;
  const atEnd = currentPage >= totalPages;

  return (
    <nav
      data-slot="circular-pagination"
      className={cn("flex gap-2 items-center", className)}
      {...props}
    >
      <button
        type="button"
        data-slot="pagination-button"
        data-direction="prev"
        aria-label="Previous page"
        disabled={atStart}
        onClick={() => onPageChange(currentPage - 1)}
        className="size-8 rounded-full flex items-center justify-center border border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors disabled:opacity-30 disabled:pointer-events-none"
      >
        <ChevronLeft className="size-4" />
      </button>

      {items.map((item, idx) => {
        if (item === "ellipsis-left" || item === "ellipsis-right") {
          return (
            <span
              key={`${item}-${idx}`}
              data-slot="pagination-ellipsis"
              aria-hidden="true"
              className="size-8 flex items-center justify-center text-muted-foreground text-[10px] font-bold"
            >
              …
            </span>
          );
        }

        const isActive = item === currentPage;
        return (
          <button
            key={item}
            type="button"
            data-slot="pagination-button"
            data-active={isActive}
            aria-label={`Page ${item}`}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onPageChange(item)}
            className={cn(
              "size-8 rounded-full flex items-center justify-center font-bold text-[10px] transition-colors",
              isActive
                ? "border border-foreground bg-foreground text-background"
                : "border border-border text-foreground hover:bg-secondary"
            )}
          >
            {item}
          </button>
        );
      })}

      <button
        type="button"
        data-slot="pagination-button"
        data-direction="next"
        aria-label="Next page"
        disabled={atEnd}
        onClick={() => onPageChange(currentPage + 1)}
        className="size-8 rounded-full flex items-center justify-center border border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors disabled:opacity-30 disabled:pointer-events-none"
      >
        <ChevronRight className="size-4" />
      </button>
    </nav>
  );
}
