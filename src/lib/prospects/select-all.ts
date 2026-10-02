/**
 * Server-side resolution of "everything matching these filters" for the Search
 * page. Lives outside the "use server" action files so it is not itself a
 * client-callable endpoint; actions wrap it. See getAllMatchingProspectSelection.
 */
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { resolveProspectEligibility } from "@/lib/prospects/eligibility";
import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { filterSelectFragment } from "@/lib/prospects/filter-to-supabase";
import {
  SEARCH_SELECT_ALL_CAP,
  buildScopedQuery,
  mapSearchError,
  resolveIncludeMessages,
  runWithSearchFallback,
  type QueryOrigin,
} from "@/lib/prospects/search-scope";
import { createClient } from "@/lib/supabase/server";

/** A Search-page "all matching" selection: re-resolved on the server, never a client id list. */
export type SelectionFilters = {
  search: string | null;
  blockStack: FilterBlock[];
  imported?: "today" | null;
};

/**
 * How a filter selection is resolved. Chosen by the SERVER entry point, never by the client:
 *  - 'legacy': byte-for-byte the pre-Search resolver (prospect-or-DNC status, unescaped address
 *    ilike, uncapped). Used by the existing Prospects/campaign actions.
 *  - 'search': Search-page semantics (all statuses, training hidden, search_properties, lead-skip
 *    reporting) and ALWAYS capped at SEARCH_SELECT_ALL_CAP.
 */
export type SelectMode = "legacy" | "search";

/** Explicit checkbox ids, or the filters of a select-all-matching. */
export type PropertySelection = string[] | { filters: SelectionFilters };

export function selectionFilters(s: PropertySelection): SelectionFilters | null {
  return Array.isArray(s) ? null : s.filters;
}

/** The explicit ids of a selection (empty for a filter selection). */
export function selectionIds(s: PropertySelection): string[] {
  return Array.isArray(s) ? s : [];
}

export type SelectAllResult = {
  eligibleIds: string[];
  eligibleCount: number;
  dncLockedCount: number;
  /** The DNC-locked prospect ids behind `dncLockedCount` (search origin), so
   *  wrappers can report them like the checkbox path does. */
  dncLockedIds?: string[];
  matchedCount: number;
  /** Matched rows that are not prospects (leads etc.) and so were skipped. */
  skippedLeads: number;
};

export async function selectAllMatching(
  args: SelectionFilters,
  mode: SelectMode,
): Promise<Result<SelectAllResult>> {
  try {
    const supabase = await createClient();
    const origin: QueryOrigin = mode === "search" ? "search_page" : "legacy";

    let includeMessages = false;
    if (origin === "search_page") {
      try {
        includeMessages = await resolveIncludeMessages();
      } catch {
        return {
          ok: false,
          error: {
            code: "SEARCH_ACCESS_UNAVAILABLE",
            message: "Membership access could not be verified. Please retry.",
          },
        };
      }
    }

    const filterSelect = filterSelectFragment(args.blockStack);
    const propertiesSelect = [
      "id, source_import_id, source_imported_at",
      filterSelect,
    ]
      .filter(Boolean)
      .join(", ");
    const searchOrigin = origin === "search_page";
    // Search mode is ALWAYS capped; legacy mode (campaign audiences) never was.
    const capOn = mode === "search";
    let addressFallback = false;

    const failure = (error: { code?: string | null; message?: string }) => {
      const mapped = searchOrigin ? mapSearchError(error) : null;
      return {
        ok: false as const,
        error: {
          code: mapped?.code ?? "SELECT_ALL_FAILED",
          message: mapped?.message ?? error.message ?? "Select all failed",
        },
      };
    };

    // Search origin: one exact head count first so an over-cap selection is
    // rejected before paging (each 1k keyset page is one RPC evaluation).
    if (searchOrigin) {
      const counted = await runWithSearchFallback(async (opts) => {
        const { builder } = await buildScopedQuery(supabase, {
          origin,
          select: propertiesSelect,
          selectOpts: { count: "exact", head: true },
          search: args.search,
          blockStack: args.blockStack,
          imported: args.imported ?? null,
          includeMessages,
          addressFallback: opts.addressFallback,
        });
        return (await builder) as {
          count: number | null;
          error: { code?: string | null; message?: string } | null;
        };
      });
      addressFallback = counted.degraded;
      if (counted.result.error) return failure(counted.result.error);
      if ((counted.result.count ?? 0) > SEARCH_SELECT_ALL_CAP) {
        return {
          ok: false,
          error: {
            code: "SELECT_ALL_TOO_LARGE",
            message: `That is ${(counted.result.count ?? 0).toLocaleString()} results, over the ${SEARCH_SELECT_ALL_CAP.toLocaleString()} limit for selecting everything. Narrow the search or filters, or select rows on the page.`,
          },
        };
      }
    }

    // PostgREST silently caps results at 1 000 rows (db-max-rows default).
    // Use a deterministic ID keyset. Offset pagination can skip or duplicate
    // rows when a prospect changes state while a >1K selection is loading.
    const PAGE = 1000;
    const allIds: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const { builder } = await buildScopedQuery(supabase, {
        origin,
        select: propertiesSelect,
        search: args.search,
        blockStack: args.blockStack,
        imported: args.imported ?? null,
        includeMessages,
        addressFallback,
      });
      let query = builder;
      if (cursor) query = query.gt("id", cursor);
      const { data, error } = await query
        .order("id", { ascending: true })
        .limit(PAGE);
      if (error) return failure(error);
      const rows = (data ?? []) as unknown as Array<{ id: string }>;
      allIds.push(...rows.map((row) => row.id));
      if (capOn && allIds.length > SEARCH_SELECT_ALL_CAP) {
        return {
          ok: false,
          error: {
            code: "SELECT_ALL_TOO_LARGE",
            message: `More than ${SEARCH_SELECT_ALL_CAP.toLocaleString()} results. Narrow the search or filters, or select rows on the page.`,
          },
        };
      }
      if (rows.length < PAGE) break;
      const nextCursor = rows.at(-1)?.id ?? null;
      if (!nextCursor || nextCursor === cursor) {
        return {
          ok: false,
          error: {
            code: "SELECT_ALL_FAILED",
            message: "Prospect selection did not advance safely.",
          },
        };
      }
      cursor = nextCursor;
    }

    const resolved = await resolveProspectEligibility(
      supabase,
      allIds,
      "selection",
    );
    return ok({
      eligibleIds: resolved.eligibleIds,
      eligibleCount: resolved.eligibleIds.length,
      // Leads are counted BEFORE the DNC split, so a locked lead is a
      // skipped lead, not a "DNC locked prospect".
      dncLockedCount: searchOrigin
        ? resolved.prospectDncLockedCount
        : resolved.dncLockedCount,
      dncLockedIds: searchOrigin ? resolved.prospectDncLockedIds : undefined,
      matchedCount: allIds.length,
      skippedLeads: searchOrigin
        ? resolved.skippedLeadCount
        : resolved.exclusions.filter(
            (item) => item.reason === "not_found_or_not_prospect",
          ).length,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "get_all_matching_prospect_ids" } });
    return errFromUnknown(e, "SELECT_ALL_FAILED");
  }
}

export type ResolvedSelection = {
  /** For a filter selection: the server-resolved eligible ids. For explicit ids: the ids as given. */
  ids: string[];
  /** Filter selections only: matched rows that are not prospects. */
  skippedLeads: number;
  /** Filter selections only: matched DNC-locked prospects. */
  dncLockedCount: number;
  dncLockedIds: string[];
  /** Filter selections only: every matched row. */
  matchedCount: number;
  fromFilters: boolean;
};

/**
 * Resolve any selection to ids on the server. A filter selection is re-resolved in the given mode
 * ('search' is always capped) and never trusts client ids; explicit ids pass through so the
 * per-action guards (eligibility, DNC) re-check them. The mode is chosen by the entry point.
 */
export async function resolveSelection(
  selection: PropertySelection,
  mode: SelectMode,
): Promise<Result<ResolvedSelection>> {
  const filters = selectionFilters(selection);
  if (!filters) {
    const ids = selectionIds(selection);
    return ok({ ids, skippedLeads: 0, dncLockedCount: 0, dncLockedIds: [], matchedCount: ids.length, fromFilters: false });
  }
  const resolved = await selectAllMatching(filters, mode);
  if (!resolved.ok) return resolved;
  return ok({
    ids: resolved.data.eligibleIds,
    skippedLeads: resolved.data.skippedLeads,
    dncLockedCount: resolved.data.dncLockedCount,
    dncLockedIds: resolved.data.dncLockedIds ?? [],
    matchedCount: resolved.data.matchedCount,
    fromFilters: true,
  });
}
