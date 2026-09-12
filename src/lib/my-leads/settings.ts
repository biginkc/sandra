import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  AcquisitionErrorCode,
  SetAcquisitionDesignationInput,
  SetAcquisitionSettingsInput,
} from "./types";

export type AcquisitionSettingsFailure = {
  ok: false;
  code: AcquisitionErrorCode;
  message: string;
};

export type AcquisitionDesignationResult =
  | {
      ok: true;
      duplicate: boolean;
      orgId: string;
      userId: string;
      acquisitionsEnabled: boolean;
    }
  | AcquisitionSettingsFailure;

export type AcquisitionSettingsResult =
  | {
      ok: true;
      duplicate: boolean;
      orgId: string;
      needsSequenceOwnerId: string;
      myLeadsEnabled: boolean;
      settingsRevision: number;
    }
  | AcquisitionSettingsFailure;

type RpcError = {
  code?: string | null;
  message?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapRpcError(error: RpcError): AcquisitionSettingsFailure {
  const text = error.message ?? "";
  const code =
    text.includes("IDEMPOTENCY_CONFLICT") || error.code === "23505"
      ? "IDEMPOTENCY_CONFLICT"
      : text.includes("STALE_STATE") || error.code === "40001"
        ? "STALE_STATE"
        : text.includes("RECIPIENT_UNAVAILABLE")
          ? "RECIPIENT_UNAVAILABLE"
          : error.code === "42501" || text.includes("FORBIDDEN")
            ? "FORBIDDEN"
            : "INVALID_INPUT";
  const messages: Record<AcquisitionErrorCode, string> = {
    UNAUTHENTICATED: "Sign in to manage My Leads settings.",
    FORBIDDEN: "Only an active organization owner can manage My Leads settings.",
    FEATURE_DISABLED: "My Leads is disabled for this organization.",
    NOT_FOUND: "The requested organization member was not found.",
    STALE_ASSIGNMENT: "The selected member changed. Refresh and try again.",
    STALE_STATE: "These settings changed in another session. Refresh and try again.",
    DNC_LOCKED: "This lead is protected by its do-not-call lock.",
    INVALID_INPUT: "Review the settings and try again.",
    IDEMPOTENCY_CONFLICT: "That request ID was already used for different settings.",
    RECIPIENT_UNAVAILABLE: "Choose an active organization member with a verified identity.",
    PENDING_OFFER_EXISTS: "This lead already has a pending offer.",
    PROVIDER_EVIDENCE_PENDING: "Call evidence is still being recorded.",
  };
  return { ok: false, code, message: messages[code] };
}

function parseDesignationResult(value: unknown): AcquisitionDesignationResult {
  if (
    isRecord(value) &&
    value.ok === true &&
    typeof value.duplicate === "boolean" &&
    typeof value.orgId === "string" &&
    typeof value.userId === "string" &&
    typeof value.acquisitionsEnabled === "boolean"
  ) {
    return {
      ok: true,
      duplicate: value.duplicate,
      orgId: value.orgId,
      userId: value.userId,
      acquisitionsEnabled: value.acquisitionsEnabled,
    };
  }
  return {
    ok: false,
    code: "INVALID_INPUT",
    message: "The settings service returned an invalid designation result.",
  };
}

function parseSettingsResult(value: unknown): AcquisitionSettingsResult {
  if (
    isRecord(value) &&
    value.ok === true &&
    typeof value.duplicate === "boolean" &&
    typeof value.orgId === "string" &&
    typeof value.needsSequenceOwnerId === "string" &&
    typeof value.myLeadsEnabled === "boolean" &&
    typeof value.settingsRevision === "number" &&
    Number.isSafeInteger(value.settingsRevision)
  ) {
    return {
      ok: true,
      duplicate: value.duplicate,
      orgId: value.orgId,
      needsSequenceOwnerId: value.needsSequenceOwnerId,
      myLeadsEnabled: value.myLeadsEnabled,
      settingsRevision: value.settingsRevision,
    };
  }
  return {
    ok: false,
    code: "INVALID_INPUT",
    message: "The settings service returned an invalid settings result.",
  };
}

/** Owner-only designation mutation. The RPC performs authorization and CAS. */
export async function setAcquisitionDesignation(
  input: SetAcquisitionDesignationInput,
): Promise<AcquisitionDesignationResult> {
  const client = await createClient();
  const { data, error } = await client.rpc("fn_set_acquisition_designation", {
    p_enabled: input.enabled,
    p_expected_enabled: input.expectedEnabled,
    p_idempotency_key: input.idempotencyKey,
    p_org_id: input.orgId,
    p_user_id: input.userId,
  });
  if (error) return mapRpcError(error);
  return parseDesignationResult(data);
}

/** Owner-only recipient/settings mutation. Rollout remains a separate launch operation. */
export async function setAcquisitionSettings(
  input: SetAcquisitionSettingsInput,
): Promise<AcquisitionSettingsResult> {
  const client = await createClient();
  const { data, error } = await client.rpc("fn_set_acquisition_settings", {
    p_expected_settings_revision: input.expectedSettingsRevision,
    p_idempotency_key: input.idempotencyKey,
    p_needs_sequence_owner_id: input.needsSequenceOwnerId,
    p_org_id: input.orgId,
  });
  if (error) return mapRpcError(error);
  return parseSettingsResult(data);
}
