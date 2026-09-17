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
import { sendSmsToContact } from "./send";
import { sendilloFromEnvWithOptions } from "./providers/sendillo";
import type { DialpadFromOption, MessagingProvider, ProviderSenderNumber } from "./types";
import {
  composeRepSms,
  REP_SMS_ASSISTANT,
  REP_SMS_COMPOSITION_POLICY_VERSION,
  REP_SMS_PERSONA,
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

export type RepSmsObligationFence = {
  obligationId: string;
  claimToken: string;
  claimGeneration: number;
  actorId: string;
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
  return {
    orgId: value.orgId,
    actorId: value.actorId,
    contactId: value.contactId ?? null,
    provider: contextProvider,
    compositionPolicyVersion: policyVersion,
    obligation,
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

export async function readRepSmsContext(propertyId: string): Promise<RepSmsContext> {
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
  const { data: contact, error: contactError } = context.contactId
    ? await client
        .from("contacts")
        .select(
          "phone_1,phone_1_type,phone_2,phone_2_type,phone_3,phone_3_type",
        )
        .eq("id", context.contactId)
        .maybeSingle()
    : { data: null, error: null };
  if (contactError) {
    throw new Error("Could not load the lead phone number. Please retry.");
  }
  return {
    ...context,
    phone: selectBestSmsPhone(contact)?.phone ?? null,
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
    entry.providerNumberId?.trim()
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
  senderNumber: string,
  sender?: RepSmsSender,
): Promise<void> {
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
      (!sender?.providerSenderId || match.providerNumberId !== sender.providerSenderId)
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

export type DispatchRepSmsInput = {
  propertyId: string;
  assignmentId: string;
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
  /** Present only when resuming a claimed durable obligation. */
  obligationFence?: RepSmsObligationFence;
};

/**
 * Send exactly one human-reviewed rep message. All lead, sender and provider
 * decisions are server-owned; `sendSmsToContact` remains the single outbound
 * persistence/suppression/provider pipeline.
 */
export async function dispatchRepSms(input: DispatchRepSmsInput) {
  const composition = compositionFromInput(input);
  const context = await readRepSmsContext(input.propertyId);
  const provider = providerForRepSms();
  const sender = context.senders.find((candidate) => candidate.id === input.assignmentId);
  assertSenderGrant(sender, context, provider);
  if (!context.contactId) throw new Error("Lead has no homeowner contact linked.");
  const contactId = context.contactId;

  const senderNumber = normalizePhone(sender.number) ?? sender.number.trim();
  const to = input.to?.trim() || undefined;
  const metadata = {
    repSms: {
      workflow: "maria-through-mel",
      policyVersion: composition.policyVersion,
      persona: REP_SMS_PERSONA,
      assistant: REP_SMS_ASSISTANT,
      actorUserId: context.actorId,
      senderAssignmentId: sender.id,
      provider: provider.providerId,
      providerAccountId: sender.providerAccountId ?? null,
      providerSenderId: sender.providerSenderId ?? null,
      grantStatus: sender.grantStatus ?? null,
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
  const client = await createClient();
  const fence = input.obligationFence;
  if (fence && (!fence.obligationId || !fence.claimToken || !fence.actorId
    || !Number.isInteger(fence.claimGeneration) || fence.claimGeneration < 1)) {
    throw new Error("The saved follow-up fence is invalid. Refresh before sending.");
  }
  return sendSmsToContact(
    client,
    {
      origin: "manual",
      propertyId: input.propertyId,
      contactId,
      body: composition.finalBody,
      from: senderNumber,
      to,
      metadata,
    },
    {
      provider,
      authorize: async () => {
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
        await assertLiveSenderEligibility(provider, senderNumber, freshSender);
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
      },
    },
  );
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
