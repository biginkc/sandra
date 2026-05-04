// DataTableShell + DataTableFooter — BMH "warm paper" table chrome.
//
// Source: DESIGN.md §4.11 (forward-looking — not yet deployed). The shadcn 4
// `Table` primitive in Sandra CRM already bakes in BMH styling for headers
// (label-caps, h-12, px-6 py-4, tracking-widest) and cells (px-6 py-4
// generous padding), so this registry entry intentionally does NOT
// re-implement those. It only provides what's missing: the rounded-2xl
// bordered container that frames the table as a card, and the footer strip
// for "Showing X of Y" + pagination.
//
// Compose with shadcn's `<Table>`, `<TableHeader>`, `<TableBody>`, etc.
// inside the shell.

import { cn } from "@/lib/utils";

export interface DataTableShellProps
  extends React.HTMLAttributes<HTMLDivElement> {}

/**
 * Outer wrapper for a BMH data table — rounded card chrome with an overflow
 * clip so the contained `<Table>` and footer strip share rounded corners.
 *
 * @example
 * <DataTableShell>
 *   <Table>
 *     <TableHeader>...</TableHeader>
 *     <TableBody>...</TableBody>
 *   </Table>
 *   <DataTableFooter>
 *     <span className="text-sm text-muted-foreground">Showing 1–25 of 1,382</span>
 *     <CircularPagination current={1} totalPages={56} onChange={...} />
 *   </DataTableFooter>
 * </DataTableShell>
 */
export function DataTableShell({
  className,
  children,
  ...props
}: DataTableShellProps) {
  return (
    <div
      data-slot="data-table-shell"
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-card",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface DataTableFooterProps
  extends React.HTMLAttributes<HTMLDivElement> {}

/**
 * Footer strip for the data table shell — tinted band with a top border.
 * Uses `flex items-center justify-between` so a left-side count summary
 * and a right-side pagination control sit at opposite ends. Wraps to two
 * rows on narrow widths via `flex-wrap`.
 *
 * Renders as a `<div>` (not `<tfoot>`) because it sits outside the `<table>`
 * element inside the shell — this keeps the table semantics clean while
 * giving the shell control of the footer chrome.
 *
 * @example
 * <DataTableFooter>
 *   <span className="text-sm text-muted-foreground">Showing 1–25 of 1,382</span>
 *   <CircularPagination current={1} totalPages={56} onChange={...} />
 * </DataTableFooter>
 */
export function DataTableFooter({
  className,
  children,
  ...props
}: DataTableFooterProps) {
  return (
    <div
      data-slot="data-table-footer"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/50 px-6 py-4",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
