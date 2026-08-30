import "server-only";

import { ValidationError } from "@/lib/errors/classes";

import {
  ESIGN_MERGE_FIELD_NAMES,
  type DropboxSignProvider,
  type EsignMergeFieldName,
  type ProviderSignature,
  type TemplateOption,
} from "./contracts";

export type ProviderSendContractInput = Readonly<{
  localRequestId: string;
  template: TemplateOption;
  signers: readonly Readonly<{
    role: string;
    order: number;
    name: string;
    emailAddress: string;
  }>[];
  mergeValues: Readonly<Record<EsignMergeFieldName, string>>;
  title?: string;
  subject?: string;
  message?: string;
}>;

export async function sendContractWithTemplate(
  provider: DropboxSignProvider,
  input: ProviderSendContractInput,
) {
  validateContractSendInput(input);

  const response = await provider.sendWithTemplate({
    localRequestId: input.localRequestId,
    templateId: input.template.providerTemplateId,
    signers: input.signers.map(({ role, name, emailAddress }) => ({
      role,
      name: name.trim(),
      emailAddress: emailAddress.trim(),
    })),
    mergeValues: { ...input.mergeValues },
    title: input.title,
    subject: input.subject,
    message: input.message,
  });

  if (!response.detailsUrl) {
    throw new ValidationError(
      "Dropbox Sign did not return a manager details URL.",
    );
  }
  validateProviderSignatures(input.signers, response.signatures);
  return response;
}

export function validateContractSendInput(
  input: ProviderSendContractInput,
): void {
  assertExactTemplateContract(input.template);
  assertExactSignerAssignments(input.template, input.signers);
  assertExactMergeValues(input.mergeValues);
}

export function validateProviderSignatures(
  expected: ProviderSendContractInput["signers"],
  actual: readonly ProviderSignature[],
): void {
  assertProviderSignatures(expected, actual);
}

function assertExactTemplateContract(template: TemplateOption): void {
  const roles = [...template.signerRoles].sort((a, b) => a.order - b.order);
  if (
    roles.length === 0 ||
    roles.some((role, index) => role.order !== index || !role.name.trim()) ||
    new Set(roles.map((role) => role.name)).size !== roles.length ||
    !roles.some((role) => role.name === template.sellerRoleName)
  ) {
    throw new ValidationError(
      "The template signer roles are no longer valid. Refresh and try again.",
    );
  }

  if (
    template.mergeFieldNames.length !== ESIGN_MERGE_FIELD_NAMES.length ||
    new Set(template.mergeFieldNames).size !==
      template.mergeFieldNames.length ||
    ESIGN_MERGE_FIELD_NAMES.some(
      (requiredName) => !template.mergeFieldNames.includes(requiredName),
    )
  ) {
    throw new ValidationError(
      "The template merge fields are no longer valid. Refresh and try again.",
    );
  }
}

function assertExactSignerAssignments(
  template: TemplateOption,
  signers: ProviderSendContractInput["signers"],
): void {
  const expected = [...template.signerRoles].sort((a, b) => a.order - b.order);
  const actual = [...signers].sort((a, b) => a.order - b.order);
  const matches =
    expected.length === actual.length &&
    expected.every(
      (role, index) =>
        actual[index]?.role === role.name &&
        actual[index]?.order === role.order &&
        actual[index]?.name.trim() &&
        isEmail(actual[index]?.emailAddress ?? ""),
    );
  if (!matches) {
    throw new ValidationError(
      "Assign exactly one signer to every template role.",
    );
  }
}

function assertExactMergeValues(
  mergeValues: ProviderSendContractInput["mergeValues"],
): void {
  const actual = Object.keys(mergeValues);
  if (
    actual.length !== ESIGN_MERGE_FIELD_NAMES.length ||
    ESIGN_MERGE_FIELD_NAMES.some(
      (name) => !actual.includes(name) || !mergeValues[name].trim(),
    )
  ) {
    throw new ValidationError(
      "Complete the five required contract fields before sending.",
    );
  }
}

function assertProviderSignatures(
  expected: ProviderSendContractInput["signers"],
  actual: readonly ProviderSignature[],
): void {
  const expectedSorted = [...expected].sort((a, b) => a.order - b.order);
  const actualSorted = [...actual].sort((a, b) => a.order - b.order);
  const matches =
    expectedSorted.length === actualSorted.length &&
    new Set(actualSorted.map((signature) => signature.signatureId)).size ===
      actualSorted.length &&
    expectedSorted.every((signer, index) => {
      const delivered = actualSorted[index];
      return (
        delivered?.role === signer.role &&
        delivered.order === signer.order &&
        delivered.name === signer.name.trim() &&
        delivered.emailAddress === signer.emailAddress.trim() &&
        Boolean(delivered.signatureId)
      );
    });
  if (!matches) {
    throw new ValidationError(
      "Dropbox Sign returned signer details that do not match this send.",
    );
  }
}

function isEmail(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.includes("@") && !trimmed.startsWith("@") && !trimmed.endsWith("@")
  );
}
