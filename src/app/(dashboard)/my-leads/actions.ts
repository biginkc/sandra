"use server";
import { revalidatePath } from "next/cache";
import { reportError } from "@/lib/errors/report";
import type { Json } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { startDripForLeads } from "@/app/(dashboard)/sequences/actions";
import {
  composeRepSms,
  type RepSmsComposition,
  type RepSmsCompositionInput,
} from "@/lib/messaging/rep-sms-composition";
import {
  createRepSmsObligationFence,
  dispatchRepSms,
} from "@/lib/messaging/rep-sms";
import {
  getAcquisitionQueue,
  getAcquisitionKpis,
  getAcquisitionDetail,
  getMyLeadsQueueRow,
  myLeadsViewer,
  MyLeadsReadError,
  type DetailGroup,
} from "@/lib/my-leads/queries";
import { listMyLeadsInDrip } from "@/lib/my-leads/drip-queries";
import {
  setAcquisitionDesignation,
  setAcquisitionSettings,
} from "@/lib/my-leads/settings";
import type {
  SetAcquisitionDesignationInput,
  SetAcquisitionSettingsInput,
} from "@/lib/my-leads/types";
import type { QueueStage } from "@/lib/my-leads/types";

export async function loadMyLeads(input: {
  memberId: string;
  search: string;
  period: "today" | "week" | "month" | "custom";
  startDate?: string;
  endDate?: string;
}) {
  try {
    const [snapshot, kpis, drips] = await Promise.all([
      getAcquisitionQueue(input),
      getAcquisitionKpis({ memberId: input.memberId, period: "today" }),
      listMyLeadsInDrip(input.memberId, input.search),
    ]);
    return { ok: true as const, snapshot, kpis, drips };
  } catch (error) {
    reportMyLeadsReadFailure("my_leads_queue");
    return {
      ok: false as const,
      message:
        error instanceof Error ? error.message : "Could not load My Leads.",
    };
  }
}
export async function loadMyLeadsStage(input: {
  memberId: string;
  search: string;
  stage: QueueStage;
  cursor: string;
}) {
  try {
    return { ok: true as const, snapshot: await getAcquisitionQueue(input) };
  } catch (error) {
    reportMyLeadsReadFailure("my_leads_stage");
    return {
      ok: false as const,
      message:
        error instanceof Error ? error.message : "Could not load this section.",
    };
  }
}
/**
 * How sure a failed command is about NOT having committed. The default is `unknown`.
 * `rejected` is an explicit allow-list:
 * - (a) pure app-side checks of the frozen payload made before any RPC (unsupported action,
 *   follow-up template/compose errors, handoff argument checks, a managerless request whose
 *   receipt lookup CONFIRMS no receipt);
 * - (b) these named SQL raises, which every command function makes AFTER its receipt lookup
 *   (a committed original would have returned its stored receipt first, and a raise rolls the
 *   whole call back): STALE_*, FEATURE_DISABLED, NOT_FOUND, DNC_LOCKED, PENDING_OFFER_EXISTS,
 *   RECIPIENT_UNAVAILABLE, PROVIDER_EVIDENCE_PENDING. Verified against
 *   supabase/migrations/20261003130000_my_leads_conflicts_non_retryable.sql and the log/finalize functions.
 * Everything else is `unknown`: transport/fetch errors, auth/session errors, unexpected
 * exceptions, missing confirmation, FORBIDDEN (access can change after an original committed, and it
 * is raised before the lookup in several functions), SQL INVALID_INPUT (log-attempt raises it for a
 * null auth.uid() before the lookup), UNAUTHENTICATED, recording/motivation checks, and
 * IDEMPOTENCY_CONFLICT, which has its own already-saved path.
 */
const viewerFailure = (error: unknown) =>
  (error as { code?: string })?.code === "UNAUTHENTICATED"
    ? failure(
        "unknown",
        "Your session expired. Sign in again, then Reconcile.",
        "UNAUTHENTICATED" as const,
      )
    : failure(
        "unknown",
        "Sign in with an active organization before updating a lead.",
      );
/**
 * True only for a real Postgres error RESPONSE: postgrest-js resolves transport failures
 * (fetch failed, abort) as `{ error: { code: "" }, status: 0 }`, a non-JSON gateway body as an
 * error with no code, and PostgREST's own errors with a longer `PGRST...` code. None of those
 * prove the function ran and rolled back. A raised SQLSTATE (P0001, 42501, ...) has status > 0
 * and exactly five characters.
 */
function isAnsweredRpcError(rpc: {
  status?: number;
  error?: { code?: string } | null;
}) {
  const code = rpc.error?.code;
  return (
    (rpc.status ?? 0) > 0 &&
    typeof code === "string" &&
    /^[0-9A-Z]{5}$/.test(code)
  );
}
/** Marks a failure built from an RPC error RESPONSE: the call reached Postgres and rolled back. Never set for transport failures, thrown calls or missing confirmation. */
const answeredWrapper =
  (rpc: { status?: number; error?: { code?: string } | null }) =>
  <T extends object>(failureResult: T) =>
    isAnsweredRpcError(rpc)
      ? { ...failureResult, answered: true as const }
      : failureResult;
class ReceiptLookupError extends Error {}
const ALREADY_SAVED = "This was already saved. Refresh to see it.";
type Certainty = "rejected" | "unknown";
const REJECTED_AFTER_LOOKUP = [
  "STALE_STATE",
  "STALE_ASSIGNMENT",
  "FEATURE_DISABLED",
  "NOT_FOUND",
  "DNC_LOCKED",
  "PENDING_OFFER_EXISTS",
  "RECIPIENT_UNAVAILABLE",
  "PROVIDER_EVIDENCE_PENDING",
];
const failure = <C extends string | undefined>(
  certainty: Certainty,
  message: string,
  code?: C,
) =>
  ({ ok: false as const, certainty, message, ...(code ? { code } : {}) }) as {
    ok: false;
    certainty: Certainty;
    message: string;
  } & (C extends string ? { code: C } : { code?: undefined });
const named = (message: string, names: readonly string[]) =>
  names.find((name) =>
    new RegExp(`^${name}\\b`).test(message.trim().toUpperCase()),
  );
/** Handoff with a drip records the outcome while keeping the current owner. */
export async function submitMyLeadHandoffDrip(input: {
  memberId: string;
  propertyId: string;
  sequenceId: string;
  reason: "not_interested";
  expectedEpisodeId: string;
  expectedQueueVersion: number;
  expectedSharedStatus: string;
  idempotencyKey: string;
}) {
  if (
    input.reason !== "not_interested" ||
    !input.sequenceId ||
    !input.idempotencyKey
  )
    return failure("rejected", "Choose an eligible handoff reason and drip.");
  let viewer;
  try {
    viewer = await myLeadsViewer();
  } catch (error) {
    return viewerFailure(error);
  }
  if (!viewer.isOwner && viewer.userId !== input.memberId)
    return failure("unknown", "You can update only your own queue.");
  let rpc: {
    data: { ok?: boolean } | null;
    error: { message?: string; code?: string } | null;
    status?: number;
  };
  try {
    rpc = await (
      viewer.client as unknown as {
        rpc(
          name: string,
          args: Record<string, string | number>,
        ): Promise<{
          data: { ok?: boolean } | null;
          error: { message?: string; code?: string } | null;
          status?: number;
        }>;
      }
    ).rpc("fn_handoff_acquisition_lead_to_drip", {
      p_org_id: viewer.orgId,
      p_member_id: input.memberId,
      p_property_id: input.propertyId,
      p_expected_episode_id: input.expectedEpisodeId,
      p_expected_queue_version: input.expectedQueueVersion,
      p_expected_shared_status: input.expectedSharedStatus,
      p_idempotency_key: input.idempotencyKey,
    });
  } catch {
    return failure(
      "unknown",
      "Could not save the handoff outcome. Please retry.",
    );
  }
  const { data, error } = rpc;
  const ans = answeredWrapper(rpc);
  if (error) {
    const message = error.message ?? "";
    if (named(message, ["IDEMPOTENCY_CONFLICT"]))
      return ans(
        failure("unknown", ALREADY_SAVED, "IDEMPOTENCY_CONFLICT" as const),
      );
    if (named(message, ["FORBIDDEN"]))
      return ans(
        failure(
          "unknown",
          "This lead is unavailable. Refresh and try again.",
          "FORBIDDEN" as const,
        ),
      );
    if (named(message, ["STALE_STATE", "STALE_ASSIGNMENT"]))
      return ans(
        failure(
          "rejected",
          "This lead changed. Refresh before trying again.",
          "STALE_STATE" as const,
        ),
      );
    if (named(message, REJECTED_AFTER_LOOKUP))
      return ans(
        failure("rejected", "This lead is unavailable. Refresh and try again."),
      );
    return ans(
      failure("unknown", "Could not save the handoff outcome. Please retry."),
    );
  }
  if (data?.ok !== true)
    return failure(
      "unknown",
      "The update was not confirmed. Retry with the same form.",
    );
  // The RPC committed. Nothing below may turn this into a failure.
  try {
    revalidatePath("/my-leads");
    revalidatePath("/leads");
    revalidatePath(`/leads/${input.propertyId}`);
  } catch {}
  try {
    const enrolled = await startDripForLeads(input.sequenceId, [
      input.propertyId,
    ]);
    if (!enrolled.ok)
      return { ok: true as const, dripFailure: enrolled.error.message };
    const item = enrolled.data.results[0];
    return {
      ok: true as const,
      ...(item?.status === "enrolled"
        ? {}
        : { dripFailure: item?.reason ?? "Could not start drip." }),
    };
  } catch {
    return { ok: true as const, dripFailure: "Could not start the drip." };
  }
}
/** One lead's current queue row (or why it is unavailable), for the pinned deep link and lead-page logging. */
export async function loadMyLeadRow(input: {
  memberId: string;
  propertyId: string;
}) {
  try {
    return { ok: true as const, lookup: await getMyLeadsQueueRow(input) };
  } catch (error) {
    const code = error instanceof MyLeadsReadError ? error.code : "READ_FAILED";
    if (code !== "NOT_FOUND" && code !== "FORBIDDEN")
      reportMyLeadsReadFailure("my_leads_row");
    return {
      ok: false as const,
      code,
      message:
        error instanceof Error ? error.message : "Could not load this lead.",
    };
  }
}
export async function loadMyLeadDetail(input: {
  memberId: string;
  propertyId: string;
  group?: DetailGroup;
  cursor?: string | null;
}) {
  try {
    return { ok: true as const, detail: await getAcquisitionDetail(input) };
  } catch (error) {
    reportMyLeadsReadFailure("my_leads_detail");
    return {
      ok: false as const,
      message:
        error instanceof Error ? error.message : "Could not load lead details.",
    };
  }
}
export async function loadMyLeadQueueRow(input: {
  memberId: string;
  propertyId: string;
}) {
  try {
    return { ok: true as const, lookup: await getMyLeadsQueueRow(input) };
  } catch {
    reportMyLeadsReadFailure("my_leads_queue_row");
    return {
      ok: false as const,
      message: "Could not load this lead. Please retry.",
    };
  }
}
function reportMyLeadsReadFailure(operation: string) {
  const diagnostic = new Error("My Leads read failed");
  diagnostic.name = "MyLeadsReadFailure";
  reportError(diagnostic, {
    errorClass: "database",
    tags: { surface: "server", operation, kind: "read_failure" },
  });
}
const commands = {
  "log-attempt": "fn_log_acquisition_attempt",
  "ready-for-offer": "fn_ready_acquisition_offer",
  "log-offer": "fn_log_acquisition_offer",
  "contract-signed": "fn_record_acquisition_contract",
  "decline-offer": "fn_decline_acquisition_offer",
  handoff: "fn_handoff_acquisition_lead",
  archive: "fn_archive_acquisition_contract",
} as const;
export async function submitMyLeadCommand(
  command: keyof typeof commands,
  input: Record<string, Json>,
) {
  if (!Object.hasOwn(commands, command))
    return failure("rejected", "Unsupported action.");
  let viewer;
  try {
    viewer = await myLeadsViewer();
  } catch (error) {
    return viewerFailure(error);
  }
  const client = viewer.client;
  input = { ...input, orgId: viewer.orgId };
  let composition: RepSmsComposition | null = null;
  if (command === "log-attempt" && input.outcome === "no_answer") {
    try {
      let legacyReplay = false;
      const supplied =
        input.followUp &&
        typeof input.followUp === "object" &&
        !Array.isArray(input.followUp)
          ? (input.followUp as RepSmsCompositionInput)
          : { body: typeof input.smsBody === "string" ? input.smsBody : null };
      // The no-answer path requires curated copy. This check runs before the
      // attempt RPC, so malformed or unapproved copy can never create work.
      if (!supplied.templateId)
        throw new Error("Choose a curated follow-up template.");
      if (
        typeof supplied.acquisitionsManager !== "string" ||
        !supplied.acquisitionsManager.trim()
      ) {
        // A pre-release request may be replayed after its attempt was saved.
        // Accept that exact key only when the durable command already exists;
        // never create a new Maria follow-up from an omitted name.
        const key =
          typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
        const operation =
          input.source === "sandra"
            ? "finalize_acquisition_attempt"
            : "log_acquisition_attempt";
        let receipt: { data: unknown; error: unknown } | null = null;
        try {
          receipt = key
            ? await createAdminClient()
                .from("acquisition_commands")
                .select("id")
                .eq("org_id", viewer.orgId)
                .eq("actor_user_id", viewer.userId)
                .eq("operation", operation)
                .eq("idempotency_key", key)
                .maybeSingle()
            : null;
        } catch {
          throw new ReceiptLookupError();
        }
        // A failed lookup proves nothing; only a confirmed absence is a rejection.
        if (receipt?.error) throw new ReceiptLookupError();
        if (!receipt?.data) throw new Error("Enter the acquisitions manager.");
        legacyReplay = true;
      }
      composition = composeRepSms(supplied);
      const followUpPayload: Record<string, unknown> = {
        ...composition,
        body: composition.finalBody,
      };
      if (legacyReplay) delete followUpPayload.acquisitionsManager;
      input = {
        ...input,
        smsBody: composition.finalBody,
        followUp: followUpPayload as Json,
      };
    } catch (error) {
      if (error instanceof ReceiptLookupError)
        return failure(
          "unknown",
          "The update could not be confirmed. Retry with the same form.",
        );
      return failure(
        "rejected",
        error instanceof Error
          ? error.message
          : "Choose a valid follow-up message.",
      );
    }
  }
  const rpcName =
    command === "log-attempt" && input.source === "sandra"
      ? "fn_finalize_acquisition_attempt"
      : commands[command];
  let rpc: {
    data: Json | null;
    error: { message?: string; code?: string } | null;
    status?: number;
  };
  try {
    rpc = await (
      client as unknown as {
        rpc(
          name: string,
          args: { p_input: Json },
        ): Promise<{
          data: Json | null;
          error: { message?: string; code?: string } | null;
          status?: number;
        }>;
      }
    ).rpc(rpcName, { p_input: input });
  } catch {
    return failure(
      "unknown",
      "The update could not be confirmed. Retry with the same form.",
    );
  }
  const { data, error } = rpc;
  const ans = answeredWrapper(rpc);
  if (error) {
    const message = error.message ?? "";
    // A receipt exists for this key with a different request: the save already went through.
    if (named(message, ["IDEMPOTENCY_CONFLICT"]))
      return ans(
        failure("unknown", ALREADY_SAVED, "IDEMPOTENCY_CONFLICT" as const),
      );
    if (named(message, ["UNAUTHENTICATED"]))
      return ans(
        failure(
          "unknown",
          "Your session expired. Sign in again, then Reconcile.",
          "UNAUTHENTICATED" as const,
        ),
      );
    if (named(message, ["FORBIDDEN"]))
      return ans(
        failure(
          "unknown",
          "This lead is unavailable or you no longer have access. Refresh to check access. Your draft is retained.",
          "FORBIDDEN" as const,
        ),
      );
    if (
      named(message, ["STALE_STATE", "STALE_ASSIGNMENT"]) ||
      message.includes("STALE_")
    )
      return ans(
        failure(
          "rejected",
          "This lead changed. Refresh before trying again.",
          "STALE_STATE" as const,
        ),
      );
    const certainty: Certainty = named(message, REJECTED_AFTER_LOOKUP)
      ? "rejected"
      : "unknown";
    if (message.includes("RECORDING_REQUIRED"))
      return ans(
        failure(
          certainty,
          "Attach the DialPad recording link before saving this call.",
          "RECORDING_REQUIRED" as const,
        ),
      );
    if (message.includes("MOTIVATION"))
      return ans(
        failure(
          certainty,
          "Specify motivation or choose No motivation provided.",
          "MOTIVATION_REQUIRED" as const,
        ),
      );
    return ans(
      failure(
        certainty,
        message.includes("PENDING_OFFER")
          ? "Resolve the current pending offer first."
          : message.includes("RECIPIENT")
            ? "The handoff recipient is unavailable. Ask the owner to update settings."
            : "The update could not be saved. Check the fields and retry.",
      ),
    );
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.ok !== true
  )
    return failure(
      "unknown",
      "The update was not confirmed. Retry with the same form.",
    );
  // The RPC committed. Nothing below may turn this into a failure.
  try {
    revalidatePath("/my-leads");
    revalidatePath("/leads");
    if (typeof input.propertyId === "string")
      revalidatePath(`/leads/${input.propertyId}`);
  } catch {}
  return finishCommitted({ command, viewer, input, data, composition });
}

async function finishCommitted(args: {
  command: keyof typeof commands;
  viewer: Awaited<ReturnType<typeof myLeadsViewer>>;
  input: Record<string, Json>;
  data: Json;
  composition: RepSmsComposition | null;
}) {
  const { command, viewer, input, data, composition } = args;
  const record = data as Record<string, unknown>;
  if (command === "log-attempt" && input.outcome === "no_answer") {
    // The attempt is committed; a failure while composing or sending the follow-up is reported as a follow-up status.
    try {
      return await finishNoAnswerFollowUp({
        viewer,
        input,
        record,
        composition,
      });
    } catch {
      return followUpResult(
        "unknown",
        "The attempt was saved, but its follow-up could not be confirmed.",
      );
    }
  }
  const followUpValue = record.followUp ?? record.follow_up;
  const followUp =
    followUpValue &&
    typeof followUpValue === "object" &&
    !Array.isArray(followUpValue)
      ? (followUpValue as { status?: unknown; message?: unknown })
      : null;
  const allowedFollowUpStatuses = new Set([
    "required",
    "draft",
    "sending",
    "accepted",
    "delivered",
    "delivery_failed",
    "blocked",
    "failed_not_dispatched",
    "unknown",
  ]);
  if (
    followUp &&
    typeof followUp.status === "string" &&
    allowedFollowUpStatuses.has(followUp.status)
  ) {
    return {
      ok: true as const,
      attemptRecorded: command === "log-attempt",
      followUp: {
        status: followUp.status as
          | "required"
          | "draft"
          | "sending"
          | "accepted"
          | "delivered"
          | "delivery_failed"
          | "blocked"
          | "failed_not_dispatched"
          | "unknown",
        message: typeof followUp.message === "string" ? followUp.message : null,
      },
    };
  }
  return {
    ok: true as const,
    ...(command === "log-attempt" ? { attemptRecorded: true as const } : {}),
  };
}

type FollowUpStatus =
  | "required"
  | "draft"
  | "sending"
  | "accepted"
  | "delivered"
  | "delivery_failed"
  | "blocked"
  | "failed_not_dispatched"
  | "unknown";

type ObligationRpc = {
  data: Json | null;
  error: { message?: string; code?: string } | null;
};

function followUpResult(status: FollowUpStatus, message?: string | null) {
  return {
    ok: true as const,
    attemptRecorded: true as const,
    followUp: { status, message: message ?? null },
  };
}

async function finishNoAnswerFollowUp(args: {
  viewer: Awaited<ReturnType<typeof myLeadsViewer>>;
  input: Record<string, Json>;
  record: Record<string, unknown>;
  composition: RepSmsComposition | null;
}) {
  const obligationId =
    typeof args.record.obligationId === "string"
      ? args.record.obligationId
      : typeof args.record.obligation_id === "string"
        ? args.record.obligation_id
        : null;
  if (!obligationId || !args.composition) {
    return followUpResult(
      "blocked",
      "Attempt recorded. Follow-up texting is not enabled for this rep.",
    );
  }

  let admin: {
    rpc(name: string, input: Record<string, unknown>): Promise<ObligationRpc>;
  };
  try {
    admin = createAdminClient() as unknown as {
      rpc(name: string, input: Record<string, unknown>): Promise<ObligationRpc>;
    };
  } catch {
    return followUpResult(
      "unknown",
      "Attempt recorded. Follow-up authorization is unavailable; refresh before retrying.",
    );
  }
  let claim: ObligationRpc;
  try {
    claim = await admin.rpc("fn_claim_authorize_rep_sms_obligation", {
      p_org_id: args.viewer.orgId,
      p_obligation_id: obligationId,
      p_actor_id: args.viewer.userId,
      p_composition: {
        ...args.composition,
        body: args.composition.finalBody,
      },
    });
  } catch {
    return followUpResult(
      "unknown",
      "Attempt recorded. Follow-up authorization could not be confirmed. Refresh before retrying.",
    );
  }
  if (
    claim.error ||
    !claim.data ||
    typeof claim.data !== "object" ||
    Array.isArray(claim.data)
  ) {
    return followUpResult(
      "unknown",
      "Attempt recorded. Follow-up authorization could not be confirmed. Refresh before retrying.",
    );
  }
  const claimRecord = claim.data as Record<string, unknown>;
  const claimState =
    typeof claimRecord.state === "string" ? claimRecord.state : null;
  const claimMessage =
    typeof claimRecord.reason === "string" ? claimRecord.reason : null;
  if (claimRecord.ok !== true) {
    if (claimState && isFollowUpStatus(claimState))
      return followUpResult(claimState, claimMessage);
    return followUpResult(
      "unknown",
      claimMessage ??
        "Attempt recorded. Follow-up authorization could not be confirmed.",
    );
  }
  if (
    claimState !== "sending" ||
    typeof claimRecord.claimToken !== "string" ||
    typeof claimRecord.claimGeneration !== "number" ||
    !Number.isInteger(claimRecord.claimGeneration) ||
    typeof claimRecord.assignmentId !== "string" ||
    typeof claimRecord.toNumber !== "string"
  ) {
    return followUpResult(
      "unknown",
      "Attempt recorded. Follow-up authorization returned an invalid fence. Refresh before retrying.",
    );
  }

  let dispatchOutcome: Awaited<ReturnType<typeof dispatchRepSms>>;
  try {
    dispatchOutcome = await dispatchRepSms({
      propertyId: String(args.input.propertyId),
      assignmentId: claimRecord.assignmentId,
      to: claimRecord.toNumber,
      obligationFence: createRepSmsObligationFence({
        obligationId,
        claimToken: claimRecord.claimToken,
        claimGeneration: claimRecord.claimGeneration,
        actorId: args.viewer.userId,
        propertyId: String(args.input.propertyId),
        assignmentId: claimRecord.assignmentId,
        toNumber: claimRecord.toNumber,
        composition: args.composition,
      }),
      composition: args.composition,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Authorization is already durable. An exception cannot prove whether the
    // provider request was reached, so keep the obligation review-only rather
    // than exposing a retry that could send a duplicate SMS.
    return persistFollowUpResult(
      admin,
      obligationId,
      claimRecord.claimToken,
      "unknown",
      reason,
      args.composition,
    );
  }

  const outcome = dispatchOutcome as Record<string, unknown>;
  const providerId =
    typeof outcome.externalId === "string" ? outcome.externalId : null;
  const reason =
    typeof outcome.error === "string"
      ? outcome.error
      : typeof outcome.reason === "string"
        ? outcome.reason
        : `Dispatch returned ${String(outcome.status ?? "unknown")}.`;
  if (
    outcome.status === "sent" ||
    (outcome.status === "db_error" && providerId)
  ) {
    return persistFollowUpResult(
      admin,
      obligationId,
      claimRecord.claimToken,
      "accepted",
      providerId,
      args.composition,
    );
  }
  if (
    typeof outcome.status === "string" &&
    outcome.status.startsWith("blocked_")
  ) {
    return persistFollowUpResult(
      admin,
      obligationId,
      claimRecord.claimToken,
      "blocked",
      reason,
      args.composition,
    );
  }
  if (
    outcome.status === "provider_failed" &&
    outcome.providerAttempted === false
  ) {
    return persistFollowUpResult(
      admin,
      obligationId,
      claimRecord.claimToken,
      "failed_not_dispatched",
      reason,
      args.composition,
    );
  }
  // Once dispatchRepSms has crossed its provider boundary, a provider failure
  // is ambiguous. Keep it unknown; only an exception before that call can be
  // reported as failed_not_dispatched.
  return persistFollowUpResult(
    admin,
    obligationId,
    claimRecord.claimToken,
    "unknown",
    reason,
    args.composition,
  );
}

function isFollowUpStatus(value: string): value is FollowUpStatus {
  return [
    "required",
    "draft",
    "sending",
    "accepted",
    "delivered",
    "delivery_failed",
    "blocked",
    "failed_not_dispatched",
    "unknown",
  ].includes(value);
}

async function persistFollowUpResult(
  admin: {
    rpc(name: string, input: Record<string, unknown>): Promise<ObligationRpc>;
  },
  obligationId: string,
  claimToken: string,
  state: "accepted" | "blocked" | "failed_not_dispatched" | "unknown",
  value: string | null,
  composition: RepSmsComposition,
) {
  let result: ObligationRpc;
  try {
    result = await admin.rpc("fn_record_rep_sms_obligation_result", {
      p_obligation_id: obligationId,
      p_claim_token: claimToken,
      p_state: state,
      p_provider_message_id: state === "accepted" ? value : null,
      p_provider_error:
        state === "accepted" ? null : (value ?? `Follow-up ${state}.`),
      p_metadata: {
        policyVersion: composition.policyVersion,
        introId: composition.introId,
        introVersion: composition.introVersion,
        templateId: composition.templateId,
        templateVersion: composition.templateVersion,
        initialRemainder: composition.initialRemainder,
        remainder: composition.remainder,
        body: composition.finalBody,
      } as Json,
    });
  } catch {
    return followUpResult(
      "unknown",
      "Attempt recorded. Follow-up result could not be persisted; refresh before retrying.",
    );
  }
  if (
    result.error ||
    !result.data ||
    typeof result.data !== "object" ||
    Array.isArray(result.data) ||
    (result.data as Record<string, unknown>).ok !== true
  ) {
    return followUpResult(
      "unknown",
      "Attempt recorded. Follow-up result could not be persisted; refresh before retrying.",
    );
  }
  // Provider callbacks may win the race before this worker records its
  // accepted result. Return the database's stored state so the Attempts UI
  // cannot report an early delivery failure or delivery as accepted.
  const saved = result.data as Record<string, unknown>;
  const storedState =
    typeof saved.state === "string" && isFollowUpStatus(saved.state)
      ? saved.state
      : state;
  const storedError =
    typeof saved.providerError === "string" ? saved.providerError : value;
  return followUpResult(
    storedState,
    storedState === "accepted" || storedState === "delivered"
      ? null
      : storedError,
  );
}

export async function changeAcquisitionDesignation(
  input: SetAcquisitionDesignationInput,
) {
  const result = await setAcquisitionDesignation(input);
  if (result.ok) revalidatePath("/my-leads");
  return result;
}
export async function changeAcquisitionSettings(
  input: SetAcquisitionSettingsInput,
) {
  const result = await setAcquisitionSettings(input);
  if (result.ok) revalidatePath("/my-leads");
  return result;
}

export async function loadMyLeadCallReferences(
  propertyId: string,
  memberId: string,
) {
  try {
    const viewer = await myLeadsViewer();
    const { data, error } = await (
      viewer.client as unknown as {
        rpc(
          name: string,
          args: Record<string, string>,
        ): Promise<{
          data: { id: string; occurredAt: string }[] | null;
          error: unknown;
        }>;
      }
    ).rpc("fn_get_acquisition_call_references", {
      p_org_id: viewer.orgId,
      p_property_id: propertyId,
      p_member_id: memberId,
    });
    if (error || !data)
      return {
        ok: false as const,
        message: "Could not load pending call references.",
      };
    return {
      ok: true as const,
      options: data.map((call) => ({
        id: call.id,
        label:
          new Intl.DateTimeFormat("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "America/Chicago",
          }).format(new Date(call.occurredAt)) + " Central",
      })),
    };
  } catch {
    return {
      ok: false as const,
      message: "Could not load pending call references.",
    };
  }
}
