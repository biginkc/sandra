import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";
import type {
  AcquisitionCommandFailure,
  AcquisitionCommandResult,
  AcquisitionErrorCode,
  ArchiveAcquisitionContractInput,
  DeclineAcquisitionOfferInput,
  HandoffAcquisitionLeadInput,
  LogAcquisitionOfferInput,
  RecordAcquisitionContractInput,
  ReadyAcquisitionOfferInput,
} from "./types";

type RpcError = { code?: string | null; message?: string | null };

const errorMessages: Record<AcquisitionErrorCode, string> = {
  UNAUTHENTICATED: "Sign in to manage this lead.",
  FORBIDDEN: "You do not have access to this lead.",
  FEATURE_DISABLED: "My Leads is disabled for this organization.",
  NOT_FOUND: "This lead is no longer available.",
  STALE_ASSIGNMENT: "This lead was reassigned. Refresh and try again.",
  STALE_STATE: "This lead changed in another session. Refresh and try again.",
  DNC_LOCKED: "This lead is protected by its do-not-call lock.",
  INVALID_INPUT: "Review the fields and try again.",
  IDEMPOTENCY_CONFLICT: "That request ID was already used for different data.",
  RECIPIENT_UNAVAILABLE: "The configured handoff recipient is unavailable.",
  PENDING_OFFER_EXISTS: "This lead already has a pending offer.",
  PROVIDER_EVIDENCE_PENDING: "Call evidence is still being recorded.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcFailure(error: RpcError): AcquisitionCommandFailure {
  const text = (error.message ?? "").toUpperCase();
  const knownCodes: AcquisitionErrorCode[] = [
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "FEATURE_DISABLED",
    "NOT_FOUND",
    "STALE_ASSIGNMENT",
    "STALE_STATE",
    "DNC_LOCKED",
    "INVALID_INPUT",
    "IDEMPOTENCY_CONFLICT",
    "RECIPIENT_UNAVAILABLE",
    "PENDING_OFFER_EXISTS",
    "PROVIDER_EVIDENCE_PENDING",
  ];
  const namedCode = knownCodes.find((code) => text.includes(code));
  const code: AcquisitionErrorCode =
    namedCode ??
    (error.code === "23505" ? "IDEMPOTENCY_CONFLICT" :
      error.code === "42501" ? "FORBIDDEN" :
        error.code === "40001" ? "STALE_STATE" : "INVALID_INPUT");
  return { ok: false, code, message: errorMessages[code] };
}

function parseResult(value: unknown): AcquisitionCommandResult {
  if (
    isRecord(value) &&
    value.ok === true &&
    typeof value.duplicate === "boolean" &&
    typeof value.propertyId === "string" &&
    typeof value.queueVersion === "number" &&
    Number.isSafeInteger(value.queueVersion) &&
    (value.stage === null ||
      value.stage === "not_contacted" ||
      value.stage === "contacted" ||
      value.stage === "needs_offer" ||
      value.stage === "offer_sent" ||
      value.stage === "under_contract") &&
    typeof value.archived === "boolean"
  ) {
    return {
      ok: true,
      duplicate: value.duplicate,
      propertyId: value.propertyId,
      queueVersion: value.queueVersion,
      stage: value.stage,
      archived: value.archived,
      ...(typeof value.attemptId === "string" ? { attemptId: value.attemptId } : {}),
      ...(typeof value.offerId === "string" ? { offerId: value.offerId } : {}),
      ...(typeof value.assignmentEpisodeId === "string"
        ? { assignmentEpisodeId: value.assignmentEpisodeId }
        : {}),
    };
  }
  return {
    ok: false,
    code: "INVALID_INPUT",
    message: "The workflow service returned an invalid result.",
  };
}

async function finish(
  request: PromiseLike<{ data: Json | null; error: RpcError | null }>,
): Promise<AcquisitionCommandResult> {
  const { data, error } = await request;
  if (error) return rpcFailure(error);
  return parseResult(data);
}

/** Promote a contacted lead to Needs offer after recording its motivation. */
export async function readyAcquisitionOffer(
  input: ReadyAcquisitionOfferInput,
): Promise<AcquisitionCommandResult> {
  const client = await createClient();
  return finish(
    client.rpc("fn_ready_acquisition_offer", { p_input: input as unknown as Json }),
  );
}

/** Record an offer already made by a representative. This never sends it. */
export async function logAcquisitionOffer(
  input: LogAcquisitionOfferInput,
): Promise<AcquisitionCommandResult> {
  const client = await createClient();
  return finish(
    client.rpc("fn_log_acquisition_offer", { p_input: input as unknown as Json }),
  );
}

export async function recordAcquisitionContract(
  input: RecordAcquisitionContractInput,
): Promise<AcquisitionCommandResult> {
  const client = await createClient();
  return finish(
    client.rpc("fn_record_acquisition_contract", { p_input: input as unknown as Json }),
  );
}

export async function declineAcquisitionOffer(
  input: DeclineAcquisitionOfferInput,
): Promise<AcquisitionCommandResult> {
  const client = await createClient();
  return finish(
    client.rpc("fn_decline_acquisition_offer", { p_input: input as unknown as Json }),
  );
}

export async function handoffAcquisitionLead(
  input: HandoffAcquisitionLeadInput,
): Promise<AcquisitionCommandResult> {
  const client = await createClient();
  return finish(
    client.rpc("fn_handoff_acquisition_lead", { p_input: input as unknown as Json }),
  );
}

export async function archiveAcquisitionContract(
  input: ArchiveAcquisitionContractInput,
): Promise<AcquisitionCommandResult> {
  const client = await createClient();
  return finish(
    client.rpc("fn_archive_acquisition_contract", { p_input: input as unknown as Json }),
  );
}
