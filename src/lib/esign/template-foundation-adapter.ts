import "server-only";

import { randomUUID } from "node:crypto";

import { ProviderError } from "@/lib/errors/classes";
import { getSingleActiveMembership } from "@/lib/auth/memberships";
import { createAdminClient } from "@/lib/supabase/admin";

import { ESIGN_MERGE_FIELD_NAMES, type TemplateOption, type TemplateSignerRole } from "./contracts";
import { getEsignCredentials, configuredDropboxSignEmbeddedDomain } from "./credentials";
import { createDropboxSignProvider } from "./dropbox-sign";
import { isRestartableDraftEditorFailure } from "./provider-failure";
import {
  createTemplateOrchestrator,
  type StagedTemplateSource,
  type TemplateDraftRecord,
  type TemplateOrchestratorPorts,
} from "./template-orchestrator";

const STAGING_BUCKET = "esign-staging";
const TEMPLATE_DRAFT_SELECT = "id,org_id,name,document_type,sign_template_id,provider_account_id,seller_role,signer_roles,merge_field_names,staging_source_id,supersedes_template_id,lifecycle_state";
const EXPIRED_PROVIDER_SYNC_STARTED_AT = "1970-01-01T00:00:00.000Z";

export type TemplateLibraryRecord = TemplateOption & {
  sourceFilename: string;
  sourceSizeBytes: number;
  pageCount: number | null;
  fieldCount: number | null;
  updatedAt: string;
  updatedByName: string;
  recentSendCount30d: number;
};

function assertTemplateManagementEnabled(
  credentials: Awaited<ReturnType<typeof getEsignCredentials>>,
) {
  if (!credentials) throw new Error("DROPBOX_SIGN_NOT_CONNECTED");
  if (!credentials.sendingEnabled) throw new Error("DROPBOX_SIGN_NOT_CONNECTED");
  return credentials;
}

export async function createFoundationTemplateOrchestrator() {
  const selectedMembership = await getSingleActiveMembership();
  const actorPort = {
    async getActor() {
      return selectedMembership.ok
        ? {
            userId: selectedMembership.membership.user_id,
            orgId: selectedMembership.membership.org_id,
            isOwner: selectedMembership.membership.role === "owner",
          }
        : null;
    },
  };
  const membership = await actorPort.getActor();
  const admin = createAdminClient();
  let providerSyncTimestampCapability: boolean | null = null;
  const readProviderSyncStartedAt = async (
    orgId: string,
    templateId: string,
  ): Promise<string | null> => {
    if (providerSyncTimestampCapability === false) return null;
    const { data, error } = await admin
      .from("esign_templates")
      .select("provider_sync_started_at")
      .eq("org_id", orgId)
      .eq("id", templateId)
      .maybeSingle();
    if (error) {
      if (!isMissingProviderSyncTimestampColumnError(error)) throw error;
      providerSyncTimestampCapability = false;
      return null;
    }
    providerSyncTimestampCapability = true;
    return data?.provider_sync_started_at ?? null;
  };
  let providerPromise: Promise<{
    clientId: string;
    providerAccountId: string;
    provider: ReturnType<typeof createDropboxSignProvider>;
  }> | null = null;
  const providerConnection = () => {
    if (!providerPromise) {
      providerPromise = (async () => {
        if (!membership) throw new Error("AUTH_REQUIRED");
        const credentials = assertTemplateManagementEnabled(
          await getEsignCredentials(membership.orgId),
        );
        return {
          clientId: credentials.clientId,
          providerAccountId: credentials.providerAccountId,
          provider: createDropboxSignProvider({
            apiKey: credentials.apiKey,
            clientId: credentials.clientId,
            expectedDomain: configuredDropboxSignEmbeddedDomain(),
          }),
        };
      })();
    }
    return providerPromise;
  };

  const repository: TemplateOrchestratorPorts["repository"] = {
    async listFinalized(orgId) {
      const { data, error } = await admin
        .from("available_esign_templates")
        .select("id,name,document_type,sign_template_id,seller_role,signer_roles,merge_field_names,source_filename,source_size_bytes,updated_at,updated_by")
        .eq("org_id", orgId)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: requests, error: requestError } = await admin
        .from("esign_requests")
        .select("template_id")
        .eq("org_id", orgId)
        .gte("created_at", since);
      if (requestError) throw requestError;
      const counts = new Map<string, number>();
      for (const request of requests ?? []) counts.set(request.template_id, (counts.get(request.template_id) ?? 0) + 1);
      return (data ?? []).map((row) => {
        const option = optionFromRow(row);
        return {
          ...option,
          sourceFilename: row.source_filename ?? "Dropbox Sign template",
          sourceSizeBytes: row.source_size_bytes ?? 0,
          pageCount: null,
          fieldCount: row.merge_field_names?.length ?? null,
          updatedAt: row.updated_at ?? new Date(0).toISOString(),
          updatedByName: "Organization owner",
          recentSendCount30d: counts.get(option.id) ?? 0,
        } satisfies TemplateLibraryRecord;
      });
    },

    async listPendingCopies(orgId) {
      const { data: active, error } = await admin
        .from("esign_templates")
        .select("id,org_id,name,lifecycle_state,staging_source_id,supersedes_template_id")
        .eq("org_id", orgId)
        .or("duplicate_of_template_id.not.is.null,supersedes_template_id.not.is.null")
        .in("lifecycle_state", ["preparing", "editing"])
        .is("deleted_at", null)
        .is("abandoned_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const { data: abandoned, error: abandonedError } = await admin
        .from("esign_templates")
        .select("id,org_id,name,lifecycle_state,staging_source_id,duplicate_of_template_id,supersedes_template_id")
        .eq("org_id", orgId)
        .in("lifecycle_state", ["abandoned", "finalized"])
        .not("staging_source_id", "is", null)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (abandonedError) throw abandonedError;
      const stageIds = (abandoned ?? []).flatMap((row) => row.staging_source_id ? [row.staging_source_id] : []);
      let cleanupStageIds = new Set<string>();
      if (stageIds.length > 0) {
        const { data: stages, error: stageError } = await admin
          .from("esign_template_staging_sources")
          .select("id")
          .eq("org_id", orgId)
          .in("id", stageIds)
          .in("cleanup_outcome", ["pending", "failed"]);
        if (stageError) throw stageError;
        cleanupStageIds = new Set((stages ?? []).map((stage) => stage.id));
      }
      const abandonedIds = (abandoned ?? []).map((row) => row.id);
      let placementRestartOriginalIds = new Set<string>();
      if (abandonedIds.length > 0) {
        const { data: replacements, error: replacementError } = await admin
          .from("esign_templates")
          .select("staging_source_id")
          .eq("org_id", orgId)
          .in("staging_source_id", abandonedIds)
          .in("lifecycle_state", ["preparing", "editing", "finalized"])
          .is("deleted_at", null)
          .is("abandoned_at", null);
        if (replacementError) throw replacementError;
        placementRestartOriginalIds = new Set(
          (replacements ?? []).flatMap((row) =>
            row.staging_source_id ? [row.staging_source_id] : [],
          ),
        );
      }
      const activeCopies = (active ?? []).map((row) => ({
        id: row.id,
        orgId: row.org_id,
        name: row.name,
        lifecycle: row.lifecycle_state as "preparing" | "editing",
        kind: row.supersedes_template_id ? "edit_revision" as const : "copy" as const,
      }));
      const cleanupCopies = (abandoned ?? []).flatMap((row) => {
        if (
          !row.staging_source_id ||
          !cleanupStageIds.has(row.staging_source_id) ||
          (row.lifecycle_state !== "abandoned" &&
            !row.duplicate_of_template_id &&
            !row.supersedes_template_id)
        ) {
          return [];
        }
        const kind = row.supersedes_template_id
          ? "edit_revision" as const
          : row.duplicate_of_template_id
            ? "copy" as const
            : placementRestartOriginalIds.has(row.id)
              ? "placement_restart" as const
              : null;
        return [{
          id: row.id,
          orgId: row.org_id,
          name: row.name,
          lifecycle: "cleanup_attention" as const,
          ...(kind ? { kind } : {}),
        }];
      });
      return [...activeCopies, ...cleanupCopies];
    },

    async recordVerifiedStage(stage) {
      const { data, error } = await admin.rpc("record_verified_esign_template_source", {
        p_org_id: stage.orgId,
        p_source_id: stage.id,
        p_storage_path: stage.storagePath,
        p_source_filename: stage.filename,
        p_source_size_bytes: stage.size,
        p_content_type: stage.mimeType,
        p_source_sha256: stage.sha256,
        p_actor_id: membership!.userId,
      });
      if (error) {
        const reconciled = await this.getStage(stage.orgId, stage.id);
        if (reconciled && JSON.stringify(reconciled) === JSON.stringify(stage)) return reconciled;
        throw error;
      }
      if (data !== stage.id) throw new Error("verified source ID mismatch");
      return stage;
    },

    async recordUnattachedStageCleanup(input) {
      const values = input.outcome === "deleted"
        ? { cleanup_outcome: "deleted", cleanup_attempted_at: new Date().toISOString(), cleanup_error_code: null }
        : { cleanup_outcome: "failed", cleanup_attempted_at: new Date().toISOString(), cleanup_error_code: "STORAGE_DELETE_FAILED" };
      const { data, error } = await admin
        .from("esign_template_staging_sources")
        .update(values)
        .eq("org_id", input.orgId)
        .eq("id", input.stageId)
        .eq("cleanup_outcome", "pending")
        .select("id")
        .maybeSingle();
      if (error || !data) throw error ?? new Error("unattached source cleanup was not recorded");
    },

    async getStage(orgId, stageId) {
      const { data, error } = await admin
        .from("esign_template_staging_sources")
        .select("id,org_id,storage_path,source_filename,source_size_bytes,content_type,source_sha256")
        .eq("org_id", orgId)
        .eq("id", stageId)
        .maybeSingle();
      if (error) throw error;
      return data ? stageFromRow(data) : null;
    },

    async createHiddenDraft(input) {
      if (!input.stagingSourceId) throw new Error("verified source is required");
      const { data, error } = await admin.rpc("create_esign_template_draft", {
        p_org_id: input.orgId,
        p_source_id: input.stagingSourceId,
        p_name: input.name,
        p_document_type: input.documentType,
        p_seller_role: input.sellerRoleName,
        p_signer_roles: input.signerRoles.map((role) => ({ ...role })),
        p_actor_id: membership!.userId,
      });
      if (error) {
        const { data: reconciled, error: reconcileError } = await admin
          .from("esign_templates")
          .select(TEMPLATE_DRAFT_SELECT)
          .eq("org_id", input.orgId)
          .eq("staging_source_id", input.stagingSourceId)
          .maybeSingle();
        if (reconcileError || !reconciled) throw error;
        const providerSyncStartedAt = await readProviderSyncStartedAt(
          input.orgId,
          reconciled.id,
        );
        return draftFromRow({
          ...reconciled,
          provider_sync_started_at: providerSyncStartedAt,
        });
      }
      const created = await this.getTemplate(input.orgId, data);
      if (!created) throw new Error("created template not found");
      return created;
    },

    async createHiddenDuplicate(input) {
      const { data, error } = await admin.rpc("create_esign_template_duplicate_draft", {
        p_org_id: input.orgId,
        p_source_template_id: input.sourceTemplateId,
        p_name: input.name,
        p_actor_id: membership!.userId,
      });
      if (error) throw error;
      const created = await this.getTemplate(input.orgId, data);
      if (!created) throw new Error("created duplicate not found");
      return created;
    },

    async createHiddenEditRevision(input) {
      const { data, error } = await admin.rpc("create_esign_template_edit_revision", {
        p_org_id: input.orgId,
        p_source_template_id: input.sourceTemplateId,
        p_source_id: input.stagingSourceId,
        p_actor_id: membership!.userId,
      });
      if (error) throw error;
      const created = await this.getTemplate(input.orgId, data);
      if (!created) throw new Error("created edit revision not found");
      return created;
    },

    async getTemplate(orgId, templateId) {
      const { data, error } = await admin
        .from("esign_templates")
        .select(TEMPLATE_DRAFT_SELECT)
        .eq("org_id", orgId)
        .eq("id", templateId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const providerSyncStartedAt = await readProviderSyncStartedAt(
        orgId,
        templateId,
      );
      return draftFromRow({
        ...data,
        provider_sync_started_at: providerSyncStartedAt,
      });
    },

    async markFinishSyncStarted(orgId, templateId, startedAt) {
      if (providerSyncTimestampCapability !== false) {
        const { data: claimed, error: claimError } = await admin
          .from("esign_templates")
          .update({ provider_sync_started_at: startedAt })
          .eq("org_id", orgId)
          .eq("id", templateId)
          .eq("lifecycle_state", "editing")
          .is("provider_sync_started_at", null)
          .select("provider_sync_started_at")
          .maybeSingle();
        if (claimError) {
          if (!isMissingProviderSyncTimestampColumnError(claimError)) {
            throw claimError;
          }
          providerSyncTimestampCapability = false;
        } else {
          providerSyncTimestampCapability = true;
          if (claimed?.provider_sync_started_at) {
            return claimed.provider_sync_started_at;
          }
          return readProviderSyncStartedAt(orgId, templateId);
        }
      }

      // During code-first rollout or rollback, the old schema cannot persist
      // the deadline. Verify the draft is still editable, then fail closed on
      // provider not_found instead of resetting the 60-minute grace period on
      // every invocation. A ready provider template can still finalize.
      const { data: legacyDraft, error: legacyReadError } = await admin
        .from("esign_templates")
        .select("id")
        .eq("org_id", orgId)
        .eq("id", templateId)
        .eq("lifecycle_state", "editing")
        .maybeSingle();
      if (legacyReadError) throw legacyReadError;
      return legacyDraft ? EXPIRED_PROVIDER_SYNC_STARTED_AT : null;
    },

    async attachProviderId(orgId, templateId, providerTemplateId) {
      const { data, error } = await admin.rpc("attach_esign_template_provider_id", {
        p_org_id: orgId,
        p_template_id: templateId,
        p_provider_template_id: providerTemplateId,
        p_actor_id: membership!.userId,
      });
      if (error) throw error;
      return data === "attached" || data === "already_attached";
    },

    async finalizeDraft(input) {
      const { data, error } = await admin.rpc("finalize_esign_template", {
        p_org_id: input.orgId,
        p_template_id: input.templateId,
        p_provider_template_id: input.expectedProviderTemplateId,
        p_seller_role: input.option.sellerRoleName,
        p_provider_signer_roles: input.option.signerRoles.map((role) => ({ ...role })),
        p_provider_merge_field_names: [...input.option.mergeFieldNames],
        p_actor_id: membership!.userId,
      });
      if (error) throw error;
      return data === "finalized" || data === "already_finalized";
    },

    async publishEditRevision(input) {
      const { data, error } = await admin.rpc("publish_esign_template_edit_revision", {
        p_org_id: input.orgId,
        p_source_template_id: input.sourceTemplateId,
        p_revision_template_id: input.revisionTemplateId,
        p_expected_source_provider_template_id: input.expectedSourceProviderTemplateId,
        p_revision_provider_template_id: input.revisionProviderTemplateId,
        p_seller_role: input.option.sellerRoleName,
        p_provider_signer_roles: input.option.signerRoles.map((role) => ({ ...role })),
        p_provider_merge_field_names: [...input.option.mergeFieldNames],
        p_actor_id: membership!.userId,
      });
      if (error) throw error;
      return data === "published" || data === "already_published" ? data : null;
    },

    async markAbandoned(orgId, templateId) {
      const { data, error } = await admin.rpc("abandon_esign_template_draft", {
        p_org_id: orgId,
        p_template_id: templateId,
        p_actor_id: membership!.userId,
      });
      if (error) throw error;
      return data === "abandoned" || data === "already_abandoned";
    },

    async softDelete(orgId, templateId, confirmRecentSends) {
      const { data, error } = await admin.rpc("soft_delete_esign_template", {
        p_org_id: orgId,
        p_template_id: templateId,
        p_confirm_recent_sends: confirmRecentSends,
        p_actor_id: membership!.userId,
      });
      if (error) throw error;
      const row = data?.[0];
      if (!row || !["deleted", "already_deleted", "needs_confirmation"].includes(row.outcome)) throw new Error("invalid delete outcome");
      return { outcome: row.outcome as "deleted" | "already_deleted" | "needs_confirmation", recentSendCount: row.recent_send_count };
    },

    async recordSourceCleanup(input) {
      const errorCode = input.outcome === "failed" ? "STORAGE_DELETE_FAILED" : null;
      const { error } = await admin.rpc("record_esign_template_source_cleanup", {
        p_org_id: input.orgId,
        p_template_id: input.templateId,
        p_storage_path: input.storagePath,
        p_outcome: input.outcome,
        p_error_code: errorCode,
        p_actor_id: membership!.userId,
      });
      if (error) throw error;
    },
  };

  const storage: TemplateOrchestratorPorts["storage"] = {
    async putPrivate(path, bytes, mimeType) {
      const { error } = await admin.storage.from(STAGING_BUCKET).upload(path, bytes, { contentType: mimeType, upsert: false });
      if (error) throw error;
    },
    async readPrivate(path) {
      const { data, error } = await admin.storage.from(STAGING_BUCKET).download(path);
      if (error) throw error;
      return new Uint8Array(await data.arrayBuffer());
    },
    async deletePrivate(path) {
      const { data, error } = await admin.storage.from(STAGING_BUCKET).remove([path]);
      if (error) throw error;
      if (data.length === 0) return "already_absent";
      if (data.length === 1 && data[0].name === path) return "deleted";
      throw new Error("staged object deletion returned an unexpected result");
    },
  };

  const ports: TemplateOrchestratorPorts = {
    auth: actorPort,
    repository,
    storage,
    provider: {
      async getEmbeddedClientId() {
        return (await providerConnection()).clientId;
      },
      async createDraft(input) {
        const { provider } = await providerConnection();
        const session = await provider.createEmbeddedTemplateDraft({
          localTemplateId: input.localTemplateId,
          title: input.title,
          file: { filename: input.file.filename, bytes: Buffer.from(input.file.bytes) },
          signerRoles: input.signerRoles,
          mergeFieldNames: input.mergeFieldNames,
        });
        return { providerTemplateId: session.providerTemplateId };
      },
      async getFreshEditUrl(providerTemplateId) {
        const { provider } = await providerConnection();
        const session = await provider.getEmbeddedTemplateEditUrl(providerTemplateId);
        return { editUrl: session.editUrl, expiresAt: session.expiresAt };
      },
      async getTemplate(providerTemplateId, signal) {
        const { provider } = await providerConnection();
        return provider.getTemplate(providerTemplateId, signal);
      },
      async getTemplateFiles(providerTemplateId) {
        const { provider } = await providerConnection();
        return new Uint8Array(await provider.getTemplateFiles(providerTemplateId));
      },
      async duplicateTemplate(input) {
        const connection = await providerConnection();
        if (connection.providerAccountId !== input.expectedProviderAccountId) throw new Error("PROVIDER_ACCOUNT_MISMATCH");
        const { provider } = connection;
        const bytes = await provider.getTemplateFiles(input.providerTemplateId);
        return provider.duplicateTemplate(input.providerTemplateId, { filename: `${input.title}.pdf`, bytes });
      },
      async deleteTemplate(providerTemplateId) {
        const { provider } = await providerConnection();
        return provider.deleteTemplate(providerTemplateId);
      },
      isNotFound(error) {
        return error instanceof ProviderError && error.details?.statusCode === 404;
      },
      classifyTemplateReadError(error) {
        return classifyDropboxTemplateReadError(error);
      },
      isAmbiguousMutation(error) {
        return error instanceof ProviderError
          && (typeof error.details?.statusCode !== "number" || error.details.statusCode >= 500);
      },
      isRestartableEditorSessionError(error) {
        return isRestartableDraftEditorFailure(error);
      },
    },
    randomId: randomUUID,
    now: () => new Date(),
  };

  return createTemplateOrchestrator(ports);
}

export function classifyDropboxTemplateReadError(error: unknown): "not_found" | "terminal" {
  return error instanceof ProviderError
    && error.provider === "dropbox_sign"
    && error.details?.statusCode === 404
    && error.details?.providerCode === "not_found"
    ? "not_found"
    : "terminal";
}

export function isMissingProviderSyncTimestampColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const diagnostic = [candidate.message, candidate.details, candidate.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return (
    (code === "PGRST204" || code === "42703")
    && /\bprovider_sync_started_at\b/i.test(diagnostic)
  );
}

function signerRoles(value: unknown): readonly TemplateSignerRole[] {
  if (!Array.isArray(value)) throw new Error("invalid signer roles");
  const roles = value.map((role) => {
    if (!role || typeof role !== "object") throw new Error("invalid signer role");
    const item = role as { name?: unknown; order?: unknown };
    if (typeof item.name !== "string" || typeof item.order !== "number") throw new Error("invalid signer role");
    return { name: item.name, order: item.order };
  });
  return roles.sort((left, right) => left.order - right.order);
}

function exactFields(value: string[] | null): typeof ESIGN_MERGE_FIELD_NAMES {
  if (!value || value.length !== ESIGN_MERGE_FIELD_NAMES.length || !ESIGN_MERGE_FIELD_NAMES.every((field) => value.includes(field))) {
    throw new Error("invalid merge fields");
  }
  return ESIGN_MERGE_FIELD_NAMES;
}

function optionFromRow(row: {
  id: string | null; name: string | null; document_type: string | null; sign_template_id: string | null;
  seller_role: string | null; signer_roles: unknown; merge_field_names: string[] | null;
}): TemplateOption {
  if (!row.id || !row.name || !row.document_type || !row.sign_template_id || !row.seller_role) throw new Error("invalid finalized template");
  return {
    id: row.id,
    name: row.name,
    documentType: row.document_type,
    providerTemplateId: row.sign_template_id,
    sellerRoleName: row.seller_role,
    signerRoles: signerRoles(row.signer_roles),
    mergeFieldNames: exactFields(row.merge_field_names),
  };
}

function draftFromRow(row: {
  id: string; org_id: string; name: string; document_type: string; sign_template_id: string | null;
  seller_role: string; signer_roles: unknown; merge_field_names: string[]; staging_source_id: string | null;
  supersedes_template_id?: string | null; lifecycle_state: string; provider_account_id?: string | null;
  provider_sync_started_at?: string | null;
}): TemplateDraftRecord {
  if (!["preparing", "editing", "finalized", "abandoned", "deleted", "error"].includes(row.lifecycle_state)) throw new Error("invalid template lifecycle");
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    documentType: row.document_type,
    providerTemplateId: row.sign_template_id,
    providerAccountId: row.provider_account_id ?? null,
    sellerRoleName: row.seller_role,
    signerRoles: signerRoles(row.signer_roles),
    mergeFieldNames: row.merge_field_names,
    stagingSourceId: row.staging_source_id,
    supersedesTemplateId: row.supersedes_template_id ?? null,
    providerSyncStartedAt: row.provider_sync_started_at ?? null,
    lifecycle: row.lifecycle_state as TemplateDraftRecord["lifecycle"],
  };
}

function stageFromRow(row: {
  id: string; org_id: string; storage_path: string; source_filename: string; source_size_bytes: number;
  content_type: string; source_sha256: string;
}): StagedTemplateSource {
  if (row.content_type !== "application/pdf") throw new Error("invalid staged MIME");
  return {
    id: row.id,
    orgId: row.org_id,
    storagePath: row.storage_path,
    filename: row.source_filename,
    size: row.source_size_bytes,
    mimeType: "application/pdf",
    sha256: row.source_sha256,
  };
}
