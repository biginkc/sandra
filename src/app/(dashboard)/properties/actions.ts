"use server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";

import { SELECT_ALL_HARD_CAP, type ParsedProspectsFilters } from "./prospects-query";

/**
 * Return every property_id matching the current filter set on the
 * prospects page. Used by the "Select all N prospects across all pages"
 * affordance — the table fetches the full ID set once, expands its
 * client-side selection Set, and existing bulk actions (which already
 * accept arrays of IDs) work unchanged.
 *
 * Filter chain mirrors page.tsx:
 *   - status='prospect', deleted_at IS NULL  (always)
 *   - search → ILIKE on address
 *   - vacant=true → is_vacant=true
 *   - cass='verified' → cass_status='verified'
 *   - market → exact match
 *   - assignee → 'unassigned' sentinel OR uuid match
 *   - engagement='contacted' → property_ids whose latest message direction
 *     is 'outbound' (one extra messages roundtrip; same logic as page.tsx)
 *
 * Result is capped at SELECT_ALL_HARD_CAP rows so a runaway "select-all 50K"
 * can't accidentally torch skip-trace credits via a downstream bulk action.
 */
export async function getAllMatchingProspectIds(args: {
  search: string | null;
  filters: ParsedProspectsFilters;
}): Promise<Result<string[]>> {
  try {
    const supabase = await createClient();

    let engagementFilteredIds: string[] | null = null;
    if (args.filters.engagement === "contacted") {
      const { data: msgRows } = await supabase
        .from("messages")
        .select("property_id, direction, created_at")
        .not("property_id", "is", null)
        .order("created_at", { ascending: false });
      const seen = new Set<string>();
      const matched = new Set<string>();
      for (const m of msgRows ?? []) {
        if (!m.property_id || seen.has(m.property_id)) continue;
        seen.add(m.property_id);
        if (m.direction === "outbound") matched.add(m.property_id);
      }
      engagementFilteredIds =
        matched.size === 0 ? ["__no_match__"] : Array.from(matched);
    }

    let query = supabase
      .from("properties")
      .select("id")
      .eq("status", "prospect")
      .is("deleted_at", null);

    if (args.search) {
      query = query.ilike("address", `%${args.search}%`);
    }
    if (args.filters.vacant) {
      query = query.eq("is_vacant", true);
    }
    if (args.filters.cass === "verified") {
      query = query.eq("cass_status", "verified");
    }
    if (args.filters.market) {
      query = query.eq("market", args.filters.market);
    }
    if (args.filters.assignee === "unassigned") {
      query = query.is("assigned_user_id", null);
    } else if (args.filters.assignee) {
      query = query.eq("assigned_user_id", args.filters.assignee);
    }
    if (engagementFilteredIds) {
      query = query.in("id", engagementFilteredIds);
    }

    const { data, error } = await query.limit(SELECT_ALL_HARD_CAP);

    if (error) {
      return {
        ok: false,
        error: { code: "SELECT_ALL_FAILED", message: error.message },
      };
    }

    return ok((data ?? []).map((r) => r.id));
  } catch (e) {
    reportError(e, { tags: { surface: "get_all_matching_prospect_ids" } });
    return errFromUnknown(e, "SELECT_ALL_FAILED");
  }
}
