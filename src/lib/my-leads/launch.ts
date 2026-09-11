import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { AcquisitionErrorCode } from "./types";

export type LaunchErrorCode =
  | AcquisitionErrorCode
  | "LAUNCH_INVALIDATED"
  | "ROLLBACK_BLOCKED"
  | "LAUNCH_ALREADY_APPLIED";

export type LaunchPreviewRow = {
  property_id: string;
  expected_episode_id: string | null;
  expected_assigned_user_id: string;
  expected_assigned_at: string | null;
  expected_episode_initialized_at: string | null;
  expected_member_revision: number;
  expected_shared_status: string;
  expected_queue_version: number;
  expected_queue_stage: string | null;
  expected_is_dnc_locked: boolean;
  expected_deleted_at: string | null;
  expected_settings_revision: number;
};

export type LaunchPreview = {
  ok: true;
  cohortId: string;
  orgId: string;
  memberId: string;
  settingsRevision: number;
  previewCutoffAt: string;
  previewCount: number;
  fingerprint: string;
  rows: LaunchPreviewRow[];
  excluded: {
    assignedTotal: number;
    closedOrDead: number;
    dnc: number;
    offerDeclined: number;
    alreadyArchived: number;
    missingEpisode: number;
  };
};

export type LaunchCommandSuccess = {
  ok: true;
  duplicate: boolean;
  cohortId: string;
  count: number;
  memberId?: string;
  fingerprint?: string;
  settingsRevision?: number;
};

export type LaunchCommandFailure = {
  ok: false;
  code: LaunchErrorCode;
  message: string;
};

export type LaunchCommandResult = LaunchCommandSuccess | LaunchCommandFailure;

export type ApplyAcquisitionLaunchInput = {
  orgId: string;
  memberId: string;
  cohortId: string;
  previewFingerprint: string;
  expectedSettingsRevision: number;
  idempotencyKey: string;
};

export type RollbackAcquisitionLaunchInput = {
  orgId: string;
  cohortId: string;
  idempotencyKey: string;
};

type RpcError = { code?: string | null; message?: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseRow(value: unknown): LaunchPreviewRow | null {
  if (
    !isRecord(value) ||
    typeof value.property_id !== "string" ||
    (value.expected_episode_id !== null && typeof value.expected_episode_id !== "string") ||
    typeof value.expected_assigned_user_id !== "string" ||
    (value.expected_assigned_at !== null && typeof value.expected_assigned_at !== "string") ||
    (value.expected_episode_initialized_at !== null && typeof value.expected_episode_initialized_at !== "string") ||
    !isInteger(value.expected_member_revision) ||
    typeof value.expected_shared_status !== "string" ||
    !isInteger(value.expected_queue_version) ||
    (value.expected_queue_stage !== null && typeof value.expected_queue_stage !== "string") ||
    typeof value.expected_is_dnc_locked !== "boolean" ||
    (value.expected_deleted_at !== null && typeof value.expected_deleted_at !== "string") ||
    !isInteger(value.expected_settings_revision)
  ) {
    return null;
  }
  return value as unknown as LaunchPreviewRow;
}

function parsePreview(value: unknown): LaunchPreview | null {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.cohortId !== "string" ||
    typeof value.orgId !== "string" ||
    typeof value.memberId !== "string" ||
    !isInteger(value.settingsRevision) ||
    typeof value.previewCutoffAt !== "string" ||
    !isInteger(value.previewCount) ||
    typeof value.fingerprint !== "string" ||
    !Array.isArray(value.rows) ||
    !isRecord(value.excluded)
  ) {
    return null;
  }
  const rows = value.rows.map(parseRow);
  const excluded = value.excluded;
  if (
    rows.some((row): row is null => row === null) ||
    !isInteger(excluded.assignedTotal) ||
    !isInteger(excluded.closedOrDead) ||
    !isInteger(excluded.dnc) ||
    !isInteger(excluded.offerDeclined) ||
    !isInteger(excluded.alreadyArchived) ||
    !isInteger(excluded.missingEpisode)
  ) {
    return null;
  }
  return {
    ok: true,
    cohortId: value.cohortId,
    orgId: value.orgId,
    memberId: value.memberId,
    settingsRevision: value.settingsRevision,
    previewCutoffAt: value.previewCutoffAt,
    previewCount: value.previewCount,
    fingerprint: value.fingerprint,
    rows: rows as LaunchPreviewRow[],
    excluded: {
      assignedTotal: excluded.assignedTotal,
      closedOrDead: excluded.closedOrDead,
      dnc: excluded.dnc,
      offerDeclined: excluded.offerDeclined,
      alreadyArchived: excluded.alreadyArchived,
      missingEpisode: excluded.missingEpisode,
    },
  };
}

function parseCommandResult(value: unknown): LaunchCommandResult {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.duplicate !== "boolean" ||
    typeof value.cohortId !== "string" ||
    !isInteger(value.count) ||
    (value.memberId !== undefined && typeof value.memberId !== "string") ||
    (value.fingerprint !== undefined && typeof value.fingerprint !== "string") ||
    (value.settingsRevision !== undefined && !isInteger(value.settingsRevision))
  ) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "The launch service returned an invalid result.",
    };
  }
  return {
    ok: true,
    duplicate: value.duplicate,
    cohortId: value.cohortId,
    count: value.count,
    ...(typeof value.memberId === "string" ? { memberId: value.memberId } : {}),
    ...(typeof value.fingerprint === "string" ? { fingerprint: value.fingerprint } : {}),
    ...(typeof value.settingsRevision === "number" ? { settingsRevision: value.settingsRevision } : {}),
  };
}

const errorMessages: Record<LaunchErrorCode, string> = {
  UNAUTHENTICATED: "Sign in to manage the My Leads launch.",
  FORBIDDEN: "Only an active organization owner can manage the My Leads launch.",
  FEATURE_DISABLED: "My Leads is disabled for this organization.",
  NOT_FOUND: "The requested launch target was not found.",
  STALE_ASSIGNMENT: "The launch target changed. Refresh the preview and try again.",
  STALE_STATE: "The launch state changed. Refresh the preview and try again.",
  DNC_LOCKED: "A launch target is protected by its do-not-call lock.",
  INVALID_INPUT: "Review the launch inputs and try again.",
  IDEMPOTENCY_CONFLICT: "That launch request ID was already used for different data.",
  RECIPIENT_UNAVAILABLE: "The configured sequence recipient is unavailable.",
  PENDING_OFFER_EXISTS: "A launch target already has a pending offer.",
  PROVIDER_EVIDENCE_PENDING: "Call evidence is still being recorded.",
  LAUNCH_INVALIDATED: "The preview is stale. Refresh it before applying the launch.",
  ROLLBACK_BLOCKED: "Rollback stopped because launch activity or state changed.",
  LAUNCH_ALREADY_APPLIED: "A launch is already applied or in progress.",
};

function mapRpcError(error: RpcError): LaunchCommandFailure {
  const text = (error.message ?? "").toUpperCase();
  const knownCodes: LaunchErrorCode[] = [
    "LAUNCH_INVALIDATED",
    "ROLLBACK_BLOCKED",
    "LAUNCH_ALREADY_APPLIED",
    "RECIPIENT_UNAVAILABLE",
    "IDEMPOTENCY_CONFLICT",
    "FORBIDDEN",
    "UNAUTHENTICATED",
    "FEATURE_DISABLED",
    "NOT_FOUND",
    "STALE_ASSIGNMENT",
    "STALE_STATE",
    "DNC_LOCKED",
    "PENDING_OFFER_EXISTS",
    "PROVIDER_EVIDENCE_PENDING",
    "INVALID_INPUT",
  ];
  const named = knownCodes.find((code) => text.includes(code));
  const code: LaunchErrorCode =
    named ??
    (error.code === "23505"
      ? "IDEMPOTENCY_CONFLICT"
      : error.code === "42501"
        ? "FORBIDDEN"
        : error.code === "40001"
          ? "STALE_STATE"
          : "INVALID_INPUT");
  return { ok: false, code, message: errorMessages[code] };
}

/** Read-only owner preview. It never creates a cohort or changes a row. */
export async function previewAcquisitionLaunch(input: {
  orgId: string;
  memberId: string;
}): Promise<LaunchPreview | LaunchCommandFailure> {
  const client = await createClient();
  const { data, error } = await client.rpc("fn_preview_acquisition_launch", {
    p_org_id: input.orgId,
    p_member_id: input.memberId,
  });
  if (error) return mapRpcError(error);
  return (
    parsePreview(data) ?? {
      ok: false,
      code: "INVALID_INPUT",
      message: "The launch service returned an invalid preview.",
    }
  );
}

export async function applyAcquisitionLaunch(
  input: ApplyAcquisitionLaunchInput,
): Promise<LaunchCommandResult> {
  const client = await createClient();
  const { data, error } = await client.rpc("fn_apply_acquisition_launch", {
    p_org_id: input.orgId,
    p_member_id: input.memberId,
    p_cohort_id: input.cohortId,
    p_preview_fingerprint: input.previewFingerprint,
    p_expected_settings_revision: input.expectedSettingsRevision,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) return mapRpcError(error);
  return parseCommandResult(data);
}

export async function rollbackAcquisitionLaunch(
  input: RollbackAcquisitionLaunchInput,
): Promise<LaunchCommandResult> {
  const client = await createClient();
  const { data, error } = await client.rpc("fn_rollback_acquisition_launch", {
    p_org_id: input.orgId,
    p_cohort_id: input.cohortId,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) return mapRpcError(error);
  return parseCommandResult(data);
}
