"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TemplateRow = {
  id: string;
  name: string;
  content: string;
  category: string;
  system_managed: boolean;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

/**
 * Validate name + content for create / update. Both paths used to share
 * the create-side checks via implicit "DB CHECK constraint will catch
 * it" — that surfaced raw `violates check constraint "..."` strings to
 * the toast on update (WR-07). Hoist to a single helper so both paths
 * give the same message and never leak constraint names.
 *
 * Returns { ok: true, data: trimmed } or an error Result. Trimming is
 * intentionally part of the validation so callers can rely on the
 * trimmed values for both the existence check and the DB write.
 */
type TemplateInput = {
  name?: string;
  content?: string;
};

function validateTemplateInput(
  input: TemplateInput,
  options: { requireAll: boolean },
): Result<{ name?: string; content?: string }> {
  const out: { name?: string; content?: string } = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "Name is required." },
      };
    }
    if (name.length > 120) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Name is ${name.length} characters — cap is 120.`,
        },
      };
    }
    out.name = name;
  } else if (options.requireAll) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Name is required." },
    };
  }

  if (input.content !== undefined) {
    const content = input.content.trim();
    if (!content) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "Content is required." },
      };
    }
    out.content = content;
  } else if (options.requireAll) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Content is required." },
    };
  }

  return ok(out);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listTemplates(): Promise<Result<TemplateRow[]>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sms_templates")
      .select("id, name, content, category, system_managed, created_at, updated_at")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false });
    if (error) {
      return {
        ok: false,
        error: { code: "TPL_LIST_FAILED", message: error.message },
      };
    }
    return ok(data ?? []);
  } catch (e) {
    reportError(e, { tags: { surface: "list_templates" } });
    return errFromUnknown(e, "TPL_LIST_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createTemplate(input: {
  name: string;
  content: string;
  category: string;
}): Promise<Result<{ id: string }>> {
  const validation = validateTemplateInput(
    { name: input.name, content: input.content },
    { requireAll: true },
  );
  if (!validation.ok) return validation;
  const { name, content } = validation.data as { name: string; content: string };

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data: firstOrg } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!firstOrg) {
      return {
        ok: false,
        error: { code: "NO_ORG", message: "No organization found." },
      };
    }

    const { data: inserted, error } = await supabase
      .from("sms_templates")
      .insert({
        org_id: firstOrg.id,
        name,
        content,
        category: input.category.trim() || "General",
        created_by: user?.id ?? null,
      })
      .select("id")
      .single();
    if (error) {
      return {
        ok: false,
        error: { code: "TPL_CREATE_FAILED", message: error.message },
      };
    }
    revalidatePath("/templates");
    return ok({ id: inserted.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_template" } });
    return errFromUnknown(e, "TPL_CREATE_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateTemplate(
  templateId: string,
  patch: {
    name?: string;
    content?: string;
    category?: string;
  },
): Promise<Result<null>> {
  // WR-07: run the same name/content validation create uses. `requireAll:
  // false` lets a partial patch (e.g. category only) skip the
  // name/content checks; we only validate fields that were actually
  // supplied. Returning a typed VALIDATION error here keeps the toast
  // copy consistent with create and avoids leaking raw Postgres CHECK
  // constraint names (`sms_templates_name_check` etc).
  const validation = validateTemplateInput(
    { name: patch.name, content: patch.content },
    { requireAll: false },
  );
  if (!validation.ok) return validation;

  try {
    const supabase = await createClient();

    // System-managed guard: never allow editing seeded templates.
    const { data: tpl, error: tplErr } = await supabase
      .from("sms_templates")
      .select("system_managed")
      .eq("id", templateId)
      .is("deleted_at", null)
      .maybeSingle();
    if (tplErr) {
      return { ok: false, error: { code: "TPL_UPDATE_FAILED", message: tplErr.message } };
    }
    if (!tpl) {
      return { ok: false, error: { code: "TPL_NOT_FOUND", message: "Template not found or already deleted." } };
    }
    if (tpl.system_managed) {
      return { ok: false, error: { code: "SYSTEM_MANAGED_TPL", message: "System templates cannot be edited." } };
    }

    const update: {
      name?: string;
      content?: string;
      category?: string;
    } = {};
    if (validation.data.name !== undefined) update.name = validation.data.name;
    if (validation.data.content !== undefined)
      update.content = validation.data.content;
    if (patch.category !== undefined)
      update.category = patch.category.trim() || "General";

    // WR-08: ask Postgres for an exact row count so we can detect a
    // no-op update (stale id, already-soft-deleted, RLS-hidden). Without
    // this, Supabase returns `error: null` with zero rows affected and
    // we'd lie to the user with a "Template updated" toast.
    const { error, count } = await supabase
      .from("sms_templates")
      .update(update, { count: "exact" })
      .eq("id", templateId)
      .is("deleted_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "TPL_UPDATE_FAILED", message: error.message },
      };
    }
    if ((count ?? 0) === 0) {
      return {
        ok: false,
        error: {
          code: "TPL_NOT_FOUND",
          message: "Template not found or already deleted.",
        },
      };
    }
    revalidatePath("/templates");
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_template" },
      extra: { templateId },
    });
    return errFromUnknown(e, "TPL_UPDATE_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Soft-delete
// ---------------------------------------------------------------------------

export async function deleteTemplate(
  templateId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();

    // WR-09: pre-flight count of `sequence_steps` rows pointing at this
    // template. tick.ts already pauses enrollments cleanly with
    // `template_missing` if the template disappears mid-flight, but the
    // author gets zero feedback — active enrollments silently stop
    // dripping. Refuse the delete with a `TPL_IN_USE` error and a count
    // so the UI can prompt the author to detach first.
    const { count: refCount, error: refErr } = await supabase
      .from("sequence_steps")
      .select("id", { count: "exact", head: true })
      .eq("template_id", templateId);
    if (refErr) {
      return {
        ok: false,
        error: { code: "TPL_DELETE_FAILED", message: refErr.message },
      };
    }
    if ((refCount ?? 0) > 0) {
      return {
        ok: false,
        error: {
          code: "TPL_IN_USE",
          message: `Used by ${refCount} sequence step${
            refCount === 1 ? "" : "s"
          }. Detach the template from those steps before deleting.`,
        },
      };
    }

    // System-managed guard: never allow deleting seeded templates.
    const { data: tpl, error: tplErr } = await supabase
      .from("sms_templates")
      .select("system_managed")
      .eq("id", templateId)
      .is("deleted_at", null)
      .maybeSingle();
    if (tplErr) {
      return { ok: false, error: { code: "TPL_DELETE_FAILED", message: tplErr.message } };
    }
    if (!tpl) {
      return { ok: false, error: { code: "TPL_NOT_FOUND", message: "Template not found or already deleted." } };
    }
    if (tpl.system_managed) {
      return { ok: false, error: { code: "SYSTEM_MANAGED_TPL", message: "System templates cannot be deleted." } };
    }

    // WR-08: same exact-count guard as updateTemplate.
    const { error, count } = await supabase
      .from("sms_templates")
      .update(
        { deleted_at: new Date().toISOString() },
        { count: "exact" },
      )
      .eq("id", templateId)
      .is("deleted_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "TPL_DELETE_FAILED", message: error.message },
      };
    }
    if ((count ?? 0) === 0) {
      return {
        ok: false,
        error: {
          code: "TPL_NOT_FOUND",
          message: "Template not found or already deleted.",
        },
      };
    }
    revalidatePath("/templates");
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "delete_template" },
      extra: { templateId },
    });
    return errFromUnknown(e, "TPL_DELETE_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Distinct categories (for filter dropdown)
// ---------------------------------------------------------------------------

export async function listCategories(): Promise<Result<string[]>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sms_templates")
      .select("category")
      .is("deleted_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "TPL_CAT_FAILED", message: error.message },
      };
    }
    const unique = [...new Set((data ?? []).map((r) => r.category))].sort();
    return ok(unique);
  } catch (e) {
    reportError(e, { tags: { surface: "list_categories" } });
    return errFromUnknown(e, "TPL_CAT_FAILED");
  }
}
