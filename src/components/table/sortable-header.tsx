"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { TableHead } from "@/components/ui/table";

import type { SortDirection } from "./use-table-url-state";

/**
 * Clickable column header. Same column flips dir; new column resets to
 * ascending. Active column shows an up/down arrow; inactive columns show
 * a subtle two-way arrow so the affordance is visible without dominating.
 *
 * Lifted verbatim from src/app/(dashboard)/properties/prospects-table.tsx:859-892
 * with three adaptations:
 *   1. Generic over `<TColumn extends string>` so each consumer's whitelist
 *      narrows the column name type.
 *   2. Prop rename `sort` → `current` to match D-02's call-site shape:
 *      <SortableHeader column="name" current={sort} dir={dir} onClick={onSort}>
 *   3. `testIdPrefix` prop replaces the hard-coded `prospects-sort-${column}`
 *      data-testid so consumers preserve their existing test contracts.
 *      `<SortableHeader testIdPrefix="prospects">` → data-testid="prospects-sort-{column}".
 */
export function SortableHeader<TColumn extends string>({
  column,
  current,
  dir,
  onClick,
  children,
  testIdPrefix,
}: {
  column: TColumn;
  current: TColumn | string;
  dir: SortDirection;
  onClick: (col: TColumn) => void;
  children: React.ReactNode;
  testIdPrefix?: string;
}) {
  const isActive = current === column;
  const Icon = isActive ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className="select-none">
      <button
        type="button"
        onClick={() => onClick(column)}
        aria-sort={
          isActive ? (dir === "asc" ? "ascending" : "descending") : "none"
        }
        data-testid={
          testIdPrefix ? `${testIdPrefix}-sort-${column}` : `sort-${column}`
        }
        className={`hover:text-foreground flex items-center gap-1 text-left text-xs font-bold tracking-widest uppercase ${
          isActive ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        <span>{children}</span>
        <Icon className="size-3 opacity-70" aria-hidden />
      </button>
    </TableHead>
  );
}
