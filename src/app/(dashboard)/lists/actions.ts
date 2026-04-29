"use server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";

export type CreateListInput = {
  name: string;
  description?: string | null;
  color?: string | null;
};

/**
 * Create a new list. Enforces case-insensitive uniqueness per-org so the
 * UI can't silently create a second "probate" when "Probate" exists.
 */
export async function createList(
  input: CreateListInput,
): Promise<Result<{ id: string }>> {
  const name = input.name.trim();
  if (!name) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "List name is required." },
    };
  }
  if (name.length > 80) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Name is ${name.length} characters — cap is 80.`,
      },
    };
  }
  if (input.color && !/^#[0-9a-f]{6}$/i.test(input.color)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Color must be a 6-character hex like #3b82f6.",
      },
    };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Case-insensitive pre-check so we can return a friendly error rather
    // than the uniqueness-constraint violation from the DB.
    const { data: existing } = await supabase
      .from("lists")
      .select("id, archived_at")
      .ilike("name", name)
      .maybeSingle();
    if (existing) {
      if (existing.archived_at) {
        // Revive archived list rather than rejecting the create.
        const { error } = await supabase
          .from("lists")
          .update({ archived_at: null })
          .eq("id", existing.id);
        if (error) {
          return {
            ok: false,
            error: { code: "LIST_UPDATE_FAILED", message: error.message },
          };
        }
        return ok({ id: existing.id });
      }
      return {
        ok: false,
        error: {
          code: "DUPLICATE_NAME",
          message: `A list named "${name}" already exists.`,
        },
      };
    }

    const { data: inserted, error } = await supabase
      .from("lists")
      .insert({
        name,
        description: input.description ?? null,
        color: input.color ?? null,
        created_by: user?.id ?? null,
      })
      .select("id")
      .single();
    if (error) {
      return {
        ok: false,
        error: { code: "LIST_CREATE_FAILED", message: error.message },
      };
    }
    return ok({ id: inserted.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_list" } });
    return errFromUnknown(e, "LIST_CREATE_FAILED");
  }
}

/**
 * Archive a list (soft delete). Memberships stay — stack counts don't
 * change — but the list stops showing on lead-card badges and the /lists
 * page flips it to the archived section.
 *
 * System-managed lists (the 20 PropStream-style buckets seeded by
 * migration 031) are protected: the action rejects with
 * SYSTEM_MANAGED_LIST. Defense-in-depth alongside the UI hide in
 * `list-row-actions.tsx`.
 */
export async function archiveList(id: string): Promise<Result<null>> {
  try {
    const supabase = await createClient();

    // Pre-check the row's system_managed flag so we can return a friendly
    // code instead of silently mutating archived_at.
    const { data: existing, error: lookupErr } = await supabase
      .from("lists")
      .select("system_managed")
      .eq("id", id)
      .maybeSingle();
    if (lookupErr) {
      return {
        ok: false,
        error: { code: "LIST_ARCHIVE_FAILED", message: lookupErr.message },
      };
    }
    if (!existing) {
      return {
        ok: false,
        error: { code: "LIST_NOT_FOUND", message: "List does not exist." },
      };
    }
    if (existing.system_managed) {
      return {
        ok: false,
        error: {
          code: "SYSTEM_MANAGED_LIST",
          message: "System-managed lists cannot be archived.",
        },
      };
    }

    const { error } = await supabase
      .from("lists")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      return {
        ok: false,
        error: { code: "LIST_ARCHIVE_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "archive_list" }, extra: { id } });
    return errFromUnknown(e, "LIST_ARCHIVE_FAILED");
  }
}

/**
 * Un-archive a list. Reversible from the /lists "Archived" section.
 *
 * System-managed lists never enter the archived section in the first
 * place (they're blocked by `archiveList`), but we still guard
 * `unarchiveList` for symmetry — same SYSTEM_MANAGED_LIST code so
 * consumers can branch on a single error.
 */
export async function unarchiveList(id: string): Promise<Result<null>> {
  try {
    const supabase = await createClient();

    const { data: existing, error: lookupErr } = await supabase
      .from("lists")
      .select("system_managed")
      .eq("id", id)
      .maybeSingle();
    if (lookupErr) {
      return {
        ok: false,
        error: { code: "LIST_UNARCHIVE_FAILED", message: lookupErr.message },
      };
    }
    if (!existing) {
      return {
        ok: false,
        error: { code: "LIST_NOT_FOUND", message: "List does not exist." },
      };
    }
    if (existing.system_managed) {
      return {
        ok: false,
        error: {
          code: "SYSTEM_MANAGED_LIST",
          message: "System-managed lists cannot be modified.",
        },
      };
    }

    const { error } = await supabase
      .from("lists")
      .update({ archived_at: null })
      .eq("id", id);
    if (error) {
      return {
        ok: false,
        error: { code: "LIST_UNARCHIVE_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "unarchive_list" }, extra: { id } });
    return errFromUnknown(e, "LIST_UNARCHIVE_FAILED");
  }
}
