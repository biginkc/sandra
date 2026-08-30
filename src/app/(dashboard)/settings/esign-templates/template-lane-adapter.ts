import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getCallerMemberships } from "@/lib/auth/memberships";
import { createFoundationTemplateOrchestrator } from "@/lib/esign/template-foundation-adapter";

import type {
  TemplateEditorData,
  TemplateLaneResult,
  TemplateLibraryLoadResult,
  PendingTemplateCopiesLoadResult,
} from "./types";

export async function loadTemplateLibrary(): Promise<TemplateLibraryLoadResult> {
  try {
    const membership = (await getCallerMemberships())[0];
    if (!membership || membership.role !== "owner") {
      return { ok: false, error: { code: "OWNER_REQUIRED", message: "Only an organization owner can manage eSign templates." } };
    }
    return await (await createFoundationTemplateOrchestrator()).list();
  } catch {
    return { ok: false, error: { code: "TEMPLATE_LIST_FAILED", message: "Templates could not be loaded." } };
  }
}

export async function loadPendingTemplateCopies(): Promise<PendingTemplateCopiesLoadResult> {
  try {
    const membership = (await getCallerMemberships())[0];
    if (!membership || membership.role !== "owner") {
      return { ok: false, error: { code: "OWNER_REQUIRED", message: "Only an organization owner can manage eSign templates." } };
    }
    const result = await (await createFoundationTemplateOrchestrator()).listPendingCopies();
    if (!result.ok) return result;
    return { ok: true, data: result.data.map(({ id, name, lifecycle }) => ({ id, name, lifecycle })) };
  } catch {
    return { ok: false, error: { code: "PENDING_COPY_LIST_FAILED", message: "Pending template copies could not be loaded." } };
  }
}

export async function loadTemplateEditor(
  templateId: string,
): Promise<TemplateLaneResult<TemplateEditorData>> {
  try {
    const membership = (await getCallerMemberships())[0];
    if (!membership || membership.role !== "owner") {
      return { ok: false, error: { code: "OWNER_REQUIRED", message: "Only an organization owner can manage eSign templates." } };
    }
    const { data, error } = await createAdminClient()
      .from("esign_templates")
      .select("id,name,source_filename,source_size_bytes,merge_field_names,lifecycle_state,deleted_at,abandoned_at")
      .eq("org_id", membership.org_id)
      .eq("id", templateId)
      .maybeSingle();
    if (error) throw error;
    if (!data || data.deleted_at || data.abandoned_at) {
      return { ok: false, error: { code: "TEMPLATE_NOT_FOUND", message: "The template is unavailable." } };
    }
    return { ok: true, data: {
      id: data.id,
      name: data.name,
      sourceFilename: data.source_filename ?? "Dropbox Sign template",
      sourceSizeBytes: data.source_size_bytes ?? 0,
      pageCount: null,
      fieldCount: data.merge_field_names.length,
      isFinalized: data.lifecycle_state === "finalized",
    } };
  } catch {
    return { ok: false, error: { code: "TEMPLATE_EDITOR_LOAD_FAILED", message: "The template could not be loaded." } };
  }
}
