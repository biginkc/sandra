/**
 * Fields searched by the /leads kanban page-level filter. Intentionally a
 * narrow shape so the filter logic can be reused from tests without pulling
 * in the full `Database["public"]["Tables"]["properties"]["Row"]`.
 *
 * `homeowner` is the embedded contact (via PostgREST FK alias) — null when
 * no homeowner is linked yet. Person rows have first/last names; entity
 * rows have entity_name (LLC / trust / etc.). All three are searched.
 */
export type SearchableLead = {
  address: string;
  city: string | null;
  state: string;
  zip: string | null;
  market: string | null;
  homeowner: {
    first_name: string | null;
    last_name: string | null;
    entity_name: string | null;
  } | null;
};

/**
 * Case-insensitive, whitespace-tolerant, AND-across-tokens filter.
 *
 * Examples with a lead at "123 Main St, Kansas City, MO, 64108" owned by
 * John Smith:
 *   ""              → included (empty query = no filter)
 *   "main"          → included
 *   "KANSAS"        → included (case-insensitive)
 *   "smith"         → included (matches homeowner last name)
 *   "john smith"    → included (multi-token: both names found)
 *   "kansas smith"  → included (mixed: address city + owner name)
 *   "dayton"        → excluded
 *   "  "            → included (whitespace-only = no filter)
 */
export function filterLeads<T extends SearchableLead>(
  leads: readonly T[],
  query: string,
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...leads];

  return leads.filter((lead) => {
    const fields: (string | null | undefined)[] = [
      lead.address,
      lead.city,
      lead.state,
      lead.zip,
      lead.market,
      lead.homeowner?.first_name,
      lead.homeowner?.last_name,
      lead.homeowner?.entity_name,
    ];
    const haystack = fields
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" ")
      .toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}
