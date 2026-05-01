/**
 * Generic URL-state primitives for any CRM table page (prospects, lists,
 * jobs, templates). Pure helpers (parseTableSearch / buildTableHref) live
 * here alongside the React hook so a single file owns the parse-build-
 * navigate machine. Consumers wrap these with domain-specific config
 * (sortable column whitelist, default sort, filter parser/builder
 * callbacks).
 *
 * Lifted from src/app/(dashboard)/properties/prospects-query.ts +
 * prospects-table.tsx. The existing 35 + 26 tests on /properties form
 * the regression contract — the wrappers in Plan 03 must produce
 * byte-identical URLs to the existing buildProspectsHref.
 *
 * The "use client" directive at the top makes this a client module for
 * the hook + Context exports. Server components can still import the
 * pure helpers (parseTableSearch / buildTableHref) — Next.js's RSC
 * compiler tree-shakes correctly because the helpers don't reference
 * browser/React globals.
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

export type SortDirection = "asc" | "desc";

export type ParseTableSearchInput = Record<string, string | string[] | undefined>;

export type ParsedTableSearch<TFilters extends Record<string, unknown> = Record<string, never>> = {
  page: number;
  search: string | null;
  sort: string;
  dir: SortDirection;
  filters: TFilters;
};

export type ParseConfig<TFilters extends Record<string, unknown>> = {
  sortableColumns: readonly string[];
  defaultSort: string;
  defaultDir?: SortDirection;
  parseFilters?: (raw: ParseTableSearchInput) => TFilters;
};

export type BuildConfig<TFilters extends Record<string, unknown>> = {
  defaultSort: string;
  defaultDir?: SortDirection;
  buildFilterParams?: (filters: Partial<TFilters>, sp: URLSearchParams) => void;
};

const pickFirst = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export function parseTableSearch<TFilters extends Record<string, unknown>>(
  raw: ParseTableSearchInput,
  config: ParseConfig<TFilters>,
): ParsedTableSearch<TFilters> {
  const defaultDir: SortDirection = config.defaultDir ?? "desc";

  const rawPage = Number(pickFirst(raw.page) ?? 1);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;

  const rawSearch = (pickFirst(raw.search) ?? "").trim();
  const search = rawSearch.length === 0 ? null : rawSearch;

  const rawSort = pickFirst(raw.sort);
  const sort = (config.sortableColumns as readonly string[]).includes(rawSort ?? "")
    ? (rawSort as string)
    : config.defaultSort;

  const rawDir = pickFirst(raw.dir);
  const dir: SortDirection = rawDir === "asc" ? "asc" : defaultDir;

  const filters = config.parseFilters?.(raw) ?? ({} as TFilters);

  return { page, search, sort, dir, filters };
}

export function buildTableHref<TFilters extends Record<string, unknown>>(
  parts: {
    page?: number;
    search?: string | null;
    sort?: string;
    dir?: SortDirection;
    filters?: Partial<TFilters>;
  },
  config: BuildConfig<TFilters>,
): string {
  const defaultDir: SortDirection = config.defaultDir ?? "desc";
  const sp = new URLSearchParams();
  if (parts.page && parts.page > 1) sp.set("page", String(parts.page));
  if (parts.search && parts.search.length > 0) sp.set("search", parts.search);
  if (parts.sort && parts.sort !== config.defaultSort) sp.set("sort", parts.sort);
  if (parts.dir && parts.dir !== defaultDir) sp.set("dir", parts.dir);
  if (parts.filters) {
    config.buildFilterParams?.(parts.filters, sp);
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

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
