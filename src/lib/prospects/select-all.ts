/**
 * Server-side resolution of "everything matching these filters" for the Search page. Search
 * semantics only (every status, training hidden, `search_properties`), ALWAYS capped at
 * SEARCH_SELECT_ALL_CAP: over the cap is an error and no partial selection. There is no mode,
 * origin or cap option; the pre-Search resolver is a separate, untouched legacy code path.
 */
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { filterSelectFragment } from "@/lib/prospects/filter-to-supabase";
import { partitionSearchIds } from "@/lib/prospects/search-partition";
import {
  SEARCH_SELECT_ALL_CAP,
  buildScopedQuery,
  mapSearchError,
  resolveIncludeMessages,
  runWithSearchFallback,
} from "@/lib/prospects/search-scope";
import { createClient } from "@/lib/supabase/server";

export type SelectionFilters = {
  search: string | null;
  blockStack: FilterBlock[];
  imported?: "today" | null;
};

export type SelectAllResult = {
  /** Live non-DNC prospects among the matches. */
  eligibleIds: string[];
  eligibleCount: number;
  dncLockedCount: number;
  dncLockedIds: string[];
  /** Everything the page lists for these filters. */
  matchedCount: number;
  /** Matched rows that are not prospects (leads etc.). */
  skippedLeads: number;
};

const PAGE = 1000;

export async function selectAllSearch(args: SelectionFilters): Promise<Result<SelectAllResult>> {
  try {
    const supabase = await createClient();
    let includeMessages = false;
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
    const filterSelect = filterSelectFragment(args.blockStack);
    const select = ["id, source_import_id, source_imported_at", filterSelect].filter(Boolean).join(", ");
    let addressFallback = false;

    const failure = (error: { code?: string | null; message?: string }) => {
      const mapped = mapSearchError(error);
      return {
        ok: false as const,
        error: {
          code: mapped?.code ?? "SELECT_ALL_FAILED",
          message: mapped?.message ?? error.message ?? "Select all failed",
        },
      };
    };
    const tooLarge = (n?: number) => ({
      ok: false as const,
      error: {
        code: "SELECT_ALL_TOO_LARGE",
        message:
          n === undefined
            ? `More than ${SEARCH_SELECT_ALL_CAP.toLocaleString()} results. Narrow the search or filters, or select rows on the page.`
            : `That is ${n.toLocaleString()} results, over the ${SEARCH_SELECT_ALL_CAP.toLocaleString()} limit for selecting everything. Narrow the search or filters, or select rows on the page.`,
      },
    });

    // One exact head count first so an over-cap selection is rejected before paging.
    const counted = await runWithSearchFallback(async (opts) => {
      const { builder } = await buildScopedQuery(supabase, {
        select,
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
    if ((counted.result.count ?? 0) > SEARCH_SELECT_ALL_CAP) return tooLarge(counted.result.count ?? 0);

    // Deterministic id keyset (offset paging can skip/duplicate rows while states change).
    const allIds: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const { builder } = await buildScopedQuery(supabase, {
        select,
        search: args.search,
        blockStack: args.blockStack,
        imported: args.imported ?? null,
        includeMessages,
        addressFallback,
      });
      let query = builder;
      if (cursor) query = query.gt("id", cursor);
      const { data, error } = await query.order("id", { ascending: true }).limit(PAGE);
      if (error) return failure(error);
      const rows = (data ?? []) as unknown as Array<{ id: string }>;
      allIds.push(...rows.map((row) => row.id));
      if (allIds.length > SEARCH_SELECT_ALL_CAP) return tooLarge();
      if (rows.length < PAGE) break;
      const nextCursor = rows.at(-1)?.id ?? null;
      if (!nextCursor || nextCursor === cursor) {
        return { ok: false, error: { code: "SELECT_ALL_FAILED", message: "Selection did not advance safely." } };
      }
      cursor = nextCursor;
    }

    const part = await partitionSearchIds(supabase, allIds);
    return ok({
      eligibleIds: part.prospectIds,
      eligibleCount: part.prospectIds.length,
      dncLockedCount: part.dncLockedIds.length,
      dncLockedIds: part.dncLockedIds,
      matchedCount: allIds.length,
      skippedLeads: part.skippedLeads,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "search_select_all" } });
    return errFromUnknown(e, "SELECT_ALL_FAILED");
  }
}
