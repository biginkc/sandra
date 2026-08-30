import type { Result } from "@/lib/errors/result";
import type {
  EsignDeliveryState,
  EsignMergeFieldName,
  EsignStatus,
  TemplateOption,
} from "@/lib/esign/contracts";

export const SEND_BLOCKER_PRIORITY = [
  "provider_disconnected",
  "sending_disabled",
  "no_templates",
  "owner_email_missing",
] as const;

export type SendBlockerCode = (typeof SEND_BLOCKER_PRIORITY)[number];

const SEND_BLOCKER_MESSAGES: Record<SendBlockerCode, string> = {
  provider_disconnected: "Send disabled: Dropbox Sign is not connected.",
  sending_disabled: "Send disabled: sending from leads is turned off.",
  no_templates: "Send disabled: no eSign templates are available.",
  owner_email_missing: "Send disabled: the seller has no email address.",
};

export function sendBlockerMessage(code: SendBlockerCode): string {
  return SEND_BLOCKER_MESSAGES[code];
}

export function primarySendBlocker(
  blockers: readonly SendBlockerCode[],
): SendBlockerCode | null {
  return (
    SEND_BLOCKER_PRIORITY.find((candidate) => blockers.includes(candidate)) ??
    null
  );
}

export type ContractMergeValues = Readonly<Record<EsignMergeFieldName, string>>;

export type SignerAssignment = Readonly<{
  role: string;
  order: number;
  name: string;
  emailAddress: string;
}>;

export type LeadEsignPreflight = Readonly<{
  propertyId: string;
  testMode: true;
  blockers: readonly SendBlockerCode[];
  templates: readonly TemplateOption[];
  sellerDefaults: Readonly<{
    name: string;
    emailAddress: string;
  }>;
  mergeDefaults: ContractMergeValues;
}>;

export type SendContractInput = Readonly<{
  propertyId: string;
  templateId: string;
  sendIntentId: string;
  signers: readonly SignerAssignment[];
  mergeValues: ContractMergeValues;
}>;

export type SendContractOutput = Readonly<{
  requestId: string;
}>;

export type LoadLeadEsignPreflightAction = (
  propertyId: string,
) => Promise<Result<LeadEsignPreflight>>;

export type SendContractAction = (
  input: SendContractInput,
) => Promise<Result<SendContractOutput>>;

export type ContractSignerView = Readonly<{
  id: string;
  role: string;
  order: number;
  name: string;
  emailAddress: string;
  status: "awaiting" | "viewed" | "signed" | "declined" | "error";
  lastRemindedAt: string | null;
}>;

export type LeadContractRow = Readonly<{
  id: string;
  templateName: string;
  signers: readonly ContractSignerView[];
  status: EsignStatus;
  deliveryState: EsignDeliveryState;
  testMode: boolean;
  sentAt: string | null;
  detailsUrl: string | null;
  voidRequestedAt: string | null;
  signedPdfFileId: string | null;
  errorMessage: string | null;
}>;

export type RemindContractInput = Readonly<{
  requestId: string;
  signerId: string;
}>;

export type VoidContractInput = Readonly<{
  requestId: string;
}>;

export type RetryContractInput = Readonly<{
  requestId: string;
}>;

export type DownloadLeadFileInput = Readonly<{
  fileId: string;
}>;

export type AuthorizedDownload = Readonly<{
  url: string;
}>;

export type ContractActionHandlers = Readonly<{
  remindAction: (input: RemindContractInput) => Promise<Result<null>>;
  voidAction: (input: VoidContractInput) => Promise<Result<null>>;
  retryAction: (
    input: RetryContractInput,
  ) => Promise<Result<SendContractOutput>>;
  downloadAction: (
    input: DownloadLeadFileInput,
  ) => Promise<Result<AuthorizedDownload>>;
}>;

export type LeadFileRow = Readonly<{
  id: string;
  displayName: string;
  kind: "signed_contract";
  createdAt: string;
  sizeBytes: number | null;
}>;
