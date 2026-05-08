"use server";

import { revalidatePath } from "next/cache";

import { requireOrgMembership } from "@/lib/auth/require-org-membership";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import type { FilterState } from "@/lib/prospects/filter-schema";
import { createClient } from "@/lib/supabase/server";

/**
 * Saved-filter CRUD server actions for the prospects drawer.
 *
 * All four actions follow Sandra's canonical pattern (D-13):
 *   1. requireOrgMembership(orgId)  — throws AuthorizationError on no-session
 *      or non-member; the wrapping try/catch maps to errFromUnknown
 *   2. Mutation through user JWT — no service-role bypass; RLS policies
 *      `saved_filters_write_own` (insert/update/delete) and
 *      `saved_filters_read_own_plus_base` (select) enforce isolation
 *   3. revalidatePath('/properties') on success — repaints the Quick Filters
 *      bar and the Preset dropdown
 *   4. Return Result<T> with a kind-specific failure code from RESEARCH §539
 *
 * Known constraint (D-19): base presets cannot be starred-by-user. The
 * write_own RLS policy requires `user_id = auth.uid()` and base presets have
 * `user_id = NULL`. SPEC §5 honors this — base always shows in the Quick
 * Filters bar regardless of starred state.
 *
 * All inserts hardcode `is_base: false` and `starred: false` — only the
 * migration's seed step can create base presets, and the user has to call
 * togglePinSavedFilter explicitly to star.
 */

export type SavedFilterRow = {
  id: string;
  name: string;
  filters_json: FilterState;
  starred: boolean;
  is_base: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * Create a new user-scoped saved filter.
 *
 * `user_id` resolves authoritatively from `requireOrgMembership` — the
 * action ignores any client-provided user id, so the with-check policy
 * `user_id = auth.uid()` is always satisfied.
 */
export async function createSavedFilter(input: {
  orgId: string;
  name: string;
  filtersJson: FilterState;
}): Promise<Result<{ id: string }>> {
  try {
    const trimmed = input.name.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      return {
        ok: false,
        error: {
          code: "CREATE_FILTER_FAILED",
          message: "name must be 1-100 chars",
        },
      };
    }
    if (input.filtersJson?.v !== 1) {
      return {
        ok: false,
        error: {
          code: "CREATE_FILTER_FAILED",
          message: "invalid filters_json shape",
        },
      };
    }

    const { userId, orgId } = await requireOrgMembership(input.orgId);
    const sb = await createClient();
    const { data, error } = await sb
      .from("saved_filters")
      .insert({
        org_id: orgId,
        user_id: userId,
        name: trimmed,
        filters_json: input.filtersJson,
        is_base: false,
        starred: false,
      })
      .select("id")
      .single();
    if (error) {
      return {
        ok: false,
        error: { code: "CREATE_FILTER_FAILED", message: error.message },
      };
    }
    revalidatePath("/properties");
    return ok({ id: data.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_saved_filter" } });
    return errFromUnknown(e, "CREATE_FILTER_FAILED");
  }
}

/**
 * Update name and/or filters_json on a user-scoped row. RLS prevents
 * updating base presets (NULL user_id) or other users' rows — silently
 * filters them out at the USING clause, count comes back 0, action returns
 * UPDATE_FILTER_FAILED. We rely on RLS to do the filtering — never pass
 * `user_id = auth.uid()` in the client query (that would double-check
 * something the DB already enforces and break the canonical Sandra pattern).
 */
export async function updateSavedFilter(input: {
  orgId: string;
  id: string;
  name?: string;
  filtersJson?: FilterState;
}): Promise<Result<void>> {
  try {
    await requireOrgMembership(input.orgId);

    const patch: { name?: string; filters_json?: FilterState } = {};
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (trimmed.length === 0 || trimmed.length > 100) {
        return {
          ok: false,
          error: {
            code: "UPDATE_FILTER_FAILED",
            message: "name must be 1-100 chars",
          },
        };
      }
      patch.name = trimmed;
    }
    if (input.filtersJson !== undefined) {
      if (input.filtersJson.v !== 1) {
        return {
          ok: false,
          error: {
            code: "UPDATE_FILTER_FAILED",
            message: "invalid filters_json shape",
          },
        };
      }
      patch.filters_json = input.filtersJson;
    }

    const sb = await createClient();
    const { data, error } = await sb
      .from("saved_filters")
      .update(patch)
      .eq("id", input.id)
      .select("id");
    if (error) {
      return {
        ok: false,
        error: { code: "UPDATE_FILTER_FAILED", message: error.message },
      };
    }
    if (!data || data.length === 0) {
      return {
        ok: false,
        error: {
          code: "UPDATE_FILTER_FAILED",
          message: "row not found or RLS denied",
        },
      };
    }
    revalidatePath("/properties");
    return ok(undefined);
  } catch (e) {
    reportError(e, { tags: { surface: "update_saved_filter" } });
    return errFromUnknown(e, "UPDATE_FILTER_FAILED");
  }
}

/**
 * Delete a user-scoped saved filter. RLS prevents deleting base presets
 * or other users' rows — silently filters them out, returns
 * DELETE_FILTER_FAILED.
 */
export async function deleteSavedFilter(input: {
  orgId: string;
  id: string;
}): Promise<Result<void>> {
  try {
    await requireOrgMembership(input.orgId);
    const sb = await createClient();
    const { data, error } = await sb
      .from("saved_filters")
      .delete()
      .eq("id", input.id)
      .select("id");
    if (error) {
      return {
        ok: false,
        error: { code: "DELETE_FILTER_FAILED", message: error.message },
      };
    }
    if (!data || data.length === 0) {
      return {
        ok: false,
        error: {
          code: "DELETE_FILTER_FAILED",
          message: "row not found or RLS denied",
        },
      };
    }
    revalidatePath("/properties");
    return ok(undefined);
  } catch (e) {
    reportError(e, { tags: { surface: "delete_saved_filter" } });
    return errFromUnknown(e, "DELETE_FILTER_FAILED");
  }
}

/**
 * Toggle the `starred` boolean on a user-scoped preset. RLS prevents
 * starring base presets (their user_id is NULL — no match against
 * auth.uid()) and other users' rows. Returns the resulting `starred`
 * value so the client can confirm without re-fetching.
 */
export async function togglePinSavedFilter(input: {
  orgId: string;
  id: string;
  starred: boolean;
}): Promise<Result<{ starred: boolean }>> {
  try {
    await requireOrgMembership(input.orgId);
    const sb = await createClient();
    const { data, error } = await sb
      .from("saved_filters")
      .update({ starred: input.starred })
      .eq("id", input.id)
      .select("id, starred");
    if (error) {
      return {
        ok: false,
        error: { code: "TOGGLE_PIN_FAILED", message: error.message },
      };
    }
    if (!data || data.length === 0) {
      return {
        ok: false,
        error: {
          code: "TOGGLE_PIN_FAILED",
          message: "row not found or RLS denied",
        },
      };
    }
    revalidatePath("/properties");
    return ok({ starred: data[0].starred });
  } catch (e) {
    reportError(e, { tags: { surface: "toggle_pin_saved_filter" } });
    return errFromUnknown(e, "TOGGLE_PIN_FAILED");
  }
}
