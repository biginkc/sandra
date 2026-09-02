"use client";

import { callAction } from "@/lib/errors/call-action";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";

import {
  abandonTemplateDraftAction,
  beginTemplateEditRevisionAction,
  checkTemplateEditorReadinessAction,
  createTemplateDraftAction,
  prepareTemplateUploadAction,
  promoteStaleInitialTemplateProviderCreateAction,
  deleteTemplateAction,
  duplicateTemplateAction,
  registerWebsiteTemplateAction,
  revalidateWebsiteTemplateAction,
  retryTemplateSourceCleanupAction,
  retryUnattachedTemplateSourceCleanupAction,
  retryInitialTemplateProviderCreateAction,
} from "./actions";
import { chooseDropboxPdf, type DropboxChooserSdk } from "./dropbox-chooser";
import { AmbiguousTusTerminationError, uploadStagedPdf } from "./staged-pdf-upload";
import type { TemplateLibraryActions, TemplateLaneResult } from "./types";
import type { Result } from "@/lib/errors/result";

declare global {
  interface Window {
    Dropbox?: DropboxChooserSdk;
  }
}

let chooserLoad: Promise<DropboxChooserSdk> | null = null;

export const templateLibraryActions: TemplateLibraryActions = {
  registerWebsiteTemplate(input) {
    return safeTemplateCallAction(registerWebsiteTemplateAction(input), {
      fallbackMessage: "The Dropbox Sign template could not be registered.",
    });
  },
  revalidateWebsiteTemplate(templateId, providerTemplateId) {
    return safeTemplateCallAction(
      revalidateWebsiteTemplateAction(templateId, providerTemplateId),
      {
        fallbackMessage: "The Dropbox Sign template could not be revalidated.",
      },
    );
  },
  createDraft(input, options) {
    return uploadAndCreateDraft(input, options);
  },
  async pickDropboxPdf() {
    try {
      return await chooseDropboxPdf({ sdk: await loadDropboxChooser() });
    } catch {
      return {
        ok: false,
        error: {
          code: "DROPBOX_CHOOSER_UNAVAILABLE",
          message: "Dropbox Chooser could not be loaded.",
        },
      } satisfies TemplateLaneResult<File | null>;
    }
  },
  duplicateTemplate(templateId, name) {
    return safeTemplateCallAction(duplicateTemplateAction(templateId, name), {
      fallbackMessage: "The template could not be duplicated.",
    });
  },
  beginEditRevision(templateId) {
    return safeTemplateCallAction(beginTemplateEditRevisionAction(templateId), {
      fallbackMessage: "The template edit revision could not be prepared.",
    });
  },
  checkEditorReadiness(templateId) {
    return safeTemplateCallAction(checkTemplateEditorReadinessAction(templateId), {
      fallbackMessage: "The template copy readiness could not be checked.",
    });
  },
  abandonDraft(templateId) {
    return safeTemplateCallAction(abandonTemplateDraftAction(templateId), {
      fallbackMessage: "The pending template copy could not be canceled.",
    });
  },
  retryCleanup(templateId) {
    return safeTemplateCallAction(retryTemplateSourceCleanupAction(templateId), {
      fallbackMessage: "The private source cleanup could not be retried.",
    });
  },
  retrySourceCleanup(sourceId) {
    return safeTemplateCallAction(retryUnattachedTemplateSourceCleanupAction(sourceId), {
      fallbackMessage: "The private upload cleanup could not be retried.",
    });
  },
  retryProviderCreate(templateId) {
    return safeTemplateCallAction(retryInitialTemplateProviderCreateAction(templateId), {
      fallbackMessage: "The provider setup could not be retried.",
    });
  },
  promoteStaleProviderCreate(templateId) {
    return safeTemplateCallAction(
      promoteStaleInitialTemplateProviderCreateAction(templateId),
      { fallbackMessage: "Provider recovery could not be checked." },
    );
  },
  deleteTemplate(templateId, confirmRecentSends = false) {
    return safeTemplateCallAction(deleteTemplateAction(templateId, confirmRecentSends), {
      fallbackMessage: "The template could not be deleted.",
    });
  },
};

async function uploadAndCreateDraft(
  input: Parameters<TemplateLibraryActions["createDraft"]>[0],
  options?: Parameters<TemplateLibraryActions["createDraft"]>[1],
) {
  const file = input.source.file;
  let sha256: string;
  try { sha256 = await sha256File(file); }
  catch { return { ok: false, error: { code: "PDF_HASH_FAILED", message: "The PDF could not be verified before upload." } } satisfies TemplateLaneResult<never>; }
  const prepared = await safeTemplateCallAction(prepareTemplateUploadAction({
    stagingSourceId: options?.stagingSourceId ?? crypto.randomUUID(),
    filename: file.name,
    size: file.size,
    mimeType: "application/pdf",
    sha256,
  }), {
    fallbackMessage: "The private upload could not be prepared.",
  });
  if (!prepared.ok) return prepared;
  try {
    const supabase = createBrowserSupabase();
    await uploadStagedPdf(supabase, prepared.data, file, sha256, options?.signal);
  } catch (error) {
    if (error instanceof AmbiguousTusTerminationError) {
      return {
        ok: false,
        error: {
          code: "STAGING_UPLOAD_AMBIGUOUS",
          message: "The resumable upload may still be stopping. The private source remains available for recovery.",
        },
      } satisfies TemplateLaneResult<never>;
    }
    return {
      ok: false,
      error: {
        code: "STAGING_UPLOAD_REQUIRES_RECOVERY",
        message: "The private upload did not complete. Its reservation remains available for safe cleanup.",
      },
    } satisfies TemplateLaneResult<never>;
  }
  return safeTemplateCallAction(createTemplateDraftAction({
    ...input,
    source: {
      ...prepared.data,
      origin: input.source.origin,
      filename: file.name,
      size: file.size,
      mimeType: "application/pdf",
      sha256,
    },
  }), {
    fallbackMessage: "The template could not be prepared.",
    unexpectedErrorDescription: "Try again. No template success was recorded.",
  });
}

async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function safeTemplateCallAction<T>(
  promise: Promise<Result<T>>,
  options: Parameters<typeof callAction>[1],
): Promise<Result<T>> {
  const result = await callAction(promise, options);
  if (!result.ok && result.error.code === "UNEXPECTED_ERROR") {
    return {
      ok: false,
      error: {
        code: "ESIGN_TEMPLATE_REQUEST_FAILED",
        message: "The eSign template request did not complete. Try again.",
      },
    };
  }
  return result;
}

function loadDropboxChooser(): Promise<DropboxChooserSdk> {
  if (typeof window === "undefined") return Promise.reject(new Error("chooser requires a browser"));
  if (window.Dropbox) return Promise.resolve(window.Dropbox);
  if (chooserLoad) return chooserLoad;
  chooserLoad = new Promise((resolve, reject) => {
    const appKey = process.env.NEXT_PUBLIC_DROPBOX_CHOOSER_APP_KEY?.trim();
    if (!appKey) {
      reject(new Error("chooser app key missing"));
      return;
    }
    const script = document.createElement("script");
    script.id = "dropboxjs";
    script.src = "https://www.dropbox.com/static/api/2/dropins.js";
    script.dataset.appKey = appKey;
    script.onload = () => window.Dropbox ? resolve(window.Dropbox) : reject(new Error("chooser SDK missing"));
    script.onerror = () => reject(new Error("chooser SDK failed"));
    document.head.appendChild(script);
  });
  return chooserLoad;
}
