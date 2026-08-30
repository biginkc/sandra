import "server-only";

import type {
  TemplateEditorData,
  TemplateLaneResult,
  TemplateLibraryLoadResult,
} from "./types";

const FOUNDATION_PENDING = {
  code: "ESIGN_FOUNDATION_PENDING",
  message:
    "The template library is waiting for the reviewed Dropbox Sign foundation.",
} as const;

/**
 * Fail-closed seams replaced by foundation-backed queries after the reviewed
 * Session 01 checkpoint lands. They deliberately never return sample data or
 * fake a successful provider operation.
 */
export async function loadTemplateLibrary(): Promise<TemplateLibraryLoadResult> {
  return { ok: false, error: FOUNDATION_PENDING };
}

export async function loadTemplateEditor(
  _templateId: string,
): Promise<TemplateLaneResult<TemplateEditorData>> {
  void _templateId;
  return { ok: false, error: FOUNDATION_PENDING };
}
