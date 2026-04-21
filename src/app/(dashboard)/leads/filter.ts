/**
 * Fields searched by the /leads kanban page-level filter. Intentionally a
 * narrow shape so the filter logic can be reused from tests without pulling
 * in the full `Database["public"]["Tables"]["properties"]["Row"]`.
 */
export type SearchableLead = {
  address: string;
  city: string | null;
  state: string;
  zip: string | null;
  market: string | null;
};

/**
 * Case-insensitive, whitespace-tolerant, AND-across-tokens filter.
 *
 * Examples with a lead at "123 Main St, Kansas City, MO, 64108":
 *   ""             → included (empty query = no filter)
 *   "main"         → included
 *   "KANSAS"       → included (case-insensitive)
 *   "kansas main"  → included (both tokens match in the joined haystack)
 *   "dayton"       → excluded
 *   "  "           → included (whitespace-only = no filter)
 */
export function filterLeads<T extends SearchableLead>(
  leads: readonly T[],
  query: string,
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...leads];

  return leads.filter((lead) => {
    const haystack = [lead.address, lead.city, lead.state, lead.zip, lead.market]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" ")
      .toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}
