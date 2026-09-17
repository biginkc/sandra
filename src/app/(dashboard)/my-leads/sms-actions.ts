"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { errFromUnknown, ok } from "@/lib/errors/result";
import { normalizePhone } from "@/lib/csv/normalize";
import type { DialpadFromOption, ProviderSenderNumber } from "@/lib/messaging/types";
import {
  REP_SMS_PROVIDER_ID,
  providerForRepSms,
  readRepSmsContext,
  repSmsCatalogOptionIsEligible,
  dispatchRepSms,
  createRepSmsObligationFence,
  type DispatchRepSmsInput,
} from "@/lib/messaging/rep-sms";
import { composeRepSms, type RepSmsCompositionInput } from "@/lib/messaging/rep-sms-composition";

export async function loadRepSmsContext(propertyId: string) {
  try {
    return ok(await readRepSmsContext(propertyId));
  } catch (error) {
    return errFromUnknown(error, "TEXTING_UNAVAILABLE");
  }
}

type PublicSendRepSmsInput = Omit<DispatchRepSmsInput, "obligationFence"> & {
  obligationId?: string | null;
};

function safeDispatchInput(input: PublicSendRepSmsInput): DispatchRepSmsInput {
  // Server actions are reachable with forged runtime payloads even when their
  // TypeScript input omits a field. Pick every public field explicitly so a
  // browser cannot smuggle an internal claim fence into the generic dispatch
  // path or into resumeRepSms.
  return {
    propertyId: input.propertyId,
    assignmentId: input.assignmentId,
    idempotencyKey: input.idempotencyKey,
    body: input.body,
    to: input.to,
    composition: input.composition,
    introId: input.introId,
    introVersion: input.introVersion,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    initialRemainder: input.initialRemainder,
    remainder: input.remainder,
    initialBody: input.initialBody,
  };
}

export async function sendRepSms(input: PublicSendRepSmsInput) {
  try {
    const safeInput = safeDispatchInput(input);
    // A no-answer follow-up is durable. Resume that exact obligation after a
    // reload instead of falling back to the generic manual sender.
    const obligationId = typeof input.obligationId === "string" ? input.obligationId.trim() : "";
    if (obligationId) {
      return ok({ outcome: await resumeRepSms({ ...safeInput, obligationId }) });
    }
    const context = await readRepSmsContext(safeInput.propertyId);
    if (context.obligation) {
      throw new Error(
        "This lead has a saved SMS follow-up. Resume the exact saved follow-up before sending another message.",
      );
    }
    return ok({ outcome: await dispatchRepSms(safeInput) });
  } catch (error) {
    return errFromUnknown(error, "TEXTING_UNAVAILABLE");
  }
}

type ObligationRpc = {
  data: unknown;
  error: { message?: string; code?: string } | null;
};

const RESUMABLE_OBLIGATION_STATES = new Set(["required", "draft", "failed_not_dispatched"]);

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function resultReason(value: Record<string, unknown>, fallback: string): string {
  for (const key of ["reason", "error"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return fallback;
}

async function persistResumedResult(
  admin: { rpc(name: string, input: Record<string, unknown>): Promise<ObligationRpc> },
  obligationId: string,
  claimToken: string,
  state: "accepted" | "blocked" | "failed_not_dispatched" | "delivery_failed" | "unknown",
  value: string | null,
  composition: ReturnType<typeof composeRepSms>,
  messageId?: string | null,
) {
  const result = await admin.rpc("fn_record_rep_sms_obligation_result", {
    p_obligation_id: obligationId,
    p_claim_token: claimToken,
    p_state: state,
    p_provider_message_id: state === "accepted" ? value : null,
    p_provider_error: state === "accepted" ? null : value ?? `Follow-up ${state}.`,
    p_metadata: {
      policyVersion: composition.policyVersion,
      introId: composition.introId,
      introVersion: composition.introVersion,
      templateId: composition.templateId,
      templateVersion: composition.templateVersion,
      initialRemainder: composition.initialRemainder,
      remainder: composition.remainder,
      body: composition.finalBody,
    },
  });
  const saved = recordValue(result.data);
  if (result.error || !saved || saved.ok !== true) {
    return { status: "unknown" as const, reason: "Follow-up result could not be persisted; review the text history before retrying." };
  }
  // A delivery callback can settle the durable obligation while the provider
  // result is still in flight. The RPC response is authoritative; never turn
  // that stored terminal state back into an accepted result for the caller.
  const storedState = saved.state === "delivered" || saved.state === "delivery_failed"
    ? saved.state
    : state;
  const storedMessageId = messageId ?? (typeof saved.messageId === "string" ? saved.messageId : undefined);
  const storedProviderId = typeof saved.providerMessageId === "string" ? saved.providerMessageId : value;
  const storedError = typeof saved.providerError === "string" ? saved.providerError : value;
  if (storedState === "delivered") {
    return { status: "delivered" as const, messageId: storedMessageId, externalId: storedProviderId ?? "" };
  }
  if (storedState === "delivery_failed") {
    return { status: "provider_failed" as const, messageId: storedMessageId ?? obligationId, error: storedError ?? "The provider reported delivery failure." };
  }
  return storedState === "accepted"
    ? { status: "sent" as const, messageId: storedMessageId, externalId: storedProviderId ?? "" }
    : { status: storedState, reason: storedError ?? `Follow-up ${storedState}.` };
}

async function resumeRepSms(input: DispatchRepSmsInput & { obligationId: string }) {
  const context = await readRepSmsContext(input.propertyId);
  const obligation = context.obligation;
  if (!obligation || obligation.id !== input.obligationId) {
    throw new Error("The saved follow-up is no longer the current lead obligation. Refresh before sending.");
  }
  if (!RESUMABLE_OBLIGATION_STATES.has(obligation.status)) {
    const detail = obligation.blockedReason ?? `The saved follow-up is ${obligation.status.replaceAll("_", " ")}.`;
    // Ambiguous and terminal rows are review-only. The browser cannot turn
    // these into a fresh send by replaying the generic composer.
    return { status: "unknown" as const, reason: `${detail} Automatic retry is disabled; review or close the obligation.` };
  }

  const suppliedComposition = (input.composition ?? obligation.composition ?? {}) as RepSmsCompositionInput;
  const composition = composeRepSms(suppliedComposition);
  const admin = createAdminClient() as unknown as {
    rpc(name: string, input: Record<string, unknown>): Promise<ObligationRpc>;
  };
  const claim = await admin.rpc("fn_claim_authorize_rep_sms_obligation", {
    p_org_id: context.orgId,
    p_obligation_id: obligation.id,
    p_actor_id: context.actorId,
    p_composition: { ...composition, body: composition.finalBody },
  });
  const claimRecord = recordValue(claim.data);
  if (claim.error || !claimRecord) {
    throw new Error("Follow-up authorization could not be confirmed. Refresh before retrying.");
  }
  if (claimRecord.ok !== true) {
    const reason = resultReason(claimRecord, "Follow-up authorization was not granted.");
    return { status: "unknown" as const, reason: `${reason} Automatic retry is disabled; review or close the obligation.` };
  }
  if (claimRecord.state !== "sending" || typeof claimRecord.claimToken !== "string"
    || typeof claimRecord.claimGeneration !== "number"
    || !Number.isInteger(claimRecord.claimGeneration)
    || typeof claimRecord.assignmentId !== "string" || typeof claimRecord.toNumber !== "string") {
    throw new Error("Follow-up authorization returned an invalid fence. Refresh before retrying.");
  }

  let dispatchOutcome: Awaited<ReturnType<typeof dispatchRepSms>>;
  try {
    dispatchOutcome = await dispatchRepSms({
      propertyId: input.propertyId,
      assignmentId: claimRecord.assignmentId,
      // The database claim owns the recipient. Ignore any stale browser hint.
      to: claimRecord.toNumber,
      obligationFence: {
        ...createRepSmsObligationFence({
          obligationId: obligation.id,
          claimToken: claimRecord.claimToken,
          claimGeneration: claimRecord.claimGeneration,
          actorId: context.actorId,
          propertyId: input.propertyId,
          assignmentId: claimRecord.assignmentId,
          toNumber: claimRecord.toNumber,
          composition,
        }),
      },
      idempotencyKey: obligation.id,
      composition,
    });
  } catch (error) {
    // Once authorization is durable, an exception may occur on either side of
    // the provider boundary. Unknown is the only safe state to persist.
    const reason = error instanceof Error ? error.message : String(error);
    return persistResumedResult(admin, obligation.id, claimRecord.claimToken, "unknown", reason, composition);
  }
  const outcome = dispatchOutcome as Record<string, unknown>;
  const providerId = typeof outcome.externalId === "string" ? outcome.externalId : null;
  const messageId = typeof outcome.messageId === "string" ? outcome.messageId : null;
  const reason = resultReason(outcome, `Dispatch returned ${String(outcome.status ?? "unknown")}.`);
  if (outcome.status === "sent" || (outcome.status === "db_error" && providerId)) {
    return persistResumedResult(admin, obligation.id, claimRecord.claimToken, "accepted", providerId, composition, messageId);
  }
  if (typeof outcome.status === "string" && outcome.status.startsWith("blocked_")) {
    return persistResumedResult(admin, obligation.id, claimRecord.claimToken, "blocked", reason, composition);
  }
  if (outcome.status === "provider_failed" && outcome.providerAttempted === false) {
    return persistResumedResult(admin, obligation.id, claimRecord.claimToken, "failed_not_dispatched", reason, composition);
  }
  // Once dispatchRepSms has crossed its provider boundary, a provider failure
  // or deferral does not prove non-delivery. Keep the durable obligation
  // ambiguous so an owner can reconcile the provider receipt before another
  // attempt is considered. Only the explicit providerAttempted=false signal
  // is safe to retry.
  if (outcome.status === "provider_failed" || outcome.status === "provider_deferred") {
    return persistResumedResult(admin, obligation.id, claimRecord.claimToken, "unknown", reason, composition);
  }
  return persistResumedResult(admin, obligation.id, claimRecord.claimToken, "unknown", reason, composition);
}

async function requireOwner(orgId: string) {
  const memberships = await getCallerMembershipsOrThrow();
  if (
    !memberships.some(
      (membership) =>
        membership.org_id === orgId &&
        membership.role === "owner" &&
        hasActiveSandraAccess(membership),
    )
  ) {
    throw new Error("Owner access required.");
  }
}

function toFromOption(entry: {
  phoneE164: string;
  status: string | null;
}): DialpadFromOption {
  return {
    number: entry.phoneE164,
    ownerName: "Sendillo",
    ownerType: "sendillo",
    status: entry.status ?? "active",
  };
}

function samePhone(left: string | null | undefined, right: string): boolean {
  const normalized = left ? normalizePhone(left) ?? left.trim() : "";
  return normalized === (normalizePhone(right) ?? right.trim());
}

function rawString(value: unknown, ...path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function catalogAccountId(entry: ProviderSenderNumber): string | null {
  return (
    entry.providerAccountId?.trim() ||
    rawString(entry.raw, "providerAccountId") ||
    rawString(entry.raw, "provider_account_id") ||
    rawString(entry.raw, "accountId") ||
    rawString(entry.raw, "account_id") ||
    rawString(entry.raw, "account", "id") ||
    rawString(entry.raw, "account", "accountId") ||
    null
  );
}

export async function loadRepSmsNumbers(orgId: string) {
  try {
    await requireOwner(orgId);
    const provider = providerForRepSms();
    if (provider.providerId !== REP_SMS_PROVIDER_ID && provider.providerId !== "mock") {
      throw new Error("Rep texting is available only through Sendillo.");
    }
    if (typeof provider.listPurchasedNumbers === "function") {
      const purchased = await provider.listPurchasedNumbers();
      return ok(
        purchased
          .filter(repSmsCatalogOptionIsEligible)
          .map(toFromOption),
      );
    }
    if (typeof provider.listFromNumbers !== "function") {
      throw new Error("The configured SMS provider cannot list sender numbers.");
    }
    return ok((await provider.listFromNumbers()).filter(repSmsCatalogOptionIsEligible));
  } catch (error) {
    return errFromUnknown(error, "TEXTING_NUMBERS_UNAVAILABLE");
  }
}

export type SaveRepSmsSenderInput = {
  orgId: string;
  userId: string;
  number: string;
  label: string;
  isDefault: boolean;
  active: boolean;
  /** Defaults to the only supported production provider. */
  provider?: string | null;
  /** Optional client hints; the live provider catalog remains authoritative. */
  providerAccountId?: string | null;
  providerSenderId?: string | null;
};

export async function saveRepSmsSender(input: SaveRepSmsSenderInput) {
  try {
    await requireOwner(input.orgId);
    const provider = providerForRepSms();
    const providerId = input.provider?.trim().toLowerCase() || REP_SMS_PROVIDER_ID;
    if (providerId !== provider.providerId || providerId !== REP_SMS_PROVIDER_ID) {
      throw new Error("Rep texting assignments must use Sendillo.");
    }
    // Provider identities are authoritative catalog data. Ignore client
    // hints for a revoke so an owner action cannot rewrite the audit identity
    // of an existing grant while deactivating it.
    let providerAccountId: string | null = null;
    let providerSenderId: string | null = null;
    if (input.active) {
      if (typeof provider.listPurchasedNumbers !== "function") {
        throw new Error("Sendillo sender catalog is unavailable. Refresh and retry.");
      }
      const purchased = await provider.listPurchasedNumbers();
      const match = purchased.find((entry) => samePhone(entry.phoneE164, input.number));
      if (!match || !repSmsCatalogOptionIsEligible(match)) {
        throw new Error("Choose an eligible Sendillo number.");
      }
      const catalogSenderId = match.providerNumberId?.trim() || null;
      if (!catalogSenderId) {
        throw new Error("Sendillo did not return an auditable sender identity. Refresh and retry.");
      }
      const catalogId = catalogAccountId(match);
      if (!catalogId) {
        throw new Error("Sendillo did not return a stable account identity for this sender. Refresh and retry.");
      }
      const requestedSenderId = input.providerSenderId?.trim() || null;
      const requestedAccountId = input.providerAccountId?.trim() || null;
      if (requestedSenderId && requestedSenderId !== catalogSenderId) {
        throw new Error("The selected Sendillo sender identity changed. Refresh and retry.");
      }
      if (requestedAccountId && requestedAccountId !== catalogId) {
        throw new Error("The selected Sendillo account identity changed. Refresh and retry.");
      }
      providerSenderId = catalogSenderId;
      providerAccountId = catalogId;
    }
    const client = await createClient();
    // The provider-aware migration adds p_provider while older local test
    // schemas may only expose the original function. Keep this boundary
    // explicit and typed as a function call so the app never writes a raw
    // assignment row around the owner/RLS checks.
    const rpcClient = client as unknown as {
      rpc: (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
    };
    const { data, error } = await rpcClient.rpc("fn_set_rep_sms_sender", {
      p_org_id: input.orgId,
      p_user_id: input.userId,
      p_provider: providerId,
      p_phone: input.number,
      p_provider_account_id: providerAccountId,
      p_provider_sender_id: providerSenderId,
      p_label: input.label,
      p_default: input.isDefault,
      p_active: input.active,
    });
    if (error) {
      throw new Error(
        error.message ?? "Texting assignment could not be saved. Check the member and retry.",
      );
    }
    return ok(data);
  } catch (error) {
    return errFromUnknown(error, "TEXTING_ASSIGNMENT_FAILED");
  }
}

export async function loadRepSmsAssignments(orgId: string) {
  try {
    await requireOwner(orgId);
    const client = await createClient();
    const { data, error } = await client
      .from("rep_sms_sender_assignments")
      .select("id,user_id,provider,phone_e164,label,is_default,active")
      .eq("org_id", orgId)
      .eq("active", true);
    if (error) throw new Error("Texting assignments could not be loaded. Please retry.");
    return ok(data);
  } catch (error) {
    return errFromUnknown(error, "TEXTING_ASSIGNMENTS_UNAVAILABLE");
  }
}
