/**
 * Pure URL-state helpers for any CRM table page (prospects, lists, jobs,
 * templates). Server-importable: no React, no router, no browser globals,
 * no "use client" directive.
 *
 * Lifted out of use-table-url-state.ts in Plan 01-03 to fix an RSC
 * boundary issue: server components like /properties/page.tsx call
 * `parseProspectsSearch` (which delegates here to `parseTableSearch`)
 * during SSR. When these helpers lived in a "use client" module, Next.js
 * surfaced them as opaque client-references to server consumers — which
 * crashes when the server tries to invoke them. Splitting the pure
 * helpers into a non-"use client" file makes them safe for both worlds:
 *
 *   - Server components import them directly and call them inline.
 *   - The hook in use-table-url-state.ts re-exports them so client
 *     callers see no API change (back-compat for the 12 unit tests +
 *     the table-toolbar / sortable-header consumers).
 */

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
