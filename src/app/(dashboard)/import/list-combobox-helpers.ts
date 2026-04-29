/**
 * Pure-logic helpers for the import wizard's List combobox. Extracted so
 * the matching / create behavior can be unit-tested without spinning up a
 * DOM.
 */

export type ListEntry = { id: string; name: string };

export type ListQueryClassification = {
  /** The trimmed query string. */
  trimmed: string;
  /** Lists that match the query (case-insensitive substring), or all lists
   *  when the query is empty. */
  matches: ListEntry[];
  /** True when an existing list's name matches the trimmed query exactly
   *  (case-insensitive). Drives the "you'll add to this list" affordance
   *  vs the "create new" affordance. */
  exactMatch: boolean;
  /** True when the user can create a new list from this query — i.e. the
   *  query is non-empty and doesn't already exactly match an existing
   *  list. */
  canCreate: boolean;
};

/**
 * Classify a search query against the org's existing lists. Drives both
 * the displayed match list and whether the "Create '<query>'" option
 * should appear.
 */
export function classifyListQuery(
  rawQuery: string,
  lists: readonly ListEntry[],
): ListQueryClassification {
  const trimmed = rawQuery.trim();
  if (trimmed === "") {
    return { trimmed, matches: [...lists], exactMatch: false, canCreate: false };
  }
  const lower = trimmed.toLowerCase();
  const matches = lists.filter((l) => l.name.toLowerCase().includes(lower));
  const exactMatch = lists.some((l) => l.name.toLowerCase() === lower);
  return {
    trimmed,
    matches,
    exactMatch,
    canCreate: !exactMatch,
  };
}
