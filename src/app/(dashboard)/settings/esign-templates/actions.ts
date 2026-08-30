"use server";

import { revalidatePath } from "next/cache";

import { reportError } from "@/lib/errors/report";
import { createFoundationTemplateOrchestrator } from "@/lib/esign/template-foundation-adapter";
import { getCallerMemberships } from "@/lib/auth/memberships";

import type { CreateTemplateDraftInput, TemplateLaneResult } from "./types";
import type { TemplateOption } from "@/lib/esign/contracts";

const SAFE_FAILURE = {
  code: "ESIGN_TEMPLATE_ACTION_FAILED",
  message: "The eSign template action could not be completed.",
} as const;

async function run<T>(surface: string, operation: (orchestrator: Awaited<ReturnType<typeof createFoundationTemplateOrchestrator>>) => Promise<TemplateLaneResult<T>>): Promise<TemplateLaneResult<T>> {
  try {
    const membership = (await getCallerMemberships())[0];
    if (!membership) return { ok: false, error: { code: "AUTH_REQUIRED", message: "Sign in to manage eSign templates." } };
    if (membership.role !== "owner") return { ok: false, error: { code: "OWNER_REQUIRED", message: "Only an organization owner can manage eSign templates." } };
    return await operation(await createFoundationTemplateOrchestrator());
  } catch (error) {
    reportError(error, { tags: { surface } });
    return { ok: false, error: SAFE_FAILURE };
  }
}

export async function createTemplateDraftAction(input: CreateTemplateDraftInput): Promise<TemplateLaneResult<{ templateId: string }>> {
  return run("esign_template_create", async (orchestrator) => {
    const bytes = new Uint8Array(await input.source.file.arrayBuffer());
    const staged = await orchestrator.stageSource([{
      filename: input.source.file.name,
      mimeType: input.source.file.type || "application/pdf",
      size: input.source.file.size,
      bytes,
    }]);
    if (!staged.ok) return staged;
    const result = await orchestrator.add({
      stagingSourceId: staged.data.stagingSourceId,
      name: input.name,
      documentType: input.documentType,
      signerRoles: input.signerRoles,
      sellerRoleName: input.sellerRoleName,
      mergeFieldNames: input.mergeFieldNames,
    });
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  });
}

export async function startTemplateEditorAction(templateId: string) {
  return run("esign_template_start_editor", (orchestrator) => orchestrator.startEditor(templateId));
}

export async function syncFinishedTemplateAction(templateId: string, _input: { name: string }): Promise<TemplateLaneResult<TemplateOption>> {
  void _input;
  return run("esign_template_finish", async (orchestrator) => {
    const result = await orchestrator.finishSync(templateId);
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  });
}

export async function abandonTemplateDraftAction(templateId: string): Promise<TemplateLaneResult<null>> {
  return run("esign_template_abandon", async (orchestrator) => {
    const result = await orchestrator.abandon(templateId);
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  });
}

export async function duplicateTemplateAction(templateId: string, name: string): Promise<TemplateLaneResult<{ templateId: string }>> {
  return run("esign_template_duplicate", async (orchestrator) => {
    const result = await orchestrator.duplicate(templateId, name);
    if (!result.ok) return result;
    revalidatePath("/settings/esign-templates");
    return { ok: true, data: { templateId: result.data.templateId } };
  });
}

export async function deleteTemplateAction(templateId: string, confirmRecentSends = false): Promise<TemplateLaneResult<null>> {
  return run("esign_template_delete", async (orchestrator) => {
    const result = await orchestrator.delete(templateId, confirmRecentSends);
    if (!result.ok) return result;
    revalidatePath("/settings/esign-templates");
    return { ok: true, data: null };
  });
}
