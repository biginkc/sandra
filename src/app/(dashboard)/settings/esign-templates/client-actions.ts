"use client";

import { callAction } from "@/lib/errors/call-action";

import {
  abandonTemplateDraftAction,
  checkTemplateEditorReadinessAction,
  createTemplateDraftAction,
  deleteTemplateAction,
  duplicateTemplateAction,
  retryTemplateSourceCleanupAction,
} from "./actions";
import { chooseDropboxPdf, type DropboxChooserSdk } from "./dropbox-chooser";
import type { TemplateLibraryActions, TemplateLaneResult } from "./types";
import type { Result } from "@/lib/errors/result";

declare global {
  interface Window {
    Dropbox?: DropboxChooserSdk;
  }
}

let chooserLoad: Promise<DropboxChooserSdk> | null = null;

export const templateLibraryActions: TemplateLibraryActions = {
  createDraft(input) {
    return safeTemplateCallAction(createTemplateDraftAction(input), {
      fallbackMessage: "The template could not be prepared.",
      unexpectedErrorDescription: "Try again. No template success was recorded.",
    });
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
  deleteTemplate(templateId, confirmRecentSends = false) {
    return safeTemplateCallAction(deleteTemplateAction(templateId, confirmRecentSends), {
      fallbackMessage: "The template could not be deleted.",
    });
  },
};

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
