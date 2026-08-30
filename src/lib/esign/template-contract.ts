// Compatibility re-export for the Session 02 route. The canonical provider
// contract lives in contracts.ts so sending and template management cannot
// drift into parallel role or merge-field DTOs.
export {
  ESIGN_MERGE_FIELD_NAMES,
  ESIGN_TEMPLATE_MERGE_FIELDS,
  ESIGN_TEMPLATE_TITLE_MAX_LENGTH,
  requireTemplateTitle,
  validateTemplateTitle,
  type EsignMergeFieldName,
  type EsignTemplateMergeField,
  type TemplateOption,
  type TemplateSignerRole,
} from "./contracts";

import { ESIGN_TEMPLATE_TITLE_MAX_LENGTH, validateTemplateTitle } from "./contracts";

export function getTemplateTitleValidationError(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "Enter a template name.";
  if (value.trim().length > ESIGN_TEMPLATE_TITLE_MAX_LENGTH) {
    return `Template names must be ${ESIGN_TEMPLATE_TITLE_MAX_LENGTH} characters or fewer.`;
  }
  return validateTemplateTitle(value) ? null : "Enter a template name.";
}
