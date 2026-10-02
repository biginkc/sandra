import { decodeFilters, type FilterBlock } from "./filter-schema";
import type { SelectionFilters } from "./select-all";

/** Every Search action takes a selection of exactly one of these shapes. No origin, mode or cap field exists. */
export type SearchSelection =
  | { kind: "ids"; ids: string[] }
  | { kind: "filters"; filters: SelectionFilters };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEARCH_LENGTH = 200;

export class SearchInputError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Reject unknown keys (strict): a forged `origin`, `mode`, `cap` etc. is an error, never ignored. */
export function assertKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new SearchInputError(`Unknown field "${key}" in ${where}.`);
  }
}

export function parseSelection(input: unknown): SearchSelection {
  if (!isPlainObject(input)) throw new SearchInputError("selection must be an object.");
  if (input.kind === "ids") {
    assertKeys(input, ["kind", "ids"], "selection");
    if (!Array.isArray(input.ids) || !input.ids.every((id) => typeof id === "string" && UUID.test(id))) {
      throw new SearchInputError("selection.ids must be an array of property ids.");
    }
    return { kind: "ids", ids: input.ids as string[] };
  }
  if (input.kind === "filters") {
    assertKeys(input, ["kind", "filters"], "selection");
    return { kind: "filters", filters: parseFilters(input.filters) };
  }
  throw new SearchInputError("selection.kind must be 'ids' or 'filters'.");
}

export function parseFilters(input: unknown): SelectionFilters {
  if (!isPlainObject(input)) throw new SearchInputError("filters must be an object.");
  assertKeys(input, ["search", "blockStack", "imported"], "filters");
  const { search, blockStack, imported } = input;
  if (search !== null && search !== undefined && (typeof search !== "string" || search.length > MAX_SEARCH_LENGTH)) {
    throw new SearchInputError("filters.search must be a short string or null.");
  }
  if (imported !== null && imported !== undefined && imported !== "today") {
    throw new SearchInputError("filters.imported must be 'today' or null.");
  }
  if (!Array.isArray(blockStack)) throw new SearchInputError("filters.blockStack must be an array.");
  const decoded = decodeFilters(encodeURIComponent(JSON.stringify({ v: 1, blocks: blockStack })));
  if (decoded.blocks.length !== blockStack.length) throw new SearchInputError("filters.blockStack contains an invalid block.");
  return {
    search: typeof search === "string" ? search : null,
    blockStack: decoded.blocks as FilterBlock[],
    imported: imported === "today" ? "today" : null,
  };
}

/** Parse an action's single object argument: exact allowed keys, a selection, and caller-checked extras. */
export function parseInput(
  input: unknown,
  extraKeys: readonly string[],
): { selection: SearchSelection; rest: Record<string, unknown> } {
  if (!isPlainObject(input)) throw new SearchInputError("Request must be an object.");
  assertKeys(input, ["selection", ...extraKeys], "request");
  const { selection, ...rest } = input;
  return { selection: parseSelection(selection), rest };
}
