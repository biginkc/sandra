"use server";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { requireOrgMembership } from "@/lib/auth/require-org-membership";
import { applyFilters } from "@/lib/prospects/filter-to-supabase";
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
 * Base predicates:
 *   - `deleted_at IS NULL` (soft-delete; matches `idx_properties_active`)
 *   - `status = 'prospect'` (the page is a single-status view by default)
 *
 * The `pipeline_status` block (D-12 in 05-CONTEXT) is the only block that
 * can broaden status beyond `prospect`. When a `pipeline_status` block is
 * present in the stack, the base `status = 'prospect'` predicate is dropped
 * and the block's translator (Plan 04) is responsible for emitting the
 * appropriate IN/NOT IN clause.
 *
 * @returns Result<{ count: number }> — `count` is exact (not estimated)
 *          because R9 needs an authoritative number for "select all matching"
 *          bulk actions.
 */
export async function countProspectsForFilter(input: {
  orgId: string;
  blocks: BlockStack;
}): Promise<Result<CountResult>> {
  try {
    await requireOrgMembership(input.orgId);
    const sb = await createClient();

    // Base predicates: soft-delete + prospect default. The pipeline_status
    // block (if present in the stack) replaces the prospect filter via the
    // translator's contract (Plan 04 §case 16).
    const hasPipelineBlock = input.blocks.some(
      (b) => b.kind === "pipeline_status",
    );

    let q = sb
      .from("properties")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null);
    if (!hasPipelineBlock) q = q.eq("status", "prospect");

    q = applyFilters(q, input.blocks, sb);

    const { count, error } = await q;
    if (error) {
      return {
        ok: false,
        error: { code: "COUNT_FILTER_FAILED", message: error.message },
      };
    }
    return ok({ count: count ?? 0 });
  } catch (e) {
    reportError(e, { tags: { surface: "count_prospects_for_filter" } });
    return errFromUnknown(e, "COUNT_FILTER_FAILED");
  }
}
