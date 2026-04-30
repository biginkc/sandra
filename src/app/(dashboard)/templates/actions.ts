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
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listTemplates(): Promise<Result<TemplateRow[]>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sms_templates")
      .select("id, name, content, category, created_at, updated_at")
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
  const name = input.name.trim();
  const content = input.content.trim();
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
  if (!content) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Content is required." },
    };
  }

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
  try {
    const supabase = await createClient();
    const update: {
      name?: string;
      content?: string;
      category?: string;
    } = {};
    if (patch.name !== undefined) update.name = patch.name.trim();
    if (patch.content !== undefined) update.content = patch.content.trim();
    if (patch.category !== undefined)
      update.category = patch.category.trim() || "General";

    const { error } = await supabase
      .from("sms_templates")
      .update(update)
      .eq("id", templateId)
      .is("deleted_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "TPL_UPDATE_FAILED", message: error.message },
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
    const { error } = await supabase
      .from("sms_templates")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", templateId)
      .is("deleted_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "TPL_DELETE_FAILED", message: error.message },
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
