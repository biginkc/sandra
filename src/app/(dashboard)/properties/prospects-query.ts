/**
 * Pure helpers for the /properties (Prospects) page query layer.
 *
 * Parses the page's URL searchParams into a validated, typed object
 * (page / search / sort / dir) and derives the per-row engagement state
 * from a property's most-recent message. Pure functions only — no DB,
 * no Next.js — so the page-level server component can stay terse and
 * the rules can be exercised by unit tests.
 */

export const SORTABLE_COLUMNS = [
  "address",
  "market",
  "created_at",
] as const;

export type SortableColumn = (typeof SORTABLE_COLUMNS)[number];

export type SortDirection = "asc" | "desc";

/** What the table renders as the engagement pill in the new column. */
export type EngagementState = "none" | "contacted" | "replying";

export type ParsedProspectsSearch = {
  page: number;
  search: string | null;
  sort: SortableColumn;
  dir: SortDirection;
};

/** Default sort: newest-imported first. Matches the prior behavior. */
export const DEFAULT_SORT: SortableColumn = "created_at";
export const DEFAULT_DIR: SortDirection = "desc";

function isSortableColumn(value: unknown): value is SortableColumn {
  return (
    typeof value === "string" &&
    (SORTABLE_COLUMNS as readonly string[]).includes(value)
  );
}

/**
 * Parse the page's raw searchParams into a validated object.
 * - Unknown / missing values fall back to defaults.
 * - Sort columns are whitelisted to avoid `?sort=password` style abuse
 *   (Supabase's column injection is impossible via the JS client, but
 *   we still don't want random column names producing 500s).
 * - Search is trimmed; empty strings collapse to `null` so the caller
 *   can branch on it cleanly.
 */
export function parseProspectsSearch(raw: {
  page?: string | string[];
  search?: string | string[];
  sort?: string | string[];
  dir?: string | string[];
}): ParsedProspectsSearch {
  const pickFirst = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;

  const rawPage = Number(pickFirst(raw.page) ?? 1);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;

  const rawSearch = (pickFirst(raw.search) ?? "").trim();
  const search = rawSearch.length === 0 ? null : rawSearch;

  const rawSort = pickFirst(raw.sort);
  const sort = isSortableColumn(rawSort) ? rawSort : DEFAULT_SORT;

  const rawDir = pickFirst(raw.dir);
  const dir: SortDirection = rawDir === "asc" ? "asc" : DEFAULT_DIR;

  return { page, search, sort, dir };
}

/** Build a `?key=value&...` query-string preserving non-default fields. */
export function buildProspectsHref(parts: {
  page?: number;
  search?: string | null;
  sort?: SortableColumn;
  dir?: SortDirection;
}): string {
  const sp = new URLSearchParams();
  if (parts.page && parts.page > 1) sp.set("page", String(parts.page));
  if (parts.search && parts.search.length > 0) sp.set("search", parts.search);
  if (parts.sort && parts.sort !== DEFAULT_SORT) sp.set("sort", parts.sort);
  if (parts.dir && parts.dir !== DEFAULT_DIR) sp.set("dir", parts.dir);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
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
