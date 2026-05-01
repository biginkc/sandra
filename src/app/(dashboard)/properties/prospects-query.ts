/**
 * Prospects-page domain helpers + thin wrappers around the generic
 * URL-state primitives in @/components/table/use-table-url-state.
 *
 * Generic parse/build (page, search, sort, dir, defaults stripping,
 * sortable whitelist, URL-encoding) lives in use-table-url-state.ts and
 * is exercised by use-table-url-state.test.ts (~12 tests covering the
 * shared surface). This file owns the prospects-specific shapes:
 * KNOWN_MARKETS, ParsedProspectsFilters, computeEngagement,
 * truncateMessagePreview, formatFullAddress — plus thin wrappers
 * parseProspectsSearch / buildProspectsHref that delegate to the
 * generic helpers with the prospects column whitelist + filter parsers.
 *
 * The wrapper signatures are unchanged from before the extraction so
 * the 35 tests in prospects-query.test.ts and the 26 tests in
 * prospects-table.test.tsx all stay green without modification.
 */

// Import the pure helpers from the .helpers module (NO "use client"
// directive) so the SSR path on /properties/page.tsx can call them
// without hitting Next.js's RSC client-reference boundary. Importing
// from "./use-table-url-state" (which has "use client") would surface
// these functions as opaque client-references to the server, causing a
// runtime crash when the server tries to invoke them.
import {
  buildTableHref,
  parseTableSearch,
  type SortDirection,
} from "@/components/table/use-table-url-state.helpers";

// Re-export SortDirection so existing imports `from "./prospects-query"` keep working.
export type { SortDirection };

export const SORTABLE_COLUMNS = [
  "address",
  "market",
  "created_at",
] as const;

/** Hard cap on cross-page select-all results. Prevents a runaway
 *  "select all 50K" from torching skip-trace credits via downstream
 *  bulk actions. 5,000 has plenty of headroom for current org sizes
 *  (Sandra is at ~1,400 prospects in prod). */
export const SELECT_ALL_HARD_CAP = 5000;

export type SortableColumn = (typeof SORTABLE_COLUMNS)[number];

/** What the table renders as the engagement pill in the new column. */
export type EngagementState = "none" | "contacted" | "replying";

/** Quick-filter values supported by the prospects page URL. */
export type ParsedProspectsFilters = {
  /** ?vacant=1 — restrict to is_vacant=true. */
  vacant: boolean;
  /** ?cass=verified — only the "Verified" toggle is exposed today; the
   *  parser narrows to a known whitelist. */
  cass: "verified" | null;
  /** ?engagement=contacted — derived state, requires a messages join. */
  engagement: "contacted" | null;
  /** ?market=Kansas+City — narrowed to the wizard's known markets so a
   *  bogus value doesn't 500 the query. */
  market: "Kansas City" | "St. Louis" | "Dayton" | "Lake of the Ozarks" | null;
  /** ?assignee=<uuid> | "unassigned" | null. UUID is validated upstream
   *  by RLS / not-found; we only enforce the "unassigned" sentinel here. */
  assignee: string | null;
};

export type ParsedProspectsSearch = {
  page: number;
  search: string | null;
  sort: SortableColumn;
  dir: SortDirection;
  filters: ParsedProspectsFilters;
};

export const KNOWN_MARKETS = [
  "Kansas City",
  "St. Louis",
  "Dayton",
  "Lake of the Ozarks",
] as const;

export type KnownMarket = (typeof KNOWN_MARKETS)[number];

function isKnownMarket(value: unknown): value is KnownMarket {
  return (
    typeof value === "string" &&
    (KNOWN_MARKETS as readonly string[]).includes(value)
  );
}

/** Default sort: newest-imported first. Matches the prior behavior. */
export const DEFAULT_SORT: SortableColumn = "created_at";
export const DEFAULT_DIR: SortDirection = "desc";

/**
 * Domain-specific filter parser. Pulled out as a named function so
 * parseProspectsSearch can pass it to parseTableSearch as the
 * `parseFilters` callback. Local pickFirst helper because this is the
 * only consumer in the file (the generic helper has its own internal
 * pickFirst over in use-table-url-state.ts).
 */
function parseProspectsFilters(
  raw: Record<string, string | string[] | undefined>,
): ParsedProspectsFilters {
  const pickFirst = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;

  const vacantRaw = pickFirst(raw.vacant);
  const vacant = vacantRaw === "1" || vacantRaw === "true";

  const cassRaw = pickFirst(raw.cass);
  const cass: ParsedProspectsFilters["cass"] =
    cassRaw === "verified" ? "verified" : null;

  const engagementRaw = pickFirst(raw.engagement);
  const engagement: ParsedProspectsFilters["engagement"] =
    engagementRaw === "contacted" ? "contacted" : null;

  const marketRaw = pickFirst(raw.market);
  const market: ParsedProspectsFilters["market"] = isKnownMarket(marketRaw)
    ? marketRaw
    : null;

  const assigneeRaw = (pickFirst(raw.assignee) ?? "").trim();
  const assignee = assigneeRaw.length === 0 ? null : assigneeRaw;

  return { vacant, cass, engagement, market, assignee };
}

/**
 * Parse the page's raw searchParams into a validated object.
 *
 * Thin wrapper around `parseTableSearch` from use-table-url-state.ts.
 * Supplies the prospects-specific column whitelist, defaults, and
 * filter parser — every other behavior (page clamping, search
 * trimming, dir whitelisting, array-input flattening) lives in the
 * generic helper.
 *
 * Signature is byte-identical to the pre-extraction version so the 35
 * unit tests in prospects-query.test.ts and the page.tsx call site
 * see no change.
 */
export function parseProspectsSearch(raw: {
  page?: string | string[];
  search?: string | string[];
  sort?: string | string[];
  dir?: string | string[];
  vacant?: string | string[];
  cass?: string | string[];
  engagement?: string | string[];
  market?: string | string[];
  assignee?: string | string[];
}): ParsedProspectsSearch {
  const result = parseTableSearch<ParsedProspectsFilters>(
    raw as Record<string, string | string[] | undefined>,
    {
      sortableColumns: SORTABLE_COLUMNS,
      defaultSort: DEFAULT_SORT,
      defaultDir: DEFAULT_DIR,
      parseFilters: parseProspectsFilters,
    },
  );
  // The generic helper returns sort: string; narrow back to SortableColumn
  // for the existing prospects-page consumer's type expectations.
  return {
    page: result.page,
    search: result.search,
    sort: result.sort as ParsedProspectsSearch["sort"],
    dir: result.dir,
    filters: result.filters,
  };
}

/**
 * Emit prospects filter params into a URLSearchParams in the stable
 * order asserted by tests:
 *
 *   vacant, cass, engagement, market, assignee
 *
 * Stable ordering is asserted by prospects-query.test.ts:264-285
 * ("composes filters with sort+search+page in stable order") and by
 * 4+ prospects-table.test.tsx URL assertions (e.g., the "filter
 * toggles compose" test that expects
 * `?vacant=1&cass=verified&engagement=contacted`).
 *
 * Exported so prospects-table.tsx can pass it as `buildFilterParams`
 * to `useTableUrlState`.
 */
export function buildProspectsFilterParams(
  filters: Partial<ParsedProspectsFilters>,
  sp: URLSearchParams,
): void {
  if (filters.vacant) sp.set("vacant", "1");
  if (filters.cass) sp.set("cass", filters.cass);
  if (filters.engagement) sp.set("engagement", filters.engagement);
  if (filters.market) sp.set("market", filters.market);
  if (filters.assignee) sp.set("assignee", filters.assignee);
}

/** Build a `?key=value&...` query-string preserving non-default fields.
 *  Filter params are emitted in a stable order for predictable URLs.
 *
 *  Thin wrapper around `buildTableHref` from use-table-url-state.ts.
 *  Signature is byte-identical to the pre-extraction version. */
export function buildProspectsHref(parts: {
  page?: number;
  search?: string | null;
  sort?: ParsedProspectsSearch["sort"];
  dir?: SortDirection;
  filters?: Partial<ParsedProspectsFilters>;
}): string {
  return buildTableHref<ParsedProspectsFilters>(parts, {
    defaultSort: DEFAULT_SORT,
    defaultDir: DEFAULT_DIR,
    buildFilterParams: buildProspectsFilterParams,
  });
}

/**
 * Compute the engagement pill state for a property given its
 * most-recent message (or null if it has none). The rule keys off
 * direction-of-most-recent-message so the badge always reflects
 * "whose turn is it":
 *
 *   - no messages              → "none" (no badge rendered)
 *   - latest is outbound       → "contacted" (we sent, awaiting reply)
 *   - latest is inbound        → "replying" (they sent, awaiting our reply)
 *
 * The shape is deliberately small: a single object with `direction`,
 * not a list of all messages. Callers fetch one row per property
 * (the latest) and pass it in.
 */
export function computeEngagement(
  latestMessage: { direction: "inbound" | "outbound" } | null,
): EngagementState {
  if (!latestMessage) return "none";
  return latestMessage.direction === "inbound" ? "replying" : "contacted";
}

/** Truncate the last-message body for in-table preview. Returns null
 *  for empty / null input so the caller can render an em-dash placeholder.
 */
export function truncateMessagePreview(
  body: string | null | undefined,
  maxLen = 60,
): string | null {
  if (!body) return null;
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen - 1).trimEnd() + "…";
}

/**
 * Concatenate a property's address parts into a single line that reads
 * like a human-typed address: "<street>, <city>, <state> <zip>".
 * Drops missing parts gracefully so a row with no city still renders
 * the street + state + zip without producing ", , MO ...". Used in
 * place of the old separate City / State / ZIP columns.
 */
export function formatFullAddress(parts: {
  address: string;
  city: string | null;
  state: string;
  zip: string | null;
}): string {
  const head = parts.address.trim();
  const cityState = [parts.city?.trim() || null, parts.state?.trim() || null]
    .filter(Boolean)
    .join(", ");
  const tail = [cityState, parts.zip?.trim() || null]
    .filter(Boolean)
    .join(" ");
  return tail ? `${head}, ${tail}` : head;
}
