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
