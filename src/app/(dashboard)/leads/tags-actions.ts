"use server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";

export type TagRow = {
  id: string;
  name: string;
  color: string | null;
  category: "source" | "marketing" | "skip_trace" | "phone" | "journey" | "custom";
  system_managed: boolean;
};

export type PropertyTagRow = {
  id: string;
  tag_id: string;
  source: string;
  applied_at: string;
};

/**
 * Create a user-defined tag. Always lands in the `custom` category —
 * non-custom categories are reserved for system-generated tags
 * (source:*, uploaded:*, skip-traced:*, etc.). Case-insensitive
 * uniqueness per-org so "Attorney involved" and "attorney involved"
 * don't both exist.
 */
export async function createCustomTag(
  name: string,
  color?: string | null,
): Promise<Result<TagRow>> {
  const trimmed = name.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Tag name is required." },
    };
  }
  if (trimmed.length > 60) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Name is ${trimmed.length} characters — cap is 60.`,
      },
    };
  }
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
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
    const { data: existing } = await supabase
      .from("tags")
      .select("id, name, color, category, system_managed")
      .ilike("name", trimmed)
      .maybeSingle();
    if (existing) {
      return ok(existing as TagRow);
    }
    const { data: inserted, error } = await supabase
      .from("tags")
      .insert({ name: trimmed, category: "custom", color: color ?? null })
      .select("id, name, color, category, system_managed")
      .single();
    if (error) {
      return {
        ok: false,
        error: { code: "TAG_CREATE_FAILED", message: error.message },
      };
    }
    return ok(inserted as TagRow);
  } catch (e) {
    reportError(e, { tags: { surface: "create_custom_tag" } });
    return errFromUnknown(e, "TAG_CREATE_FAILED");
  }
}

/**
 * Apply a tag to a property. Idempotent — ON CONFLICT DO NOTHING keeps
 * the first `applied_at`/`applied_by` intact. Returns ok even when the
 * tag was already applied.
 */
export async function applyPropertyTag(
  propertyId: string,
  tagId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase.from("property_tags").upsert(
      {
        property_id: propertyId,
        tag_id: tagId,
        source: "manual",
        applied_by: user?.id ?? null,
      },
      { onConflict: "property_id,tag_id", ignoreDuplicates: true },
    );
    if (error) {
      return {
        ok: false,
        error: { code: "TAG_APPLY_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "apply_property_tag" },
      extra: { propertyId, tagId },
    });
    return errFromUnknown(e, "TAG_APPLY_FAILED");
  }
}

/**
 * Remove a tag from a property. Blocks removal of system-managed tags
 * from non-custom categories so VAs can't accidentally strip provenance
 * (source:propstream, uploaded:2026-04). They can only remove `custom`
 * tags they applied manually.
 */
export async function removePropertyTag(
  propertyId: string,
  tagId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    // Check the tag is user-removable first.
    const { data: tag } = await supabase
      .from("tags")
      .select("system_managed, category")
      .eq("id", tagId)
      .maybeSingle();
    if (!tag) {
      return {
        ok: false,
        error: { code: "TAG_NOT_FOUND", message: "Tag not found." },
      };
    }
    if (tag.system_managed) {
      return {
        ok: false,
        error: {
          code: "TAG_SYSTEM_MANAGED",
          message:
            "This tag is managed by the system and can't be removed manually.",
        },
      };
    }

    const { error } = await supabase
      .from("property_tags")
      .delete()
      .eq("property_id", propertyId)
      .eq("tag_id", tagId);
    if (error) {
      return {
        ok: false,
        error: { code: "TAG_REMOVE_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "remove_property_tag" },
      extra: { propertyId, tagId },
    });
    return errFromUnknown(e, "TAG_REMOVE_FAILED");
  }
}

/**
 * List all tags in the org — used by the "Add tag" combobox on the
 * lead detail. Returns the full tag catalog (all categories) so the
 * UI can separate auto-applied / manual in its own rendering.
 */
export async function listOrgTags(): Promise<Result<TagRow[]>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("tags")
      .select("id, name, color, category, system_managed")
      .order("category", { ascending: true })
      .order("name", { ascending: true });
    if (error) {
      return {
        ok: false,
        error: { code: "TAG_LIST_FAILED", message: error.message },
      };
    }
    return ok((data ?? []) as TagRow[]);
  } catch (e) {
    reportError(e, { tags: { surface: "list_org_tags" } });
    return errFromUnknown(e, "TAG_LIST_FAILED");
  }
}
