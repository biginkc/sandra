/**
 * Generic URL-state primitives for any CRM table page (prospects, lists,
 * jobs, templates). Pure helpers (parseTableSearch / buildTableHref) live
 * here alongside the React hook (added in a follow-up task) so a single
 * file owns the parse-build-navigate machine. Consumers wrap these with
 * domain-specific config (sortable column whitelist, default sort, filter
 * parser/builder callbacks).
 *
 * Lifted from src/app/(dashboard)/properties/prospects-query.ts +
 * prospects-table.tsx. The existing 35 + 26 tests on /properties form
 * the regression contract — the wrappers in Plan 03 must produce
 * byte-identical URLs to the existing buildProspectsHref.
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
