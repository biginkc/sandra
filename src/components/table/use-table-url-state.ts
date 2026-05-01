/**
 * React hook + Context for the generic URL-state primitives. Client-only
 * because it wraps `useRouter`, `useTransition`, and the search-debounce
 * timer.
 *
 * Pure helpers (parseTableSearch / buildTableHref) and their types live
 * in ./use-table-url-state.helpers.ts — that module has NO "use client"
 * directive so server components (e.g., /properties/page.tsx) can import
 * + invoke them during SSR without hitting the RSC client-reference
 * boundary.
 *
 * For backward-compat with existing client-side imports, this file
 * re-exports the helpers + types so consumers that import from
 * "@/components/table/use-table-url-state" keep working unchanged. The
 * 12 unit tests in use-table-url-state.test.ts also still resolve via
 * this barrel.
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import {
  buildTableHref,
  parseTableSearch,
  type BuildConfig,
  type ParseConfig,
  type ParseTableSearchInput,
  type ParsedTableSearch,
  type SortDirection,
} from "./use-table-url-state.helpers";

// Re-export the pure helpers + types so client-side imports from
// "@/components/table/use-table-url-state" keep working unchanged. Server
// components should import directly from "./use-table-url-state.helpers"
// to stay outside the client boundary.
export {
  buildTableHref,
  parseTableSearch,
};
export type {
  BuildConfig,
  ParseConfig,
  ParseTableSearchInput,
  ParsedTableSearch,
  SortDirection,
};

// ============================================================
// React hook + Context — client only
// ============================================================

export type UseTableUrlStateOptions<TFilters extends Record<string, unknown>> = {
  basePath: string;
  parsed: ParsedTableSearch<TFilters>;
  mode?: "ssr" | "client";
  minSkeletonMs?: number;
  config: BuildConfig<TFilters> & { sortableColumns: readonly string[] };
};

export type UseTableUrlStateReturn<TFilters extends Record<string, unknown>> = {
  search: string;
  sort: string;
  dir: SortDirection;
  page: number;
  filters: TFilters;
  navPending: boolean;
  navigate: (url: string) => void;
  onSort: (column: string) => void;
  debouncedSearch: (next: string, ms?: number) => void;
  buildHref: (parts: {
    page?: number;
    search?: string | null;
    sort?: string;
    dir?: SortDirection;
    filters?: Partial<TFilters>;
  }) => string;
  basePath: string;
};

const TableUrlStateContext = React.createContext<UseTableUrlStateReturn<Record<string, unknown>> | null>(null);

export { TableUrlStateContext };

export function useTableUrlStateContext(): UseTableUrlStateReturn<Record<string, unknown>> {
  const ctx = React.useContext(TableUrlStateContext);
  if (!ctx) {
    throw new Error(
      "<TableToolbarSearch> must be used inside a useTableUrlState consumer (wrap with <TableUrlStateContext.Provider value={ts}>).",
    );
  }
  return ctx;
}

export function useTableUrlState<TFilters extends Record<string, unknown>>(
  options: UseTableUrlStateOptions<TFilters>,
): UseTableUrlStateReturn<TFilters> {
  const { basePath, parsed, mode = "ssr", minSkeletonMs = 150, config } = options;
  const { search, sort, dir, page, filters } = parsed;

  const router = useRouter();
  const [transitionPending, startNavTransition] = useTransition();
  const [forceSkeleton, setForceSkeleton] = useState(false);
  const skeletonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (skeletonTimer.current) clearTimeout(skeletonTimer.current);
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    },
    [],
  );

  const navigate = useCallback(
    (url: string) => {
      // Pitfall 3: clear any pending search debounce so direct nav wins.
      if (searchDebounce.current) {
        clearTimeout(searchDebounce.current);
        searchDebounce.current = null;
      }
      // D-05: 150ms skeleton floor — navPending stays true at least minSkeletonMs.
      setForceSkeleton(true);
      if (skeletonTimer.current) clearTimeout(skeletonTimer.current);
      skeletonTimer.current = setTimeout(
        () => setForceSkeleton(false),
        minSkeletonMs,
      );

      if (mode === "client") {
        // D-04 client mode: URL mirror only, no SSR roundtrip.
        router.replace(url, { scroll: false });
      } else {
        startNavTransition(() => {
          router.replace(url, { scroll: false });
        });
      }
    },
    [mode, minSkeletonMs, router],
  );

  const buildHref = useCallback(
    (parts: Parameters<typeof buildTableHref<TFilters>>[0]) =>
      buildTableHref<TFilters>(parts, config),
    [config],
  );

  const onSort = useCallback(
    (column: string) => {
      const nextDir: SortDirection =
        sort === column ? (dir === "asc" ? "desc" : "asc") : "asc";
      navigate(
        `${basePath}${buildHref({
          page: 1,
          search: search === "" ? null : search,
          sort: column,
          dir: nextDir,
          filters,
        })}`,
      );
    },
    [sort, dir, search, filters, basePath, navigate, buildHref],
  );

  const debouncedSearch = useCallback(
    (next: string, ms = 250) => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
      searchDebounce.current = setTimeout(() => {
        const trimmed = next.trim();
        navigate(
          `${basePath}${buildHref({
            page: 1,
            search: trimmed.length === 0 ? null : trimmed,
            sort,
            dir,
            filters,
          })}`,
        );
      }, ms);
    },
    [navigate, basePath, buildHref, sort, dir, filters],
  );

  const navPending = transitionPending || forceSkeleton;

  // Note: search returned as "" (not null) so consumers can pass directly to
  // <Input defaultValue={ts.search}>. The pure parser keeps null for the
  // server-side branch logic.
  return {
    search: search ?? "",
    sort,
    dir,
    page,
    filters,
    navPending,
    navigate,
    onSort,
    debouncedSearch,
    buildHref,
    basePath,
  };
}
