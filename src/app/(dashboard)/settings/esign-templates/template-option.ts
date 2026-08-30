import {
  ESIGN_MERGE_FIELD_NAMES,
  requireTemplateTitle,
  type TemplateOption,
  type TemplateSignerRole,
} from "@/lib/esign/template-contract";

export type ProviderTemplateSnapshot = Readonly<{
  providerTemplateId: string;
  signerRoles: readonly TemplateSignerRole[];
  mergeFieldNames: readonly string[];
}>;

export function toTemplateOption(input: {
  id: string;
  name: string;
  documentType: string;
  expectedProviderTemplateId: string;
  sellerRoleName: string;
  provider: ProviderTemplateSnapshot;
}): TemplateOption {
  if (input.provider.providerTemplateId !== input.expectedProviderTemplateId) {
    throw new Error("Dropbox Sign returned a different template identifier.");
  }

  const roles = [...input.provider.signerRoles].sort(
    (left, right) => left.order - right.order,
  );
  if (
    roles.length === 0 ||
    roles.some(
      (role, index) => !role.name.trim() || role.order !== index,
    ) ||
    new Set(roles.map((role) => role.name)).size !== roles.length
  ) {
    throw new Error("Dropbox Sign returned invalid signer roles.");
  }
  if (!roles.some((role) => role.name === input.sellerRoleName)) {
    throw new Error("Choose the seller role from the final Dropbox Sign roles.");
  }

  const uniqueFields = [...new Set(input.provider.mergeFieldNames)];
  if (
    uniqueFields.length !== ESIGN_MERGE_FIELD_NAMES.length ||
    ESIGN_MERGE_FIELD_NAMES.some((name) => !uniqueFields.includes(name))
  ) {
    throw new Error(
      "The template must contain exactly Sandra's five merge field labels.",
    );
  }

  return {
    id: input.id,
    name: requireTemplateTitle(input.name),
    documentType: input.documentType,
    providerTemplateId: input.provider.providerTemplateId,
    sellerRoleName: input.sellerRoleName,
    signerRoles: roles,
    mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
  };
}
