import "server-only";

import { randomUUID } from "node:crypto";

import { getCallerMemberships } from "@/lib/auth/memberships";
import type { Result } from "@/lib/errors/result";
import {
  ESIGN_TEMPLATE_MERGE_FIELDS,
  type TemplateOption,
  type TemplateSignerRole,
} from "@/lib/esign/contracts";
import {
  configuredDropboxSignEmbeddedDomain,
  getEsignCredentials,
} from "@/lib/esign/credentials";
import { createDropboxSignProvider } from "@/lib/esign/dropbox-sign";
import { classifyProviderFailure } from "@/lib/esign/provider-failure";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

import type {
  ContractMergeValues,
  LeadContractRow,
  LeadFileRow,
  SendBlockerCode,
} from "./esign-types";
import {
  createDefaultLeadEsignActionDependencies,
  createLeadEsignActionCore,
  type EsignActionProvider,
  type EsignActionRepository,
  type EsignActor,
  type EsignRequestRecord,
  type LeadSendContext,
  type ReminderCandidate,
  type SendClaim,
} from "./lead-esign-action-core";

const SIGNED_URL_SECONDS = 300;

export async function authenticateLeadEsignActor(): Promise<EsignActor | null> {
  const memberships = await getCallerMemberships();
  if (memberships.length !== 1) return null;
  return { orgId: memberships[0].org_id, userId: memberships[0].user_id };
}

export function createLeadEsignRepository(): EsignActionRepository {
  return {
    loadLeadSendContext,
    findRequestByIntent: async ({ orgId, sendIntentId }) => {
      const { data, error } = await createAdminClient()
        .from("esign_requests")
        .select("id")
        .eq("org_id", orgId)
        .eq("send_intent_id", sendIntentId)
        .maybeSingle();
      if (error) throw error;
      return data ? loadRequest(orgId, data.id) : null;
    },
    claimSend: claimSend,
    reconcileSent: async (input) => {
      const { error } = await createAdminClient().rpc(
        "reconcile_esign_request_delivery",
        {
          p_org_id: input.orgId,
          p_request_id: input.requestId,
          p_provider_request_id: input.providerRequestId,
          p_details_url: input.detailsUrl,
          p_provider_signatures: input.signatures as unknown as Json,
        },
      );
      if (error) throw error;
    },
    markSendOutcome: async (input) => {
      const { error } = await createAdminClient().rpc(
        "mark_esign_request_send_outcome",
        {
          p_org_id: input.orgId,
          p_request_id: input.requestId,
          p_delivery_state: input.deliveryState,
          p_error_message: input.safeErrorMessage,
        },
      );
      if (error) throw error;
    },
    findRequest: ({ orgId, requestId }) => loadRequest(orgId, requestId),
    claimReminder: async ({ orgId, requestId, signerId }) => {
      const claimToken = randomUUID();
      const { data, error } = await createAdminClient().rpc(
        "claim_esign_signer_reminder",
        {
          p_org_id: orgId,
          p_request_id: requestId,
          p_signer_id: signerId,
          p_claim_token: claimToken,
        },
      );
      if (error) throw error;
      const row = data?.[0];
      const fenced = mapProviderMutationClaimOutcome(row?.outcome);
      if (fenced) return fenced;
      if (!row || row.outcome === "ineligible")
        return { outcome: "ineligible" };
      if (row.outcome === "cooldown") return { outcome: "cooldown" };
      if (row.outcome !== "claimed")
        throw new Error("Unexpected reminder claim outcome.");
      const request = await loadRequest(orgId, requestId);
      const signer = request?.signers.find(
        (candidate) => candidate.id === signerId,
      );
      if (!request || !signer || !row.signer_name || !row.signer_email) {
        await releaseReminderRpc(orgId, requestId, signerId, claimToken);
        return { outcome: "ineligible" };
      }
      const candidate: ReminderCandidate = {
        claimToken,
        request,
        signer: {
          id: signer.id!,
          name: row.signer_name,
          emailAddress: row.signer_email,
          status: signer.status === "viewed" ? "viewed" : "awaiting",
          lastRemindedAt: signer.lastRemindedAt ?? null,
        },
      };
      return { outcome: "eligible", candidate };
    },
    finalizeReminder: async ({ orgId, requestId, signerId, claimToken }) => {
      const { data, error } = await createAdminClient().rpc(
        "finalize_esign_signer_reminder",
        {
          p_org_id: orgId,
          p_request_id: requestId,
          p_signer_id: signerId,
          p_claim_token: claimToken,
        },
      );
      if (error) throw error;
      return data === "applied" ? "applied" : "lease_lost";
    },
    releaseReminder: ({ orgId, requestId, signerId, claimToken }) =>
      releaseReminderRpc(orgId, requestId, signerId, claimToken),
    claimVoid: async ({ orgId, requestId }) => {
      const claimToken = randomUUID();
      const { data, error } = await createAdminClient().rpc(
        "claim_esign_request_void",
        {
          p_org_id: orgId,
          p_request_id: requestId,
          p_claim_token: claimToken,
        },
      );
      if (error) throw error;
      const row = data?.[0];
      const fenced = mapProviderMutationClaimOutcome(row?.outcome);
      if (fenced) return fenced;
      if (!row || row.outcome === "ineligible")
        return { outcome: "ineligible" };
      if (row.outcome !== "claimed")
        throw new Error("Unexpected void claim outcome.");
      const request = await loadRequest(orgId, requestId);
      if (!request) {
        await releaseVoidRpc(orgId, requestId, claimToken);
        return { outcome: "ineligible" };
      }
      return { outcome: "eligible", request, claimToken };
    },
    finalizeVoid: async ({ orgId, requestId, claimToken }) => {
      const { data, error } = await createAdminClient().rpc(
        "finalize_esign_request_void",
        {
          p_org_id: orgId,
          p_request_id: requestId,
          p_claim_token: claimToken,
        },
      );
      if (error) throw error;
      return data === "applied" ? "applied" : "lease_lost";
    },
    releaseVoid: ({ orgId, requestId, claimToken }) =>
      releaseVoidRpc(orgId, requestId, claimToken),
    findSignedFile: async ({ orgId, fileId }) => {
      const { data, error } = await createAdminClient()
        .from("lead_files")
        .select("id, source_request_id")
        .eq("org_id", orgId)
        .eq("id", fileId)
        .eq("source", "esign_signed_pdf")
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, requestId: data.source_request_id } : null;
    },
  };
}

async function releaseReminderRpc(
  orgId: string,
  requestId: string,
  signerId: string,
  claimToken: string,
) {
  const { data, error } = await createAdminClient().rpc(
    "release_esign_signer_reminder",
    {
      p_org_id: orgId,
      p_request_id: requestId,
      p_signer_id: signerId,
      p_claim_token: claimToken,
    },
  );
  if (error) throw error;
  return data === "released" ? ("released" as const) : ("lease_lost" as const);
}

export function isConsumedRetryConstraint(
  error: Readonly<{ code?: string; message?: string }>,
  retryOfRequestId: string | null,
): boolean {
  return Boolean(
    retryOfRequestId &&
    error.code === "23505" &&
    error.message?.includes("esign_requests_one_retry_child_per_source_idx"),
  );
}

export function consumedRetryRequestIds(
  requests: readonly Readonly<{ retry_of_request_id: string | null }>[],
): ReadonlySet<string> {
  return new Set(
    requests.flatMap((request) =>
      request.retry_of_request_id ? [request.retry_of_request_id] : [],
    ),
  );
}

async function releaseVoidRpc(
  orgId: string,
  requestId: string,
  claimToken: string,
) {
  const { data, error } = await createAdminClient().rpc(
    "release_esign_request_void",
    {
      p_org_id: orgId,
      p_request_id: requestId,
      p_claim_token: claimToken,
    },
  );
  if (error) throw error;
  return data === "released" ? ("released" as const) : ("lease_lost" as const);
}

async function loadLeadSendContext({
  actor,
  propertyId,
}: {
  actor: EsignActor;
  propertyId: string;
}): Promise<LeadSendContext | null> {
  const admin = createAdminClient();
  const { data: property, error } = await admin
    .from("properties")
    .select("id, org_id, address, city, state, zip, homeowner_contact_id")
    .eq("id", propertyId)
    .eq("org_id", actor.orgId)
    .maybeSingle();
  if (error) throw error;
  if (!property) return null;
  const [contactResult, integrationResult, templatesResult] = await Promise.all(
    [
      property.homeowner_contact_id
        ? admin
            .from("contacts")
            .select("first_name,last_name,entity_name,contact_type,email")
            .eq("id", property.homeowner_contact_id)
            .eq("org_id", actor.orgId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      admin
        .from("org_esign_integrations")
        .select("sending_enabled,test_mode")
        .eq("org_id", actor.orgId)
        .maybeSingle(),
      admin
        .from("available_esign_templates")
        .select(
          "id,name,document_type,sign_template_id,seller_role,signer_roles,merge_field_names",
        )
        .eq("org_id", actor.orgId)
        .order("updated_at", { ascending: false }),
    ],
  );
  if (contactResult.error) throw contactResult.error;
  if (integrationResult.error) throw integrationResult.error;
  if (templatesResult.error) throw templatesResult.error;
  const contact = contactResult.data;
  const sellerName =
    contact?.contact_type === "entity"
      ? (contact.entity_name ?? "")
      : [contact?.first_name, contact?.last_name].filter(Boolean).join(" ");
  return {
    propertyId: property.id,
    sellerName,
    sellerEmailAddress: contact?.email ?? null,
    propertyAddress: [
      property.address,
      property.city,
      property.state,
      property.zip,
    ]
      .filter(Boolean)
      .join(", "),
    connected: Boolean(integrationResult.data),
    sendingEnabled: integrationResult.data?.sending_enabled ?? false,
    testMode: true,
    templates: (templatesResult.data ?? []).flatMap(toTemplateOption),
  };
}

function toTemplateOption(row: {
  id: string | null;
  name: string | null;
  document_type: string | null;
  sign_template_id: string | null;
  seller_role: string | null;
  signer_roles: Json | null;
  merge_field_names: string[] | null;
}): TemplateOption[] {
  const roles = parseRoles(row.signer_roles);
  if (
    !row.id ||
    !row.name ||
    !row.document_type ||
    !row.sign_template_id ||
    !row.seller_role ||
    !roles
  )
    return [];
  if (!sameMergeFields(row.merge_field_names)) return [];
  return [
    {
      id: row.id,
      name: row.name,
      documentType: row.document_type,
      providerTemplateId: row.sign_template_id,
      sellerRoleName: row.seller_role,
      signerRoles: roles,
      mergeFieldNames: ESIGN_TEMPLATE_MERGE_FIELDS,
    },
  ];
}

function parseRoles(value: Json | null): readonly TemplateSignerRole[] | null {
  if (!Array.isArray(value)) return null;
  const roles: TemplateSignerRole[] = [];
  for (const item of value) {
    if (!item || Array.isArray(item) || typeof item !== "object") return null;
    const name = item.name;
    const order = item.order;
    if (typeof name !== "string" || typeof order !== "number") return null;
    roles.push({ name, order });
  }
  return roles.sort((a, b) => a.order - b.order);
}

function sameMergeFields(value: string[] | null): boolean {
  return Boolean(
    value &&
    value.length === ESIGN_TEMPLATE_MERGE_FIELDS.length &&
    [...value]
      .sort()
      .every(
        (field, index) =>
          field === [...ESIGN_TEMPLATE_MERGE_FIELDS].sort()[index],
      ),
  );
}

async function claimSend(
  input: Parameters<EsignActionRepository["claimSend"]>[0],
): Promise<SendClaim> {
  const { data, error } = await createAdminClient().rpc(
    "create_esign_request",
    {
      p_org_id: input.actor.orgId,
      p_property_id: input.propertyId,
      p_template_id: input.template.id,
      p_signer_snapshot: input.signers as unknown as Json,
      p_merge_value_snapshot: input.mergeValues as unknown as Json,
      p_send_intent_id: input.sendIntentId,
      p_payload_hash: input.payloadHash,
      p_retry_of_request_id: input.retryOfRequestId,
      p_actor_id: input.actor.userId,
    },
  );
  if (error) {
    if (isConsumedRetryConstraint(error, input.retryOfRequestId)) {
      return { outcome: "retry_ineligible" };
    }
    throw error;
  }
  const row = data?.[0];
  if (!row) throw new Error("Missing send claim result.");
  if (row.outcome === "intent_conflict") return { outcome: "intent_conflict" };
  if (row.outcome === "blocked") {
    const safeOutcome = mapAtomicSendBlocker(row.blocker_code);
    if (safeOutcome) return safeOutcome;
    const blocker: SendBlockerCode =
      row.blocker_code === "MISSING_HOMEOWNER_EMAIL"
        ? "owner_email_missing"
        : row.blocker_code === "FINALIZED_TEMPLATE_NOT_FOUND"
          ? "no_templates"
          : "sending_disabled";
    return { outcome: "blocked", blocker };
  }
  if (!row.id) throw new Error("Missing claimed request ID.");
  const request = await loadRequest(input.actor.orgId, row.id);
  if (!request) throw new Error("Claimed request not found.");
  return {
    outcome: row.outcome === "created" ? "created" : "existing",
    request,
  };
}

export function mapAtomicSendBlocker(
  blockerCode: string | null,
): SendClaim | null {
  if (blockerCode === "RETRY_NOT_ELIGIBLE")
    return { outcome: "retry_ineligible" };
  if (blockerCode === "ACTIVE_MEMBERSHIP_REQUIRED")
    return { outcome: "authorization_changed" };
  if (blockerCode === "PROPERTY_NOT_FOUND") return { outcome: "not_found" };
  return null;
}

export function mapProviderMutationClaimOutcome(
  outcome: string | null | undefined,
):
  | Readonly<{ outcome: "in_progress" }>
  | Readonly<{ outcome: "reconciliation_required" }>
  | null {
  if (outcome === "in_progress") return { outcome: "in_progress" };
  if (outcome === "reconciliation_required") {
    return { outcome: "reconciliation_required" };
  }
  return null;
}

async function loadRequest(
  orgId: string,
  requestId: string,
): Promise<EsignRequestRecord | null> {
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("esign_requests")
    .select(
      "id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,send_intent_id,payload_hash,retry_of_request_id,status,delivery_state,sign_request_id,details_url,void_requested_at,signed_pdf_path,error_message,sent_at,test_mode",
    )
    .eq("org_id", orgId)
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;
  const [
    { data: templateRow, error: templateError },
    { data: signerRows, error: signerError },
    { data: fileRow, error: fileError },
  ] = await Promise.all([
    admin
      .from("esign_templates")
      .select(
        "id,name,document_type,sign_template_id,seller_role,signer_roles,merge_field_names",
      )
      .eq("org_id", orgId)
      .eq("id", row.template_id)
      .maybeSingle(),
    admin
      .from("esign_request_signers")
      .select(
        "id,role_name,signer_order,signer_name,signer_email,status,last_reminded_at",
      )
      .eq("org_id", orgId)
      .eq("request_id", requestId)
      .order("signer_order"),
    admin
      .from("lead_files")
      .select("id")
      .eq("org_id", orgId)
      .eq("source_request_id", requestId)
      .eq("source", "esign_signed_pdf")
      .maybeSingle(),
  ]);
  if (templateError) throw templateError;
  if (signerError) throw signerError;
  if (fileError) throw fileError;
  const template = templateRow ? toTemplateOption(templateRow)[0] : null;
  if (!template) throw new Error("Request template snapshot is unavailable.");
  const merge = parseMergeValues(row.merge_value_snapshot);
  if (!merge) throw new Error("Request merge snapshot is invalid.");
  return {
    id: row.id,
    orgId: row.org_id,
    propertyId: row.property_id,
    template,
    signers: (signerRows ?? []).map((signer) => ({
      id: signer.id,
      role: signer.role_name,
      order: signer.signer_order,
      name: signer.signer_name,
      emailAddress: signer.signer_email,
      status: signer.status,
      lastRemindedAt: signer.last_reminded_at,
    })) as EsignRequestRecord["signers"],
    mergeValues: merge,
    sendIntentId: row.send_intent_id,
    payloadHash: row.payload_hash,
    retryOfRequestId: row.retry_of_request_id,
    status: row.status,
    deliveryState: row.delivery_state,
    providerRequestId: row.sign_request_id,
    detailsUrl: row.details_url,
    voidRequestedAt: row.void_requested_at,
    signedPdfFileId: fileRow?.id ?? null,
  };
}

function parseMergeValues(value: Json): ContractMergeValues | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const result: Record<string, string> = {};
  for (const field of ESIGN_TEMPLATE_MERGE_FIELDS) {
    if (typeof value[field] !== "string") return null;
    result[field] = value[field];
  }
  return result as ContractMergeValues;
}

export async function providerForOrg(
  orgId: string,
): Promise<EsignActionProvider | null> {
  const credentials = await getEsignCredentials(orgId);
  if (!credentials?.sendingEnabled) return null;
  const provider = createDropboxSignProvider({
    apiKey: credentials.apiKey,
    clientId: credentials.clientId,
    expectedDomain: configuredDropboxSignEmbeddedDomain(),
  });
  return {
    sendWithTemplate: async ({
      localRequestId,
      providerTemplateId,
      signers,
      mergeValues,
      signal,
    }) => {
      try {
        const output = await provider.sendWithTemplate({
          localRequestId,
          templateId: providerTemplateId,
          signers: signers.map(({ role, name, emailAddress }) => ({
            role,
            name,
            emailAddress,
          })),
          mergeValues,
          signal,
        });
        if (!output.detailsUrl) return { outcome: "ambiguous" };
        return {
          outcome: "sent",
          providerRequestId: output.signatureRequestId,
          detailsUrl: output.detailsUrl,
          signatures: output.signatures,
        };
      } catch (error) {
        return { outcome: classifyProviderFailure(error) };
      }
    },
    remind: async ({
      providerRequestId,
      signerName,
      signerEmailAddress,
      signal,
    }) => {
      try {
        await provider.remind(
          providerRequestId,
          { name: signerName, emailAddress: signerEmailAddress },
          signal,
        );
        return "accepted";
      } catch (error) {
        return classifyProviderFailure(error);
      }
    },
    cancel: async ({ providerRequestId, signal }) => {
      try {
        await provider.cancel(providerRequestId, signal);
        return "accepted";
      } catch (error) {
        return classifyProviderFailure(error);
      }
    },
  };
}

export function createBoundLeadEsignCore() {
  const repository = createLeadEsignRepository();
  return createLeadEsignActionCore(
    createDefaultLeadEsignActionDependencies({
      authenticate: authenticateLeadEsignActor,
      repository,
      providerForOrg,
      files: {
        authorizeSignedFile: async ({ actor, fileId, requestId }) => {
          const { data: file, error } = await createAdminClient()
            .from("lead_files")
            .select("storage_bucket,storage_path,source_request_id")
            .eq("org_id", actor.orgId)
            .eq("id", fileId)
            .eq("source_request_id", requestId)
            .maybeSingle();
          if (error || !file) return null;
          const { data, error: signError } = await createAdminClient()
            .storage.from(file.storage_bucket)
            .createSignedUrl(file.storage_path, SIGNED_URL_SECONDS);
          if (signError || !data?.signedUrl) return null;
          return {
            url: data.signedUrl,
            expiresAt: new Date(Date.now() + SIGNED_URL_SECONDS * 1_000),
          };
        },
      },
    }),
  );
}

export type LeadEsignPageModel = Readonly<{
  blockers: readonly SendBlockerCode[];
  contracts: readonly LeadContractRow[];
  files: readonly LeadFileRow[];
  contractsError: string | null;
  filesError: string | null;
}>;

export async function loadLeadEsignPageModel(
  propertyId: string,
): Promise<LeadEsignPageModel> {
  const actor = await authenticateLeadEsignActor();
  if (!actor)
    return {
      blockers: ["provider_disconnected"],
      contracts: [],
      files: [],
      contractsError: "Sign in with active organization access.",
      filesError: "Sign in with active organization access.",
    };
  const repository = createLeadEsignRepository();
  const context = await repository.loadLeadSendContext({ actor, propertyId });
  const blockers: SendBlockerCode[] = !context
    ? ["provider_disconnected"]
    : [
        ...(!context.connected ? ["provider_disconnected" as const] : []),
        ...(!context.sendingEnabled ? ["sending_disabled" as const] : []),
        ...(context.templates.length === 0 ? ["no_templates" as const] : []),
        ...(!context.sellerEmailAddress?.trim()
          ? ["owner_email_missing" as const]
          : []),
      ];
  const admin = createAdminClient();
  const [requestsResult, filesResult] = await Promise.all([
    admin
      .from("esign_requests")
      .select("id,retry_of_request_id")
      .eq("org_id", actor.orgId)
      .eq("property_id", propertyId)
      .order("created_at", { ascending: false })
      .limit(100),
    admin
      .from("lead_files")
      .select("id,file_name,created_at,size_bytes")
      .eq("org_id", actor.orgId)
      .eq("property_id", propertyId)
      .eq("source", "esign_signed_pdf")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  const contracts: LeadContractRow[] = [];
  if (!requestsResult.error) {
    const consumedRequestIds = consumedRetryRequestIds(requestsResult.data ?? []);
    for (const item of requestsResult.data ?? []) {
      const request = await loadRequest(actor.orgId, item.id);
      if (!request) continue;
      const { data: row } = await admin
        .from("esign_requests")
        .select("sent_at,error_message,test_mode")
        .eq("org_id", actor.orgId)
        .eq("id", item.id)
        .single();
      contracts.push({
        id: request.id,
        templateName: request.template.name,
        signers: request.signers as LeadContractRow["signers"],
        status: request.status,
        deliveryState: request.deliveryState,
        testMode: row?.test_mode ?? true,
        sentAt: row?.sent_at ?? null,
        detailsAvailable: request.detailsUrl !== null,
        voidRequestedAt: request.voidRequestedAt,
        signedPdfFileId: request.signedPdfFileId,
        errorMessage: row?.error_message ?? null,
        retryConsumed: consumedRequestIds.has(request.id),
      });
    }
  }
  return {
    blockers,
    contracts,
    files: (filesResult.data ?? []).map((file) => ({
      id: file.id,
      displayName: file.file_name,
      kind: "signed_contract",
      createdAt: file.created_at,
      sizeBytes: file.size_bytes,
    })),
    contractsError: requestsResult.error
      ? "Contract history is unavailable."
      : null,
    filesError: filesResult.error ? "Lead files are unavailable." : null,
  };
}

export type LeadEsignActionResult = Result<unknown>;
