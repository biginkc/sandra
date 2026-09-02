import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { ValidationError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import { err, ok, type Result } from "@/lib/errors/result";
import { isValidEsignEmail } from "@/lib/esign/email";
import {
  ESIGN_MERGE_FIELD_NAMES,
  type EsignDeliveryState,
  type EsignStatus,
  type ProviderSignature,
  type TemplateOption,
} from "@/lib/esign/contracts";
import {
  validateContractSendInput,
  validateProviderSignatures,
} from "@/lib/esign/send-contract";
import {
  ESIGN_UNKNOWN_SEND_ZERO_OBSERVATION_THRESHOLD,
} from "@/lib/esign/stuck-send-reconciliation";

import {
  primarySendBlocker,
  type AuthorizedDownload,
  type ConfirmContractNotSentInput,
  type ContractMergeValues,
  type DownloadLeadFileInput,
  type FixSignerEmailAndResendContractInput,
  type LeadEsignPreflight,
  type RemindContractInput,
  type RetryContractInput,
  type SendBlockerCode,
  type SendContractInput,
  type SendContractOutput,
  type SignerAssignment,
  type VoidContractInput,
} from "./esign-types";

const REMINDER_COOLDOWN_MS = 60 * 60 * 1_000;
const DOWNLOAD_MAX_LIFETIME_MS = 5 * 60 * 1_000;
// The lead page explicitly gives its Server Actions 300 seconds. Leave a full
// minute for claim/outcome bookkeeping so Vercel cannot terminate the action
// before an ambiguous provider call is fenced as send_unknown.
export const ESIGN_PROVIDER_TIMEOUT_MS = 4 * 60 * 1_000;

export type EsignActor = Readonly<{
  orgId: string;
  userId: string;
  role?: string | null;
}>;

export type LeadSendContext = Readonly<{
  propertyId: string;
  sellerName: string;
  hasHomeownerContact: boolean;
  sellerEmailAddress: string | null;
  propertyAddress: string;
  connected: boolean;
  sendingEnabled: boolean;
  testMode: true;
  templates: readonly TemplateOption[];
}>;

export type EsignRequestRecord = Readonly<{
  id: string;
  orgId: string;
  propertyId: string;
  template: TemplateOption;
  signers: readonly (SignerAssignment &
    Readonly<{
      id?: string;
      status?: "awaiting" | "viewed" | "signed" | "declined" | "error";
      lastRemindedAt?: string | null;
      providerSignatureId?: string | null;
    }>)[];
  mergeValues: ContractMergeValues;
  sendIntentId: string;
  payloadHash: string;
  retryOfRequestId: string | null;
  status: EsignStatus;
  deliveryState: EsignDeliveryState;
  testMode: boolean;
  providerRequestId: string | null;
  detailsUrl: string | null;
  errorMessage: string | null;
  voidRequestedAt: string | null;
  signedPdfFileId: string | null;
}>;

export type ReminderCandidate = Readonly<{
  claimToken: string;
  request: EsignRequestRecord;
  signer: Readonly<{
    id: string;
    name: string;
    emailAddress: string;
    status: "awaiting" | "viewed";
    lastRemindedAt: string | null;
  }>;
}>;

export type EmailBounceUpdateCandidate = Readonly<{
  claimToken: string;
  providerRequestId: string;
  signer: Readonly<{
    id: string;
    providerSignatureId: string;
    role: string;
    order: number;
    name: string;
    emailAddress: string;
  }>;
}>;

type ClaimSendInput = Readonly<{
  actor: EsignActor;
  propertyId: string;
  template: TemplateOption;
  signers: readonly SignerAssignment[];
  mergeValues: ContractMergeValues;
  sendIntentId: string;
  payloadHash: string;
  retryOfRequestId: string | null;
}>;

export type SendClaim =
  | Readonly<{ outcome: "created"; request: EsignRequestRecord }>
  | Readonly<{ outcome: "existing"; request: EsignRequestRecord }>
  | Readonly<{ outcome: "blocked"; blocker: SendBlockerCode }>
  | Readonly<{ outcome: "intent_conflict" }>
  | Readonly<{ outcome: "authorization_changed" }>
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "invalid_send_input" }>
  | Readonly<{ outcome: "seller_contact_conflict" }>
  | Readonly<{ outcome: "retry_ineligible" }>;

export type EsignActionRepository = Readonly<{
  loadLeadSendContext(input: {
    actor: EsignActor;
    propertyId: string;
  }): Promise<LeadSendContext | null>;
  findRequestByIntent(input: {
    orgId: string;
    sendIntentId: string;
  }): Promise<EsignRequestRecord | null>;
  isDialogEmailAuthorityReady(input: { orgId: string }): Promise<boolean>;
  claimSend(input: ClaimSendInput): Promise<SendClaim>;
  reconcileSent(input: {
    orgId: string;
    requestId: string;
    providerRequestId: string;
    detailsUrl: string;
    signatures: readonly ProviderSignature[];
  }): Promise<void>;
  markSendOutcome(input: {
    orgId: string;
    requestId: string;
    deliveryState: "send_unknown" | "failed";
    safeErrorMessage: string | null;
  }): Promise<void>;
  findProviderLookupReference(input: {
    orgId: string;
    requestId: string;
    testMode: boolean;
  }): Promise<Readonly<{
    localRequestId: string;
    providerRequestId: string;
  }> | null>;
  resolveSendUnknownNotSent(input: {
    orgId: string;
    requestId: string;
    actorId: string;
    evidence: Record<string, unknown>;
  }): Promise<"updated" | "raced">;
  claimEmailBounceUpdate(input: {
    orgId: string;
    requestId: string;
    signerId: string;
    actorId: string;
    emailAddress: string;
  }): Promise<
    | Readonly<{ outcome: "eligible"; candidate: EmailBounceUpdateCandidate }>
    | Readonly<{ outcome: "in_progress" }>
    | Readonly<{ outcome: "reconciliation_required" }>
    | Readonly<{ outcome: "ineligible" }>
  >;
  finalizeEmailBounceUpdate(input: {
    orgId: string;
    requestId: string;
    signerId: string;
    claimToken: string;
    providerSignatureId: string;
  }): Promise<"applied" | "lease_lost">;
  releaseEmailBounceUpdate(input: {
    orgId: string;
    requestId: string;
    signerId: string;
    claimToken: string;
  }): Promise<"released" | "lease_lost">;
  findRequest(input: {
    orgId: string;
    requestId: string;
  }): Promise<EsignRequestRecord | null>;
  claimReminder(input: {
    orgId: string;
    requestId: string;
    signerId: string;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "eligible"; candidate: ReminderCandidate }>
    | Readonly<{ outcome: "cooldown" }>
    | Readonly<{ outcome: "in_progress" }>
    | Readonly<{ outcome: "reconciliation_required" }>
    | Readonly<{ outcome: "ineligible" }>
  >;
  finalizeReminder(input: {
    orgId: string;
    requestId: string;
    signerId: string;
    claimToken: string;
  }): Promise<"applied" | "lease_lost">;
  releaseReminder(input: {
    orgId: string;
    requestId: string;
    signerId: string;
    claimToken: string;
  }): Promise<"released" | "lease_lost">;
  claimVoid(input: { orgId: string; requestId: string }): Promise<
    | Readonly<{
        outcome: "eligible";
        request: EsignRequestRecord;
        claimToken: string;
      }>
    | Readonly<{ outcome: "in_progress" }>
    | Readonly<{ outcome: "reconciliation_required" }>
    | Readonly<{ outcome: "ineligible" }>
  >;
  finalizeVoid(input: {
    orgId: string;
    requestId: string;
    claimToken: string;
  }): Promise<"applied" | "lease_lost">;
  releaseVoid(input: {
    orgId: string;
    requestId: string;
    claimToken: string;
  }): Promise<"released" | "lease_lost">;
  findSignedFile(input: {
    orgId: string;
    fileId: string;
  }): Promise<Readonly<{ id: string; requestId: string }> | null>;
}>;

export type ProviderDispatchOutcome =
  | Readonly<{
      outcome: "sent";
      providerRequestId: string;
      detailsUrl: string;
      signatures: readonly ProviderSignature[];
    }>
  | Readonly<{ outcome: "ambiguous" }>
  | Readonly<{ outcome: "definitive_failure" }>;

export type ProviderMutationOutcome =
  "accepted" | "ambiguous" | "definitive_failure";

export type ProviderSignerUpdateOutcome =
  | Readonly<{ outcome: "accepted"; signature: ProviderSignature }>
  | Readonly<{ outcome: "ambiguous" | "definitive_failure" }>;

export type EsignActionProvider = Readonly<{
  sendWithTemplate(input: {
    localRequestId: string;
    providerTemplateId: string;
    signers: readonly SignerAssignment[];
    mergeValues: ContractMergeValues;
    signal: AbortSignal;
  }): Promise<ProviderDispatchOutcome>;
  remind(input: {
    providerRequestId: string;
    signerName: string;
    signerEmailAddress: string;
    signal: AbortSignal;
  }): Promise<ProviderMutationOutcome>;
  cancel(input: {
    providerRequestId: string;
    signal: AbortSignal;
  }): Promise<ProviderMutationOutcome>;
  updateSignerEmail(input: {
    providerRequestId: string;
    providerSignatureId: string;
    signerName: string;
    signerEmailAddress: string;
    signerRole: string;
    signerOrder: number;
    signal: AbortSignal;
  }): Promise<ProviderSignerUpdateOutcome>;
  findSignatureRequestIdsByLocalRequestId(input: {
    localRequestId: string;
    testMode: boolean;
    signal: AbortSignal;
  }): Promise<{ complete: boolean; providerRequestIds: readonly string[] }>;
}>;

export type EsignActionFiles = Readonly<{
  authorizeSignedFile(input: {
    actor: EsignActor;
    fileId: string;
    requestId: string;
  }): Promise<Readonly<{ url: string; expiresAt: Date }> | null>;
}>;

export type LeadEsignActionDependencies = Readonly<{
  authenticate(): Promise<EsignActor | null>;
  repository: EsignActionRepository;
  providerForOrg(orgId: string): Promise<EsignActionProvider | null>;
  files: EsignActionFiles;
  now(): Date;
  newId(): string;
}>;

export type ViewContractInput = Readonly<{ requestId: string }>;
export type ViewContractOutput = Readonly<{ detailsUrl: string }>;

export type LeadEsignActionCore = ReturnType<typeof createLeadEsignActionCore>;

export function createLeadEsignActionCore(
  dependencies: LeadEsignActionDependencies,
) {
  return {
    preflight: (propertyId: string) =>
      safely(() => loadPreflight(dependencies, propertyId)),
    send: (input: SendContractInput) =>
      safely(() => send(dependencies, input, null)),
    remind: (input: RemindContractInput) =>
      safely(() => remind(dependencies, input)),
    void: (input: VoidContractInput) =>
      safely(() => requestVoid(dependencies, input)),
    retry: (input: RetryContractInput) =>
      safely(() => retry(dependencies, input)),
    fixSignerEmailAndResend: (input: FixSignerEmailAndResendContractInput) =>
      safely(() => fixSignerEmailAndResend(dependencies, input)),
    confirmNotSent: (input: ConfirmContractNotSentInput) =>
      safely(() => confirmNotSent(dependencies, input)),
    view: (input: ViewContractInput) =>
      safely(() => viewDetails(dependencies, input)),
    download: (input: DownloadLeadFileInput) =>
      safely(() => downloadSignedFile(dependencies, input)),
  };
}

async function loadPreflight(
  dependencies: LeadEsignActionDependencies,
  propertyId: string,
): Promise<LeadEsignPreflight> {
  const actor = await requireActor(dependencies);
  const context = await dependencies.repository.loadLeadSendContext({
    actor,
    propertyId,
  });
  if (!context) fail("NOT_FOUND", "Lead not found.");
  const blockers = blockersFor(context);
  return {
    propertyId: context.propertyId,
    testMode: true,
    blockers,
    templates: context.templates,
    sellerDefaults: {
      name: context.sellerName.trim(),
      emailAddress: context.sellerEmailAddress?.trim() ?? "",
    },
    mergeDefaults: {
      seller_name: context.sellerName.trim(),
      property_address: context.propertyAddress.trim(),
      offer_price: "",
      closing_date: "",
      earnest_money: "",
    },
  };
}

async function send(
  dependencies: LeadEsignActionDependencies,
  input: SendContractInput,
  retryOfRequestId: string | null,
): Promise<SendContractOutput> {
  const actor = await requireActor(dependencies);
  assertExactRuntimeSendShape(input);
  const normalized = normalizeSendInput(input);
  const payloadHash = hashSendPayload(normalized);
  const existing = await dependencies.repository.findRequestByIntent({
    orgId: actor.orgId,
    sendIntentId: normalized.sendIntentId,
  });
  if (existing)
    return resolveExistingIntent(existing, payloadHash, actor.orgId);

  const context = await dependencies.repository.loadLeadSendContext({
    actor,
    propertyId: normalized.propertyId,
  });
  if (!context) fail("NOT_FOUND", "Lead not found.");
  assertNoSendBlockers(context);
  const template = context.templates.find(
    (candidate) => candidate.id === normalized.templateId,
  );
  if (!template)
    fail("TEMPLATE_CHANGED", "Refresh the contract templates and try again.");
  assertSellerEmail(template, normalized.signers);
  validateContractSendInput({
    localRequestId: "validation-only",
    template,
    signers: normalized.signers,
    mergeValues: normalized.mergeValues,
  });
  if (
    !(await dependencies.repository.isDialogEmailAuthorityReady({
      orgId: actor.orgId,
    }))
  ) {
    fail(
      "SENDING_DISABLED",
      "Contract sending is finishing an update. Try again in a minute.",
    );
  }

  const claim = await dependencies.repository.claimSend({
    actor,
    propertyId: normalized.propertyId,
    template,
    signers: normalized.signers,
    mergeValues: normalized.mergeValues,
    sendIntentId: normalized.sendIntentId,
    payloadHash,
    retryOfRequestId,
  });
  if (claim.outcome === "blocked")
    fail(blockerCode(claim.blocker), blockerMessage(claim.blocker));
  if (claim.outcome === "retry_ineligible")
    fail("RETRY_INELIGIBLE", "Only failed contracts can be retried.");
  if (claim.outcome === "intent_conflict")
    fail(
      "SEND_INTENT_CONFLICT",
      "This send key was already used for different contract details.",
    );
  if (claim.outcome === "authorization_changed")
    fail(
      "AUTHORIZATION_CHANGED",
      "Your organization access changed. Sign in again and retry.",
    );
  if (claim.outcome === "not_found")
    fail("NOT_FOUND", "Lead not found. Refresh and try again.");
  if (claim.outcome === "invalid_send_input")
    fail(
      "INVALID_SEND_INPUT",
      "The signer details changed. Review each signer and try again.",
    );
  if (claim.outcome === "seller_contact_conflict")
    fail(
      "SELLER_EMAIL_CONFLICT",
      "That seller email belongs to another contact. Use a unique seller email before sending.",
    );
  if (claim.outcome === "existing")
    return resolveExistingIntent(claim.request, payloadHash, actor.orgId);
  try {
    assertClaimedRequest(
      claim.request,
      actor,
      normalized,
      payloadHash,
      retryOfRequestId,
    );
  } catch (error) {
    await markFailed(
      dependencies,
      { id: claim.request.id, orgId: actor.orgId },
      "REQUEST_CLAIM_MISMATCH",
    );
    throw error;
  }
  return dispatchClaimed(dependencies, claim.request);
}

async function dispatchClaimed(
  dependencies: LeadEsignActionDependencies,
  request: EsignRequestRecord,
): Promise<SendContractOutput> {
  let provider: EsignActionProvider | null;
  try {
    provider = await dependencies.providerForOrg(request.orgId);
  } catch {
    await markFailed(dependencies, request, "PROVIDER_SETUP_FAILED");
    fail("PROVIDER_DISCONNECTED", "Dropbox Sign is not connected.");
  }
  if (!provider) {
    await markFailed(dependencies, request, "PROVIDER_DISCONNECTED");
    fail("PROVIDER_DISCONNECTED", "Dropbox Sign is not connected.");
  }

  let outcome: ProviderDispatchOutcome;
  try {
    outcome = await withProviderTimeout((signal) =>
      provider.sendWithTemplate({
        localRequestId: request.id,
        providerTemplateId: request.template.providerTemplateId,
        signers: request.signers,
        mergeValues: request.mergeValues,
        signal,
      }),
    );
  } catch {
    await markUnknown(dependencies, request);
    fail(
      "SEND_UNKNOWN",
      "Dropbox Sign may have received this contract. Check its status before retrying.",
    );
  }
  if (outcome.outcome === "ambiguous") {
    await markUnknown(dependencies, request);
    fail(
      "SEND_UNKNOWN",
      "Dropbox Sign may have received this contract. Check its status before retrying.",
    );
  }
  if (outcome.outcome === "definitive_failure") {
    await markFailed(dependencies, request, "PROVIDER_REJECTED");
    fail("SEND_FAILED", "Dropbox Sign could not send this contract.");
  }

  try {
    validateDetailsUrl(outcome.detailsUrl);
    validateProviderSignatures(request.signers, outcome.signatures);
    await dependencies.repository.reconcileSent({
      orgId: request.orgId,
      requestId: request.id,
      providerRequestId: outcome.providerRequestId,
      detailsUrl: outcome.detailsUrl,
      signatures: outcome.signatures,
    });
  } catch {
    await markUnknown(dependencies, request);
    fail(
      "SEND_UNKNOWN",
      "Dropbox Sign received the contract but Sandra could not confirm its details.",
    );
  }
  return { requestId: request.id };
}

async function retry(
  dependencies: LeadEsignActionDependencies,
  input: RetryContractInput,
): Promise<SendContractOutput> {
  const actor = await requireActor(dependencies);
  const source = await dependencies.repository.findRequest({
    orgId: actor.orgId,
    requestId: input.requestId,
  });
  if (!source) fail("NOT_FOUND", "Contract not found.");
  if (source.orgId !== actor.orgId) fail("NOT_FOUND", "Contract not found.");
  if (source.deliveryState !== "failed")
    fail("RETRY_INELIGIBLE", "Only failed contracts can be retried.");
  return send(
    dependencies,
    {
      propertyId: source.propertyId,
      templateId: source.template.id,
      sendIntentId: dependencies.newId(),
      signers: source.signers.map(({ role, order, name, emailAddress }) => ({
        role,
        order,
        name,
        emailAddress,
      })),
      mergeValues: source.mergeValues,
    },
    source.id,
  );
}

async function confirmNotSent(
  dependencies: LeadEsignActionDependencies,
  input: ConfirmContractNotSentInput,
): Promise<null> {
  const actor = await requireActor(dependencies);
  if (actor.role !== "owner") {
    fail("OWNER_REQUIRED", "Only an organization owner can acknowledge this send.");
  }
  const request = await dependencies.repository.findRequest({
    orgId: actor.orgId,
    requestId: input.requestId,
  });
  if (!request) fail("NOT_FOUND", "Contract not found.");
  if (
    request.orgId !== actor.orgId ||
    request.deliveryState !== "failed" ||
    request.providerRequestId ||
    request.errorMessage !== "PROVIDER_SEND_NOT_FOUND"
  ) {
    fail(
      "CONFIRM_NOT_SENT_INELIGIBLE",
      "Only automatically evidenced not-sent contracts can be acknowledged.",
    );
  }
  const result = await dependencies.repository.resolveSendUnknownNotSent({
    orgId: actor.orgId,
    requestId: request.id,
    actorId: actor.userId,
    evidence: {
      resolutionSource: "operator",
      observedAt: dependencies.now().toISOString(),
      zeroObservationThreshold: ESIGN_UNKNOWN_SEND_ZERO_OBSERVATION_THRESHOLD,
      acknowledgedFailure: "PROVIDER_SEND_NOT_FOUND",
    },
  });
  if (result === "raced") {
    fail(
      "CONFIRM_NOT_SENT_INELIGIBLE",
      "This contract changed while Dropbox Sign was being checked. Refresh and review it.",
    );
  }
  return null;
}

async function fixSignerEmailAndResend(
  dependencies: LeadEsignActionDependencies,
  input: FixSignerEmailAndResendContractInput,
): Promise<null> {
  const actor = await requireActor(dependencies);
  if (actor.role !== "owner") {
    fail("OWNER_REQUIRED", "Only an organization owner can fix signer emails.");
  }
  const normalizedEmail = input.emailAddress.trim();
  if (!isValidEsignEmail(normalizedEmail)) {
    fail("INVALID_SIGNER_EMAIL", "Enter one email address without spaces.");
  }
  const claim = await dependencies.repository.claimEmailBounceUpdate({
    orgId: actor.orgId,
    requestId: input.requestId,
    signerId: input.signerId,
    actorId: actor.userId,
    emailAddress: normalizedEmail,
  });
  if (claim.outcome === "in_progress") {
    fail(
      "EMAIL_FIX_IN_PROGRESS",
      "A signer email update is already in progress.",
    );
  }
  if (claim.outcome === "reconciliation_required") {
    fail(
      "EMAIL_FIX_UNKNOWN",
      "Dropbox Sign may have accepted a prior email fix. Reconcile it before trying again.",
    );
  }
  if (claim.outcome !== "eligible") {
    fail(
      "EMAIL_FIX_INELIGIBLE",
      "Only bounced signer emails on existing Dropbox Sign requests can be fixed.",
    );
  }
  const { candidate } = claim;
  let provider: EsignActionProvider | null;
  try {
    provider = await dependencies.providerForOrg(actor.orgId);
  } catch {
    await releaseEmailBounceUpdate(
      dependencies,
      actor.orgId,
      input.requestId,
      input.signerId,
      candidate.claimToken,
    );
    fail("PROVIDER_DISCONNECTED", "Dropbox Sign is not connected.");
  }
  if (!provider) {
    await releaseEmailBounceUpdate(
      dependencies,
      actor.orgId,
      input.requestId,
      input.signerId,
      candidate.claimToken,
    );
    fail("PROVIDER_DISCONNECTED", "Dropbox Sign is not connected.");
  }

  let outcome: ProviderSignerUpdateOutcome;
  try {
    outcome = await withProviderTimeout((signal) =>
      provider.updateSignerEmail({
        providerRequestId: candidate.providerRequestId,
        providerSignatureId: candidate.signer.providerSignatureId,
        signerName: candidate.signer.name,
        signerEmailAddress: candidate.signer.emailAddress,
        signerRole: candidate.signer.role,
        signerOrder: candidate.signer.order,
        signal,
      }),
    );
  } catch {
    outcome = { outcome: "ambiguous" };
  }
  if (outcome.outcome === "definitive_failure") {
    await releaseEmailBounceUpdate(
      dependencies,
      actor.orgId,
      input.requestId,
      input.signerId,
      candidate.claimToken,
    );
    fail("EMAIL_FIX_FAILED", "Dropbox Sign could not update the signer email.");
  }
  if (outcome.outcome === "ambiguous") {
    fail(
      "EMAIL_FIX_UNKNOWN",
      "Dropbox Sign may have accepted the signer email update. Reconcile it before trying again.",
    );
  }

  if (outcome.outcome !== "accepted") {
    fail(
      "EMAIL_FIX_UNKNOWN",
      "Dropbox Sign may have accepted the signer email update. Reconcile it before trying again.",
    );
  }
  let finalized: "applied" | "lease_lost";
  try {
    finalized = await dependencies.repository.finalizeEmailBounceUpdate({
      orgId: actor.orgId,
      requestId: input.requestId,
      signerId: input.signerId,
      claimToken: candidate.claimToken,
      providerSignatureId: outcome.signature.signatureId,
    });
  } catch {
    fail(
      "EMAIL_FIX_UNKNOWN",
      "Dropbox Sign accepted the signer email update, but Sandra could not confirm it. Reconcile it before trying again.",
    );
  }
  if (finalized === "lease_lost") {
    fail(
      "EMAIL_FIX_UNKNOWN",
      "Dropbox Sign accepted the signer email update, but Sandra could not confirm it. Reconcile it before trying again.",
    );
  }
  return null;
}

async function remind(
  dependencies: LeadEsignActionDependencies,
  input: RemindContractInput,
): Promise<null> {
  const actor = await requireActor(dependencies);
  const now = dependencies.now();
  const claim = await dependencies.repository.claimReminder({
    orgId: actor.orgId,
    requestId: input.requestId,
    signerId: input.signerId,
    now,
  });
  if (claim.outcome === "in_progress")
    fail(
      "REMINDER_IN_PROGRESS",
      "A reminder or void request is already in progress.",
    );
  if (claim.outcome === "reconciliation_required")
    fail(
      "REMINDER_UNKNOWN",
      "A prior reminder may have been sent. Reconcile it before trying again.",
    );
  if (claim.outcome === "cooldown")
    fail(
      "REMINDER_COOLDOWN",
      "Wait one hour before reminding this signer again.",
    );
  if (claim.outcome === "ineligible")
    fail("REMINDER_INELIGIBLE", "This signer cannot be reminded.");
  const { request, signer } = claim.candidate;
  const lastRemindedAt = signer.lastRemindedAt
    ? Date.parse(signer.lastRemindedAt)
    : Number.NaN;
  if (
    request.orgId !== actor.orgId ||
    signer.id !== input.signerId ||
    !request.providerRequestId ||
    request.deliveryState !== "sent" ||
    !["awaiting", "viewed"].includes(request.status) ||
    request.voidRequestedAt ||
    (signer.lastRemindedAt !== null &&
      (!Number.isFinite(lastRemindedAt) ||
        now.getTime() - lastRemindedAt < REMINDER_COOLDOWN_MS))
  ) {
    await releaseReminder(
      dependencies,
      actor.orgId,
      request.id,
      input.signerId,
      claim.candidate.claimToken,
    );
    fail("REMINDER_INELIGIBLE", "This signer cannot be reminded.");
  }
  let provider: EsignActionProvider | null;
  try {
    provider = await dependencies.providerForOrg(actor.orgId);
  } catch {
    await releaseReminder(
      dependencies,
      actor.orgId,
      request.id,
      input.signerId,
      claim.candidate.claimToken,
    );
    fail("PROVIDER_DISCONNECTED", "Dropbox Sign is not connected.");
  }
  if (!provider) {
    await releaseReminder(
      dependencies,
      actor.orgId,
      request.id,
      input.signerId,
      claim.candidate.claimToken,
    );
    fail("PROVIDER_DISCONNECTED", "Dropbox Sign is not connected.");
  }
  let outcome: ProviderMutationOutcome;
  try {
    outcome = await withProviderTimeout((signal) =>
      provider.remind({
        providerRequestId: request.providerRequestId!,
        signerName: signer.name,
        signerEmailAddress: signer.emailAddress,
        signal,
      }),
    );
  } catch {
    outcome = "ambiguous";
  }
  if (outcome === "definitive_failure") {
    await releaseReminder(
      dependencies,
      actor.orgId,
      request.id,
      input.signerId,
      claim.candidate.claimToken,
    );
    fail("REMINDER_FAILED", "Dropbox Sign could not send the reminder.");
  }
  let finalized: "applied" | "lease_lost";
  try {
    finalized = await dependencies.repository.finalizeReminder({
      orgId: actor.orgId,
      requestId: request.id,
      signerId: input.signerId,
      claimToken: claim.candidate.claimToken,
    });
  } catch {
    fail(
      "REMINDER_UNKNOWN",
      "Dropbox Sign may have sent the reminder. Reconcile it before trying again.",
    );
  }
  if (finalized === "lease_lost")
    fail(
      "REMINDER_UNKNOWN",
      "Dropbox Sign may have sent the reminder. Reconcile it before trying again.",
    );
  if (outcome === "ambiguous")
    fail(
      "REMINDER_UNKNOWN",
      "Dropbox Sign may have sent the reminder. Wait one hour before trying again.",
    );
  return null;
}

async function requestVoid(
  dependencies: LeadEsignActionDependencies,
  input: VoidContractInput,
): Promise<null> {
  const actor = await requireActor(dependencies);
  const claim = await dependencies.repository.claimVoid({
    orgId: actor.orgId,
    requestId: input.requestId,
  });
  if (claim.outcome === "in_progress")
    fail(
      "VOID_IN_PROGRESS",
      "A reminder or void request is already in progress.",
    );
  if (claim.outcome === "reconciliation_required")
    fail(
      "VOID_UNKNOWN",
      "A prior void request may have been accepted. Reconcile it before trying again.",
    );
  if (claim.outcome !== "eligible")
    fail("VOID_INELIGIBLE", "This contract cannot be voided.");
  const request = claim.request;
  if (
    request.orgId !== actor.orgId ||
    !request.providerRequestId ||
    request.deliveryState !== "sent" ||
    request.voidRequestedAt ||
    !["awaiting", "viewed"].includes(request.status)
  ) {
    await releaseVoid(dependencies, actor.orgId, request.id, claim.claimToken);
    fail("VOID_INELIGIBLE", "This contract cannot be voided.");
  }
  let provider: EsignActionProvider | null;
  try {
    provider = await dependencies.providerForOrg(actor.orgId);
  } catch {
    await releaseVoid(dependencies, actor.orgId, request.id, claim.claimToken);
    fail("PROVIDER_DISCONNECTED", "Dropbox Sign is not connected.");
  }
  if (!provider) {
    await releaseVoid(dependencies, actor.orgId, request.id, claim.claimToken);
    fail("PROVIDER_DISCONNECTED", "Dropbox Sign is not connected.");
  }
  let outcome: ProviderMutationOutcome;
  try {
    outcome = await withProviderTimeout((signal) =>
      provider.cancel({
        providerRequestId: request.providerRequestId!,
        signal,
      }),
    );
  } catch {
    outcome = "ambiguous";
  }
  if (outcome === "definitive_failure") {
    await releaseVoid(dependencies, actor.orgId, request.id, claim.claimToken);
    fail("VOID_FAILED", "Dropbox Sign could not accept the void request.");
  }
  let finalized: "applied" | "lease_lost";
  try {
    finalized = await dependencies.repository.finalizeVoid({
      orgId: actor.orgId,
      requestId: request.id,
      claimToken: claim.claimToken,
    });
  } catch {
    fail(
      "VOID_UNKNOWN",
      "Dropbox Sign may have accepted the void request. Reconcile it before trying again.",
    );
  }
  if (finalized === "lease_lost")
    fail(
      "VOID_UNKNOWN",
      "Dropbox Sign may have accepted the void request. Reconcile it before trying again.",
    );
  if (outcome === "ambiguous")
    fail(
      "VOID_UNKNOWN",
      "Dropbox Sign may have accepted the void request. Check its status before trying again.",
    );
  return null;
}

async function viewDetails(
  dependencies: LeadEsignActionDependencies,
  input: ViewContractInput,
): Promise<ViewContractOutput> {
  const actor = await requireActor(dependencies);
  const request = await dependencies.repository.findRequest({
    orgId: actor.orgId,
    requestId: input.requestId,
  });
  if (!request?.detailsUrl)
    fail("DETAILS_UNAVAILABLE", "Dropbox Sign details are not available.");
  if (request.orgId !== actor.orgId)
    fail("DETAILS_UNAVAILABLE", "Dropbox Sign details are not available.");
  validateDetailsUrl(request.detailsUrl);
  return { detailsUrl: request.detailsUrl };
}

async function downloadSignedFile(
  dependencies: LeadEsignActionDependencies,
  input: DownloadLeadFileInput,
): Promise<AuthorizedDownload> {
  const actor = await requireActor(dependencies);
  const file = await dependencies.repository.findSignedFile({
    orgId: actor.orgId,
    fileId: input.fileId,
  });
  if (!file) fail("FILE_NOT_FOUND", "Signed file not found.");
  const request = await dependencies.repository.findRequest({
    orgId: actor.orgId,
    requestId: file.requestId,
  });
  if (
    !request ||
    request.orgId !== actor.orgId ||
    request.status !== "signed" ||
    request.signedPdfFileId !== file.id
  ) {
    fail("FILE_NOT_READY", "The signed PDF is not ready yet.");
  }
  const authorized = await dependencies.files.authorizeSignedFile({
    actor,
    fileId: file.id,
    requestId: request.id,
  });
  if (!authorized || !isSafeDownload(authorized, dependencies.now())) {
    fail("FILE_AUTHORIZATION_FAILED", "Could not prepare the signed PDF.");
  }
  return { url: authorized.url };
}

function blockersFor(context: LeadSendContext): SendBlockerCode[] {
  const blockers: SendBlockerCode[] = [];
  if (!context.connected) blockers.push("provider_disconnected");
  if (!context.sendingEnabled) blockers.push("sending_disabled");
  if (context.templates.length === 0) blockers.push("no_templates");
  if (!context.hasHomeownerContact) blockers.push("owner_contact_missing");
  else if (!context.sellerEmailAddress?.trim())
    blockers.push("owner_email_missing");
  return blockers;
}

function assertNoSendBlockers(context: LeadSendContext): void {
  const blocker = primarySendBlocker(
    blockersFor(context).filter(
      (candidate) => candidate !== "owner_email_missing",
    ),
  );
  if (blocker) fail(blockerCode(blocker), blockerMessage(blocker));
}

function assertSellerEmail(
  template: TemplateOption,
  signers: readonly SignerAssignment[],
): void {
  const seller = signers.find(
    (signer) => signer.role === template.sellerRoleName,
  );
  if (seller && seller.emailAddress.length === 0) {
    fail("OWNER_EMAIL_MISSING", "Enter the seller email before sending.");
  }
  if (seller && !isValidEsignEmail(seller.emailAddress)) {
    fail(
      "INVALID_SEND_INPUT",
      "Enter one email address without spaces for the seller.",
    );
  }
}

function blockerCode(blocker: SendBlockerCode): string {
  return blocker.toUpperCase();
}

function blockerMessage(blocker: SendBlockerCode): string {
  const messages: Record<SendBlockerCode, string> = {
    provider_disconnected: "Dropbox Sign is not connected.",
    sending_disabled: "Sending from leads is turned off.",
    no_templates: "No eSign templates are available.",
    owner_contact_missing: "No homeowner contact is linked to this lead.",
    owner_email_missing: "Enter the seller email before sending.",
  };
  return messages[blocker];
}

function normalizeSendInput(input: SendContractInput): SendContractInput {
  return {
    propertyId: input.propertyId,
    templateId: input.templateId,
    sendIntentId: input.sendIntentId,
    signers: [...input.signers]
      .sort((left, right) => left.order - right.order)
      .map((signer) => ({
        role: signer.role,
        order: signer.order,
        name: signer.name.trim(),
        emailAddress: signer.emailAddress.trim(),
      })),
    mergeValues: Object.fromEntries(
      ESIGN_MERGE_FIELD_NAMES.map((name) => [
        name,
        input.mergeValues[name].trim(),
      ]),
    ) as ContractMergeValues,
  };
}

function assertExactRuntimeSendShape(input: SendContractInput): void {
  if (
    Object.keys(input).sort().join(",") !==
    "mergeValues,propertyId,sendIntentId,signers,templateId"
  ) {
    fail("INVALID_SEND_INPUT", "The contract send details are invalid.");
  }
  const expectedMergeKeys = [...ESIGN_MERGE_FIELD_NAMES].sort();
  const actualMergeKeys = Object.keys(input.mergeValues).sort();
  if (
    actualMergeKeys.length !== expectedMergeKeys.length ||
    actualMergeKeys.some((key, index) => key !== expectedMergeKeys[index])
  ) {
    fail("INVALID_SEND_INPUT", "The contract send details are invalid.");
  }
  const expectedSignerKeys = "emailAddress,name,order,role";
  if (
    !Array.isArray(input.signers) ||
    input.signers.some(
      (signer) => Object.keys(signer).sort().join(",") !== expectedSignerKeys,
    )
  ) {
    fail("INVALID_SEND_INPUT", "The contract send details are invalid.");
  }
}

export function hashSendPayload(input: SendContractInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        propertyId: input.propertyId,
        templateId: input.templateId,
        signers: [...input.signers]
          .sort((left, right) => left.order - right.order)
          .map(({ role, order, name, emailAddress }) => ({
            role,
            order,
            name,
            emailAddress,
          })),
        mergeValues: ESIGN_MERGE_FIELD_NAMES.map((name) => [
          name,
          input.mergeValues[name],
        ]),
      }),
      "utf8",
    )
    .digest("hex");
}

function resolveExistingIntent(
  request: EsignRequestRecord,
  payloadHash: string,
  orgId: string,
): SendContractOutput {
  if (request.orgId !== orgId) fail("NOT_FOUND", "Contract not found.");
  if (request.payloadHash !== payloadHash) {
    fail(
      "SEND_INTENT_CONFLICT",
      "This send was already submitted with different contract details.",
    );
  }
  if (request.deliveryState === "sent") return { requestId: request.id };
  if (request.deliveryState === "sending") {
    fail("SEND_IN_PROGRESS", "This contract send is already in progress.");
  }
  if (request.deliveryState === "send_unknown") {
    fail(
      "SEND_UNKNOWN",
      "Dropbox Sign may have received this contract. Check its status before retrying.",
    );
  }
  if (request.deliveryState === "email_bounced") {
    fail(
      "EMAIL_BOUNCED",
      "Dropbox Sign reported that the signer email bounced. Fix the signer email and resend this request.",
    );
  }
  fail(
    "SEND_FAILED",
    "This contract send failed. Use Retry to send a new request.",
  );
}

function assertClaimedRequest(
  request: EsignRequestRecord,
  actor: EsignActor,
  input: SendContractInput,
  payloadHash: string,
  retryOfRequestId: string | null,
): void {
  if (
    request.orgId !== actor.orgId ||
    request.propertyId !== input.propertyId ||
    request.template.id !== input.templateId ||
    request.sendIntentId !== input.sendIntentId ||
    request.payloadHash !== payloadHash ||
    request.retryOfRequestId !== retryOfRequestId ||
    hashSendPayload({
      propertyId: request.propertyId,
      templateId: request.template.id,
      sendIntentId: request.sendIntentId,
      signers: request.signers,
      mergeValues: request.mergeValues,
    }) !== payloadHash
  ) {
    fail(
      "REQUEST_CLAIM_MISMATCH",
      "Sandra could not safely claim this contract send.",
    );
  }
}

function validateDetailsUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("INVALID_DETAILS_URL", "Dropbox Sign details are not available.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "app.hellosign.com" ||
    !url.pathname.startsWith("/home/manage")
  ) {
    fail("INVALID_DETAILS_URL", "Dropbox Sign details are not available.");
  }
}

function isSafeDownload(
  authorized: Readonly<{ url: string; expiresAt: Date }>,
  now: Date,
): boolean {
  return (
    isAuthorizedDownloadUrl(authorized.url) &&
    authorized.expiresAt.getTime() > now.getTime() &&
    authorized.expiresAt.getTime() - now.getTime() <= DOWNLOAD_MAX_LIFETIME_MS
  );
}

function isAuthorizedDownloadUrl(value: string): boolean {
  if (value.startsWith("/api/leads/files/") && !value.startsWith("//"))
    return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && /\.supabase\.(co|in)$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

async function withProviderTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const providerPromise = operation(controller.signal);
  void providerPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException("Provider send deadline exceeded.", "AbortError"));
    }, ESIGN_PROVIDER_TIMEOUT_MS);
  });
  return Promise.race([providerPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function releaseReminder(
  dependencies: LeadEsignActionDependencies,
  orgId: string,
  requestId: string,
  signerId: string,
  claimToken: string,
): Promise<void> {
  try {
    await dependencies.repository.releaseReminder({
      orgId,
      requestId,
      signerId,
      claimToken,
    });
  } catch {
    // The original safe action result remains authoritative. The SQL lease is
    // token-fenced and expires server-side if this best-effort release fails.
  }
}

async function releaseVoid(
  dependencies: LeadEsignActionDependencies,
  orgId: string,
  requestId: string,
  claimToken: string,
): Promise<void> {
  try {
    await dependencies.repository.releaseVoid({
      orgId,
      requestId,
      claimToken,
    });
  } catch {
    // Do not replace the original safe action result with repository details.
  }
}

async function releaseEmailBounceUpdate(
  dependencies: LeadEsignActionDependencies,
  orgId: string,
  requestId: string,
  signerId: string,
  claimToken: string,
): Promise<void> {
  try {
    await dependencies.repository.releaseEmailBounceUpdate({
      orgId,
      requestId,
      signerId,
      claimToken,
    });
  } catch {
    // Keep the original provider/action result authoritative. The claim remains
    // token-fenced so a stale replay cannot resend the same provider mutation.
  }
}

async function requireActor(
  dependencies: LeadEsignActionDependencies,
): Promise<EsignActor> {
  const actor = await dependencies.authenticate();
  if (!actor)
    fail("AUTHORIZATION_REQUIRED", "Sign in with active organization access.");
  return actor;
}

async function markUnknown(
  dependencies: LeadEsignActionDependencies,
  request: EsignRequestRecord,
): Promise<void> {
  try {
    await dependencies.repository.markSendOutcome({
      orgId: request.orgId,
      requestId: request.id,
      deliveryState: "send_unknown",
      safeErrorMessage: null,
    });
  } catch {
    reportSendOutcomePersistenceFailure("send_unknown");
  }
}

async function markFailed(
  dependencies: LeadEsignActionDependencies,
  request: Pick<EsignRequestRecord, "id" | "orgId">,
  safeErrorMessage: string,
): Promise<void> {
  try {
    await dependencies.repository.markSendOutcome({
      orgId: request.orgId,
      requestId: request.id,
      deliveryState: "failed",
      safeErrorMessage,
    });
  } catch {
    reportSendOutcomePersistenceFailure("failed");
  }
}

function reportSendOutcomePersistenceFailure(
  deliveryState: "send_unknown" | "failed",
): void {
  reportError(new Error("eSign send outcome bookkeeping failed."), {
    tags: {
      surface: "esign_send_outcome_bookkeeping",
      delivery_state: deliveryState,
    },
  });
}

class SafeActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: string, message: string): never {
  throw new SafeActionError(code, message);
}

async function safely<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await operation());
  } catch (error) {
    if (error instanceof SafeActionError) {
      return err({ code: error.code, message: error.message });
    }
    if (error instanceof ValidationError) {
      return err({
        code: "INVALID_SEND_INPUT",
        message: "The contract send details are invalid.",
      });
    }
    return err({
      code: "ESIGN_ACTION_FAILED",
      message: "The eSign action could not be completed.",
    });
  }
}

export function createDefaultLeadEsignActionDependencies(
  input: Omit<LeadEsignActionDependencies, "now" | "newId">,
): LeadEsignActionDependencies {
  return { ...input, now: () => new Date(), newId: () => randomUUID() };
}
