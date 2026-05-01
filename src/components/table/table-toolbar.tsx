"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  TableUrlStateContext,
  useTableUrlStateContext,
  type UseTableUrlStateReturn,
} from "./use-table-url-state";

/**
 * Rounded-card toolbar wrapper. Provides TableUrlStateContext to all children
 * so <TableToolbarSearch> can pull the hook state without prop drilling.
 *
 * Visual lifted verbatim from src/app/(dashboard)/properties/prospects-table.tsx:673
 * — `border-border bg-card flex flex-wrap items-center gap-3 rounded-2xl border p-3`.
 * Plan 03's /properties migration depends on byte-identical visual.
 */
function TableToolbar({
  state,
  children,
  className,
}: {
  state: UseTableUrlStateReturn<Record<string, unknown>>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <TableUrlStateContext.Provider value={state}>
      <div
        data-slot="table-toolbar"
        className={cn(
          "border-border bg-card flex flex-wrap items-center gap-3 rounded-2xl border p-3",
          className,
        )}
      >
        {children}
      </div>
    </TableUrlStateContext.Provider>
  );
}

/**
 * Uncontrolled search input wired to the hook's debouncedSearch via context.
 *
 * Uncontrolled (defaultValue=) per feedback_no_usestate_mirror_of_server_props.md:
 * router.refresh re-renders MUST NOT clobber the user's mid-keystroke text. The
 * hook's debouncedSearch handles the URL update; the input itself is the
 * source of truth for what the user is currently typing.
 *
 * The X clear button is rendered conditionally based on the input's CURRENT
 * value (uncontrolled — read via ref) rather than ctx.search (which lags by
 * the 250ms debounce). This matches prospects-table.tsx:688 where the clear
 * button shows immediately on first keystroke.
 */
function TableToolbarSearch({
  ariaLabel,
  placeholder,
  testId,
  className,
}: {
  ariaLabel: string;
  placeholder?: string;
  testId?: string;
  className?: string;
}) {
  const ctx = useTableUrlStateContext();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // Track whether the user has typed anything (drives the X visibility).
  // Initialized from ctx.search so the X is visible on first paint when
  // there's a server-rendered search query.
  const [hasContent, setHasContent] = React.useState(ctx.search.length > 0);

  const onClear = () => {
    if (inputRef.current) inputRef.current.value = "";
    setHasContent(false);
    // Direct navigate (not debouncedSearch) so the X click feels instant.
    ctx.navigate(
      `${ctx.basePath}${ctx.buildHref({
        page: 1,
        search: null,
        sort: ctx.sort,
        dir: ctx.dir,
        filters: ctx.filters,
      })}`,
    );
  };

  return (
    <div className={cn("relative max-w-md flex-1", className)}>
      <Search
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2"
        aria-hidden
      />
      <Input
        ref={inputRef}
        type="text"
        defaultValue={ctx.search}
        onChange={(e) => {
          setHasContent(e.target.value.length > 0);
          ctx.debouncedSearch(e.target.value);
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        data-testid={testId}
        className="bg-muted/60 h-10 w-full rounded-full border-none pr-10 pl-11"
      />
      {hasContent ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear search"
          data-testid={testId ? `${testId}-clear` : undefined}
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Binary toggle filter pill. `active` styles it filled; `onClick` is the
 * consumer's wiring (typically calls ts.navigate(buildHref({ filters: { ... } }))).
 *
 * Active styling: variant="default" + small X icon to telegraph "click to
 * remove". Inactive: variant="outline".
 */
function TableToolbarFilterPill({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      data-testid={testId}
      data-active={active || undefined}
      className="gap-1"
    >
      {children}
      {active ? <X className="size-3" aria-hidden /> : null}
    </Button>
  );
}

export { TableToolbar, TableToolbarSearch, TableToolbarFilterPill };
