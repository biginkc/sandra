import { assertNotTrainingTarget } from "@/lib/leads/training";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

import { normalizePhone } from "@/lib/csv/normalize";
import { ConfigurationError, ProviderError } from "@/lib/errors/classes";
import { ensureConversationIdForThread } from "@/lib/messages/threading";
import type { Database, Json } from "@/lib/supabase/types";
import { reconcileStoredStatusEvents } from "./status-events";
import { retryReceiptTransaction } from "./receipt-persistence";
import { getConsentState, type ConsentState } from "./consent";
import { checkQuietHours, type QuietHoursCheck } from "./quiet-hours";
import {
  getSenderInventoryState,
  loadCampaignDeliverySettings,
  providerSupportsSenderInventory,
  type SenderInventoryState,
} from "./delivery";
import { isSmsPhoneSuppressed } from "./opt-out-phone";
import type { MessagingProvider } from "./types";
import { getMessagingProvider } from "./registry";
import { selectBestSmsPhone, selectSmsPhoneByNumber } from "./sms-phone";
import {
  evaluateAutomatedSuppression,
  evaluateSuppression,
  type SuppressionDecision,
} from "./suppression";
import { assertSendilloOrganizationScope } from "./rep-sms-scope";
import { hasOpeningIdentity, openingIdentityError } from "./opening-identity";

/**
 * Core "send one outbound SMS" operation. Called from the lead-detail
 * composer today; the Phase-2 queue page will call the same helper.
 *
 * Pre-send checks (in order):
 *  1. Messaging provider configured.
 *  2. Contact has at least one usable saved phone.
 *  3. Latest consent state on SMS is not an explicit opt-out.
 *  4. Current time is inside [08:00, 21:00) local to the property state.
 *
 * On the send path:
 *  - Insert a `messages` row with status='pending' BEFORE calling the
 *    provider so even a crash leaves a breadcrumb.
 *  - Call provider.sendSms.
 *  - Update the same row with externalId + status='sent', or status='failed'
 *    + error_message on failure.
 *
 * Never throws — returns a discriminated outcome so callers can render
 * consistently without try/catch.
 */

type MessagesUpdate = Database["public"]["Tables"]["messages"]["Update"];

const LANDLINE_BLOCK_REASON =
  "Contact only has landline numbers — SMS can't be delivered. Call or mail instead.";
export const PROVIDER_PENDING_STALE_MS = 15 * 60_000;
const PROVIDER_TRANSIENT_DEFER_MS = 5 * 60_000;
const PROVIDER_TRANSIENT_MAX_DEFER_ATTEMPTS = 3;

type RepSmsIdempotencyRow = {
  id: string;
  org_id: string;
  property_id: string | null;
  contact_id: string | null;
  body: string;
  status: string;
  external_id: string | null;
  error_message: string | null;
  from_address: string | null;
  to_address: string | null;
  metadata: Json | null;
};

/**
 * Service-owned reservation authority for a generic rep SMS. The value is
 * created by fn_claim_rep_sms_delivery after the server validates the actor,
 * tenant, lead, sender grant, and complete message payload. It is deliberately
 * separate from the browser-writable messages row.
 */
export type RepSmsDeliveryReceiptAuthority = {
  receiptId: string;
  claimToken: string;
  claimGeneration: number;
  orgId: string;
};

type RepSmsDeliveryLedgerResult = {
  ok?: unknown;
  state?: unknown;
  providerMessageId?: unknown;
  providerError?: unknown;
};

function repSmsLedgerResult(value: unknown): RepSmsDeliveryLedgerResult | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RepSmsDeliveryLedgerResult
    : null;
}

async function recordRepSmsDeliveryLedgerResult(
  authority: RepSmsDeliveryReceiptAuthority,
  state: "accepted" | "failed_not_dispatched" | "unknown",
  input: { providerMessageId?: string | null; providerStatus?: string | null; providerError?: string | null },
): Promise<RepSmsDeliveryLedgerResult | null> {
  try {
    const admin = createAdminClient() as unknown as {
      rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
    };
    const result = await admin.rpc("fn_record_rep_sms_delivery_result", {
      p_receipt_id: authority.receiptId,
      p_claim_token: authority.claimToken,
      p_claim_generation: authority.claimGeneration,
      p_state: state,
      p_provider_message_id: input.providerMessageId ?? null,
      p_provider_status: input.providerStatus ?? null,
      p_provider_error: input.providerError ?? null,
    });
    if (result.error) return null;
    const record = repSmsLedgerResult(result.data);
    return record?.ok === true ? record : null;
  } catch {
    return null;
  }
}

/**
 * Every return before the provider boundary is proven non-dispatch. A
 * service-owned rep receipt must preserve that evidence so the same
 * submission key can receive a fresh claim generation after the operator
 * fixes the blocking condition. If the evidence write itself fails, hold the
 * receipt as unknown rather than letting the caller retry blindly.
 */
async function preserveRepSmsPreDispatchFailure(
  input: SendSmsInput,
  outcome: SendSmsOutcome,
): Promise<SendSmsOutcome> {
  if (!input.repSmsReceipt) return outcome;
  const detail = "error" in outcome && typeof outcome.error === "string"
    ? outcome.error
    : "reason" in outcome && typeof outcome.reason === "string"
      ? outcome.reason
      : `The SMS was held before provider dispatch (${outcome.status}).`;
  const recorded = await recordRepSmsDeliveryLedgerResult(input.repSmsReceipt, "failed_not_dispatched", {
    providerError: detail,
  });
  if (recorded) return outcome;
  return {
    status: "provider_unknown",
    messageId: input.repSmsReceipt.receiptId,
    error: `${detail}. The durable non-dispatch result could not be confirmed; review before retrying.`,
  };
}

function normalizeMaybePhone(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return normalizePhone(value) ?? value.trim();
}

const BMH_OPENING_IDENTITY_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

function shouldEnforceBmhOpeningIdentity(orgId: string): boolean {
  return (
    orgId === BMH_OPENING_IDENTITY_ORG_ID ||
    process.env.SENDILLO_ORG_ID?.trim() === orgId
  );
}

async function loadConversationOpeningEvidence(
  supabase: SupabaseClient<Database>,
  args: { orgId: string; customerPhone: string; businessPhone: string },
): Promise<
  | { ok: true; hasDeliveredOutbound: boolean; hasInbound: boolean }
  | { ok: false; error: string }
> {
  const customerPhone = normalizeMaybePhone(args.customerPhone) ?? args.customerPhone;
  const businessPhone = normalizeMaybePhone(args.businessPhone) ?? args.businessPhone;
  try {
    const [outbound, inbound] = await Promise.all([
      supabase
        .from("messages")
        .select("id")
        .eq("org_id", args.orgId)
        .eq("channel", "sms")
        .eq("direction", "outbound")
        .eq("to_address", customerPhone)
        .eq("from_address", businessPhone)
        .in("status", ["sent", "delivered"])
        .limit(1),
      supabase
        .from("messages")
        .select("id")
        .eq("org_id", args.orgId)
        .eq("channel", "sms")
        .eq("direction", "inbound")
        .eq("from_address", customerPhone)
        .eq("to_address", businessPhone)
        .eq("status", "received")
        .limit(1),
    ]);
    if (outbound.error || inbound.error) {
      return {
        ok: false,
        error: outbound.error?.message ?? inbound.error?.message ?? "opening history lookup failed",
      };
    }
    return {
      ok: true,
      hasDeliveredOutbound: (outbound.data?.length ?? 0) > 0,
      hasInbound: (inbound.data?.length ?? 0) > 0,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function repSmsIdempotencyConflict(
  row: RepSmsIdempotencyRow,
  input: SendSmsInput,
): string | null {
  if (row.property_id !== input.propertyId) return "lead";
  if (row.contact_id !== input.contactId) return "contact";
  if (row.body !== input.body) return "message body";
  const requestedTo = normalizeMaybePhone(input.to);
  if (requestedTo && normalizeMaybePhone(row.to_address) !== requestedTo) return "recipient";
  const requestedFrom = normalizeMaybePhone(input.from);
  if (requestedFrom && normalizeMaybePhone(row.from_address) !== requestedFrom) return "sender";
  return null;
}

function repSmsIdempotencyReplay(
  row: RepSmsIdempotencyRow,
  input: SendSmsInput,
): SendSmsOutcome {
  const conflict = repSmsIdempotencyConflict(row, input);
  if (conflict) {
    return {
      status: "db_error",
      error: `SMS idempotency key was already used for a different ${conflict}. Start a new message before sending.`,
    };
  }
  if (row.status === "sent" || row.status === "delivered") {
    if (row.external_id) {
      return { status: "sent", messageId: row.id, externalId: row.external_id };
    }
    // A terminal row without the provider receipt is still ambiguous. Keep
    // the key held so a reload cannot issue a second provider request while
    // an operator or webhook reconciles the missing external id.
    return {
      status: "provider_unknown",
      messageId: row.id,
      error: row.error_message ?? "The previous SMS was accepted without a provider receipt.",
    };
  }
  if (row.status === "queued") return { status: "queued", messageId: row.id };
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : null;
  if (row.status === "pending" || metadata?.providerOutcome === "provider_unknown") {
    return {
      status: "provider_unknown",
      messageId: row.id,
      error: row.error_message ?? "A previous SMS request is still being reconciled.",
    };
  }
  if (row.status === "failed") {
    return {
      status: "provider_failed",
      messageId: row.id,
      error: row.error_message ?? "The previous SMS request failed before completion.",
    };
  }
  return {
    status: "db_error",
    messageId: row.id,
    error: `The previous SMS request has an unsupported state (${row.status}). Review text history before retrying.`,
  };
}

async function loadRepSmsIdempotencyRow(
  supabase: SupabaseClient<Database>,
  orgId: string,
  idempotencyKey: string,
): Promise<{ row: RepSmsIdempotencyRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from("messages")
    .select("id,org_id,property_id,contact_id,body,status,external_id,error_message,from_address,to_address,metadata")
    .eq("org_id", orgId)
    .eq("channel", "sms")
    .eq("direction", "outbound")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data as RepSmsIdempotencyRow | null, error: null };
}

export type SendSmsOutcome =
  | { status: "sent"; messageId: string; externalId: string }
  | { status: "queued"; messageId: string }
  | { status: "paused"; messageId: string }
  | {
      status: "blocked_provider_off";
      reason: string;
    }
  | {
      status: "blocked_no_approved_sender";
      reason: string;
    }
  | {
      status: "blocked_no_phone";
      reason: string;
    }
  | {
      status: "blocked_landline";
      reason: string;
    }
  | {
      status: "blocked_terminal_dispo";
      reason: string;
      source: Extract<SuppressionDecision, { suppressed: true }>["source"];
      outreachDispo?: string | null;
      consentState?: ConsentState | null;
    }
  | {
      /**
       * The final-dispatch automated-only re-check fired: fresh state
       * loaded immediately before the provider call showed the property
       * moved to a HUMAN_OWNED_DISPOS (or SUPPRESSED_DISPOS) outcome
       * after the row was created/claimed. Only ever returned when the
       * send's provenance is `origin: 'automated'` — manual sends never
       * hit this path. The row is left/marked `status: 'failed'` (never
       * retried) so the queue doesn't loop on a terminal state.
       */
      status: "blocked_automated_suppressed";
      messageId: string;
      reason: string;
      source: Extract<SuppressionDecision, { suppressed: true }>["source"];
      outreachDispo?: string | null;
      consentState?: ConsentState | null;
    }
  | {
      /**
       * The final-dispatch automated-only re-check ran, but the fresh
       * property/contact reload it depends on errored (or threw). Fail
       * closed: with current suppression state unknown, the send is held
       * rather than allowed through — a read failure must never let a
       * send proceed that current state might forbid. Only ever returned
       * when `origin: 'automated'`; manual sends don't run this re-check
       * at all, so they're unaffected. The row is marked `status: 'failed'`
       * (never retried) so the queue doesn't loop on an unresolved read.
       */
      status: "blocked_fresh_state_unavailable";
      messageId: string;
      error: string;
    }
  | {
      status: "blocked_no_consent";
      reason: string;
      consentState: ConsentState;
    }
  | {
      status: "blocked_quiet_hours";
      reason: string;
      check: QuietHoursCheck;
    }
  | {
      status: "blocked_not_due";
      messageId: string;
      retryAt: string;
    }
  | {
      status: "blocked_campaign_paused";
      messageId?: string;
      reason: string;
    }
  | {
      status: "provider_failed";
      messageId: string;
      error: string;
      /** False means the manual authorization fence failed before fetch. */
      providerAttempted?: boolean;
      /** Native sequence sends retain ambiguity instead of guessing no-send. */
      deliveryOutcome?: SequenceAttemptOutcome;
    }
  | {
      /**
       * The provider boundary was reached but Sendillo did not provide
       * definitive non-delivery evidence. This is a durable hold: callers
       * must reconcile the provider receipt before offering another send.
       */
      status: "provider_unknown";
      messageId: string;
      error: string;
    }
  | {
      status: "provider_deferred";
      messageId: string;
      error: string;
      attempt: number;
      retryAt: string;
    }
  | { status: "contact_not_found" }
  | { status: "property_not_found" }
  | {
      status: "blocked_sequence_authorization";
      messageId: string;
      reason: string;
      attemptOutcome: SequenceAttemptOutcome;
    }
  | {
      status: "db_error";
      error: string;
      messageId?: string;
      externalId?: string;
      /** Set when the provider accepted before receipt persistence failed. */
      deliveryOutcome?: SequenceAttemptOutcome;
    };

/** Evidence classification for one native sequence provider attempt. */
export type SequenceAttemptOutcome =
  | "not_attempted"
  | "definitively_rejected"
  | "accepted"
  | "unknown";

export type SequenceSendContext = {
  enrollmentId: string;
  stepId: string;
  claimId: string;
};

export type SendSmsInput = {
  /**
   * Send provenance — required, no default, so every caller declares
   * itself. `'automated'` means no human is reviewing this exact message
   * body/timing before it fires: the AI responder, sequence tick, and the
   * bulk-campaign queue path. `'manual'` means a human is sending or
   * queueing this specific message right now: the lead-detail composer
   * (both immediate and "queue for later"). This drives the final-dispatch
   * re-check immediately before the provider call — see
   * `evaluateAutomatedSuppression` in ./suppression.
   */
  origin: "automated" | "manual";
  /** Contact to send to. We prefer a saved mobile across phone_1/2/3. */
  contactId: string;
  /** Linked property — required for quiet-hours zone + thread continuity. */
  propertyId: string;
  body: string;
  /**
   * Optional explicit from-number. Inventory-aware providers validate this
   * against the approved sender catalog before any provider call.
   */
  from?: string;
  /**
   * Optional override for the recipient phone. Used by Messages when the
   * visible conversation is on a saved secondary contact phone. The value
   * must match phone_1/2/3 or the send is blocked before provider use.
   */
  to?: string;
  /**
   * Queue the message for later release instead of sending immediately.
   * Inserts the `messages` row with `status='queued'` and returns a
   * `queued` outcome — no provider call, no consent check yet (that
   * happens at release time, because consent state can change between
   * queueing and sending).
   *
   * The quiet-hours check IS skipped at queue time for the same reason;
   * release re-checks against then-current time.
   */
  queueOnly?: boolean;
  scheduledFor?: Date | null;
  metadata?: Json | null;
  campaignId?: string | null;
  /**
   * Reply/automation paths must be sender-sticky: prior inbound business
   * number, then campaign Delivery snapshot. Cold sequence first-touches opt
   * into a separate provider-default fallback below; replies stay strict.
   */
  requireStickyFrom?: boolean;
  /**
   * Sequence first-touches can have no prior inbound and no campaign snapshot.
   * When true, the provider default may be used, but inventory-aware providers
   * still validate it against the approved sender catalog before any send.
   */
  allowDefaultFromWhenNoSticky?: boolean;
  /**
   * Mark a known cold opener so the transport can reject copy that omits the
   * fixed sender identity. This validates only the marked opener; it never
   * rewrites follow-ups, replies, or human-composed messages.
   */
  requiresOpeningIdentity?: boolean;
  /** Tenant-scoped replay key for a manual rep SMS submission. */
  idempotencyKey?: string | null;
  /**
   * Service-owned rep SMS reservation. When present, this ledger is the
   * replay authority and messages.idempotency_key is intentionally ignored.
   */
  repSmsReceipt?: RepSmsDeliveryReceiptAuthority | null;
  /** Native sequence fence; omitted by manual, AI, and campaign callers. */
  sequenceContext?: SequenceSendContext;
};

export async function sendSmsToContact(
  supabase: SupabaseClient<Database>,
  input: SendSmsInput,
  manualDispatch?: { provider: MessagingProvider; authorize: (messageId: string) => Promise<void> },
): Promise<SendSmsOutcome> {
  await assertNotTrainingTarget(supabase, { propertyId: input.propertyId, contactId: input.contactId });
  if (manualDispatch && (input.origin !== "manual" || input.queueOnly || input.campaignId)) {
    throw new Error("Assigned senders support immediate manual messages only.");
  }
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (input.idempotencyKey != null && !idempotencyKey) {
    return { status: "db_error", error: "SMS idempotency key cannot be blank." };
  }
  if (idempotencyKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    return { status: "db_error", error: "SMS idempotency key is invalid." };
  }

  const resolveProvider = (): MessagingProvider | SendSmsOutcome => {
    try {
      const provider = manualDispatch?.provider ?? getMessagingProvider();
      return provider ?? {
        status: "blocked_provider_off",
        reason: "Messaging is off — set MESSAGING_PROVIDER in .env.local to enable it.",
      };
    } catch (e) {
      if (e instanceof ConfigurationError) {
        return { status: "blocked_provider_off", reason: e.message };
      }
      throw e;
    }
  };

  // Resolve an existing keyed submission before provider configuration. A
  // completed send must remain replayable when a later page load is missing
  // provider configuration; replaying a durable receipt never needs a second
  // provider request.
  let preloadedProperty: {
    id: string;
    org_id: string;
    state: string;
    outreach_dispo: string | null;
  } | null = null;
  let idempotencyChecked = false;
  if (idempotencyKey && !input.repSmsReceipt) {
    const propertyLookup = await supabase
      .from("properties")
      .select("id, org_id, state, outreach_dispo")
      .eq("id", input.propertyId)
      .maybeSingle();
    if (propertyLookup.error) return { status: "db_error", error: propertyLookup.error.message };
    if (!propertyLookup.data) return { status: "property_not_found" };
    preloadedProperty = propertyLookup.data;
    try {
      // Check the tenant before replaying a service-owned keyed submission.
      // A replay must never become a cross-tenant visibility side channel
      // merely because it does not issue a second provider request.
      assertSendilloOrganizationScope(
        preloadedProperty.org_id,
        manualDispatch?.provider.providerId,
      );
    } catch (e) {
      return {
        status: "db_error",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    idempotencyChecked = true;
    const existing = await loadRepSmsIdempotencyRow(
      supabase,
      propertyLookup.data.org_id,
      idempotencyKey,
    );
    if (existing.error) return { status: "db_error", error: existing.error };
    if (existing.row) return repSmsIdempotencyReplay(existing.row, input);
  }

  // Validate a marked opener only after the keyed replay fast path has had a
  // chance to return its durable result. New opener requests still fail
  // before queue or provider writes.
  if (input.requiresOpeningIdentity) {
    const identityError = openingIdentityError(input.body);
    if (identityError) return { status: "db_error", error: identityError };
  }

  // QUEUE-ONLY shortcut — skip consent + quiet-hours checks (they'll
  // run at release time), skip the provider call, just persist a
  // `status='queued'` breadcrumb.
  if (input.queueOnly) {
    const resolved = resolveProvider();
    if (!("providerId" in resolved)) return resolved;
    return queueForLater(supabase, resolved.providerId, input);
  }

  const campaignPause = await blockIfCampaignPaused(
    supabase,
    input.campaignId,
  );
  if (campaignPause) return preserveRepSmsPreDispatchFailure(input, campaignPause);

  // 2. Look up contact + property in parallel.
  const [contactResult, propertyResult] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out")
      .eq("id", input.contactId)
      .maybeSingle(),
    preloadedProperty
      ? Promise.resolve({ data: preloadedProperty, error: null })
      : supabase
        .from("properties")
        .select("id, org_id, state, outreach_dispo")
        .eq("id", input.propertyId)
        .maybeSingle(),
  ]);

  if (contactResult.error) {
    return preserveRepSmsPreDispatchFailure(input, { status: "db_error", error: contactResult.error.message });
  }
  if (!contactResult.data) return preserveRepSmsPreDispatchFailure(input, { status: "contact_not_found" });
  if (propertyResult.error) {
    return preserveRepSmsPreDispatchFailure(input, { status: "db_error", error: propertyResult.error.message });
  }
  if (!propertyResult.data) return preserveRepSmsPreDispatchFailure(input, { status: "property_not_found" });

  // Resolve an existing submission before current consent or quiet-hour
  // state. A replay is a read of the original durable outcome; it must never
  // create a second provider request or turn a completed send into a new
  // blocked attempt after the lead changes. The keyed fast path above handles
  // provider-off reloads; this check covers callers whose initial property
  // read did not use it.
  if (idempotencyKey && !input.repSmsReceipt && !idempotencyChecked) {
    const existing = await loadRepSmsIdempotencyRow(
      supabase,
      propertyResult.data.org_id,
      idempotencyKey,
    );
    if (existing.error) return { status: "db_error", error: existing.error };
    if (existing.row) return repSmsIdempotencyReplay(existing.row, input);
  }

  const resolved = resolveProvider();
  if (!("providerId" in resolved)) return resolved;
  const provider = resolved;
  try {
    // The provider key is application-scoped.  Bind every property-backed
    // Sendillo send to the single configured organization before any sender
    // lookup or pending row can cross that provider boundary.
    assertSendilloOrganizationScope(propertyResult.data.org_id, provider.providerId);
  } catch (e) {
    return preserveRepSmsPreDispatchFailure(input, {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const consentState = await getConsentState(supabase, input.contactId, "sms");
  const suppression = evaluateSuppression({
    outreachDispo: propertyResult.data.outreach_dispo,
    consentState,
    doNotContact: contactResult.data.do_not_contact,
    smsOptedOut: contactResult.data.sms_opted_out,
  });
  if (suppression.suppressed) {
    return preserveRepSmsPreDispatchFailure(input, blockedTerminalDispo(suppression));
  }

  const destination = input.to
    ? selectSmsPhoneByNumber(contactResult.data, input.to)
    : selectBestSmsPhone(contactResult.data);
  if (!destination) {
    return preserveRepSmsPreDispatchFailure(input, {
      status: "blocked_no_phone",
      reason: input.to
        ? "Selected thread phone is not saved on this contact. Resolve the contact phone before replying."
        : "Contact has no phone number. Add one before sending SMS.",
    });
  }
  if (destination.lineType === "landline") {
    return preserveRepSmsPreDispatchFailure(input, { status: "blocked_landline", reason: LANDLINE_BLOCK_REASON });
  }
  try {
    if (
      await isSmsPhoneSuppressed(
        supabase,
        destination.phone,
        propertyResult.data.org_id,
      )
    ) {
      return preserveRepSmsPreDispatchFailure(input, blockedTerminalDispo({
        suppressed: true,
        source: "phone_suppression",
        outreachDispo: propertyResult.data.outreach_dispo,
        consentState,
        reason: "Phone number is suppressed from SMS.",
      }));
    }
  } catch (e) {
    return preserveRepSmsPreDispatchFailure(input, {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 3. Consent check — only hard-block explicit opt-outs; no-consent is allowed.
  if (consentState === "opted_out") {
    return preserveRepSmsPreDispatchFailure(input, {
      status: "blocked_no_consent",
      reason: consentMessage(consentState),
      consentState,
    });
  }

  // 4. Quiet hours.
  const quiet = checkQuietHours(propertyResult.data.state);
  if (!quiet.ok) {
    return preserveRepSmsPreDispatchFailure(input, {
      status: "blocked_quiet_hours",
      reason: quietMessage(quiet),
      check: quiet,
    });
  }

  // 5. Pre-insert the row so we always have a breadcrumb.
  let conversationId: string;
  try {
    conversationId = await ensureConversationIdForThread(
      supabase,
      input.contactId,
      input.propertyId,
    );
  } catch (e) {
    return preserveRepSmsPreDispatchFailure(input, {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
  const normalizedToPhone = normalizePhone(destination.phone) ?? destination.phone;
  const fromResolution = await resolveOutboundFromAddress(supabase, {
    provider,
    orgId: propertyResult.data.org_id,
    contactId: input.contactId,
    propertyId: input.propertyId,
    toAddress: normalizedToPhone,
    explicitFrom: input.from,
    campaignId: input.campaignId,
    requireStickyFrom: input.requireStickyFrom ?? false,
    allowDefaultFromWhenNoSticky: input.allowDefaultFromWhenNoSticky ?? false,
  });
  if (!fromResolution.ok) return preserveRepSmsPreDispatchFailure(input, fromResolution.outcome);
  const fromAddress = fromResolution.fromAddress;
  if (
    !input.queueOnly &&
    !hasOpeningIdentity(input.body) &&
    shouldEnforceBmhOpeningIdentity(propertyResult.data.org_id)
  ) {
    if (!fromAddress) {
      return preserveRepSmsPreDispatchFailure(input, {
        status: "db_error",
        error: openingIdentityError(input.body) ?? "Opening SMS identity is required.",
      });
    }
    const evidence = await loadConversationOpeningEvidence(supabase, {
      orgId: propertyResult.data.org_id,
      customerPhone: normalizedToPhone,
      businessPhone: fromAddress,
    });
    if (!evidence.ok) {
      return preserveRepSmsPreDispatchFailure(input, {
        status: "db_error",
        error: `opening history lookup failed: ${evidence.error}`,
      });
    }
    // An inbound message establishes an existing conversation even when the
    // provider has no successful outbound receipt yet. Failed, pending, and
    // queued rows intentionally do not count as identity evidence.
    if (!evidence.hasDeliveredOutbound && !evidence.hasInbound && !hasOpeningIdentity(input.body)) {
      return preserveRepSmsPreDispatchFailure(input, {
        status: "db_error",
        error: openingIdentityError(input.body) ?? "Opening SMS identity is required.",
      });
    }
  }
  const inputMetadata =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : null;
  const pendingAt = new Date().toISOString();
  const { data: pending, error: insertError } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "outbound",
      status: "pending",
      provider: provider.providerId,
      campaign_id: input.campaignId ?? null,
      contact_id: input.contactId,
      property_id: input.propertyId,
      idempotency_key: input.repSmsReceipt ? null : idempotencyKey,
      conversation_id: conversationId,
      from_address: fromAddress,
      to_address: normalizedToPhone,
      body: input.body,
      metadata: {
        ...(inputMetadata ?? {}),
        providerAttempt: {
          pendingAt,
          maxPendingMs: PROVIDER_PENDING_STALE_MS,
        },
      } as Json,
    })
    .select("id")
    .single();
  if (insertError || !pending) {
    if (insertError?.code === "23505" && idempotencyKey && !input.repSmsReceipt) {
      const existing = await loadRepSmsIdempotencyRow(
        supabase,
        propertyResult.data.org_id,
        idempotencyKey,
      );
      if (!existing.error && existing.row) {
        return repSmsIdempotencyReplay(existing.row, input);
      }
    }
    if (input.repSmsReceipt) {
      const recorded = await recordRepSmsDeliveryLedgerResult(input.repSmsReceipt, "failed_not_dispatched", {
        providerError: insertError?.message ?? "failed to insert the pending SMS row",
      });
      if (!recorded) {
        return {
          status: "provider_unknown",
          messageId: input.repSmsReceipt.receiptId,
          error: "The SMS could not be prepared and its durable retry state could not be recorded. Review before retrying.",
        };
      }
    }
    return {
      status: "db_error",
      error: insertError?.message ?? "failed to insert pending message",
    };
  }

  // 5b. Final automated-boundary re-check — immediately before the
  // provider call, on FRESH state, so a campaign SMS whose row was
  // inserted before a booking (or an AI/sequence send that passed its
  // early dispo gate before a booking committed) cannot still reach the
  // provider after the property became human-owned. Manual sends
  // (composer/inline reply) skip this — they stay consent-only per
  // `isSuppressed`, already enforced above.
  if (input.origin === "automated") {
    const freshCheck = await checkFreshAutomatedSuppression(supabase, {
      propertyId: input.propertyId,
      contactId: input.contactId,
    });
    if (!freshCheck.ok) {
      await supabase
        .from("messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: `Held: could not confirm current suppression state before sending (${freshCheck.error}).`,
        })
        .eq("id", pending.id);
      return {
        status: "blocked_fresh_state_unavailable",
        messageId: pending.id,
          error: freshCheck.error,
      };
    }
    const blocked = freshCheck.decision;
    if (blocked) {
      await supabase
        .from("messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: blocked.reason,
        })
        .eq("id", pending.id);
      return {
        status: "blocked_automated_suppressed",
        messageId: pending.id,
        reason: blocked.reason,
        source: blocked.source,
        outreachDispo: blocked.outreachDispo ?? null,
        consentState: blocked.consentState ?? null,
      };
    }
  }

  // Native sequence sends have one stricter final fence than other
  // automated origins. The RPC locks the current enrollment and jointly
  // rechecks its expected step, contact/property boundary, consent,
  // selected phone, and durable phone suppression. On success it records
  // provider intent as `unknown` in the same transaction. Keep the provider
  // invocation directly after this await: there must be no intervening read
  // or write that could make a cancellation appear to prove non-delivery.
  if (input.sequenceContext) {
    const { data: authorization, error: authorizationError } = await supabase.rpc(
      "authorize_sequence_provider_attempt",
      {
        p_enrollment_id: input.sequenceContext.enrollmentId,
        p_step_id: input.sequenceContext.stepId,
        p_claim_id: input.sequenceContext.claimId,
        p_contact_id: input.contactId,
        p_property_id: input.propertyId,
        p_phone: normalizedToPhone,
        p_message_id: pending.id,
      },
    );
    if (authorizationError) {
      await supabase
        .from("messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: `Held: sequence authorization unavailable (${authorizationError.message}).`,
        })
        .eq("id", pending.id)
        .eq("status", "pending");
      return {
        status: "blocked_sequence_authorization",
        messageId: pending.id,
        reason: authorizationError.message,
        // An RPC error cannot prove whether its transaction committed the
        // provider intent marker; retain the safe unknown classification.
        attemptOutcome: "unknown",
      };
    }
    const decision = authorization?.[0];
    if (!decision?.authorized) {
      const reason = decision?.reason ?? "sequence authorization denied";
      await supabase
        .from("messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: reason,
        })
        .eq("id", pending.id)
        .eq("status", "pending");
      const attemptOutcome: SequenceAttemptOutcome =
        decision?.attempt_outcome === "definitively_rejected" ||
        decision?.attempt_outcome === "accepted" ||
        decision?.attempt_outcome === "unknown"
          ? decision.attempt_outcome
          : "not_attempted";
      return {
        status: "blocked_sequence_authorization",
        messageId: pending.id,
        reason,
        attemptOutcome,
      };
    }
  }

  // 6. Send. Keep accepted-provider errors outside provider failure handling.
  let acceptedExternalId: string | undefined;
  let providerAccepted = false;
  let providerCallStarted = false;
  try {
    await manualDispatch?.authorize(pending.id);
    providerCallStarted = true;
    const result = await provider.sendSms({
      to: destination.phone,
      body: input.body,
      from: fromAddress ?? undefined,
    });
    providerAccepted = true;
    acceptedExternalId = result.externalId;
    // Bind the provider receipt before updating the user-visible history row.
    // If that row update loses a race, the service ledger still records that
    // the provider accepted the request and a retry cannot issue a duplicate.
    let repSmsLedgerResult: RepSmsDeliveryLedgerResult | null = null;
    if (input.repSmsReceipt) {
      repSmsLedgerResult = await recordRepSmsDeliveryLedgerResult(input.repSmsReceipt, "accepted", {
        providerMessageId: result.externalId,
        providerStatus: result.providerStatus,
      });
      if (!repSmsLedgerResult) {
        return {
          status: "db_error",
          messageId: pending.id,
          externalId: result.externalId,
          ...(input.sequenceContext ? { deliveryOutcome: "accepted" as const } : {}),
          error: "The provider accepted the SMS, but its durable receipt could not be recorded. Review before retrying.",
        };
      }
    }
    const updates: MessagesUpdate = {
      status: "sent",
      external_id: result.externalId,
      sent_at: new Date().toISOString(),
      metadata: {
        ...(inputMetadata ?? {}),
        providerStatus: result.providerStatus,
        raw: result.raw,
      } as Json,
    };
    const { data: updated, error: updateError } = await retryReceiptTransaction(() =>
      supabase
        .from("messages")
        .update(updates)
        .eq("id", pending.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle(),
    );
    if (updateError || !updated) {
      return {
        status: "db_error",
        messageId: pending.id,
        externalId: result.externalId,
        ...(input.sequenceContext ? { deliveryOutcome: "accepted" as const } : {}),
        error: updateError?.message ?? "message changed while marking sent",
      };
    }
    if (repSmsLedgerResult?.state === "delivery_failed") {
      return {
        status: "provider_failed",
        messageId: pending.id,
        error: typeof repSmsLedgerResult.providerError === "string"
          ? repSmsLedgerResult.providerError
          : "The provider reported delivery failure.",
      };
    }
    await reconcileStoredStatusEvents(
      supabase,
      provider.providerId,
      result.externalId,
    );
    return {
      status: "sent",
      messageId: pending.id,
      externalId: result.externalId,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Receipt/reconciliation failures cannot change provider acceptance into failure.
    if (providerAccepted) {
      return {
        status: "db_error",
        messageId: pending.id,
        externalId: acceptedExternalId,
        ...(input.sequenceContext
          ? { deliveryOutcome: acceptedExternalId ? ("accepted" as const) : ("unknown" as const) }
          : {}),
        error: message,
      };
    }
    if (input.repSmsReceipt) {
      const state = providerCallStarted ? "unknown" : "failed_not_dispatched";
      const recorded = await recordRepSmsDeliveryLedgerResult(input.repSmsReceipt, state, {
        providerError: message,
      });
      if (!recorded) {
        return {
          status: "provider_unknown",
          messageId: pending.id,
          error: `${message}. Durable receipt state could not be confirmed; review before retrying.`,
        };
      }
    }
    if (isAmbiguousProviderError(e)) {
      await supabase
        .from("messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: message,
          metadata: {
            ...(inputMetadata ?? {}),
            providerOutcome: "provider_unknown",
            providerAttempt: {
              pendingAt,
              maxPendingMs: PROVIDER_PENDING_STALE_MS,
              terminal: true,
              retryable: false,
            },
          } as Json,
        })
        .eq("id", pending.id)
        .eq("status", "pending");
      return {
        status: "provider_unknown",
        messageId: pending.id,
        error: message,
      };
    }
    await supabase
      .from("messages")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_message: message,
        metadata: {
          ...(inputMetadata ?? {}),
            providerAttempt: {
              pendingAt,
              maxPendingMs: PROVIDER_PENDING_STALE_MS,
              terminal: true,
              outcome: classifySequenceProviderFailure(e),
            },
        } as Json,
      })
      .eq("id", pending.id);
    return {
      status: "provider_failed",
      messageId: pending.id,
      error: message,
      ...(input.sequenceContext
        ? { deliveryOutcome: classifySequenceProviderFailure(e) }
        : {}),
      ...(manualDispatch && !providerCallStarted ? { providerAttempted: false } : {}),
    };
  }
}

function classifySequenceProviderFailure(error: unknown): SequenceAttemptOutcome {
  // Only an adapter-provided marker is evidence of a definitive rejection.
  // Generic Error text, a failed messages row, and missing provider linkage
  // are all ambiguous once the provider call has begun.
  if (
    error instanceof ProviderError &&
    error.details?.definitiveRejection === true
  ) {
    return "definitively_rejected";
  }
  if (error instanceof ProviderError && error.details?.notSent === true) {
    return "not_attempted";
  }
  return "unknown";
}

/**
 * Persist a `messages` row with status='queued'. No provider call, no
 * consent check, no quiet-hours check — those run at release time via
 * `releaseQueuedMessage`. We only sanity-check that the contact has a
 * phone and that the property exists.
 */
async function queueForLater(
  supabase: SupabaseClient<Database>,
  providerId: string,
  input: SendSmsInput,
): Promise<SendSmsOutcome> {
  const [contactResult, propertyResult, consentState] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out")
      .eq("id", input.contactId)
      .maybeSingle(),
    supabase
      .from("properties")
      .select("id, org_id, outreach_dispo")
      .eq("id", input.propertyId)
      .maybeSingle(),
    getConsentState(supabase, input.contactId, "sms"),
  ]);
  if (contactResult.error) {
    return { status: "db_error", error: contactResult.error.message };
  }
  if (!contactResult.data) return { status: "contact_not_found" };
  if (propertyResult.error) {
    return { status: "db_error", error: propertyResult.error.message };
  }
  if (!propertyResult.data) return { status: "property_not_found" };

  try {
    assertSendilloOrganizationScope(propertyResult.data.org_id, providerId);
  } catch (e) {
    return {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const suppression = evaluateSuppression({
    outreachDispo: propertyResult.data.outreach_dispo,
    consentState,
    doNotContact: contactResult.data.do_not_contact,
    smsOptedOut: contactResult.data.sms_opted_out,
  });
  if (suppression.suppressed) {
    return blockedTerminalDispo(suppression);
  }

  const destination = input.to
    ? selectSmsPhoneByNumber(contactResult.data, input.to)
    : selectBestSmsPhone(contactResult.data);
  if (!destination) {
    return {
      status: "blocked_no_phone",
      reason: input.to
        ? "Selected thread phone is not saved on this contact. Resolve the contact phone before queueing."
        : "Contact has no phone number. Add one before queueing.",
    };
  }
  if (destination.lineType === "landline") {
    return { status: "blocked_landline", reason: LANDLINE_BLOCK_REASON };
  }
  try {
    if (
      await isSmsPhoneSuppressed(
        supabase,
        destination.phone,
        propertyResult.data.org_id,
      )
    ) {
      return blockedTerminalDispo({
        suppressed: true,
        source: "phone_suppression",
        outreachDispo: propertyResult.data.outreach_dispo,
        consentState,
        reason: "Phone number is suppressed from SMS.",
      });
    }
  } catch (e) {
    return {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  let conversationId: string;
  try {
    conversationId = await ensureConversationIdForThread(
      supabase,
      input.contactId,
      input.propertyId,
    );
  } catch (e) {
    return {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const normalizedToPhone = normalizePhone(destination.phone) ?? destination.phone;
  const provider = getMessagingProvider();
  if (!provider || provider.providerId !== providerId) {
    return {
      status: "blocked_provider_off",
      reason: "Messaging provider changed while queueing this SMS.",
    };
  }
  const fromResolution = await resolveOutboundFromAddress(supabase, {
    provider,
    orgId: propertyResult.data.org_id,
    contactId: input.contactId,
    propertyId: input.propertyId,
    toAddress: normalizedToPhone,
    explicitFrom: input.from,
    campaignId: input.campaignId,
    requireStickyFrom: input.requireStickyFrom ?? false,
    allowDefaultFromWhenNoSticky: input.allowDefaultFromWhenNoSticky ?? false,
  });
  if (!fromResolution.ok) return fromResolution.outcome;
  const fromAddress = fromResolution.fromAddress;
  if (
    !hasOpeningIdentity(input.body) &&
    shouldEnforceBmhOpeningIdentity(propertyResult.data.org_id)
  ) {
    if (!fromAddress) {
      return {
        status: "db_error",
        error: openingIdentityError(input.body) ?? "Opening SMS identity is required.",
      };
    }
    const evidence = await loadConversationOpeningEvidence(supabase, {
      orgId: propertyResult.data.org_id,
      customerPhone: normalizedToPhone,
      businessPhone: fromAddress,
    });
    if (!evidence.ok) {
      return { status: "db_error", error: `opening history lookup failed: ${evidence.error}` };
    }
    if (!evidence.hasDeliveredOutbound && !evidence.hasInbound) {
      return {
        status: "db_error",
        error: openingIdentityError(input.body) ?? "Opening SMS identity is required.",
      };
    }
  }
  const campaignPause = await campaignIsPaused(supabase, input.campaignId);
  if (campaignPause.error) {
    return { status: "db_error", error: campaignPause.error };
  }
  const queuedStatus = campaignPause.paused ? "paused" : "queued";
  const scheduledFor = input.scheduledFor?.toISOString() ?? null;
  // Stamp send provenance onto the row itself — `releaseQueuedMessage`
  // can't infer it later (a bulk campaign row and a manually-queued
  // composer row look identical by then), so it must be captured here at
  // enqueue time and read back at release.
  const metadataWithOrigin: Json = {
    ...(readMetadataRecord(input.metadata ?? null) ?? {}),
    sendOrigin: input.origin,
    ...(input.requiresOpeningIdentity
      ? { openingIdentityRequired: true }
      : {}),
  } as Json;
  const { data: queued, error } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "outbound",
      status: queuedStatus,
      provider: providerId,
      campaign_id: input.campaignId ?? null,
      contact_id: input.contactId,
      property_id: input.propertyId,
      conversation_id: conversationId,
      from_address: fromAddress,
      to_address: normalizedToPhone,
      body: input.body,
      scheduled_for: campaignPause.paused ? null : scheduledFor,
      metadata: campaignPause.paused
        ? addCampaignPauseMetadata(
            metadataWithOrigin,
            new Date().toISOString(),
            scheduledFor,
          )
        : metadataWithOrigin,
    })
    .select("id")
    .single();
  if (error || !queued) {
    return {
      status: "db_error",
      error: error?.message ?? "failed to insert queued message",
    };
  }
  return { status: queuedStatus, messageId: queued.id };
}

/**
 * Release a queued message — treats the stored row as the source of
 * truth for to/from/body/contact/property, re-runs consent + quiet-hours
 * checks against CURRENT state (not when it was queued), then fires
 * through the provider and flips status queued → pending → sent|failed.
 *
 * Callers: the /messages page's Send Next button, and the auto-send
 * controller's tick loop.
 */
export async function releaseQueuedMessage(
  supabase: SupabaseClient<Database>,
  messageId: string,
): Promise<SendSmsOutcome> {
  let provider;
  try {
    provider = getMessagingProvider();
  } catch (e) {
    if (e instanceof ConfigurationError) {
      return { status: "blocked_provider_off", reason: e.message };
    }
    throw e;
  }
  if (!provider) {
    return {
      status: "blocked_provider_off",
      reason:
        "Messaging is off — set MESSAGING_PROVIDER in .env.local to enable it.",
    };
  }

  const { data: msg, error: fetchError } = await supabase
    .from("messages")
    .select(
      "id, status, provider, org_id, campaign_id, contact_id, property_id, body, from_address, to_address, scheduled_for, metadata",
    )
    .eq("id", messageId)
    .maybeSingle();
  if (fetchError) {
    return { status: "db_error", error: fetchError.message };
  }
  if (!msg) return { status: "contact_not_found" };
  try {
    assertSendilloOrganizationScope(msg.org_id, provider.providerId);
  } catch (e) {
    return {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  await assertNotTrainingTarget(supabase, { propertyId: msg.property_id, contactId: msg.contact_id });
  // Only queued rows can be released. Anything else is likely a
  // double-click or a stale auto-send tick — treat as a no-op by
  // returning the terminal state instead of re-sending.
  if (msg.status !== "queued") {
    if (msg.status === "sent") {
      return { status: "sent", messageId: msg.id, externalId: "(already sent)" };
    }
    return { status: "db_error", error: `message is ${msg.status}, not queued` };
  }
  const queuedMetadata = readMetadataRecord(msg.metadata);
  const requiresOpeningIdentity = queuedMetadata?.openingIdentityRequired === true;
  const enforceOpeningIdentityAtClaim = requiresOpeningIdentity;
  const campaignPause = await pauseQueuedMessageIfCampaignPaused(
    supabase,
    msg.id,
    msg.campaign_id,
    msg.metadata,
    msg.scheduled_for,
  );
  if (campaignPause) return campaignPause;
  if (msg.scheduled_for && new Date(msg.scheduled_for).getTime() > Date.now()) {
    return {
      status: "blocked_not_due",
      messageId: msg.id,
      retryAt: msg.scheduled_for,
    };
  }
  if (requiresOpeningIdentity && !hasOpeningIdentity(msg.body)) {
    const identityError = openingIdentityError(msg.body);
    if (identityError) {
      await failQueuedMessage(supabase, msg.id, identityError);
      return { status: "db_error", messageId: msg.id, error: identityError };
    }
  }
  if (!msg.contact_id || !msg.property_id || !msg.to_address) {
    return {
      status: "db_error",
      error: "queued message missing contact/property/to_address",
    };
  }
  // Legacy queued rows may predate the openingIdentityRequired metadata. For
  // the configured BMH Sendillo tenant, use the actual phone pair and only
  // delivered outbound or inbound history as evidence that this is already
  // an established conversation. Queued, failed, and pending rows do not
  // suppress this check, so a legacy anonymous first touch fails safely.
  if (
    !hasOpeningIdentity(msg.body) &&
    !requiresOpeningIdentity &&
    shouldEnforceBmhOpeningIdentity(msg.org_id)
  ) {
    if (!msg.from_address) {
      const identityError = openingIdentityError(msg.body) ?? "Opening SMS identity is required.";
      await failQueuedMessage(supabase, msg.id, identityError);
      return { status: "db_error", messageId: msg.id, error: identityError };
    }
    const evidence = await loadConversationOpeningEvidence(supabase, {
      orgId: msg.org_id,
      customerPhone: msg.to_address,
      businessPhone: msg.from_address,
    });
    if (!evidence.ok) {
      return {
        status: "db_error",
        messageId: msg.id,
        error: `opening history lookup failed: ${evidence.error}`,
      };
    }
    if (!evidence.hasDeliveredOutbound && !evidence.hasInbound) {
      const identityError = openingIdentityError(msg.body) ?? "Opening SMS identity is required.";
      await failQueuedMessage(supabase, msg.id, identityError);
      return { status: "db_error", messageId: msg.id, error: identityError };
    }
  }
  if (msg.provider !== provider.providerId) {
    const error =
      `queued message belongs to provider ${msg.provider ?? "unknown"}, current provider is ${provider.providerId}`;
    await failQueuedMessage(supabase, msg.id, error);
    return {
      status: "db_error",
      error,
    };
  }
  // Sender guard: the row must send from the sender it was queued with,
  // and that sender must be in the synced approved inventory — never an
  // env-default fallback. Unknown/inactive senders fail the row loudly;
  // empty/never-synced inventory is deferred so first deploys do not
  // terminally kill every queued row before the first catalog sync.
  // Accepted v1 risk: same-org direct INSERT can still queue an approved but
  // wrong sender on a locked campaign. Release validates org inventory, not
  // campaign lock; official campaign paths stamp and lock the sender earlier.
  if (providerSupportsSenderInventory(provider)) {
    if (!msg.from_address) {
      const error =
        `queued message is missing from_address; Delivery sender is required for provider ${provider.providerId}`;
      return deferQueuedMessage(supabase, msg.id, error, msg.metadata);
    }

    let inventory: SenderInventoryState;
    try {
      inventory = await getSenderInventoryState(
        supabase,
        msg.org_id,
        provider.providerId,
        msg.from_address,
      );
    } catch (e) {
      return {
        status: "db_error",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if (inventory.state !== "approved") {
      if (inventory.state === "empty") {
        const error =
          `queued message sender ${msg.from_address} is blocked because no approved sender inventory has been synced for provider ${provider.providerId}`;
        return deferQueuedMessage(supabase, msg.id, error, msg.metadata);
      }
      const senderState =
        inventory.state === "inactive" ? "no longer active" : "not";
      const error =
        `queued message sender ${msg.from_address} is ${senderState} ` +
        `in the approved ${provider.providerId} sender inventory`;
      await failQueuedMessage(supabase, msg.id, error);
      return {
        status: "db_error",
        error,
      };
    }
  }

  // Line-type re-check — a number can get classified landline between
  // queue and release (cache backfill, lookup providers), and slot
  // promotion can move a queued-to landline OUT of phone_1 (slot 2/3),
  // so the destination must be checked against EVERY current slot, not
  // just slot 1. Fail permanently rather than blocking so the auto-send
  // tick doesn't retry it forever.
  const [consentState, releaseContactResult, propertyResult] = await Promise.all([
    getConsentState(supabase, msg.contact_id, "sms"),
    supabase
      .from("contacts")
      .select(
        "phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out",
      )
      .eq("id", msg.contact_id)
      .maybeSingle(),
    supabase
      .from("properties")
      .select("org_id, state, outreach_dispo")
      .eq("id", msg.property_id)
      .maybeSingle(),
  ]);
  if (releaseContactResult.error) {
    return { status: "db_error", error: releaseContactResult.error.message };
  }
  if (propertyResult.error) {
    return { status: "db_error", error: propertyResult.error.message };
  }

  const suppression = evaluateSuppression({
    outreachDispo: propertyResult.data?.outreach_dispo ?? null,
    consentState,
    doNotContact: releaseContactResult.data?.do_not_contact ?? null,
    smsOptedOut: releaseContactResult.data?.sms_opted_out ?? null,
  });
  if (suppression.suppressed) {
    const outcome = blockedTerminalDispo(suppression);
    await failQueuedMessage(supabase, msg.id, outcome.reason);
    return outcome;
  }
  try {
    if (
      await isSmsPhoneSuppressed(
        supabase,
        msg.to_address,
        propertyResult.data?.org_id ?? msg.org_id,
      )
    ) {
      const outcome = blockedTerminalDispo({
        suppressed: true,
        source: "phone_suppression",
        outreachDispo: propertyResult.data?.outreach_dispo ?? null,
        consentState,
        reason: "Phone number is suppressed from SMS.",
      });
      await failQueuedMessage(supabase, msg.id, outcome.reason);
      return outcome;
    }
  } catch (e) {
    return {
      status: "db_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (consentState === "opted_out") {
    await failQueuedMessage(supabase, msg.id, consentMessage(consentState));
    return {
      status: "blocked_no_consent",
      reason: consentMessage(consentState),
      consentState,
    };
  }

  const releaseContact = releaseContactResult.data;
  if (releaseContact) {
    const slots: [string | null, string][] = [
      [releaseContact.phone_1, releaseContact.phone_1_type],
      [releaseContact.phone_2, releaseContact.phone_2_type],
      [releaseContact.phone_3, releaseContact.phone_3_type],
    ];
    const destinationIsLandline = slots.some(
      ([number, type]) =>
        type === "landline" &&
        number &&
        (normalizePhone(number) ?? number) === msg.to_address,
    );
    if (destinationIsLandline) {
      await failQueuedMessage(supabase, msg.id, LANDLINE_BLOCK_REASON);
      return { status: "blocked_landline", reason: LANDLINE_BLOCK_REASON };
    }
  }

  // Quiet-hours re-check — dominant reason to queue in the first place.
  const quiet = checkQuietHours(propertyResult.data?.state ?? null);
  if (!quiet.ok) {
    return {
      status: "blocked_quiet_hours",
      reason: quietMessage(quiet),
      check: quiet,
    };
  }

  // Flip queued → pending atomically to prevent a concurrent tick from
  // double-sending. The `eq("status", "queued")` guard means the UPDATE
  // only applies if nobody else grabbed it first; we check rowcount
  // indirectly via a re-read.
  const currentMetadata = queuedMetadata;
  const pendingAt = new Date().toISOString();
  const { data: claimed, error: flipError } = await supabase
    .from("messages")
    .update({
      status: "pending",
      metadata: {
        ...(currentMetadata ?? {}),
        providerAttempt: {
          pendingAt,
          maxPendingMs: PROVIDER_PENDING_STALE_MS,
        },
      } as Json,
    })
    .eq("id", msg.id)
    .eq("status", "queued")
    .select("id, body")
    .maybeSingle();
  if (flipError) {
    return { status: "db_error", error: flipError.message };
  }
  if (!claimed) {
    return {
      status: "db_error",
      error: "another worker claimed this queued message",
    };
  }
  if (typeof claimed.body !== "string") {
    const error = "queued message claim did not return its body";
    await supabase
      .from("messages")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_message: error,
      })
      .eq("id", msg.id)
      .eq("status", "pending");
    return { status: "db_error", messageId: msg.id, error };
  }
  let claimedIdentityError =
    enforceOpeningIdentityAtClaim && !hasOpeningIdentity(claimed.body)
      ? openingIdentityError(claimed.body)
      : null;
  // A direct queue update can change the body between the initial read and
  // the CAS claim. Re-check an anonymous claimed body against the phone-pair
  // history so a first-touch row cannot race its identity guard away. An
  // established conversation may continue with a human-composed follow-up.
  if (
    !claimedIdentityError &&
    !requiresOpeningIdentity &&
    !hasOpeningIdentity(claimed.body) &&
    shouldEnforceBmhOpeningIdentity(msg.org_id)
  ) {
    if (!msg.from_address) {
      claimedIdentityError = openingIdentityError(claimed.body) ?? "Opening SMS identity is required.";
    } else {
      const evidence = await loadConversationOpeningEvidence(supabase, {
        orgId: msg.org_id,
        customerPhone: msg.to_address,
        businessPhone: msg.from_address,
      });
      if (!evidence.ok) {
        const error = `opening history lookup failed: ${evidence.error}`;
        await supabase
          .from("messages")
          .update({
            status: "failed",
            failed_at: new Date().toISOString(),
            error_message: error,
          })
          .eq("id", msg.id)
          .eq("status", "pending");
        return { status: "db_error", messageId: msg.id, error };
      }
      if (!evidence.hasDeliveredOutbound && !evidence.hasInbound) {
        claimedIdentityError = openingIdentityError(claimed.body) ?? "Opening SMS identity is required.";
      }
    }
  }
  if (claimedIdentityError) {
    await supabase
      .from("messages")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_message: claimedIdentityError,
      })
      .eq("id", msg.id)
      .eq("status", "pending");
    return {
      status: "db_error",
      messageId: msg.id,
      error: claimedIdentityError,
    };
  }

  const postClaimPause = await campaignIsPaused(supabase, msg.campaign_id);
  if (postClaimPause.error) {
    return { status: "db_error", error: postClaimPause.error };
  }
  if (postClaimPause.paused) {
    const { error: pauseClaimedError } = await supabase
      .from("messages")
      .update({
        status: "paused",
        scheduled_for: null,
        metadata: addCampaignPauseMetadata(
          {
            ...(currentMetadata ?? {}),
            providerAttempt: {
              pendingAt,
              maxPendingMs: PROVIDER_PENDING_STALE_MS,
            },
          } as Json,
          new Date().toISOString(),
          msg.scheduled_for,
        ),
      })
      .eq("id", msg.id)
      .eq("status", "pending");
    if (pauseClaimedError) {
      return { status: "db_error", error: pauseClaimedError.message };
    }
    return {
      status: "blocked_campaign_paused",
      messageId: msg.id,
      reason: "Campaign sends were paused before this SMS reached the provider. It was held until the campaign is resumed.",
    };
  }

  // Final automated-boundary re-check — immediately before the provider
  // call, on FRESH state. Provenance is read off the row itself (stamped
  // at enqueue time in `queueForLater`), since a bulk-campaign row and a
  // manually-queued composer row are indistinguishable by release time
  // otherwise. Rows queued before this field existed default to
  // 'automated' — fail safe toward suppression rather than silently
  // skipping the check.
  const queuedOrigin = resolveQueuedSendOrigin(msg.metadata);
  if (queuedOrigin === "automated") {
    const freshCheck = await checkFreshAutomatedSuppression(supabase, {
      propertyId: msg.property_id,
      contactId: msg.contact_id,
    });
    if (!freshCheck.ok) {
      const { error: holdError } = await supabase
        .from("messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: `Held: could not confirm current suppression state before sending (${freshCheck.error}).`,
        })
        .eq("id", msg.id)
        .eq("status", "pending");
      if (holdError) {
        return { status: "db_error", error: holdError.message };
      }
      return {
        status: "blocked_fresh_state_unavailable",
        messageId: msg.id,
        error: freshCheck.error,
      };
    }
    const blocked = freshCheck.decision;
    if (blocked) {
      const { error: suppressError } = await supabase
        .from("messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: blocked.reason,
        })
        .eq("id", msg.id)
        .eq("status", "pending");
      if (suppressError) {
        return { status: "db_error", error: suppressError.message };
      }
      return {
        status: "blocked_automated_suppressed",
        messageId: msg.id,
        reason: blocked.reason,
        source: blocked.source,
        outreachDispo: blocked.outreachDispo ?? null,
        consentState: blocked.consentState ?? null,
      };
    }
  }

  let providerAccepted = false;
  let acceptedExternalId: string | undefined;
  try {
    // Accepted race: an operator-triggered catalog sync can deactivate this
    // sender in the milliseconds after validation and before the provider call.
    // The queued row keeps the exact sender snapshot for audit/retry review.
    const result = await provider.sendSms({
      to: msg.to_address,
      body: claimed.body,
      from: msg.from_address ?? undefined,
    });
    providerAccepted = true;
    acceptedExternalId = result.externalId;
    // Freeze this payload once; retries persist the same accepted provider result.
    const updates: MessagesUpdate = {
      status: "sent",
      external_id: result.externalId,
      sent_at: new Date().toISOString(),
      failed_at: null,
      error_message: null,
      metadata: {
        ...(currentMetadata ?? {}),
        providerStatus: result.providerStatus,
        raw: result.raw,
      } as Json,
    };
    const { data: updated, error: updateError } = await retryReceiptTransaction(() =>
      supabase
        .from("messages")
        .update(updates)
        .eq("id", msg.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle(),
    );
    if (updateError || !updated) {
      return {
        status: "db_error",
        messageId: msg.id,
        externalId: result.externalId,
        error: updateError?.message ?? "queued message changed while marking sent",
      };
    }
    await reconcileStoredStatusEvents(
      supabase,
      provider.providerId,
      result.externalId,
    );
    return {
      status: "sent",
      messageId: msg.id,
      externalId: result.externalId,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (providerAccepted) {
      return {
        status: "db_error",
        messageId: msg.id,
        externalId: acceptedExternalId,
        error: message,
      };
    }
    if (isAmbiguousProviderError(e)) {
      const unknownMetadata = {
        ...(currentMetadata ?? {}),
        providerOutcome: "provider_unknown",
        providerAttempt: {
          pendingAt,
          maxPendingMs: PROVIDER_PENDING_STALE_MS,
          terminal: true,
          retryable: false,
        },
      } as Json;
      const { error: unknownError } = await supabase
        .from("messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: message,
          metadata: unknownMetadata,
        })
        .eq("id", msg.id)
        .eq("status", "pending");
      if (unknownError) {
        return { status: "db_error", error: unknownError.message };
      }
      return {
        status: "provider_unknown",
        messageId: msg.id,
        error: message,
      };
    }
    const retry = buildProviderRetryUpdate(e, currentMetadata);
    if (retry.defer) {
      const pauseForRetry = await campaignIsPaused(supabase, msg.campaign_id);
      if (pauseForRetry.error) {
        return { status: "db_error", error: pauseForRetry.error };
      }
      const retryMetadata = pauseForRetry.paused
        ? addCampaignPauseMetadata(
            retry.metadata,
            new Date().toISOString(),
            retry.retryAt,
          )
        : retry.metadata;
      const { data: deferred, error: deferError } = await supabase
        .from("messages")
        .update({
          status: pauseForRetry.paused ? "paused" : "queued",
          scheduled_for: pauseForRetry.paused ? null : retry.retryAt,
          error_message: message,
          metadata: retryMetadata,
        })
        .eq("id", msg.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (deferError) {
        return { status: "db_error", error: deferError.message };
      }
      if (!deferred) {
        return {
          status: "db_error",
          error: "queued message changed while scheduling provider retry",
        };
      }
      return {
        status: "provider_deferred",
        messageId: msg.id,
        error: message,
        attempt: retry.attempt,
        retryAt: retry.retryAt,
      };
    }

    const { data: failed, error: failError } = await supabase
      .from("messages")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_message: retry.errorMessage,
        metadata: retry.metadata,
      })
      .eq("id", msg.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (failError) {
      return { status: "db_error", error: failError.message };
    }
    if (!failed) {
      return {
        status: "db_error",
        error: "queued message changed while marking provider failure",
      };
    }
    return { status: "provider_failed", messageId: msg.id, error: message };
  }
}

function readMetadataRecord(metadata: Json | null): Record<string, unknown> | null {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : null;
}

function addCampaignPauseMetadata(
  metadata: Json | null,
  pausedAt: string,
  previousScheduledFor: string | null,
): Json {
  const baseMetadata = readMetadataRecord(metadata) ?? {};
  return {
    ...baseMetadata,
    campaignPause: {
      pausedAt,
      previousScheduledFor,
      reason: "operator_pause",
    },
  } as Json;
}

async function campaignIsPaused(
  supabase: SupabaseClient<Database>,
  campaignId: string | null | undefined,
): Promise<{ paused: boolean; error: string | null }> {
  if (!campaignId) return { paused: false, error: null };
  const { data, error } = await supabase
    .from("campaigns")
    .select("status")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) return { paused: false, error: error.message };
  return { paused: data?.status === "paused", error: null };
}

async function blockIfCampaignPaused(
  supabase: SupabaseClient<Database>,
  campaignId: string | null | undefined,
): Promise<Extract<SendSmsOutcome, { status: "blocked_campaign_paused" | "db_error" }> | null> {
  const paused = await campaignIsPaused(supabase, campaignId);
  if (paused.error) return { status: "db_error", error: paused.error };
  if (!paused.paused) return null;
  return {
    status: "blocked_campaign_paused",
    reason: "Campaign sends are paused. Resume the campaign before sending or queueing more SMS.",
  };
}

async function pauseQueuedMessageIfCampaignPaused(
  supabase: SupabaseClient<Database>,
  messageId: string,
  campaignId: string | null,
  metadata: Json | null,
  previousScheduledFor: string | null,
): Promise<Extract<SendSmsOutcome, { status: "blocked_campaign_paused" | "db_error" | "sent" }> | null> {
  const paused = await campaignIsPaused(supabase, campaignId);
  if (paused.error) return { status: "db_error", error: paused.error };
  if (!paused.paused) return null;

  const { error } = await supabase
    .from("messages")
    .update({
      status: "paused",
      scheduled_for: null,
      metadata: addCampaignPauseMetadata(
        metadata,
        new Date().toISOString(),
        previousScheduledFor,
      ),
    })
    .eq("id", messageId)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (error) return { status: "db_error", error: error.message };

  const { data: latest, error: latestError } = await supabase
    .from("messages")
    .select("id, status, external_id")
    .eq("id", messageId)
    .maybeSingle();
  if (latestError) return { status: "db_error", error: latestError.message };
  if (latest?.status === "sent") {
    return {
      status: "sent",
      messageId,
      externalId: latest.external_id ?? "(already sent)",
    };
  }
  if (latest?.status === "pending") {
    return {
      status: "db_error",
      error: "queued message was already claimed before it could be paused",
    };
  }

  return {
    status: "blocked_campaign_paused",
    messageId,
    reason: "Campaign sends are paused. This queued SMS was held until the campaign is resumed.",
  };
}

function buildProviderRetryUpdate(
  error: unknown,
  currentMetadata: Record<string, unknown> | null,
):
  | {
      defer: true;
      attempt: number;
      retryAt: string;
      metadata: Json;
    }
  | {
      defer: false;
      errorMessage: string;
      metadata: Json;
    } {
  const message = error instanceof Error ? error.message : String(error);
  const previous = readProviderRetryMetadata(currentMetadata);
  const transient = isTransientProviderError(error);
  const attempt = previous.attempts + 1;
  const now = new Date();
  const baseMetadata = currentMetadata ?? {};
  const providerRetry = {
    attempts: attempt,
    lastError: message,
    lastAttemptAt: now.toISOString(),
    transient,
    maxDeferAttempts: PROVIDER_TRANSIENT_MAX_DEFER_ATTEMPTS,
  };

  if (transient && attempt <= PROVIDER_TRANSIENT_MAX_DEFER_ATTEMPTS) {
    const retryAt = new Date(
      now.getTime() + PROVIDER_TRANSIENT_DEFER_MS * attempt,
    ).toISOString();
    return {
      defer: true,
      attempt,
      retryAt,
      metadata: {
        ...baseMetadata,
        providerRetry: {
          ...providerRetry,
          nextRetryAt: retryAt,
        },
      } as Json,
    };
  }

  return {
    defer: false,
    errorMessage:
      transient && attempt > PROVIDER_TRANSIENT_MAX_DEFER_ATTEMPTS
        ? `${message} (provider retry cap reached after ${previous.attempts} deferred attempts).`
        : message,
    metadata: {
      ...baseMetadata,
      providerRetry: {
        ...providerRetry,
        terminal: true,
      },
    } as Json,
  };
}

function readProviderRetryMetadata(
  metadata: Record<string, unknown> | null,
): { attempts: number } {
  const retry = metadata?.providerRetry;
  if (!retry || typeof retry !== "object" || Array.isArray(retry)) {
    return { attempts: 0 };
  }
  const attempts = (retry as Record<string, unknown>).attempts;
  return {
    attempts:
      typeof attempts === "number" && Number.isInteger(attempts) ? attempts : 0,
  };
}

// Provider retries are allowed only for errors with documented retry
// semantics. The Sendillo adapter marks its ambiguous boundary outcomes
// before this classifier runs, so those rows stay on the non-resend hold.
function isTransientProviderError(error: unknown): boolean {
  // Sendillo's timeout, transport failure, 5xx response, and 2xx response
  // without a reconcilable message id all leave delivery uncertain. They
  // must never enter the generic retry queue, which could duplicate a text.
  if (isAmbiguousProviderError(error)) return false;
  if (error instanceof ProviderError) {
    const status = error.details?.status;
    if (
      typeof status === "number" &&
      (status === 408 || status === 425 || status === 429 || status >= 500)
    ) {
      return true;
    }
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    /carrier blocked|unknown recipient|unknown number|invalid (recipient|phone|number)|opted out|unsubscribed/.test(
      message,
    )
  ) {
    return false;
  }
  return /\b429\b|rate limit|too many requests|timeout|timed out|abort|network|fetch failed|econn|etimedout|temporar|5\d\d/.test(
    message,
  );
}

/**
 * A provider error can be safely retried only when the provider proved it
 * rejected the request before accepting it. Sendillo's API gives us no such
 * proof for a transport/abort failure, a 5xx response, or a successful
 * response with no message id. Keep this classifier deliberately narrow so
 * another adapter's documented retry contract is unchanged.
 */
function isAmbiguousProviderError(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.provider !== "sendillo") {
    return false;
  }
  const details = error.details;
  if (!details || details.notSent === true) return false;
  return details.ambiguousDelivery === true
    || details.transportFailure === true
    || details.isAbort === true
    || details.acceptedWithoutId === true;
}

function consentMessage(state: ConsentState): string {
  switch (state) {
    case "opted_out":
      return "Contact has opted out of SMS. Sending is blocked.";
    case "can_send_informational_only":
      return "Only informational SMS is permitted — written consent is required for marketing messages.";
    case "no_consent":
      return "No SMS consent on file. Capture written consent before sending.";
    case "can_send_marketing":
      // Shouldn't reach here, caller only renders on block.
      return "OK to send.";
  }
}

function quietMessage(check: QuietHoursCheck): string {
  if (check.ok) return "OK to send.";
  if (check.reason === "unknown_state") {
    return "Property has no US state — can't determine local time. Add state and retry.";
  }
  return `Quiet hours — it's ${check.localTime} local (${check.zone}). TCPA window is 08:00–21:00.`;
}

function blockedTerminalDispo(
  decision: Extract<SuppressionDecision, { suppressed: true }>,
): Extract<SendSmsOutcome, { status: "blocked_terminal_dispo" }> {
  return {
    status: "blocked_terminal_dispo",
    reason: decision.reason,
    source: decision.source,
    outreachDispo: decision.outreachDispo ?? null,
    consentState: decision.consentState ?? null,
  };
}

type FreshSuppressionCheck =
  | {
      ok: true;
      decision: Extract<SuppressionDecision, { suppressed: true }> | null;
    }
  | { ok: false; error: string };

/**
 * Re-load the property's dispo and the contact's suppression fields +
 * consent state FRESH (not reusing anything looked up earlier in this
 * call) and run them through `evaluateAutomatedSuppression` — the single
 * boundary function. Called immediately before every provider dispatch
 * when `origin === 'automated'`.
 *
 * Fail-closed: if either reload errors (or the call throws), this returns
 * `{ ok: false }` rather than silently treating the unread state as
 * "not suppressed" — a transient read failure must never let a send
 * through that current state might forbid. Only `{ ok: true, decision }`
 * reports an actual (non-)suppression verdict; `decision` is `null` when
 * clear to send.
 */
async function checkFreshAutomatedSuppression(
  supabase: SupabaseClient<Database>,
  args: { propertyId: string; contactId: string },
): Promise<FreshSuppressionCheck> {
  let propertyResult: { data: { outreach_dispo: string | null } | null; error: { message: string } | null };
  let contactResult: {
    data: { do_not_contact: boolean | null; sms_opted_out: boolean | null } | null;
    error: { message: string } | null;
  };
  let consentState: ConsentState;
  try {
    [propertyResult, contactResult, consentState] = await Promise.all([
      supabase
        .from("properties")
        .select("outreach_dispo")
        .eq("id", args.propertyId)
        .maybeSingle(),
      supabase
        .from("contacts")
        .select("do_not_contact, sms_opted_out")
        .eq("id", args.contactId)
        .maybeSingle(),
      getConsentState(supabase, args.contactId, "sms"),
    ]);
  } catch (e) {
    return {
      ok: false,
      error: `fresh suppression state reload threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (propertyResult.error || contactResult.error) {
    return {
      ok: false,
      error:
        propertyResult.error?.message ??
        contactResult.error?.message ??
        "fresh suppression state reload failed",
    };
  }
  // `.maybeSingle()` returns `{ data: null, error: null }` when the row is
  // gone (hard-deleted, or the id was bad) — not an error. Fail closed here
  // too: a missing property/contact means we can't confirm current
  // suppression state, so treat it the same as a reload failure rather
  // than falling through with `?? null` defaults that would read as
  // "nothing suppressing this send."
  if (!propertyResult.data || !contactResult.data) {
    return {
      ok: false,
      error: !propertyResult.data
        ? "fresh suppression state reload: property row not found"
        : "fresh suppression state reload: contact row not found",
    };
  }
  const decision = evaluateAutomatedSuppression({
    outreachDispo: propertyResult.data?.outreach_dispo ?? null,
    consentState,
    doNotContact: contactResult.data?.do_not_contact ?? null,
    smsOptedOut: contactResult.data?.sms_opted_out ?? null,
  });
  return { ok: true, decision: decision.suppressed ? decision : null };
}

/**
 * Read the `origin` a queued row was created with (stamped by
 * `queueForLater` under `metadata.sendOrigin`). Rows queued before this
 * field existed, or with a malformed value, resolve to `'automated'` —
 * the fail-safe direction, since it's the stricter check.
 */
function resolveQueuedSendOrigin(metadata: Json | null): "automated" | "manual" {
  const record = readMetadataRecord(metadata);
  return record?.sendOrigin === "manual" ? "manual" : "automated";
}

type ResolvedProvider = NonNullable<ReturnType<typeof getMessagingProvider>>;

type ResolveFromArgs = {
  provider: ResolvedProvider;
  orgId: string;
  contactId: string;
  propertyId: string;
  toAddress: string;
  explicitFrom?: string | null;
  campaignId?: string | null;
  requireStickyFrom: boolean;
  allowDefaultFromWhenNoSticky: boolean;
};

type ResolveFromResult =
  | { ok: true; fromAddress: string | null }
  | { ok: false; outcome: SendSmsOutcome };

async function resolveOutboundFromAddress(
  supabase: SupabaseClient<Database>,
  args: ResolveFromArgs,
): Promise<ResolveFromResult> {
  try {
    // Sender resolution may query provider-backed inventory or campaign
    // snapshots.  Apply the same tenant fence before those reads.
    assertSendilloOrganizationScope(args.orgId, args.provider.providerId);
  } catch (e) {
    return {
      ok: false,
      outcome: {
        status: "db_error",
        error: e instanceof Error ? e.message : String(e),
      },
    };
  }
  const supportsInventory = providerSupportsSenderInventory(args.provider);
  let fromAddress: string | null = null;
  let fromSource: "explicit" | "sticky" | "campaign" | "default" | null = null;

  if (args.explicitFrom && args.explicitFrom.trim()) {
    fromAddress = normalizePhone(args.explicitFrom) ?? args.explicitFrom.trim();
    fromSource = "explicit";
  } else {
    try {
      fromAddress = await loadLatestInboundBusinessNumber(supabase, {
        contactId: args.contactId,
        propertyId: args.propertyId,
        toAddress: args.toAddress,
      });
      if (fromAddress) fromSource = "sticky";
    } catch (e) {
      return {
        ok: false,
        outcome: {
          status: "db_error",
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }

    if (!fromAddress && args.campaignId) {
      try {
        const delivery = await loadCampaignDeliverySettings(
          supabase,
          args.campaignId,
        );
        fromAddress = delivery.fromAddress ?? delivery.senderNumber;
        if (fromAddress) fromSource = "campaign";
      } catch (e) {
        return {
          ok: false,
          outcome: {
            status: "db_error",
            error: e instanceof Error ? e.message : String(e),
          },
        };
      }
    }

    if (
      !fromAddress &&
      (args.allowDefaultFromWhenNoSticky ||
        !args.requireStickyFrom ||
        !supportsInventory)
    ) {
      const fallback = args.provider.getDefaultFromNumber?.() ?? null;
      fromAddress = fallback ? normalizePhone(fallback) ?? fallback : null;
      if (fromAddress) fromSource = "default";
    }
  }

  if (supportsInventory) {
    if (!fromAddress) {
      if (args.allowDefaultFromWhenNoSticky) {
        return {
          ok: false,
          outcome: {
            status: "blocked_no_approved_sender",
            reason: "no approved sender for first-touch sequence send",
          },
        };
      }
      return {
        ok: false,
        outcome: {
          status: "db_error",
          error:
            "No sticky sending number found for this SMS. Reply from the business number the contact last texted, choose an approved sender, or configure campaign Delivery.",
        },
      };
    }

    let inventory: SenderInventoryState;
    try {
      inventory = await getSenderInventoryState(
        supabase,
        args.orgId,
        args.provider.providerId,
        fromAddress,
      );
    } catch (e) {
      return {
        ok: false,
        outcome: {
          status: "db_error",
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
    if (inventory.state !== "approved") {
      const detail =
        inventory.state === "empty"
          ? "no approved sender inventory has been synced"
          : inventory.state === "inactive"
            ? "the sender is no longer active"
            : "the sender is not in the approved sender inventory";
      if (args.allowDefaultFromWhenNoSticky && fromSource === "default") {
        return {
          ok: false,
          outcome: {
            status: "blocked_no_approved_sender",
            reason: "no approved sender for first-touch sequence send",
          },
        };
      }
      return {
        ok: false,
        outcome: {
          status: "db_error",
          error: `Cannot send from ${fromAddress}: ${detail} for provider ${args.provider.providerId}.`,
        },
      };
    }
  }

  return { ok: true, fromAddress };
}

async function loadLatestInboundBusinessNumber(
  supabase: SupabaseClient<Database>,
  args: {
    contactId: string;
    propertyId: string;
    toAddress: string;
  },
): Promise<string | null> {
  const normalizedTo = normalizePhone(args.toAddress) ?? args.toAddress;
  let query = supabase
    .from("messages")
    .select("to_address")
    .eq("channel", "sms")
    .eq("direction", "inbound")
    .eq("contact_id", args.contactId)
    .eq("property_id", args.propertyId)
    .not("to_address", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (normalizedTo) {
    query = query.eq("from_address", normalizedTo);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`latest inbound sender lookup failed: ${error.message}`);
  }
  const raw = data?.[0]?.to_address ?? null;
  return raw ? normalizePhone(raw) ?? raw : null;
}

/**
 * Terminal-fail a queued message (status-guarded so a row another
 * worker claimed or sent is never touched). Exported for the
 * sequence-tick cron, which fails opted-out rows instead of leaving
 * them eternally queued.
 */
export async function failQueuedMessage(
  supabase: SupabaseClient<Database>,
  messageId: string,
  errorMessage: string,
): Promise<void> {
  await supabase
    .from("messages")
    .update({
      status: "failed",
      failed_at: new Date().toISOString(),
      error_message: errorMessage,
    })
    .eq("id", messageId)
    .eq("status", "queued");
}

async function deferQueuedMessage(
  supabase: SupabaseClient<Database>,
  messageId: string,
  errorMessage: string,
  metadata: Json | null,
): Promise<Extract<SendSmsOutcome, { status: "provider_deferred" | "db_error" }>> {
  const retryAt = new Date(Date.now() + PROVIDER_TRANSIENT_DEFER_MS).toISOString();
  const currentMetadata = readMetadataRecord(metadata) ?? {};
  const { error } = await supabase
    .from("messages")
    .update({
      status: "queued",
      scheduled_for: retryAt,
      error_message: errorMessage,
      metadata: {
        ...currentMetadata,
        senderGuard: {
          deferredAt: new Date().toISOString(),
          reason: errorMessage,
          nextRetryAt: retryAt,
        },
      } as Json,
    })
    .eq("id", messageId)
    .eq("status", "queued");
  if (error) return { status: "db_error", error: error.message };
  return {
    status: "provider_deferred",
    messageId,
    error: errorMessage,
    attempt: 0,
    retryAt,
  };
}
