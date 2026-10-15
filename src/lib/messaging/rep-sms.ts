import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ConfigurationError } from "@/lib/errors/classes";
import { normalizePhone } from "@/lib/csv/normalize";
import { getConsentState } from "./consent";
import { evaluateSuppression } from "./suppression";
import { isSmsPhoneSuppressed } from "./opt-out-phone";
import { selectBestSmsPhone, selectSmsPhoneByNumber } from "./sms-phone";
import { getMessagingProvider } from "./registry";
import { sendSmsToContact, type RepSmsDeliveryReceiptAuthority, type SendSmsOutcome } from "./send";
import { sendilloFromEnvWithOptions } from "./providers/sendillo";
import { assertSendilloOrganizationScope } from "./rep-sms-scope";
import { resolveInboundStamp } from "./inbound-stamp";
import type { DialpadFromOption, MessagingProvider, ProviderSenderNumber } from "./types";
import {
  composeRepSms,
  REP_SMS_COMPOSITION_POLICY_VERSION,
  REP_SMS_PERSONA,
  REP_SMS_ASSISTANT,
  type RepSmsComposition,
  type RepSmsCompositionInput,
} from "./rep-sms-composition";

export const REP_SMS_PROVIDER_ID = "sendillo" as const;

/** A grant is bound to the provider as well as the E.164 sender. */
export type RepSmsSender = {
  id: string;
  number: string;
  label: string;
  isDefault: boolean;
  provider?: string | null;
  providerAccountId?: string | null;
  providerSenderId?: string | null;
  grantStatus?: string | null;
  grantedAt?: string | null;
  revokedAt?: string | null;
  compositionPolicyVersion?: number | null;
};

export type RepSmsPendingObligation = {
  id: string;
  attemptId: string;
  status: string;
  messageBody: string | null;
  composition: Record<string, unknown> | null;
  blockedReason: string | null;
  senderAssignmentId: string | null;
  fromNumber: string | null;
  toNumber: string | null;
};

/**
 * A generic manual SMS draft that has reached the service-owned delivery
 * ledger.  The browser may lose its localStorage copy, so recovery must use
 * this immutable server record and keep the original key, body, sender, and
 * recipient together.
 */
export type RepSmsPendingSubmission = {
  key: string;
  receiptId: string;
  state: string;
  assignmentId: string;
  from: string;
  to: string;
  body: string;
  composition: Record<string, unknown> | null;
  providerMessageId: string | null;
  providerError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type RepSmsObligationFence = {
  obligationId: string;
  claimToken: string;
  claimGeneration: number;
  actorId: string;
  /** Server-created binding for the exact outbound request this claim owns. */
  propertyId: string;
  assignmentId: string;
  toNumber: string;
  compositionFingerprint: string;
};

type RepSmsDeliveryLedgerRecord = {
  ok?: unknown;
  receiptId?: unknown;
  state?: unknown;
  claimToken?: unknown;
  claimGeneration?: unknown;
  messageId?: unknown;
  providerMessageId?: unknown;
  providerError?: unknown;
  reason?: unknown;
};

type RepSmsDeliveryLedgerRpc = {
  data: unknown;
  error: { message?: string; code?: string } | null;
};

/**
 * The exact failed/unverified record a My Leads Broken item points at. refId wins over "the lead's saved submission"
 * so a lead with several failures resumes, resends or checks the one the rep chose. The ledger is not directly readable
 * (no grants), so it is read through a SECURITY DEFINER read function; obligations and messages go through RLS.
 */
export type RepSmsTargetSource = "ledger" | "obligation" | "message";
export type RepSmsTargetRequest = { sourceKind: RepSmsTargetSource; refId: string };
/**
 * resume   a required/draft/failed_not_dispatched obligation: the existing obligation resume (its own id is the key)
 * replace  a definitive failure: prefill THAT body and send as a NEW submission (never the failed key)
 * check    unverified (unknown, stale in-flight, provider_unknown): reconcile/refresh that id, never a fresh send
 * review   blocked: show that item's block reason
 * resolved the record is no longer failing; unavailable: not found / not this lead's
 */
export type RepSmsTargetDisposition = "resume" | "replace" | "check" | "review" | "resolved" | "unavailable";
export type RepSmsTargetInfo = RepSmsTargetRequest & {
  disposition: RepSmsTargetDisposition;
  state: string | null;
  body: string | null;
  composition: Record<string, unknown> | null;
  assignmentId: string | null;
  from: string | null;
  to: string | null;
  /** Ledger only: the original submission key (the replacement must NOT reuse it). */
  submissionKey: string | null;
  reason: string | null;
};

export type RepSmsContext = {
  orgId: string;
  actorId: string;
  contactId: string | null;
  senders: RepSmsSender[];
  phone: string | null;
  provider?: string | null;
  compositionPolicyVersion?: number | null;
  /** Pending durable work must be resumed by id through the fenced RPC path. */
  obligation?: RepSmsPendingObligation | null;
  /** Generic send recovery is separate from no-answer obligations. */
  submission?: RepSmsPendingSubmission | null;
  /** Present only when the caller asked for a specific failed/unverified record (see RepSmsTargetRequest). */
  target?: RepSmsTargetInfo | null;
};

type RawRepSmsContext = Omit<RepSmsContext, "senders"> & {
  senders?: Array<RepSmsSender & {
    phone_e164?: string;
    is_default?: boolean;
    provider_account_id?: string | null;
    provider_sender_id?: string | null;
    grant_status?: string | null;
    granted_at?: string | null;
    revoked_at?: string | null;
    composition_policy_version?: number | null;
  }>;
  provider?: string | null;
  provider_id?: string | null;
  composition_policy_version?: number | null;
  compositionPolicyVersion?: number | null;
  obligation?: Partial<RepSmsPendingObligation> | null;
  submission?: unknown;
};

function normalizeContext(raw: unknown): RepSmsContext {
  if (!raw || typeof raw !== "object") {
    throw new Error("Texting access could not be verified. Please retry.");
  }
  const value = raw as RawRepSmsContext;
  if (!value.orgId || !value.actorId || !Array.isArray(value.senders)) {
    throw new Error("Texting access could not be verified. Please retry.");
  }
  const contextProvider = value.provider ?? value.provider_id ?? null;
  const policyVersion = value.compositionPolicyVersion ?? value.composition_policy_version ?? null;
  const rawObligation = value.obligation;
  const obligation = rawObligation && typeof rawObligation.id === "string" && typeof rawObligation.attemptId === "string" && typeof rawObligation.status === "string"
    ? {
        id: rawObligation.id,
        attemptId: rawObligation.attemptId,
        status: rawObligation.status,
        messageBody: typeof rawObligation.messageBody === "string" ? rawObligation.messageBody : null,
        composition: rawObligation.composition && typeof rawObligation.composition === "object" && !Array.isArray(rawObligation.composition)
          ? rawObligation.composition as Record<string, unknown>
          : null,
        blockedReason: typeof rawObligation.blockedReason === "string" ? rawObligation.blockedReason : null,
        senderAssignmentId: typeof rawObligation.senderAssignmentId === "string" ? rawObligation.senderAssignmentId : null,
        fromNumber: typeof rawObligation.fromNumber === "string" ? rawObligation.fromNumber : null,
        toNumber: typeof rawObligation.toNumber === "string" ? rawObligation.toNumber : null,
      }
    : null;
  const rawSubmission = value.submission;
  const submissionValue = rawSubmission && typeof rawSubmission === "object" && !Array.isArray(rawSubmission)
    ? rawSubmission as Record<string, unknown>
    : null;
  const submissionComposition = submissionValue?.composition && typeof submissionValue.composition === "object" && !Array.isArray(submissionValue.composition)
    ? submissionValue.composition as Record<string, unknown>
    : null;
  const submission = submissionValue
    && typeof submissionValue.key === "string"
    && typeof submissionValue.receiptId === "string"
    && typeof submissionValue.state === "string"
    && typeof submissionValue.assignmentId === "string"
    && typeof submissionValue.from === "string"
    && typeof submissionValue.to === "string"
    && typeof submissionValue.body === "string"
    ? {
        key: submissionValue.key,
        receiptId: submissionValue.receiptId,
        state: submissionValue.state,
        assignmentId: submissionValue.assignmentId,
        from: submissionValue.from,
        to: submissionValue.to,
        body: submissionValue.body,
        composition: submissionComposition,
        providerMessageId: typeof submissionValue.providerMessageId === "string" ? submissionValue.providerMessageId : null,
        providerError: typeof submissionValue.providerError === "string" ? submissionValue.providerError : null,
        createdAt: typeof submissionValue.createdAt === "string" ? submissionValue.createdAt : null,
        updatedAt: typeof submissionValue.updatedAt === "string" ? submissionValue.updatedAt : null,
      }
    : null;
  return {
    orgId: value.orgId,
    actorId: value.actorId,
    contactId: value.contactId ?? null,
    provider: contextProvider,
    compositionPolicyVersion: policyVersion,
    obligation,
    submission,
    senders: value.senders.map((sender) => ({
      id: sender.id,
      number: sender.number ?? sender.phone_e164 ?? "",
      label: sender.label,
      isDefault: sender.isDefault ?? sender.is_default ?? false,
      provider: sender.provider ?? contextProvider,
      providerAccountId: sender.providerAccountId ?? sender.provider_account_id ?? null,
      providerSenderId: sender.providerSenderId ?? sender.provider_sender_id ?? null,
      grantStatus: sender.grantStatus ?? sender.grant_status ?? null,
      grantedAt: sender.grantedAt ?? sender.granted_at ?? null,
      revokedAt: sender.revokedAt ?? sender.revoked_at ?? null,
      compositionPolicyVersion: sender.compositionPolicyVersion ?? policyVersion,
    })),
    phone: null,
  };
}

export async function readRepSmsContext(propertyId: string, target?: RepSmsTargetRequest | null): Promise<RepSmsContext> {
  const client = await createClient();
  const { data, error } = await client.rpc("fn_get_rep_sms_context", {
    p_property_id: propertyId,
  });
  if (error || !data) {
    throw new Error(
      error?.code === "42501"
        ? error.message
        : "Texting access could not be verified. Please retry.",
    );
  }
  const context = normalizeContext(data);
  // The authenticated RPC scopes the row to the lead's organization, but
  // Sendillo's bearer key is shared at the application level.  Fence the
  // returned context before loading its draft, contact, or sender data so an
  // old grant from another tenant can never reach an app-scoped catalog or
  // dispatch path.
  assertSendilloOrganizationScope(context.orgId, context.provider);
  const { data: submissionData, error: submissionError } = await client.rpc("fn_get_rep_sms_delivery_draft", {
    p_property_id: propertyId,
  });
  if (submissionError) {
    throw new Error("Texting recovery could not be loaded. Please retry.");
  }
  const rawSubmissionEnvelope = submissionData && typeof submissionData === "object" && !Array.isArray(submissionData)
    ? submissionData as Record<string, unknown>
    : null;
  const recoveredContext = rawSubmissionEnvelope && Object.prototype.hasOwnProperty.call(rawSubmissionEnvelope, "draft")
    ? normalizeContext({ ...context, submission: rawSubmissionEnvelope.draft })
    : context;
  const { data: contact, error: contactError } = recoveredContext.contactId
    ? await client
        .from("contacts")
        .select(
          "phone_1,phone_1_type,phone_2,phone_2_type,phone_3,phone_3_type",
        )
        .eq("id", recoveredContext.contactId)
        .maybeSingle()
    : { data: null, error: null };
  if (contactError) {
    throw new Error("Could not load the lead phone number. Please retry.");
  }
  const base = {
    ...recoveredContext,
    phone: selectBestSmsPhone(contact)?.phone ?? null,
  };
  if (!target) return base;
  const info = await readRepSmsTarget(client, propertyId, base, target);
  // A resumable obligation target replaces the lead's "current" obligation so the existing resume path acts on the
  // chosen row, not whichever obligation the context read happened to return.
  return {
    ...base,
    ...(info.target.disposition === "resume" && info.obligation ? { obligation: info.obligation } : {}),
    target: info.target,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEDGER_CHECK_STATES = new Set(["reserved", "sending", "unknown"]);
const OBLIGATION_RESUME_STATES = new Set(["required", "draft", "failed_not_dispatched"]);
const OBLIGATION_CHECK_STATES = new Set(["unknown", "claimed", "sending"]);

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Pure: how a ledger receipt state is handled. Exported for tests. */
export function ledgerTargetDisposition(state: string): RepSmsTargetDisposition {
  if (state === "failed_not_dispatched" || state === "delivery_failed") return "replace";
  if (state === "blocked") return "review";
  if (LEDGER_CHECK_STATES.has(state)) return "check";
  return "resolved";
}
export function obligationTargetDisposition(state: string): RepSmsTargetDisposition {
  if (OBLIGATION_RESUME_STATES.has(state)) return "resume";
  if (state === "delivery_failed") return "replace";
  if (state === "blocked") return "review";
  if (OBLIGATION_CHECK_STATES.has(state)) return "check";
  return "resolved";
}
export function messageTargetDisposition(status: string, providerOutcome: unknown): RepSmsTargetDisposition {
  if (status === "failed") return providerOutcome === "provider_unknown" ? "check" : "replace";
  if (status === "pending" || status === "queued") return "check";
  return "resolved";
}

type TargetRead = { target: RepSmsTargetInfo; obligation?: RepSmsPendingObligation };

/**
 * Read-only: load the ONE record the caller chose, scoped to this lead and org. The context read above already proved
 * the caller may text this lead; this adds the lead/org filter on the chosen id (a foreign id comes back unavailable).
 */
async function readRepSmsTarget(
  client: Awaited<ReturnType<typeof createClient>>,
  propertyId: string,
  context: RepSmsContext,
  request: RepSmsTargetRequest,
): Promise<TargetRead> {
  const unavailable = (reason: string): TargetRead => ({
    target: { ...request, disposition: "unavailable", state: null, body: null, composition: null, assignmentId: null, from: null, to: null, submissionKey: null, reason },
  });
  if (!UUID_RE.test(request.refId)) return unavailable("That text could not be found.");
  const loose = client as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
    from: (table: string) => {
      select: (columns: string) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => {
            eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> };
          };
        };
      };
    };
  };

  if (request.sourceKind === "obligation") {
    const { data, error } = await loose
      .from("rep_sms_obligations")
      .select("id,attempt_id,state,message_body,composition,blocked_reason,sender_assignment_id,from_number,to_number,provider_error,last_error")
      .eq("id", request.refId)
      .eq("property_id", propertyId)
      .eq("org_id", context.orgId)
      .maybeSingle();
    if (error) throw new Error("Texting recovery could not be loaded. Please retry.");
    const row = jsonObject(data);
    if (!row) return unavailable("That follow-up could not be found.");
    const state = String(row.state ?? "");
    const disposition = obligationTargetDisposition(state);
    const composition = jsonObject(row.composition);
    const blockedReason = str(row.blocked_reason);
    const obligation: RepSmsPendingObligation = {
      id: request.refId,
      attemptId: String(row.attempt_id ?? ""),
      status: state,
      messageBody: str(row.message_body),
      composition,
      blockedReason,
      senderAssignmentId: str(row.sender_assignment_id),
      fromNumber: str(row.from_number),
      toNumber: str(row.to_number),
    };
    return {
      obligation,
      target: {
        ...request,
        disposition,
        state,
        body: str(row.message_body),
        composition,
        assignmentId: obligation.senderAssignmentId,
        from: obligation.fromNumber,
        to: obligation.toNumber,
        submissionKey: null,
        reason: blockedReason ?? str(row.provider_error) ?? str(row.last_error),
      },
    };
  }

  if (request.sourceKind === "ledger") {
    const { data, error } = await loose.rpc("fn_get_rep_sms_delivery_target", { p_property_id: propertyId, p_ledger_id: request.refId });
    if (error) throw new Error("Texting recovery could not be loaded. Please retry.");
    const row = jsonObject(jsonObject(data)?.target);
    if (row) {
      const state = String(row.state ?? "");
      return {
        target: {
          ...request,
          disposition: ledgerTargetDisposition(state),
          state,
          body: str(row.body),
          composition: jsonObject(row.composition),
          assignmentId: str(row.assignmentId),
          from: str(row.from),
          to: str(row.to),
          submissionKey: str(row.key),
          reason: str(row.providerError) ?? str(row.lastPreDispatchFailure),
        },
      };
    }
    // text_status_unknown can come from a ledger receipt OR a bare message (the classifier does not say which). Ids are
    // uuids, so a miss in the ledger falls through to the messages table with the same id; never a guess by kind.
  }

  const orScope = context.contactId
    ? `property_id.eq.${propertyId},and(property_id.is.null,contact_id.eq.${context.contactId})`
    : `property_id.eq.${propertyId}`;
  const messages = client as unknown as {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => {
            eq: (c: string, v: string) => {
              or: (filter: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> };
            };
          };
        };
      };
    };
  };
  const { data, error } = await messages
    .from("messages")
    .select("id,body,status,metadata")
    .eq("id", request.refId)
    .eq("org_id", context.orgId)
    .eq("channel", "sms")
    .or(orScope)
    .maybeSingle();
  if (error) throw new Error("Texting recovery could not be loaded. Please retry.");
  const row = jsonObject(data);
  if (!row) return unavailable("That text could not be found.");
  const metadata = jsonObject(row.metadata);
  const repSms = jsonObject(metadata?.repSms);
  const status = String(row.status ?? "");
  const composition = repSms
    ? {
        acquisitionsManager: repSms.acquisitionsManager,
        introId: repSms.introId,
        introVersion: repSms.introVersion,
        templateId: repSms.templateId,
        templateVersion: repSms.templateVersion,
        initialRemainder: repSms.initialRemainder,
        remainder: repSms.finalRemainder,
        initialBody: repSms.initialBody,
      }
    : null;
  return {
    target: {
      sourceKind: "message",
      refId: request.refId,
      disposition: messageTargetDisposition(status, metadata?.providerOutcome),
      state: status,
      body: str(repSms?.finalBody) ?? str(row.body),
      composition: composition && typeof composition.remainder === "string" ? composition : null,
      assignmentId: str(repSms?.senderAssignmentId),
      from: str(repSms?.from),
      to: null,
      submissionKey: null,
      reason: str(metadata?.providerError) ?? str(metadata?.error),
    },
  };
}

export function providerForRepSms(): MessagingProvider {
  const configured = process.env.MESSAGING_PROVIDER?.trim().toLowerCase();
  if (configured === REP_SMS_PROVIDER_ID || (!configured && process.env.SENDILLO_API_KEY)) {
    // An explicit grant supplies `from`; SENDILLO_FROM_NUMBER is not required
    // for this one-shot path and must never become an implicit fallback.
    return sendilloFromEnvWithOptions({ requireDefaultFrom: false });
  }

  // The mock provider is useful for deterministic integration tests. It still
  // goes through the same explicit grant and composition guards.
  if (configured === "mock") {
    const provider = getMessagingProvider();
    if (provider) return provider;
  }
  if (!configured) {
    throw new ConfigurationError(
      "Rep texting requires the Sendillo provider to be configured.",
    );
  }
  throw new ConfigurationError(
    "Rep texting is available only through the configured Sendillo provider.",
  );
}

function senderProvider(sender: RepSmsSender, context: RepSmsContext): string | null {
  return sender.provider ?? context.provider ?? null;
}

function assertSenderGrant(
  sender: RepSmsSender | undefined,
  context: RepSmsContext,
  provider: MessagingProvider,
): asserts sender is RepSmsSender {
  if (!sender || !sender.id || !sender.number) {
    throw new Error("Choose a texting number assigned to you.");
  }
  const grantProvider = senderProvider(sender, context)?.trim().toLowerCase() ?? null;
  if (!grantProvider || grantProvider !== provider.providerId) {
    throw new Error(
      "This texting assignment belongs to a different provider. Refresh and choose an active Sendillo number.",
    );
  }
  if (provider.providerId === REP_SMS_PROVIDER_ID) {
    if (!sender.providerAccountId?.trim()) {
      throw new Error(
        "This texting assignment has no audited Sendillo account identity. Ask an owner to refresh the assignment.",
      );
    }
    if (!sender.providerSenderId?.trim()) {
      throw new Error(
        "This texting assignment has no audited Sendillo sender identity. Ask an owner to refresh the assignment.",
      );
    }
    if (sender.grantStatus && sender.grantStatus.trim().toLowerCase() !== "active") {
      throw new Error("This Sendillo texting grant is no longer active. Refresh before sending.");
    }
    if (sender.revokedAt) {
      throw new Error("This Sendillo texting grant was revoked. Refresh before sending.");
    }
  }
  const policyVersion = sender.compositionPolicyVersion ?? context.compositionPolicyVersion;
  if (provider.providerId === REP_SMS_PROVIDER_ID && policyVersion == null) {
    throw new Error(
      "This texting assignment has no current message policy. Ask an owner to refresh the assignment.",
    );
  }
  if (
    policyVersion != null &&
    Number(policyVersion) !== REP_SMS_COMPOSITION_POLICY_VERSION
  ) {
    throw new Error(
      "This texting assignment uses an outdated message policy. Ask an owner to refresh the assignment.",
    );
  }
  if (sender.compositionPolicyVersion != null &&
      Number(sender.compositionPolicyVersion) !== REP_SMS_COMPOSITION_POLICY_VERSION) {
    throw new Error(
      "This texting assignment uses an outdated message policy. Ask an owner to refresh the assignment.",
    );
  }
}

// Sendillo's catalog is the source of truth for live sender readiness. Keep
// this vocabulary deliberately small: an absent, pending, unknown, or newly
// invented status is not affirmative evidence that SMS can be sent.
const SENDILLO_NUMBER_ACTIVE_STATUSES = new Set(["active"]);
const SENDILLO_MESSAGING_ACTIVE_STATUSES = new Set(["active"]);

function eligibleStatus(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function eligibleSendilloNumber(entry: ProviderSenderNumber): boolean {
  return Boolean(
    entry.providerAccountId?.trim()
      && entry.providerNumberId?.trim()
      && SENDILLO_NUMBER_ACTIVE_STATUSES.has(entry.status?.trim().toLowerCase() ?? "")
      && SENDILLO_MESSAGING_ACTIVE_STATUSES.has(entry.messagingStatus?.trim().toLowerCase() ?? ""),
  );
}

function samePhone(left: string | null | undefined, right: string): boolean {
  const normalized = left ? normalizePhone(left) ?? left.trim() : "";
  return normalized === right;
}

async function assertLiveSenderEligibility(
  provider: MessagingProvider,
  orgId: string,
  senderNumber: string,
  sender?: RepSmsSender,
): Promise<void> {
  // This must happen before the provider catalog request.  The catalog is
  // fetched with the application-wide Sendillo key and is therefore not a
  // tenant-neutral lookup.
  assertSendilloOrganizationScope(orgId, provider.providerId);
  const normalizedSender = normalizePhone(senderNumber) ?? senderNumber.trim();
  if (typeof provider.listPurchasedNumbers === "function") {
    const purchased = await provider.listPurchasedNumbers();
    const match = purchased.find((entry) => samePhone(entry.phoneE164, normalizedSender));
    if (
      !match ||
      (provider.providerId === REP_SMS_PROVIDER_ID && !eligibleSendilloNumber(match))
    ) {
      throw new Error(
        `The assigned Sendillo number ${senderNumber} is not currently eligible for SMS. Ask an owner to update the assignment.`,
      );
    }
    if (
      provider.providerId === REP_SMS_PROVIDER_ID &&
      (!sender?.providerAccountId ||
        !match.providerAccountId ||
        match.providerAccountId !== sender.providerAccountId ||
        !sender.providerSenderId ||
        match.providerNumberId !== sender.providerSenderId)
    ) {
      throw new Error(
        `The assigned Sendillo sender identity changed. Ask an owner to refresh the assignment.`,
      );
    }
    return;
  }
  if (typeof provider.listFromNumbers !== "function") {
    throw new Error("The configured SMS provider cannot verify sender eligibility.");
  }
  const numbers = await provider.listFromNumbers();
  const match = numbers.find((entry) => samePhone(entry.number, normalizedSender));
  if (!match || !eligibleStatus(match.status) || match.ownerType === "unknown" || match.ownerType === "available") {
    throw new Error(
      `The assigned ${provider.providerId} number ${senderNumber} is not currently eligible for SMS. Ask an owner to update the assignment.`,
    );
  }
}

function compositionFromInput(input: DispatchRepSmsInput): RepSmsComposition {
  const supplied = input.composition ?? {
    introId: input.introId,
    introVersion: input.introVersion,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    initialRemainder: input.initialRemainder,
    remainder: input.remainder,
    body: input.body,
    initialBody: input.initialBody,
  };
  return composeRepSms(supplied);
}

/**
 * The claim token fences the durable row, while this binding fences the
 * request assembled around it. Keeping the request identity in the fence
 * catches an internal caller accidentally pairing a valid claim with another
 * lead, sender, recipient, or edited payload before it reaches the provider.
 */
export function repSmsCompositionFingerprint(composition: RepSmsComposition): string {
  return JSON.stringify({
    policyVersion: composition.policyVersion,
    introId: composition.introId,
    ...(composition.acquisitionsManager === REP_SMS_ASSISTANT ? {} : { acquisitionsManager: composition.acquisitionsManager }),
    introVersion: composition.introVersion,
    templateId: composition.templateId,
    templateVersion: composition.templateVersion,
    templateOrigin: composition.templateOrigin,
    initialRemainder: composition.initialRemainder,
    remainder: composition.remainder,
    initialBody: composition.initialBody,
    finalBody: composition.finalBody,
  });
}

export function createRepSmsObligationFence(input: {
  obligationId: string;
  claimToken: string;
  claimGeneration: number;
  actorId: string;
  propertyId: string;
  assignmentId: string;
  toNumber: string;
  composition: RepSmsComposition;
}): RepSmsObligationFence {
  return {
    obligationId: input.obligationId,
    claimToken: input.claimToken,
    claimGeneration: input.claimGeneration,
    actorId: input.actorId,
    propertyId: input.propertyId,
    assignmentId: input.assignmentId,
    toNumber: normalizePhone(input.toNumber) ?? input.toNumber.trim(),
    compositionFingerprint: repSmsCompositionFingerprint(input.composition),
  };
}

function ledgerRecord(value: unknown): RepSmsDeliveryLedgerRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RepSmsDeliveryLedgerRecord
    : null;
}

function ledgerString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function replayRepSmsLedger(record: RepSmsDeliveryLedgerRecord): SendSmsOutcome | null {
  const state = ledgerString(record.state);
  const receiptId = ledgerString(record.receiptId);
  if (!state || !receiptId) return null;
  const messageId = ledgerString(record.messageId) ?? receiptId;
  const providerMessageId = ledgerString(record.providerMessageId);
  const error = ledgerString(record.providerError) ?? `The previous SMS request is ${state.replaceAll("_", " ")}.`;
  if (state === "accepted" || state === "delivered") {
    return providerMessageId
      ? { status: "sent", messageId, externalId: providerMessageId }
      : { status: "provider_unknown", messageId, error: "The previous SMS was accepted without a provider receipt." };
  }
  if (state === "delivery_failed") {
    return { status: "provider_failed", messageId, error };
  }
  if (state === "unknown" || state === "sending" || state === "reserved") {
    return { status: "provider_unknown", messageId, error };
  }
  if (state === "blocked") {
    return { status: "db_error", messageId, error };
  }
  return null;
}

async function claimRepSmsDeliveryLedger(input: {
  context: RepSmsContext;
  provider: MessagingProvider;
  sender: RepSmsSender;
  propertyId: string;
  toNumber: string;
  body: string;
  composition: RepSmsComposition;
  submissionKey: string;
}): Promise<{ authority: RepSmsDeliveryReceiptAuthority } | { outcome: SendSmsOutcome; receiptId?: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.submissionKey)) {
    throw new Error("A stable SMS submission key is required. Refresh the composer before sending.");
  }
  const admin = createAdminClient() as unknown as {
    rpc(name: string, args: Record<string, unknown>): Promise<RepSmsDeliveryLedgerRpc>;
  };
  const persistedComposition: Record<string, unknown> = { ...input.composition };
  // Match the exact JSON shape of pre-manager drafts during reconciliation.
  if (input.composition.acquisitionsManager === REP_SMS_ASSISTANT) delete persistedComposition.acquisitionsManager;
  const result = await admin.rpc("fn_claim_rep_sms_delivery_with_composition", {
    p_org_id: input.context.orgId,
    p_actor_id: input.context.actorId,
    p_submission_key: input.submissionKey,
    p_property_id: input.propertyId,
    p_contact_id: input.context.contactId,
    p_sender_assignment_id: input.sender.id,
    p_provider: input.provider.providerId,
    p_provider_account_id: input.sender.providerAccountId,
    p_provider_sender_id: input.sender.providerSenderId,
    p_from_number: normalizePhone(input.sender.number) ?? input.sender.number.trim(),
    p_to_number: input.toNumber,
    p_body: input.body,
    p_composition: persistedComposition,
  });
  if (result.error) throw new Error(result.error.message ?? "SMS reservation could not be confirmed.");
  const record = ledgerRecord(result.data);
  if (!record) throw new Error("SMS reservation returned an invalid response. Refresh before sending.");
  if (record.ok !== true) {
    const replay = replayRepSmsLedger(record);
    if (replay) return { outcome: replay, receiptId: ledgerString(record.receiptId) ?? undefined };
    throw new Error(ledgerString(record.reason) ?? "The previous SMS request is already in progress. Refresh before sending.");
  }
  const receiptId = ledgerString(record.receiptId);
  const claimToken = ledgerString(record.claimToken);
  const claimGeneration = typeof record.claimGeneration === "number" ? record.claimGeneration : null;
  if (!receiptId || !claimToken || claimGeneration == null || !Number.isInteger(claimGeneration) || claimGeneration < 1) {
    throw new Error("SMS reservation returned an invalid dispatch fence. Refresh before sending.");
  }
  return {
    authority: {
      receiptId,
      claimToken,
      claimGeneration,
      orgId: input.context.orgId,
    },
  };
}

async function recordRepSmsLedgerResult(
  authority: RepSmsDeliveryReceiptAuthority,
  state: "failed_not_dispatched" | "unknown",
  providerError: string,
): Promise<boolean> {
  try {
    const admin = createAdminClient() as unknown as {
      rpc(name: string, args: Record<string, unknown>): Promise<RepSmsDeliveryLedgerRpc>;
    };
    const result = await admin.rpc("fn_record_rep_sms_delivery_result", {
      p_receipt_id: authority.receiptId,
      p_claim_token: authority.claimToken,
      p_claim_generation: authority.claimGeneration,
      p_state: state,
      p_provider_error: providerError,
    });
    return !result.error && ledgerRecord(result.data)?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Reply-to stamp for a human rep text. The persisted stamp (on the obligation or
 * ledger row) wins and is read through a read-only function; otherwise the
 * browser's validated id is bound once (first writer wins). When the
 * authoritative value cannot be established the text still sends, but carries
 * `inbound_stamp_unresolved` instead of an id: a plain unstamped text would be
 * credited by time ordering with replies that arrived while it was being
 * written, the marker makes it handle none.
 */
type RepSmsInboundStamp = { stamp: string | null; unresolved: boolean };

async function resolveRepSmsInboundStamp(args: {
  orgId: string;
  propertyId: string;
  supplied: string | null | undefined;
  target: { kind: "obligation" | "draft"; id: string } | null;
}): Promise<RepSmsInboundStamp> {
  const scope = { orgId: args.orgId, propertyId: args.propertyId };
  const captured = Boolean(args.supplied);
  if (!captured && !args.target) return { stamp: null, unresolved: false };
  const admin = createAdminClient();
  const supplied = captured ? await resolveInboundStamp(admin, args.supplied, scope) : null;
  // A capture that does not validate (or could not be checked) is unresolved.
  if (!args.target) return { stamp: supplied, unresolved: captured && !supplied };
  const rpc = admin as unknown as {
    rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
  };
  const call = async (name: string, rpcArgs: Record<string, unknown>) => {
    // One retry for a transient failure.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await rpc.rpc(name, rpcArgs);
        if (!result.error) return { ok: true as const, data: result.data };
        console.warn(`[inbound-stamp] ${name} failed for ${args.target?.kind} ${args.target?.id}: ${result.error.message ?? "unknown"}`);
      } catch (error) {
        console.warn(`[inbound-stamp] ${name} threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ok: false as const };
  };
  const key = { p_kind: args.target.kind, p_id: args.target.id, p_org_id: args.orgId };
  // 1. The persisted stamp wins. A stored value that no longer validates is
  //    dropped and never replaced by a newer browser capture.
  const stored = await call("fn_get_rep_sms_inbound_stamp", key);
  if (stored.ok && typeof stored.data === "string") {
    const valid = await resolveInboundStamp(admin, stored.data, scope);
    return { stamp: valid, unresolved: !valid };
  }
  // 2. Nothing readable is stored. With nothing captured there is nothing to
  //    bind; an unreadable store with no capture is unresolved.
  if (!supplied) return { stamp: null, unresolved: captured || !stored.ok };
  // 3. Bind the browser's validated id (a concurrent bind is returned instead).
  const bound = await call("fn_bind_rep_sms_inbound_stamp", { ...key, p_inbound_message_id: supplied });
  if (!bound.ok) return { stamp: null, unresolved: true };
  if (typeof bound.data !== "string") return { stamp: null, unresolved: true };
  const valid = await resolveInboundStamp(admin, bound.data, scope);
  return { stamp: valid, unresolved: !valid };
}

export type DispatchRepSmsInput = {
  propertyId: string;
  assignmentId: string;
  /** Stable browser submission key for a free-form/manual send. */
  idempotencyKey?: string | null;
  /** Compatibility input. New callers should use `composition`. */
  body?: string | null;
  to?: string | null;
  composition?: RepSmsCompositionInput;
  introId?: string | null;
  introVersion?: number | string | null;
  templateId?: string | null;
  templateVersion?: number | string | null;
  initialRemainder?: string | null;
  remainder?: string | null;
  initialBody?: string | null;
  /**
   * Newest inbound message the composer showed when it opened. Validated
   * server-side and stamped as `metadata.inbound_message_id`; dropped if it
   * does not belong to this org and property.
   */
  inboundMessageId?: string | null;
  /** Present only when resuming a claimed durable obligation. */
  obligationFence?: RepSmsObligationFence;
  /**
   * Server-set only (never copied from browser input): this send replaces a verified definitive failure, so a lead
   * obligation that is itself terminal-failed (delivery_failed/blocked) does not block it.
   */
  replacingFailedSend?: boolean;
};

/**
 * Send exactly one human-reviewed rep message. All lead, sender and provider
 * decisions are server-owned; `sendSmsToContact` remains the single outbound
 * persistence/suppression/provider pipeline.
 */
export async function dispatchRepSms(input: DispatchRepSmsInput): Promise<SendSmsOutcome> {
  // A resume names its obligation; read that row so a lead with several saved follow-ups acts on the chosen one.
  const context = await readRepSmsContext(
    input.propertyId,
    input.obligationFence ? { sourceKind: "obligation", refId: input.obligationFence.obligationId } : null,
  );
  const manager = input.composition?.acquisitionsManager;
  const replayingSavedSubmission = Boolean(context.submission && context.submission.key === input.idempotencyKey);
  if (!input.obligationFence && !replayingSavedSubmission && (typeof manager !== "string" || !manager.trim())) {
    throw new Error("Enter the acquisitions manager before sending.");
  }
  const composition = compositionFromInput(input);
  // Only a definitively undelivered follow-up may be replaced by a new send; a blocked one stays blocked (Review only).
  const terminalFailedObligation = Boolean(
    input.replacingFailedSend && context.obligation && context.obligation.status === "delivery_failed",
  );
  if (context.obligation && !input.obligationFence && !terminalFailedObligation) {
    throw new Error(
      "This lead has a saved SMS follow-up. Resume the exact saved follow-up before sending another message.",
    );
  }
  if (
    context.obligation &&
    input.obligationFence &&
    input.obligationFence.obligationId !== context.obligation.id
  ) {
    throw new Error(
      "The saved SMS follow-up changed. Refresh and resume the current follow-up before sending.",
    );
  }
  // A generic rep text has no durable obligation row to fence a retry. Require
  // the same tenant-scoped key that sendSmsToContact persists before crossing
  // the provider boundary; obligation resumes use the obligation id below.
  if (!input.obligationFence && !input.idempotencyKey?.trim()) {
    throw new Error("A stable SMS submission key is required. Refresh the composer before sending.");
  }
  const provider = providerForRepSms();
  assertSendilloOrganizationScope(context.orgId, provider.providerId);
  const sender = context.senders.find((candidate) => candidate.id === input.assignmentId);
  assertSenderGrant(sender, context, provider);
  if (!context.contactId) throw new Error("Lead has no homeowner contact linked.");
  const contactId = context.contactId;

  const senderNumber = normalizePhone(sender.number) ?? sender.number.trim();
  const to = input.to?.trim() || undefined;
  const fence = input.obligationFence;
  let deliveryAuthority: RepSmsDeliveryReceiptAuthority | null = null;
  if (!fence) {
    const toNumber = normalizePhone(to ?? context.phone ?? "");
    if (toNumber) {
      const claim = await claimRepSmsDeliveryLedger({
        context,
        provider,
        sender,
        propertyId: input.propertyId,
        toNumber,
        body: composition.finalBody,
        composition,
        submissionKey: input.idempotencyKey?.trim() ?? "",
      });
      if ("outcome" in claim) {
        return claim.outcome;
      }
      deliveryAuthority = claim.authority;
    }
  }
  const inboundStamp = await resolveRepSmsInboundStamp({
    orgId: context.orgId,
    propertyId: input.propertyId,
    supplied: input.inboundMessageId,
    // The durable record that survives a reload owns the stamp: the obligation
    // for a resume, the delivery-ledger row for a generic send/recovered draft.
    target: fence
      ? { kind: "obligation", id: fence.obligationId }
      : deliveryAuthority
        ? { kind: "draft", id: deliveryAuthority.receiptId }
        : null,
  });
  const metadata = {
    ...(inboundStamp.stamp ? { inbound_message_id: inboundStamp.stamp } : {}),
    ...(inboundStamp.unresolved ? { inbound_stamp_unresolved: true } : {}),
    repSms: {
      workflow: composition.acquisitionsManager === REP_SMS_ASSISTANT ? "maria-through-mel" : "manager-through-mel",
      policyVersion: composition.policyVersion,
      persona: REP_SMS_PERSONA,
      assistant: composition.acquisitionsManager,
      acquisitionsManager: composition.acquisitionsManager,
      actorUserId: context.actorId,
      senderAssignmentId: sender.id,
      provider: provider.providerId,
      providerAccountId: sender.providerAccountId ?? null,
      providerSenderId: sender.providerSenderId ?? null,
      grantStatus: sender.grantStatus ?? null,
      // Persist the fenced obligation before the provider request. A Sendillo
      // delivery callback can arrive before the accepted-result write binds
      // its external id on rep_sms_obligations; status-events uses this exact
      // id plus the stored org/provider/account identity to close that race.
      obligationId: fence?.obligationId ?? null,
      receiptId: deliveryAuthority?.receiptId ?? null,
      from: senderNumber,
      introId: composition.introId,
      introVersion: composition.introVersion,
      templateId: composition.templateId,
      templateVersion: composition.templateVersion,
      templateOrigin: composition.templateOrigin,
      initialBody: composition.initialBody,
      finalBody: composition.finalBody,
      initialRemainder: composition.initialRemainder,
      finalRemainder: composition.remainder,
    },
  };
  if (fence && (!fence.obligationId || !fence.claimToken || !fence.actorId
    || !Number.isInteger(fence.claimGeneration) || fence.claimGeneration < 1
    || fence.propertyId !== input.propertyId
    || fence.assignmentId !== sender.id
    || !to
    || !samePhone(fence.toNumber, normalizePhone(to) ?? to)
    || fence.compositionFingerprint !== repSmsCompositionFingerprint(composition))) {
    throw new Error("The saved follow-up fence is invalid. Refresh before sending.");
  }
  let outcome: SendSmsOutcome;
  try {
    const client = await createClient();
    outcome = await sendSmsToContact(
      client,
      {
        origin: "manual",
        takeoverActorId: context.actorId,
        propertyId: input.propertyId,
        contactId,
        body: composition.finalBody,
        from: senderNumber,
        to,
        metadata,
        // The browser-writable messages idempotency column is retained for
        // legacy traffic only. Rep SMS replay is fenced by the service-owned
        // ledger (or by the durable obligation fence), so never use the
        // messages row as its authority.
        idempotencyKey: null,
        repSmsReceipt: deliveryAuthority,
      },
      {
        provider,
        authorize: async (messageId: string) => {
        // Re-read the queue/RLS/grant context after the pending breadcrumb is
        // written. A reassignment or revoked grant must stop before provider
        // dispatch even when the browser held an old composer open.
        const fresh = await readRepSmsContext(input.propertyId);
        const freshSender = fresh.senders.find((candidate) => candidate.id === sender.id);
        assertSenderGrant(freshSender, fresh, provider);
        if (
          fresh.actorId !== context.actorId ||
          fresh.orgId !== context.orgId ||
          fresh.contactId !== context.contactId ||
          !samePhone(freshSender.number, senderNumber) ||
          senderProvider(freshSender, fresh)?.trim().toLowerCase() !== provider.providerId
        ) {
          throw new Error("The lead or texting assignment changed. Refresh before sending.");
        }
        await assertLiveSenderEligibility(provider, fresh.orgId, senderNumber, freshSender);
        await assertFreshRepSuppression({
          propertyId: input.propertyId,
          contactId,
          to,
          orgId: context.orgId,
        });
        if (fence) {
          const admin = createAdminClient() as unknown as {
            rpc(name: string, args: Record<string, unknown>): Promise<{
              data: unknown;
              error: { message?: string; code?: string } | null;
            }>;
          };
          const { data, error } = await admin.rpc("fn_assert_rep_sms_obligation_dispatch", {
            p_obligation_id: fence.obligationId,
            p_claim_token: fence.claimToken,
            p_claim_generation: fence.claimGeneration,
            p_actor_id: fence.actorId,
          });
          const asserted = data && typeof data === "object" && !Array.isArray(data)
            ? data as Record<string, unknown>
            : null;
          if (error || asserted?.ok !== true || asserted.state !== "sending") {
            throw new Error(
              error?.message ?? "The saved follow-up is no longer authorized for dispatch. Refresh before sending.",
            );
          }
        }
        if (deliveryAuthority) {
          const admin = createAdminClient() as unknown as {
            rpc(name: string, args: Record<string, unknown>): Promise<RepSmsDeliveryLedgerRpc>;
          };
          const marked = await admin.rpc("fn_mark_rep_sms_delivery_sending", {
            p_receipt_id: deliveryAuthority.receiptId,
            p_claim_token: deliveryAuthority.claimToken,
            p_claim_generation: deliveryAuthority.claimGeneration,
            p_message_id: messageId,
          });
          const markedRecord = ledgerRecord(marked.data);
          if (marked.error || markedRecord?.ok !== true || markedRecord.state !== "sending") {
            throw new Error(
              marked.error?.message ?? "The SMS reservation is no longer authorized for dispatch. Refresh before sending.",
            );
          }
        }
        },
      },
    );
  } catch (error) {
    if (!deliveryAuthority) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const recorded = await recordRepSmsLedgerResult(deliveryAuthority, "failed_not_dispatched", detail);
    if (!recorded) {
      return {
        status: "provider_unknown",
        messageId: deliveryAuthority.receiptId,
        error: `${detail}. The durable non-dispatch result could not be confirmed; review before retrying.`,
      };
    }
    return {
      status: "provider_failed",
      messageId: deliveryAuthority.receiptId,
      error: detail,
      providerAttempted: false,
    };
  }
  if (deliveryAuthority && typeof outcome.status === "string" && outcome.status.startsWith("blocked_")) {
    const detail = "reason" in outcome && typeof outcome.reason === "string"
      ? outcome.reason
      : "error" in outcome && typeof outcome.error === "string"
        ? outcome.error
        : "The SMS was blocked before provider dispatch.";
    const recorded = await recordRepSmsLedgerResult(deliveryAuthority, "failed_not_dispatched", detail);
    if (!recorded) {
      return {
        status: "provider_unknown",
        messageId: deliveryAuthority.receiptId,
        error: "The SMS was blocked locally, but its durable result could not be recorded. Review before retrying.",
      };
    }
  }
  return outcome;
}

async function assertFreshRepSuppression(args: {
  propertyId: string;
  contactId: string;
  to?: string;
  orgId: string;
}): Promise<void> {
  const client = await createClient();
  const [contactResult, propertyResult] = await Promise.all([
    client
      .from("contacts")
      .select(
        "id,phone_1,phone_1_type,phone_2,phone_2_type,phone_3,phone_3_type,do_not_contact,sms_opted_out",
      )
      .eq("id", args.contactId)
      .maybeSingle(),
    client
      .from("properties")
      .select("id,org_id,outreach_dispo")
      .eq("id", args.propertyId)
      .maybeSingle(),
  ]);
  if (contactResult.error || propertyResult.error || !contactResult.data || !propertyResult.data) {
    throw new Error("Could not confirm the lead's current texting permissions. Refresh before sending.");
  }
  if (propertyResult.data.org_id !== args.orgId) {
    throw new Error("The lead organization changed. Refresh before sending.");
  }
  const consent = await getConsentState(client, args.contactId, "sms");
  const suppression = evaluateSuppression({
    outreachDispo: propertyResult.data.outreach_dispo,
    consentState: consent,
    doNotContact: contactResult.data.do_not_contact,
    smsOptedOut: contactResult.data.sms_opted_out,
  });
  if (suppression.suppressed) throw new Error(suppression.reason);
  const destination = args.to
    ? selectSmsPhoneByNumber(contactResult.data, args.to)
    : selectBestSmsPhone(contactResult.data);
  if (!destination) throw new Error("The selected lead phone is no longer available. Refresh before sending.");
  if (await isSmsPhoneSuppressed(client, destination.phone, args.orgId)) {
    throw new Error("Phone number is suppressed from SMS.");
  }
}

export type RepSmsAssignment = {
  id: string;
  user_id: string;
  phone_e164: string;
  label: string;
  is_default: boolean;
  active: boolean;
  provider?: string;
  composition_policy_version?: number;
};

/** Exported for server actions and focused backend tests. */
export function repSmsProviderId(): typeof REP_SMS_PROVIDER_ID {
  return REP_SMS_PROVIDER_ID;
}

export function repSmsCatalogOptionIsEligible(entry: ProviderSenderNumber | DialpadFromOption): boolean {
  if ("phoneE164" in entry) {
    return eligibleSendilloNumber(entry);
  }
  return eligibleStatus(entry.status)
    && !["unknown", "available"].includes(entry.ownerType.trim().toLowerCase());
}
