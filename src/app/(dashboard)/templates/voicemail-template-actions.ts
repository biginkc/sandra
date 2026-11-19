"use server";

import { revalidatePath } from "next/cache";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { voicemailScriptProblem } from "@/lib/sequences/voicemail-drop-step-config";
import { createClient } from "@/lib/supabase/server";

/**
 * Saved voicemail scripts (voicemail_templates). Kept apart from SMS
 * templates (sms_templates) so neither ever shows up in the other's pickers.
 * A drip voicemail step can rotate among the scripts in one group.
 */
export type VoicemailTemplateRow = {
  id: string;
  name: string;
  content: string;
  category: string;
  created_at: string;
  updated_at: string;
};

export type VoicemailTemplateGroup = {
  category: string;
  count: number;
  /** Scripts in the group the worker would refuse (too long, bad merge field, [a/b]). */
  problemCount: number;
};

type Input = { name?: string; content?: string; category?: string };

function invalid(message: string): Result<never> {
  return { ok: false, error: { code: "VALIDATION", message } };
}

function validate(input: Input, requireAll: boolean): Result<Input> {
  const out: Input = {};
  if (input.name !== undefined || requireAll) {
    const name = (input.name ?? "").trim();
    if (!name) return invalid("Name is required.");
    if (name.length > 120) return invalid(`Name is ${name.length} characters — cap is 120.`);
    out.name = name;
  }
  if (input.category !== undefined || requireAll) {
    const category = (input.category ?? "").trim();
    if (!category) return invalid("Group is required.");
    if (category.length > 120) return invalid(`Group is ${category.length} characters — cap is 120.`);
    out.category = category;
  }
  if (input.content !== undefined || requireAll) {
    const content = (input.content ?? "").trim();
    const problem = voicemailScriptProblem(content);
    if (problem) return invalid(problem);
    out.content = content;
  }
  return ok(out);
}

export async function listVoicemailTemplates(): Promise<Result<VoicemailTemplateRow[]>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("voicemail_templates")
      .select("id, name, content, category, created_at, updated_at")
      .is("deleted_at", null)
      .order("category")
      .order("name");
    if (error) return { ok: false, error: { code: "VM_TPL_LIST_FAILED", message: error.message } };
    return ok(data ?? []);
  } catch (e) {
    reportError(e, { tags: { surface: "list_voicemail_templates" } });
    return errFromUnknown(e, "VM_TPL_LIST_FAILED");
  }
}

/** Groups for the drip editor's "Rotate between saved voicemail scripts". */
export async function listVoicemailTemplateGroups(): Promise<Result<VoicemailTemplateGroup[]>> {
  const rows = await listVoicemailTemplates();
  if (!rows.ok) return rows;
  return ok(groupVoicemailTemplates(rows.data));
}

function groupVoicemailTemplates(rows: readonly Pick<VoicemailTemplateRow, "category" | "content">[]): VoicemailTemplateGroup[] {
  const groups = new Map<string, VoicemailTemplateGroup>();
  for (const row of rows) {
    const group = groups.get(row.category) ?? { category: row.category, count: 0, problemCount: 0 };
    group.count += 1;
    if (voicemailScriptProblem(row.content)) group.problemCount += 1;
    groups.set(row.category, group);
  }
  return [...groups.values()].sort((a, b) => a.category.localeCompare(b.category));
}

export async function createVoicemailTemplate(input: {
  name: string;
  content: string;
  category: string;
}): Promise<Result<{ id: string }>> {
  const valid = validate(input, true);
  if (!valid.ok) return valid;
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const { data: org } = await supabase.from("organizations").select("id").limit(1).maybeSingle();
    if (!org) return { ok: false, error: { code: "NO_ORG", message: "No organization found." } };
    const { data, error } = await supabase
      .from("voicemail_templates")
      .insert({
        org_id: org.id,
        name: valid.data.name!,
        content: valid.data.content!,
        category: valid.data.category!,
        created_by: user?.id ?? null,
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: { code: "VM_TPL_CREATE_FAILED", message: error.message } };
    revalidatePath("/templates");
    return ok({ id: data.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_voicemail_template" } });
    return errFromUnknown(e, "VM_TPL_CREATE_FAILED");
  }
}

export async function updateVoicemailTemplate(
  templateId: string,
  patch: Input,
): Promise<Result<null>> {
  const valid = validate(patch, false);
  if (!valid.ok) return valid;
  try {
    const supabase = await createClient();
    if (valid.data.category !== undefined) {
      const blocked = await wouldEmptyUsedGroup(supabase, templateId, valid.data.category);
      if (blocked) return blocked;
    }
    const { error, count } = await supabase
      .from("voicemail_templates")
      .update(valid.data, { count: "exact" })
      .eq("id", templateId)
      .is("deleted_at", null);
    if (error) return { ok: false, error: { code: "VM_TPL_UPDATE_FAILED", message: error.message } };
    if ((count ?? 0) === 0) {
      return { ok: false, error: { code: "VM_TPL_NOT_FOUND", message: "Voicemail script not found or already deleted." } };
    }
    revalidatePath("/templates");
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "update_voicemail_template" }, extra: { templateId } });
    return errFromUnknown(e, "VM_TPL_UPDATE_FAILED");
  }
}

export async function deleteVoicemailTemplate(templateId: string): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const blocked = await wouldEmptyUsedGroup(supabase, templateId, null);
    if (blocked) return blocked;
    const { error, count } = await supabase
      .from("voicemail_templates")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", templateId)
      .is("deleted_at", null);
    if (error) return { ok: false, error: { code: "VM_TPL_DELETE_FAILED", message: error.message } };
    if ((count ?? 0) === 0) {
      return { ok: false, error: { code: "VM_TPL_NOT_FOUND", message: "Voicemail script not found or already deleted." } };
    }
    revalidatePath("/templates");
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "delete_voicemail_template" }, extra: { templateId } });
    return errFromUnknown(e, "VM_TPL_DELETE_FAILED");
  }
}

/**
 * Refuse a delete or regroup that would leave a group a drip step rotates
 * through with no scripts (the worker would pause those enrollments).
 */
async function wouldEmptyUsedGroup(
  supabase: Awaited<ReturnType<typeof createClient>>,
  templateId: string,
  nextCategory: string | null,
): Promise<Result<never> | null> {
  const { data: tpl, error } = await supabase
    .from("voicemail_templates")
    .select("category")
    .eq("id", templateId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, error: { code: "VM_TPL_CHECK_FAILED", message: error.message } };
  if (!tpl || tpl.category === nextCategory) return null;
  const [{ count: siblings, error: sibErr }, { count: steps, error: stepErr }] = await Promise.all([
    supabase.from("voicemail_templates").select("id", { count: "exact", head: true })
      .eq("category", tpl.category).is("deleted_at", null),
    supabase.from("sequence_steps").select("id", { count: "exact", head: true })
      .eq("vm_template_category", tpl.category),
  ]);
  if (sibErr || stepErr) {
    return { ok: false, error: { code: "VM_TPL_CHECK_FAILED", message: (sibErr ?? stepErr)!.message } };
  }
  if ((siblings ?? 0) <= 1 && (steps ?? 0) > 0) {
    return {
      ok: false,
      error: {
        code: "VM_TPL_IN_USE",
        message: `This is the last script in "${tpl.category}", and ${steps} drip step${steps === 1 ? "" : "s"} rotate through it. Add another script to the group or change those steps first.`,
      },
    };
  }
  return null;
}
