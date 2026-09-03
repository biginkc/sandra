"use server";

import { revalidatePath } from "next/cache";

import { reportError } from "@/lib/errors/report";
import {
  DatabaseError,
  ProviderError,
  ValidationError,
} from "@/lib/errors/classes";
import { createFoundationTemplateOrchestrator } from "@/lib/esign/template-foundation-adapter";
import { createInitialTemplateRuntime } from "@/lib/esign/template-initial-runtime";
import { getSingleActiveMembership } from "@/lib/auth/memberships";
import {
  registerDropboxWebsiteTemplate,
  revalidateDropboxWebsiteTemplate,
} from "@/lib/esign/website-template-registration";

import type {
  CreatedTemplateDraft,
  CreateTemplateDraftActionInput,
  PreparedTemplateUpload,
  PrepareTemplateUploadInput,
  RetriedTemplateDraft,
  RestartedTemplateDraft,
  TemplateLaneResult,
} from "./types";
import type { TemplateOption } from "@/lib/esign/contracts";

const SAFE_FAILURE = {
  code: "ESIGN_TEMPLATE_ACTION_FAILED",
  message: "The eSign template action could not be completed.",
} as const;

const KNOWN_WEBSITE_TEMPLATE_ERRORS: Record<string, string> = {
  template_id_mismatch:
    "Dropbox Sign returned a different template ID. Copy the template ID again from Dropbox Sign.",
  embedded_template_not_supported:
    "Register a non-embedded template created on the Dropbox Sign website.",
  template_not_usable:
    "Unlock the Dropbox Sign template before registering it.",
  template_document_mismatch:
    "The Dropbox Sign template must include at least one document.",
  template_account_mismatch:
    "The template must be available to the connected Dropbox Sign account.",
  signer_role_mismatch:
    "Dropbox Sign signer roles must be exactly Seller then Buyer.",
  merge_field_mismatch:
    "Dropbox Sign Sender merge fields must be exactly seller_name, property_address, offer_price, closing_date, and earnest_money.",
  template_field_mismatch:
    "Dropbox Sign must include required signature fields for Seller and Buyer.",
};

function safeWebsiteTemplateActionFailure(error: unknown) {
  if (error instanceof ValidationError) {
    return { code: "VALIDATION", message: error.message };
  }
  if (error instanceof ProviderError) {
    const providerCode =
      typeof error.details?.providerCode === "string"
        ? error.details.providerCode
        : null;
    const statusCode =
      typeof error.details?.statusCode === "number"
        ? error.details.statusCode
        : null;
    if (providerCode && KNOWN_WEBSITE_TEMPLATE_ERRORS[providerCode]) {
      return {
        code: providerCode.toUpperCase(),
        message: KNOWN_WEBSITE_TEMPLATE_ERRORS[providerCode],
      };
    }
    if (statusCode === 429 || (statusCode !== null && statusCode >= 500)) {
      return {
        code: "PROVIDER_TEMPORARILY_UNAVAILABLE",
        message: "Dropbox Sign could not validate the template right now. Try again.",
      };
    }
  }
  if (error instanceof Error && error.message === "DROPBOX_SIGN_NOT_CONNECTED") {
    return {
      code: "DROPBOX_SIGN_NOT_CONNECTED",
      message: "Connect Dropbox Sign before registering website templates.",
    };
  }
  if (error instanceof DatabaseError) return SAFE_FAILURE;
  return SAFE_FAILURE;
}

async function run<T>(
  surface: string,
  operation: (
    orchestrator: Awaited<
      ReturnType<typeof createFoundationTemplateOrchestrator>
    >,
  ) => Promise<TemplateLaneResult<T>>,
): Promise<TemplateLaneResult<T>> {
  try {
    const resolvedMembership = await getSingleActiveMembership();
    if (!resolvedMembership.ok)
      return {
        ok: false,
        error: {
          code: "AUTH_REQUIRED",
          message: "Sign in to manage eSign templates.",
        },
      };
    if (resolvedMembership.membership.role !== "owner")
      return {
        ok: false,
        error: {
          code: "OWNER_REQUIRED",
          message: "Only an organization owner can manage eSign templates.",
        },
      };
    return await operation(await createFoundationTemplateOrchestrator());
  } catch (error) {
    reportError(error, { tags: { surface } });
    return { ok: false, error: SAFE_FAILURE };
  }
}

export async function prepareTemplateUploadAction(
  input: PrepareTemplateUploadInput,
): Promise<TemplateLaneResult<PreparedTemplateUpload>> {
  try {
    const resolvedMembership = await getSingleActiveMembership();
    if (!resolvedMembership.ok)
      return {
        ok: false,
        error: {
          code: "AUTH_REQUIRED",
          message: "Sign in to manage eSign templates.",
        },
      };
    if (resolvedMembership.membership.role !== "owner")
      return {
        ok: false,
        error: {
          code: "OWNER_REQUIRED",
          message: "Only an organization owner can manage eSign templates.",
        },
      };
    return await (await createInitialTemplateRuntime()).prepare(input);
  } catch (error) {
    reportError(error, { tags: { surface: "esign_template_prepare_upload" } });
    return { ok: false, error: SAFE_FAILURE };
  }
}

export async function registerWebsiteTemplateAction(input: {
  providerTemplateId: string;
  name: string;
  documentType: string;
}): Promise<TemplateLaneResult<TemplateOption>> {
  try {
    const resolvedMembership = await getSingleActiveMembership();
    if (!resolvedMembership.ok)
      return {
        ok: false,
        error: {
          code: "AUTH_REQUIRED",
          message: "Sign in to manage eSign templates.",
        },
      };
    if (resolvedMembership.membership.role !== "owner")
      return {
        ok: false,
        error: {
          code: "OWNER_REQUIRED",
          message: "Only an organization owner can manage eSign templates.",
        },
      };
    const result = await registerDropboxWebsiteTemplate({
      orgId: resolvedMembership.membership.org_id,
      actorId: resolvedMembership.membership.user_id,
      providerTemplateId: input.providerTemplateId,
      name: input.name,
      documentType: input.documentType,
    });
    revalidatePath("/settings/esign-templates");
    return { ok: true, data: result };
  } catch (error) {
    reportError(error, { tags: { surface: "esign_template_register_website" } });
    return { ok: false, error: safeWebsiteTemplateActionFailure(error) };
  }
}

export async function revalidateWebsiteTemplateAction(
  templateId: string,
  providerTemplateId: string,
): Promise<TemplateLaneResult<{ status: "valid" | "unavailable" }>> {
  try {
    const resolvedMembership = await getSingleActiveMembership();
    if (!resolvedMembership.ok)
      return {
        ok: false,
        error: {
          code: "AUTH_REQUIRED",
          message: "Sign in to manage eSign templates.",
        },
      };
    if (resolvedMembership.membership.role !== "owner")
      return {
        ok: false,
        error: {
          code: "OWNER_REQUIRED",
          message: "Only an organization owner can manage eSign templates.",
        },
      };
    const status = await revalidateDropboxWebsiteTemplate({
      orgId: resolvedMembership.membership.org_id,
      actorId: resolvedMembership.membership.user_id,
      templateId,
      providerTemplateId,
    });
    revalidatePath("/settings/esign-templates");
    return { ok: true, data: { status } };
  } catch (error) {
    reportError(error, { tags: { surface: "esign_template_revalidate_website" } });
    return { ok: false, error: safeWebsiteTemplateActionFailure(error) };
  }
}

export async function createTemplateDraftAction(
  input: CreateTemplateDraftActionInput,
): Promise<TemplateLaneResult<CreatedTemplateDraft>> {
  try {
    const result = await (
      await createInitialTemplateRuntime()
    ).create({
      source: input.source,
      name: input.name,
      documentType: input.documentType,
      signerRoles: input.signerRoles,
      sellerRoleName: input.sellerRoleName,
    });
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  } catch (error) {
    reportError(error, { tags: { surface: "esign_template_create" } });
    return { ok: false, error: SAFE_FAILURE };
  }
}

export async function startTemplateEditorAction(templateId: string) {
  return run("esign_template_start_editor", (orchestrator) =>
    orchestrator.startEditor(templateId),
  );
}

export async function restartTemplatePlacementAction(
  templateId: string,
): Promise<TemplateLaneResult<RestartedTemplateDraft>> {
  try {
    const runtime = await createInitialTemplateRuntime();
    const orchestrator = await createFoundationTemplateOrchestrator();
    const replacement = await runtime.createReplacementFromRetainedSource(
      templateId,
      async () => {
        const retired = await orchestrator.abandon(templateId);
        if (retired.ok) {
          return { ok: true, data: { cleanupAttention: false } };
        }
        if (retired.error.code.startsWith("SOURCE_CLEANUP_")) {
          return { ok: true, data: { cleanupAttention: true } };
        }
        return retired;
      },
    );
    if (!replacement.ok) return replacement;
    if (!replacement.data.initialEditorSession) {
      return {
        ok: false,
        error: {
          code: "PLACEMENT_RESTART_IN_PROGRESS",
          message:
            "Another restart already created this replacement. Return to the template library to continue or clean it up.",
        },
      };
    }

    revalidatePath("/settings/esign-templates");
    return {
      ok: true,
      data: {
        templateId: replacement.data.templateId,
        initialEditorSession: replacement.data.initialEditorSession,
        cleanupAttention: replacement.data.cleanupAttention,
      },
    };
  } catch (error) {
    reportError(error, { tags: { surface: "esign_template_restart_placement" } });
    return { ok: false, error: SAFE_FAILURE };
  }
}

export async function beginTemplateEditRevisionAction(
  templateId: string,
): Promise<
  TemplateLaneResult<{ templateId: string; readiness: "ready" | "pending" }>
> {
  return run("esign_template_begin_edit_revision", async (orchestrator) => {
    const result = await orchestrator.beginEditRevision(templateId);
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  });
}

export async function checkTemplateEditorReadinessAction(
  templateId: string,
): Promise<TemplateLaneResult<{ readiness: "ready" | "pending" }>> {
  return run("esign_template_editor_readiness", (orchestrator) =>
    orchestrator.checkEditorReadiness(templateId),
  );
}

export async function syncFinishedTemplateAction(
  templateId: string,
  _input: { name: string },
): Promise<TemplateLaneResult<TemplateOption>> {
  void _input;
  return run("esign_template_finish", async (orchestrator) => {
    const result = await orchestrator.finishSync(templateId);
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  });
}

export async function abandonTemplateDraftAction(
  templateId: string,
): Promise<TemplateLaneResult<null>> {
  return run("esign_template_abandon", async (orchestrator) => {
    const result = await orchestrator.abandon(templateId);
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  });
}

export async function retryTemplateSourceCleanupAction(
  templateId: string,
): Promise<TemplateLaneResult<null>> {
  return run("esign_template_retry_cleanup", async (orchestrator) => {
    const result = await orchestrator.retryCleanup(templateId);
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  });
}

export async function retryUnattachedTemplateSourceCleanupAction(
  sourceId: string,
): Promise<TemplateLaneResult<null>> {
  try {
    const result = await (
      await createInitialTemplateRuntime()
    ).cleanupSource(sourceId);
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  } catch (error) {
    reportError(error, {
      tags: { surface: "esign_template_unattached_cleanup" },
    });
    return { ok: false, error: SAFE_FAILURE };
  }
}

export async function reconcileUnknownTemplateProviderAction(
  templateId: string,
  providerTemplateId: string,
): Promise<TemplateLaneResult<{ templateId: string }>> {
  try {
    const result = await (
      await createInitialTemplateRuntime()
    ).reconcileUnknown(templateId, providerTemplateId);
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  } catch (error) {
    reportError(error, {
      tags: { surface: "esign_template_provider_reconcile" },
    });
    return { ok: false, error: SAFE_FAILURE };
  }
}

export async function promoteStaleInitialTemplateProviderCreateAction(
  templateId: string,
): Promise<
  TemplateLaneResult<{
    templateId: string;
    providerCreateState: "unknown" | "attached";
  }>
> {
  try {
    const result = await (
      await createInitialTemplateRuntime()
    ).promoteStaleProviderCreate(templateId);
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  } catch (error) {
    reportError(error, {
      tags: { surface: "esign_template_provider_promote_stale" },
    });
    return { ok: false, error: SAFE_FAILURE };
  }
}

export async function retryInitialTemplateProviderCreateAction(
  templateId: string,
): Promise<TemplateLaneResult<RetriedTemplateDraft>> {
  try {
    const result = await (await createInitialTemplateRuntime()).retryProviderCreate(templateId);
    if (result.ok) revalidatePath("/settings/esign-templates");
    return result;
  } catch (error) {
    reportError(error, { tags: { surface: "esign_template_provider_retry" } });
    return { ok: false, error: SAFE_FAILURE };
  }
}

export async function duplicateTemplateAction(
  templateId: string,
  name: string,
): Promise<
  TemplateLaneResult<{ templateId: string; readiness: "ready" | "pending" }>
> {
  return run("esign_template_duplicate", async (orchestrator) => {
    const result = await orchestrator.duplicate(templateId, name);
    if (!result.ok) return result;
    revalidatePath("/settings/esign-templates");
    return { ok: true, data: result.data };
  });
}

export async function deleteTemplateAction(
  templateId: string,
  confirmRecentSends = false,
): Promise<TemplateLaneResult<null>> {
  return run("esign_template_delete", async (orchestrator) => {
    const result = await orchestrator.delete(templateId, confirmRecentSends);
    if (!result.ok) return result;
    revalidatePath("/settings/esign-templates");
    return { ok: true, data: null };
  });
}
