export const ESIGN_TEMPLATE_MERGE_FIELDS = [
  "seller_name",
  "property_address",
  "offer_price",
  "closing_date",
  "earnest_money",
] as const;

// Foundation and Session 03 currently use this alias. Both names point to the
// same frozen tuple so integration cannot drift into parallel field contracts.
export const ESIGN_MERGE_FIELD_NAMES = ESIGN_TEMPLATE_MERGE_FIELDS;

export const ESIGN_TEMPLATE_TITLE_MAX_LENGTH = 160;

export type EsignTemplateMergeField =
  (typeof ESIGN_TEMPLATE_MERGE_FIELDS)[number];
export type EsignMergeFieldName = EsignTemplateMergeField;

export type TemplateSignerRole = Readonly<{
  name: string;
  order: number;
}>;

export type TemplateOption = Readonly<{
  id: string;
  name: string;
  documentType: string;
  providerTemplateId: string;
  sellerRoleName: string;
  signerRoles: readonly TemplateSignerRole[];
  mergeFieldNames: typeof ESIGN_TEMPLATE_MERGE_FIELDS;
}>;

export function validateTemplateTitle(value: string): string | null {
  const title = value.trim();
  if (!title) return "Enter a template name.";
  if (title.length > ESIGN_TEMPLATE_TITLE_MAX_LENGTH) {
    return `Template names must be ${ESIGN_TEMPLATE_TITLE_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

export function requireTemplateTitle(value: string): string {
  const error = validateTemplateTitle(value);
  if (error) throw new Error(error);
  return value.trim();
}
