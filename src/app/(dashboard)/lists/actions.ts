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
 */
export async function archiveList(id: string): Promise<Result<null>> {
  try {
    const supabase = await createClient();
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

/** Un-archive a list. Reversible from the /lists "Archived" section. */
export async function unarchiveList(id: string): Promise<Result<null>> {
  try {
    const supabase = await createClient();
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
