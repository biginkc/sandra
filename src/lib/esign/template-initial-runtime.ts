import "server-only";

import { createHash } from "node:crypto";

import { getCallerMemberships } from "@/lib/auth/memberships";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  getEsignCredentials,
  configuredDropboxSignEmbeddedDomain,
} from "./credentials";
import { createDropboxSignProvider } from "./dropbox-sign";
import {
  runInitialProviderCreate,
  type InitialProviderCreatePorts,
  type ProviderCreateState,
} from "./initial-template-provider-create";
import { cleanupUnattachedSource } from "./unattached-source-cleanup";
import {
  ESIGN_TEMPLATE_MAX_PDF_BYTES,
  type TemplateActionResult,
} from "./template-orchestrator";
import type { TemplateSignerRole } from "./template-contract";

const BUCKET = "esign-staging" as const;

export type PreparedSource = Readonly<{
  stagingSourceId: string;
  bucket: typeof BUCKET;
  storagePath: string;
}>;
export type PreparedSourceMetadata = Readonly<{
  stagingSourceId: string;
  filename: string;
  size: number;
  mimeType: "application/pdf";
  sha256: string;
}>;

export async function createInitialTemplateRuntime() {
  const membership = (await getCallerMemberships())[0];
  if (!membership) throw new Error("AUTH_REQUIRED");
  if (membership.role !== "owner") throw new Error("OWNER_REQUIRED");
  const actorId = membership.user_id;
  const orgId = membership.org_id;
  const admin = createAdminClient();

  const cleanup = async (
    source: PreparedSource,
  ): Promise<TemplateActionResult<null>> =>
    cleanupUnattachedSource(
      {
        orgId,
        sourceId: source.stagingSourceId,
        storagePath: source.storagePath,
        actorId,
      },
      {
        async claim(input) {
          const { data, error } = await admin.rpc(
            "claim_unattached_esign_template_source_cleanup",
            {
              p_org_id: input.orgId,
              p_source_id: input.sourceId,
              p_storage_path: input.storagePath,
              p_actor_id: input.actorId,
            },
          );
          const row = data?.[0];
          if (
            error ||
            !row ||
            !["claimed", "already_in_progress", "already_deleted"].includes(
              row.outcome,
            )
          )
            throw error ?? new Error("invalid cleanup claim");
          return {
            outcome: row.outcome as
              "claimed" | "already_in_progress" | "already_deleted",
            sourceId: row.source_id,
            cleanupToken: row.cleanup_token,
            createdBy: row.created_by,
          };
        },
        async deletePrivate(path) {
          const { data, error } = await admin.storage
            .from(BUCKET)
            .remove([path]);
          if (error) throw error;
          if (data.length === 0) return "already_absent";
          if (data.length === 1 && data[0]?.name === path) return "deleted";
          throw new Error("unexpected storage deletion result");
        },
        async complete(input) {
          const { data, error } = await admin.rpc(
            "complete_unattached_esign_template_source_cleanup",
            {
              p_org_id: input.orgId,
              p_source_id: input.sourceId,
              p_storage_path: input.storagePath,
              p_cleanup_token: input.cleanupToken,
              p_outcome: input.outcome,
              p_safe_code: input.errorCode,
              p_actor_id: input.actorId,
            },
          );
          const row = data?.[0];
          if (
            error ||
            !row ||
            !["deleted", "already_deleted", "failed"].includes(row.outcome)
          )
            throw error ?? new Error("invalid cleanup completion");
          return {
            outcome: row.outcome as "deleted" | "already_deleted" | "failed",
            sourceId: row.source_id,
            createdBy: row.created_by,
          };
        },
      },
    );

  const runtime = {
    async listRecoveries(): Promise<
      TemplateActionResult<
        readonly (
          | {
              id: string;
              name: string;
              lifecycle: "cleanup_attention";
              kind: "source_cleanup";
            }
          | {
              id: string;
              name: string;
              lifecycle: "provider_attention";
              kind: "provider_create";
              providerCreateState:
                "unstarted" | "claimed" | "invoking" | "unknown" | "attached";
            }
        )[]
      >
    > {
      const [sources, providers] = await Promise.all([
        admin.rpc("list_pending_esign_template_source_uploads", {
          p_org_id: orgId,
          p_actor_id: actorId,
        }),
        admin.rpc("list_pending_esign_template_provider_creates", {
          p_org_id: orgId,
          p_actor_id: actorId,
        }),
      ]);
      if (sources.error || providers.error)
        return failure(
          "TEMPLATE_RECOVERY_LIST_FAILED",
          "Template recovery state could not be loaded.",
        );
      return success([
        ...(sources.data ?? []).map((row) => ({
          id: row.source_id,
          name: row.source_filename,
          lifecycle: "cleanup_attention" as const,
          kind: "source_cleanup" as const,
        })),
        ...(providers.data ?? []).map((row) => ({
          id: row.template_id,
          name: row.name,
          lifecycle: "provider_attention" as const,
          kind: "provider_create" as const,
          providerCreateState: row.provider_create_state as
            "unstarted" | "claimed" | "invoking" | "unknown" | "attached",
        })),
      ]);
    },
    async promoteStaleProviderCreate(
      templateId: string,
    ): Promise<
      TemplateActionResult<{
        templateId: string;
        providerCreateState: "unknown" | "attached";
      }>
    > {
      if (!isOpaqueId(templateId))
        return failure(
          "PROVIDER_RECOVERY_INVALID",
          "The hidden template reference is invalid.",
        );
      const { data: pending, error: pendingError } = await admin.rpc(
        "list_pending_esign_template_provider_creates",
        { p_org_id: orgId, p_actor_id: actorId },
      );
      const recovery = pending?.find(
        (row) =>
          row.template_id === templateId &&
          row.provider_create_state === "invoking",
      );
      if (pendingError || !recovery)
        return failure(
          "PROVIDER_RECOVERY_UNAVAILABLE",
          "This provider invocation is not awaiting stale recovery.",
        );
      const result = (await admin.rpc(
        "mark_stale_esign_template_provider_create_unknown" as never,
        {
          p_org_id: orgId,
          p_template_id: recovery.template_id,
          p_source_id: recovery.source_id,
          p_actor_id: actorId,
        } as never,
      )) as unknown as {
        data: Array<{
          outcome: string;
          template_id: string;
          provider_create_state: string;
          created_by: string;
        }> | null;
        error: unknown;
      };
      const row = result.data?.[0];
      if (
        result.error ||
        !row ||
        row.template_id !== templateId ||
        !["recorded_unknown", "already_unknown", "already_attached"].includes(
          row.outcome,
        ) ||
        !["unknown", "attached"].includes(row.provider_create_state)
      ) {
        return failure(
          "PROVIDER_RECOVERY_NOT_STALE",
          "Provider creation is still in progress. Try again after the recovery window.",
        );
      }
      return success({
        templateId: row.template_id,
        providerCreateState: row.provider_create_state as
          "unknown" | "attached",
      });
    },
    async cleanupSource(sourceId: string): Promise<TemplateActionResult<null>> {
      const { data, error } = await admin.rpc(
        "list_pending_esign_template_source_uploads",
        { p_org_id: orgId, p_actor_id: actorId },
      );
      if (error)
        return failure(
          "SOURCE_CLEANUP_READ_FAILED",
          "The private source cleanup state could not be loaded.",
        );
      const row = data?.find((candidate) => candidate.source_id === sourceId);
      if (
        !row ||
        row.storage_bucket !== BUCKET ||
        row.storage_path !== `${orgId}/${sourceId}.pdf`
      ) {
        return failure(
          "SOURCE_CLEANUP_INVALID",
          "The private source is not available for cleanup.",
        );
      }
      return cleanup({
        stagingSourceId: row.source_id,
        bucket: BUCKET,
        storagePath: row.storage_path,
      });
    },
    async reconcileUnknown(
      templateId: string,
      providerTemplateId: string,
    ): Promise<TemplateActionResult<{ templateId: string }>> {
      if (
        !isOpaqueId(templateId) ||
        !providerTemplateId.trim() ||
        providerTemplateId.length > 255
      ) {
        return failure(
          "PROVIDER_RECONCILE_INVALID",
          "The provider template reference is invalid.",
        );
      }
      const { data: pending, error: pendingError } = await admin.rpc(
        "list_pending_esign_template_provider_creates",
        { p_org_id: orgId, p_actor_id: actorId },
      );
      if (pendingError)
        return failure(
          "PROVIDER_RECONCILE_READ_FAILED",
          "Provider recovery state could not be loaded.",
        );
      const row = pending?.find(
        (candidate) =>
          candidate.template_id === templateId &&
          candidate.provider_create_state === "unknown",
      );
      if (!row)
        return failure(
          "PROVIDER_RECONCILE_UNAVAILABLE",
          "This template is not awaiting manual provider reconciliation.",
        );
      const { data: local, error: localError } = await admin
        .from("esign_templates")
        .select(
          "id,name,signer_roles,seller_role,merge_field_names,staging_source_id,provider_account_id,provider_create_state,sign_template_id",
        )
        .eq("org_id", orgId)
        .eq("id", templateId)
        .maybeSingle();
      if (
        localError ||
        !local ||
        local.provider_create_state !== "unknown" ||
        local.staging_source_id !== row.source_id ||
        local.sign_template_id !== null ||
        !local.provider_account_id
      ) {
        return failure(
          "PROVIDER_RECONCILE_CONTRACT_MISMATCH",
          "The hidden template contract could not be verified.",
        );
      }
      const credentials = await getEsignCredentials(orgId);
      if (
        !credentials ||
        credentials.providerAccountId !== local.provider_account_id
      ) {
        return failure(
          "PROVIDER_ACCOUNT_MISMATCH",
          "Dropbox Sign is not connected to the template's original account.",
        );
      }
      let candidate;
      try {
        const provider = createDropboxSignProvider({
          apiKey: credentials.apiKey,
          clientId: credentials.clientId,
          expectedDomain: configuredDropboxSignEmbeddedDomain(),
        });
        candidate = await provider.getTemplate(providerTemplateId.trim());
      } catch {
        return failure(
          "PROVIDER_RECONCILE_LOOKUP_FAILED",
          "The Dropbox Sign template could not be verified.",
        );
      }
      const localRoles = parseSignerRoles(local.signer_roles);
      if (
        !providerReconciliationCandidateMatches({
          expectedProviderTemplateId: providerTemplateId.trim(),
          expectedLocalTemplateId: templateId,
          expectedTitle: local.name,
          expectedRoles: localRoles,
          sellerRoleName: local.seller_role,
          expectedMergeFields: local.merge_field_names,
          candidate,
        })
      ) {
        return failure(
          "PROVIDER_RECONCILE_CANDIDATE_MISMATCH",
          "The Dropbox Sign template does not match the hidden Sandra draft.",
        );
      }
      const { data, error } = await admin.rpc(
        "reconcile_unknown_esign_template_provider_create",
        {
          p_org_id: orgId,
          p_template_id: row.template_id,
          p_source_id: row.source_id,
          p_provider_template_id: providerTemplateId.trim(),
          p_actor_id: actorId,
        },
      );
      const reconciled = data?.[0];
      if (
        error ||
        !reconciled ||
        !["attached", "already_attached"].includes(reconciled.outcome) ||
        reconciled.template_id !== templateId ||
        reconciled.provider_template_id !== providerTemplateId.trim()
      ) {
        return failure(
          "PROVIDER_RECONCILE_FAILED",
          "The provider template could not be reconciled safely.",
        );
      }
      return success({ templateId: reconciled.template_id });
    },
    async prepare(
      metadata: PreparedSourceMetadata,
    ): Promise<TemplateActionResult<PreparedSource>> {
      if (!validMetadata(metadata))
        return failure(
          "STAGING_METADATA_INVALID",
          "Choose one valid PDF up to 40 MB.",
        );
      if (!isOpaqueId(metadata.stagingSourceId)) {
        return failure(
          "STAGING_SOURCE_INVALID",
          "The private upload reservation is invalid.",
        );
      }
      const sourceId = metadata.stagingSourceId;
      const { data, error } = await admin.rpc(
        "prepare_esign_template_source_upload",
        {
          p_org_id: orgId,
          p_source_id: sourceId,
          p_source_filename: metadata.filename,
          p_source_size_bytes: metadata.size,
          p_content_type: metadata.mimeType,
          p_source_sha256: metadata.sha256,
          p_actor_id: actorId,
        },
      );
      const row = data?.[0];
      if (
        error ||
        !row ||
        !["prepared", "existing_same_contract"].includes(row.outcome) ||
        row.source_id !== sourceId ||
        row.storage_bucket !== BUCKET ||
        row.storage_path !== `${orgId}/${sourceId}.pdf`
      ) {
        return failure(
          "STAGING_PREPARE_FAILED",
          "The private upload reservation could not be prepared.",
        );
      }
      return success({
        stagingSourceId: row.source_id,
        bucket: BUCKET,
        storagePath: row.storage_path,
      });
    },

    async create(input: {
      source: PreparedSource & PreparedSourceMetadata;
      name: string;
      documentType: string;
      signerRoles: readonly TemplateSignerRole[];
      sellerRoleName: string;
      beforeProviderCreate?: (
        replacementTemplateId: string,
      ) => Promise<TemplateActionResult<{ cleanupAttention: boolean }>>;
    }): Promise<
      TemplateActionResult<{
        templateId: string;
        initialEditorSession: {
          providerTemplateId: string;
          editUrl: string;
          expiresAt: number | null;
          clientId: string;
        } | null;
        cleanupAttention?: boolean;
      }>
    > {
      const expectedPath = `${orgId}/${input.source.stagingSourceId}.pdf`;
      if (
        input.source.bucket !== BUCKET ||
        input.source.storagePath !== expectedPath ||
        !validMetadata(input.source)
      ) {
        return failure(
          "STAGING_SOURCE_INVALID",
          "The private upload reservation is invalid.",
        );
      }
      let bytes: Uint8Array;
      try {
        const { data, error } = await admin.storage
          .from(BUCKET)
          .download(input.source.storagePath);
        if (error) throw error;
        bytes = new Uint8Array(await data.arrayBuffer());
      } catch {
        return failure(
          "STAGING_VERIFY_READ_FAILED",
          "The private PDF could not be verified. Its reservation remains available for recovery.",
        );
      }
      const actualSha = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.byteLength !== input.source.size ||
        bytes.byteLength > ESIGN_TEMPLATE_MAX_PDF_BYTES ||
        bytes.byteLength === 0 ||
        !hasPdfMagic(bytes) ||
        actualSha !== input.source.sha256
      ) {
        return failure(
          "STAGING_VERIFY_FAILED",
          "The stored PDF did not match its reservation. Cleanup remains available.",
        );
      }
      const { data: verifiedData, error: verifiedError } = await admin.rpc(
        "verify_esign_template_source_upload",
        {
          p_org_id: orgId,
          p_source_id: input.source.stagingSourceId,
          p_storage_path: input.source.storagePath,
          p_observed_size_bytes: bytes.byteLength,
          p_observed_content_type: "application/pdf",
          p_observed_sha256: actualSha,
          p_actor_id: actorId,
        },
      );
      const verified = verifiedData?.[0];
      if (
        verifiedError ||
        !verified ||
        verified.source_id !== input.source.stagingSourceId ||
        !["verified", "already_verified"].includes(verified.outcome)
      ) {
        return failure(
          "STAGING_VERIFY_RECORD_FAILED",
          "The verified PDF could not be recorded. Its reservation remains available for recovery.",
        );
      }
      const { data: consumedData, error: consumedError } = await admin.rpc(
        "consume_esign_template_source_draft",
        {
          p_org_id: orgId,
          p_source_id: input.source.stagingSourceId,
          p_name: input.name,
          p_document_type: input.documentType,
          p_seller_role: input.sellerRoleName,
          p_signer_roles: input.signerRoles.map((role) => ({ ...role })),
          p_actor_id: actorId,
        },
      );
      const consumed = consumedData?.[0];
      if (
        consumedError ||
        !consumed ||
        !["created", "existing_same_contract"].includes(consumed.outcome)
      ) {
        return failure(
          "DRAFT_CONSUME_FAILED",
          "The hidden template draft could not be reconciled.",
        );
      }

      let cleanupAttention: boolean | undefined;
      if (input.beforeProviderCreate) {
        const retired = await input.beforeProviderCreate(consumed.template_id);
        if (!retired.ok) return retired;
        cleanupAttention = retired.data.cleanupAttention;
      }

      let cachedCredentials: Awaited<ReturnType<typeof getEsignCredentials>> =
        null;
      const providerResult = await runInitialProviderCreate(
        {
          orgId,
          templateId: consumed.template_id,
          sourceId: input.source.stagingSourceId,
          actorId,
        },
        providerPorts({
          admin,
          orgId,
          actorId,
          localTemplateId: consumed.template_id,
          bytes,
          input,
          getCredentials: async () => {
            cachedCredentials ??= await getEsignCredentials(orgId);
            return cachedCredentials;
          },
        }),
      );
      if (!providerResult.ok) return providerResult;
      const created = {
        templateId: providerResult.data.templateId,
        initialEditorSession: providerResult.data.initialEditorSession,
      };
      return success(
        cleanupAttention === undefined
          ? created
          : { ...created, cleanupAttention },
      );
    },
    async retryProviderCreate(
      templateId: string,
    ): Promise<TemplateActionResult<{ templateId: string }>> {
      if (!isOpaqueId(templateId)) {
        return failure("PROVIDER_RETRY_INVALID", "The hidden template reference is invalid.");
      }
      const { data: pending, error: pendingError } = await admin.rpc(
        "list_pending_esign_template_provider_creates",
        { p_org_id: orgId, p_actor_id: actorId },
      );
      const recovery = pending?.find((row) =>
        row.template_id === templateId && row.provider_create_state === "unstarted"
      );
      if (pendingError || !recovery) {
        return failure("PROVIDER_RETRY_UNAVAILABLE", "This template is not awaiting a safe provider retry.");
      }
      const { data: draft, error: draftError } = await admin
        .from("esign_templates")
        .select("id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,sign_template_id,staging_source_id,source_filename,source_size_bytes,source_content_type,source_sha256,staging_path,lifecycle_state,provider_create_state,provider_create_last_released_token_hash,duplicate_of_template_id,supersedes_template_id,finalized_at,deleted_at,abandoned_at")
        .eq("org_id", orgId)
        .eq("id", templateId)
        .maybeSingle();
      if (
        draftError || !draft || draft.org_id !== orgId || draft.id !== templateId ||
        draft.lifecycle_state !== "preparing" || draft.provider_create_state !== "unstarted" ||
        !draft.provider_create_last_released_token_hash || draft.sign_template_id !== null ||
        draft.staging_source_id !== recovery.source_id ||
        draft.staging_path !== `${orgId}/${recovery.source_id}.pdf` ||
        draft.duplicate_of_template_id !== null || draft.supersedes_template_id !== null ||
        draft.finalized_at !== null || draft.deleted_at !== null || draft.abandoned_at !== null ||
        !draft.source_filename || !draft.source_size_bytes ||
        draft.source_content_type !== "application/pdf" || !draft.source_sha256
      ) {
        return failure("PROVIDER_RETRY_CONTRACT_MISMATCH", "The hidden retryable template contract could not be verified.");
      }
      const signerRoles = parseSignerRoles(draft.signer_roles);
      if (
        signerRoles.length === 0 ||
        !signerRoles.some((role) => role.name === draft.seller_role) ||
        !exactFiveFields(draft.merge_field_names)
      ) {
        return failure("PROVIDER_RETRY_CONTRACT_MISMATCH", "The hidden retryable template contract could not be verified.");
      }
      let bytes: Uint8Array;
      try {
        const { data, error } = await admin.storage.from(BUCKET).download(draft.staging_path);
        if (error) throw error;
        bytes = new Uint8Array(await data.arrayBuffer());
      } catch {
        return failure("PROVIDER_RETRY_SOURCE_UNAVAILABLE", "The retained private PDF could not be read for retry.");
      }
      const actualSha = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.byteLength !== draft.source_size_bytes || bytes.byteLength === 0 ||
        bytes.byteLength > ESIGN_TEMPLATE_MAX_PDF_BYTES || !hasPdfMagic(bytes) ||
        actualSha !== draft.source_sha256
      ) {
        return failure("PROVIDER_RETRY_SOURCE_MISMATCH", "The retained private PDF no longer matches the retryable draft.");
      }
      let cachedCredentials: Awaited<ReturnType<typeof getEsignCredentials>> = null;
      const result = await runInitialProviderCreate(
        { orgId, templateId, sourceId: recovery.source_id, actorId },
        providerPorts({
          admin, orgId, actorId, localTemplateId: templateId, bytes,
          input: {
            source: {
              stagingSourceId: recovery.source_id, bucket: BUCKET,
              storagePath: draft.staging_path, filename: draft.source_filename,
              size: draft.source_size_bytes, mimeType: "application/pdf",
              sha256: draft.source_sha256,
            },
            name: draft.name, documentType: draft.document_type,
            signerRoles, sellerRoleName: draft.seller_role,
          },
          getCredentials: async () => {
            cachedCredentials ??= await getEsignCredentials(orgId);
            return cachedCredentials;
          },
        }),
      );
      return result.ok ? success({ templateId: result.data.templateId }) : result;
    },
    async createReplacementFromRetainedSource(
      templateId: string,
      retireOriginal: (
        replacementTemplateId: string,
      ) => Promise<TemplateActionResult<{ cleanupAttention: boolean }>>,
    ): Promise<
      TemplateActionResult<{
        templateId: string;
        initialEditorSession: {
          providerTemplateId: string;
          editUrl: string;
          expiresAt: number | null;
          clientId: string;
        } | null;
        cleanupAttention: boolean;
      }>
    > {
      if (!isOpaqueId(templateId)) {
        return failure(
          "PLACEMENT_RESTART_INVALID",
          "The unfinished template reference is invalid.",
        );
      }
      const { data: draft, error: draftError } = await admin
        .from("esign_templates")
        .select(
          "id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,sign_template_id,staging_source_id,source_filename,source_size_bytes,source_content_type,source_sha256,staging_path,staging_deleted_at,lifecycle_state,provider_create_state,duplicate_of_template_id,supersedes_template_id,finalized_at,deleted_at,abandoned_at",
        )
        .eq("org_id", orgId)
        .eq("id", templateId)
        .maybeSingle();
      if (
        draftError ||
        !draft ||
        draft.org_id !== orgId ||
        !["editing", "abandoned"].includes(draft.lifecycle_state) ||
        draft.provider_create_state !== "attached" ||
        !draft.sign_template_id ||
        !draft.staging_source_id ||
        draft.staging_path !== `${orgId}/${draft.staging_source_id}.pdf` ||
        draft.duplicate_of_template_id !== null ||
        draft.supersedes_template_id !== null ||
        draft.finalized_at !== null ||
        draft.deleted_at !== null ||
        (draft.lifecycle_state === "editing" && draft.abandoned_at !== null) ||
        (draft.lifecycle_state === "abandoned" && draft.abandoned_at === null) ||
        !draft.source_filename ||
        !draft.source_size_bytes ||
        draft.source_content_type !== "application/pdf" ||
        !draft.source_sha256
      ) {
        return failure(
          "PLACEMENT_RESTART_UNAVAILABLE",
          "Only an attached unfinished template with its retained PDF can restart field placement.",
        );
      }
      const signerRoles = parseSignerRoles(draft.signer_roles);
      if (
        signerRoles.length === 0 ||
        !signerRoles.some((role) => role.name === draft.seller_role) ||
        !exactFiveFields(draft.merge_field_names)
      ) {
        return failure(
          "PLACEMENT_RESTART_CONTRACT_MISMATCH",
          "The unfinished template contract could not be verified safely.",
        );
      }
      let bytes: Uint8Array;
      try {
        const retainedPath =
          draft.lifecycle_state === "abandoned"
            ? `${orgId}/${templateId}.pdf`
            : draft.staging_path;
        const { data, error } = await admin.storage
          .from(BUCKET)
          .download(retainedPath);
        if (error) throw error;
        bytes = new Uint8Array(await data.arrayBuffer());
      } catch {
        return failure(
          "PLACEMENT_RESTART_SOURCE_UNAVAILABLE",
          "The retained private PDF could not be read. The original draft was not changed.",
        );
      }
      const actualSha = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.byteLength !== draft.source_size_bytes ||
        bytes.byteLength === 0 ||
        bytes.byteLength > ESIGN_TEMPLATE_MAX_PDF_BYTES ||
        !hasPdfMagic(bytes) ||
        actualSha !== draft.source_sha256
      ) {
        return failure(
          "PLACEMENT_RESTART_SOURCE_MISMATCH",
          "The retained private PDF no longer matches the original draft. The original draft was not changed.",
        );
      }
      // One retained draft gets one durable replacement reservation. Concurrent
      // and post-retirement retry requests therefore converge on the same local
      // draft, while the provider-create claim admits only one Dropbox mutation.
      const replacementSourceId = templateId;
      const metadata: PreparedSourceMetadata = {
        stagingSourceId: replacementSourceId,
        filename: draft.source_filename,
        size: bytes.byteLength,
        mimeType: "application/pdf",
        sha256: actualSha,
      };
      const prepared = await runtime.prepare(metadata);
      if (!prepared.ok) return prepared;
      try {
        const { error } = await admin.storage
          .from(BUCKET)
          .upload(prepared.data.storagePath, bytes, {
            contentType: "application/pdf",
            upsert: false,
          });
        if (error) {
          const { data: existing, error: readError } = await admin.storage
            .from(BUCKET)
            .download(prepared.data.storagePath);
          if (readError) throw error;
          const existingBytes = new Uint8Array(await existing.arrayBuffer());
          const existingSha = createHash("sha256")
            .update(existingBytes)
            .digest("hex");
          if (
            existingBytes.byteLength !== bytes.byteLength ||
            existingSha !== actualSha
          ) {
            throw error;
          }
        }
      } catch {
        return failure(
          "PLACEMENT_RESTART_COPY_FAILED",
          "The retained PDF could not be copied or reconciled for a safe restart. The original draft was not changed.",
        );
      }
      const replacement = await runtime.create({
        source: { ...prepared.data, ...metadata },
        name: draft.name,
        documentType: draft.document_type,
        signerRoles,
        sellerRoleName: draft.seller_role,
        beforeProviderCreate: retireOriginal,
      });
      if (!replacement.ok) return replacement;
      return success({
        templateId: replacement.data.templateId,
        initialEditorSession: replacement.data.initialEditorSession,
        cleanupAttention: replacement.data.cleanupAttention ?? false,
      });
    },
    cleanup,
  };
  return runtime;
}

function providerPorts(context: {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  actorId: string;
  localTemplateId: string;
  bytes: Uint8Array;
  input: {
    source: PreparedSource & PreparedSourceMetadata;
    name: string;
    documentType: string;
    signerRoles: readonly TemplateSignerRole[];
    sellerRoleName: string;
  };
  getCredentials(): ReturnType<typeof getEsignCredentials>;
}): InitialProviderCreatePorts {
  const rpc = async (
    name:
      | "claim_esign_template_provider_create"
      | "begin_esign_template_provider_create"
      | "release_esign_template_provider_create_claim"
      | "record_definitive_esign_template_provider_create_failure"
      | "mark_esign_template_provider_create_unknown"
      | "complete_esign_template_provider_create",
    args: Record<string, string>,
  ) => {
    const result = await context.admin.rpc(name, args as never);
    if (result.error || !result.data?.[0])
      throw result.error ?? new Error(`invalid ${name} result`);
    return result.data[0] as Record<string, string | null>;
  };
  return {
    async claim(input) {
      const row = await rpc("claim_esign_template_provider_create", {
        p_org_id: input.orgId,
        p_template_id: input.templateId,
        p_source_id: input.sourceId,
        p_actor_id: input.actorId,
      });
      return {
        outcome: row.outcome as
          "claimed" | "already_in_progress" | "already_attached",
        templateId: row.template_id!,
        providerCreateState: row.provider_create_state as ProviderCreateState,
        claimToken: row.claim_token,
        providerTemplateId: row.provider_template_id,
        providerAccountId: row.provider_account_id,
        createdBy: row.created_by!,
      };
    },
    async begin(input) {
      const row = await rpc("begin_esign_template_provider_create", {
        p_org_id: input.orgId,
        p_template_id: input.templateId,
        p_source_id: input.sourceId,
        p_claim_token: input.claimToken,
        p_actor_id: input.actorId,
      });
      return {
        outcome: row.outcome as
          "started" | "already_started" | "already_attached",
        templateId: row.template_id!,
        providerCreateState: row.provider_create_state as
          "unstarted" | "claimed" | "invoking" | "unknown" | "attached",
        createdBy: row.created_by!,
      };
    },
    async release(input) {
      const row = await rpc("release_esign_template_provider_create_claim", {
        p_org_id: input.orgId,
        p_template_id: input.templateId,
        p_source_id: input.sourceId,
        p_claim_token: input.claimToken,
        p_actor_id: input.actorId,
      });
      return {
        outcome: row.outcome as
          "released" | "already_released" | "already_attached",
        templateId: row.template_id!,
        createdBy: row.created_by!,
      };
    },
    async markUnknown(input) {
      const row = await rpc("mark_esign_template_provider_create_unknown", {
        p_org_id: input.orgId,
        p_template_id: input.templateId,
        p_source_id: input.sourceId,
        p_claim_token: input.claimToken,
        p_error_code: input.errorCode,
        p_actor_id: input.actorId,
      });
      return {
        outcome: row.outcome as
          "recorded_unknown" | "already_unknown" | "already_attached",
        templateId: row.template_id!,
        createdBy: row.created_by!,
      };
    },
    async recordDefinitiveFailure(input) {
      const row = await rpc(
        "record_definitive_esign_template_provider_create_failure",
        {
          p_org_id: input.orgId,
          p_template_id: input.templateId,
          p_source_id: input.sourceId,
          p_claim_token: input.claimToken,
          p_error_code: input.errorCode,
          p_actor_id: input.actorId,
        },
      );
      return {
        outcome: row.outcome as
          | "recorded_failure"
          | "already_recorded"
          | "already_attached",
        templateId: row.template_id!,
        createdBy: row.created_by!,
      };
    },
    async complete(input) {
      const row = await rpc("complete_esign_template_provider_create", {
        p_org_id: input.orgId,
        p_template_id: input.templateId,
        p_source_id: input.sourceId,
        p_claim_token: input.claimToken,
        p_provider_template_id: input.providerTemplateId,
        p_actor_id: input.actorId,
      });
      return {
        outcome: row.outcome as "attached" | "already_attached",
        templateId: row.template_id!,
        providerTemplateId: row.provider_template_id!,
        createdBy: row.created_by!,
      };
    },
    provider: {
      async loadAccountIdentity() {
        const credentials = await context.getCredentials();
        if (!credentials) throw new Error("DROPBOX_SIGN_NOT_CONNECTED");
        return { providerAccountId: credentials.providerAccountId };
      },
      async invoke() {
        const credentials = await context.getCredentials();
        if (!credentials) throw new Error("DROPBOX_SIGN_NOT_CONNECTED");
        const provider = createDropboxSignProvider({
          apiKey: credentials.apiKey,
          clientId: credentials.clientId,
          expectedDomain: configuredDropboxSignEmbeddedDomain(),
        });
        const created = await provider.createEmbeddedTemplateDraft({
          localTemplateId: context.localTemplateId,
          title: context.input.name,
          file: {
            filename: context.input.source.filename,
            bytes: Buffer.from(context.bytes),
          },
          signerRoles: context.input.signerRoles,
          mergeFieldNames: [
            "seller_name",
            "property_address",
            "offer_price",
            "closing_date",
            "earnest_money",
          ],
        });
        return {
          providerTemplateId: created.providerTemplateId,
          editUrl: created.editUrl,
          expiresAt: created.expiresAt,
          clientId: credentials.clientId,
        };
      },
    },
  };
}

function validMetadata(input: PreparedSourceMetadata) {
  return (
    isOpaqueId(input.stagingSourceId) &&
    input.filename.toLowerCase().endsWith(".pdf") &&
    input.size > 0 &&
    input.size <= ESIGN_TEMPLATE_MAX_PDF_BYTES &&
    input.mimeType === "application/pdf" &&
    /^[a-f0-9]{64}$/.test(input.sha256)
  );
}
function hasPdfMagic(bytes: Uint8Array) {
  return (
    bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-"
  );
}
function isOpaqueId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
function parseSignerRoles(value: unknown): TemplateSignerRole[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((role, index) => {
      if (!role || typeof role !== "object") return [];
      const name =
        "name" in role && typeof role.name === "string" ? role.name : "";
      const order =
        "order" in role && typeof role.order === "number" ? role.order : index;
      return name ? [{ name, order }] : [];
    })
    .sort((a, b) => a.order - b.order);
}
function sameOrderedRoles(
  left: readonly TemplateSignerRole[],
  right: readonly TemplateSignerRole[],
) {
  return (
    left.length === right.length &&
    left.every(
      (role, index) =>
        role.name === right[index]?.name && role.order === right[index]?.order,
    )
  );
}
function exactFiveFields(fields: readonly string[]) {
  const expected = new Set([
    "seller_name",
    "property_address",
    "offer_price",
    "closing_date",
    "earnest_money",
  ]);
  return (
    fields.length === expected.size &&
    fields.every((field) => expected.has(field))
  );
}
export function providerReconciliationCandidateMatches(input: {
  expectedProviderTemplateId: string;
  expectedLocalTemplateId: string;
  expectedTitle: string;
  expectedRoles: readonly TemplateSignerRole[];
  sellerRoleName: string;
  expectedMergeFields: readonly string[];
  candidate: {
    providerTemplateId: string;
    localTemplateId: string | null;
    title: string | null;
    signerRoles: readonly TemplateSignerRole[];
    mergeFieldNames: readonly string[];
  };
}) {
  return (
    input.candidate.providerTemplateId === input.expectedProviderTemplateId &&
    input.candidate.localTemplateId === input.expectedLocalTemplateId &&
    input.candidate.title?.trim() === input.expectedTitle &&
    sameOrderedRoles(input.candidate.signerRoles, input.expectedRoles) &&
    input.expectedRoles.some((role) => role.name === input.sellerRoleName) &&
    exactFiveFields(input.candidate.mergeFieldNames) &&
    exactFiveFields(input.expectedMergeFields)
  );
}
function success<T>(data: T): TemplateActionResult<T> {
  return { ok: true, data };
}
function failure(code: string, message: string): TemplateActionResult<never> {
  return { ok: false, error: { code, message } };
}
