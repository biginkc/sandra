"use server";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { requireOrgMembership } from "@/lib/auth/require-org-membership";
import { filterSelectFragment } from "@/lib/prospects/filter-to-supabase";
import {
  buildScopedQuery,
  mapSearchError,
  parseQueryOrigin,
  resolveIncludeMessages,
  runWithSearchFallback,
  type QueryOrigin,
} from "@/lib/prospects/search-scope";
import type { BlockStack } from "@/lib/prospects/filter-schema";
import { createClient } from "@/lib/supabase/server";

export type CountResult = { count: number };

/**
 * Live count for the drawer footer "Show N prospects" CTA.
 *
 * Runs under the user JWT — RLS-scoped via the Stage 1 membership regime
 * (migration 054). No service-role bypass anywhere; the count reflects what
 * the caller would actually see on `/properties` if the same predicates were
 * applied to a row-returning query.
 *
 * Debounce (250 ms) is applied CLIENT-side by Plan 06's drawer hook —
 * `useDebouncedFilters(filters, 250)`. This action runs on every call.
 *
 * Base predicates come from `buildScopedQuery` (search-scope.ts): origin
 * 'legacy' keeps `status = 'prospect' OR is_dnc_locked` (dropped when a
 * pipeline_status block is present); origin 'search_page' counts every
 * status, hides training rows and applies the page's search.
 *
 * @returns Result<{ count: number }> — `count` is exact (not estimated)
 *          because R9 needs an authoritative number for "select all matching"
 *          bulk actions.
 */
export async function countProspectsForFilter(input: {
  orgId: string;
  blocks: BlockStack;
  /** Page `?search=`. Previously ignored (count drifted from the page). */
  search?: string | null;
  /** Page `?imported=today`. Previously ignored. */
  imported?: "today" | null;
  /** Defaults to 'legacy'; the Search page passes 'search_page'. */
  origin?: QueryOrigin;
}): Promise<Result<CountResult>> {
  try {
    await requireOrgMembership(input.orgId);
    const sb = await createClient();
    const origin = parseQueryOrigin(input.origin);

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

    // Base predicates (deleted_at, scope, training, search) come from the
    // shared query context so this count can never drift from the page.
    const select = ["id", filterSelectFragment(input.blocks)]
      .filter(Boolean)
      .join(", ");
    const { result } = await runWithSearchFallback(async (opts) => {
      const { builder } = await buildScopedQuery(sb, {
        origin,
        select,
        selectOpts: { count: "exact", head: true },
        search: input.search ?? null,
        blockStack: input.blocks,
        imported: input.imported ?? null,
        includeMessages,
        addressFallback: opts.addressFallback,
      });
      return (await builder) as {
        count: number | null;
        error: { code?: string | null; message?: string } | null;
      };
    });
    if (result.error) {
      const mapped = origin === "search_page" ? mapSearchError(result.error) : null;
      return {
        ok: false,
        error: {
          code: "COUNT_FILTER_FAILED",
          message: mapped?.message ?? result.error.message ?? "Count failed",
        },
      };
    }
    return ok({ count: result.count ?? 0 });
  } catch (e) {
    reportError(e, { tags: { surface: "count_prospects_for_filter" } });
    return errFromUnknown(e, "COUNT_FILTER_FAILED");
  }
}
