import { randomUUID } from "node:crypto";
import { after } from "next/server";

import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import {
  enrollNurtureInDrip,
  loadNurtureAutoDripConfig,
  type NurtureAutoDripConfig,
} from "./nurture-auto-drip";
import { routeNurture, type NurtureRoute } from "./nurture-routes";
import { ensureConversationIdForThread } from "@/lib/messages/threading";
import { isSmsPhoneSuppressed } from "@/lib/messaging/opt-out-phone";
import { getConsentStateStrict } from "@/lib/messaging/consent";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import {
  checkFloridaCap,
  checkRecipientQuietHours,
} from "@/lib/messaging/quiet-hours-recipient";
import { sendSmsToContact } from "@/lib/messaging/send";
import { WEBHOOK_PROCESSING_LEASE_MS } from "@/lib/messaging/webhook-lease";
import { testBarrier, testFault } from "@/lib/testing/test-barriers";
import { TEST_SEND_REFUSED } from "@/lib/messaging/send-allowlist";
import { normalizePhone } from "@/lib/csv/normalize";
import { selectBestSmsPhone, selectSmsPhoneByNumber } from "@/lib/messaging/sms-phone";
import { isSuppressed, shouldSuppressAutomatedSend } from "@/lib/messaging/suppression";
import { pausePropertyEnrollments } from "@/lib/sequences/enrollment";
import { recordPausedEnrollmentsForUndo } from "./undo";
import type { Database, Json } from "@/lib/supabase/types";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { assignHotLeadToOwner, recordHotFailure, recordHotTextOnHeldLead } from "@/lib/hot-sellers/assign";
import { HOT_KEYWORD_TIER, isHotReason, isHotSeller } from "@/lib/hot-sellers/hot";

/** Hold reason: the rendered nine-question reply differs from the approved text; nothing was sent. */
export const NINE_REPLY_TEXT_NOT_APPROVED = "reply_text_not_approved";
/** Hold reason when a hot seller could not be handed to Jarrad (hot: still alerts). */
const HOT_LEAD_ASSIGN_FAILED_REASON = "hot_lead_assign_failed";
/** Hold reason when the lead is on My Leads under Jarrad but its 'assigned' event did not save (hot). */
const HOT_LEAD_EVENT_FAILED_REASON = "hot_lead_event_failed";
/** A hot text on a lead someone else owns whose alert event could not be saved (the lead was NOT moved to Jarrad). */
const HOT_ALERT_EVENT_FAILED_REASON = "hot_alert_event_failed";

import {
  recordStep,
  resumeRun,
  updateRun,
  type MaybeRunContext,
  type PipelineRunContext,
  type RecordStepInput,
} from "@/lib/pipeline-runs";
import { listAdminUserIds } from "@/lib/auth/admins";
import { createNotification } from "@/lib/notifications/dispatch";
import {
  classifyForDispatch,
  type ClassificationBridgeResult,
} from "@/lib/sms-classification/dispatch-bridge";
import type { JevEscalationReason } from "@/lib/sms-classification/types";
import { jevOutcomeForLunaHold } from "@/lib/sms-classification/luna/hold";
import { lunaSuggestionsEnabled } from "@/lib/sms-classification/luna/config";
import { requestLunaSuggestion } from "@/lib/sms-classification/luna/suggest";

import {
  claimAiResponse,
  completeAiResponseClaim,
  expireAiResponseClaimLease,
  loadClaimTemplateSent,
  recordClaimTemplateSent,
} from "./claims";
import {
  GATE_EVIDENCE_STATUSES,
  classifyGateRow,
  classifyNewerInboundHandler,
  decideDraftGate,
  decideSendGate,
  type GateOutboundFact,
  type NewerInboundFact,
  type SendGateDecision,
  type SendGatePhase,
  SILENT_HANDLED_RULES,
  type SilentHandledRule,
  silentExitReason,
  silentSkipClaimOutcome,
} from "./send-gate";
import {
  REPLY_RETRY_DELAY_SECONDS,
  REPLY_RETRY_MAX,
  writeReplyDeadLetter,
  type AiRetryOutcome,
  type NineDeferral,
  type RetryReason,
  type RetryReply,
} from "./retry";
import { retryOutstandingSuppressionObligations } from "./confirm-suppression";
import { classifyAiSkip } from "./classify";
import {
  classifyProviderFailure,
  generateAiReply,
  type AnthropicLike,
} from "./generate";
import { humanizeReply } from "./humanize";
import { IDENTITY_REPLY_BODY, isIdentityQuestion } from "./identity";
import { APPROVED_REPLY_TEXTS } from "./approved-reply-texts";
import {
  enrollNineDrip,
  CLASSIFIER_ENGINE_UNREADABLE,
  readClassifierEngine,
  runNineClassification,
  type NineDripResult,
} from "./nine-questions-engine";
import {
  actionForNineAnswer,
  NINE_HOT_REPLY_TEXTS,
  NINE_REPEAT_NOT_INTERESTED_RULE,
  type NineHotReply,
  type NineQuestionResult,
} from "@/lib/sms-classification/nine-questions";
import { loadOrgThresholdMap } from "@/lib/sms-classification/thresholds";
import { hasAllowedPriceSignal, hasNonPriceEscalationPhrase, matchEscalationKeyword, nonPriceTier, priceSignalAllowed } from "./keywords";
import {
  NUMBER_SOURCE_ANSWER_RECEIVED_REASON,
  NUMBER_SOURCE_AWAITING_ANSWER_REASON,
  NUMBER_SOURCE_NOT_SENT_PREFIX,
} from "./number-source";
import { resolveResponderOutcome, type ResponderRoute } from "./route";
import { validateAiReplyBody } from "./safety";
import { HOSTILE_NEEDS_CONFIRM_REASON, isHostileInbound } from "./hostile";
import { buildTwoWayThreadState } from "@/lib/sms-classification/context";
import { classifyV2, JevAttemptsError, v2ProviderDeps, type V2Classification } from "@/lib/sms-classification/routing-v2/classify";
import type { JevAttemptOutcome } from "@/lib/sms-classification/providers/jev-gateway";
import { isV2Eligible, readRoutingV2Flags, readRoutingV2FlagsResult, v2SliceAllowed, type RoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";
import { executeV2Stop } from "@/lib/sms-classification/routing-v2/model-stop-suppression";
import {
  runRoutingV2PhoneAction,
  settleUnsettledRoutingV2PhoneReplies,
  type SendWrongNumberReply,
} from "@/lib/sms-classification/routing-v2/wrong-number-all";
import { classifyWrongNumberScope } from "@/lib/messaging/wrong-number-scope";
import { liveDecisionRow, recordLiveV2Decision, recordLiveV2DecisionRow } from "@/lib/sms-classification/routing-v2/live-decisions";
import type { V2Action, V2Step } from "@/lib/sms-classification/routing-v2/actions";
import {
  DEALMACHINE_NO_KEY,
  MODEL_STOP_NO_PHONE,
  recordRoutingV2Audit,
  recordV2ModelSpend,
  V2_LIVE_JEV_POLICY,
  V2_OUTBOX_REASON,
  liveHoldReason,
  liveStepFor,
  V2_JEV_FAILED,
  queueLiveHoldAlerts,
  readLiveV2Evidence,
  storedFinalDecision,
  storedV2Decision,
  type StoredLiveEvidence,
} from "@/lib/sms-classification/routing-v2/live-dispatch";
import { applyStoredV2Transition } from "@/lib/sms-classification/routing-v2/live-transition";
import { deliverV2Outbox, type V2OutboxIntent, type V2OutboxResult } from "@/lib/sms-classification/routing-v2/outbox";
import { resolveV2Reply } from "@/lib/sms-classification/routing-v2/reply-template";
import type { V2AnyReplyKey } from "@/lib/sms-classification/routing-v2/reply-texts";
import {
  lookupDealMachineValue,
  supabaseDealMachineCacheStore,
  type ValueLookupResult,
} from "@/lib/sms-classification/routing-v2/dealmachine-value";
import { fetchDealMachineEstimatedValue } from "@/lib/comps/providers/dealmachine";
import { SOLD_NEEDS_HUMAN_REASON, isSoldInbound } from "./sold";
import {
  hasSendableNumberSourceTemplate,
  NUMBER_SOURCE_REPLY_KEY,
  resolveApprovedTemplateReply,
  type TemplateReplyKey,
} from "./template-reply";
import { getOutboundSenderName } from "@/lib/messaging/sender-persona";
import type {
  AiMessageMetadata,
  AiStructuredOutput,
  AiWrongScope,
} from "./types";

/**
 * Side-channel facts about a returned outcome that must not change its shape
 * (callers and tests compare outcomes structurally): which Q8 rule ended a run
 * silently, and whether the run flagged the property. Read only by
 * `claimOutcomeOf` when the claim is completed.
 */
const outcomeMeta = new WeakMap<
  object,
  { silentRule?: SilentHandledRule; flagged?: boolean; flagFailed?: boolean }
>();

/** A `skipped` outcome that ended silently under Q8 rule 0, 2, 4, 5 or 8. */
function silentSkip(
  reason: string,
  rule: SilentHandledRule,
): { outcome: "skipped"; reason: string } {
  const outcome = { outcome: "skipped" as const, reason };
  outcomeMeta.set(outcome, { silentRule: rule });
  return outcome;
}

/** A `skipped` outcome that flagged the property for a human (rules 1 and 3). */
function flaggedSkip(reason: string): { outcome: "skipped"; reason: string } {
  const outcome = { outcome: "skipped" as const, reason };
  outcomeMeta.set(outcome, { flagged: true });
  return outcome;
}

/** The silent Q8 rule (0/2/4/5/8) a non-flagging skip decision ended under, else null. */
function silentRuleOf(decision: SendGateDecision): SilentHandledRule | null {
  if (decision.action !== "skip" || decision.flag) return null;
  return (SILENT_HANDLED_RULES as readonly number[]).includes(decision.rule)
    ? (decision.rule as SilentHandledRule)
    : null;
}

/**
 * Persist an early / claim-less silent exit on the INBOUND row
 * (`processing.aiResponder.outcome = skipped:rule_<n>`) so a later run's rule 1
 * reads it as handled when no claim exists. The write is confirmed (error and
 * matched-row checked); a failure is reported and returns false (the exit
 * stays unstamped, which a later run treats as unhandled: flagged, never lost).
 */
export async function stampSilentExit(
  supabase: SupabaseClient<Database>,
  inboundMessageId: string,
  rule: SilentHandledRule,
  reason: string,
): Promise<boolean> {
  try {
    const { data: row, error: readError } = await supabase
      .from("messages")
      .select("metadata")
      .eq("id", inboundMessageId)
      .maybeSingle();
    if (readError || !row) throw new Error(readError?.message ?? "inbound row not found");
    const metadata = readJsonObject((row.metadata ?? null) as Json | null);
    const processing = readJsonObject((metadata.processing ?? null) as Json | null);
    const next = {
      ...metadata,
      processing: {
        ...processing,
        aiResponder: {
          outcome: silentSkipClaimOutcome(rule),
          reason,
          completedAt: new Date().toISOString(),
        },
      },
    } as Json;
    const { data: updated, error } = await supabase
      .from("messages")
      .update({ metadata: next })
      .eq("id", inboundMessageId)
      .select("id")
      .maybeSingle();
    if (error || !updated) throw new Error(error?.message ?? "inbound stamp matched no row");
    return true;
  } catch (e) {
    reportError(e, {
      tags: { surface: "ai_responder_silent_exit_stamp" },
      extra: { inboundMessageId, rule },
    });
    return false;
  }
}

/** The stamp / claim outcome string for a returned outcome (see `claimOutcomeOf`). */
export function inboundStampOutcomeOf(outcome: { outcome: string }): string {
  return claimOutcomeOf(outcome);
}

/** Tags an outcome whose own flag write could not be proven (claim reads `flag_failed`). */
function markFlagFailed(outcome: object): void {
  outcomeMeta.set(outcome, { ...(outcomeMeta.get(outcome) ?? {}), flagFailed: true });
}

function flagFailedOf(outcome: object): boolean {
  return outcomeMeta.get(outcome)?.flagFailed === true;
}

/**
 * What the claim records for an outcome: a silent end under rule 0/2/4/5/8 is
 * `skipped:rule_<n>` (counts as handled for rule 1 on a newer inbound); a skip
 * that flagged the property is `escalated`; a bare `skipped` is not handled.
 */
function claimOutcomeOf(outcome: { outcome: string }): string {
  if (outcome.outcome !== "skipped") return outcome.outcome;
  const meta = outcomeMeta.get(outcome);
  if (meta?.silentRule !== undefined) return silentSkipClaimOutcome(meta.silentRule);
  if (meta?.flagged) return "escalated";
  return "skipped";
}

/**
 * `completeAiResponseClaim`, refusing to record an unproven flag as handled.
 * The proof is carried PER CALL: `flagOk` is the boolean the run's own
 * `markPropertyNeedsAttention` returned. `flagOk: false` on an `escalated`
 * completion downgrades it to an `error` claim (`flag_failed`, not handled).
 * There is no shared per-client or per-property state, so a concurrent run on
 * the same property cannot read another run's flag result.
 */
function completeClaim(
  _supabase: SupabaseClient<Database>,
  _propertyId: string,
  args: Parameters<typeof completeAiResponseClaim>[1] & { flagOk?: boolean },
): Promise<boolean> {
  const { flagOk, ...rest } = args;
  if (rest.outcome === "escalated" && !rest.errorMessage && flagOk === false) {
    return completeAiResponseClaim(_supabase, { ...rest, errorMessage: "flag_failed" });
  }
  return completeAiResponseClaim(_supabase, rest);
}

/**
 * Consider an inbound SMS for an AI first-touch reply. This is the
 * DB-touching orchestrator called from the Dialpad webhook AFTER
 * auto-qualify, notifications, and sequence-pause have run.
 *
 * Escalation / skip paths — none of these send an SMS; the property
 * gets `needs_human_attention=true` when a human response is actually
 * needed (keyword match, model escalation, safety-validator reject,
 * generate failure). Non-attention skips (opt_out, disabled,
 * max-turns-reached, outside-business-hours) just return silently.
 *
 * Deps-injected Anthropic client so integration tests stub the LLM
 * call without hitting the real API.
 */

export type AiDispatchOutcome =
  | { outcome: "sent"; messageId: string; confidence: number }
  | { outcome: "escalated"; reason: string }
  | { outcome: "auto_closed"; reason: string }
  | { outcome: "opted_out"; reason: string }
  | { outcome: "skipped"; reason: string };

export type AiDispatchInput = {
  propertyId: string;
  contactId: string;
  conversationId?: string | null;
  inboundFromPhone?: string | null;
  inboundToPhone?: string | null;
  inboundBody: string;
  inboundMessageId?: string | null;
  /** Messages v2 evidence run for this inbound; observation only. */
  runId?: string | null;
  /** 0/undefined = first dispatch; N = the Nth re-dispatch (see ./retry). */
  retryAttempt?: number;
  /**
   * The reply the previous attempt generated, carried by the retry outcome.
   * When present on a retry the dispatch neither re-classifies (no second Jev
   * call) nor re-generates: it re-sends exactly this text. Never log it.
   */
  retryReply?: RetryReply;
  /**
   * Set by the webhook's inline fallback when the delay workflow could not be
   * started: this dispatch is running without the randomized reply delay, so
   * an approved-template reply is dropped (the outcome still applies).
   */
  replyDelayBypassed?: boolean;
  /** Why: `delay_not_applied` = the delay clamped to 0 with a delay configured; `delay_not_configured` = the org has no reply delay (max 0), so templates never send; default `delay_unavailable`. */
  replyDelayBypassReason?: "delay_unavailable" | "delay_not_applied" | "delay_not_configured";
  /** A nine-question reply deferred until the send window opened (see ./retry NineDeferral). */
  nineDeferral?: NineDeferral;
  /** A deferred run re-deciding from scratch: how many deferrals came before (loop bound only). */
  nineDeferCount?: number;
  /**
   * Routing v2 backfill (scripts/routing-v2-backfill.ts) re-dispatching an OLD unanswered seller
   * text through this same entry. Absent on every live path (webhook / delay workflow), so live
   * behaviour is unchanged. See docs/routing-v2-backfill.md.
   */
  routingV2Backfill?: RoutingV2BackfillContext;
};

/** Backfill modes that reach the dispatch (dry-run never dispatches). */
export type RoutingV2BackfillContext = {
  runId: string;
  /**
   * apply = the full live treatment (replies <= --text-max-age-days old). sort_only = older
   * replies: decided and sorted (stops, holds, closes, hot alerts into Jarrad's queue) but NO
   * auto reply and NO drip (Jarrad 2026-10-31).
   */
  mode: "classify_only" | "apply" | "sort_only";
  /**
   * Apply / sort-only: the decision row an earlier classify-only run built for this inbound
   * (never written to routing_v2_live_decisions by classify-only). It is recorded now exactly
   * as a live decision would be (a safety decision through the atomic recorder) and carried
   * out, with no second model call.
   */
  storedDecisionRow?: Record<string, unknown>;
  /**
   * Classify-only: receives the decision row instead of the database. Classify-only writes no
   * decision row, hold, pause, cancel, alert, obligation, reply or drip (Opus review B1).
   */
  onClassified?: (row: Record<string, unknown>) => Promise<void>;
  /**
   * Apply / sort-only resume: an interrupted backfill apply already recorded this text's decision
   * (routing_v2_live_decisions); carry out that row instead of classifying again.
   */
  resumeRecordedDecision?: boolean;
};

/** A backfill text the v2 engine did not take (flags / canary / engine off, or unreadable): skipped, never the legacy engine. */
export const ROUTING_V2_BACKFILL_V2_NOT_LIVE = "routing_v2:backfill_v2_not_live";
/** Classify-only: the text would take the up-front keyword hold (a side effect): skipped, reported as keyword_hold. */
export const ROUTING_V2_BACKFILL_CLASSIFY_KEYWORD_HOLD = "routing_v2:backfill_classify_only_keyword_hold";
/** Apply / sort-only: a newer seller text exists on the property, so this older one is not acted on. */
export const ROUTING_V2_BACKFILL_NEWER_INBOUND = "routing_v2:backfill_newer_inbound";
/** Classify-only could not decide without a side effect (a hold, a recorder failure): skipped. */
export const ROUTING_V2_BACKFILL_CLASSIFY_UNAVAILABLE = "routing_v2:backfill_classify_only_unavailable";

/** Claim / outcome reason of a classify-only backfill dispatch: decision recorded, nothing carried out. */
export const ROUTING_V2_BACKFILL_CLASSIFY_ONLY = "routing_v2:backfill_classify_only";

/**
 * Roads whose approved seller text only makes sense right after the seller's message, so an OLD
 * reply must not get it. In backfill apply these hold for a person (existing reason, existing
 * hold alert copy) instead of sending. No text is invented or reworded for the backlog.
 * - driving_reply+book_appointment: "Okay, thank you for letting me know. I'll reach out to you
 *   later." answers "I'm driving"; days later it is wrong.
 */
export const ROUTING_V2_BACKFILL_HOLD_ROADS: ReadonlySet<string> = new Set(["driving_reply+book_appointment"]);

/** Hot roads: in sort-only their owner alerts are raised and the lead goes to Jarrad's queue. */
const ROUTING_V2_SORT_ONLY_HOT_ROADS: ReadonlySet<string> = new Set([
  "book_appointment", "reaction+book_appointment", "driving_reply+book_appointment", "price_check", "ALERT_call_me",
]);

export type RoutingV2SortOnlyKind =
  /** Same as live: Jev failed / stop / bad number / any hold road (nothing is ever sent on these). */
  | "live_failed" | "live_stop" | "live_bad_number" | "live_hold"
  /** Close this property, no reply: existing AI disposition writer (this property only). */
  | "close_wrong_number" | "close_not_interested"
  /** Hot or alert road: its stored owner alerts + a needs-person hold (no reply, no drip). */
  | "alert_and_hold"
  /** Every other road: decision recorded, nothing carried out. */
  | "record_only";

/** What sort-only does with a stored decision (pure; the report uses the same function). */
export function routingV2SortOnlyKind(e: Pick<StoredLiveEvidence, "status" | "action" | "failure_reason">): RoutingV2SortOnlyKind {
  const step = liveStepFor(e as StoredLiveEvidence);
  if (step.kind === "failed") return "live_failed";
  if (step.kind === "stop") return "live_stop";
  if (step.kind === "bad_number") return "live_bad_number";
  if (step.kind === "wrong_number") return "close_wrong_number";
  if (step.kind === "hold") return "live_hold";
  const road = e.action?.road ?? "";
  if (road === "not_interested_drip") return "close_not_interested";
  if (ROUTING_V2_SORT_ONLY_HOT_ROADS.has(road) || (e.action?.steps ?? []).some((s) => s.kind === "alert")) return "alert_and_hold";
  return "record_only";
}

export type AiDispatchOptions = {
  checkSuperseded?: boolean;
  /** Already-resolved run context (skips the runId lookup). */
  runContext?: PipelineRunContext | null;
};

/** Best-effort evidence step against the given run (no-op when null). Never throws. */
async function trace(
  supabase: SupabaseClient<Database>,
  step: RecordStepInput,
  ctx?: MaybeRunContext,
): Promise<void> {
  await recordStep(supabase, ctx ?? null, step);
}

const AI_REPLY_THREAD_DEBOUNCE_MS = 45_000;
const DEESCALATION_TEMPLATE_WITH_NAME =
  "So sorry to bug you. Sounds like you get a lot of these. Are you {first_name}? Just want to make sure we don't bother you again.";
const DEESCALATION_TEMPLATE_GENERIC =
  "So sorry to bug you. Sounds like you get a lot of these. Are you the owner here? Want to make sure we don't bother you again.";

type ResponderDispoResult =
  | { updated: true }
  | {
      updated: false;
      reason:
        | "already_terminal"
        | "db_error"
        | "replayed_other_disposition"
        // Root review of 8361775a, jev-root-revision-review.md, 2026-09-20:
        // properties.decision_context_revision moved between the evaluation
        // read and this write — the RPC refused to apply a possibly-stale
        // model result.
        | "stale_context";
    };

type AiReviewDisposition =
  "wrong_number" | "not_interested" | "opted_out" | "dnc";

type AiDispatchPropertyGateRow = Pick<
  Database["public"]["Tables"]["properties"]["Row"],
  | "ai_responder_disabled"
  | "homeowner_contact_id"
  | "id"
  | "last_ai_escalation_reason"
  | "needs_human_attention"
  | "org_id"
  | "outreach_dispo"
  | "state"
>;

export type AiDispatchPreGateResult =
  | { ok: true; property: AiDispatchPropertyGateRow; routingV2Live?: boolean }
  | { ok: false; outcome: AiDispatchOutcome };

/**
 * Stress F8/F9 at b6a00a0a2f17 (round 17): a keyword / legal / possible-stop hold that could not be
 * written fails closed. The lead's v2 drips are paused, its pending v2 auto replies cancelled, and
 * (v2 live) an unrecovered safety marker is stored for the inbound (a failed decision row with no
 * effects): the apply gate blocks the lead's newer texts and the sweep re-attempts the hold.
 */
async function keywordHoldFailClosed(
  supabase: SupabaseClient<Database>,
  a: { propertyId: string; inboundMessageId?: string | null; orgId?: string | null; reason: string },
): Promise<void> {
  try {
    await keywordHoldFailClosedInner(supabase, a);
  } catch (e) {
    reportError(e, { tags: { surface: "ai_responder_keyword_hold" }, extra: { propertyId: a.propertyId } });
  }
}

async function keywordHoldFailClosedInner(
  supabase: SupabaseClient<Database>,
  a: { propertyId: string; inboundMessageId?: string | null; orgId?: string | null; reason: string },
): Promise<void> {
  reportError(new Error("keyword hold could not be written; failing closed"), {
    tags: { surface: "ai_responder_keyword_hold" }, extra: { propertyId: a.propertyId, reason: a.reason },
  });
  await pauseV2DripsFailClosed(supabase, a.propertyId);
  const loose = supabase as unknown as {
    from: (t: string) => {
      update: (v: Record<string, unknown>) => { eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => PromiseLike<{ error: { message: string } | null }> } } };
      insert: (r: Record<string, unknown>) => PromiseLike<{ error: { code?: string; message: string } | null }>;
    };
  };
  const cancel = await loose.from("routing_v2_outbox").update({ status: "cancelled", cancel_reason: "held_for_person" })
    .eq("property_id", a.propertyId).eq("kind", "reply").eq("status", "pending");
  if (cancel.error) reportError(new Error(cancel.error.message), { tags: { surface: "ai_responder_keyword_hold" }, extra: { propertyId: a.propertyId } });
  if (!a.orgId || !a.inboundMessageId) return;
  if ((await routingV2LiveForSweep(supabase, a.orgId, a.propertyId)) === "no") return;
  const marker = await loose.from("routing_v2_live_decisions").insert({
    org_id: a.orgId, property_id: a.propertyId, inbound_message_id: a.inboundMessageId,
    status: "failed", failure_reason: `keyword_hold_failed:${a.reason}`.slice(0, 200), expected_revision: 0,
  });
  if (marker.error && marker.error.code !== "23505") {
    reportError(new Error(marker.error.message), { tags: { surface: "ai_responder_keyword_hold" }, extra: { propertyId: a.propertyId } });
  }
}

export async function applyKeywordEscalation(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    inboundBody: string;
    escalationKeywords?: ReadonlyArray<string> | null;
    runContext?: MaybeRunContext;
    /**
     * Jev automatic: a price signal never writes a HOT hold up front (before
     * consent checks and classification). A price-only text writes nothing
     * here (the shared hot decision handles it after the gates); a mixed text
     * keeps a person-review hold under its NON-price reason, which can only be
     * alerted by the later classify-only check if stop / DNC / wrong / bad
     * number does not win.
     */
    jevAutomatic?: boolean;
    /** The inbound and its org (round 17): a hold that cannot be written fails closed for it. */
    inboundMessageId?: string | null;
    orgId?: string | null;
  },
): Promise<{ escalated: true; reason: string; flagOk: boolean } | { escalated: false }> {
  const keywordMatch = matchEscalationKeyword(args.inboundBody, {
    allowedPhrases: args.escalationKeywords ?? undefined,
  });
  if (args.jevAutomatic && keywordMatch && hasAllowedPriceSignal(args.inboundBody, args.escalationKeywords ?? null)) {
    const otherTier = nonPriceTier(args.inboundBody, args.escalationKeywords ?? null);
    if (!otherTier) {
      await trace(supabase, {
        kind: "gate",
        name: "escalation_keyword",
        result: "pass",
        detail: { tier: HOT_KEYWORD_TIER, deferred: "shared_hot_decision" },
      }, args.runContext);
      return { escalated: false };
    }
    const mixedReason = `keyword:${otherTier}`;
    await trace(supabase, {
      kind: "gate",
      name: "escalation_keyword",
      result: "block",
      detail: { tier: otherTier, alsoPrice: true },
    }, args.runContext);
    const mixedOk = await markPropertyNeedsAttention(supabase, args.propertyId, mixedReason, args.runContext);
    if (!mixedOk) await keywordHoldFailClosed(supabase, { ...args, reason: mixedReason });
    return { escalated: true, reason: mixedReason, flagOk: mixedOk };
  }
  if (!keywordMatch) {
    await trace(
      supabase,
      { kind: "gate", name: "escalation_keyword", result: "pass" },
      args.runContext,
    );
    return { escalated: false };
  }

  // A numeric amount the org's allow-list does not cover is still held (as on
  // main) but under a non-hot reason: it never drives a hot alert.
  const unlistedNumeric =
    keywordMatch.tier === "price_offer" && !priceSignalAllowed(keywordMatch, args.escalationKeywords ?? null);
  const reason = unlistedNumeric ? "keyword:numeric_amount" : `keyword:${keywordMatch.tier}`;
  await trace(
    supabase,
    {
      kind: "gate",
      name: "escalation_keyword",
      result: "block",
      detail: { tier: keywordMatch.tier },
    },
    args.runContext,
  );
  const flagOk = await markPropertyNeedsAttention(
    supabase,
    args.propertyId,
    reason,
    args.runContext,
  );
  if (!flagOk) await keywordHoldFailClosed(supabase, { ...args, reason });
  return { escalated: true, reason, flagOk };
}

export async function checkAiResponderDispatchPreGates(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  options: AiDispatchOptions = {},
): Promise<AiDispatchPreGateResult> {
  const runCtx = options.runContext ?? null;
  const blocked = async (
    reason: string,
  ): Promise<void> =>
    trace(
      supabase,
      { kind: "gate", name: reason, result: "block", detail: { reason } },
      runCtx,
    );
  const { data: property } = await supabase
    .from("properties")
    .select(
      "id, org_id, state, ai_responder_disabled, outreach_dispo, needs_human_attention, homeowner_contact_id, last_ai_escalation_reason, is_dnc_locked",
    )
    .eq("id", input.propertyId)
    .maybeSingle();
  if (!property) {
    await blocked("property_not_found");
    return {
      ok: false,
      outcome: { outcome: "skipped", reason: "property_not_found" },
    };
  }
  if (property.needs_human_attention && !input.routingV2Backfill && (await isAnswerToNumberSourceReply(supabase, input))) {
    // The seller is answering "want me to take you off the list?". The property
    // is already held, but the answer must not vanish into a silent
    // already-terminal exit: refresh the hold so a person sees there is a new
    // message. When the hold is our own awaiting marker its reason becomes
    // `number_source_answer_received`; when the property was already held for
    // another reason that reason is kept (a person still needs it) and only the
    // hold's timestamp moves. Nothing is sent and nothing is suppressed.
    const now = new Date().toISOString();
    const own = property.last_ai_escalation_reason === NUMBER_SOURCE_AWAITING_ANSWER_REASON;
    // A HOT flag keeps its own time: its alert key (hot_flag:<property>:<flagAt>)
    // must not move, or a non-hot answer would page Jarrad again.
    const keepFlagTime = isHotReason(property.last_ai_escalation_reason);
    let q = supabase
      .from("properties")
      .update({
        ...(own ? { last_ai_escalation_reason: NUMBER_SOURCE_ANSWER_RECEIVED_REASON } : {}),
        ...(keepFlagTime ? {} : { last_ai_escalation_at: now }),
        updated_at: now,
      })
      .eq("id", input.propertyId)
      .eq("needs_human_attention", true);
    if (own) q = q.eq("last_ai_escalation_reason", NUMBER_SOURCE_AWAITING_ANSWER_REASON);
    const { data: refreshed } = await q.select("id").maybeSingle();
    await blocked(NUMBER_SOURCE_ANSWER_RECEIVED_REASON);
    if (refreshed) {
      return { ok: false, outcome: flaggedSkip(NUMBER_SOURCE_ANSWER_RECEIVED_REASON) };
    }
  }
  // Opus review of 93a8070932bd (B1): "is routing v2 live for this property" is decided ONCE, with
  // the strict read, before the terminal gate. That single answer picks v2 vs legacy below and
  // decides whether an older mechanics hold yields; a read error is "not live", so the hold stays.
  const v2LiveState = input.inboundMessageId
    ? (testFault("dispatch:v2_live_read", { propertyId: input.propertyId, inboundMessageId: input.inboundMessageId })
        ? "error"
        : await routingV2LiveForSweep(supabase, property.org_id, input.propertyId))
    : "no";
  const routingV2Live = v2LiveState === "yes";
  // Routing v2 backfill resume (Astra review 2b-3): an interrupted apply whose atomic recorder
  // already wrote THIS text's safety hold must still finish that decision's remaining effects
  // (suppression, alerts). Only when the lead's hold is the one written for this very text.
  const backfillResumeOwnHold = routingV2Live && !!input.routingV2Backfill?.resumeRecordedDecision && property.needs_human_attention
    && (await backfillHoldIsFor(supabase, input.propertyId, input.inboundMessageId ?? null));
  if (isTerminalAiResponderProperty(property) && !backfillResumeOwnHold
      && !(routingV2Live && (await mechanicsHoldYieldsTo(supabase, property, input.inboundMessageId, { v2Live: true })))) {
    // PR 2: a lead that already needs a person, or carries a human-owned
    // disposition (nurture / callback / booked), still gets ONE classify-only
    // look so a new hot text reaches Jarrad (owner rule 2026-10-19: every hot
    // reply alerts him): no reply, no drip, no disposition, no assignment
    // change; non-hot exits exactly as before. True suppression (wrong / bad
    // number, DNC, opted out) is refused inside classifyOnlyForHotText, and
    // DNC-locked leads are never classified.
    // A backfill text whose lead became held / closed after selection is left to the person.
    if (!property.is_dnc_locked && input.inboundMessageId && !input.routingV2Backfill) {
      await classifyOnlyForHotText(supabase, input, property, runCtx);
    }
    await blocked("already_terminal");
    return {
      ok: false,
      outcome: silentSkip("already_terminal", 0),
    };
  }
  await testBarrier("dispatch:after_early_gate", { propertyId: input.propertyId, inboundMessageId: input.inboundMessageId ?? null });

  // Stress review A-2 (latest reply wins): with routing v2 live, a newer seller text (rule 1),
  // an auto reply to another inbound (rule 3) or a drip / campaign text (rule 5) sent since this
  // inbound never parks or drops it here. Every reply is
  // classified and recorded; the v2 transition keeps the newest reply's route (an older one
  // queues only its owner alerts) and the outbox fence refuses a stale auto reply.
  // Routing v2 backfill: v2 not live for this text right now = skipped before any gate can flag it.
  if (input.routingV2Backfill && !routingV2Live) {
    await blocked(ROUTING_V2_BACKFILL_V2_NOT_LIVE);
    return { ok: false, outcome: { outcome: "skipped", reason: ROUTING_V2_BACKFILL_V2_NOT_LIVE } };
  }
  if (input.inboundMessageId) {
    // Q8 decision table at the early gate: rule 0 (suppression / disabled /
    // terminal) and rule 8 first, then rules 1-6, first match wins; the same
    // function the pre-send check uses. A failed lookup never decides here:
    // the pre-send check re-reads under the lease and fails closed.
    const evaluation = await evaluateSendGate(supabase, input, {
      phase: "early",
      claimStartedAt: null,
      checkNewerInbound: options.checkSuperseded === true,
      property,
      ...(routingV2Live ? { mechanicsYield: "decided" as const } : {}),
    });
    if (evaluation.ok) {
      const decision = evaluation.decision;
      // Rule 0 reasons other than a terminal property (consent, org off,
      // disabled property) keep their existing downstream handling (the skip
      // classifier still lets Jev classify): silent, nothing flagged here,
      // and rules 1-6 must not run for a dead lead.
      const passThrough = (decision.action === "skip" && decision.rule === 0 && decision.reason !== "already_terminal")
        || (backfillResumeOwnHold && decision.action === "skip" && decision.rule === 0 && decision.reason === "already_terminal")
        || (routingV2Live && decision.action === "skip" && (decision.rule === 1 || decision.rule === 3 || decision.rule === 5));
      const plan = passThrough ? null : skipPlanFor(decision, "early");
      if (plan) {
        await blocked(plan.trace);
        if (plan.flagReason && input.routingV2Backfill?.mode === "classify_only") {
          // Classify-only never writes a hold: a flagging gate skips the text (counted).
          return { ok: false, outcome: { outcome: "skipped", reason: ROUTING_V2_BACKFILL_CLASSIFY_UNAVAILABLE } };
        }
        if (plan.flagReason) {
          const flagged = await markPropertyNeedsAttention(
            supabase,
            input.propertyId,
            plan.flagReason,
            runCtx,
          );
          // A flag that cannot be proven must not read as "a human was told":
          // fall through so the run proceeds and the pre-send check
          // re-evaluates under the lease and fails closed (rule 7).
          if (flagged) return { ok: false, outcome: flaggedSkip(plan.reason) };
        } else {
          const rule = silentRuleOf(decision);
          return {
            ok: false,
            outcome: rule === null ? { outcome: "skipped", reason: plan.reason } : silentSkip(plan.reason, rule),
          };
        }
      }
    }
  }

  await trace(supabase, { kind: "gate", name: "pre_gates", result: "pass" }, runCtx);
  return routingV2Live ? { ok: true, property, routingV2Live } : { ok: true, property };
}

/**
 * True when this inbound is a seller's answer to our number-source reply: the
 * latest outbound message is that reply (`reply_key`, so this works whatever
 * reason the property is held for) and it was not sent in answer to THIS inbound
 * (a replay of the original question is not an answer). Fails closed (false).
 */
async function isAnswerToNumberSourceReply(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("messages")
    .select("metadata")
    .eq("property_id", input.propertyId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return false;
  const meta = (data.metadata ?? {}) as { reply_key?: unknown; inbound_message_id?: unknown };
  if (meta.reply_key !== NUMBER_SOURCE_REPLY_KEY) return false;
  if (input.inboundMessageId && meta.inbound_message_id === input.inboundMessageId) return false;
  return true;
}

export async function dispatchAiResponse(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  deps: { anthropic: AnthropicLike } & AiDispatchOptions,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  // Evidence only: resolve the run (null when none / lookup fails) and thread
  // it explicitly down every helper. Nothing below branches on it.
  const runContext =
    deps.runContext ?? (input.runId ? await resumeRun(supabase, input.runId) : null);
  const result = await dispatchAiResponseCore(supabase, input, { ...deps, runContext });
  // A silent exit (rule 0 / 2 / 4 / 5 / 8) that may have left no claim records
  // its outcome on the inbound row so a later run's rule 1 reads it as handled.
  if (result.outcome === "skipped" && input.inboundMessageId) {
    const rule = outcomeMeta.get(result)?.silentRule;
    if (rule !== undefined) {
      await stampSilentExit(supabase, input.inboundMessageId, rule, result.reason);
    }
  }
  return result;
}

export const NINE_CLOSE_WRONG_PERSON_CONTEXT_CHANGED = "nine_close_wrong_person_context_changed";

/**
 * The revision a wrong-person close may act on after our own reply: the evaluation
 * revision plus the one bump our outbound SMS causes. Anything else moved = null (abort).
 */
export function wrongPersonCloseRevision(evaluationRevision: number, currentRevision: number): number | null {
  const expected = evaluationRevision + 1;
  return currentRevision === expected ? expected : null;
}

async function dispatchAiResponseCore(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  deps: { anthropic: AnthropicLike } & AiDispatchOptions,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  // --------------------------------------------------------------------------
  // 1. Load property + org + config
  // --------------------------------------------------------------------------
  const preGates = await checkAiResponderDispatchPreGates(supabase, input, {
    checkSuperseded: deps.checkSuperseded,
    runContext: deps.runContext,
  });
  if (!preGates.ok) return preGates.outcome;
  const { property } = preGates;
  // Routing v2 backfill: only the v2 engine may handle an old text. v2 not live for this text
  // right now (flags / canary / engine re-read per text, so a mid-run kill switch is honoured)
  // = skipped and counted; never the legacy engine, never a reply or a drip (Opus review B2).
  if (input.routingV2Backfill && !preGates.routingV2Live) {
    return { outcome: "skipped", reason: ROUTING_V2_BACKFILL_V2_NOT_LIVE };
  }
  // Newest-inbound fence (Astra review 2b-2): before the keyword branch and everything after it,
  // an older backfill text never acts once a newer seller text exists (any mode).
  if (input.routingV2Backfill && input.inboundMessageId
      && (await backfillNewerInboundExists(supabase, input.propertyId, input.inboundMessageId)) !== "no") {
    return { outcome: "skipped", reason: ROUTING_V2_BACKFILL_NEWER_INBOUND };
  }

  const { data: config } = await supabase
    .from("ai_responder_configs")
    .select(
      "id, active, model, system_prompt, max_turns, min_confidence, escalation_keywords, business_hours_only, classifier_provider, classifier_mode, outbound_mode, reply_generation",
    )
    .eq("org_id", property.org_id)
    .eq("active", true)
    .maybeSingle();

  // Messages v2 PR 3: the org's engine, read ONCE per inbound and carried on `config`.
  // Only a missing engine column (a database before the migration) falls back to the
  // eight-answer engine; any other read problem is `unreadable` and holds.
  const engineRead =
    config?.classifier_provider === "jev" ? await readClassifierEngine(supabase, property.org_id) : "outcome_v1";
  // A responder-off property (a person's takeover switch) is checked FIRST: it runs no
  // engine and writes no hold either way, so an unreadable switch there changes nothing
  // (it falls through to the silent responder-off skip below).
  // Routing v2 backfill: the config read here (the one every later branch uses) must itself say
  // Jev automatic + nine questions, or the text is skipped. Closes the gap between the pre-gate's
  // live read and this one (a flip in between can never route a backfill text to another engine).
  if (input.routingV2Backfill && !(config?.classifier_provider === "jev" && config.classifier_mode === "automatic" && engineRead === "nine_questions")) {
    return { outcome: "skipped", reason: ROUTING_V2_BACKFILL_V2_NOT_LIVE };
  }
  if (engineRead === "unreadable" && property.ai_responder_disabled !== true) {
    // The switch state is unknown: run neither engine, a person looks (not a hot hold).
    await markPropertyNeedsAttention(supabase, input.propertyId, CLASSIFIER_ENGINE_UNREADABLE, deps.runContext);
    return { outcome: "escalated", reason: CLASSIFIER_ENGINE_UNREADABLE };
  }
  const classifierEngine = engineRead === "unreadable" ? "outcome_v1" : engineRead;
  if (config) (config as { classifier_engine?: string }).classifier_engine = classifierEngine;

  if (deps.runContext) {
    await updateRun(supabase, deps.runContext, {
      mode:
        config?.classifier_provider === "jev"
          ? config.classifier_mode === "automatic"
            ? "automatic"
            : "shadow"
          : "legacy",
    });
  }

  // --------------------------------------------------------------------------
  // 1b. A retry that carries its generated reply short-circuits HERE, before the
  //     keyword / skip / throttle gates and the Jev block: it never classifies
  //     or generates again, and a gate that trips during the retry gap cannot
  //     silently drop the reply (see retryWithCarriedReply).
  // --------------------------------------------------------------------------
  if ((input.retryAttempt ?? 0) > 0 && input.retryReply) {
    return retryWithCarriedReply(supabase, input, property, config, deps.runContext);
  }

  // --------------------------------------------------------------------------
  // 2. Keyword gate (runs even without a config so we surface the right
  //    signal on lead detail regardless). If no config and no match,
  //    we'll skip below.
  // --------------------------------------------------------------------------
  // PR 2: with Jev automatic, the price_offer keyword is NOT a hot flag on its
  // own here. It is decided after the consent / suppression gates and the
  // classification, by the shared hot decision, so "STOP texting me, what's
  // your price" stays an opt-out (stop / DNC / wrong / bad number win).
  const deferPriceKeyword =
    !!config && config.active === true && isJevAutomatic(config) &&
    isPriceKeyword(input.inboundBody, config.escalation_keywords) &&
    // A text that ALSO carries a non-price signal (died, lawyer, "real person")
    // keeps main's up-front hold so a person always sees it.
    !hasNonPriceEscalationPhrase(input.inboundBody, { allowedPhrases: config.escalation_keywords ?? undefined });
  if (deferPriceKeyword) {
    await trace(supabase, {
      kind: "gate",
      name: "escalation_keyword",
      result: "pass",
      detail: { tier: HOT_KEYWORD_TIER, deferred: "shared_hot_decision" },
    }, deps.runContext);
  }
  // PR 2: a person turned the responder OFF for this property (their
  // takeover switch): Sandra writes no keyword hold and sends no alert,
  // whatever the phrase. Everything else (opted-out / DNC contacts, phone
  // suppression, no active config) keeps main's behaviour: a keyword still
  // writes its hold so a person sees it. Nothing is ever texted either way.
  // (Held / human-takeover properties never reach this point.)
  const keywordHit =
    !deferPriceKeyword &&
    matchEscalationKeyword(input.inboundBody, { allowedPhrases: config?.escalation_keywords ?? undefined }) !== null;
  const keywordGated = keywordHit && property.ai_responder_disabled === true;
  if (keywordGated) {
    await trace(supabase, {
      kind: "gate",
      name: "escalation_keyword",
      result: "skipped",
      detail: { why: "disabled_per_property" },
    }, deps.runContext);
  }
  if (keywordHit && !keywordGated && input.routingV2Backfill?.mode === "classify_only") {
    // Classify-only (enforced here, with the keywords just read): the up-front keyword hold is a
    // side effect, so the text is skipped and counted instead (Astra review 1).
    return { outcome: "skipped", reason: ROUTING_V2_BACKFILL_CLASSIFY_KEYWORD_HOLD };
  }
  const keywordEscalation = deferPriceKeyword || keywordGated
    ? ({ escalated: false } as const)
    : await applyKeywordEscalation(supabase, {
        propertyId: input.propertyId,
        inboundBody: input.inboundBody,
        escalationKeywords: config?.escalation_keywords ?? null,
        runContext: deps.runContext,
        jevAutomatic: !!config && config.active === true && isJevAutomatic(config),
        inboundMessageId: input.inboundMessageId ?? null,
        orgId: property.org_id,
      });

  if (keywordEscalation.escalated) {
    // The up-front hold keeps main's (non-price) reason so a person sees it.
    // If the text ALSO carries an allowed price signal, the lead is now held:
    // run the held-lead classify-only check, which alerts Jarrad once only if
    // stop / DNC / wrong / bad number does not win (and its own gates pass).
    // A backfill text never reaches the legacy classifier: the keyword hold stands for a person.
    if (!input.routingV2Backfill) {
      await checkHotTextAfterKeywordHold(supabase, input, keywordEscalation.reason, config?.escalation_keywords ?? null, deps.runContext, property);
    }
    const escalatedOutcome: AiDispatchOutcome = { outcome: "escalated", reason: keywordEscalation.reason };
    // Stress F8/F9 (round 17): a hold that did not land is never recorded as handled (claim
    // flag_failed); it already failed closed (drips paused, replies cancelled, safety marker).
    if (!keywordEscalation.flagOk) markFlagFailed(escalatedOutcome);
    return escalatedOutcome;
  }

  // --------------------------------------------------------------------------
  // 3. Skip classifier — consent, disabled, turn, biz-hours. No volume
  //    cap: provider/API credits are the only cap (Jarrad's standing rule).
  // --------------------------------------------------------------------------
  const consentLookup = await getConsentStateStrict(supabase, input.contactId, "sms");
  const consentState = consentLookup.ok ? consentLookup.state : null;
  const countedTurns = await countAiTurnsInThread(
    supabase,
    input.propertyId,
    input.contactId,
    input.conversationId ?? null,
  );
  if ((countedTurns === null || consentState === null) && input.routingV2Backfill?.mode === "classify_only") {
    return { outcome: "skipped", reason: ROUTING_V2_BACKFILL_CLASSIFY_UNAVAILABLE };
  }
  if (countedTurns === null || consentState === null) {
    // Rule 7: a gate that cannot be evaluated never passes. No reply exists
    // yet (nothing to dead-letter), so flag a human with `send_check_failed`.
    await trace(supabase, {
      kind: "gate",
      name: "send_check_failed",
      result: "error",
      detail: { check: consentState === null ? "consent" : "max_turns" },
    }, deps.runContext);
    await flagAndDeadLetter(supabase, {
      runContext: deps.runContext,
      orgId: property.org_id,
      conversationId: input.conversationId ?? null,
      propertyId: input.propertyId,
      inboundMessageId: input.inboundMessageId ?? null,
      body: null,
      reason: "send_check_failed",
    });
    return { outcome: "escalated", reason: "send_check_failed" };
  }
  const currentTurn = countedTurns;
  const withinBusinessHours = checkQuietHours(property.state).ok;

  const decision = classifyAiSkip({
    config: config
      ? {
          active: config.active,
          business_hours_only: config.business_hours_only,
          max_turns: config.max_turns,
        }
      : null,
    consentState,
    propertyDisabled: property.ai_responder_disabled,
    currentTurn,
    withinBusinessHours,
  });

  await trace(
    supabase,
    decision.skip
      ? {
          kind: "gate",
          name: "ai_skip",
          result: "block",
          detail: { reason: decision.reason },
        }
      : { kind: "gate", name: "ai_skip", result: "pass" },
      deps.runContext,
  );

  if (decision.skip) {
    // Classify/reply-eligibility decoupling (Jev workflow, 2026-09-20):
    // `decision.skip` governs whether Sandra may SEND an automated reply
    // (org-wide off, no consent, per-property AI-responder disabled —
    // a VA-controlled human-takeover kill switch, see
    // `setAiResponderDisabled` — or the reply-pacing gates: per-thread
    // max-turns and outside-business-hours). Jev's own outcomes never
    // send a reply (Jev has no `send_reply`/`deescalate_close` route —
    // it only ever escalates, closes, opts out, or requests dnc/nurture)
    // so classifying and applying ITS effect is safe to decouple from
    // the reply-pacing gates specifically. It must NOT be decoupled from
    // consent/org-off/property-disabled — those represent real
    // suppression and human-takeover signals that must still be
    // respected, not just reply throttling.
    const jevClassifyEligibleDespiteSkip =
      config != null &&
      config.active === true &&
      config.classifier_provider === "jev" &&
      consentState !== "opted_out" &&
      !property.ai_responder_disabled;

    if (jevClassifyEligibleDespiteSkip) {
      const outcome = await classifyAndApplyDespiteReplyIneligibility(
        supabase,
        input,
        property,
        config,
        currentTurn,
        deps.runContext,
        decision.reason,
      );
      if (outcome) return outcome;
      // use_legacy — Jev had nothing actionable to apply (jev_no_action
      // is now handled and returns non-null above), so the original skip
      // reason (reply-pacing, not a Jev decision) still stands.
    }

    // First dispatch, before any reply exists: the pacing / consent / off gates
    // are a silent Q8 rule 0 exit (recorded as `skipped:rule_0`, handled).
    return silentSkip(decision.reason, 0);
  }

  // Stress review A-2: the 45 s reply throttle never parks a v2 reply (see the pre-gates).
  if (input.conversationId && !preGates.routingV2Live) {
    const recentReply = await findRecentAiReplyInThread(
      supabase,
      input.conversationId,
      AI_REPLY_THREAD_DEBOUNCE_MS,
    );
    if (recentReply) {
      // The 45s throttle is not a private silent-drop rule: a recent AI reply
      // is classified by the same Q8 table as every other outbound (an AI
      // reply to a DIFFERENT inbound that went out is rule 3: flag a human;
      // one still queued is rule 4: retry; one that answers this inbound is
      // rule 2: silent). Submitted evidence stays bounded to "since the
      // seller's inbound" (rules 3 and 5); the throttle never widens it.
      const evaluation = await evaluateSendGate(supabase, input, {
        phase: "presend",
        claimStartedAt: null,
        checkNewerInbound: false,
        property,
      });
      if (evaluation.ok && evaluation.decision.action === "retry") {
        await trace(supabase, {
          kind: "gate",
          name: "duplicate_throttled",
          result: "block",
          detail: { rule: 4 },
        }, deps.runContext);
        return retryBeforeGeneration(supabase, input, property.org_id, deps.runContext);
      }
      const plan = evaluation.ok ? skipPlanFor(evaluation.decision, "presend") : null;
      if (plan) {
        await trace(supabase, {
          kind: "gate",
          name: "duplicate_throttled",
          result: "block",
          detail: { rule: evaluation.ok ? evaluation.decision.rule : null },
        }, deps.runContext);
        if (plan.flagReason) {
          const throttleFlagged = await markPropertyNeedsAttention(
            supabase,
            input.propertyId,
            plan.flagReason,
            deps.runContext,
          );
          // A flag that cannot be proven must not read as "a human was told":
          // fall through so the pre-send check re-evaluates under the lease and
          // fails closed (rule 7), like the early gate.
          if (throttleFlagged) return flaggedSkip("duplicate_throttled");
        } else {
          const throttleRule = evaluation.ok ? silentRuleOf(evaluation.decision) : null;
          return throttleRule === null
            ? { outcome: "skipped", reason: plan.reason }
            : silentSkip(plan.reason, throttleRule);
        }
      }
      if (!evaluation.ok) {
        // Cannot classify the recent reply: never drop silently on a failed
        // lookup. Continue; the pre-send check is strict and fails closed.
        await trace(supabase, {
          kind: "gate",
          name: "duplicate_throttled",
          result: "error",
          detail: { lookup: "failed" },
        }, deps.runContext);
      } else {
        await trace(supabase, {
          kind: "gate",
          name: "duplicate_throttled",
          result: "pass",
        }, deps.runContext);
      }
    } else {
      await trace(supabase, {
        kind: "gate",
        name: "duplicate_throttled",
        result: "pass",
      }, deps.runContext);
    }
  }

  const claimStartedAt = new Date().toISOString();
  const responseClaim = await claimAiResponse(supabase, {
    orgId: property.org_id,
    inboundMessageId: input.inboundMessageId,
    propertyId: input.propertyId,
    contactId: input.contactId,
    conversationId: input.conversationId ?? null,
  });
  await traceClaim(supabase, responseClaim, deps.runContext);
  if (!responseClaim.claimed) {
    return refusedClaimOutcome(supabase, input, responseClaim.reason, property.org_id, deps.runContext);
  }

  // Hostile wording (approved phrase list) never auto-suppresses and never
  // auto-replies: it is held for a person (`hostile_needs_confirm`) once the
  // classification has run, and every automatic template is blocked for the
  // message. An explicit opt-out the classifier recognises still goes through
  // the existing opt-out path untouched. The identity shortcut is skipped so
  // an automated "who is this" answer can never go to a hostile seller.
  const hostileInbound = isHostileInbound(input.inboundBody);
  // Messages v2 PR 3: with the nine questions on, "who is this" is one of Jev's nine
  // answers (and ranks BELOW stop / wrong person / price in the approved order), so
  // the wording shortcut must not answer first. Any read failure = the old engine.
  const nineEngineOn = classifierEngine === "nine_questions" && config?.classifier_mode === "automatic";

  // PR 2: a hot seller never gets an automatic text. "Who is this? I might
  // sell." would otherwise be answered by the identity shortcut before Jev
  // runs; with Jev in automatic mode, classify first and let a hot decision
  // take the hand-off path below (no reply) instead.
  // ONE classification serves the identity decision AND the main path below
  // (passed through as `precomputed`), so the two can never disagree. A
  // classifier failure fails closed: no identity text; the main path holds.
  // With the nine questions on (automatic) the wording shortcut never runs, and neither does
  // the eight-answer pre-classification it would need. A price-keyword text never takes the
  // identity shortcut (it goes to the shared hot decision instead).
  const identityQuestion = !hostileInbound && !nineEngineOn && !deferPriceKeyword && isIdentityQuestion(input.inboundBody);
  const identityClassification = identityQuestion && config && isJevAutomatic(config)
    ? await classifyInboundOnce(supabase, { input, orgId: property.org_id, runCtx: deps.runContext })
    : null;
  const identityHot = identityClassification !== null && (
    identityClassification.kind === "jev_automatic_failed" ||
    (await isHotRouting(supabase, property.org_id, identityClassification, input.inboundBody, config?.escalation_keywords ?? null))
  );
  if (identityHot) {
    await trace(supabase, {
      kind: "action",
      name: "identity_reply",
      result: "skipped",
      detail: { why: identityClassification?.kind === "jev_automatic_failed" ? "classifier_failed" : "hot_seller" },
    }, deps.runContext);
  }

  if (identityQuestion && !identityHot) {
    // "Who is this?" that is ALSO "how did you get my number?": send only the
    // approved number-source template (it identifies the context) and skip the
    // identity reply, so the seller gets ONE message. Needs the classifier, so
    // it is attempted only when an approved template is mapped; every other
    // case (and any failure) falls through to the identity reply below.
    const identityLookup = await resolveNumberSourceForIdentity(supabase, {
      input,
      orgId: property.org_id,
      config: config!,
      runCtx: deps.runContext,
      precomputed: identityClassification,
    });
    // The randomized reply delay was bypassed: an approved template is never sent
    // instantly, so the number-source reply is dropped and a person is told.
    const identityDelayDrop = identityLookup.template && input.replyDelayBypassed
      ? (input.replyDelayBypassReason ?? "delay_unavailable")
      : null;
    const numberSource = identityDelayDrop ? null : identityLookup.template;
    const identityNotSentReason = identityDelayDrop ?? identityLookup.askedNotSentReason;
    if (numberSource) {
      const nsRepeat = await templateAlreadySentToProperty(supabase, property.org_id, input.propertyId, numberSource.templateId, numberSource.body);
      if (nsRepeat !== "no") {
        return holdRepeatedReply(supabase, {
          input,
          claimId: responseClaim.claimId,
          holdReason: `${NUMBER_SOURCE_NOT_SENT_PREFIX}${TEMPLATE_ALREADY_SENT}`,
          lookup: nsRepeat,
          detail: { templateId: numberSource.templateId, mappingId: numberSource.mappingId, replyKey: numberSource.key, via: "identity_interceptor" },
          runCtx: deps.runContext,
        });
      }
      const sent = await sendResponderMessage(supabase, {
        runContext: deps.runContext,
        input,
        body: numberSource.body,
        model: config!.model,
        confidence: numberSource.nativeConfidence ?? 1,
        sentiment: "neutral",
        turn: currentTurn + 1,
        source: "approved_template",
        templateId: numberSource.templateId,
        templateSource: numberSource.source,
        replyKey: NUMBER_SOURCE_REPLY_KEY,
        orgId: property.org_id,
        claimStartedAt,
        outboundMode: config!.outbound_mode,
        replyKind: "send_reply",
      });
      await trace(supabase, {
        kind: "reply",
        name: "template_reply",
        result:
          sent.outcome === "sent"
            ? "sent"
            : sent.outcome === "skipped"
              ? "skipped"
              : sent.outcome === "retry"
                ? "block"
                : "held",
        detail: {
          templateId: numberSource.templateId,
          mappingId: numberSource.mappingId,
          outcome: numberSource.outcome,
          replyKey: numberSource.key,
          via: "identity_interceptor",
          sendOutcome: sent.outcome,
        },
      }, deps.runContext);
      // A contended send drops its carried reply so the re-dispatch classifies again and
      // re-runs the template path (a carried reply would go out as a plain LLM reply,
      // without the approval re-check, reply_key or the awaiting-answer hold).
      const settledNumberSource = await settleClaimForSendOutcome(supabase, responseClaim.claimId, sent.outcome === "retry" ? { ...sent, reply: undefined } : sent, {
        orgId: property.org_id,
        input,
        body: numberSource.body,
        runContext: deps.runContext,
      });
      // The reply asks "want me to take you off the list?": a person must see the answer.
      if (sent.outcome === "sent") {
        await holdWithRetry(supabase, input.propertyId, NUMBER_SOURCE_AWAITING_ANSWER_REASON, deps.runContext);
      } else if (sent.outcome !== "retry") {
        // Refused at the final fence (approval changed, recipient window) or held by the send
        // path: nobody answered the question, so a person is told (first flag wins).
        await holdWithRetry(
          supabase,
          input.propertyId,
          `${NUMBER_SOURCE_NOT_SENT_PREFIX}send_${sent.outcome}`,
          deps.runContext,
        );
      }
      return settledNumberSource;
    }
    const safety = validateAiReplyBody(IDENTITY_REPLY_BODY);
    if (!safety.ok) {
      const reason = `safety:${safety.reason}`;
      await trace(supabase, {
        kind: "gate",
        name: "safety",
        result: "block",
        detail: { reason: safety.reason },
      }, deps.runContext);
      const flagOk1 = await markPropertyNeedsAttention(supabase, input.propertyId, reason, deps.runContext);
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: "escalated",
        flagOk: flagOk1,
      });
      return { outcome: "escalated", reason };
    }
    const identityRepeat = await templateAlreadySentToProperty(supabase, property.org_id, input.propertyId, null, IDENTITY_REPLY_BODY);
    if (identityRepeat !== "no") {
      return holdRepeatedReply(supabase, {
        input,
        claimId: responseClaim.claimId,
        holdReason: TEMPLATE_ALREADY_SENT_HOLD,
        lookup: identityRepeat,
        detail: { replyKind: "identity" },
        runCtx: deps.runContext,
      });
    }
    const outcome = await sendResponderMessage(supabase, {
      runContext: deps.runContext,
      input,
      body: IDENTITY_REPLY_BODY,
      model: config!.model,
      confidence: 1,
      sentiment: "neutral",
      turn: currentTurn + 1,
      // Every current caller is `llm` (brief, fix round 2): even the fixed
      // identity template is not classed as an approved template until a
      // human approves that classification.
      source: "llm",
      orgId: property.org_id,
      claimStartedAt,
      outboundMode: config!.outbound_mode,
      replyKind: "identity",
    });
    const settledIdentity = await settleClaimForSendOutcome(supabase, responseClaim.claimId, outcome, {
      orgId: property.org_id,
      input,
      body: IDENTITY_REPLY_BODY,
      runContext: deps.runContext,
    });
    // The seller also asked how we got the number but that reply did not go
    // out: the identity copy does not answer it, so a person looks.
    if (identityNotSentReason) {
      await holdWithRetry(
        supabase,
        input.propertyId,
        `${NUMBER_SOURCE_NOT_SENT_PREFIX}${identityNotSentReason}`,
        deps.runContext,
      );
    }
    return settledIdentity;
  }

  // A retry with no carried reply (it waited at the gate before generating)
  // still ends at an already-stored draft: never regenerate over a human's.
  if ((input.retryAttempt ?? 0) > 0) {
    const reused = await reuseForRetry(supabase, input, {
      claimId: responseClaim.claimId,
      startedAt: claimStartedAt,
    }, deps.runContext);
    if (reused) return reused;
  }

  // --------------------------------------------------------------------------
  // 4. Classify — Jev (if this org's config selects it) or legacy Claude.
  //
  // Jarrad's explicit override (2026-09-20, on top of Fable's reviewed
  // plan) of the standing "shadow first" posture: when classifyForDispatch
  // resolves to `jev_route`, legacy Claude is skipped entirely for this
  // message — not called for comparison. Fable's per-org-canary
  // requirement (schema default `shadow`, `automatic` requires an
  // explicit per-org flip) is unchanged; only "keep legacy running during
  // canary" was overridden. dnc's human-gate is unaffected either way —
  // DB-enforced regardless of mode (see 20260920120000_sms_classification_runs.sql).
  // --------------------------------------------------------------------------
  const templateCtx: TemplateStepContext = {
    model: config!.model,
    outboundMode: config!.outbound_mode,
    currentTurn,
    claimStartedAt,
    ...(hostileInbound ? { hostile: true } : {}),
  };
  const classificationResult = await classifyAndHandleNonRouteOutcomes(
    supabase,
    input,
    property,
    config,
    responseClaim,
    deps.runContext,
    templateCtx,
    identityClassification,
  );
  if (classificationResult.handled) return classificationResult.outcome;
  const classification = classificationResult.classification;


  return resolveAndApplyRoute(
    supabase,
    input,
    property,
    {
      model: config!.model,
      system_prompt: config!.system_prompt,
      min_confidence: config!.min_confidence,
      outbound_mode: config!.outbound_mode,
      reply_generation: config!.reply_generation,
    },
    deps,
    currentTurn,
    { claimId: responseClaim.claimId, startedAt: claimStartedAt },
    classification,
    deps.runContext,
    templateCtx,
  );
}

/**
 * Runs Jev classification and, for the three outcomes that never touch
 * the reply pipeline (nurture, below-threshold/human-gated "needs a
 * decision", new_lead promotion), applies the effect and returns the
 * terminal outcome directly. Returns `handled: false` for `use_legacy`
 * (nothing to apply here — `jev_no_action` is now handled inline and
 * never reaches this return) or a `jev_route` classification — the
 * caller still resolves/applies that route itself via
 * `resolveAndApplyRoute`, kept separate because a `jev_route` MAY, in
 * principle, need `generateAiReply`'s legacy branch (never true for an
 * actual Jev decision, but the union type doesn't encode that).
 */
/**
 * The decoupled entry point: classification is eligible even though a
 * reply is not (see the `decision.skip` branch in `dispatchAiResponse`
 * for exactly which gates this bypasses and why). Takes its own AI
 * response claim — independent of, and mutually exclusive with, the
 * claim taken later in the normal (`!decision.skip`) path, since control
 * never reaches both in the same call. Returns null when classification
 * had nothing to apply (`use_legacy` — `jev_no_action` is handled inline
 * and returns a real outcome above, never reaching this return) or —
 * should never happen for an actual Jev decision, defended anyway — a
 * `jev_route` whose route would have sent a reply.
 */
async function classifyAndApplyDespiteReplyIneligibility(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  property: AiDispatchPropertyGateRow,
  config: {
    classifier_provider?: string | null;
    classifier_mode?: string | null;
    classifier_engine?: string | null;
    model: string;
    system_prompt: string;
    min_confidence: number;
    reply_generation?: string | null;
  },
  currentTurn: number,
  runCtx?: MaybeRunContext,
  /** Why no reply may be sent (the skip classifier's reason), e.g. `outside_business_hours`. */
  replyIneligibleReason?: string,
): Promise<AiDispatchOutcome | AiRetryOutcome | null> {
  const claimStartedAt = new Date().toISOString();
  const responseClaim = await claimAiResponse(supabase, {
    orgId: property.org_id,
    inboundMessageId: input.inboundMessageId,
    propertyId: input.propertyId,
    contactId: input.contactId,
    conversationId: input.conversationId ?? null,
  });
  await traceClaim(supabase, responseClaim, runCtx);
  if (!responseClaim.claimed) {
    return refusedClaimOutcome(supabase, input, responseClaim.reason, property.org_id, runCtx);
  }

  const classificationResult = await classifyAndHandleNonRouteOutcomes(
    supabase,
    input,
    property,
    config,
    responseClaim,
    runCtx,
    undefined,
    undefined,
    replyIneligibleReason,
  );
  if (classificationResult.handled) return classificationResult.outcome;
  const classification = classificationResult.classification;

  if (classification.kind !== "jev_route") {
    // use_legacy — jev_no_action is handled inline above and never
    // reaches here; nothing for Jev to apply, so the original
    // reply-pacing skip reason stands (handled by the caller).
    //
    // This run took a claim and is leaving WITHOUT a reply: settle the claim
    // as an error (lease released) so it can never read as a live handler of
    // this inbound (Q8 rule 1) for the rest of its 5-minute lease, and so a
    // re-dispatch of the same inbound can reclaim it at once.
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: "skipped",
      errorMessage: "reply_ineligible",
      releaseLease: true,
    });
    return null;
  }

  if (classification.route.kind === "send_reply" || classification.route.kind === "deescalate_close") {
    // Provably unreachable today — JEV_OUTCOME_TO_ACTION never maps to
    // an action that resolves to a send-kind route (Jev has no reply
    // body). Fail loud rather than silently send while reply-ineligible:
    // "must not replay sends" is a hard requirement, not a best effort.
    reportError(
      new Error("Jev route unexpectedly resolved to a send-kind route while reply-ineligible"),
      {
        tags: { surface: "ai_responder_jev_decoupled_classify" },
        extra: { propertyId: input.propertyId, routeKind: classification.route.kind },
      },
    );
    const flagOk2 = await markPropertyNeedsAttention(supabase, input.propertyId, "jev_unexpected_send_route", runCtx);
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
      flagOk: flagOk2,
    });
    return { outcome: "escalated", reason: "jev_unexpected_send_route" };
  }

  return resolveAndApplyRoute(
    supabase,
    input,
    property,
    config,
    // deps.anthropic is unreachable here — every remaining route.kind
    // (escalate/opt_out/close_dnc/auto_close/auto_close_wrong_number)
    // never calls generateAiReply, only the send-kind cases above do.
    { anthropic: null as never },
    currentTurn,
    { claimId: responseClaim.claimId, startedAt: claimStartedAt },
    classification,
    runCtx,
  );
}

async function classifyAndHandleNonRouteOutcomes(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  property: AiDispatchPropertyGateRow,
  config:
    | {
        classifier_provider?: string | null;
        classifier_mode?: string | null;
        classifier_engine?: string | null;
        escalation_keywords?: ReadonlyArray<string> | null;
      }
    | null
    | undefined,
  responseClaim: { claimId: string | null },
  runCtx?: MaybeRunContext,
  /** Present only on the reply-eligible path: absent = no template step. */
  templateCtx?: TemplateStepContext,
  /** The identity check's classification of this same inbound: reused, never recomputed. */
  precomputed?: ClassificationBridgeResult | null,
  /** Reply-ineligible path only: why no reply may be sent now. */
  replyIneligibleReason?: string,
): Promise<
  | { handled: true; outcome: AiDispatchOutcome | AiRetryOutcome }
  | { handled: false; classification: ClassificationBridgeResult }
> {
  // Messages v2 PR 3: per-org engine switch (default outcome_v1 = today's path).
  if (config?.classifier_provider === "jev" && config.classifier_engine === "nine_questions") {
    if (config.classifier_mode === "automatic") {
      // Routing v2 cutover: an eligible property (questions_live + canary) runs the v2 engine
      // instead. Flag off / not eligible / unreadable flags = null = today's nine-question step.
      const v2 = await runRoutingV2LiveStep(supabase, {
        input,
        property,
        claim: responseClaim,
        runCtx,
        templateCtx,
        escalationKeywords: config.escalation_keywords ?? null,
        ...(replyIneligibleReason ? { replyIneligibleReason } : {}),
      });
      if (v2) return { handled: true, outcome: v2 };
      if (input.routingV2Backfill) {
        // The v2 step declined after the pre-gate said live (a flag flip / read error in between).
        await completeClaim(supabase, input.propertyId, { claimId: responseClaim.claimId, outcome: ROUTING_V2_BACKFILL_V2_NOT_LIVE });
        return { handled: true, outcome: { outcome: "skipped", reason: ROUTING_V2_BACKFILL_V2_NOT_LIVE } };
      }
      // Opus review of 93a8070932bd (B1): a lead still held here got past the early gate only
      // because an older mechanics hold yields on the v2 road; if v2 did not take it after all,
      // the legacy engine must not answer a held lead.
      if (property.needs_human_attention) return { handled: true, outcome: silentSkip("already_terminal", 0) };
      return {
        handled: true,
        outcome: await runNineQuestionsStep(supabase, {
          input,
          property,
          claim: responseClaim,
          runCtx,
          templateCtx,
          escalationKeywords: config.escalation_keywords ?? null,
          ...(replyIneligibleReason ? { replyIneligibleReason } : {}),
        }),
      };
    }
    // Shadow: the decision is recorded for comparison; the eight-answer path still acts.
    const shadow = await runNineClassification(
      supabase,
      {
        orgId: property.org_id,
        propertyId: input.propertyId,
        contactId: input.contactId,
        conversationId: input.conversationId ?? null,
        inboundMessageId: input.inboundMessageId ?? null,
        inboundBody: input.inboundBody,
      },
      { fetch, typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "", runContext: runCtx, shadow: true },
    );
    if (shadow.kind === "ok") {
      await trace(supabase, {
        kind: "shadow",
        name: "would_apply",
        result: "would_apply",
        detail: { shadow_engine: "nine_questions", answer: shadow.result.answer },
      }, runCtx);
    }
  }
  // `precomputed` is only ever set on the eight-answer path (the nine engine skips the identity
  // pre-classification), so the nine branch above never consumes it.
  const classification = precomputed ?? await classifyForDispatch(
    supabase,
    {
      orgId: property.org_id,
      propertyId: input.propertyId,
      contactId: input.contactId,
      conversationId: input.conversationId ?? null,
      inboundMessageId: input.inboundMessageId ?? null,
      inboundBody: input.inboundBody,
    },
    {
      classifierProvider: (config?.classifier_provider as "legacy" | "jev") ?? "legacy",
      classifierMode: (config?.classifier_mode as "shadow" | "automatic") ?? "shadow",
    },
    {
      fetch,
      typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "",
      runContext: runCtx,
    },
  );

  // PR 2: hot wins. One shared routing decision right after classification,
  // before any reply, drip or disposition: a nurture / not-interested result
  // that also says "price or offer" / "call me" is a hot seller. It is held
  // for Jarrad (hot hold → one Slack + one text); no reply, no disposition.
  // new_lead promotions and escalations keep their own hot paths.
  // The deferred price_offer keyword (Jev automatic): hot unless stop / DNC /
  // wrong / bad number won; a promotion or a hot escalate route keeps its own
  // hot path. If Jev failed, the keyword alone marks hot (alert only).
  const priceKeyword =
    !!config && isJevAutomatic(config) &&
    isPriceKeyword(input.inboundBody, config.escalation_keywords);
  if (
    priceKeyword &&
    classification.kind !== "jev_promote_new_lead" &&
    !(classification.kind === "jev_route" && classification.route.kind === "escalate") &&
    !stopOrDncWins(classification) &&
    !hotWinsOver(classification)
  ) {
    const keywordReason = `keyword:${HOT_KEYWORD_TIER}`;
    await trace(supabase, {
      kind: "hold",
      name: "hot_wins",
      result: "held",
      detail: { kind: classification.kind, keyword: HOT_KEYWORD_TIER },
    }, runCtx);
    const kwFlagOk = await markPropertyNeedsAttention(supabase, input.propertyId, keywordReason, runCtx);
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
      flagOk: kwFlagOk,
    });
    return { handled: true, outcome: { outcome: "escalated", reason: keywordReason } };
  }

  // Hot wins ONLY over nurture and not-interested (at or below their cutoff).
  // Stop / DNC / wrong-number always beat hot (Jarrad's approved order puts
  // "asked to stop" above "talked price"): their human review paths run.
  if (hotWinsOver(classification)) {
    const hotReason = `model:${(classification as { escalationReason?: string | null }).escalationReason}`;
    await trace(supabase, {
      kind: "hold",
      name: "hot_wins",
      result: "held",
      detail: { kind: classification.kind, escalation: (classification as { escalationReason?: string | null }).escalationReason ?? null },
    }, runCtx);
    const hotFlagOk = await markPropertyNeedsAttention(supabase, input.propertyId, hotReason, runCtx);
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
      flagOk: hotFlagOk,
    });
    return { handled: true, outcome: { outcome: "escalated", reason: hotReason } };
  }

  // Luna fallback SUGGESTION for a below-threshold hold. Fire-and-forget after
  // the response: it never delays or blocks this pipeline, never applies
  // anything, and is a no-op unless LUNA_SUGGESTIONS_ENABLED=1 with a key.
  const lunaJevOutcome = jevOutcomeForLunaHold(classification);
  if (lunaJevOutcome && input.inboundMessageId && lunaSuggestionsEnabled()) {
    const inboundMessageId = input.inboundMessageId;
    runAfterResponse(async () => {
      await requestLunaSuggestion(
        supabase,
        {
          orgId: property.org_id,
          propertyId: input.propertyId,
          contactId: input.contactId,
          conversationId: input.conversationId ?? null,
          inboundMessageId,
          inboundBody: input.inboundBody,
          jevOutcome: lunaJevOutcome,
          escalationKeywords: config?.escalation_keywords ?? null,
          runContext: runCtx,
        },
        { fetch },
      );
    });
  }

  if (classification.kind === "jev_nurture") {
    if (isHostileInbound(input.inboundBody)) {
      return { handled: true, outcome: await holdHostileForConfirm(supabase, input, responseClaim, runCtx) };
    }
    // Root review of dbbb12e6, finding 1: effect + revision guard +
    // audit insert now happen atomically inside ONE RPC call — see
    // applyJevLeadDecisionAtomically's doc comment.
    //
    // Approved-template reply first (Phase 4): nurture is a human-owned
    // disposition that suppresses automated sends, so the reply must go out
    // before the outcome is applied.
    //
    // Nurture auto-drip (per-org switch, default off). When on, the approved
    // routing runs on Jev's timeframe / listing answers: "ready within 30 days"
    // is a hot lead for a person, so it gets no nurture reply and no drip.
    const dripCfg = await loadNurtureAutoDripConfig(supabase, property.org_id);
    const dripRoute: NurtureRoute | null = dripCfg.enabled
      ? routeNurture({
          readyTimeframe: classification.readyTimeframe,
          listingStatus: classification.listingStatus,
        })
      : null;
    if (dripRoute?.kind === "person") {
      if (input.inboundMessageId) {
        await proposeJevLeadDecision(supabase, {
          propertyId: input.propertyId,
          conversationId: input.conversationId,
          inboundMessageId: input.inboundMessageId,
          classificationRunId: classification.classificationRunId,
          outcome: "new_lead",
          nativeConfidence: classification.nativeConfidence,
          thresholdAtDecision: classification.thresholdAtDecision,
          thresholdVersion: classification.thresholdVersion,
          expectedRevision: classification.evaluationRevision,
        });
      }
      await trace(supabase, {
        kind: "hold",
        name: "nurture_ready_within_30_days",
        result: "held",
        detail: { reason: "hot_lead", readyTimeframe: classification.readyTimeframe ?? null },
      }, runCtx);
      const hotFlagOk = await markPropertyNeedsAttention(supabase, input.propertyId, "hot_lead", runCtx);
      // Also start the Book appointment drip (no nurture reply, no dispo change,
      // no extra delay beyond the drip's own first step). It pauses on the
      // seller's reply and when a person takes over; a failure here never
      // undoes the hold.
      if (classification.askedHowNumberObtained) {
        // The seller also asked how we got their number and no reply goes out: a person
        // answers, so nothing is enrolled in a drip.
        await trace(supabase, {
          kind: "action",
          name: "drip_enrolled",
          result: "skipped",
          detail: { why: "number_source_asked", route: "hot_book_appointment" },
        }, runCtx);
      } else {
        // PR 2: a hot seller is handed to Jarrad (hot hold → one Slack + one
        // text); Sandra never starts a seller-facing drip for them.
        await trace(supabase, {
          kind: "action",
          name: "drip_enrolled",
          result: "skipped",
          detail: { why: "hot_seller_no_drip", route: "hot_book_appointment" },
        }, runCtx);
      }
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: "escalated",
        flagOk: hotFlagOk,
      });
      return { handled: true, outcome: { outcome: "escalated", reason: "hot_lead" } };
    }
    let templateMessageId: string | null = null;
    let numberSourceHold: string | null = null;
    let templateReplyKey: TemplateReplyKey | null = null;
    // Why no nurture reply went out (drip enrolment needs the nurture reply first).
    let templateNotSentReason: string | null = !templateCtx
      ? "no_reply_path"
      : templateCtx.hostile
        ? "hostile"
        : null;
    if (templateCtx && !templateCtx.hostile) {
      const step = await runApprovedTemplateStep(supabase, {
        input,
        property,
        ctx: templateCtx,
        claim: responseClaim,
        outcome: "nurture",
        nativeConfidence: classification.nativeConfidence,
        escalationReason: classification.escalationReason,
        askedHowNumberObtained: classification.askedHowNumberObtained,
        runCtx,
      });
      if (step.kind === "stop") return { handled: true, outcome: step.outcome };
      templateMessageId = step.outboundMessageId;
      numberSourceHold = step.hold;
      templateReplyKey = step.replyKey;
      templateNotSentReason = step.outboundMessageId ? null : (step.notSentReason ?? "not_sent");
    } else if (classification.askedHowNumberObtained) {
      // Asked, but this dispatch cannot send replies at all.
      numberSourceHold = `${NUMBER_SOURCE_NOT_SENT_PREFIX}reply_ineligible`;
    }
    // True when there is nothing to hold or the hold is persisted. A hold that could not be
    // written completes the claim as error `flag_failed` (not handled) so it is recoverable:
    // the claim keeps the sent template's id, so a re-dispatch never sends it twice.
    const holdForNumberSource = async (): Promise<boolean> =>
      numberSourceHold ? holdWithRetry(supabase, input.propertyId, numberSourceHold, runCtx) : true;
    const applyResult = await applyJevLeadDecisionAtomically(supabase, {
      propertyId: input.propertyId,
      conversationId: input.conversationId,
      inboundMessageId: input.inboundMessageId,
      classificationRunId: classification.classificationRunId,
      outcome: "nurture",
      nativeConfidence: classification.nativeConfidence,
      thresholdAtDecision: classification.thresholdAtDecision,
      thresholdVersion: classification.thresholdVersion,
      expectedRevision: classification.evaluationRevision,
    });
    if (
      applyResult.status === "applied" ||
      applyResult.status === "already_nurture" ||
      applyResult.status === "replayed"
    ) {
      await trace(supabase, {
        kind: "action",
        name: "apply_nurture",
        result: "applied",
        detail: { status: applyResult.status },
      }, runCtx);
      if (applyResult.status === "applied") {
        await recordLeadEvent({
          propertyId: input.propertyId,
          actorType: "ai",
          eventType: LEAD_EVENT_TYPES.DISPO_SET,
          payload: { from: null, to: "nurture", reason: "model:nurture" },
        });
      }
      // Applied first, then held: a flagged property would make the outcome write skip.
      const holdOk = await holdForNumberSource();
      // Strictly AFTER the nurture reply was accepted and the outcome applied. Only the
      // nurture reply itself starts a drip: when the number-source reply replaced it
      // (or was asked for and could not go out) the seller is waiting on a person, so
      // nothing is enrolled and no "nurture reply not sent" flag is raised.
      if (!classification.askedHowNumberObtained) {
        await runNurtureAutoDripStep(supabase, {
          propertyId: input.propertyId,
          contactId: input.contactId,
          cfg: dripCfg,
          route: dripRoute,
          replySent: templateMessageId !== null && templateReplyKey === "nurture",
          notSentReason: templateNotSentReason ?? "not_sent",
          runCtx,
        });
      }
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: holdOk ? "auto_closed" : "escalated",
        ...(holdOk ? {} : { flagOk: false }),
        ...(templateMessageId ? { outboundMessageId: templateMessageId } : {}),
      });
      return { handled: true, outcome: { outcome: "auto_closed", reason: "model:nurture" } };
    }
    await trace(supabase, {
      kind: "action",
      name: "apply_nurture",
      result: applyResult.status === "already_terminal" ? "skipped" : "error",
      detail: { status: applyResult.status },
    }, runCtx);
    if (applyResult.status === "already_terminal") {
      // Benign, not an error: something more specific than nurture is
      // already set (possibly by a human while Jev was classifying) —
      // nurture must never downgrade it. Skip silently, same treatment
      // as the legacy path's "already_terminal" RPC status.
      const terminalHoldOk = await holdForNumberSource();
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: terminalHoldOk ? silentSkipClaimOutcome(0) : "escalated",
        ...(terminalHoldOk ? {} : { flagOk: false }),
        ...(templateMessageId ? { outboundMessageId: templateMessageId } : {}),
      });
      return { handled: true, outcome: silentSkip("already_terminal", 0) };
    }
    const reason = applyResult.status === "stale_decision_context" ? "jev_stale_decision_context" : "nurture_write_failed";
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
      errorMessage: applyResult.status,
      ...(templateMessageId ? { outboundMessageId: templateMessageId } : {}),
    });
    await markPropertyNeedsAttention(supabase, input.propertyId, reason, runCtx);
    return { handled: true, outcome: { outcome: "escalated", reason } };
  }

  if (classification.kind === "jev_needs_decision") {
    if (isHostileInbound(input.inboundBody)) {
      return { handled: true, outcome: await holdHostileForConfirm(supabase, input, responseClaim, runCtx) };
    }
    // Below the org's configured threshold, missing/invalid native
    // confidence, or no threshold configured at all for an outcome with no
    // existing pending-review path to fall back on (currently only
    // `nurture` — see dispatch-bridge.ts). Apply nothing; leave the
    // property for a human, same treatment as every other escalation path
    // in this function.
    const reason = `jev_below_threshold:${classification.outcome}`;
    if (classification.outcome === "nurture") {
      await proposeJevLeadDecision(supabase, {
        propertyId: input.propertyId,
        conversationId: input.conversationId,
        inboundMessageId: input.inboundMessageId,
        classificationRunId: classification.classificationRunId,
        outcome: "nurture",
        nativeConfidence: classification.nativeConfidence,
        thresholdAtDecision: classification.thresholdAtDecision,
        thresholdVersion: classification.thresholdVersion,
        expectedRevision: classification.evaluationRevision,
      });
    }
    const flagOk3 = await markPropertyNeedsAttention(supabase, input.propertyId, reason, runCtx);
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
      flagOk: flagOk3,
    });
    return { handled: true, outcome: { outcome: "escalated", reason } };
  }

  if (classification.kind === "jev_promote_new_lead") {
    if (isHostileInbound(input.inboundBody)) {
      return { handled: true, outcome: await holdHostileForConfirm(supabase, input, responseClaim, runCtx) };
    }
    // new_lead at/above the org's configured threshold. Promote via the
    // atomic RPC (root review of dbbb12e6, finding 1) — never appointment
    // booking, never a raw properties.status write here. qualifyProperty
    // (the shared primitive the legacy Haiku qualifier and manual qualify
    // actions still use) is not called from this path anymore — its
    // effect is replicated inside fn_auto_apply_jev_lead_decision so it
    // can be atomic with the revision guard and the audit insert.
    // No template step here: a new lead never auto-replies (PLAN D5). The
    // human follow-up owns the conversation.
    const applyResult = await applyJevLeadDecisionAtomically(supabase, {
      propertyId: input.propertyId,
      conversationId: input.conversationId,
      inboundMessageId: input.inboundMessageId,
      classificationRunId: classification.classificationRunId,
      outcome: "new_lead",
      nativeConfidence: classification.nativeConfidence,
      thresholdAtDecision: classification.thresholdAtDecision,
      thresholdVersion: classification.thresholdVersion,
      expectedRevision: classification.evaluationRevision,
    });
    if (
      applyResult.status === "applied" ||
      applyResult.status === "already_qualified" ||
      applyResult.status === "replayed"
    ) {
      await trace(supabase, {
        kind: "action",
        name: "promote_new_lead",
        result: "applied",
        detail: { status: applyResult.status },
      }, runCtx);
      if (applyResult.status === "applied") {
        await recordLeadEvent({
          propertyId: input.propertyId,
          actorType: "system",
          eventType: LEAD_EVENT_TYPES.QUALIFIED,
          payload: { from: "prospect", to: "new_lead" },
        });
      }
      // Hot seller (PR 2): the lead goes on My Leads under Jarrad (shared with the nine-question path).
      const handoffEscalation = await handOffHotLead(supabase, input.propertyId, responseClaim, runCtx, input.inboundMessageId);
      if (handoffEscalation) return { handled: true, outcome: handoffEscalation };
      const newLeadHoldOk = classification.askedHowNumberObtained
        // A new lead never auto-replies (PLAN D5), so the number-source reply
        // is not sent either; the lead's owner sees the question.
        ? await holdWithRetry(supabase, input.propertyId, `${NUMBER_SOURCE_NOT_SENT_PREFIX}outcome_new_lead`, runCtx)
        : true;
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: newLeadHoldOk ? "auto_closed" : "escalated",
        ...(newLeadHoldOk ? {} : { flagOk: false }),
      });
      return { handled: true, outcome: { outcome: "auto_closed", reason: "model:new_lead_promoted" } };
    }
    // dnc_locked / not_found / stale_decision_context / training_blocked /
    // error: never silently drop a Jev-detected new lead — surface it for
    // a human exactly like the below-threshold case above, rather than
    // treating a promotion failure as a skip.
    const reason = "jev_new_lead_promotion_failed";
    await trace(supabase, {
      kind: "action",
      name: "promote_new_lead",
      result: "error",
      detail: { status: applyResult.status },
    }, runCtx);
    let ourFlagAt: string | null = null;
    await markPropertyNeedsAttention(supabase, input.propertyId, reason, runCtx, NO_GUARD, (at) => {
      ourFlagAt = at;
    });
    await recordHotFailure(supabase, input.propertyId, input.inboundMessageId, reason, ourFlagAt);
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
      errorMessage: applyResult.status,
    });
    return { handled: true, outcome: { outcome: "escalated", reason } };
  }

  // Root review of dbbb12e6 (jev-root-autoapply-review.md, finding 2):
  // jev_no_action (Jev genuinely classified but landed on unclear/
  // bad_number — this kind is only ever reached in automatic mode;
  // shadow mode already returned use_legacy above resolvePolicyOutcome)
  // and jev_automatic_failed (HTTP failure/missing revision baseline/
  // unverifiable source message/audit-persist failure, automatic mode
  // only) must both create a durable, human-actionable item and stop
  // right here — falling through to `resolveAndApplyRoute` would run the
  // LEGACY classify+reply pipeline and apply an outcome with no trusted
  // Jev decision behind it, the exact human-decision-gate violation root
  // flagged. Deterministic STOP is unaffected — it's handled entirely
  // upstream of classification, in inbound.ts's matchesStopKeyword.
  if (classification.kind === "jev_no_action") {
    if (isHostileInbound(input.inboundBody)) {
      return { handled: true, outcome: await holdHostileForConfirm(supabase, input, responseClaim, runCtx) };
    }
    const reason = "jev_unclear_no_action";
    const flagOk4 = await markPropertyNeedsAttention(supabase, input.propertyId, reason, runCtx);
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
      flagOk: flagOk4,
    });
    return { handled: true, outcome: { outcome: "escalated", reason } };
  }

  if (classification.kind === "jev_automatic_failed") {
    const reason = `jev_automatic_failed:${classification.reason}`;
    const flagOk5 = await markPropertyNeedsAttention(supabase, input.propertyId, reason, runCtx);
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
      flagOk: flagOk5,
    });
    return { handled: true, outcome: { outcome: "escalated", reason } };
  }

  return { handled: false, classification };
}

/**
 * Jev-only mode (`ai_responder_configs.reply_generation = 'off'`): no LLM reply
 * is generated or sent. The conversation is held for a human with the reason
 * `needs_reply` so the seller is never silently unanswered.
 */
async function holdForNeedsReply(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  claimId: string | null,
  runCtx?: MaybeRunContext,
): Promise<AiDispatchOutcome> {
  await trace(supabase, {
    kind: "gate",
    name: "reply_generation_off",
    result: "block",
    detail: { reason: "needs_reply" },
  }, runCtx);
  const flagOk = await markPropertyNeedsAttention(supabase, input.propertyId, "needs_reply", runCtx);
  await completeClaim(supabase, input.propertyId, {
    claimId,
    outcome: "escalated",
    flagOk,
  });
  return { outcome: "escalated", reason: "needs_reply" };
}

async function resolveAndApplyRoute(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  property: AiDispatchPropertyGateRow,
  config: {
    model: string;
    system_prompt: string;
    min_confidence: number;
    outbound_mode?: string | null;
    reply_generation?: string | null;
  },
  deps: { anthropic: AnthropicLike },
  currentTurn: number,
  responseClaim: { claimId: string | null; startedAt?: string },
  classification: ClassificationBridgeResult,
  runCtx?: MaybeRunContext,
  /** Present only on the reply-eligible path: absent = no template step. */
  templateCtx?: TemplateStepContext,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  let generated: AiStructuredOutput;
  let route: ResponderRoute;
  let jevAutoAccept: { classificationRunId: string } | null = null;
  // Root review of 8361775a, jev-root-revision-review.md, 2026-09-20:
  // revision read before the Jev HTTP call started. undefined for legacy
  // (non-jev_route) classifications, which skip the check entirely.
  const jevRevision =
    classification.kind === "jev_route" ? classification.evaluationRevision : undefined;

  if (classification.kind === "jev_route") {
    generated = classification.assembled;
    route = classification.route;
    if (classification.eligibleForAutoAccept) {
      jevAutoAccept = { classificationRunId: classification.classificationRunId };
    }
  } else {
    // Jev-only mode: the owner turned LLM drafting off. This is the ONLY
    // place the legacy generator is called, so refusing here guarantees no
    // Anthropic call on any path. A human answers instead.
    if (config.reply_generation === "off") {
      return holdForNeedsReply(supabase, input, responseClaim.claimId, runCtx);
    }
    // use_legacy — jev_no_action is handled inline above (returns
    // handled: true before reaching resolveAndApplyRoute), so only
    // use_legacy falls through to the existing combined Claude
    // classify+generate call, unchanged from today. A hostile inbound is held
    // BEFORE the model is called: no LLM call, no automatic decision.
    if (isHostileInbound(input.inboundBody)) {
      return holdHostileForConfirm(supabase, input, responseClaim, runCtx);
    }
    const conversation = await loadConversation(
      supabase,
      input.propertyId,
      input.contactId,
      input.conversationId ?? null,
      input.inboundMessageId ?? null,
    );
    // Append the current inbound body explicitly. The webhook inserts the
    // inbound row before dispatching, so loadConversation excludes it by
    // id — otherwise the model would see the current message twice.
    conversation.push({ role: "user", content: input.inboundBody });

    try {
      generated = await generateAiReply(
        {
          model: config!.model,
          systemPrompt: config!.system_prompt,
          conversation,
        },
        { client: deps.anthropic },
      );
    } catch (e) {
      // Account-level provider failures (dead credits / dead key) are an
      // operator incident, not a code error: every inbound will fail the
      // same way until a human fixes the account. Distinct reasons make
      // the UI say what actually broke, and admins get notified (once per
      // 24h, not per reply) so a hot campaign can't silently lose its
      // first-responder for a whole morning (2026-06-12).
      const providerFailure = classifyProviderFailure(e);
      const reason =
        providerFailure === "billing"
          ? "provider_billing"
          : providerFailure === "auth"
            ? "provider_auth"
            : "generate_error";
      reportError(e, {
        tags: { surface: "ai_responder_generate", reason },
        extra: { propertyId: input.propertyId },
      });
      await markPropertyNeedsAttention(supabase, input.propertyId, reason, runCtx);
      if (providerFailure) {
        await notifyAdminsOfProviderFailure(supabase, {
          orgId: property.org_id,
          propertyId: input.propertyId,
          failure: providerFailure,
        });
      }
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: "escalated",
        errorMessage: reason,
      });
      return { outcome: "escalated", reason };
    }
    route = resolveResponderOutcome(generated);
  }
  if (isHostileInbound(input.inboundBody)) {
    // Hostile wording: hold for a person, whatever else the classifier decided
    // (close, nurture, wrong number, opt-out, dnc, a generated reply). Jarrad
    // (2026-10-08): no auto DNC decisions; only a bare carrier STOP keyword
    // (handled in the webhook before dispatch) suppresses automatically.
    return holdHostileForConfirm(supabase, input, responseClaim, runCtx);
  }
  const expectedDisposition: AiReviewDisposition | null =
    route.kind === "opt_out"
      ? "opted_out"
      : route.kind === "close_dnc"
        ? "dnc"
        : route.kind === "auto_close_wrong_number"
          ? "wrong_number"
          : route.kind === "auto_close" || route.kind === "deescalate_close"
            ? "not_interested"
            : null;
  if (expectedDisposition && input.inboundMessageId) {
    const existingReview = await findExistingAiDispositionReview(
      supabase,
      input.inboundMessageId,
    );
    if (
      !existingReview.ok &&
      expectedDisposition !== "opted_out" &&
      expectedDisposition !== "dnc"
    ) {
      const reason = "ai_disposition_replay_lookup_failed";
      await markPropertyNeedsAttention(supabase, input.propertyId, reason, runCtx);
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: "escalated",
        errorMessage: reason,
      });
      return { outcome: "escalated", reason };
    }
    if (
      existingReview.ok &&
      existingReview.disposition &&
      existingReview.disposition !== expectedDisposition &&
      expectedDisposition !== "opted_out" &&
      expectedDisposition !== "dnc"
    ) {
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: silentSkipClaimOutcome(0),
      });
      return silentSkip("replayed_other_disposition", 0);
    }
  }
  if (
    route.kind === "send_reply" &&
    generated.confidence < config!.min_confidence
  ) {
    const reason = `low_confidence:${generated.confidence}`;
    const flagOk6 = await markPropertyNeedsAttention(supabase, input.propertyId, reason, runCtx);
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
      flagOk: flagOk6,
    });
    return { outcome: "escalated", reason };
  }

  switch (route.kind) {
    case "escalate":
      // A Jev-classified new_lead below its org threshold also gets a
      // real jev_lead_decisions row (Needs-a-decision queue), not just
      // the generic attention flag — legacy Claude's own "needs_review"
      // escalate reasons have no Jev decision to record and skip this.
      if (classification.kind === "jev_route" && input.inboundMessageId) {
        await proposeJevLeadDecision(supabase, {
          propertyId: input.propertyId,
          conversationId: input.conversationId,
          inboundMessageId: input.inboundMessageId,
          classificationRunId: classification.classificationRunId,
          outcome: "new_lead",
          nativeConfidence: classification.nativeConfidence,
          thresholdAtDecision: classification.thresholdAtDecision,
          thresholdVersion: classification.thresholdVersion,
          expectedRevision: jevRevision!,
        });
      }
      const flagOk7 = await markPropertyNeedsAttention(
        supabase,
        input.propertyId,
        route.reason,
        runCtx,
      );
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: "escalated",
        flagOk: flagOk7,
      });
      return { outcome: "escalated", reason: route.reason };
    case "opt_out": {
      // HARD RULE (Jarrad, 2026-10-07: "I don't want you making any DNC
      // decisions. I don't want Jev making any DNC decisions."): a model
      // judgment never suppresses a phone. Jev's opted_out is ALWAYS deferred
      // to human review whatever its confidence or the automation switch
      // (thresholds.ts also refuses to auto-apply it); the legacy classifier's
      // opt_out only holds the lead. Suppression happens when a human
      // confirms (confirm-suppression.ts). The deterministic carrier STOP
      // keyword path in messaging/inbound.ts is the only automatic one.
      const isJevOptOut = classification.kind === "jev_route";
      if (!isJevOptOut) {
        return holdModelOptOutForHuman(supabase, {
          runCtx,
          propertyId: input.propertyId,
          claimId: responseClaim.claimId,
          reason: HOLD_MODEL_OPT_OUT_NEEDS_CONFIRM,
          routeReason: route.reason,
        });
      }
      const optOutResult = await proposeDeferredJevDisposition(supabase, {
        runContext: runCtx,
        propertyId: input.propertyId,
        conversationId: input.conversationId ?? null,
        inboundMessageId: input.inboundMessageId ?? null,
        classificationRunId: classification.classificationRunId,
        dispo: "opted_out",
        reason: route.reason,
        expectedRevision: jevRevision!,
        holdReason: HOLD_JEV_OPTED_OUT_NEEDS_CONFIRM,
      });
      await traceDisposition(supabase, "opted_out", optOutResult, true, runCtx);
      if (!optOutResult.updated) {
        const outcome = closeOutcome(optOutResult, route.reason);
        await completeClaim(supabase, input.propertyId, {
          claimId: responseClaim.claimId,
          outcome: claimOutcomeOf(outcome),
          errorMessage: dispositionClaimError(optOutResult),
        });
        return outcome;
      }
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: "opted_out",
      });
      return { outcome: "opted_out", reason: route.reason };
    }
    case "close_dnc": {
      // HARD RULE (Jarrad, 2026-10-07): no automated DNC decision. Jev's dnc
      // opens a pending review + holds the lead (`jev_dnc_needs_confirm`)
      // with NO phone suppression; the legacy classifier's dnc only holds
      // (`model_dnc_needs_confirm`). A human confirming the review is what
      // suppresses the phone (confirm-suppression.ts).
      if (classification.kind !== "jev_route") {
        return holdModelOptOutForHuman(supabase, {
          runCtx,
          propertyId: input.propertyId,
          claimId: responseClaim.claimId,
          reason: HOLD_MODEL_DNC_NEEDS_CONFIRM,
          routeReason: route.reason,
        });
      }
      const dncResult = await proposeJevDncForReview(supabase, {
        runContext: runCtx,
        propertyId: input.propertyId,
        conversationId: input.conversationId ?? null,
        inboundMessageId: input.inboundMessageId ?? null,
        classificationRunId: classification.classificationRunId,
        reason: route.reason,
        expectedRevision: jevRevision!,
      });
      await traceDisposition(supabase, "dnc", dncResult, true, runCtx);
      const dncOutcome = closeOutcome(dncResult, route.reason);
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: claimOutcomeOf(dncOutcome),
        errorMessage: dispositionClaimError(dncResult),
      });
      return dncOutcome;
    }
    case "auto_close_wrong_number":
      let wrongNumberTemplateMessageId: string | null = null;
      let wrongNumberStepHold: string | null = null;
      // The seller asked how we got the number AND is the wrong contact: the
      // wrong-number reply is not sent (it would not answer the question, and
      // the number-source reply is never sent to a wrong contact); a person looks.
      const wrongNumberNumberSourceAsked =
        classification.kind === "jev_route" && classification.askedHowNumberObtained;
      if (
        templateCtx &&
        !templateCtx.hostile &&
        !wrongNumberNumberSourceAsked &&
        classification.kind === "jev_route" &&
        classification.eligibleForAutoAccept &&
        classification.wrongScope === "this_property"
      ) {
        // Approved wrong-number reply (no promise to remove the number). The
        // wrong_number disposition applied below, for this property only, is
        // the whole effect. NO phone-level suppression here (Jarrad: no
        // automatic DNC decisions; phone-wide blocking is a person's call). Never sent for a scope other than an explicit
        // this_property (RULES-PROPOSAL 2.2 "Must NOT fire").
        const step = await runApprovedTemplateStep(supabase, {
          input,
          property,
          ctx: templateCtx,
          claim: responseClaim,
          outcome: "wrong_number",
          nativeConfidence: classification.nativeConfidence,
          escalationReason: classification.escalationReason,
          runCtx,
        });
        if (step.kind === "stop") return step.outcome;
        wrongNumberTemplateMessageId = step.outboundMessageId;
        wrongNumberStepHold = step.hold;
      }
      const isJevBelowThresholdWrongNumber = classification.kind === "jev_route" && !classification.eligibleForAutoAccept;
      const wrongNumberResult = isJevBelowThresholdWrongNumber
        ? await proposeDeferredJevDisposition(supabase, {
          runContext: runCtx,
            propertyId: input.propertyId,
            conversationId: input.conversationId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            classificationRunId: classification.classificationRunId,
            dispo: "wrong_number",
            reason: route.reason,
            expectedRevision: jevRevision!,
            wrongScope: route.scope,
          })
        : await applyWrongNumber(supabase, {
          runContext: runCtx,
            propertyId: input.propertyId,
            conversationId: input.conversationId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            scope: route.scope,
            reason: route.reason,
            expectedRevision: jevRevision,
            undo: jevAutoAccept
              ? { orgId: property.org_id, classificationRunId: jevAutoAccept.classificationRunId }
              : undefined,
          });
      await traceDisposition(
        supabase,
        "wrong_number",
        wrongNumberResult,
        isJevBelowThresholdWrongNumber,
        runCtx,
      );
      const wrongNumberOutcome = closeOutcome(wrongNumberResult, route.reason);
      // scope = all keeps its review pending: phone-wide suppression is a
      // human decision, so never auto-accept it.
      if (
        jevAutoAccept &&
        wrongNumberResult.updated &&
        input.inboundMessageId &&
        route.scope !== "all"
      ) {
        await maybeAutoAcceptJevReview(
          supabase,
          input.inboundMessageId,
          jevAutoAccept.classificationRunId,
        );
      }
      const wrongNumberHoldReason = wrongNumberNumberSourceAsked
        ? `${NUMBER_SOURCE_NOT_SENT_PREFIX}outcome_wrong_number`
        : wrongNumberStepHold;
      const wrongNumberHoldOk = wrongNumberHoldReason
        ? await holdWithRetry(supabase, input.propertyId, wrongNumberHoldReason, runCtx)
        : true;
      const wrongNumberClaimError = dispositionClaimError(wrongNumberResult);
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: wrongNumberHoldOk || wrongNumberClaimError ? claimOutcomeOf(wrongNumberOutcome) : "escalated",
        ...(wrongNumberHoldOk ? {} : { flagOk: false }),
        errorMessage: wrongNumberClaimError,
        ...(wrongNumberTemplateMessageId ? { outboundMessageId: wrongNumberTemplateMessageId } : {}),
      });
      return wrongNumberOutcome;
    case "auto_close":
      let autoCloseTemplateMessageId: string | null = null;
      let autoCloseNumberSourceHold: string | null = null;
      if (
        classification.kind === "jev_route" &&
        classification.eligibleForAutoAccept &&
        isSoldInbound(input.inboundBody)
      ) {
        // "Sold" wording (RULES-PROPOSAL 2.1, NI-1 "Must NOT fire"): the
        // not-interested check-back ask is wrong for a home that is gone, so
        // neither the template nor the automatic close goes out; a person
        // looks at it.
        await trace(supabase, {
          kind: "gate",
          name: "sold_hold",
          result: "block",
          detail: { reason: SOLD_NEEDS_HUMAN_REASON },
        }, runCtx);
        const soldFlagOk = await markPropertyNeedsAttention(
          supabase,
          input.propertyId,
          SOLD_NEEDS_HUMAN_REASON,
          runCtx,
        );
        await completeClaim(supabase, input.propertyId, {
          claimId: responseClaim.claimId,
          outcome: "escalated",
          flagOk: soldFlagOk,
        });
        return { outcome: "escalated", reason: SOLD_NEEDS_HUMAN_REASON };
      }
      if (
        templateCtx &&
        !templateCtx.hostile &&
        classification.kind === "jev_route" &&
        classification.eligibleForAutoAccept
      ) {
        // Approved-template reply before the terminal not-interested
        // disposition, which would suppress it (see runApprovedTemplateStep).
        const step = await runApprovedTemplateStep(supabase, {
          input,
          property,
          ctx: templateCtx,
          claim: responseClaim,
          outcome: "not_interested",
          nativeConfidence: classification.nativeConfidence,
          escalationReason: classification.escalationReason,
          askedHowNumberObtained: classification.askedHowNumberObtained,
          runCtx,
        });
        if (step.kind === "stop") return step.outcome;
        autoCloseTemplateMessageId = step.outboundMessageId;
        autoCloseNumberSourceHold = step.hold;
      } else if (classification.kind === "jev_route" && classification.askedHowNumberObtained) {
        // Asked, but no reply goes out here: below its cutoff, a hostile
        // inbound, or a dispatch that cannot send replies.
        autoCloseNumberSourceHold = `${NUMBER_SOURCE_NOT_SENT_PREFIX}${
          templateCtx?.hostile ? "hostile" : !templateCtx ? "reply_ineligible" : "below_cutoff"
        }`;
      }
      const isJevBelowThresholdAutoClose = classification.kind === "jev_route" && !classification.eligibleForAutoAccept;
      const autoCloseResult = isJevBelowThresholdAutoClose
        ? await proposeDeferredJevDisposition(supabase, {
          runContext: runCtx,
            propertyId: input.propertyId,
            conversationId: input.conversationId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            classificationRunId: classification.classificationRunId,
            dispo: route.dispo,
            reason: route.reason,
            expectedRevision: jevRevision!,
          })
        : await setResponderDispo(supabase, {
          runContext: runCtx,
            propertyId: input.propertyId,
            conversationId: input.conversationId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            dispo: route.dispo,
            reason: route.reason,
            expectedRevision: jevRevision,
            undo: jevAutoAccept
              ? { orgId: property.org_id, classificationRunId: jevAutoAccept.classificationRunId }
              : undefined,
          });
      await traceDisposition(
        supabase,
        route.dispo,
        autoCloseResult,
        isJevBelowThresholdAutoClose,
        runCtx,
      );
      const autoCloseOutcome = closeOutcome(autoCloseResult, route.reason);
      if (jevAutoAccept && autoCloseResult.updated && input.inboundMessageId) {
        await maybeAutoAcceptJevReview(
          supabase,
          input.inboundMessageId,
          jevAutoAccept.classificationRunId,
        );
      }
      const autoCloseHoldOk = autoCloseNumberSourceHold
        ? await holdWithRetry(supabase, input.propertyId, autoCloseNumberSourceHold, runCtx)
        : true;
      const autoCloseClaimError = dispositionClaimError(autoCloseResult);
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: autoCloseHoldOk || autoCloseClaimError ? claimOutcomeOf(autoCloseOutcome) : "escalated",
        ...(autoCloseHoldOk ? {} : { flagOk: false }),
        errorMessage: autoCloseClaimError,
        ...(autoCloseTemplateMessageId ? { outboundMessageId: autoCloseTemplateMessageId } : {}),
      });
      return autoCloseOutcome;
    case "send_reply":
    case "deescalate_close": {
      const bodyResult = await resolveOutboundBody(supabase, {
        route,
        contactId: input.contactId,
        model: config!.model,
        anthropic: deps.anthropic,
      });
      const safety = validateAiReplyBody(bodyResult.body);
      if (!safety.ok) {
        const reason = `safety:${safety.reason}`;
        await trace(supabase, {
          kind: "gate",
          name: "safety",
          result: "block",
          detail: { reason: safety.reason },
        }, runCtx);
        const flagOk8 = await markPropertyNeedsAttention(supabase, input.propertyId, reason, runCtx);
        await completeClaim(supabase, input.propertyId, {
          claimId: responseClaim.claimId,
          outcome: "escalated",
          flagOk: flagOk8,
        });
        return { outcome: "escalated", reason };
      }
      await trace(supabase, { kind: "gate", name: "safety", result: "pass" }, runCtx);

      return deliverRoutedReply(supabase, {
        input,
        property,
        config,
        currentTurn,
        responseClaim,
        runCtx,
        reply: {
          kind: route.kind,
          body: bodyResult.body,
          confidence: generated.confidence,
          sentiment: generated.sentiment,
          ...(route.kind === "deescalate_close" ? { closeReason: route.reason } : {}),
        },
      });
    }
    default:
      return assertNeverRoute(route);
  }
}


/**
 * The AI reply row that matters for a duplicate-insert on this inbound. Several
 * rows can carry the stamp, so rank them: a row the provider accepted
 * (sent / delivered) beats an in-flight one (pending / queued), which beats a
 * failed one. `status` matters: a `pending` row is an in-flight (or
 * abandoned) attempt, not a delivered reply. `aborted` = the row was retired
 * before the provider (`metadata.abortedBeforeProvider`).
 */
async function findExistingAiReplyForInbound(
  supabase: SupabaseClient<Database>,
  inboundMessageId: string,
): Promise<ExistingAiReply | null> {
  const result = await lookupAiReplyForInbound(supabase, inboundMessageId);
  return result.ok ? result.reply : null;
}

type ExistingAiReply = {
  id: string;
  status: string;
  aborted: boolean;
  /** Failed row whose provider outcome is ambiguous (the text may have gone out). */
  providerUnknown: boolean;
};

/**
 * Same ranking as `findExistingAiReplyForInbound`, but a database error is
 * `{ ok: false }` (lookup failure), never conflated with "no reply exists".
 */
async function lookupAiReplyForInbound(
  supabase: SupabaseClient<Database>,
  inboundMessageId: string,
): Promise<{ ok: true; reply: ExistingAiReply | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, status, metadata")
    .eq("channel", "sms")
    .eq("direction", "outbound")
    .contains("metadata", {
      generated_by: "ai_responder_v1",
      inbound_message_id: inboundMessageId,
    })
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_existing_reply_lookup" },
      extra: { inboundMessageId },
    });
    return { ok: false };
  }
  const rank = (status: string) =>
    status === "sent" || status === "delivered" ? 0 : status === "pending" || status === "queued" ? 1 : 2;
  const rows = (data ?? []).map((r) => ({
    id: r.id,
    status: r.status,
    aborted: (() => {
      const meta = readJsonObject((r.metadata ?? null) as Json | null);
      return meta.abortedBeforeProvider === true || meta.aborted_inbound_message_id !== undefined;
    })(),
    providerUnknown: readJsonObject((r.metadata ?? null) as Json | null).providerOutcome === "provider_unknown",
  }));
  rows.sort((l, r) => rank(l.status) - rank(r.status));
  return { ok: true, reply: rows[0] ?? null };
}

/**
 * A claim refused at dispatch. `already_replied` is a finished reply (silent).
 * `already_claimed` on a RETRY is never silent: the retry exists because the
 * seller is unanswered, and nobody else is known to be on it, so flag a human.
 */
async function refusedClaimOutcome(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  reason: "already_claimed" | "already_replied",
  orgId: string,
  runCtx?: MaybeRunContext,
): Promise<AiDispatchOutcome> {
  if (reason === "already_claimed" && (input.retryAttempt ?? 0) > 0) {
    await trace(supabase, {
      kind: "gate",
      name: "claim_refused_on_retry",
      result: "block",
      detail: { attempt: input.retryAttempt ?? 0 },
    }, runCtx);
    // Q8 rule 7: the carried reply (when there is one) is dead-lettered with
    // the flag; a failed dead letter changes the flag to dead_letter_failed.
    await flagAndDeadLetter(supabase, {
      runContext: runCtx,
      orgId: input.retryReply?.orgId ?? orgId,
      conversationId: input.conversationId ?? null,
      propertyId: input.propertyId,
      inboundMessageId: input.inboundMessageId ?? null,
      body: input.retryReply?.body ?? null,
      reason: "claim_refused_on_retry",
      flagReason: "reply_skipped:claim_refused_on_retry",
    });
  }
  return {
    outcome: "skipped",
    reason: reason === "already_replied" ? "already_replied" : "already_claimed",
  };
}

/**
 * Claim bookkeeping for the outcome of a send. A `retry` parks the claim in
 * `error` with its lease expired so the re-dispatch can reclaim it at once. If
 * that write fails it is retried through a dedicated lease-expiry update; if
 * THAT fails too, the retry could never run, so it is NOT scheduled: the reply
 * is dead-lettered and the property flagged immediately.
 */
async function settleClaimForSendOutcome(
  supabase: SupabaseClient<Database>,
  claimId: string | null,
  outcome: ResponderSendOutcome,
  ctx: {
    orgId: string;
    input: AiDispatchInput;
    body: string;
    runContext?: MaybeRunContext;
  },
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  if (outcome.outcome !== "retry") {
    await completeClaim(supabase, ctx.input.propertyId, {
      claimId,
      outcome: claimOutcomeOf(outcome),
      outboundMessageId: outcome.outcome === "sent" ? outcome.messageId : null,
      flagOk: !flagFailedOf(outcome),
    });
    return outcome;
  }
  const errorMessage = retryableClaimError(outcome)!;
  let released = await completeClaim(supabase, ctx.input.propertyId, {
    claimId,
    outcome: outcome.outcome,
    errorMessage,
    releaseLease: true,
  });
  if (!released) {
    released = await expireAiResponseClaimLease(supabase, { claimId, errorMessage });
  }
  if (released) return outcome;

  await trace(supabase, {
    kind: "gate",
    name: "retry_unschedulable",
    result: "error",
    detail: { reason: outcome.reason, attempt: outcome.attempt },
  }, ctx.runContext);
  await flagAndDeadLetter(supabase, {
    runContext: ctx.runContext,
    orgId: ctx.orgId,
    conversationId: ctx.input.conversationId ?? null,
    propertyId: ctx.input.propertyId,
    inboundMessageId: ctx.input.inboundMessageId ?? null,
    body: ctx.body,
    reason: outcome.reason,
    flagReason: flagForRetryReason(outcome.reason),
  });
  // Best effort: stop the claim reading as a live retry.
  await completeClaim(supabase, ctx.input.propertyId, {
    claimId,
    outcome: "escalated",
    errorMessage: "retry_unschedulable",
  });
  return { outcome: "escalated", reason: outcome.reason };
}

/**
 * Rule 8 evidence: what a human did to the draft(s) stored for this inbound.
 * `error` is a failed lookup (callers fail closed).
 */
async function loadDraftState(
  supabase: SupabaseClient<Database>,
  inboundMessageId: string,
): Promise<"resolved" | "pending" | "none" | "error"> {
  const { data, error } = await supabase
    .from("ai_reply_drafts")
    .select("id, status")
    .eq("inbound_message_id", inboundMessageId)
    .limit(20);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_draft_state_lookup" },
      extra: { inboundMessageId },
    });
    return "error";
  }
  return decideDraftGate((data ?? []).map((d) => d.status));
}

/**
 * Retry shortcut for a retry that has NO carried reply (so it re-runs the
 * normal pipeline): a draft already stored for the inbound ends the retry as
 * held. A discarded / sent draft ends it silently (rule 8). Null = fall through.
 */
async function reuseForRetry(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  responseClaim: { claimId: string | null; startedAt?: string },
  runCtx?: MaybeRunContext,
): Promise<AiDispatchOutcome | null> {
  if (!input.inboundMessageId) return null;
  const draft = await loadDraftState(supabase, input.inboundMessageId);
  if (draft === "resolved") return endAsAlreadyAnswered(supabase, responseClaim.claimId, runCtx);
  if (draft === "pending") return holdExistingDraft(supabase, input, responseClaim.claimId, runCtx);
  return null;
}

async function endAsAlreadyAnswered(
  supabase: SupabaseClient<Database>,
  claimId: string | null,
  runCtx?: MaybeRunContext,
): Promise<AiDispatchOutcome> {
  await trace(supabase, { kind: "gate", name: "already_answered", result: "pass", detail: { rule: 8 } }, runCtx);
  await completeAiResponseClaim(supabase, { claimId, outcome: silentSkipClaimOutcome(8) });
  return silentSkip("already_answered", 8);
}

async function holdExistingDraft(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  claimId: string | null,
  runCtx?: MaybeRunContext,
): Promise<AiDispatchOutcome> {
  await trace(supabase, {
    kind: "hold",
    name: "llm_draft_held",
    result: "held",
    detail: { reused: true, attempt: input.retryAttempt ?? 0 },
  }, runCtx);
  const flagOk = await markPropertyNeedsAttention(supabase, input.propertyId, "draft_held", runCtx);
  await completeClaim(supabase, input.propertyId, { claimId, outcome: "escalated", flagOk });
  return { outcome: "escalated", reason: "draft_held" };
}

/**
 * A retry carrying the reply the previous attempt generated. Order: claim ->
 * terminal draft state (rule 8; a pending draft stays held) -> pacing gates ->
 * the send (the pre-send Q8 table runs under the lease in `sendResponderMessage`).
 *
 * A reply-pacing gate (max turns, business hours) or a suppression that
 * trips during the retry gap must not drop the reply silently: pacing gates
 * HOLD the reply as a draft and flag a human with the text dead-lettered
 * (Q8 rule 7); suppression / human-takeover / org-off end quietly (the AI is
 * not allowed to answer at all).
 */
async function retryWithCarriedReply(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  property: AiDispatchPropertyGateRow,
  config:
    | {
        active: boolean;
        business_hours_only: boolean;
        max_turns: number;
        model: string;
        outbound_mode?: string | null;
        reply_generation?: string | null;
      }
    | null
    | undefined,
  runCtx?: MaybeRunContext,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const carried = input.retryReply!;
  const claimStartedAt = new Date().toISOString();
  const responseClaim = await claimAiResponse(supabase, {
    orgId: property.org_id,
    inboundMessageId: input.inboundMessageId,
    propertyId: input.propertyId,
    contactId: input.contactId,
    conversationId: input.conversationId ?? null,
  });
  await traceClaim(supabase, responseClaim, runCtx);
  if (!responseClaim.claimed) {
    return refusedClaimOutcome(supabase, input, responseClaim.reason, property.org_id, runCtx);
  }
  const claim = { claimId: responseClaim.claimId, startedAt: claimStartedAt };

  if (input.inboundMessageId) {
    const draft = await loadDraftState(supabase, input.inboundMessageId);
    if (draft === "resolved") return endAsAlreadyAnswered(supabase, claim.claimId, runCtx);
    if (draft === "pending") return holdExistingDraft(supabase, input, claim.claimId, runCtx);
    if (draft === "error") {
      const flagged1 = await flagAndDeadLetter(supabase, {
        runContext: runCtx,
        orgId: property.org_id,
        conversationId: input.conversationId ?? null,
        propertyId: input.propertyId,
        inboundMessageId: input.inboundMessageId ?? null,
        body: carried.body,
        reason: "send_check_failed",
      });
      await completeClaim(supabase, input.propertyId, {
        claimId: claim.claimId,
        outcome: "escalated",
        flagOk: flagged1.flagged,
      });
      return { outcome: "escalated", reason: "send_check_failed" };
    }
  }

  const consentLookup = await getConsentStateStrict(supabase, input.contactId, "sms");
  const consentState = consentLookup.ok ? consentLookup.state : null;
  const countedTurns = await countAiTurnsInThread(
    supabase,
    input.propertyId,
    input.contactId,
    input.conversationId ?? null,
  );
  if (countedTurns === null || consentState === null) {
    // Rule 7: the turn count could not be read. A reply exists (carried), so
    // dead-letter it and flag; the claim completes as handled-by-flag only if
    // the flag persisted (see `completeClaim`).
    const flagged3 = await flagAndDeadLetter(supabase, {
      runContext: runCtx,
      orgId: property.org_id,
      conversationId: input.conversationId ?? null,
      propertyId: input.propertyId,
      inboundMessageId: input.inboundMessageId ?? null,
      body: carried.body,
      reason: "send_check_failed",
    });
    await completeClaim(supabase, input.propertyId, {
      claimId: claim.claimId,
      outcome: "escalated",
      flagOk: flagged3.flagged,
    });
    return { outcome: "escalated", reason: "send_check_failed" };
  }
  const currentTurn = countedTurns;
  const skip = classifyAiSkip({
    config: config
      ? {
          active: config.active,
          business_hours_only: config.business_hours_only,
          max_turns: config.max_turns,
        }
      : null,
    consentState,
    propertyDisabled: property.ai_responder_disabled,
    currentTurn,
    withinBusinessHours: checkQuietHours(property.state).ok,
  });
  await trace(
    supabase,
    skip.skip
      ? { kind: "gate", name: "ai_skip", result: "block", detail: { reason: skip.reason, retry: true } }
      : { kind: "gate", name: "ai_skip", result: "pass", detail: { retry: true } },
    runCtx,
  );
  if (skip.skip) {
    if (skip.reason === "max_turns_reached" || skip.reason === "outside_business_hours") {
      const sendArgs = replySendArgs({
        input,
        orgId: property.org_id,
        model: config?.model ?? "",
        turn: currentTurn + 1,
        claimStartedAt,
        outboundMode: config?.outbound_mode,
        runContext: runCtx,
        reply: carried,
      });
      const persisted = await persistHeldDraft(supabase, sendArgs);
      if (persisted === "already_resolved") return endAsAlreadyAnswered(supabase, claim.claimId, runCtx);
      const flagged2 = await flagAndDeadLetter(supabase, {
        runContext: runCtx,
        orgId: property.org_id,
        conversationId: input.conversationId ?? null,
        propertyId: input.propertyId,
        inboundMessageId: input.inboundMessageId ?? null,
        body: carried.body,
        reason: skip.reason,
        flagReason: `reply_skipped:${skip.reason}`,
      });
      await completeClaim(supabase, input.propertyId, {
        claimId: claim.claimId,
        outcome: "escalated",
        flagOk: flagged2.flagged,
      });
      return { outcome: "escalated", reason: skip.reason };
    }
    // Every remaining skip reason here is a rule-0 exit (suppression / off).
    await completeClaim(supabase, input.propertyId, {
      claimId: claim.claimId,
      outcome: silentSkipClaimOutcome(0),
    });
    return silentSkip(skip.reason, 0);
  }

  // Jev-only mode: a reply generated before drafting was turned off is not
  // sent either; a human answers. Checked only after the skip gate so
  // opt-out / suppression / takeover / disabled still end quietly.
  if (config?.reply_generation === "off") {
    return holdForNeedsReply(supabase, input, claim.claimId, runCtx);
  }

  await trace(supabase, {
    kind: "action",
    name: "retry_reply_reused",
    result: "applied",
    detail: { attempt: input.retryAttempt ?? 0 },
  }, runCtx);
  return deliverRoutedReply(supabase, {
    input,
    property,
    config: { model: config!.model, outbound_mode: config!.outbound_mode },
    currentTurn,
    responseClaim: claim,
    runCtx,
    reply: {
      kind: carried.kind,
      body: carried.body,
      confidence: carried.confidence,
      sentiment: carried.sentiment,
      ...(carried.closeReason ? { closeReason: carried.closeReason } : {}),
    },
  });
}

/** A retry with no reply to carry (gate-time rule-4 wait): re-dispatch later. */
async function retryBeforeGeneration(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  orgId: string,
  runCtx?: MaybeRunContext,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const attempt = input.retryAttempt ?? 0;
  if (attempt < REPLY_RETRY_MAX) {
    return {
      outcome: "retry",
      reason: "reply_pending",
      attempt: attempt + 1,
      delaySeconds: REPLY_RETRY_DELAY_SECONDS,
    };
  }
  // Competitor still queued after the last attempt: flag a human (no reply was
  // generated yet, so there is no text to dead-letter).
  await flagAndDeadLetter(supabase, {
    runContext: runCtx,
    orgId,
    conversationId: input.conversationId ?? null,
    propertyId: input.propertyId,
    inboundMessageId: input.inboundMessageId ?? null,
    body: null,
    reason: "reply_pending",
    flagReason: flagForRetryReason("reply_pending"),
  });
  return { outcome: "escalated", reason: "reply_pending" };
}

/** Send a resolved, safety-checked reply and settle the claim. */
/** What the template step needs from the dispatch that is not on the input. */
type TemplateStepContext = {
  model: string;
  outboundMode?: string | null;
  currentTurn: number;
  claimStartedAt: string | null;
  /**
   * The inbound is hostile (`isHostileInbound`): the not-interested, nurture
   * and wrong-number templates must never go out for this message.
   */
  hostile?: boolean;
};

export type TemplateStepResult =
  /**
   * Carry on with today's flow (apply the outcome); `outboundMessageId` when a
   * template went out. A template that was refused or held (quiet hours, hold
   * mode, any gate) also continues, with no message id: see the doc below.
   * `replyKey` is the mapping key of the template that went out (`number_source`
   * when it replaced the outcome's own reply), else null: anything that
   * enrols a drip off this reply (nurture) must check `replyKey === "nurture"`.
   * `hold` is a flag reason the caller sets AFTER the outcome is applied: the
   * awaiting-answer hold when the number-source reply went out, or
   * `number_source_reply_not_sent:<reason>` when the seller asked but it did not.
   */
  | { kind: "continue"; outboundMessageId: string | null; replyKey: TemplateReplyKey | null; hold: string | null; notSentReason?: string }
  /** A contended send was parked for retry: do NOT apply the outcome yet (the re-dispatch re-runs this step). */
  | { kind: "stop"; outcome: AiDispatchOutcome | AiRetryOutcome };

/**
 * Template step (Messages v2 Phase 4, PLAN D5 / 4.6). When Jev's outcome maps
 * to an active, human-approved library template, Jev reports no human
 * follow-up, and the outcome's switch is on and its confidence clears the
 * cutoff, send that template through the same `sendResponderMessage`
 * chokepoint (Q8 gate, reservation, fence, consent, suppression, recipient
 * quiet hours) with `source: approved_template`. Otherwise `continue` with no
 * message: today's behaviour is untouched.
 *
 * The reply goes out BEFORE the outcome is applied: nurture and a terminal
 * not-interested disposition both suppress automated sends, so replying after
 * the effect would always be refused. Jev Noul checks are not run: the text is
 * a pre-approved library template, not an LLM draft.
 *
 * A template that is NOT sent never blocks the outcome (Q5/Q6: at or above the
 * threshold the outcome applies). When the send cannot happen now (the owner's
 * `outbound_mode = hold`, or the recipient's quiet hours / Florida cap) the
 * template is DROPPED, not queued: nothing is flagged or stored, the trace
 * records what was withheld, and the outcome is applied as it would have been
 * without a template. Dropped rather than held because the applied outcome
 * makes a later automated reply moot (nurture is human-owned; not_interested is
 * terminal) and because a held draft or dead letter flags the property, which
 * makes the disposition RPC skip the very outcome we must apply. Any refusal
 * inside the send path itself (a Q8 gate, a fence, a timeout) keeps its own
 * flag / dead letter as the human-visible record and the step still continues
 * to the outcome (nurture applies; the disposition RPC's existing rule that a
 * flagged property is left to the human still governs not_interested). Only a
 * contended send (`retry`) stops here, because the re-dispatch re-runs this
 * step with the outcome still unapplied.
 *
 * Crash safety: the sent message id is written to the dispatch claim before
 * the outcome is applied (`recordClaimTemplateSent`); a claim that still holds
 * it past its lease is swept and flagged (`template_sent_outcome_missing`),
 * and a re-dispatch of the same claim never sends the template twice.
 */
/** Silent (unflagged) skip reason: the template was revoked / edited before the send. */
const TEMPLATE_APPROVAL_CHANGED = "template_approval_changed";
const TEMPLATE_QUIET_HOURS_RECIPIENT = "quiet_hours_recipient_at_send";

/** Trace-only drop reason (not a hold/flag reason). */
const TEMPLATE_DROP_DELAY_UNAVAILABLE = "delay_unavailable";

/** Not-sent reason: this approved template (or its exact text) already went to this property. */
export const TEMPLATE_ALREADY_SENT = "template_already_sent";
/** A-2 C3: a v2 reply cancelled because our own older auto reply went out after its inbound. */
export const V2_OLDER_AUTO_REPLY_SENT = "v2_older_auto_reply_sent";
/** Hold written by the eight-answer path for a repeat (a known `reply_skipped:` reason). */
const TEMPLATE_ALREADY_SENT_HOLD = `reply_skipped:${TEMPLATE_ALREADY_SENT}`;

/**
 * "yes" when an outbound on this property already carried this template id or this exact
 * body, "no" when none did, "error" when either lookup failed (callers fail closed).
 * A row that failed before reaching the provider (status failed, no external id) never
 * went out and does not count; pending / unknown / sent rows do.
 */
/** The approved not-interested text went out to this property and the provider accepted it. */
async function notInterestedReplyAccepted(
  supabase: SupabaseClient<Database>,
  orgId: string,
  propertyId: string,
): Promise<"yes" | "no" | "error"> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, status, external_id")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("direction", "outbound")
    .eq("body", APPROVED_REPLY_TEXTS.not_interested);
  if (error || !Array.isArray(data)) return "error";
  return data.some((r) => !!r.external_id && (r.status === "sent" || r.status === "delivered")) ? "yes" : "no";
}

async function templateAlreadySentToProperty(
  supabase: SupabaseClient<Database>,
  orgId: string,
  propertyId: string,
  templateId: string | null,
  body: string,
): Promise<"yes" | "no" | "error"> {
  const neverSent = (r: { status: string | null; external_id: string | null }) => r.status === "failed" && !r.external_id;
  const base = () =>
    supabase
      .from("messages")
      .select("id, status, external_id")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("direction", "outbound");
  if (templateId) {
    const byTemplate = await base().eq("metadata->>template_id", templateId);
    if (byTemplate.error || !Array.isArray(byTemplate.data)) return "error";
    if (byTemplate.data.some((r) => !neverSent(r))) return "yes";
  }
  const byBody = await base().eq("body", body);
  if (byBody.error || !Array.isArray(byBody.data)) return "error";
  return byBody.data.some((r) => !neverSent(r)) ? "yes" : "no";
}

/**
 * A fixed reply (template or identity text) this property already received: send nothing,
 * trace the skip, hold for a person, settle the claim as escalated.
 */
async function holdRepeatedReply(
  supabase: SupabaseClient<Database>,
  a: {
    input: AiDispatchInput;
    claimId: string | null;
    holdReason: string;
    lookup: "yes" | "error";
    detail: Record<string, unknown>;
    runCtx?: MaybeRunContext;
  },
): Promise<AiDispatchOutcome> {
  await trace(supabase, {
    kind: "reply",
    name: "template_reply",
    result: "skipped",
    detail: { ...a.detail, reason: TEMPLATE_ALREADY_SENT, ...(a.lookup === "error" ? { lookup: "failed" } : {}) },
  }, a.runCtx);
  const flagOk = await holdWithRetry(supabase, a.input.propertyId, a.holdReason, a.runCtx);
  await completeClaim(supabase, a.input.propertyId, { claimId: a.claimId, outcome: "escalated", flagOk });
  return { outcome: "escalated", reason: a.holdReason };
}

export async function runApprovedTemplateStep(
  supabase: SupabaseClient<Database>,
  a: {
    input: AiDispatchInput;
    property: AiDispatchPropertyGateRow;
    ctx: TemplateStepContext;
    claim: { claimId: string | null };
    outcome: Extract<TemplateReplyKey, "nurture" | "not_interested" | "wrong_number">;
    nativeConfidence: number | null;
    /** Jev's human-follow-up answer; only `not_applicable` allows a template. */
    escalationReason: JevEscalationReason | null;
    /**
     * Jev said the seller asked how we got their number. When true and an
     * approved `number_source` template is mapped, THAT template is sent
     * instead of the outcome's own (one reply, never two). Otherwise nothing
     * changes.
     */
    askedHowNumberObtained?: boolean;
    /** Messages v2 PR 3: decided by the nine questions (see resolveApprovedTemplateReply). */
    decidedBy?: "nine_questions";
    /**
     * The exact approved text. When set, the final rendered body must equal it
     * byte for byte or nothing is sent (`reply_text_not_approved`).
     */
    requiredBody?: string;
    /**
     * Nine-question reply_and_drip only: a refusal ONLY because a send window is closed
     * (property quiet hours in the send pipeline, recipient window in the send path or at
     * the provider fence) comes back as `skipped:${NINE_WINDOW_CLOSED}` with no flag or
     * dead letter, so the caller can defer it. Florida cap / unknown state still hold.
     */
    windowDeferrable?: boolean;
    runCtx?: MaybeRunContext;
  },
): Promise<TemplateStepResult> {
  const { input, property, ctx, claim, runCtx } = a;
  const resolveFor = (mappingKey?: typeof NUMBER_SOURCE_REPLY_KEY) =>
    resolveApprovedTemplateReply(supabase, {
      orgId: property.org_id,
      propertyId: input.propertyId,
      contactId: input.contactId,
      outcome: a.outcome,
      ...(mappingKey ? { mappingKey } : {}),
      outcomeConfidence: a.nativeConfidence,
      escalationReason: a.escalationReason,
      // The responder does not ask Jev for a reply intent yet, so only
      // any-intent mappings match until it does.
      replyIntent: null,
      ...(a.decidedBy ? { decidedBy: a.decidedBy } : {}),
    });
  const asked = a.askedHowNumberObtained === true;
  const notSent = (reason: string) => (asked ? `${NUMBER_SOURCE_NOT_SENT_PREFIX}${reason}` : null);
  // When the seller asked how we got the number, the approved number-source
  // reply is the ONLY template that may answer: if it cannot go out, the
  // outcome's own template is NOT sent in its place (it would not answer the
  // question); the caller holds the conversation for a person instead.
  const resolved = asked ? await resolveFor(NUMBER_SOURCE_REPLY_KEY) : await resolveFor();
  if (resolved.kind === "none") {
    if (
      asked ||
      resolved.reason === "human_follow_up" ||
      resolved.reason === "template_unavailable" ||
      resolved.reason === "render_failed" ||
      resolved.reason === "lookup_failed"
    ) {
      await trace(supabase, {
        kind: "reply",
        name: "template_reply",
        result: "skipped",
        detail: { outcome: a.outcome, reason: resolved.reason, ...(asked ? { replyKey: NUMBER_SOURCE_REPLY_KEY } : {}) },
      }, runCtx);
    }
    return { kind: "continue", outboundMessageId: null, replyKey: null, hold: notSent(resolved.reason), notSentReason: resolved.reason };
  }

  if (a.requiredBody !== undefined && resolved.body !== a.requiredBody) {
    await trace(supabase, {
      kind: "reply",
      name: "template_reply",
      result: "skipped",
      detail: { outcome: a.outcome, templateId: resolved.templateId, mappingId: resolved.mappingId, reason: NINE_REPLY_TEXT_NOT_APPROVED },
    }, runCtx);
    return { kind: "continue", outboundMessageId: null, replyKey: null, hold: null, notSentReason: NINE_REPLY_TEXT_NOT_APPROVED };
  }
  // The randomized reply delay was bypassed (workflow could not start): never
  // send a template instantly. Drop it; the outcome still applies.
  if (input.replyDelayBypassed) {
    const bypassReason = input.replyDelayBypassReason ?? TEMPLATE_DROP_DELAY_UNAVAILABLE;
    await trace(supabase, {
      kind: "reply",
      name: "template_reply",
      result: "skipped",
      detail: {
        outcome: a.outcome,
        templateId: resolved.templateId,
        mappingId: resolved.mappingId,
        reason: bypassReason,
        disposition: "dropped_outcome_applies",
      },
    }, runCtx);
    return { kind: "continue", outboundMessageId: null, replyKey: null, hold: notSent(bypassReason), notSentReason: bypassReason };
  }
  const replyKey: TemplateReplyKey = resolved.key ?? resolved.outcome;
  const sentHold = replyKey === NUMBER_SOURCE_REPLY_KEY ? NUMBER_SOURCE_AWAITING_ANSWER_REASON : null;

  // Cannot send right now (owner's draft-only switch, or the recipient's clock /
  // Florida cap): DROP the template and carry on so the outcome applies (Q5/Q6).
  // Done here, before any side effect, because a refused send flags the property
  // and a flagged property is skipped by the disposition RPC. The outcome has
  // made a later automated reply moot (nurture is human-owned; not_interested is
  // terminal), so nothing is queued; the trace records what was withheld.
  const dropReason = await templateSendBlockedNow(supabase, input, ctx);
  if (dropReason) {
    await trace(supabase, {
      kind: "reply",
      name: "template_reply",
      result: "held",
      detail: {
        outcome: a.outcome,
        templateId: resolved.templateId,
        mappingId: resolved.mappingId,
        reason: dropReason,
        disposition: "dropped_outcome_applies",
      },
    }, runCtx);
    return { kind: "continue", outboundMessageId: null, replyKey: null, hold: notSent(dropReason), notSentReason: dropReason };
  }

  // A crashed earlier run of this claim may already have sent the template:
  // never send it twice. An unreadable claim fails closed (no second send).
  const alreadySent = await loadClaimTemplateSent(supabase, claim.claimId);
  if (alreadySent !== null) {
    await trace(supabase, {
      kind: "reply",
      name: "template_reply",
      result: "skipped",
      detail: {
        outcome: a.outcome,
        reason: alreadySent === "error" ? "claim_unreadable" : "already_sent",
        templateId: resolved.templateId,
      },
    }, runCtx);
    return alreadySent === "error"
      ? { kind: "continue", outboundMessageId: null, replyKey: null, hold: notSent("claim_unreadable"), notSentReason: "claim_unreadable" }
      : { kind: "continue", outboundMessageId: alreadySent, replyKey, hold: sentHold };
  }

  // Never repeat an approved template on the same property (owner rule): when this
  // template, or the same text, already went out here, nothing is sent and a person
  // looks. An unreadable history fails closed the same way.
  const repeat = await templateAlreadySentToProperty(supabase, property.org_id, input.propertyId, resolved.templateId, resolved.body);
  if (repeat !== "no") {
    await trace(supabase, {
      kind: "reply",
      name: "template_reply",
      result: "skipped",
      detail: {
        outcome: a.outcome,
        templateId: resolved.templateId,
        mappingId: resolved.mappingId,
        reason: TEMPLATE_ALREADY_SENT,
        ...(repeat === "error" ? { lookup: "failed" } : {}),
      },
    }, runCtx);
    return {
      kind: "continue",
      outboundMessageId: null,
      replyKey: null,
      hold: notSent(TEMPLATE_ALREADY_SENT) ?? TEMPLATE_ALREADY_SENT_HOLD,
      notSentReason: TEMPLATE_ALREADY_SENT,
    };
  }

  let recorded = true;
  let markerWrites = 0;
  const sent = await sendResponderMessage(supabase, {
    runContext: runCtx,
    input,
    ...(a.windowDeferrable ? { windowDeferrable: true } : {}),
    body: resolved.body,
    model: ctx.model,
    confidence: a.nativeConfidence ?? 1,
    sentiment: "neutral",
    turn: ctx.currentTurn + 1,
    source: "approved_template",
    templateId: resolved.templateId,
    templateSource: resolved.source,
    replyKey,
    orgId: property.org_id,
    claimStartedAt: ctx.claimStartedAt,
    outboundMode: ctx.outboundMode,
    replyKind: "send_reply",
    // Written the instant the provider accepts, ahead of every other
    // post-send write, so the sweeper can see a crash from here on.
    onProviderAccepted: async (messageId) => {
      markerWrites += 1;
      recorded = await recordClaimTemplateSent(supabase, {
        claimId: claim.claimId,
        outboundMessageId: messageId,
      });
    },
  });
  // Durable BEFORE anything else (even the trace) once the provider accepted:
  // this is the only thing that lets the sweeper see a crash from here on. If
  // the write fails the sweeper cannot see one, so tell a human now rather
  // than risk silence.
  if (sent.outcome === "sent" && markerWrites === 0) {
    // The send path did not report acceptance (should not happen); record now.
    recorded = await recordClaimTemplateSent(supabase, {
      claimId: claim.claimId,
      outboundMessageId: sent.messageId,
    });
  }
  const detail = {
    templateId: resolved.templateId,
    mappingId: resolved.mappingId,
    outcome: a.outcome,
    ...(resolved.key === NUMBER_SOURCE_REPLY_KEY ? { replyKey: resolved.key } : {}),
    sendOutcome: sent.outcome,
    ...(sent.outcome === "sent" ? { outboundMessageId: sent.messageId } : {}),
    ...("reason" in sent && sent.reason ? { reason: sent.reason } : {}),
  };
  await trace(supabase, {
    kind: "reply",
    name: "template_reply",
    result:
      sent.outcome === "sent"
        ? "sent"
        : sent.outcome === "skipped"
          ? "skipped"
          : sent.outcome === "retry"
            ? "block"
            : "held",
    detail,
  }, runCtx);

  if (sent.outcome === "sent") {
    if (!recorded) {
      await markPropertyNeedsAttention(supabase, input.propertyId, "template_sent_outcome_missing", runCtx);
    }
    return { kind: "continue", outboundMessageId: sent.messageId, replyKey, hold: sentHold };
  }
  // Nothing was sent. Held (hold mode / recipient window / any gate) or
  // silently refused: the outcome still applies (see the doc above).
  if (sent.outcome !== "retry") {
    const why = ("reason" in sent && sent.reason ? `${sent.outcome}:${sent.reason}` : sent.outcome).replace(/\s+/g, "_");
    return { kind: "continue", outboundMessageId: null, replyKey: null, hold: notSent(`send_${sent.outcome}`), notSentReason: why };
  }

  // A retry drops its carried reply so the re-dispatch classifies again and
  // re-runs this step with the outcome still unapplied (a carried template
  // reply would send without applying it).
  return {
    kind: "stop",
    outcome: await settleClaimForSendOutcome(supabase, claim.claimId, { ...sent, reply: undefined }, {
      orgId: property.org_id,
      input,
      body: resolved.body,
      runContext: runCtx,
    }),
  };
}

/**
 * Classify-only for an inbound on a property Sandra will not reply to: one that
 * already needs a person, OR one with a human-owned disposition (nurture,
 * callback_requested, booked_appointment) even when it is not flagged.
 * True suppression (wrong_number, bad_number, dnc, opted_out) never gets here.
 * With Jev automatic, one classification and the shared hot routing decision;
 * hot → one hot_text event (alerted to Jarrad by the cron, whoever owns the
 * lead, subject to the usual cover / cap / cutoff rules). Never sends, enrols,
 * disposes or assigns. A failed write releases the claim; on a held lead the
 * hold keeps a person in the loop, but on an UNFLAGGED lead nothing else
 * records it, so it is only retried if the same inbound is replayed.
 */
async function classifyOnlyForHotText(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  property: GateProperty & { last_ai_escalation_reason?: string | null },
  runCtx: MaybeRunContext,
): Promise<void> {
  const orgId = property.org_id;
  try {
    // A person took over the thread: Sandra stays out.
    if (property.last_ai_escalation_reason === "rep_sms_human_takeover") return;
    // The same rule-0 gates as any send (org off, consent / opt-out, DNC,
    // phone suppression, responder disabled = human takeover), evaluated as
    // if the lead were not held. Any failed lookup or any gate → nothing.
    // Alert-only (nothing is sent), so only TRUE suppression blocks it
    // (wrong_number / bad_number / dnc / opted_out dispositions); human-owned
    // dispositions (nurture, callback, booked) do not. A rep's lead still
    // alerts Jarrad (owner decision 2026-10-19); the assignment is untouched.
    if (isSuppressed({ outreachDispo: property.outreach_dispo })) return;
    const silent = await loadSilentExit(supabase, input, { ...property, needs_human_attention: false, outreach_dispo: null });
    if (!silent.ok || silent.reason) return;
    // Already handled: a response claim or a classification run for this
    // inbound means it went through before. Never classify a replay; a failed
    // lookup fails closed.
    const inboundId = input.inboundMessageId as string;
    // No conversation: nothing reliable to classify against.
    if (!input.conversationId) return;
    const { data: claim, error: claimError } = await supabase
      .from("ai_response_claims")
      .select("id, status, lease_expires_at")
      .eq("inbound_message_id", inboundId)
      .limit(1);
    if (claimError) return;
    const prior = (claim ?? [])[0] as { status: string; lease_expires_at: string | null } | undefined;
    // Done ('completed') or another run's live lease: stop. A released
    // 'error' claim (an earlier hot-text write failed) or an expired
    // 'processing' claim (a crashed run) is retried.
    if (prior && (prior.status === "completed" || (prior.lease_expires_at && Date.parse(prior.lease_expires_at) > (await dbNowMs(supabase))))) return;
    const retryOfFailedWrite = prior?.status === "error";
    const { data: cfg } = await supabase
      .from("ai_responder_configs")
      .select("classifier_provider, classifier_mode, escalation_keywords")
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    if (!cfg || !isJevAutomatic(cfg)) return;
    const escalationKeywords = (cfg as { escalation_keywords?: string[] | null }).escalation_keywords ?? null;
    // An unreadable switch runs nothing. The nine-question engine gets its own classify-only look.
    const engine = await readClassifierEngine(supabase, orgId);
    if (engine === "unreadable") return;
    // A replay of an inbound that was already classified (full path or an
    // earlier classify-only look) is never classified again: no paid call,
    // no second event for one text.
    const { data: seen, error: seenError } = await supabase
      .from("sms_classification_runs")
      .select("id")
      .eq("source_inbound_message_id", inboundId)
      .limit(1);
    // (A retry of a failed hot-text write classifies again: one extra call
    // beats a lost alert.)
    if (seenError || ((seen ?? []).length > 0 && !retryOfFailedWrite)) return;
    // Claim the inbound atomically (the response-claim table's unique key)
    // before classifying: concurrent runs of the same held inbound cannot both
    // call Jev or both act. No real claim row → do nothing (fail closed).
    const claim2 = await claimAiResponse(supabase, {
      orgId,
      inboundMessageId: inboundId,
      propertyId: input.propertyId,
      contactId: input.contactId,
      conversationId: input.conversationId ?? null,
    });
    if (!claim2.claimed || !claim2.claimId) return;
    let classifyOnlyOutcome: "escalated" | "skipped" | "write_failed" = "write_failed";
    try {
      classifyOnlyOutcome = engine === "nine_questions"
        ? await classifyOnlyClaimedNine(supabase, input, orgId, escalationKeywords, runCtx)
        : await classifyOnlyClaimed(supabase, input, orgId, runCtx, escalationKeywords);
    } finally {
      if (classifyOnlyOutcome === "write_failed") {
        // The hot text's event (or the run itself) failed: never mark the
        // inbound done. Release the claim (error, lease expired) so a replay
        // classifies and writes again.
        reportError(new Error("hot text on held lead not recorded; claim released for retry"), {
          tags: { surface: "hot_text_on_held_lead" },
          extra: { propertyId: input.propertyId, inboundMessageId: inboundId },
        });
        await completeAiResponseClaim(supabase, {
          claimId: claim2.claimId,
          outcome: "hot_text_write_failed",
          errorMessage: "hot_text_event_not_recorded",
          releaseLease: true,
        });
      } else {
        await completeAiResponseClaim(supabase, { claimId: claim2.claimId, outcome: classifyOnlyOutcome });
      }
    }
  } catch (error) {
    reportError(error, { tags: { surface: "hot_text_on_held_lead" }, extra: { propertyId: input.propertyId } });
  }
}

/**
 * After a person-review keyword hold whose reason is NOT the hot price
 * reason: if the text also carries an allowed price signal, run the held-lead
 * classify-only check (its own gates, atomic claim, one classification,
 * stop / DNC / wrong / bad number precedence). Used by the normal dispatch and
 * the delayed-reply inbound path.
 */
export async function checkHotTextAfterKeywordHold(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  holdReason: string,
  escalationKeywords: ReadonlyArray<string> | null,
  runCtx: MaybeRunContext,
  knownProperty?: GateProperty & { last_ai_escalation_reason?: string | null },
): Promise<void> {
  if (holdReason.startsWith(`keyword:${HOT_KEYWORD_TIER}`) || !input.inboundMessageId) return;
  if (!isPriceKeyword(input.inboundBody, escalationKeywords)) return;
  let property = knownProperty ?? null;
  if (!property) {
    const { data } = await supabase
      .from("properties")
      .select("org_id, ai_responder_disabled, outreach_dispo, needs_human_attention, last_ai_escalation_reason")
      .eq("id", input.propertyId)
      .maybeSingle();
    if (!data) return;
    property = data as GateProperty & { last_ai_escalation_reason?: string | null };
  }
  await classifyOnlyForHotText(
    supabase,
    input,
    { ...property, needs_human_attention: true, last_ai_escalation_reason: holdReason },
    runCtx,
  );
}

/**
 * Classify-only for the nine-question engine (a text on a lead that already needs a person): one
 * nine-question read; hot when the answer is open_to_selling / talked_price, or a price keyword
 * hits and the answer is not asked_stop / hostile / wrong_person / already_sold / tenant. Records the hot text; sends nothing.
 */
async function classifyOnlyClaimedNine(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  orgId: string,
  escalationKeywords: ReadonlyArray<string> | null,
  runCtx: MaybeRunContext,
): Promise<"escalated" | "skipped" | "write_failed"> {
  const cls = await runNineClassification(
    supabase,
    {
      orgId,
      propertyId: input.propertyId,
      contactId: input.contactId,
      conversationId: input.conversationId ?? null,
      inboundMessageId: input.inboundMessageId ?? null,
      inboundBody: input.inboundBody,
    },
    { fetch, typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "", runContext: runCtx ?? undefined },
  );
  // Hostile wording waits for a person's confirmation: never recorded as a hot text.
  if (isHostileInbound(input.inboundBody)) return "skipped";
  const keyword = hasHotPriceKeyword(input.inboundBody, escalationKeywords);
  const answer = cls.kind === "ok" ? cls.result.answer : null;
  const blocked =
    answer === "asked_stop" || answer === "hostile" || answer === "wrong_person" || answer === "already_sold" || answer === "tenant";
  const answerHot = answer === "open_to_selling" || answer === "talked_price";
  if (blocked || !(answerHot || keyword)) return "skipped";
  const recorded = await recordHotTextOnHeldLead(supabase, input.propertyId, input.inboundMessageId ?? null, answerHot ? "hot_lead" : "price_or_offer");
  await trace(supabase, {
    kind: "action",
    name: "hot_text_on_held_lead",
    result: recorded === "recorded" ? "applied" : recorded === "write_failed" ? "error" : "skipped",
    detail: { engine: "nine_questions", answer },
  }, runCtx);
  return recorded === "recorded" ? "escalated" : recorded;
}

/** The classify-only work, under its claim. Returns the claim outcome. */
async function classifyOnlyClaimed(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  orgId: string,
  runCtx: MaybeRunContext,
  escalationKeywords: ReadonlyArray<string> | null,
): Promise<"escalated" | "skipped" | "write_failed"> {
  {
    const c = await classifyInboundOnce(supabase, { input, orgId, runCtx: runCtx ?? undefined });
    if (!(await isHotRouting(supabase, orgId, c, input.inboundBody, escalationKeywords))) return "skipped";
    const escalation = "escalationReason" in c ? c.escalationReason : null;
    const recorded = await recordHotTextOnHeldLead(supabase, input.propertyId, input.inboundMessageId ?? null, escalation ?? "hot_lead");
    await trace(supabase, {
      kind: "action",
      name: "hot_text_on_held_lead",
      result: recorded === "recorded" ? "applied" : recorded === "write_failed" ? "error" : "skipped",
      detail: { escalation: escalation ?? null },
    }, runCtx);
    return recorded === "recorded" ? "escalated" : recorded;
  }
}

function isJevAutomatic(config: { classifier_provider?: string | null; classifier_mode?: string | null }): boolean {
  return config.classifier_provider === "jev" && config.classifier_mode === "automatic";
}

/** Classify this inbound with Jev automatic. Callers pass the result on instead of classifying again. */
async function classifyInboundOnce(
  supabase: SupabaseClient<Database>,
  a: { input: AiDispatchInput; orgId: string; runCtx?: MaybeRunContext },
): Promise<ClassificationBridgeResult> {
  const { input } = a;
  return classifyForDispatch(
    supabase,
    {
      orgId: a.orgId,
      propertyId: input.propertyId,
      contactId: input.contactId,
      conversationId: input.conversationId ?? null,
      inboundMessageId: input.inboundMessageId ?? null,
      inboundBody: input.inboundBody,
    },
    { classifierProvider: "jev", classifierMode: "automatic" },
    { fetch, typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "", runContext: a.runCtx },
  );
}

/**
 * THE hot / not-hot routing decision for a classified inbound, used before any
 * identity text: the shared hot definition, plus the nurture "ready within 30
 * days" person route (the same routeNurture call the main path makes).
 */
async function isHotRouting(
  supabase: SupabaseClient<Database>,
  orgId: string,
  c: ClassificationBridgeResult,
  /** The inbound text: the price_offer keyword is hot unless stop / DNC / wrong / bad number won. */
  inboundBody?: string,
  /** The org's configured escalation phrases (ai_responder_configs.escalation_keywords), same as the normal path. */
  escalationKeywords?: ReadonlyArray<string> | null,
): Promise<boolean> {
  if (isHotClassification(c)) return true;
  if (inboundBody && !stopOrDncWins(c) && isPriceKeyword(inboundBody, escalationKeywords)) return true;
  if (c.kind !== "jev_nurture") return false;
  const cfg = await loadNurtureAutoDripConfig(supabase, orgId);
  return cfg.enabled && routeNurture({ readyTimeframe: c.readyTimeframe, listingStatus: c.listingStatus }).kind === "person";
}

/**
 * A hot escalation overrides ONLY a nurture, not-interested (at or below its
 * cutoff) or unclear result. Never opted_out, dnc, wrong_number, bad_number
 * or any other route.
 */
function hotWinsOver(c: ClassificationBridgeResult): boolean {
  const hotEsc = (r: string | null | undefined) => isHotSeller({ reasons: [r] });
  if (c.kind === "jev_nurture") return hotEsc(c.escalationReason);
  if (c.kind === "jev_route") return c.route.kind === "auto_close" && hotEsc(c.escalationReason);
  if (c.kind === "jev_needs_decision") {
    return (c.outcome === "nurture" || c.outcome === "not_interested") && hotEsc(c.escalationReason);
  }
  // "Unclear" + a hot escalation is hot; "bad_number" sits with wrong-number and never is.
  if (c.kind === "jev_no_action") return c.outcome === "unclear" && hotEsc(c.escalationReason);
  return false;
}

/** The price_offer keyword, matched against the ORG's configured phrases on every path. */
function isPriceKeyword(body: string, escalationKeywords?: ReadonlyArray<string> | null): boolean {
  return hasAllowedPriceSignal(body, escalationKeywords);
}

/** Stop / DNC / wrong-number / bad-number results always beat hot (Jarrad's order). */
function stopOrDncWins(c: ClassificationBridgeResult): boolean {
  if (c.kind === "jev_route") {
    return c.route.kind === "opt_out" || c.route.kind === "close_dnc" || c.route.kind === "auto_close_wrong_number";
  }
  if (c.kind === "jev_needs_decision") {
    return c.outcome === "opted_out" || c.outcome === "dnc" || c.outcome === "wrong_number" || c.outcome === "bad_number";
  }
  if (c.kind === "jev_no_action") return c.outcome === "bad_number";
  return false;
}

/** Hot seller by the shared definition (lib/hot-sellers/hot.ts), with stop / DNC / wrong-number always winning. */
function isHotClassification(c: ClassificationBridgeResult): boolean {
  if (c.kind === "jev_promote_new_lead") return true;
  if (c.kind === "jev_needs_decision" && c.outcome === "new_lead") return true;
  // The escalate route only comes from outcome new_lead (below its cutoff):
  // hot whatever the escalation reason.
  if (c.kind === "jev_route" && c.route.kind === "escalate") return true;
  return hotWinsOver(c);
}

/**
 * Identity-interceptor helper: when this inbound both asks who we are and asks
 * how we got the number, returns the rendered number-source template, under the
 * same gates the classified path applies (a nurture / not-interested outcome at
 * its cutoff, no human follow-up, label switch on, an approved + mapped
 * template). The classification goes through `classifyForDispatch`, so the Jev
 * decision is saved like any other (`sms_classification_runs`) and the same
 * timeout and retries apply; no outcome is applied (the identity path never
 * applied one). `askedNotSentReason` is set when Jev said yes but no
 * number-source template could go out, so the caller holds for a person.
 * Hostile inbounds never reach this (the identity shortcut is skipped).
 */
async function resolveNumberSourceForIdentity(
  supabase: SupabaseClient<Database>,
  a: {
    input: AiDispatchInput;
    orgId: string;
    config: { classifier_provider?: string | null; classifier_mode?: string | null };
    runCtx?: MaybeRunContext;
    precomputed?: ClassificationBridgeResult | null;
  },
): Promise<{
  template:
    | (Extract<Awaited<ReturnType<typeof resolveApprovedTemplateReply>>, { kind: "template" }> & {
        nativeConfidence: number | null;
      })
    | null;
  askedNotSentReason: string | null;
}> {
  const { input } = a;
  const none = { template: null, askedNotSentReason: null };
  if (a.config.classifier_provider !== "jev" || a.config.classifier_mode !== "automatic") return none;
  if (!(await hasSendableNumberSourceTemplate(supabase, a.orgId))) return none;
  const classification = a.precomputed ?? await classifyInboundOnce(supabase, { input, orgId: a.orgId, runCtx: a.runCtx });
  let outcome: "nurture" | "not_interested" | null = null;
  let asked = false;
  let nativeConfidence: number | null = null;
  let escalationReason: JevEscalationReason | null = null;
  if (classification.kind === "jev_nurture") {
    outcome = "nurture";
    asked = classification.askedHowNumberObtained;
    nativeConfidence = classification.nativeConfidence;
    escalationReason = classification.escalationReason;
  } else if (
    classification.kind === "jev_route" &&
    classification.route.kind === "auto_close" &&
    classification.eligibleForAutoAccept
  ) {
    outcome = "not_interested";
    asked = classification.askedHowNumberObtained;
    nativeConfidence = classification.nativeConfidence;
    escalationReason = classification.escalationReason;
  } else if (
    (classification.kind === "jev_route" || classification.kind === "jev_promote_new_lead") &&
    classification.askedHowNumberObtained
  ) {
    return { template: null, askedNotSentReason: "outcome_not_templatable" };
  } else if (
    (classification.kind === "jev_needs_decision" || classification.kind === "jev_no_action") &&
    classification.askedHowNumberObtained
  ) {
    // Jev heard the question but the outcome is below its cutoff / has no action:
    // the identity reply goes out as today and a person answers the number question.
    return { template: null, askedNotSentReason: classification.kind === "jev_needs_decision" ? "below_threshold" : "no_action" };
  }
  if (!outcome || !asked) return none;
  const resolved = await resolveApprovedTemplateReply(supabase, {
    orgId: a.orgId,
    propertyId: input.propertyId,
    contactId: input.contactId,
    outcome,
    mappingKey: NUMBER_SOURCE_REPLY_KEY,
    outcomeConfidence: nativeConfidence,
    escalationReason,
    replyIntent: null,
  });
  return resolved.kind === "template"
    ? { template: { ...resolved, nativeConfidence }, askedNotSentReason: null }
    : { template: null, askedNotSentReason: resolved.reason };
}

/**
 * Nurture auto-drip step (per-org switch `nurture_auto_drip`, default off).
 * Order is strict: the approved nurture reply must have been accepted by the
 * provider, THEN the lead is enrolled. When the reply did not go out (quiet
 * hours, gate refusal, outbound hold, no approved/mapped template) nothing is
 * enrolled and a person is asked to reply and start the drip
 * (`nurture_reply_not_sent:<reason>`). A refused enrolment leaves the lead as
 * nurture and raises `drip_enroll_failed:<reason>`. With the switch off this is
 * a no-op: no read beyond the config, no step recorded.
 */
/** Tail of the `drip_enroll_failed:` hold when enrolment threw. */
const ENROLL_THREW = "enroll_threw";

async function runNurtureAutoDripStep(
  supabase: SupabaseClient<Database>,
  a: {
    propertyId: string;
    /** The inbound's sender: enrolled when the lead has no saved homeowner. */
    contactId: string;
    cfg: NurtureAutoDripConfig;
    route: NurtureRoute | null;
    replySent: boolean;
    notSentReason: string;
    runCtx?: MaybeRunContext;
  },
): Promise<void> {
  if (!a.cfg.enabled || !a.route || a.route.kind !== "drip") return;
  const { drip, delayDays } = a.route;
  if (!a.replySent) {
    await trace(supabase, {
      kind: "action",
      name: "drip_enrolled",
      result: "skipped",
      detail: { why: "reply_not_sent", detail: a.notSentReason, route: drip },
    }, a.runCtx);
    await markPropertyNeedsAttention(supabase, a.propertyId, `nurture_reply_not_sent:${a.notSentReason}`, a.runCtx);
    return;
  }
  let result: Awaited<ReturnType<typeof enrollNurtureInDrip>>;
  try {
    result = await enrollNurtureInDrip(supabase, {
      propertyId: a.propertyId,
      sequenceId: a.cfg.sequences[drip],
      delayDays,
      route: drip,
      contactId: a.contactId,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "nurture_auto_drip" }, extra: { propertyId: a.propertyId } });
    result = { status: "refused", reason: ENROLL_THREW };
  }
  if (result.status === "refused") {
    await trace(supabase, {
      kind: "action",
      name: "drip_enrolled",
      result: "error",
      detail: { reason: result.reason, route: drip },
    }, a.runCtx);
    await markPropertyNeedsAttention(
      supabase,
      a.propertyId,
      result.reason === "drip_paused" ? "drip_paused" : `drip_enroll_failed:${result.reason}`,
      a.runCtx,
    );
    return;
  }
  await trace(supabase, {
    kind: "action",
    name: "drip_enrolled",
    result: "applied",
    detail: {
      status: result.status,
      route: drip,
      sequenceId: result.sequenceId,
      ...(result.status === "enrolled"
        ? { enrollmentId: result.enrollmentId, firstSendNotBefore: result.firstSendNotBefore }
        : {}),
    },
  }, a.runCtx);
}

/**
 * Side-effect-free "will this template go out now?" for the template step.
 * Returns why not (`outbound_mode_hold`, or the recipient-window reason) or null.
 */
async function templateSendBlockedNow(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  ctx: TemplateStepContext,
): Promise<string | null> {
  const policy = resolveOutboundPolicy({ source: "approved_template", dbMode: ctx.outboundMode });
  if (policy.hold) return policy.reason;
  const verdict = await evaluateRecipientWindow(supabase, input);
  return verdict.ok ? null : `quiet_hours_recipient:${verdict.why}`;
}

async function deliverRoutedReply(
  supabase: SupabaseClient<Database>,
  a: {
    input: AiDispatchInput;
    property: AiDispatchPropertyGateRow;
    config: { model: string; outbound_mode?: string | null };
    currentTurn: number;
    responseClaim: { claimId: string | null; startedAt?: string };
    runCtx?: MaybeRunContext;
    reply: {
      kind: "send_reply" | "deescalate_close" | "identity" | "nine_hot_reply";
      body: string;
      confidence: number;
      sentiment: AiMessageMetadata["sentiment"];
      closeReason?: string;
    };
  },
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const { input, property, config, responseClaim, runCtx, reply } = a;
  const sent = await sendResponderMessage(supabase, {
    runContext: runCtx,
    input,
    body: reply.body,
    model: config.model,
    confidence: reply.confidence,
    sentiment: reply.sentiment,
    turn: a.currentTurn + 1,
    source: "llm",
    orgId: property.org_id,
    claimStartedAt: responseClaim.startedAt ?? null,
    outboundMode: config.outbound_mode,
    replyKind: reply.kind,
    ...(reply.closeReason ? { closeReason: reply.closeReason } : {}),
  });
  if (sent.outcome !== "sent") {
    return settleClaimForSendOutcome(supabase, responseClaim.claimId, sent, {
      orgId: property.org_id,
      input,
      body: reply.body,
      runContext: runCtx,
    });
  }

  if (reply.kind === "deescalate_close") {
    const closeReason = reply.closeReason ?? "deescalate_close";
    const closeResult = await setResponderDispo(supabase, {
      runContext: runCtx,
      propertyId: input.propertyId,
      conversationId: input.conversationId ?? null,
      inboundMessageId: input.inboundMessageId ?? null,
      dispo: "not_interested",
      reason: closeReason,
    });
    const outcome = closeOutcome(closeResult, closeReason);
    await completeClaim(supabase, input.propertyId, {
      claimId: responseClaim.claimId,
      outcome: claimOutcomeOf(outcome),
      outboundMessageId: sent.messageId,
      errorMessage: dispositionClaimError(closeResult),
    });
    return outcome;
  }

  await completeClaim(supabase, input.propertyId, {
    claimId: responseClaim.claimId,
    outcome: "sent",
    outboundMessageId: sent.messageId,
  });
  return sent;
}

/**
 * A-2 F2: a hold about OUR OWN earlier reply ('mechanics', from an older inbound) does not make
 * a newer seller text terminal: that text is routed fresh and the v2 transition clears the hold
 * (audited). Decided in SQL (created_at, id) under the DB clock. A human-owned disposition still
 * wins; any read error keeps today's terminal behaviour.
 */
async function mechanicsHoldYieldsTo(
  supabase: SupabaseClient<Database>,
  property: { id?: string; org_id?: string | null; needs_human_attention?: boolean | null; outreach_dispo?: string | null },
  inboundMessageId: string | null | undefined,
  /** The caller already decided v2 is live (the early gate's single strict read). */
  decided?: { v2Live: true },
): Promise<boolean> {
  if (!property.needs_human_attention || !property.id || !inboundMessageId) return false;
  if (shouldSuppressAutomatedSend({ outreachDispo: property.outreach_dispo ?? null })) return false;
  // Astra review of 921b71c2a133 (P1): only the v2 transition clears a mechanics hold (audited), so
  // the hold yields only while v2 routing is live for this property. With v2 off (never on, or
  // turned off after it wrote the hold) the hold is terminal exactly as today; any read error too.
  let orgId = property.org_id ?? null;
  if (!decided?.v2Live && !orgId) {
    const { data: row, error: orgError } = await supabase.from("properties").select("org_id").eq("id", property.id).maybeSingle();
    if (orgError || !row?.org_id) return false;
    orgId = row.org_id;
  }
  if (!decided?.v2Live && (await routingV2LiveForSweep(supabase, orgId!, property.id)) !== "yes") return false;
  let data: unknown;
  let error: { message: string } | null;
  try {
    ({ data, error } = await (supabase as unknown as LooseRpc).rpc("routing_v2_mechanics_hold_yields", {
      p_property_id: property.id, p_inbound_message_id: inboundMessageId,
    }));
  } catch (e) {
    error = { message: e instanceof Error ? e.message : String(e) };
  }
  if (error) {
    // Deployed ahead of the migration (function missing) or a read error: terminal, as today.
    if (!/PGRST202|42883|does not exist|Could not find/i.test(error.message)) {
      reportError(new Error(error.message), { tags: { surface: "routing_v2_mechanics_hold_yields" }, extra: { propertyId: property.id } });
    }
    return false;
  }
  return data === true;
}

function isTerminalAiResponderProperty(
  property: Pick<
    AiDispatchPropertyGateRow,
    "needs_human_attention" | "outreach_dispo"
  >,
): boolean {
  return (
    property.needs_human_attention ||
    shouldSuppressAutomatedSend({ outreachDispo: property.outreach_dispo })
  );
}

async function findLatestInboundInThreadStrict(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
): Promise<{ ok: true; row: { id: string; created_at: string } | null } | { ok: false }> {
  let query = supabase
    .from("messages")
    .select("id, created_at")
    .eq("property_id", input.propertyId)
    .eq("direction", "inbound")
    .eq("channel", "sms");
  query = input.conversationId
    ? query.eq("conversation_id", input.conversationId)
    : query.eq("contact_id", input.contactId);

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_latest_inbound_lookup" },
      extra: {
        propertyId: input.propertyId,
        contactId: input.contactId,
        conversationId: input.conversationId ?? null,
        inboundMessageId: input.inboundMessageId ?? null,
      },
    });
    return { ok: false };
  }
  return { ok: true, row: data ?? null };
}

async function findRecentAiReplyInThread(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  windowMs: number,
): Promise<{ id: string; createdAtMs: number } | null> {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const { data, error } = await supabase
    .from("messages")
    .select("id, status, created_at, sent_at")
    .eq("channel", "sms")
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .in("status", ["pending", "sent", "queued"])
    .contains("metadata", { generated_by: "ai_responder_v1" })
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_recent_reply_lookup" },
      extra: { conversationId, cutoff },
    });
    return null;
  }

  const recent = data?.find((reply) => {
    const effectiveTimestamp =
      reply.status === "pending"
        ? reply.created_at
        : (reply.sent_at ?? reply.created_at);
    return effectiveTimestamp >= cutoff;
  });
  if (!recent) return null;
  const createdAtMs = Date.parse(recent.created_at);
  return { id: recent.id, createdAtMs: Number.isNaN(createdAtMs) ? Date.now() - windowMs : createdAtMs };
}

// ---------- helpers ---------------------------------------------------------

async function resolveOutboundBody(
  supabase: SupabaseClient<Database>,
  args: {
    route: Extract<ResponderRoute, { kind: "send_reply" | "deescalate_close" }>;
    contactId: string;
    model: string;
    anthropic: AnthropicLike;
  },
): Promise<{ body: string }> {
  if (args.route.kind === "deescalate_close") {
    return { body: await buildDeescalationBody(supabase, args.contactId) };
  }

  const draft = args.route.body.trim();
  return {
    body: draft
      ? await humanizeReply(
          { draft, model: args.model },
          { client: args.anthropic },
        )
      : draft,
  };
}

export type ReplySource = "approved_template" | "llm" | "human";

/**
 * Outbound policy. Defaults PRESERVE production today (origin/main always
 * sent): DB mode `send`, AI_RESPONDER_OUTBOUND_MODE unset/"send" and
 * AI_RESPONDER_LLM_AUTOSEND unset/"1".
 *  - EITHER hold wins. A send happens only when ai_responder_configs
 *    .outbound_mode is `send` AND AI_RESPONDER_OUTBOUND_MODE is unset or
 *    `send`. Env `hold` forces hold; env `send` can NOT override a DB `hold`
 *    (an owner's hold is never silently lifted by a deploy variable).
 *  - AI_RESPONDER_LLM_AUTOSEND="0" holds every `llm`-sourced reply as a
 *    draft. Flipping it to "0" is the Phase-1 D5 enforcement.
 */
export function resolveOutboundPolicy(args: {
  source: ReplySource;
  dbMode?: string | null;
  /**
   * The body is the fixed, human-approved identity text (IDENTITY_REPLY_BODY),
   * not model-written. It is exempt ONLY from the LLM-autosend switch; every
   * outbound-mode hold and every other guard still applies.
   */
  approvedFixedText?: boolean;
}): { hold: false } | { hold: true; reason: "outbound_mode_hold" | "llm_autosend_off" } {
  // A human clicking Send on a held draft is the human decision the hold was
  // waiting for. The AI outbound policy (draft-only rollback, LLM autosend off)
  // governs what the AI may send on its own; re-holding a human's click would
  // loop the draft back into the hold rail forever.
  if (args.source === "human") return { hold: false };
  const envMode = process.env.AI_RESPONDER_OUTBOUND_MODE?.trim().toLowerCase();
  if (envMode === "hold" || args.dbMode === "hold") {
    return { hold: true, reason: "outbound_mode_hold" };
  }
  if (args.source === "llm" && !args.approvedFixedText && process.env.AI_RESPONDER_LLM_AUTOSEND?.trim() === "0") {
    return { hold: true, reason: "llm_autosend_off" };
  }
  return { hold: false };
}

/**
 * The nine-question identity send is fixed approved text only when the caller
 * opted in explicitly AND it runs with the recipient-window/Florida-cap guards
 * (windowDeferrable) AND both its kind and its exact body match. The legacy
 * identity interceptor and carried retries never opt in, so they stay governed
 * by the LLM-autosend switch.
 */
export function isApprovedFixedText(args: {
  approvedFixedText?: boolean;
  windowDeferrable?: boolean;
  replyKind?: string | null;
  body: string;
}): boolean {
  if (args.approvedFixedText !== true || args.windowDeferrable !== true) return false;
  if (args.replyKind === "identity") return args.body === IDENTITY_REPLY_BODY;
  // The three hot reply texts Jarrad approved verbatim 2026-10-20 (sendNineHotReply only).
  if (args.replyKind === "nine_hot_reply") return (Object.values(NINE_HOT_REPLY_TEXTS) as string[]).includes(args.body);
  return false;
}

/**
 * What a send-gate evaluation concluded. `ok: false` is a lookup that failed
 * or returned something unparseable: the early gate lets the pipeline continue
 * (the pre-send check re-reads under the lease); the pre-send check FAILS
 * CLOSED (`send_check_failed`), never "assume current".
 */
type GateEvaluation =
  | { ok: true; decision: SendGateDecision; newerInboundId: string | null }
  | {
      ok: false;
      /** The evidence set was too large to read completely: fail closed (rule 7). */
      reason?: "evidence_truncated";
    };

/** Upper bound on each evidence query; hitting it fails the decision closed. */
const GATE_EVIDENCE_CAP = 500;

/** The only flag reason a human Send is exempt from (engineering policy: the narrowest exemption). */
export const HUMAN_SEND_EXEMPT_FLAG_REASON = "draft_held";

type GateProperty = Pick<
  AiDispatchPropertyGateRow,
  "needs_human_attention" | "outreach_dispo" | "ai_responder_disabled" | "org_id"
>;

/**
 * Gather every fact the Q8 table needs and decide. READS ONLY (no flag, no
 * trace, no write): the caller applies the decision after re-validating that
 * its attempt is still live, so a lookup that resumes after a timeout cannot
 * mutate anything.
 *
 * Outbound evidence window: starts at min(claimStartedAt, inbound.created_at),
 * so a retry (which takes a new claim) never forgets what
 * happened before it, e.g. a human reply during the retry gap. AI rows
 * stamped with THIS inbound are always evidence regardless of the window.
 */
async function evaluateSendGate(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  opts: {
    phase: SendGatePhase;
    claimStartedAt: string | null;
    checkNewerInbound: boolean;
    /** Already-loaded property (the early gate has it); otherwise read here. */
    property?: GateProperty | null;
    /** The caller's own pending send row: it is not a competitor to itself. */
    excludeMessageId?: string;
    /**
     * A human is sending a held draft: the property's own "flagged for a human"
     * state is what put the draft on the rail, so it is not a reason to refuse
     * the human's click. Every other rule 0 predicate (suppression, DNC,
     * consent, terminal disposition, responder off) still applies.
     */
    humanActor?: boolean;
    /**
     * Opus review of 93a8070932bd (B1): an older mechanics hold may yield only on the v2 road:
     * "decided" = the early gate's single strict read said v2 is live; "outbox" = this is a v2
     * outbox reply send (re-checked strictly). Absent = the legacy road: the hold is terminal.
     */
    mechanicsYield?: "decided" | "outbox";
  },
): Promise<GateEvaluation> {
  // Astra review of b6a00a0a2f17 (C): the gate compares DB-written times (inbound created_at,
  // claim leases, sent_at), so "now" is the DB's.
  const nowMs = await dbNowMs(supabase);

  // Rule 0 evidence (suppression / disabled / consent / terminal): silent by
  // design and decided before anything else is read.
  const silent = await loadSilentExit(supabase, input, opts.property ?? null, opts.humanActor === true, opts.mechanicsYield);
  if (!silent.ok) return { ok: false };
  if (silent.reason) {
    return {
      ok: true,
      decision: decideSendGate(
        { silentExit: { reason: silent.reason }, newerInbound: { present: false }, outbound: [] },
        { phase: opts.phase },
      ),
      newerInboundId: null,
    };
  }

  // Rule 8 evidence: a terminal (discarded / already sent) draft.
  if (input.inboundMessageId) {
    const draft = await loadDraftState(supabase, input.inboundMessageId);
    if (draft === "error") return { ok: false };
    if (draft === "resolved") {
      return {
        ok: true,
        decision: decideSendGate(
          { terminalDraft: true, newerInbound: { present: false }, outbound: [] },
          { phase: opts.phase },
        ),
        newerInboundId: null,
      };
    }
  }

  let newerInbound: NewerInboundFact = { present: false };
  let newerInboundId: string | null = null;
  if (opts.checkNewerInbound && input.inboundMessageId) {
    const latest = await findLatestInboundInThreadStrict(supabase, input);
    if (!latest.ok) return { ok: false };
    if (latest.row && latest.row.id !== input.inboundMessageId) {
      const handled = await newerInboundHasLiveHandler(supabase, latest.row.id, nowMs);
      if (handled === null) return { ok: false };
      const createdMs = Date.parse(latest.row.created_at);
      newerInboundId = latest.row.id;
      newerInbound = {
        present: true,
        handled,
        ageMs: Number.isNaN(createdMs) ? null : nowMs - createdMs,
      };
      // Rule 1 decides on its own: no outbound evidence is needed.
      return {
        ok: true,
        decision: decideSendGate({ newerInbound, outbound: [] }, { phase: opts.phase }),
        newerInboundId,
      };
    }
  }

  const outbound = await gatherOutboundFacts(supabase, input, opts, nowMs);
  if (!outbound.ok) return outbound.truncated ? { ok: false, reason: "evidence_truncated" } : { ok: false };
  if (opts.phase === "presend") await testBarrier("outbox:presend_after_evidence", { propertyId: input.propertyId, inboundMessageId: input.inboundMessageId ?? null });
  return {
    ok: true,
    decision: decideSendGate({ newerInbound, outbound: outbound.facts }, { phase: opts.phase }),
    newerInboundId,
  };
}

/**
 * Rule 0 evidence. Same predicates as today's gates, read in one place: the
 * property is terminal (human attention / terminal disposition), the AI
 * responder is off for the org (no active config) or the property, or the
 * seller opted out. `reason` is null when none holds. A failed read is
 * `ok: false` (the caller fails closed).
 */
async function loadSilentExit(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  known: GateProperty | null,
  humanActor = false,
  mechanicsYield?: "decided" | "outbox",
): Promise<{ ok: true; reason: string | null } | { ok: false }> {
  // A human send reads the flag reason fresh: the exemption below depends on
  // it, and the early gate's row does not carry it.
  let property: (GateProperty & { last_ai_escalation_reason?: string | null }) | null = humanActor ? null : known;
  if (!property) {
    const { data, error } = await supabase
      .from("properties")
      .select(
        humanActor
          ? "org_id, ai_responder_disabled, outreach_dispo, needs_human_attention, last_ai_escalation_reason"
          : "org_id, ai_responder_disabled, outreach_dispo, needs_human_attention",
      )
      .eq("id", input.propertyId)
      .maybeSingle();
    if (error || !data) {
      reportError(new Error(error?.message ?? "property not found"), {
        tags: { surface: "ai_responder_rule0_property_lookup" },
        extra: { propertyId: input.propertyId },
      });
      return { ok: false };
    }
    property = data as unknown as GateProperty & { last_ai_escalation_reason?: string | null };
  }
  if (humanActor) {
    // Engineering policy: a human Send is exempt
    // from the "already flagged" check ONLY when the flag is exactly
    // `draft_held` (the flag that put the draft on the rail) or a hostile
    // hold being confirmed (`hostile_needs_confirm[:<id>]`). Any other flag
    // reason still refuses, with the reason shown.
    if (shouldSuppressAutomatedSend({ outreachDispo: property.outreach_dispo })) {
      return { ok: true, reason: "already_terminal" };
    }
    const humanExempt =
      property.last_ai_escalation_reason === HUMAN_SEND_EXEMPT_FLAG_REASON ||
      // "Confirm do-not-contact" on a hostile hold: the click is the human
      // decision, validated by the hold action (reason + inbound id + org).
      // Every other gate (Q8, consent, quiet hours, fence) still applies.
      (property.last_ai_escalation_reason ?? "").startsWith(HOSTILE_NEEDS_CONFIRM_REASON);
    if (property.needs_human_attention && !humanExempt) {
      return {
        ok: true,
        reason: `already_flagged:${property.last_ai_escalation_reason ?? "unknown"}`,
      };
    }
  } else if (isTerminalAiResponderProperty(property) && !(mechanicsYield
      && (await mechanicsHoldYieldsTo(supabase, { ...property, id: input.propertyId }, input.inboundMessageId,
        mechanicsYield === "decided" ? { v2Live: true } : undefined)))) {
    return { ok: true, reason: "already_terminal" };
  }

  const { data: config, error: configError } = await supabase
    .from("ai_responder_configs")
    .select("active")
    .eq("org_id", property.org_id)
    .eq("active", true)
    .maybeSingle();
  if (configError) {
    reportError(new Error(configError.message), {
      tags: { surface: "ai_responder_rule0_config_lookup" },
      extra: { propertyId: input.propertyId },
    });
    return { ok: false };
  }
  const consentLookup = await getConsentStateStrict(supabase, input.contactId, "sms");
  if (!consentLookup.ok) {
    // An unreadable consent state is never "no consent" and never a silent
    // pass: fail closed (rule 7).
    reportError(new Error(consentLookup.error), {
      tags: { surface: "ai_responder_rule0_consent_lookup" },
      extra: { propertyId: input.propertyId },
    });
    return { ok: false };
  }
  const consentState = consentLookup.state;

  // The SENDER's own suppression: the contact flags and the destination phone.
  // Any failed read is `ok: false` (rule 7), never a silent pass.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out")
    .eq("id", input.contactId)
    .maybeSingle();
  if (contactError) {
    reportError(new Error(contactError.message), {
      tags: { surface: "ai_responder_rule0_contact_lookup" },
      extra: { propertyId: input.propertyId },
    });
    return { ok: false };
  }
  let phoneSuppressed = false;
  const destination = input.inboundFromPhone ?? (contact ? selectBestSmsPhone(contact)?.phone : null) ?? null;
  if (destination) {
    try {
      phoneSuppressed = await isSmsPhoneSuppressed(supabase, destination, property.org_id);
    } catch (e) {
      reportError(e, {
        tags: { surface: "ai_responder_rule0_phone_suppression_lookup" },
        extra: { propertyId: input.propertyId },
      });
      return { ok: false };
    }
  }
  return {
    ok: true,
    reason: silentExitReason({
      configActive: !!config,
      consentState,
      propertyDisabled: property.ai_responder_disabled,
      doNotContact: contact?.do_not_contact ?? null,
      smsOptedOut: contact?.sms_opted_out ?? null,
      phoneSuppressed,
    }),
  };
}

async function gatherOutboundFacts(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  opts: { claimStartedAt: string | null; excludeMessageId?: string },
  nowMs: number,
): Promise<{ ok: true; facts: GateOutboundFact[] } | { ok: false; truncated?: true }> {
  let claimedAtMs: number | null = null;
  if (opts.claimStartedAt) {
    claimedAtMs = Date.parse(opts.claimStartedAt);
    if (Number.isNaN(claimedAtMs)) return { ok: false };
  }
  const inbound = await loadInboundCreatedAtMs(supabase, input);
  if (!inbound.ok) return { ok: false };
  const starts = [claimedAtMs, inbound.ms].filter(
    (v): v is number => v !== null,
  );
  const windowStartMs = starts.length > 0 ? Math.min(...starts) : null;

  type Row = {
    id: string;
    created_at: string;
    sent_at: string | null;
    status: string;
    campaign_id: string | null;
    metadata: Json | null;
    scheduled_for: string | null;
  };
  const columns = "id, created_at, sent_at, status, campaign_id, metadata, scheduled_for";
  const rows = new Map<string, Row>();

  const threadQuery = (statuses: readonly string[]) => {
    const query = supabase
      .from("messages")
      .select(columns)
      .eq("property_id", input.propertyId)
      .eq("channel", "sms")
      .eq("direction", "outbound")
      .in("status", [...statuses]);
    return input.conversationId
      ? query.eq("conversation_id", input.conversationId)
      : query.eq("contact_id", input.contactId);
  };
  const reportLookup = (message: string) =>
    reportError(new Error(message), {
      tags: { surface: "ai_responder_pre_send_outbound_lookup" },
      extra: { propertyId: input.propertyId },
    });

  // (1) Outstanding competitors (pending / queued), whenever they were created:
  // a rep text scheduled for later may predate the inbound. Complete set, no
  // time window; reaching the cap fails the decision closed.
  {
    const { data, error } = await threadQuery(["pending", "queued"])
      .order("created_at", { ascending: false })
      .limit(GATE_EVIDENCE_CAP + 1);
    if (error) {
      reportLookup(error.message);
      return { ok: false };
    }
    if ((data ?? []).length > GATE_EVIDENCE_CAP) return { ok: false, truncated: true };
    for (const row of (data ?? []) as Row[]) rows.set(row.id, row);
  }

  // (2) Rows that went out (sent / delivered) since the window start. "Went
  // out" is the submission time (sent_at); created_at is the fallback for a
  // row with no sent_at. Complete set within the window; cap = fail closed.
  if (windowStartMs !== null) {
    const iso = new Date(windowStartMs).toISOString();
    const { data, error } = await threadQuery(["sent", "delivered"])
      .or(`sent_at.gte.${iso},and(sent_at.is.null,created_at.gte.${iso})`)
      .order("created_at", { ascending: false })
      .limit(GATE_EVIDENCE_CAP + 1);
    if (error) {
      reportLookup(error.message);
      return { ok: false };
    }
    if ((data ?? []).length > GATE_EVIDENCE_CAP) return { ok: false, truncated: true };
    for (const row of (data ?? []) as Row[]) rows.set(row.id, row);
  }

  if (input.inboundMessageId) {
    const { data, error } = await supabase
      .from("messages")
      .select(columns)
      .eq("channel", "sms")
      .eq("direction", "outbound")
      .in("status", [...GATE_EVIDENCE_STATUSES])
      .contains("metadata", {
        generated_by: "ai_responder_v1",
        inbound_message_id: input.inboundMessageId,
      })
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      reportError(new Error(error.message), {
        tags: { surface: "ai_responder_existing_reply_lookup" },
        extra: { inboundMessageId: input.inboundMessageId },
      });
      return { ok: false };
    }
    for (const row of (data ?? []) as Row[]) rows.set(row.id, row);
  }
  if (opts.excludeMessageId) rows.delete(opts.excludeMessageId);
  if (rows.size === 0) return { ok: true, facts: [] };

  // Chunked: up to ~1000 ids must not blow the request URL limit.
  const sequenceMessageIds = new Set<string>();
  const ids = [...rows.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const { data: runs, error: runsError } = await supabase
      .from("sequence_step_runs")
      .select("message_id")
      .in("message_id", ids.slice(i, i + 100));
    if (runsError) {
      reportError(new Error(runsError.message), {
        tags: { surface: "ai_responder_pre_send_sequence_lookup" },
        extra: { propertyId: input.propertyId },
      });
      return { ok: false };
    }
    for (const r of runs ?? []) if (r.message_id) sequenceMessageIds.add(r.message_id);
  }
  const ctx = {
    inboundMessageId: input.inboundMessageId ?? null,
    inboundCreatedAtMs: inbound.ms,
    nowMs,
    sequenceMessageIds,
  };
  const facts: GateOutboundFact[] = [];
  for (const row of rows.values()) {
    const fact = classifyGateRow(row, ctx);
    if (fact) facts.push(fact);
  }
  return { ok: true, facts };
}

async function loadInboundCreatedAtMs(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
): Promise<{ ok: true; ms: number | null } | { ok: false }> {
  if (!input.inboundMessageId) return { ok: true, ms: null };
  const { data, error } = await supabase
    .from("messages")
    .select("created_at")
    .eq("id", input.inboundMessageId)
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_pre_send_inbound_lookup" },
      extra: { inboundMessageId: input.inboundMessageId },
    });
    return { ok: false };
  }
  const ms = data ? Date.parse(data.created_at) : Number.NaN;
  return { ok: true, ms: Number.isNaN(ms) ? null : ms };
}

/**
 * How the caller applies a non-sending decision: the outcome reason, the trace
 * gate name, and (when the table says "flag a human") the flag reason. Null
 * for send / retry / defer.
 */
function skipPlanFor(
  decision: SendGateDecision,
  phase: SendGatePhase,
): { reason: string; trace: string; flagReason: string | null } | null {
  if (decision.action !== "skip") return null;
  switch (decision.rule) {
    case 0:
      // Silent by design; the reason is the pre-existing gate reason.
      return { reason: decision.reason, trace: decision.reason, flagReason: null };
    case 8:
      return { reason: "already_answered", trace: "already_answered", flagReason: null };
    case 1:
      return decision.flag
        ? {
            reason: phase === "early" ? "superseded_by_newer_inbound" : "superseded_before_send",
            trace: phase === "early" ? "superseded_by_newer_inbound" : "superseded_before_send",
            flagReason: "reply_skipped:newer_inbound",
          }
        : {
            reason: phase === "early" ? "superseded_by_newer_inbound" : "superseded_before_send",
            trace: phase === "early" ? "superseded_by_newer_inbound" : "superseded_before_send",
            flagReason: null,
          };
    case 2: {
      // An existing AI reply for this very inbound keeps its historical
      // early-gate reason (`already_replied`).
      const aiEarly = phase === "early" && decision.answeredBy === "ai";
      return {
        reason: aiEarly ? "already_replied" : "already_answered",
        trace: aiEarly ? "already_replied" : "already_answered",
        flagReason: null,
      };
    }
    case 3:
      return {
        reason: "superseded_before_send",
        trace: "superseded_before_send",
        flagReason: "reply_skipped:outbound_since_claim",
      };
    case 4:
      return { reason: "rep_text_scheduled", trace: "rep_text_scheduled", flagReason: null };
    case 5:
      return { reason: "superseded_by_broadcast", trace: "superseded_by_broadcast", flagReason: null };
  }
}

/**
 * Rule 1 evidence: does the newer inbound have a LIVE handler (see
 * `classifyNewerInboundHandler`)? Null = a lookup failed.
 */
async function newerInboundHasLiveHandler(
  supabase: SupabaseClient<Database>,
  newerInboundId: string,
  nowMs: number,
): Promise<boolean | null> {
  const { data: claim, error } = await supabase
    .from("ai_response_claims")
    .select("status, outcome, error_message, lease_expires_at")
    .eq("inbound_message_id", newerInboundId)
    .eq("response_kind", "sms_ai_responder_v1")
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_newer_inbound_claim_lookup" },
      extra: { newerInboundId },
    });
    return null;
  }
  const { data: message, error: messageError } = await supabase
    .from("messages")
    .select("metadata")
    .eq("id", newerInboundId)
    .maybeSingle();
  if (messageError) {
    reportError(new Error(messageError.message), {
      tags: { surface: "ai_responder_newer_inbound_state_lookup" },
      extra: { newerInboundId },
    });
    return null;
  }
  const processing = readJsonObject((message?.metadata ?? null) as Json | null).processing;
  const ai =
    processing && typeof processing === "object" && !Array.isArray(processing)
      ? (processing as Record<string, Json>).aiResponder
      : null;
  const stamp =
    ai && typeof ai === "object" && !Array.isArray(ai)
      ? { outcome: (ai as Record<string, Json>).outcome, workflowRunId: (ai as Record<string, Json>).workflowRunId }
      : null;
  return classifyNewerInboundHandler({ claim: claim ?? null, stamp, nowMs });
}

/**
 * Tunables for waiting on another sender's reservation (tests shrink them).
 * `deadlineMs` is a wall-clock budget INCLUDING RPC time (not an attempt
 * count). `providerTimeoutMs` must stay under `leaseSeconds`; it is the ONE
 * deadline for a whole leased send attempt (key resolution, reservation wait,
 * every preflight read, the provider call), and the lease is renewed at the
 * provider fence immediately before the provider submission.
 */
export const sendReservationTuning = {
  leaseSeconds: 90,
  deadlineMs: 6_000,
  waitDelayMs: 250,
  providerTimeoutMs: 60_000,
  /** Cleanup (lease release) gets its own short deadline; a hang = expired by time. */
  releaseTimeoutMs: 2_000,
};

function providerTimeoutMs(): number {
  const fromEnv = Number(process.env.AI_RESPONDER_SEND_TIMEOUT_MS);
  const wanted =
    Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : sendReservationTuning.providerTimeoutMs;
  return Math.max(1, Math.min(wanted, sendReservationTuning.leaseSeconds * 1000 - 10_000));
}

type ResponderSendArgs = {
  /** Routing-v2 intent authorized by its single-attempt consumer; rechecked at the provider boundary. */
  routingV2OutboxId?: string;
  /** Routing v2 phone action (PR-G): its durable send id, used as the provider idempotency key. */
  providerIdempotencyKey?: string;
  /** §5.4: the work item's test tag (routing v2 outbox row), checked at the provider boundary. */
  testRunId?: string | null;
  /** Routing v2 phone action (PR-G): final flags/canary/suppression check right before the provider. */
  routingV2SendAllowed?: () => Promise<boolean>;
  input: AiDispatchInput;
  body: string;
  model: string;
  confidence: number;
  sentiment: AiMessageMetadata["sentiment"];
  turn: number;
  /** Who authored the text: `llm` for generated replies, `approved_template` for the template step, `human` for a hold click (see `sendHumanDraft`). */
  source: ReplySource;
  /** Set only for a human-approved send: who clicked, and whether they edited the text. */
  approvedBy?: { userId: string; edited: boolean };
  /** The library template behind an `approved_template` send (evidence + message metadata). */
  templateId?: string | null;
  /** The unrendered library text `body` was rendered from; the send-time approval re-check compares it (not the rendered body) to the approved text. Defaults to `body`. */
  templateSource?: string | null;
  /** Mapping key of that template (`number_source` etc.), stored as `reply_key` so a later inbound can tell it is answering that reply. */
  replyKey?: string | null;
  orgId: string;
  /** When this run took its claim; null when unknown (check skipped). */
  claimStartedAt: string | null;
  /** ai_responder_configs.outbound_mode as loaded for this dispatch. */
  outboundMode?: string | null;
  /** Explicit pipeline run handle for evidence steps (null = no run). */
  runContext?: MaybeRunContext;
  /** What produced the body; carried by a retry outcome (see ./retry). */
  replyKind: RetryReply["kind"];
  /** deescalate_close only: the route reason for the follow-up disposition. */
  closeReason?: string;
  /**
   * Called with the outbound message id the instant the provider has accepted
   * the send, BEFORE any metadata update / trace / run update / lease release.
   * Used by the template step to make the sent message durable on its claim.
   * Must not throw.
   */
  onProviderAccepted?: (messageId: string) => Promise<void>;
  /** See runApprovedTemplateStep `windowDeferrable`; also makes the recipient window apply to an identity (llm) send. */
  windowDeferrable?: boolean;
  /**
   * Nine-question identity send only: the body is the fixed human-approved
   * IDENTITY_REPLY_BODY, so the LLM-autosend switch does not hold it (see
   * isApprovedFixedText). Every other guard still applies.
   */
  approvedFixedText?: boolean;
  /**
   * Per-send flag proof, created by `sendResponderMessage` for each call (never
   * shared between runs): set `failed` when this send's own attention flag
   * write could not be proven.
   */
  flagProof?: { failed: boolean };
};

type ResponderSendOutcome =
  | Extract<AiDispatchOutcome, { outcome: "sent" | "escalated" | "skipped" }>
  | AiRetryOutcome;

/**
 * Claim bookkeeping for an outcome. A `retry` leaves the claim in `error`
 * with its lease released so the re-dispatch of the SAME inbound can reclaim
 * it immediately; everything else completes normally.
 */
function retryableClaimError(outcome: { outcome: string; reason?: string; attempt?: number }): string | undefined {
  return outcome.outcome === "retry"
    ? `retry_scheduled:${outcome.reason}:${outcome.attempt}`
    : undefined;
}

/**
 * Re-read the owner's outbound mode right before the provider call; the
 * dispatch-start snapshot can be minutes old (delay workflow). FAILS CLOSED:
 * a lookup error OR no active config row means `hold` (never the stale
 * snapshot), and EITHER-hold-wins still applies.
 */
async function loadLiveOutboundMode(
  supabase: SupabaseClient<Database>,
  orgId: string,
  fallback: string | null | undefined,
): Promise<string | null | undefined> {
  const { data, error } = await supabase
    .from("ai_responder_configs")
    .select("outbound_mode")
    .eq("org_id", orgId)
    .eq("active", true)
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_live_outbound_mode" },
      extra: { orgId },
    });
    return "hold";
  }
  if (!data) return "hold";
  return fallback === "hold" ? "hold" : (data.outbound_mode ?? fallback);
}

/**
 * Called immediately before EVERY mutation made by a leased send attempt
 * (flag, dead letter, draft write, evidence step). It throws
 * `AttemptAbandoned` once the attempt is past its deadline, so a read that
 * resumes after a timeout can decide nothing and write nothing. A caller that
 * is not an attempt (the pre-lease hold path, the deadline handler itself)
 * passes no guard.
 */
type Guard = () => void;
const NO_GUARD: Guard = () => undefined;

/**
 * APPLY a pre-send evaluation (the mutations half of the Q8 gate). Returns an
 * outcome that ends the send, or null to proceed. Every mutation is preceded
 * by `guard()`.
 */
async function applyGateEvaluation(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
  evaluation: GateEvaluation,
  guard: Guard,
): Promise<ResponderSendOutcome | null> {
  if (!evaluation.ok) {
    if (evaluation.reason === "evidence_truncated") {
      guard();
      await trace(supabase, {
        kind: "gate",
        name: "evidence_truncated",
        result: "error",
        detail: { cap: GATE_EVIDENCE_CAP },
      }, args.runContext);
    }
    return failClosed(supabase, args, "send_check_failed", undefined, guard);
  }
  const decision = evaluation.decision;
  if (decision.action === "send" || decision.action === "defer") return null;
  if (decision.action === "retry") {
    // Rule 4: a competing reply is queued and has not been submitted. It does
    // not answer the seller until it leaves and it may still fail, so never
    // skip silently: look again shortly (a competitor that failed is excluded
    // next time and this reply goes out normally).
    guard();
    await trace(supabase, { kind: "gate", name: "reply_pending", result: "block" }, args.runContext);
    return retryOrFailReply(supabase, args, "reply_pending", guard);
  }
  // A-2 C3: a queued v2 reply whose rule 3 fired only because OUR OWN older auto reply (to
  // another seller text) already went out is cancelled quietly; the outbox decides the hold
  // (C1). A person's text (human_unrelated) and every non-v2 caller keep today's flag.
  if (args.routingV2OutboxId && isOwnOlderAutoReplyOnly(decision)) {
    guard();
    await trace(supabase, { kind: "gate", name: V2_OLDER_AUTO_REPLY_SENT, result: "block", detail: { rule: 3 } }, args.runContext);
    return { outcome: "skipped", reason: V2_OLDER_AUTO_REPLY_SENT };
  }
  // A-2 race analysis F1: a queued v2 reply overtaken by a newer seller text (rule 1, flagged or
  // not) is cancelled and nothing more. It never writes a hold and never reads another request's
  // progress: the newer text is routed (or, if its own handler dies, held by the lease-death
  // sweep) on its own lifecycle. Non-v2 callers keep today's rule-1 behaviour.
  const basePlan = skipPlanFor(decision, "presend")!;
  const plan = args.routingV2OutboxId && decision.action === "skip" && decision.rule === 1
    ? { ...basePlan, flagReason: null }
    : basePlan;
  guard();
  await trace(
    supabase,
    decision.rule === 2 || decision.rule === 8
      ? { kind: "gate", name: plan.trace, result: "pass", detail: { rule: decision.rule } }
      : decision.rule === 0
        ? { kind: "gate", name: plan.trace, result: "block", detail: { rule: 0, reason: decision.reason } }
        : { kind: "gate", name: plan.trace, result: "block", detail: { rule: decision.rule } },
    args.runContext,
  );
  if (plan.flagReason) {
    guard();
    // A-2 F2: a queued v2 reply's flag is about our own reply (mechanics): written through the
    // one fenced hold writer, only if no newer seller text exists ('superseded' = the newer text
    // owns the thread: no hold, counted as handled).
    const flagged = args.routingV2OutboxId && args.input.inboundMessageId
      ? await writeV2Hold(supabase, args.input.propertyId, args.input.inboundMessageId, plan.flagReason, "mechanics") !== "error"
      : await markPropertyNeedsAttention(
        supabase,
        args.input.propertyId,
        plan.flagReason,
        args.runContext,
        guard,
      );
    if (!flagged) {
      // The flag could not be proven: the seller is unanswered and no human
      // was told. The reply exists, so it is dead-lettered (rule 7); the
      // claim completes as `flag_failed`, never as handled.
      await writeReplyDeadLetter(supabase, args.runContext, {
        orgId: args.orgId,
        conversationId: args.input.conversationId ?? null,
        propertyId: args.input.propertyId,
        inboundMessageId: args.input.inboundMessageId ?? null,
        body: args.body,
        reason: "flag_failed",
        guard,
      });
      if (args.flagProof) args.flagProof.failed = true;
      return { outcome: "escalated", reason: "flag_failed" };
    }
    return flaggedSkip(plan.reason);
  }
  switch (decision.rule) {
    case 0:
    case 2:
    case 4:
    case 5:
    case 8:
      return silentSkip(plan.reason, decision.rule);
    default:
      // Rule 1 with a live handler elsewhere: silent, but not itself a
      // handler of this inbound (stays a bare `skipped`).
      return { outcome: "skipped", reason: plan.reason };
  }
}

function flagForRetryReason(reason: string): string {
  return reason === "draft_persist_failed" ? reason : `reply_skipped:${reason}`;
}

/**
 * Q8 rule 7, the ONE helper behind every "not sent for a reason other than
 * rules 1-5" exit: the generated reply text is dead-lettered (one retry of
 * the write inside `writeReplyDeadLetter`) and the property is flagged. When
 * the dead letter cannot be written the flag reads
 * `dead_letter_failed:<reason>` (the text then survives only in the retry's
 * durable workflow state). `body: null` = no reply was generated yet, so
 * there is nothing to save. Returns whether the text is safely stored.
 */
export async function flagAndDeadLetter(
  supabase: SupabaseClient<Database>,
  args: {
    runContext?: MaybeRunContext;
    orgId: string;
    conversationId: string | null;
    propertyId: string;
    inboundMessageId: string | null;
    body: string | null;
    /** Dead-letter reason; also the flag reason unless `flagReason` is given. */
    reason: string;
    flagReason?: string;
    guard?: () => void;
    /**
     * Write the flag BEFORE the dead-letter row. The late-send sweeper treats
     * an unresolved `send_timeout` row as proof the flag write already ran, so
     * the timeout path must never insert that row first. If the dead letter
     * then fails, the flag is rewritten to `dead_letter_failed:<reason>`.
     */
    flagFirst?: boolean;
  },
): Promise<{ deadLettered: boolean; flagReason: string; flagged: boolean }> {
  args.guard?.();
  if (args.flagFirst && args.body !== null) {
    const firstReason = args.flagReason ?? args.reason;
    const flagged = await markPropertyNeedsAttention(
      supabase,
      args.propertyId,
      firstReason,
      args.runContext,
      args.guard ?? NO_GUARD,
    );
    args.guard?.();
    const stored = await writeReplyDeadLetter(supabase, args.runContext, {
      orgId: args.orgId,
      conversationId: args.conversationId,
      propertyId: args.propertyId,
      inboundMessageId: args.inboundMessageId,
      body: args.body,
      reason: args.reason,
      guard: args.guard,
    });
    if (stored) return { deadLettered: true, flagReason: firstReason, flagged };
    // Keep the originating identity (`dead_letter_failed:send_timeout:<id>`):
    // a late reconciliation and the orphan repair both bind to the inbound id.
    const failedReason = `dead_letter_failed:${firstReason}`;
    args.guard?.();
    // The flag is already set (needs_human_attention), so rewrite only OUR
    // reason; a different flag reason is never overwritten.
    const { error: rewriteError } = await supabase
      .from("properties")
      .update({ last_ai_escalation_reason: failedReason, updated_at: new Date().toISOString() })
      .eq("id", args.propertyId)
      .eq("last_ai_escalation_reason", firstReason);
    if (rewriteError) {
      reportError(new Error(rewriteError.message), {
        tags: { surface: "ai_responder_dead_letter_failed_flag_rewrite" },
        extra: { propertyId: args.propertyId },
      });
    }
    return { deadLettered: false, flagReason: failedReason, flagged: flagged && !rewriteError };
  }
  const deadLettered =
    args.body === null
      ? true
      : await writeReplyDeadLetter(supabase, args.runContext, {
          orgId: args.orgId,
          conversationId: args.conversationId,
          propertyId: args.propertyId,
          inboundMessageId: args.inboundMessageId,
          body: args.body,
          reason: args.reason,
          guard: args.guard,
        });
  const flagReason = deadLettered
    ? (args.flagReason ?? args.reason)
    : `dead_letter_failed:${args.reason}`;
  args.guard?.();
  const flagged = await markPropertyNeedsAttention(
    supabase,
    args.propertyId,
    flagReason,
    args.runContext,
    args.guard ?? NO_GUARD,
  );
  return { deadLettered, flagReason, flagged };
}

async function flagAndDeadLetterFor(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
  reason: string,
  options: { flagReason?: string; guard?: Guard; flagFirst?: boolean } = {},
) {
  const result = await flagAndDeadLetter(supabase, {
    runContext: args.runContext,
    orgId: args.orgId,
    conversationId: args.input.conversationId ?? null,
    propertyId: args.input.propertyId,
    inboundMessageId: args.input.inboundMessageId ?? null,
    body: args.body,
    reason,
    ...options,
  });
  if (!result.flagged && args.flagProof) args.flagProof.failed = true;
  return result;
}

/**
 * Fail-closed exits that are NOT retried (the seller must not be double-texted
 * or the cause is unknowable): the generated reply is dead-lettered, then the
 * property is flagged. Reason `send_check_failed` (any pre-send lookup / RPC
 * could not be trusted) or `send_timeout` (the provider request may still
 * land).
 */
async function failClosed(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
  reason: "send_check_failed" | "send_timeout",
  detail?: { timeoutMs: number },
  guard: Guard = NO_GUARD,
): Promise<ResponderSendOutcome> {
  guard();
  await trace(supabase, {
    kind: "gate",
    name: reason,
    result: "error",
    ...(detail ? { detail } : {}),
  }, args.runContext);
  const flagResult = await flagAndDeadLetterFor(
    supabase,
    args,
    reason,
    reason === "send_timeout"
      ? { guard, flagFirst: true, flagReason: sendTimeoutFlagReason(args.input.inboundMessageId ?? null) }
      : { guard },
  );
  const inboundForBacking = args.input.inboundMessageId ?? null;
  if (reason === "send_timeout" && inboundForBacking && flagResult.deadLettered) {
    // The dead-letter row now exists, so this flag can never be an orphan:
    // mark it `:backed` so the orphan scan excludes it server-side. Conditional
    // on the exact original reason; zero rows = someone replaced it, which is fine.
    guard();
    const { error: backedError } = await supabase
      .from("properties")
      .update({
        last_ai_escalation_reason: sendTimeoutBackedFlagReason(inboundForBacking),
        updated_at: new Date().toISOString(),
      })
      .eq("id", args.input.propertyId)
      .eq("last_ai_escalation_reason", sendTimeoutFlagReason(inboundForBacking));
    if (backedError) {
      reportError(new Error(backedError.message), {
        tags: { surface: "ai_responder_send_timeout_backed_flag" },
        extra: { propertyId: args.input.propertyId },
      });
    }
  }
  return { outcome: "escalated", reason };
}

/**
 * The flag reason written for a provider timeout. It carries the originating
 * inbound id (`send_timeout:<inbound_id>`) so a late reconciliation can only
 * ever convert ITS OWN timeout flag, never a later timeout's.
 */
const SEND_TIMEOUT_FLAG_PREFIX = "send_timeout:";
function sendTimeoutFlagReason(inboundMessageId: string | null): string {
  return inboundMessageId ? `${SEND_TIMEOUT_FLAG_PREFIX}${inboundMessageId}` : "send_timeout";
}
const DEAD_LETTER_FAILED_TIMEOUT_PREFIX = `dead_letter_failed:${SEND_TIMEOUT_FLAG_PREFIX}`;
const SEND_TIMEOUT_BACKED_SUFFIX = ":backed";
/** `send_timeout:<id>:backed`: the dead-letter row exists, so the orphan scan skips this flag. */
function sendTimeoutBackedFlagReason(inboundMessageId: string): string {
  return `${SEND_TIMEOUT_FLAG_PREFIX}${inboundMessageId}${SEND_TIMEOUT_BACKED_SUFFIX}`;
}
/** Every flag spelling a timeout for this inbound can carry (identity-bound). */
function sendTimeoutFlagReasons(inboundMessageId: string | null): string[] {
  const primary = sendTimeoutFlagReason(inboundMessageId);
  return inboundMessageId
    ? [
        primary,
        `${primary}${SEND_TIMEOUT_BACKED_SUFFIX}`,
        `dead_letter_failed:${primary}`,
        `dead_letter_failed:${primary}${SEND_TIMEOUT_BACKED_SUFFIX}`,
      ]
    : [primary, `dead_letter_failed:${primary}`];
}
/** Inbound id carried by a `send_timeout:<id>[:backed]` / `dead_letter_failed:send_timeout:<id>` flag. */
function inboundIdFromTimeoutFlag(reason: string | null | undefined): string | null {
  if (!reason) return null;
  let rest = reason.startsWith(DEAD_LETTER_FAILED_TIMEOUT_PREFIX)
    ? reason.slice(DEAD_LETTER_FAILED_TIMEOUT_PREFIX.length)
    : reason.startsWith(SEND_TIMEOUT_FLAG_PREFIX)
      ? reason.slice(SEND_TIMEOUT_FLAG_PREFIX.length)
      : "";
  if (rest.endsWith(SEND_TIMEOUT_BACKED_SUFFIX)) rest = rest.slice(0, -SEND_TIMEOUT_BACKED_SUFFIX.length);
  return rest.length > 0 ? rest : null;
}

/**
 * A reply that could not be sent or stored. While retries remain, nothing is
 * flagged or completed: the caller re-dispatches the same inbound through the
 * delay workflow (REPLY_RETRY_DELAY_SECONDS later, REPLY_RETRY_MAX times),
 * carrying the generated reply so the retry re-sends it verbatim. On the last
 * attempt: dead-letter the text, and flag the property so a human sees it.
 */
async function retryOrFailReply(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
  reason: RetryReason,
  guard: Guard = NO_GUARD,
): Promise<ResponderSendOutcome> {
  const attempt = args.input.retryAttempt ?? 0;
  if (attempt < REPLY_RETRY_MAX) {
    return {
      outcome: "retry",
      reason,
      attempt: attempt + 1,
      delaySeconds: REPLY_RETRY_DELAY_SECONDS,
      reply: {
        body: args.body,
        confidence: args.confidence,
        sentiment: args.sentiment,
        orgId: args.orgId,
        kind: args.replyKind,
        ...(args.closeReason ? { closeReason: args.closeReason } : {}),
      },
    };
  }
  await flagAndDeadLetterFor(supabase, args, reason, {
    flagReason: flagForRetryReason(reason),
    guard,
  });
  return { outcome: "escalated", reason };
}

/**
 * Store a held reply exactly once per inbound. Reuses an existing PENDING
 * draft for the inbound (already stored). A `sent` draft means a human already
 * answered; a `discarded` draft means a human decided NOT to answer: neither
 * is ever revived by a retry, both end the dispatch as already_answered.
 */
async function persistHeldDraft(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
  guard: Guard = NO_GUARD,
): Promise<"stored" | "already_resolved" | { error: { message: string } }> {
  guard();
  const inboundId = args.input.inboundMessageId ?? null;
  if (inboundId) {
    const { data: existing, error: lookupError } = await supabase
      .from("ai_reply_drafts")
      .select("id, status, created_at")
      .eq("inbound_message_id", inboundId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (lookupError) return { error: lookupError };
    const rows = existing ?? [];
    if (rows.some((d) => d.status === "sent" || d.status === "discarded")) {
      return "already_resolved";
    }
    if (rows.some((d) => d.status === "pending")) return "stored";
  }
  // The lookup above awaits: an attempt that expired meanwhile must not insert.
  guard();
  const { error: draftError } = await supabase.from("ai_reply_drafts").insert({
    org_id: args.orgId,
    run_id: args.runContext?.runId ?? null,
    conversation_id: args.input.conversationId ?? null,
    property_id: args.input.propertyId,
    inbound_message_id: inboundId,
    body: args.body,
    source: args.source,
    status: "pending",
  });
  // 23505 = the unique pending-draft-per-inbound index: a concurrent run
  // stored it first, which is success.
  if (draftError && (draftError as { code?: string }).code !== "23505") {
    return { error: draftError };
  }
  return "stored";
}

async function holdReplyAsDraft(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
  reason: "outbound_mode_hold" | "llm_autosend_off",
  guard: Guard = NO_GUARD,
): Promise<ResponderSendOutcome> {
  guard();
  const persisted = await persistHeldDraft(supabase, args, guard);
  guard();
  if (persisted === "already_resolved") {
    await trace(supabase, { kind: "gate", name: "already_answered", result: "pass" }, args.runContext);
    return silentSkip("already_answered", 8);
  }
  if (typeof persisted === "object") {
    reportError(new Error(persisted.error.message), {
      tags: { surface: "ai_responder_draft_insert" },
      // Ids only: the reply text is preserved by the dead letter, never by this
      // routine report.
      extra: {
        propertyId: args.input.propertyId,
        inboundMessageId: args.input.inboundMessageId ?? null,
      },
    });
    await trace(supabase, {
      kind: "gate",
      name: "draft_persist_failed",
      result: "error",
      detail: { source: args.source, reason, attempt: args.input.retryAttempt ?? 0 },
    }, args.runContext);
    return retryOrFailReply(supabase, args, "draft_persist_failed", guard);
  }
  await trace(supabase, {
    kind: "hold",
    name: "llm_draft_held",
    result: "held",
    detail: { source: args.source, reason, stored: true },
  }, args.runContext);
  guard();
  const heldFlagged = await markPropertyNeedsAttention(
    supabase,
    args.input.propertyId,
    "draft_held",
    args.runContext,
    guard,
  );
  if (!heldFlagged && args.flagProof) args.flagProof.failed = true;
  return { outcome: "escalated", reason: "draft_held" };
}

/**
 * One attempt at a leased send. `abandoned` flips when the attempt's overall
 * deadline passes (or the provider fence refuses); an abandoned attempt can
 * never reach the provider and stops at its next checkpoint, so a late
 * completion of a paused await can neither submit nor flag nor write.
 */
type SendAttempt = {
  abandoned: boolean;
  /** The provider fence let the submission through (set synchronously). */
  providerStarted: boolean;
  deadlineAt: number;
  holder: string;
  conversationKey: string | null;
  reserved: boolean;
  fenceRefusal: null | "lost" | "error" | "abandoned" | "revalidate";
  /** Why the fence's live re-validation refused (`fence:suppressed`, ...). */
  fenceReason?: string;
  /** The recipient-window verdict's reason when the fence refused on it (`outside_window`, `florida_cap`, ...). */
  fenceWindowWhy?: string;
};

class AttemptAbandoned extends Error {
  constructor() {
    super("ai send attempt abandoned");
  }
}

/** The attempt may still act: not abandoned and inside its deadline (which is
 * always shorter than the lease, so "in time" also means "lease still ours"). */
function attemptValid(attempt: SendAttempt): boolean {
  return !attempt.abandoned && Date.now() < attempt.deadlineAt;
}

function assertLive(attempt: SendAttempt): void {
  if (!attemptValid(attempt)) {
    attempt.abandoned = true;
    throw new AttemptAbandoned();
  }
}

async function reserveSend(
  supabase: SupabaseClient<Database>,
  conversationKey: string,
  inboundMessageId: string | null,
  attempt: SendAttempt,
): Promise<"reserved" | "elsewhere" | "error"> {
  const deadline = Date.now() + sendReservationTuning.deadlineMs;
  for (;;) {
    assertLive(attempt);
    const { data, error } = await supabase.rpc("fn_reserve_ai_send", {
      p_conversation_id: conversationKey,
      p_inbound_message_id: inboundMessageId ?? null,
      p_holder: attempt.holder,
      p_lease_seconds: sendReservationTuning.leaseSeconds,
    });
    if (error) {
      reportError(new Error(error.message), {
        tags: { surface: "ai_responder_send_reserve" },
        extra: { conversationKey },
      });
      return "error";
    }
    if (data === true) {
      attempt.reserved = true;
      return "reserved";
    }
    if (Date.now() + sendReservationTuning.waitDelayMs > deadline) return "elsewhere";
    await new Promise((resolve) => setTimeout(resolve, sendReservationTuning.waitDelayMs));
  }
}

/**
 * Release the lease, with its OWN short deadline: cleanup must never hold the
 * outcome hostage. A release that hangs is treated as expired-by-time (the
 * lease lapses on its own), reported, and the caller carries on.
 */
async function releaseSend(
  supabase: SupabaseClient<Database>,
  conversationKey: string,
  holder: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = (async () => {
    try {
      const { error } = await supabase.rpc("fn_release_ai_send", {
        p_conversation_id: conversationKey,
        p_holder: holder,
      });
      if (error) {
        reportError(new Error(error.message), {
          tags: { surface: "ai_responder_send_release" },
          extra: { conversationKey },
        });
      }
    } catch (e) {
      reportError(e, {
        tags: { surface: "ai_responder_send_release" },
        extra: { conversationKey },
      });
    }
  })();
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      reportError(new Error("ai send lease release timed out"), {
        tags: { surface: "ai_responder_send_release_timeout" },
        extra: { conversationKey },
      });
      resolve();
    }, sendReservationTuning.releaseTimeoutMs);
  });
  try {
    await Promise.race([release, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Verify the lease is still ours and push its expiry out a full lease. */
async function renewSend(
  supabase: SupabaseClient<Database>,
  conversationKey: string,
  holder: string,
): Promise<"renewed" | "lost" | "error"> {
  const { data, error } = await supabase.rpc("fn_renew_ai_send", {
    p_conversation_id: conversationKey,
    p_holder: holder,
    p_lease_seconds: sendReservationTuning.leaseSeconds,
  });
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_send_renew" },
      extra: { conversationKey },
    });
    return "error";
  }
  return data === true ? "renewed" : "lost";
}

/**
 * The provider fence: sendSmsToContact awaits this as the LAST step before the
 * provider submission (after every preflight await). The attempt must still be
 * live and inside its deadline AND the lease must still be ours (renewed to a
 * full lease so the bounded provider call cannot outlive it). Anything else
 * refuses, and the provider is never called.
 */
const FENCE_QUIET_HOURS_RECIPIENT = "fence:quiet_hours_recipient";
const FENCE_TEMPLATE_APPROVAL_CHANGED = "fence:template_approval_changed";
const FENCE_NINE_CONTEXT_CHANGED = "fence:nine_deferred_context_changed";
const FENCE_PROPERTY_WINDOW = "fence:property_window";

async function fenceProviderSubmit(
  supabase: SupabaseClient<Database>,
  attempt: SendAttempt,
  args: ResponderSendArgs,
  ctx: { messageId?: string } = {},
): Promise<boolean> {
  const pastDeadline = () => attempt.abandoned || Date.now() >= attempt.deadlineAt;
  if (pastDeadline() || !attempt.conversationKey) {
    attempt.abandoned = true;
    attempt.fenceRefusal = "abandoned";
    return false;
  }
  const renewed = await renewSend(supabase, attempt.conversationKey, attempt.holder);
  if (pastDeadline()) {
    attempt.abandoned = true;
    attempt.fenceRefusal = "abandoned";
    return false;
  }
  if (renewed !== "renewed") {
    attempt.fenceRefusal = renewed;
    return false;
  }
  // Re-validate the facts that can change in the window between the earlier
  // checks and the submission: suppression / opt-out (Rule 0), the send-gate
  // facts (newer inbound, a competitor that answered or was submitted; this
  // attempt's own pending row excluded) and the live outbound policy. Any
  // unreadable fact refuses (fail closed).
  const refuse = (reason: string): false => {
    attempt.fenceRefusal = "revalidate";
    attempt.fenceReason = reason;
    return false;
  };
  const evaluation = await evaluateSendGate(supabase, args.input, {
    ...((args as { routingV2OutboxId?: string }).routingV2OutboxId ? { mechanicsYield: "outbox" as const } : {}),
    phase: "presend",
    claimStartedAt: args.claimStartedAt,
    checkNewerInbound: !!args.input.inboundMessageId,
    excludeMessageId: ctx.messageId,
    humanActor: args.source === "human",
  });
  if (pastDeadline()) {
    attempt.abandoned = true;
    attempt.fenceRefusal = "abandoned";
    return false;
  }
  if (!evaluation.ok) return refuse("fence:gate:error");
  const decision = evaluation.decision;
  if (decision.action !== "send") {
    return refuse(decision.action === "skip" && decision.rule === 0 ? "fence:suppressed" : `fence:gate:${decision.rule}`);
  }
  const liveMode = await loadLiveOutboundMode(supabase, args.orgId, args.outboundMode);
  if (pastDeadline()) {
    attempt.abandoned = true;
    attempt.fenceRefusal = "abandoned";
    return false;
  }
  if (resolveOutboundPolicy({ source: args.source, dbMode: liveMode, approvedFixedText: isApprovedFixedText(args) }).hold) return refuse("fence:hold");
  if (args.windowDeferrable) {
    // The property's own window (business hours / quiet hours: the same checkQuietHours rule
    // sendSmsToContact applies at its step 4, which runs BEFORE several awaits). Re-checked
    // here so a deferrable nine reply cannot reach the provider after it closes.
    const { data: prop, error: propError } = await supabase
      .from("properties")
      .select("state")
      .eq("id", args.input.propertyId)
      .maybeSingle();
    if (pastDeadline()) {
      attempt.abandoned = true;
      attempt.fenceRefusal = "abandoned";
      return false;
    }
    const propertyWindow = propError || !prop ? null : checkQuietHours(prop.state);
    if (!propertyWindow || !propertyWindow.ok) {
      attempt.fenceWindowWhy = propertyWindow && !propertyWindow.ok ? propertyWindow.reason : "unreadable";
      return refuse(FENCE_PROPERTY_WINDOW);
    }
  }
  if (args.source === "approved_template" || args.windowDeferrable) {
    // The last word before the provider, AFTER every preflight read in
    // sendSmsToContact: the owner may have revoked / edited / deleted the
    // template and the recipient's window (or the Florida cap) may have
    // closed while those reads ran. This attempt's own pending row is
    // excluded from the cap count.
    const window = await evaluateRecipientWindow(supabase, args.input, ctx.messageId);
    if (pastDeadline()) {
      attempt.abandoned = true;
      attempt.fenceRefusal = "abandoned";
      return false;
    }
    if (!window.ok) {
      attempt.fenceWindowWhy = window.why;
      return refuse(FENCE_QUIET_HOURS_RECIPIENT);
    }
    // An identity (llm) send has no library template to re-check.
    const approved = args.source === "approved_template" ? await templateStillApproved(supabase, args) : true;
    if (pastDeadline()) {
      attempt.abandoned = true;
      attempt.fenceRefusal = "abandoned";
      return false;
    }
    if (!approved) return refuse(FENCE_TEMPLATE_APPROVAL_CHANGED);
  }
  const deferral = args.input.nineDeferral;
  if (deferral) {
    // A deferred nine-question reply acts only on the lead it decided on: compare the live
    // revision, allowing exactly the one bump this attempt's own pending message row causes.
    const { data: live, error: liveError } = await supabase
      .from("properties")
      .select("decision_context_revision")
      .eq("id", args.input.propertyId)
      .maybeSingle();
    if (pastDeadline()) {
      attempt.abandoned = true;
      attempt.fenceRefusal = "abandoned";
      return false;
    }
    const expected = deferral.revision + (ctx.messageId ? 1 : 0);
    if (liveError || !live || live.decision_context_revision !== expected) return refuse(FENCE_NINE_CONTEXT_CHANGED);
  }
  if (args.routingV2OutboxId) {
    await testBarrier("outbox:before_fence", { propertyId: args.input.propertyId, inboundMessageId: args.input.inboundMessageId ?? null });
    const { data, error } = await (supabase as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
    }).rpc("routing_v2_check_authorized_outbox_send", {
      p_outbox_id: args.routingV2OutboxId,
      p_property_id: args.input.propertyId,
      p_inbound_message_id: args.input.inboundMessageId ?? null,
    });
    if (pastDeadline()) {
      attempt.abandoned = true;
      attempt.fenceRefusal = "abandoned";
      return false;
    }
    if (error || data !== "ok") return refuse("fence:routing_v2_outbox");
  }
  if (args.routingV2SendAllowed) {
    let allowed = false;
    try {
      allowed = await args.routingV2SendAllowed();
    } catch {
      allowed = false;
    }
    if (pastDeadline()) {
      attempt.abandoned = true;
      attempt.fenceRefusal = "abandoned";
      return false;
    }
    if (!allowed) return refuse("fence:routing_v2_phone_action");
  }
  attempt.providerStarted = true;
  return true;
}

/**
 * The reservation key for a thread. conversation ids are assigned per
 * (contact, property) by ensureConversationIdForThread (the same function
 * resolveInboundThread uses), so a run that arrives without a conversation id
 * resolves the SAME id instead of falling back to the contact id; every run
 * in a thread therefore contends on one key. Null = could not resolve.
 */
async function resolveReservationKey(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
): Promise<string | null> {
  if (input.conversationId) return input.conversationId;
  try {
    return await ensureConversationIdForThread(supabase, input.contactId, input.propertyId);
  } catch (e) {
    reportError(e, {
      tags: { surface: "ai_responder_reservation_key" },
      extra: { propertyId: input.propertyId },
    });
    return null;
  }
}

/**
 * The number this send will ACTUALLY text: the same choice `sendSmsToContact`
 * makes (the thread's number when the inbound named one, else the best saved
 * phone via selectBestSmsPhone). Quiet hours and the Florida cap must follow
 * this number, not whichever number the inbound happened to arrive from. null
 * (no contact, no match, unreadable) fails closed upstream.
 */
async function resolveSendDestinationPhone(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select("phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type")
    .eq("id", input.contactId)
    .maybeSingle();
  if (error || !data) {
    reportError(new Error(error?.message ?? "contact not found for send destination"), {
      tags: { surface: "ai_responder_send_destination" },
      extra: { contactId: input.contactId },
    });
    return null;
  }
  const choice = input.inboundFromPhone
    ? selectSmsPhoneByNumber(data, input.inboundFromPhone)
    : selectBestSmsPhone(data);
  return normalizePhone(choice?.phone ?? null);
}

/**
 * Outbound SMS to THIS destination number in the last 24h that reached (or may
 * have reached) the provider; null = unreadable. Counted per destination phone
 * (a seller's second number is a different recipient).
 */
async function countRecentOutboundTexts(
  supabase: SupabaseClient<Database>,
  contactId: string,
  destinationPhone: string,
  /** This attempt's own pending row, which must not count against its own cap. */
  excludeMessageId?: string,
): Promise<number | null> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let countQuery = supabase
    .from("messages")
    .select("*", { count: "exact", head: true });
  if (excludeMessageId) countQuery = countQuery.neq("id", excludeMessageId);
  const { count, error } = await countQuery
    .eq("contact_id", contactId)
    .eq("to_address", destinationPhone)
    .eq("channel", "sms")
    .eq("direction", "outbound")
    .gte("created_at", since)
    .or("metadata->>abortedBeforeProvider.is.null,metadata->>abortedBeforeProvider.neq.true")
    .is("metadata->>aborted_inbound_message_id", null);
  if (error || count === null || count === undefined) {
    reportError(new Error(error?.message ?? "missing outbound count"), {
      tags: { surface: "ai_responder_recipient_cap_count" },
      extra: { contactId },
    });
    return null;
  }
  return count;
}

type RecipientWindowVerdict =
  | { ok: true; state: string; localTime: string }
  | { ok: false; why: string; state: string | null; localTime: string | null };

/**
 * Is the RECIPIENT's local clock inside the send window, and (Florida) under
 * the 3-per-24h cap for the number that will be texted? Side-effect free: no
 * flag, no dead letter, no trace. Unresolvable state / destination / count
 * fails closed.
 */
async function evaluateRecipientWindow(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  excludeMessageId?: string,
): Promise<RecipientWindowVerdict> {
  const phone = await resolveSendDestinationPhone(supabase, input);
  const window = checkRecipientQuietHours(phone);
  if (!window.ok) {
    return { ok: false, why: window.reason, state: window.state, localTime: window.localTime };
  }
  if (window.florida) {
    const cap = checkFloridaCap(
      phone ? await countRecentOutboundTexts(supabase, input.contactId, phone, excludeMessageId) : null,
    );
    if (!cap.ok) return { ok: false, why: cap.reason, state: window.state, localTime: window.localTime };
  }
  return { ok: true, state: window.state, localTime: window.localTime };
}

/**
 * Recipient-local quiet hours for a template send (PLAN 4.10). Returns the
 * escalated outcome when the send must not go out now, else null. This is the
 * last line of defence inside the send path (the template step normally drops
 * the template earlier, without a flag, via `evaluateRecipientWindow`).
 */
async function refuseOutsideRecipientWindow(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
): Promise<ResponderSendOutcome | null> {
  const verdict = await evaluateRecipientWindow(supabase, args.input);
  if (verdict.ok) {
    await trace(supabase, {
      kind: "gate",
      name: "quiet_hours_recipient",
      result: "pass",
      detail: { state: verdict.state, localTime: verdict.localTime },
    }, args.runContext);
    return null;
  }
  await trace(supabase, {
    kind: "gate",
    name: "quiet_hours_recipient",
    result: "block",
    detail: { reason: verdict.why, state: verdict.state, localTime: verdict.localTime },
  }, args.runContext);
  // Window-only refusal of a deferrable nine reply: nothing flagged, the caller defers.
  if (args.windowDeferrable && verdict.why === "outside_window") return { outcome: "skipped", reason: NINE_WINDOW_CLOSED };
  await flagAndDeadLetterFor(supabase, args, "quiet_hours_recipient");
  return { outcome: "escalated", reason: "quiet_hours_recipient" };
}

async function sendResponderMessage(
  supabase: SupabaseClient<Database>,
  rawArgs: ResponderSendArgs,
): Promise<ResponderSendOutcome> {
  const flagProof = { failed: false };
  const outcome = await sendResponderMessageInner(supabase, { ...rawArgs, flagProof });
  if (flagProof.failed && outcome.outcome === "escalated") markFlagFailed(outcome);
  return outcome;
}

/**
 * A human clicked Send on a held draft (Messages v2 holds rail). The text goes
 * through the SAME chokepoint as every other responder send, so the Q8 table,
 * the per-conversation lease, the suppression / consent / quiet-hours checks
 * inside `sendSmsToContact`, and the one-reply-per-inbound guard all run at
 * click time; a stale draft is refused, never sent.
 *
 * Differences from an AI send, all deliberate: `source: "human"` (never held
 * by the AI outbound policy); the property being flagged for a human does not
 * refuse the click (that flag is what put the draft on the rail); there is no
 * claim and nothing is re-scheduled: a transient refusal (`retryable`) is shown
 * to the user, who clicks again.
 */
export type HumanDraftSendInput = {
  orgId: string;
  propertyId: string;
  contactId: string;
  conversationId: string | null;
  inboundMessageId: string | null;
  /** The number that texted us, so the reply goes to the same phone. */
  inboundFromPhone?: string | null;
  /** The text to send (the draft, or the human's edit of it). */
  body: string;
  userId: string;
  edited: boolean;
  runContext?: MaybeRunContext;
};

export type HumanDraftSendResult =
  | { status: "sent"; messageId: string }
  | {
      status: "refused";
      /** Machine reason (a Q8 skip reason, or a send failure reason). */
      reason: string;
      /** The send was refused for a transient reason; clicking again may work. */
      retryable: boolean;
      /** The refusal flagged the property for a human (or it already was). */
      flagged: boolean;
    };

export async function sendHumanDraft(
  supabase: SupabaseClient<Database>,
  input: HumanDraftSendInput,
): Promise<HumanDraftSendResult> {
  const outcome = await sendResponderMessage(supabase, {
    input: {
      propertyId: input.propertyId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      inboundFromPhone: input.inboundFromPhone ?? null,
      inboundBody: "",
      inboundMessageId: input.inboundMessageId,
    },
    body: input.body,
    model: "human",
    confidence: 1,
    sentiment: "neutral",
    turn: 0,
    source: "human",
    approvedBy: { userId: input.userId, edited: input.edited },
    orgId: input.orgId,
    claimStartedAt: null,
    runContext: input.runContext,
    replyKind: "send_reply",
  });
  if (outcome.outcome === "sent") {
    return { status: "sent", messageId: outcome.messageId };
  }
  if (outcome.outcome === "retry") {
    return { status: "refused", reason: outcome.reason, retryable: true, flagged: false };
  }
  return {
    status: "refused",
    reason: outcome.reason,
    retryable: false,
    flagged: outcome.outcome === "escalated" || outcomeMeta.get(outcome)?.flagged === true,
  };
}

async function sendResponderMessageInner(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
): Promise<ResponderSendOutcome> {
  // Rules 0 and 8 (suppression / terminal draft) are the FIRST thing every
  // gate evaluation checks (see `evaluateSendGate`), on both the hold path and
  // under the send lease.

  // Outbound policy (rollback to draft-only + D5). Lives here so immediate
  // dispatch AND the resumed delay workflow both hit it. A held reply sends
  // nothing, so it needs no reservation, but it still must be current.
  const initialPolicy = resolveOutboundPolicy({
    source: args.source,
    dbMode: args.outboundMode,
    approvedFixedText: isApprovedFixedText(args),
  });
  if (initialPolicy.hold) {
    const evaluation = await evaluateSendGate(supabase, args.input, {
      ...((args as { routingV2OutboxId?: string }).routingV2OutboxId ? { mechanicsYield: "outbox" as const } : {}),
      phase: "presend",
      claimStartedAt: args.claimStartedAt,
      checkNewerInbound: !!args.input.inboundMessageId,
      humanActor: args.source === "human",
    });
    const stale = await applyGateEvaluation(supabase, args, evaluation, NO_GUARD);
    if (stale) return stale;
    return holdReplyAsDraft(supabase, args, initialPolicy.reason);
  }

  // Template auto-sends are also gated on the RECIPIENT's local time (8am-9pm,
  // Florida 8am-8pm + 3 texts per 24h): the property's state is not where the
  // seller is. A refusal is a rule 7 exit (flag a human, text dead-lettered).
  if (args.source === "approved_template" || args.windowDeferrable) {
    const refused = await refuseOutsideRecipientWindow(supabase, args);
    if (refused) return refused;
  }

  // Send reservation: a per-conversation lease. Claims are per inbound
  // message, so two inbounds in one conversation can both pass every
  // dispatch-entry check; the lease serialises the re-check + provider call so
  // exactly one of them can send.
  //
  // ONE overall deadline bounds the whole attempt (key resolution, the
  // reservation wait, every preflight read, the provider call). If it passes
  // the attempt is abandoned: it can never reach the provider (the fence
  // refuses), it stops at its next checkpoint, and every mutation it would
  // make is guarded (see `Guard`).
  const attempt: SendAttempt = {
    abandoned: false,
    providerStarted: false,
    deadlineAt: Date.now() + providerTimeoutMs(),
    holder: randomUUID(),
    conversationKey: null,
    reserved: false,
    fenceRefusal: null,
  };
  let keepLease = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    type Raced = { kind: "done"; outcome: ResponderSendOutcome } | { kind: "deadline" };
    const done: Promise<Raced> = leasedSend(supabase, args, attempt).then(
      (outcome): Raced => ({ kind: "done", outcome }),
      (e: unknown): Raced => {
        if (e instanceof AttemptAbandoned) return { kind: "deadline" };
        throw e;
      },
    );
    const deadline = new Promise<Raced>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "deadline" }), providerTimeoutMs());
    });
    const raced = await Promise.race([done, deadline]);
    if (raced.kind === "done") return raced.outcome;
    // The deadline won: `done` may still settle later. A late failure must be
    // reported, never left as an unhandled rejection.
    done.catch((e: unknown) =>
      reportError(e, {
        tags: { surface: "ai_responder_late_attempt_error" },
        extra: { propertyId: args.input.propertyId },
      }),
    );

    attempt.abandoned = true;
    if (attempt.providerStarted) {
      // The provider request may still be in flight and complete: this run does
      // NOT retry it (a second send could double-text). Keep the lease until it
      // expires so nobody else sends over it; dead-letter + flag a human.
      keepLease = true;
      const timedOut = failClosed(supabase, args, "send_timeout", { timeoutMs: providerTimeoutMs() });
      reconcileLateSend(supabase, args, done, timedOut);
      return await timedOut;
    }
    // Nothing reached the provider and nothing ever will (the fence refuses an
    // abandoned attempt): safe to retry.
    await trace(supabase, {
      kind: "gate",
      name: "send_preflight_timeout",
      result: "block",
      detail: { attempt: args.input.retryAttempt ?? 0 },
    }, args.runContext);
    return await retryOrFailReply(supabase, args, "send_preflight_timeout");
  } finally {
    clearTimeout(timer);
    if (attempt.reserved && attempt.conversationKey && !keepLease) {
      await releaseSend(supabase, attempt.conversationKey, attempt.holder);
    }
  }
}

/**
 * Run post-response work so it is not dropped when the invocation freezes:
 * Next's `after()` (what the rest of the codebase uses), falling back to a
 * plain detached promise outside a request scope (workflow steps, tests).
 * The task never throws.
 */
function runAfterResponse(task: () => Promise<void>): void {
  const safe = async () => {
    try {
      await task();
    } catch (e) {
      reportError(e, { tags: { surface: "ai_responder_after_task" } });
    }
  };
  try {
    after(safe);
  } catch {
    void safe();
  }
}

/**
 * A provider timeout is flagged `send_timeout:<inbound_id>` and the reply
 * dead-lettered because the request may still land. When the provider ACCEPTS it late (the abandoned
 * attempt's delivery reconciliation completes with `sent` after the deadline)
 * the flag would otherwise invite a human to re-send a text the seller already
 * has. Reconcile (`reconcileLateSendForInbound`). In-process this is scheduled
 * through `runAfterResponse` so it survives the response; the durable intent is
 * the `send_timeout` dead-letter row written by the timeout path while the
 * provider call is still in flight, which `sweepLateSends` (run by the
 * stale-run cron) finishes if this invocation dies first.
 */
function reconcileLateSend(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
  attempt: Promise<{ kind: "done"; outcome: ResponderSendOutcome } | { kind: "deadline" }>,
  timeoutHandled: Promise<unknown>,
): void {
  runAfterResponse(async () => {
    let late: { kind: "done"; outcome: ResponderSendOutcome } | { kind: "deadline" };
    try {
      late = await attempt;
    } catch {
      return; // already reported by the caller's late-error handler
    }
    if (late.kind !== "done" || late.outcome.outcome !== "sent") return;
    try {
      await timeoutHandled;
    } catch {
      // The timeout path failed; still record that the text went out.
    }
    await reconcileLateSendForInbound(supabase, {
      runContext: args.runContext,
      orgId: args.orgId,
      conversationId: args.input.conversationId ?? null,
      propertyId: args.input.propertyId,
      inboundMessageId: args.input.inboundMessageId ?? null,
      body: args.body,
      confirmedSent: true,
    });
  });
}

/**
 * Idempotently record that a timed-out send was ACCEPTED BY THE PROVIDER late
 * (acceptance, not delivery: the provider took the text after our timeout).
 * Appends a `sent_late` marker dead-letter row (the table is insert-only; the
 * reason name is historical, read it as "accepted by provider late") and moves
 * the flag reason from `send_timeout:<inbound_id>` (or the insert-failure
 * fallback `dead_letter_failed:send_timeout:<inbound_id>`) to
 * `send_timeout_then_sent`, but ONLY while the flag still carries THIS inbound's identity (a newer flag
 * reason, including another inbound's timeout, is never overwritten).
 *
 * The flag update runs EVERY time, even when the marker already exists: the
 * sweeper can write the marker between the timeout path's dead-letter insert
 * and its flag write, which would otherwise leave the flag stuck. It is
 * idempotent (matches nothing once converted). Without `confirmedSent` the AI
 * reply row for the inbound must be sent / delivered (the sweeper path).
 */
export async function reconcileLateSendForInbound(
  supabase: SupabaseClient<Database>,
  args: {
    runContext?: MaybeRunContext;
    orgId: string;
    conversationId: string | null;
    propertyId: string;
    inboundMessageId: string | null;
    body: string;
    confirmedSent?: boolean;
  },
): Promise<"reconciled" | "already_reconciled" | "not_sent" | "error"> {
  try {
    let markerExisted = false;
    if (args.inboundMessageId) {
      if (!args.confirmedSent) {
        const lookup = await lookupAiReplyForInbound(supabase, args.inboundMessageId);
        // A failed lookup is NOT "not sent": surface it so callers skip the row.
        if (!lookup.ok) return "error";
        const reply = lookup.reply;
        if (!reply || reply.aborted || (reply.status !== "sent" && reply.status !== "delivered")) {
          return "not_sent";
        }
      }
      const { data: prior, error: priorError } = await supabase
        .from("ai_reply_dead_letters")
        .select("id")
        .eq("inbound_message_id", args.inboundMessageId)
        .eq("reason", "sent_late")
        .limit(1);
      if (priorError) throw new Error(priorError.message);
      markerExisted = (prior ?? []).length > 0;
    }
    if (!markerExisted) {
      const written = await writeReplyDeadLetter(supabase, args.runContext, {
        orgId: args.orgId,
        conversationId: args.conversationId,
        propertyId: args.propertyId,
        inboundMessageId: args.inboundMessageId,
        body: args.body,
        reason: "sent_late",
      });
      if (!written) return "error";
    }
    const { data: converted, error } = await supabase
      .from("properties")
      .update({
        last_ai_escalation_reason: "send_timeout_then_sent",
        updated_at: new Date().toISOString(),
      })
      .eq("id", args.propertyId)
      .in("last_ai_escalation_reason", sendTimeoutFlagReasons(args.inboundMessageId))
      .select("id")
      .maybeSingle();
    if (error) {
      reportError(new Error(error.message), {
        tags: { surface: "ai_responder_late_send_flag_reason" },
        extra: { propertyId: args.propertyId },
      });
      return "error";
    }
    // A zero-row flag update is NOT success: the timeout writer may not have
    // written its flag yet. Resolve only when the flag is provably gone (read
    // succeeded and it is not still THIS inbound's timeout flag); otherwise
    // leave the row unresolved so a later sweep converts the flag.
    let resolutionReason: string | null = null;
    if (!converted) {
      const { data: current, error: readError } = await supabase
        .from("properties")
        .select("last_ai_escalation_reason")
        .eq("id", args.propertyId)
        .maybeSingle();
      if (readError) {
        reportError(new Error(readError.message), {
          tags: { surface: "ai_responder_late_send_flag_read" },
          extra: { propertyId: args.propertyId },
        });
        return "error";
      }
      const currentReason = (current as { last_ai_escalation_reason?: string | null } | null)
        ?.last_ai_escalation_reason ?? null;
      if (currentReason !== null && sendTimeoutFlagReasons(args.inboundMessageId).includes(currentReason)) {
        return "error";
      }
      if (currentReason !== "send_timeout_then_sent") resolutionReason = "flag_replaced";
    }
    // Works with NO dead-letter row (insert failed / process died): the marker
    // above is written regardless and the stamp below simply matches nothing.
    // Durable resolution, stamped LAST: the original send_timeout row(s) stay
    // unresolved until the flag conversion above has succeeded, so the sweeper
    // (which reads only unresolved rows) re-drives a failed flag update.
    // Idempotent (only unresolved rows match).
    if (args.inboundMessageId) {
      const { error: resolveError } = await supabase
        .from("ai_reply_dead_letters")
        .update({
          resolved_at: new Date().toISOString(),
          ...(resolutionReason ? { resolution_reason: resolutionReason } : {}),
        })
        .eq("inbound_message_id", args.inboundMessageId)
        .eq("reason", "send_timeout")
        .is("resolved_at", null);
      if (resolveError) {
        reportError(new Error(resolveError.message), {
          tags: { surface: "ai_responder_late_send_resolve" },
          extra: { propertyId: args.propertyId },
        });
        return "error";
      }
    }
    return markerExisted && !converted ? "already_reconciled" : "reconciled";
  } catch (e) {
    reportError(e, {
      tags: { surface: "ai_responder_late_send_reconcile" },
      extra: { propertyId: args.propertyId },
    });
    return "error";
  }
}

/**
 * Durable recovery for `reconcileLateSend`: finish every `send_timeout` whose
 * text did reach the provider but whose in-process reconciliation never ran
 * (the invocation froze or died). Call from the stale-run cron.
 *
 * The main candidate source is the unresolved `send_timeout` dead-letter rows
 * (`resolved_at is null`, served by a partial index, oldest first, keyset
 * paginated, never offset): `reconcileLateSendForInbound` stamps `resolved_at`
 * only AFTER the flag conversion succeeds, so a stuck flag normally has an
 * unresolved row. The one gap (process death between the flag write and the row
 * insert) is closed by `repairOrphanedTimeouts`, a small bounded properties scan
 * that creates the missing row first.
 *
 * Rows that can never be reconciled are stamped resolved (with
 * `resolution_reason`) on first sight so they are not re-read every run and
 * cannot starve newer rows:
 *   - `unreconcilable:missing_ids`  the row lacks inbound/org/property ids;
 *   - `unreconcilable:reply_failed` the AI reply for that inbound is terminally
 *     `failed` (not an aborted-before-provider row), so it cannot be accepted;
 *   - `unreconcilable:reply_unknown` the reply failed with an ambiguous
 *     provider outcome (`provider_unknown`); re-checked each sweep, stamped only
 *     after the 7-day window;
 *   - `unreconcilable:no_reply`     older than the 7-day window and BOTH reads
 *     positively found no accepted reply (none, pending, or aborted). A lookup
 *     error is never terminal: the row is skipped and retried;
 *   - `flag_replaced`               the property flag was cleared/replaced by
 *     someone else (not an error; the marker is still written).
 * Reconciled rows are stamped with a null reason.
 *
 * Pass A reach per run is pageSize x maxPages (1,000 rows by default); because
 * blockers resolve on first sight, repeated runs always reach newer rows.
 *
 * `cursor`/`nextCursor` remain as an optional continuation for a caller that
 * wants to resume a bounded run, but correctness no longer depends on one.
 */
export type LateSendSweepCursor = {
  a: { createdAt: string; id: string } | null;
};

const ORPHAN_PAGE_SIZE = 200;
const ORPHAN_MAX_PAGES = 5;
const ORPHAN_MIN_AGE_MS = 5 * 60 * 1000;
export const ORPHAN_PLACEHOLDER_BODY = "[reply text unavailable — orphaned timeout]";

/**
 * One page of the orphan scan: flagged properties whose escalation reason is a
 * timeout flag, stamped inside the window, within one id slice (keyset by id).
 * Exported so the integration test can run the exact filters against PostgREST.
 */
export function orphanPropertiesQuery(
  supabase: SupabaseClient<Database>,
  args: { windowIso: string; lower: string; upper: string | null; after: string | null },
) {
  let query = supabase
    .from("properties")
    .select("id, org_id, last_ai_escalation_reason, last_ai_escalation_at")
    .eq("needs_human_attention", true)
    .or(
      "and(last_ai_escalation_reason.like.send_timeout:%,last_ai_escalation_reason.not.like.%:backed),and(last_ai_escalation_reason.like.dead_letter_failed:send_timeout:%,last_ai_escalation_reason.not.like.%:backed)",
    )
    .gte("last_ai_escalation_at", args.windowIso);
  query = args.after ? query.gt("id", args.after) : query.gte("id", args.lower);
  if (args.upper) query = query.lt("id", args.upper);
  return query.order("id", { ascending: true }).limit(ORPHAN_PAGE_SIZE);
}

const ORPHAN_SLICE_COUNT = 16;
// Coupled to the 10-minute cron schedule in vercel.json (one slice per run);
// change the schedule and this together.
const ORPHAN_SLICE_MS = 10 * 60 * 1000;
/** Max uuids per bulk `.in('inbound_message_id', ...)` (about 4KB of URL). */
const ORPHAN_IN_CHUNK = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bounds of one of 16 uuid id-space slices (first hex char); `upper` is exclusive, null for the last. */
export function orphanSliceBounds(slice: number): { lower: string; upper: string | null } {
  const tail = "0000000-0000-0000-0000-000000000000";
  return {
    lower: `${slice.toString(16)}${tail}`,
    upper: slice >= ORPHAN_SLICE_COUNT - 1 ? null : `${(slice + 1).toString(16)}${tail}`,
  };
}

/**
 * Mark a timeout flag `:backed` (its recovery row exists) so the orphan query
 * excludes it. Conditional on the exact current value (zero rows = replaced).
 */
async function backOrphanFlag(
  supabase: SupabaseClient<Database>,
  prop: { id: string; last_ai_escalation_reason: string | null },
): Promise<boolean> {
  const currentReason = prop.last_ai_escalation_reason;
  if (!currentReason || currentReason.endsWith(SEND_TIMEOUT_BACKED_SUFFIX)) return true;
  const { error } = await supabase
    .from("properties")
    .update({
      last_ai_escalation_reason: `${currentReason}${SEND_TIMEOUT_BACKED_SUFFIX}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", prop.id)
    .eq("last_ai_escalation_reason", currentReason);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_orphan_timeout_backed_flag" },
      extra: { propertyId: prop.id },
    });
    return false;
  }
  return true;
}

/** Reason an unreadable timeout flag is rewritten to so it leaves the orphan candidate set. */
const SEND_TIMEOUT_UNPARSEABLE_REASON = "send_timeout_unparseable";

/**
 * Rewrite a timeout flag whose inbound id is not a uuid to
 * `send_timeout_unparseable` (no longer matches the scan's `send_timeout:%`
 * filters; attention flag untouched). Conditional on the exact current value.
 */
async function retireMalformedOrphanFlag(
  supabase: SupabaseClient<Database>,
  prop: { id: string; last_ai_escalation_reason: string | null },
): Promise<boolean> {
  const { error } = await supabase
    .from("properties")
    .update({
      last_ai_escalation_reason: SEND_TIMEOUT_UNPARSEABLE_REASON,
      updated_at: new Date().toISOString(),
    })
    .eq("id", prop.id)
    .eq("last_ai_escalation_reason", prop.last_ai_escalation_reason as string);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_orphan_timeout_malformed_rewrite" },
      extra: { propertyId: prop.id },
    });
    return false;
  }
  return true;
}

/**
 * Third, bounded source: a property flagged `send_timeout:<id>` /
 * `dead_letter_failed:send_timeout:<id>` with NO dead-letter row for that inbound
 * (the process died between the flag write and the row insert, or the insert
 * failed and the after() callback also died). Inserts a synthetic `send_timeout`
 * row (body = placeholder: the text is lost in this double failure) so the normal
 * pass handles it from then on. Properties that already have a row are untouched.
 *
 * Stateless rotation: flags that already have a recovery row (or that terminally
 * failed) stay flagged, so a scan that always restarted at the lowest id could be
 * consumed by them forever. Instead the uuid id-space is cut into 16 slices by
 * the first hex character and each run scans only slice
 * `floor(now / 10min) mod 16`, so every slice is covered every 160 minutes (well
 * inside the 7-day window). Within a slice: keyset by id, 200 per page, at most
 * 5 pages (1,000 properties) and 200 inserted rows per run. The cap only matters
 * if more than 1,000 flagged timeouts share one hex prefix (more than ~16,000
 * flagged timeouts in total); beyond that bound a high-id orphan in that slice
 * can still be starved.
 *
 * Eligibility is decided server-side: flags already backed by a dead-letter row
 * (`send_timeout:<id>:backed`, written by the timeout path once its insert
 * succeeds) are excluded from the query, so only genuine orphans (the
 * process-death case and the `dead_letter_failed:` double failure) are ever
 * fetched. The per-slice 1,000 cap therefore matters only with more than 1,000
 * genuine orphans in one slice; the 16-slice rotation is cheap insurance, not
 * load-bearing.
 *
 * Per page, one `.in('inbound_message_id', ids)` query finds the existing rows.
 * Flags with no `last_ai_escalation_at` (legacy) are not eligible (no fallback to
 * `updated_at`); flags younger than 5 minutes are skipped (the live timeout path
 * may still be writing its own row); flags older than 7 days are out of window.
 * A flag whose inbound id is not a uuid (or is empty) is rewritten, conditional
 * on its exact current value, to `send_timeout_unparseable`, which leaves the
 * candidate set so it cannot consume visits forever; it is counted as
 * `malformed`, never an error.
 *
 * Convergence is conditional on the promotion write succeeding: a flag whose
 * row exists but whose `:backed` promotion fails stays eligible and is retried
 * on the next visit (failures are counted in `backingFailed` and reported once
 * per run with the property ids). Persistent write failures therefore keep
 * those flags consuming scan budget until the write works.
 */
async function repairOrphanedTimeouts(
  supabase: SupabaseClient<Database>,
  windowStartMs: number,
  scanClockMs: number,
): Promise<{ malformed: number; backingFailed: string[] }> {
  const windowIso = new Date(windowStartMs).toISOString();
  const slice = Math.floor(scanClockMs / ORPHAN_SLICE_MS) % ORPHAN_SLICE_COUNT;
  const { lower, upper } = orphanSliceBounds(slice);
  let after: string | null = null;
  let inserted = 0;
  let malformed = 0;
  const backingFailed: string[] = [];
  for (let page = 0; page < ORPHAN_MAX_PAGES && inserted < ORPHAN_PAGE_SIZE; page += 1) {
    const query = orphanPropertiesQuery(supabase, { windowIso, lower, upper, after });
    const { data, error } = await query;
    if (error) {
      reportError(new Error(error.message), { tags: { surface: "ai_responder_orphan_timeout_scan" } });
      return { malformed, backingFailed };
    }
    const props = (data ?? []) as Array<{
      id: string;
      org_id: string | null;
      last_ai_escalation_reason: string | null;
      last_ai_escalation_at: string | null;
    }>;
    const candidates: Array<{ prop: (typeof props)[number]; inboundId: string; stampedAt: string }> = [];
    for (const prop of props) {
      const inboundId = inboundIdFromTimeoutFlag(prop.last_ai_escalation_reason);
      if (!inboundId || !UUID_RE.test(inboundId)) {
        if (await retireMalformedOrphanFlag(supabase, prop)) malformed += 1;
        continue;
      }
      if (!prop.org_id) continue;
      const stampedAt = prop.last_ai_escalation_at;
      if (!stampedAt) continue;
      const stampedMs = new Date(stampedAt).getTime();
      if (!Number.isFinite(stampedMs) || Date.now() - stampedMs < ORPHAN_MIN_AGE_MS) continue;
      candidates.push({ prop, inboundId, stampedAt });
    }
    const existing = new Set<string>();
    if (candidates.length > 0) {
      const ids = candidates.map((c) => c.inboundId);
      for (let i = 0; i < ids.length; i += ORPHAN_IN_CHUNK) {
        const { data: rows, error: existingError } = await supabase
          .from("ai_reply_dead_letters")
          .select("inbound_message_id")
          .in("inbound_message_id", ids.slice(i, i + ORPHAN_IN_CHUNK))
          .eq("reason", "send_timeout");
        if (existingError) {
          reportError(new Error(existingError.message), { tags: { surface: "ai_responder_orphan_timeout_repair" } });
          return { malformed, backingFailed };
        }
        for (const r of (rows ?? []) as Array<{ inbound_message_id: string | null }>) {
          if (r.inbound_message_id) existing.add(r.inbound_message_id);
        }
      }
    }
    for (const { prop, inboundId, stampedAt } of candidates) {
      if (inserted >= ORPHAN_PAGE_SIZE) break;
      if (existing.has(inboundId)) {
        // Row exists but the flag is unmarked (a failed/interrupted backing
        // write): promote it so later visits skip it.
        if (!(await backOrphanFlag(supabase, prop))) backingFailed.push(prop.id);
        continue;
      }
      try {
        const { data: inbound, error: inboundError } = await supabase
          .from("messages")
          .select("conversation_id")
          .eq("id", inboundId)
          .maybeSingle();
        if (inboundError) throw new Error(inboundError.message);
        const { error: insertError } = await supabase.from("ai_reply_dead_letters").insert({
          org_id: prop.org_id as string,
          conversation_id: (inbound as { conversation_id?: string | null } | null)?.conversation_id ?? null,
          property_id: prop.id,
          inbound_message_id: inboundId,
          body: ORPHAN_PLACEHOLDER_BODY,
          reason: "send_timeout",
          created_at: stampedAt,
        });
        if (insertError) throw new Error(insertError.message);
        inserted += 1;
        if (!(await backOrphanFlag(supabase, prop))) backingFailed.push(prop.id);
      } catch (e) {
        reportError(e, {
          tags: { surface: "ai_responder_orphan_timeout_repair" },
          extra: { propertyId: prop.id },
        });
      }
    }
    const last = props[props.length - 1];
    if (props.length < ORPHAN_PAGE_SIZE || !last) return { malformed, backingFailed };
    after = last.id;
  }
  return { malformed, backingFailed };
}

export async function sweepLateSends(
  supabase: SupabaseClient<Database>,
  options: {
    sinceMs?: number;
    pageSize?: number;
    maxPages?: number;
    cursor?: LateSendSweepCursor;
    /** Clock used only to pick the orphan-scan slice (tests); defaults to Date.now(). */
    orphanScanNowMs?: number;
  } = {},
): Promise<{
  scanned: number;
  reconciled: number;
  nextCursor: LateSendSweepCursor | null;
  orphanMalformed: number;
  orphanBackingFailed: number;
  suppressionRetried: { attempted: number; succeeded: number; failed: number; holdsCleared: number };
}> {
  const windowStartMs = Date.now() - (options.sinceMs ?? 7 * 24 * 60 * 60 * 1000);
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 10;
  let scanned = 0;
  let reconciled = 0;
  let cursorA = options.cursor?.a ?? null;
  let exhaustedA = false;
  let orphanMalformed = 0;
  let orphanBackingFailed = 0;
  let suppressionRetried = { attempted: 0, succeeded: 0, failed: 0, holdsCleared: 0 };
  const done = () => ({
    scanned,
    reconciled,
    orphanMalformed,
    orphanBackingFailed,
    suppressionRetried,
    nextCursor: exhaustedA ? null : { a: cursorA },
  });
  const resolveUnreconcilable = async (id: string, reason: string): Promise<boolean> => {
    const { error } = await supabase
      .from("ai_reply_dead_letters")
      .update({ resolved_at: new Date().toISOString(), resolution_reason: reason })
      .eq("id", id)
      .is("resolved_at", null);
    if (error) {
      reportError(new Error(error.message), { tags: { surface: "ai_responder_late_send_sweep" } });
      return false;
    }
    return true;
  };

  // Orphan repair runs FIRST so a repaired row is handled by pass A this run.
  const orphanResult = await repairOrphanedTimeouts(
    supabase,
    windowStartMs,
    options.orphanScanNowMs ?? Date.now(),
  );
  orphanMalformed = orphanResult.malformed;
  orphanBackingFailed = orphanResult.backingFailed.length;
  if (orphanBackingFailed > 0) {
    reportError(new Error(`orphan timeout scan could not promote ${orphanBackingFailed} flag(s) to :backed`), {
      tags: { surface: "ai_responder_orphan_timeout_backing_failed" },
      extra: { orphanBackingFailed, propertyIds: orphanResult.backingFailed.slice(0, 50) },
    });
  }
  if (orphanMalformed > 0) {
    reportError(new Error(`orphan timeout scan retired ${orphanMalformed} flag(s) with a malformed inbound id`), {
      tags: { surface: "ai_responder_orphan_timeout_malformed" },
      extra: { orphanMalformed },
    });
  }

  // Durable phone-suppression obligations recorded by the confirm RPC (or a
  // failed first attempt): retry the ones older than 2 minutes. Bounded, and
  // idempotent with a concurrent human Retry. Never throws.
  suppressionRetried = await retryOutstandingSuppressionObligations(supabase as never, {
    olderThanSeconds: 120,
    limit: 25,
  });

  for (let page = 0; page < maxPages; page += 1) {
    let query = supabase
      .from("ai_reply_dead_letters")
      .select("id, created_at, org_id, conversation_id, property_id, inbound_message_id, body")
      .eq("reason", "send_timeout")
      .is("resolved_at", null);
    if (cursorA) {
      query = query.or(
        `created_at.gt.${cursorA.createdAt},and(created_at.eq.${cursorA.createdAt},id.gt.${cursorA.id})`,
      );
    }
    const { data, error } = await query
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(pageSize);
    if (error) {
      reportError(new Error(error.message), { tags: { surface: "ai_responder_late_send_sweep" } });
      return done();
    }
    const all = data ?? [];
    for (const row of all) {
      scanned += 1;
      if (!row.inbound_message_id || !row.org_id || !row.property_id) {
        await resolveUnreconcilable(row.id as string, "unreconcilable:missing_ids");
        continue;
      }
      const result = await reconcileLateSendForInbound(supabase, {
        orgId: row.org_id as string,
        conversationId: row.conversation_id,
        propertyId: row.property_id as string,
        inboundMessageId: row.inbound_message_id,
        body: row.body,
      });
      if (result === "reconciled") reconciled += 1;
      // "error" (including a failed reply lookup) is never terminal: skip this
      // row for this run; it stays unresolved and is retried next sweep.
      if (result !== "not_sent") continue;
      const second = await lookupAiReplyForInbound(supabase, row.inbound_message_id);
      if (!second.ok) continue;
      const reply = second.reply;
      if (reply && !reply.aborted && (reply.status === "sent" || reply.status === "delivered")) {
        // Accepted between the two reads: reconcile (marker + flag), never no_reply.
        const again = await reconcileLateSendForInbound(supabase, {
          orgId: row.org_id as string,
          conversationId: row.conversation_id,
          propertyId: row.property_id as string,
          inboundMessageId: row.inbound_message_id,
          body: row.body,
        });
        if (again === "reconciled") reconciled += 1;
        continue;
      }
      const aged = new Date(row.created_at as string).getTime() < windowStartMs;
      if (reply && !reply.aborted && reply.status === "failed") {
        if (reply.providerUnknown) {
          // Ambiguous provider error: the text may have gone out and a status
          // webhook can still flip the row. Keep re-checking until the window ends.
          if (aged) await resolveUnreconcilable(row.id as string, "unreconcilable:reply_unknown");
        } else {
          await resolveUnreconcilable(row.id as string, "unreconcilable:reply_failed");
        }
      } else if (aged) {
        await resolveUnreconcilable(row.id as string, "unreconcilable:no_reply");
      }
    }
    // Advance past EVERY row read (resolved or not) so the next page never re-reads it.
    const last = all[all.length - 1];
    if (last?.created_at) cursorA = { createdAt: last.created_at as string, id: last.id as string };
    if (all.length < pageSize) {
      exhaustedA = true;
      break;
    }
  }
  return done();
}

async function leasedSend(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
  attempt: SendAttempt,
): Promise<ResponderSendOutcome> {
  const guard: Guard = () => assertLive(attempt);
  const conversationKey = await resolveReservationKey(supabase, args.input);
  assertLive(attempt);
  if (!conversationKey) return failClosed(supabase, args, "send_check_failed", undefined, guard);
  attempt.conversationKey = conversationKey;
  const reservation = await reserveSend(
    supabase,
    conversationKey,
    args.input.inboundMessageId ?? null,
    attempt,
  );
  if (attempt.abandoned) {
    // The reservation landed after the attempt was abandoned: free it now so
    // it does not hold the conversation for a full lease.
    if (attempt.reserved) await releaseSend(supabase, conversationKey, attempt.holder);
    throw new AttemptAbandoned();
  }
  if (reservation === "error") return failClosed(supabase, args, "send_check_failed", undefined, guard);
  if (reservation === "elsewhere") {
    // Another sender held the lease for the whole wait budget. Nothing was
    // sent, so this must not end silently: retry later, flag after the last.
    guard();
    await trace(supabase, {
      kind: "gate",
      name: "send_reserved_elsewhere",
      result: "block",
      detail: { attempt: args.input.retryAttempt ?? 0 },
    }, args.runContext);
    return retryOrFailReply(supabase, args, "send_reserved_elsewhere", guard);
  }

  // Re-validate UNDER the reservation (the Q8 table, final): READ everything,
  // then re-check the attempt is still live, only then apply (flag / trace).
  const evaluation = await evaluateSendGate(supabase, args.input, {
    ...((args as { routingV2OutboxId?: string }).routingV2OutboxId ? { mechanicsYield: "outbox" as const } : {}),
    phase: "presend",
    claimStartedAt: args.claimStartedAt,
    checkNewerInbound: !!args.input.inboundMessageId,
    humanActor: args.source === "human",
  });
  assertLive(attempt);
  const stale = await applyGateEvaluation(supabase, args, evaluation, guard);
  if (stale) return stale;

  // Re-read the policy immediately before the provider call.
  const liveMode = await loadLiveOutboundMode(supabase, args.orgId, args.outboundMode);
  assertLive(attempt);
  const livePolicy = resolveOutboundPolicy({ source: args.source, dbMode: liveMode, approvedFixedText: isApprovedFixedText(args) });
  if (livePolicy.hold) {
    return await holdReplyAsDraft(supabase, args, livePolicy.reason, guard);
  }

  return deliverResponderMessage(supabase, args, attempt);
}

/** Is the template still approved for exactly the text about to be sent? Fails closed. */
async function templateStillApproved(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
): Promise<boolean> {
  if (!args.templateId) return false;
  try {
    const { data, error } = await supabase
      .from("sms_templates")
      .select("content, approved_for_auto_send, approved_content, deleted_at")
      .eq("id", args.templateId)
      .maybeSingle();
    if (error || !data) return false;
    return (
      data.deleted_at == null &&
      data.approved_for_auto_send === true &&
      data.approved_content !== null &&
      data.approved_content === data.content &&
      data.approved_content === (args.templateSource ?? args.body)
    );
  } catch {
    return false;
  }
}

async function deliverResponderMessage(
  supabase: SupabaseClient<Database>,
  args: ResponderSendArgs,
  attempt: SendAttempt,
): Promise<ResponderSendOutcome> {
  const guard: Guard = () => assertLive(attempt);
  let inboundToPhone = args.input.inboundToPhone ?? null;
  if (!inboundToPhone && args.input.inboundMessageId) {
    try {
      inboundToPhone = await loadInboundBusinessNumber(
        supabase,
        args.input.inboundMessageId,
      );
    } catch (e) {
      const reason = "send_blocked:db_error";
      reportError(e, {
        tags: { surface: "ai_responder_inbound_sender_lookup" },
        extra: {
          propertyId: args.input.propertyId,
          inboundMessageId: args.input.inboundMessageId,
        },
      });
      await flagAndDeadLetterFor(supabase, args, reason, { guard });
      return { outcome: "escalated", reason };
    }
    assertLive(attempt);
  }
  let hookFired = false;
  // The provider boundary is fenced inside sendSmsToContact: after every one
  // of ITS preflight awaits, `beforeProviderSubmit` re-validates the lease (and
  // the attempt deadline) and refuses the submission if either is gone.
  const sendResult = await sendSmsToContact(supabase, {
    origin: "automated",
    contactId: args.input.contactId,
    propertyId: args.input.propertyId,
    body: args.body,
    from: inboundToPhone ?? undefined,
    to: args.input.inboundFromPhone ?? undefined,
    requireStickyFrom: true,
    // Routing v2: the provider submission is keyed by the outbox id, so a replay of the same
    // intent returns the durable original and never reaches the provider twice.
    ...(args.routingV2OutboxId || args.providerIdempotencyKey
      ? { idempotencyKey: args.providerIdempotencyKey ?? args.routingV2OutboxId }
      : {}),
    ...(args.testRunId ? { testRunId: args.testRunId } : {}),
    beforeProviderSubmit: (ctx) => fenceProviderSubmit(supabase, attempt, args, ctx),
    // Fired inside the send, right after the provider accepts and before its
    // receipt persistence / reconciliation.
    ...(args.onProviderAccepted
      ? {
          onProviderAccepted: async ({ messageId }: { messageId: string }) => {
            hookFired = true;
            await args.onProviderAccepted!(messageId);
          },
        }
      : {}),
    metadata: args.input.inboundMessageId
      ? ({
          generated_by: "ai_responder_v1",
          inbound_message_id: args.input.inboundMessageId,
        } as Json)
      : null,
  });

  if (sendResult.status === "blocked_before_provider") {
    if (sendResult.refusal === TEST_SEND_REFUSED) {
      // §5.4: a test-tagged reply to a number the business does not own. Terminal on every
      // path: never retried (one message row, one refusal row), never dead-lettered or flagged.
      guard();
      await trace(supabase, { kind: "gate", name: TEST_SEND_REFUSED, result: "block" }, args.runContext);
      return { outcome: "skipped", reason: TEST_SEND_REFUSED };
    }
    if (sendResult.retired === false) {
      // The refused row could not be retired: it still carries the stamp that
      // owns this inbound, so a retry would collide with it. Never retry over
      // it; dead-letter + flag a human.
      guard();
      await trace(supabase, { kind: "gate", name: "send_abort_unconfirmed", result: "error" }, args.runContext);
      const reason = "send_blocked:abort_unconfirmed";
      await flagAndDeadLetterFor(supabase, args, reason, { guard });
      return { outcome: "escalated", reason };
    }
    if (
      attempt.fenceRefusal === "revalidate" &&
      (attempt.fenceReason === FENCE_TEMPLATE_APPROVAL_CHANGED ||
        attempt.fenceReason === FENCE_QUIET_HOURS_RECIPIENT ||
        attempt.fenceReason === FENCE_NINE_CONTEXT_CHANGED ||
        attempt.fenceReason === FENCE_PROPERTY_WINDOW)
    ) {
      // The template must not go out now. Nothing was sent; drop it silently
      // (the outcome still applies, same as the earlier pre-send drops).
      guard();
      await trace(supabase, {
        kind: "gate",
        name: "provider_fence_refused",
        result: "block",
        detail: { reason: attempt.fenceReason },
      }, args.runContext);
      if (
        args.windowDeferrable &&
        (attempt.fenceReason === FENCE_QUIET_HOURS_RECIPIENT || attempt.fenceReason === FENCE_PROPERTY_WINDOW) &&
        attempt.fenceWindowWhy === "outside_window"
      ) {
        // At the fence this attempt's pending row already exists (and moved the revision once).
        return { outcome: "skipped", reason: NINE_WINDOW_CLOSED_AT_FENCE };
      }
      return {
        outcome: "skipped",
        reason:
          attempt.fenceReason === FENCE_TEMPLATE_APPROVAL_CHANGED
            ? TEMPLATE_APPROVAL_CHANGED
            : attempt.fenceReason === FENCE_NINE_CONTEXT_CHANGED
              ? NINE_DEFERRED_CONTEXT_CHANGED
              : TEMPLATE_QUIET_HOURS_RECIPIENT,
      };
    }
    if (attempt.fenceRefusal === "error") {
      return failClosed(supabase, args, "send_check_failed", undefined, guard);
    }
    if (attempt.fenceRefusal === "abandoned") throw new AttemptAbandoned();
    if (attempt.fenceRefusal === "revalidate") {
      // The world changed after the earlier checks: nothing was submitted.
      // Re-decide under the lease we still hold (silent skip / flag / hold as a
      // draft), exactly as the pre-send check would have.
      guard();
      await trace(supabase, {
        kind: "gate",
        name: "provider_fence_refused",
        result: "block",
        detail: { reason: attempt.fenceReason ?? "fence:gate:error" },
      }, args.runContext);
      const evaluation = await evaluateSendGate(supabase, args.input, {
        ...((args as { routingV2OutboxId?: string }).routingV2OutboxId ? { mechanicsYield: "outbox" as const } : {}),
        phase: "presend",
        claimStartedAt: args.claimStartedAt,
        checkNewerInbound: !!args.input.inboundMessageId,
        humanActor: args.source === "human",
      });
      guard();
      const stale = await applyGateEvaluation(supabase, args, evaluation, guard);
      if (stale) return stale;
      const liveMode = await loadLiveOutboundMode(supabase, args.orgId, args.outboundMode);
      guard();
      const livePolicy = resolveOutboundPolicy({ source: args.source, dbMode: liveMode, approvedFixedText: isApprovedFixedText(args) });
      if (livePolicy.hold) return holdReplyAsDraft(supabase, args, livePolicy.reason, guard);
      return retryOrFailReply(supabase, args, "send_lease_lost", guard);
    }
    guard();
    await trace(supabase, { kind: "gate", name: "send_lease_lost", result: "block" }, args.runContext);
    return retryOrFailReply(supabase, args, "send_lease_lost", guard);
  }

  if (
    args.input.inboundMessageId &&
    sendResult.status === "db_error" &&
    isAiReplyDuplicateInsertError(sendResult.error)
  ) {
    guard();
    const existingReply = await findExistingAiReplyForInbound(
      supabase,
      args.input.inboundMessageId,
    );
    guard();
    const existingStatus = existingReply?.status;
    if (existingStatus === "sent" || existingStatus === "delivered") {
      // Only a row the provider accepted counts as an answered seller.
      await trace(supabase, {
        kind: "gate",
        name: "already_replied",
        result: "block",
      }, args.runContext);
      return silentSkip("already_replied", 2);
    }
    if (existingStatus === "pending" || existingStatus === "queued") {
      // Another attempt's row for this inbound is still in flight (or was
      // abandoned and has not aborted yet). It is not a delivered reply (Q8
      // rule 4): try again shortly instead of ending the seller's thread silently.
      await trace(supabase, { kind: "gate", name: "send_row_in_flight", result: "block" }, args.runContext);
      return retryOrFailReply(supabase, args, "send_reserved_elsewhere", guard);
    }
    if (existingReply && existingStatus === "failed" && !existingReply.aborted) {
      // A previous attempt's row failed AFTER the provider boundary and still
      // owns this inbound's stamp: the seller was not answered and a resend
      // would collide with it. Flag, never "already replied".
      const reason = "send_blocked:prior_attempt_failed";
      await flagAndDeadLetterFor(supabase, args, reason, { guard });
      return { outcome: "escalated", reason };
    }
    if (existingReply && existingStatus !== "failed") {
      // Any other status is a blocked send (rule 7), never an answered seller.
      const reason = `send_blocked:${existingStatus}`;
      await flagAndDeadLetterFor(supabase, args, reason, { guard });
      return { outcome: "escalated", reason };
    }
    // No row, or a failed row retired before the provider: the duplicate is
    // unexplained; fall through to the generic blocked-send handling (rule 7).
  }

  if (
    sendResult.status === "blocked_terminal_dispo" ||
    sendResult.status === "blocked_automated_suppressed"
  ) {
    guard();
    await trace(supabase, {
      kind: "gate",
      name: "send_suppressed",
      result: "block",
      detail: { status: sendResult.status },
    }, args.runContext);
    return silentSkip("already_terminal", 0);
  }

  if (sendResult.status === "blocked_fresh_state_unavailable") {
    // A consent / suppression lookup inside the send could not be read (Q8
    // rule 7): fail closed as `send_check_failed`, never a generic block.
    return failClosed(supabase, args, "send_check_failed", undefined, guard);
  }

  if (sendResult.status === "blocked_quiet_hours" && args.routingV2OutboxId && !sendResult.check.ok && sendResult.check.reason === "unknown_state") {
    // B-1: the property's state cannot be read, so there is no window to wait for. Not a
    // quiet-hours close and never a routine no-op: a person looks (the outbox holds).
    guard();
    await trace(supabase, { kind: "gate", name: "quiet_hours", result: "block", detail: { window: "unknown_state" } }, args.runContext);
    return { outcome: "skipped", reason: NINE_WINDOW_UNKNOWN_STATE };
  }
  if (sendResult.status === "blocked_quiet_hours" && args.windowDeferrable) {
    // The property's own window (checked inside the send, before any row is written):
    // window-only, so a deferrable nine reply is deferred instead of flagged.
    guard();
    await trace(supabase, { kind: "gate", name: "quiet_hours", result: "block", detail: { deferrable: true } }, args.runContext);
    return { outcome: "skipped", reason: NINE_WINDOW_CLOSED };
  }
  if (sendResult.status !== "sent" && sendResult.status !== "queued") {
    const reason = `send_blocked:${sendResult.status}`;
    await flagAndDeadLetterFor(supabase, args, reason, { guard });
    return { outcome: "escalated", reason };
  }

  // ---- DELIVERY RECONCILIATION -------------------------------------------
  // Everything below records that the provider ACCEPTED this reply (the
  // message id, its AI metadata, the evidence step, the run link). It is
  // deliberately NOT guarded by the attempt deadline: a submission that
  // completed after the deadline still happened and must be recorded. It is
  // reachable only after a successful submission (status sent / queued, i.e.
  // the provider fence let it through); an attempt that did NOT submit can
  // never get here, and the assertion keeps it so.
  if (!attempt.providerStarted) guard();
  const messageId = sendResult.messageId;
  if (args.onProviderAccepted && !hookFired) await args.onProviderAccepted(messageId);
  const metadata: AiMessageMetadata = {
    generated_by: "ai_responder_v1",
    ...(args.input.inboundMessageId
      ? { inbound_message_id: args.input.inboundMessageId }
      : {}),
    model: args.model,
    confidence: args.confidence,
    sentiment: args.sentiment,
    turn: args.turn,
    ...(args.source === "approved_template"
      ? {
          reply_source: "approved_template" as const,
          template_id: args.templateId ?? null,
          ...(args.replyKey ? { reply_key: args.replyKey } : {}),
        }
      : {}),
  };
  const { data: messageRow, error: messageLookupError } = await supabase
    .from("messages")
    .select("metadata")
    .eq("id", messageId)
    .maybeSingle();
  if (messageLookupError) {
    reportError(new Error(messageLookupError.message), {
      tags: { surface: "ai_responder_message_metadata_lookup" },
      extra: {
        messageId,
        inboundMessageId: args.input.inboundMessageId ?? null,
      },
    });
  }
  await supabase
    .from("messages")
    .update({
      metadata: {
        ...readJsonObject(messageRow?.metadata ?? null),
        ...metadata,
        ...(args.approvedBy
          ? {
              approved_by_user_id: args.approvedBy.userId,
              edited_by_human: args.approvedBy.edited,
            }
          : {}),
      } as Json,
    })
    .eq("id", messageId);

  await trace(supabase, {
    kind: "reply",
    name: "ai_reply",
    result: "sent",
    detail: {
      outboundMessageId: messageId,
      actor: args.approvedBy ? "human_approved" : "ai",
      confidence: args.confidence,
      persona: getOutboundSenderName(),
    },
  }, args.runContext);
  await updateRun(supabase, args.runContext, {
    outboundMessageId: messageId,
  });
  return { outcome: "sent", messageId, confidence: args.confidence };
}

/** Build the send arguments for an already-generated (carried) reply. */
function replySendArgs(a: {
  input: AiDispatchInput;
  orgId: string;
  model: string;
  turn: number;
  claimStartedAt: string | null;
  outboundMode?: string | null;
  runContext?: MaybeRunContext;
  reply: RetryReply;
}): ResponderSendArgs {
  return {
    input: a.input,
    body: a.reply.body,
    model: a.model,
    confidence: a.reply.confidence,
    sentiment: a.reply.sentiment,
    turn: a.turn,
    source: "llm",
    orgId: a.orgId,
    claimStartedAt: a.claimStartedAt,
    outboundMode: a.outboundMode,
    runContext: a.runContext,
    replyKind: a.reply.kind,
    ...(a.reply.closeReason ? { closeReason: a.reply.closeReason } : {}),
  };
}

/** Hold reasons for model judgments that wait for a human (registered in hold-alerts/holds.ts). */
export const HOLD_JEV_DNC_NEEDS_CONFIRM = "jev_dnc_needs_confirm";
export const HOLD_JEV_OPTED_OUT_NEEDS_CONFIRM = "jev_opted_out_needs_confirm";
export const HOLD_JEV_WRONG_NUMBER_ALL_NEEDS_CONFIRM = "jev_wrong_number_all_needs_confirm";
export const HOLD_MODEL_OPT_OUT_NEEDS_CONFIRM = "model_opt_out_needs_confirm";
export const HOLD_MODEL_DNC_NEEDS_CONFIRM = "model_dnc_needs_confirm";

async function setResponderDispo(
  supabase: SupabaseClient<Database>,
  args: {
    runContext?: MaybeRunContext;
    propertyId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    dispo: "wrong_number" | "not_interested" | "opted_out" | "dnc";
    reason: string;
    // Jev-eligible-auto-accept calls only (root review of 8361775a,
    // jev-root-revision-review.md, 2026-09-20): revision read before the
    // Jev HTTP call started. Legacy callers omit this.
    expectedRevision?: number;
    /** Jev auto-applies only: record prior state so a person can undo it. */
    undo?: { orgId: string; classificationRunId: string };
    /** wrong_number: written by the same RPC that creates the review. */
    wrongScope?: AiWrongScope;
  },
): Promise<ResponderDispoResult> {
  // HARD RULE (Jarrad 2026-10-07): fn_apply_ai_disposition_with_review flips
  // contacts.sms_opted_out immediately for opted_out/dnc, which is an
  // automated DNC decision. Model judgments reach those dispositions only via
  // the deferred review RPCs; refuse here so no caller can bypass that.
  if (args.dispo === "opted_out" || args.dispo === "dnc") {
    const reason = `ai_disposition_${args.dispo}_requires_human`;
    await markPropertyNeedsAttention(supabase, args.propertyId, reason, args.runContext);
    reportError(new Error(reason), {
      tags: { surface: "ai_responder_set_dispo" },
      extra: { propertyId: args.propertyId, dispo: args.dispo },
    });
    return { updated: false, reason: "db_error" };
  }
  if (!args.conversationId || !args.inboundMessageId) {
    const reason = "ai_disposition_missing_thread_identity";
    await markPropertyNeedsAttention(supabase, args.propertyId, reason, args.runContext);
    reportError(new Error(reason), {
      tags: { surface: "ai_responder_set_dispo" },
      extra: { propertyId: args.propertyId, dispo: args.dispo },
    });
    return { updated: false, reason: "db_error" };
  }

  let failureMessage = "AI disposition RPC failed";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { data, error } = await supabase.rpc(
      "fn_apply_ai_disposition_with_review",
      {
        p_property_id: args.propertyId,
        p_conversation_id: args.conversationId,
        p_source_inbound_message_id: args.inboundMessageId,
        p_disposition: args.dispo,
        p_ai_reason: args.reason,
        p_expected_revision: args.expectedRevision ?? null,
        ...(args.dispo === "wrong_number" && args.wrongScope
          ? { p_wrong_scope: args.wrongScope }
          : {}),
        // The undo record (prior state + what Jev applied) is written by the
        // RPC itself, in its transaction, under the property row lock.
        ...(args.undo ? { p_undo_classification_run_id: args.undo.classificationRunId } : {}),
      },
    );
    if (error) {
      if (error.message.includes("STALE_DECISION_CONTEXT")) {
        await markPropertyNeedsAttention(supabase, args.propertyId, "jev_stale_decision_context", args.runContext);
        return { updated: false, reason: "stale_context" };
      }
      failureMessage = error.message;
      continue;
    }

    const status = readAiDispositionRpcStatus(data);
    if (status === "already_terminal") {
      return { updated: false, reason: "already_terminal" };
    }
    if (status === "replayed") {
      const existingReview = await findExistingAiDispositionReview(
        supabase,
        args.inboundMessageId,
      );
      if (!existingReview.ok || !existingReview.disposition) {
        failureMessage = "AI disposition replay lookup failed";
        continue;
      }
      if (existingReview.disposition !== args.dispo) {
        return { updated: false, reason: "replayed_other_disposition" };
      }
    } else if (status !== "applied") {
      failureMessage = "unexpected AI disposition RPC response";
      continue;
    }

    let pausedEnrollmentIds: string[] = [];
    if (args.dispo === "wrong_number") {
      const pauseResult = await pausePropertyEnrollments(supabase, {
        propertyId: args.propertyId,
        reason: "inbound_reply",
        permanent: false,
        actor: { actorType: "ai" },
      });
      pausedEnrollmentIds = pauseResult?.enrollmentIds ?? [];
    }
    if (args.undo && status === "applied" && pausedEnrollmentIds.length > 0) {
      await recordPausedEnrollmentsForUndo(supabase, {
        inboundMessageId: args.inboundMessageId,
        pausedEnrollmentIds,
      });
    }
    return { updated: true };
  }

  await markPropertyNeedsAttention(
    supabase,
    args.propertyId,
    "disposition_write_failed",
    args.runContext,
  );
  reportError(new Error(failureMessage), {
    tags: { surface: "ai_responder_set_dispo" },
    extra: {
      propertyId: args.propertyId,
      dispo: args.dispo,
      reason: args.reason,
      attempts: 2,
    },
  });
  return { updated: false, reason: "db_error" };
}

/**
 * Best-effort: flips a just-created `pending` review row to
 * `auto_accepted`, linked to the Jev classification run that decided it.
 * Never called for `dnc` — the caller only sets `jevAutoAccept` when
 * `eligibleForAutoAccept` was true (dispatch-bridge.ts already excludes
 * `close_dnc`), and `fn_accept_ai_disposition_review` independently
 * rejects `dnc` as belt-and-suspenders.
 *
 * Deliberately swallows its own errors: a failed auto-accept leaves the
 * review `pending` for manual confirmation instead, which is a safe
 * fallback — the disposition effect itself already succeeded by the
 * time this runs, so failing loudly here would be a worse outcome than
 * just falling back to the human-review path.
 */
/**
 * Records a below-threshold/human-gated new_lead or nurture decision in
 * jev_lead_decisions (the Needs-a-decision queue for these two outcomes
 * — see 20261008140100_jev_lead_decisions.sql). Best-effort: the caller's
 * own markPropertyNeedsAttention already surfaces this on the property
 * regardless, so a failed insert here is logged, not escalated as a
 * bigger failure.
 */
async function proposeJevLeadDecision(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    conversationId: string | null | undefined;
    inboundMessageId: string | null | undefined;
    classificationRunId: string;
    outcome: "new_lead" | "nurture";
    nativeConfidence: number | null;
    thresholdAtDecision: number | null;
    thresholdVersion: number | null;
    expectedRevision: number;
  },
): Promise<void> {
  if (!args.conversationId || !args.inboundMessageId) return;
  const { error } = await supabase.rpc("fn_propose_jev_lead_decision", {
    p_property_id: args.propertyId,
    p_conversation_id: args.conversationId,
    p_source_inbound_message_id: args.inboundMessageId,
    p_classification_run_id: args.classificationRunId,
    p_outcome: args.outcome,
    p_native_confidence: args.nativeConfidence,
    p_threshold_at_decision: args.thresholdAtDecision,
    p_threshold_version: args.thresholdVersion,
    p_expected_revision: args.expectedRevision,
  });
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "jev_lead_decision_propose" },
      extra: { propertyId: args.propertyId, outcome: args.outcome },
    });
  }
}

/**
 * Root review of dbbb12e6 (jev-root-autoapply-review.md, finding 1, P1):
 * the effect (nurture's outreach_dispo write / new_lead's status write),
 * the decision_context_revision guard, and the jev_lead_decisions audit
 * insert now happen atomically inside `fn_auto_apply_jev_lead_decision`
 * itself — one RPC, one transaction. The prior design called
 * qualifyProperty/setOutreachDispoNurture (a separate write, which
 * itself bumped decision_context_revision) and THEN this RPC with the
 * PRE-write revision, so the RPC's own staleness check rejected every
 * normal successful apply. qualifyProperty/setOutreachDispoNurture are
 * unchanged and still used by every non-Jev-automatic-apply caller
 * (manual qualify, the legacy Haiku qualifier, deferred/below-threshold
 * Jev dispositions) — this call site alone no longer uses them.
 */
type JevAutoApplyResult =
  | { status: "applied" | "already_nurture" | "already_qualified" | "replayed"; decisionId: string }
  | { status: "already_terminal" | "dnc_locked" | "not_found" | "stale_decision_context" | "training_blocked" | "error" };

async function applyJevLeadDecisionAtomically(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    conversationId: string | null | undefined;
    inboundMessageId: string | null | undefined;
    classificationRunId: string;
    outcome: "new_lead" | "nurture";
    nativeConfidence: number | null;
    thresholdAtDecision: number | null;
    thresholdVersion: number | null;
    expectedRevision: number;
  },
): Promise<JevAutoApplyResult> {
  if (!args.conversationId || !args.inboundMessageId) return { status: "error" };
  const { data, error } = await supabase.rpc("fn_auto_apply_jev_lead_decision", {
    p_property_id: args.propertyId,
    p_conversation_id: args.conversationId,
    p_source_inbound_message_id: args.inboundMessageId,
    p_classification_run_id: args.classificationRunId,
    p_outcome: args.outcome,
    p_native_confidence: args.nativeConfidence,
    p_threshold_at_decision: args.thresholdAtDecision,
    p_threshold_version: args.thresholdVersion,
    p_expected_revision: args.expectedRevision,
  });
  if (error) {
    if (error.message.includes("STALE_DECISION_CONTEXT")) return { status: "stale_decision_context" };
    if (error.message.includes("training lead")) return { status: "training_blocked" };
    reportError(new Error(error.message), {
      tags: { surface: "jev_lead_decision_auto_apply" },
      extra: { propertyId: args.propertyId, outcome: args.outcome },
    });
    return { status: "error" };
  }
  const result = data as { status: string; decisionId?: string };
  if (
    result.status === "applied" ||
    result.status === "already_nurture" ||
    result.status === "already_qualified" ||
    result.status === "replayed"
  ) {
    return { status: result.status, decisionId: result.decisionId ?? "" };
  }
  if (
    result.status === "already_terminal" ||
    result.status === "dnc_locked" ||
    result.status === "not_found"
  ) {
    return { status: result.status };
  }
  reportError(new Error(`unexpected fn_auto_apply_jev_lead_decision status: ${result.status}`), {
    tags: { surface: "jev_lead_decision_auto_apply" },
    extra: { propertyId: args.propertyId, outcome: args.outcome },
  });
  return { status: "error" };
}

async function maybeAutoAcceptJevReview(
  supabase: SupabaseClient<Database>,
  inboundMessageId: string,
  classificationRunId: string,
): Promise<void> {
  const { data: review, error: lookupErr } = await supabase
    .from("ai_disposition_reviews")
    .select("id, status")
    .eq("source_inbound_message_id", inboundMessageId)
    .maybeSingle();
  if (lookupErr || !review || review.status !== "pending") return;

  const { error } = await supabase.rpc("fn_accept_ai_disposition_review", {
    p_review_id: review.id,
    p_classification_run_id: classificationRunId,
  });
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "sms_classification_auto_accept" },
      extra: { inboundMessageId, classificationRunId },
    });
  }
}

async function findExistingAiDispositionReview(
  supabase: SupabaseClient<Database>,
  inboundMessageId: string,
): Promise<
  { ok: true; disposition: AiReviewDisposition | null } | { ok: false }
> {
  const { data, error } = await supabase
    .from("ai_disposition_reviews")
    .select("disposition")
    .eq("source_inbound_message_id", inboundMessageId)
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_dispo_replay_lookup" },
      extra: { inboundMessageId },
    });
    return { ok: false };
  }
  const disposition = data?.disposition;
  if (
    disposition === "wrong_number" ||
    disposition === "not_interested" ||
    disposition === "opted_out" ||
    disposition === "dnc"
  ) {
    return { ok: true, disposition };
  }
  return { ok: true, disposition: null };
}

/**
 * Writes `outreach_dispo = 'nurture'` for a Jev-classified nurture
 * outcome. Label-only, no reply, no owner assignment — matches the
 * scope Jarrad approved (2026-09-20): `needs_sequence` (which requires a
 * human-assigned owner, `src/lib/my-leads/settings.ts:150`) is the
 * future migration target once real sequence hookup exists, never
 * written by this adapter.
 *
 * Deliberately does NOT reuse `setOutreachDispo`
 * (`app/(dashboard)/messages/dispo-actions.ts`) — that's a `"use
 * server"` action requiring a signed-in `auth.uid()`, which this
 * webhook-driven dispatch pipeline doesn't have. This is the minimal
 * equivalent write for a service-role caller, same optimistic-
 * concurrency guard, without the human-auth requirement nurture doesn't
 * need.
 */
/**
 * Astra PR review finding (2026-09-20): the original version's
 * optimistic-concurrency check only guarded against a change happening
 * AFTER its own read — if the property was already DNC/opted_out/a
 * booked appointment/etc. by the time this function's own SELECT ran
 * (e.g. a human acted while Jev's classification call was in flight),
 * it would read that value as the "current" baseline and happily
 * overwrite it with nurture, clearing `follow_up_at` in the process.
 *
 * Fixed by refusing to write at all unless the freshly-read disposition
 * is null or already `nurture` (idempotent retry) — nurture is the
 * lowest-priority tag in this system; it must never downgrade anything
 * more specific that's already there. Mirrors the terminal-state check
 * `fn_apply_ai_disposition_with_review` already does for its own four
 * dispositions, applied here for the fifth (nurture has no RPC of its
 * own since it needs no auth.uid() gate).
 */
/**
 * Jev-driven dnc: open the pending human review (outreach_dispo untouched) and
 * hold the lead with `jev_dnc_needs_confirm`. NO phone suppression, no consent
 * event: per Jarrad's 2026-10-07 directive ("I don't want Jev making any DNC
 * decisions") only a human confirming the review suppresses the phone.
 */
async function proposeJevDncForReview(
  supabase: SupabaseClient<Database>,
  args: {
    runContext?: MaybeRunContext;
    propertyId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    classificationRunId: string;
    reason: string;
    expectedRevision: number;
  },
): Promise<ResponderDispoResult> {
  if (!args.conversationId || !args.inboundMessageId) {
    const reason = "ai_disposition_missing_thread_identity";
    await markPropertyNeedsAttention(supabase, args.propertyId, reason, args.runContext);
    reportError(new Error(reason), {
      tags: { surface: "ai_responder_propose_dnc" },
      extra: { propertyId: args.propertyId },
    });
    return { updated: false, reason: "db_error" };
  }

  const { data, error } = await supabase.rpc(
    "fn_propose_ai_dnc_suppression_review",
    {
      p_property_id: args.propertyId,
      p_conversation_id: args.conversationId,
      p_source_inbound_message_id: args.inboundMessageId,
      p_classification_run_id: args.classificationRunId,
      p_ai_reason: args.reason,
      p_expected_revision: args.expectedRevision,
    },
  );
  if (error) {
    if (error.message.includes("STALE_DECISION_CONTEXT")) {
      await markPropertyNeedsAttention(supabase, args.propertyId, "jev_stale_decision_context", args.runContext);
      return { updated: false, reason: "stale_context" };
    }
    await markPropertyNeedsAttention(supabase, args.propertyId, "dnc_proposal_write_failed", args.runContext);
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_propose_dnc" },
      extra: { propertyId: args.propertyId, reason: args.reason },
    });
    return { updated: false, reason: "db_error" };
  }

  const status = readAiDispositionRpcStatus(data);
  if (status === "already_terminal") return { updated: false, reason: "already_terminal" };
  // "proposed" and "replayed" both mean a pending review + hold now exist;
  // the phone is NOT suppressed and outreach_dispo waits for a human.
  await stampHoldReason(supabase, args.propertyId, HOLD_JEV_DNC_NEEDS_CONFIRM, args.runContext);
  return { updated: true };
}

/**
 * Legacy-classifier opt_out / dnc (no Jev run, so no review RPC input): hold
 * the lead for a human and do nothing else. No disposition, no consent event,
 * no phone suppression.
 */
async function holdModelOptOutForHuman(
  supabase: SupabaseClient<Database>,
  args: {
    runCtx: MaybeRunContext | undefined;
    propertyId: string;
    claimId: string | null;
    reason: string;
    routeReason: string;
  },
): Promise<AiDispatchOutcome> {
  const flagOk = await markPropertyNeedsAttention(supabase, args.propertyId, args.reason, args.runCtx);
  if (flagOk) {
    await stampHoldReason(supabase, args.propertyId, args.reason, args.runCtx);
  }
  await completeClaim(supabase, args.propertyId, {
    claimId: args.claimId,
    outcome: "escalated",
    flagOk,
  });
  return { outcome: "escalated", reason: args.reason };
}

/**
 * The review RPCs flip `needs_human_attention` themselves, so
 * `markPropertyNeedsAttention` (which only writes when the flag is still
 * false) would never record WHY. This sets the reason on an already-held
 * property. Best effort: the pending review row is the durable record.
 */
async function stampHoldReason(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  reason: string,
  runContext?: MaybeRunContext,
): Promise<void> {
  await trace(
    supabase,
    { kind: "hold", name: "needs_confirm", result: "held", detail: { reason } },
    runContext,
  );
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("properties")
    .update({
      last_ai_escalation_reason: reason,
      last_ai_escalation_at: now,
      updated_at: now,
    })
    .eq("id", propertyId)
    .eq("needs_human_attention", true)
    // Never overwrite a suppression_incomplete pointer: it names reviews whose
    // phone suppression is still owed and drives the sweeper/clear logic.
    .or("last_ai_escalation_reason.is.null,last_ai_escalation_reason.not.like.suppression_incomplete%");
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_stamp_hold_reason" },
      extra: { propertyId, reason },
    });
  }
}

/**
 * Root final-review finding (P1, jev-root-final-review.md, 2026-09-20):
 * `fn_apply_ai_disposition_with_review` (called by `setResponderDispo`)
 * writes `properties.outreach_dispo` IMMEDIATELY even for a below-
 * threshold Jev decision — only the auto-accept step was ever skipped.
 * "Below threshold routes to Needs a decision" must mean the property is
 * UNCHANGED until a human confirms, not merely unacknowledged. This
 * calls `fn_propose_deferred_ai_disposition_review`
 * (20261008140400_jev_deferred_disposition_proposal.sql) instead, which
 * creates the pending review with `dispo_applied=false` and never
 * touches `outreach_dispo`. This function applies no suppression for any
 * disposition: per Jarrad's Q6 rule a below-threshold opted_out is held for
 * human review like the others (keyword STOP suppresses upstream in code).
 */
async function proposeDeferredJevDisposition(
  supabase: SupabaseClient<Database>,
  args: {
    runContext?: MaybeRunContext;
    propertyId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    classificationRunId: string;
    dispo: "wrong_number" | "not_interested" | "opted_out";
    reason: string;
    expectedRevision: number;
    /** Recorded as the hold reason once the pending review exists. */
    holdReason?: string;
    /** wrong_number only: scope "all" makes a human confirm suppress the phone. */
    wrongScope?: AiWrongScope;
  },
): Promise<ResponderDispoResult> {
  if (!args.conversationId || !args.inboundMessageId) {
    const reason = "ai_disposition_missing_thread_identity";
    await markPropertyNeedsAttention(supabase, args.propertyId, reason, args.runContext);
    reportError(new Error(reason), {
      tags: { surface: "ai_responder_propose_deferred_dispo" },
      extra: { propertyId: args.propertyId, dispo: args.dispo },
    });
    return { updated: false, reason: "db_error" };
  }

  const { data, error } = await supabase.rpc(
    "fn_propose_deferred_ai_disposition_review",
    {
      p_property_id: args.propertyId,
      p_conversation_id: args.conversationId,
      p_source_inbound_message_id: args.inboundMessageId,
      p_classification_run_id: args.classificationRunId,
      p_disposition: args.dispo,
      p_ai_reason: args.reason,
      p_expected_revision: args.expectedRevision,
      ...(args.dispo === "wrong_number" && args.wrongScope ? { p_wrong_scope: args.wrongScope } : {}),
    },
  );
  if (error) {
    if (error.message.includes("STALE_DECISION_CONTEXT")) {
      await markPropertyNeedsAttention(supabase, args.propertyId, "jev_stale_decision_context", args.runContext);
      return { updated: false, reason: "stale_context" };
    }
    await markPropertyNeedsAttention(supabase, args.propertyId, "disposition_proposal_write_failed", args.runContext);
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_propose_deferred_dispo" },
      extra: { propertyId: args.propertyId, dispo: args.dispo, reason: args.reason },
    });
    return { updated: false, reason: "db_error" };
  }

  const status = readAiDispositionRpcStatus(data);
  if (status === "already_terminal") return { updated: false, reason: "already_terminal" };
  // "proposed" and "replayed" both mean a pending review now exists —
  // same convention as proposeJevDncForReview's `updated: true`. The
  // outreach_dispo write itself is intentionally still pending.
  if (args.dispo === "wrong_number" && args.wrongScope === "all") {
    await stampHoldReason(supabase, args.propertyId, HOLD_JEV_WRONG_NUMBER_ALL_NEEDS_CONFIRM, args.runContext);
  } else if (args.holdReason) {
    await stampHoldReason(supabase, args.propertyId, args.holdReason, args.runContext);
  }
  return { updated: true };
}

async function applyWrongNumber(
  supabase: SupabaseClient<Database>,
  args: {
    runContext?: MaybeRunContext;
    propertyId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    scope: AiWrongScope;
    reason: string;
    expectedRevision?: number;
    undo?: { orgId: string; classificationRunId: string };
  },
): Promise<ResponderDispoResult> {
  // The wrong_number disposition applies to THIS property only. A model's
  // "wrong number for everything" judgment (scope = all) never suppresses the
  // phone by itself (Jarrad 2026-10-07: no automated DNC decisions): it keeps
  // the review pending and holds the lead so a human decides phone-wide
  // suppression.
  const result = await setResponderDispo(supabase, {
    runContext: args.runContext,
    propertyId: args.propertyId,
    conversationId: args.conversationId,
    inboundMessageId: args.inboundMessageId,
    dispo: "wrong_number",
    reason: args.reason,
    expectedRevision: args.expectedRevision,
    undo: args.undo,
    wrongScope: args.scope,
  });
  if (args.scope === "all" && result.updated) {
    const flagged = await markPropertyNeedsAttention(
      supabase,
      args.propertyId,
      HOLD_JEV_WRONG_NUMBER_ALL_NEEDS_CONFIRM,
      args.runContext,
    );
    if (flagged) {
      await stampHoldReason(
        supabase,
        args.propertyId,
        HOLD_JEV_WRONG_NUMBER_ALL_NEEDS_CONFIRM,
        args.runContext,
      );
    }
  }
  return result;
}

/**
 * Hold a hostile conversation for a person. Nothing is suppressed and nothing
 * is sent: only a human click ("Confirm do-not-contact" on the hold card)
 * suppresses the number and then sends the approved hostile reply.
 */
async function holdHostileForConfirm(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  responseClaim: { claimId: string | null },
  runCtx?: MaybeRunContext,
): Promise<AiDispatchOutcome> {
  await trace(supabase, {
    kind: "gate",
    name: "hostile_hold",
    result: "block",
    detail: { reason: HOSTILE_NEEDS_CONFIRM_REASON },
  }, runCtx);
  // The originating inbound id rides in the hold reason so "Confirm
  // do-not-contact" acts on exactly this message's contact and number.
  const flagOk = await markPropertyNeedsAttention(
    supabase,
    input.propertyId,
    input.inboundMessageId
      ? `${HOSTILE_NEEDS_CONFIRM_REASON}:${input.inboundMessageId}`
      : HOSTILE_NEEDS_CONFIRM_REASON,
    runCtx,
  );
  await completeClaim(supabase, input.propertyId, {
    claimId: responseClaim.claimId,
    outcome: "escalated",
    flagOk,
  });
  return { outcome: "escalated", reason: HOSTILE_NEEDS_CONFIRM_REASON };
}

async function loadContactPhone(
  supabase: SupabaseClient<Database>,
  contactId: string,
): Promise<{ phone: string | null; firstName: string | null }> {
  const { data, error } = await supabase
    .from("contacts")
    .select(
      "phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, first_name",
    )
    .eq("id", contactId)
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_contact_lookup" },
      extra: { contactId },
    });
  }
  const destination = selectBestSmsPhone(data);
  return {
    phone: destination?.phone ?? null,
    firstName: data?.first_name?.trim() || null,
  };
}

async function traceClaim(
  supabase: SupabaseClient<Database>,
  claim: { claimed: boolean; claimId?: string | null; reason?: string },
  ctx?: MaybeRunContext,
): Promise<void> {
  const runCtx = ctx ?? null;
  if (!runCtx) return;
  await trace(
    supabase,
    claim.claimed
      ? {
          kind: "action",
          name: "claim",
          result: "applied",
          detail: { claimId: claim.claimId ?? null },
        }
      : {
          kind: "action",
          name: "claim",
          result: "skipped",
          detail: { reason: claim.reason ?? "already_claimed" },
        },
    runCtx,
  );
  if (claim.claimed && claim.claimId) {
    await updateRun(supabase, runCtx, { claimId: claim.claimId });
  }
  if (!claim.claimed) {
    // Lost the claim: this process must never finalise the shared run.
    runCtx.duplicate = true;
    await trace(
      supabase,
      {
        kind: "gate",
        name: "duplicate_dispatch",
        result: "skipped",
        detail: { reason: claim.reason ?? "already_claimed" },
      },
      runCtx,
    );
  }
}

async function traceDisposition(
  supabase: SupabaseClient<Database>,
  name: string,
  result: ResponderDispoResult,
  deferred: boolean,
  ctx?: MaybeRunContext,
): Promise<void> {
  await trace(supabase, {
    kind: "action",
    name,
    result: result.updated
      ? deferred
        ? "held"
        : "applied"
      : result.reason === "db_error"
        ? "error"
        : "skipped",
    detail: result.updated
      ? { deferred }
      : { deferred, reason: result.reason },
  }, ctx);
}

function closeOutcome(
  result: ResponderDispoResult,
  reason: string,
): Extract<
  AiDispatchOutcome,
  { outcome: "auto_closed" | "skipped" | "escalated" }
> {
  if (result.updated) {
    return { outcome: "auto_closed", reason };
  }
  if (result.reason === "already_terminal") {
    return silentSkip("already_terminal", 0);
  }
  if (result.reason === "replayed_other_disposition") {
    return silentSkip("replayed_other_disposition", 0);
  }
  return { outcome: "escalated", reason: "disposition_write_failed" };
}

function dispositionClaimError(result: ResponderDispoResult): string | null {
  return !result.updated && result.reason === "db_error"
    ? "disposition_write_failed"
    : null;
}

async function buildDeescalationBody(
  supabase: SupabaseClient<Database>,
  contactId: string,
): Promise<string> {
  const contact = await loadContactPhone(supabase, contactId);
  if (!contact.firstName) return DEESCALATION_TEMPLATE_GENERIC;
  const named = DEESCALATION_TEMPLATE_WITH_NAME.replace(
    "{first_name}",
    contact.firstName,
  );
  return named.length <= 160 ? named : DEESCALATION_TEMPLATE_GENERIC;
}

function readAiDispositionRpcStatus(
  value: Json,
): "applied" | "proposed" | "replayed" | "already_terminal" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = (value as Record<string, Json>).status;
  return status === "applied" ||
    status === "proposed" ||
    status === "replayed" ||
    status === "already_terminal"
    ? status
    : null;
}

async function loadInboundBusinessNumber(
  supabase: SupabaseClient<Database>,
  inboundMessageId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("to_address")
    .eq("id", inboundMessageId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (error) {
    throw new Error(`AI inbound sender lookup failed: ${error.message}`);
  }
  return data?.to_address ?? null;
}

function assertNeverRoute(value: never): never {
  throw new Error(`Unhandled responder route: ${JSON.stringify(value)}`);
}

/**
 * markPropertyNeedsAttention never overwrites an existing flag, so a property
 * already held for something else (a draft, a price escalation) would lose the
 * actionable, message-specific confirm-DNC reason. Upgrade the reason to this
 * message's confirm hold, guarded on the value just read. A suppression
 * recovery pointer is preserved (it carries its own retry action).
 */
export async function flagConfirmDncHold(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  reason: string,
): Promise<boolean> {
  const flagged = await markPropertyNeedsAttention(supabase, propertyId, reason);
  if (!flagged) return false;
  const { data, error } = await supabase
    .from("properties")
    .select("needs_human_attention, last_ai_escalation_reason")
    .eq("id", propertyId)
    .maybeSingle();
  if (error || !data) return false;
  const current = data.last_ai_escalation_reason ?? null;
  if (data.needs_human_attention !== true) return false;
  if (current === reason) return true;
  if (current && (current === "suppression_incomplete" || current.startsWith("suppression_incomplete:"))) return true;
  const base = supabase
    .from("properties")
    .update({ last_ai_escalation_reason: reason, last_ai_escalation_at: new Date().toISOString() })
    .eq("id", propertyId)
    .eq("needs_human_attention", true);
  const { data: updated, error: updateError } = await (current === null
    ? base.is("last_ai_escalation_reason", null)
    : base.eq("last_ai_escalation_reason", current)
  ).select("id");
  if (updateError) return false;
  return Array.isArray(updated) ? updated.length > 0 : Boolean(updated);
}


/**
 * The number-source hold carries an obligation (a person must answer or look), and
 * on the identity path the message is already out so the dispatch cannot be re-run.
 * Tries the flag write up to three times; a persistent failure is reported by
 * `markPropertyNeedsAttention` and returned as false.
 */
async function holdWithRetry(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  reason: string,
  runContext?: MaybeRunContext,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await markPropertyNeedsAttention(supabase, propertyId, reason, runContext)) return true;
  }
  return false;
}

export async function markPropertyNeedsAttention(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  reason: string,
  runContext?: MaybeRunContext,
  /**
   * An abandoned send attempt passes its validity check: it runs immediately
   * before the evidence step AND again before the property write (the trace
   * awaits, so the attempt can expire in between). Not an attempt = no guard.
   */
  guard: Guard = NO_GUARD,
  /** Called with the flag time only when THIS call set the flag (not when it was already set). */
  onSet?: (flagAt: string) => void,
): Promise<boolean> {
  // Evidence first: the hold is recorded whether or not the flag write wins.
  guard();
  await trace(
    supabase,
    { kind: "hold", name: "needs_attention", result: "held", detail: { reason } },
    runContext,
  );
  guard();
  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("properties")
    .update({
      needs_human_attention: true,
      last_ai_escalation_reason: reason,
      last_ai_escalation_at: now,
      updated_at: now,
    })
    .eq("id", propertyId)
    .eq("needs_human_attention", false)
    .select("id")
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_mark_attention" },
      extra: { propertyId, reason },
    });
    return false;
  }
  if (!updated) {
    // Nothing matched `needs_human_attention = false`. Reviews of 3288da8ef6b3 / 251a3321672a
    // (B-1, N-2, N-3): write this hold through the one hold writer, atomically, without reading
    // first: it holds a lead that became unheld meanwhile, and upgrades a lead held only for our
    // own unsent reply (mechanics) to safety so the next text cannot clear it.
    const r = await writeSafetyHold(supabase, propertyId, null, reason);
    if (r === "upgraded" || r === "already_held") return true;
    if (r === "missing" || r === "error") return false;
    if (r === "unavailable") {
      // The function is not deployed yet: prove the flag exists (pre-420000 behaviour).
      const { data: current, error: readError } = await supabase
        .from("properties")
        .select("needs_human_attention")
        .eq("id", propertyId)
        .maybeSingle();
      const exists = !readError && current?.needs_human_attention === true;
      if (!exists) {
        reportError(new Error(readError?.message ?? "attention flag not persisted"), {
          tags: { surface: "ai_responder_mark_attention" },
          extra: { propertyId, reason },
        });
      }
      return exists;
    }
    // r === "held": this call set the flag; reconcile below as for the plain write.
  }
  onSet?.(now);
  // Reconciliation of a SUCCESSFUL flag: the lead-event ledger entry is
  // evidence about a flag that already exists. A failure here must never turn
  // a persisted flag into a failed one (nor propagate), so it is reported and
  // swallowed.
  try {
    await recordLeadEvent({
      propertyId,
      actorType: "ai",
      eventType: LEAD_EVENT_TYPES.AI_ESCALATED,
      payload: { from: false, to: true, reason },
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "ai_responder_mark_attention_lead_event" },
      extra: { propertyId, reason },
    });
  }
  return true;
}

function readJsonObject(value: Json | null): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

function isAiReplyDuplicateInsertError(message: string): boolean {
  return (
    message.includes("idx_messages_ai_responder_inbound_unique") ||
    message.includes("duplicate key value violates unique constraint")
  );
}

/**
 * Count AI-generated messages already sent on this property's thread.
 * Drives the `max_turns` cap.
 */
async function countAiTurnsInThread(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  contactId: string,
  conversationId: string | null,
): Promise<number | null> {
  // ONE query. Exclude ONLY rows retired before the provider (the always-set
  // `abortedBeforeProvider: true` marker): the seller never received those. A
  // row that failed at or after the provider boundary still counts (its text
  // may have reached the seller). A failed count returns null: the caller
  // fails CLOSED (Q8 rule 7), it never assumes "no turns yet".
  const query = supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .eq("direction", "outbound")
    .contains("metadata", { generated_by: "ai_responder_v1" })
    .or("metadata->>abortedBeforeProvider.is.null,metadata->>abortedBeforeProvider.neq.true")
    // Legacy retired rows carry only `aborted_inbound_message_id`; the same
    // marker pair `findExistingAiReplyForInbound` honours.
    .is("metadata->>aborted_inbound_message_id", null);
  const { count, error } = await (conversationId
    ? query.eq("conversation_id", conversationId)
    : query.eq("contact_id", contactId));
  if (error || count === null || count === undefined) {
    reportError(new Error(error?.message ?? "missing turn count"), {
      tags: { surface: "ai_responder_turn_count" },
      extra: { propertyId },
    });
    return null;
  }
  return count;
}

/**
 * Load the last ~20 messages in this property's thread, oldest first,
 * mapped to the role shape Claude expects. Inbound → user, outbound →
 * assistant (from the model's perspective it IS the assistant that
 * authored the outbound, regardless of whether AI or a human did).
 */
async function loadConversation(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  contactId: string,
  conversationId: string | null,
  excludeMessageId: string | null,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  let query = supabase
    .from("messages")
    .select("direction, body, created_at")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: false })
    .limit(20);
  query = conversationId
    ? query.eq("conversation_id", conversationId)
    : query.eq("contact_id", contactId);
  // The current inbound is appended by the caller; its row already
  // exists (webhook inserts before dispatch), so drop it here or the
  // model sees the message it is answering twice.
  if (excludeMessageId) query = query.neq("id", excludeMessageId);
  const { data } = await query;
  const rows = (data ?? []).slice().reverse(); // chronological
  return rows.map((r) => ({
    role: r.direction === "inbound" ? "user" : "assistant",
    content: r.body ?? "",
  }));
}

/**
 * Tell every admin the AI responder is down at the ACCOUNT level —
 * throttled to one notification per failure kind per 24h, because a
 * busy campaign can hit the same dead-credits wall on every single
 * inbound and a notification per reply is noise, not signal. Failures
 * here are swallowed: notifying is best-effort and must never break
 * the escalation path that is already protecting the conversation.
 */
async function notifyAdminsOfProviderFailure(
  supabase: SupabaseClient<Database>,
  args: {
    orgId: string;
    propertyId: string;
    failure: "billing" | "auth";
  },
): Promise<void> {
  try {
    // Per-KIND throttle: a billing alert must not suppress a later auth
    // alert. Kind is matched via the deterministic title written by
    // formatNotification (coupling noted there) — and the migration-076
    // partial unique index on (user_id, title, utc-day) makes the
    // insert race-safe even when two concurrent failures both pass this
    // read-then-insert check: the loser's insert conflicts and is
    // swallowed by createNotification.
    const titleNeedle =
      args.failure === "billing" ? "%credits exhausted%" : "%key rejected%";
    const { data: recent } = await supabase
      .from("notifications")
      .select("id")
      .eq("org_id", args.orgId)
      .eq("event_type", "ai_responder_provider_failure")
      .ilike("title", titleNeedle)
      .gte(
        "created_at",
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      )
      .limit(1);
    if (recent && recent.length > 0) return;

    const adminIds = await listAdminUserIds(supabase);
    if (adminIds.length === 0) return;

    await createNotification(supabase, {
      orgId: args.orgId,
      eventType: "ai_responder_provider_failure",
      entityType: "property",
      entityId: args.propertyId,
      payload: { providerFailure: args.failure },
      recipients: adminIds,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "ai_responder_provider_failure_notify" },
      extra: { orgId: args.orgId, failure: args.failure },
    });
  }
}


// ----------------------------------------------------------------------------
// Messages v2 PR 3 — Jarrad's nine questions (per-org switch
// `ai_responder_configs.classifier_engine = 'nine_questions'`, automatic mode).
// Replies are only approved library texts; every send goes through the existing
// gates (send gate, suppression, quiet hours, outbound mode). Nothing here
// suppresses a number or sets a terminal disposition except wrong_person, which
// closes THIS property exactly as the eight-answer wrong-number route does.
// ----------------------------------------------------------------------------

type NineStepArgs = {
  input: AiDispatchInput;
  property: AiDispatchPropertyGateRow;
  claim: { claimId: string | null };
  runCtx?: MaybeRunContext;
  /** Absent on the reply-ineligible (decoupled) path: no reply can be sent. */
  templateCtx?: TemplateStepContext;
  /** The org's escalation phrases (the same list PR 2's price-keyword decision reads). */
  escalationKeywords?: ReadonlyArray<string> | null;
  /** Reply-ineligible path only: the skip classifier's reason (e.g. `outside_business_hours`). */
  replyIneligibleReason?: string;
  /** Test seam: the clock the deferral reads. */
  now?: Date;
};

/** A hot reply whose lead changed after the hand-off (someone acted on it): the text is dropped. */
const NINE_HOT_REPLY_CONTEXT_CHANGED = "nine_hot_reply_context_changed";
/** A deferred nine-question reply whose lead changed while it waited: a person looks. */
export const NINE_DEFERRED_CONTEXT_CHANGED = "nine_deferred_context_changed";
/** The repeat-no rule could not stop the drip after marking the lead not interested. */
export const NINE_REPEAT_NO_DRIP_STOP_FAILED = "nine_repeat_no_drip_stop_failed";
const NINE_REPEAT_NO_PAUSE_REASON = "status_terminal" as const;
/** Loop bound only (one inbound is deferred at most this many times), not a send cap. */
export const NINE_DEFER_MAX = 3;
/** Wait this long past the moment both windows open before re-dispatching. */
const NINE_DEFER_BUFFER_SECONDS = 5 * 60;
const NINE_DEFER_STEP_SECONDS = 15 * 60;
const NINE_DEFER_HORIZON_SECONDS = 48 * 60 * 60;

/**
 * Why a nine-question reply was not sent, when the ONLY reason is a closed send
 * window: business hours (the reply-ineligible skip), the recipient's local
 * window, or the reply delay clamped to 0 at the window's edge (delay.ts clamps
 * to 0 whenever the window is closed or about to close). Anything else (Florida
 * cap, draft-only mode, a repeat, a gate) is not deferrable.
 */
export function isNineDeferrableNotSent(why: string, replyIneligibleReason?: string): boolean {
  if (why === "reply_ineligible") return replyIneligibleReason === "outside_business_hours";
  return (
    why === "quiet_hours_recipient:outside_window" ||
    why === "delay_not_applied" ||
    // Late, window-only refusals from inside the send path / the provider fence.
    why === NINE_WINDOW_CLOSED ||
    why === `skipped:${NINE_WINDOW_CLOSED}` ||
    why === NINE_WINDOW_CLOSED_AT_FENCE ||
    why === `skipped:${NINE_WINDOW_CLOSED_AT_FENCE}`
  );
}

/** A send refused ONLY because a send window is closed (see runApprovedTemplateStep `windowDeferrable`). */
export const NINE_WINDOW_CLOSED = "nine_window_closed";
/** The same, refused at the provider fence: this attempt's own pending row was written first. */
export const NINE_WINDOW_CLOSED_AT_FENCE = "nine_window_closed_at_fence";
/** B-1: a v2 reply refused because the property's state (its time zone) cannot be read. */
export const NINE_WINDOW_UNKNOWN_STATE = "nine_window_unknown_state";

/**
 * Seconds from `now` until both the property's business-hours window and the
 * recipient's local window are open (plus a small buffer), or null when they
 * never are within 48 hours (unknown state / area code). Steps in 15-minute
 * increments so DST and multi-zone area codes need no date math.
 */
export function secondsUntilNineSendWindow(
  propertyState: string | null | undefined,
  recipientPhone: string | null | undefined,
  now: Date,
): number | null {
  for (let t = NINE_DEFER_STEP_SECONDS; t <= NINE_DEFER_HORIZON_SECONDS; t += NINE_DEFER_STEP_SECONDS) {
    const at = new Date(now.getTime() + t * 1000);
    if (checkQuietHours(propertyState, at).ok && checkRecipientQuietHours(recipientPhone, at).ok) {
      return t + NINE_DEFER_BUFFER_SECONDS;
    }
  }
  return null;
}

/**
 * Held for Jarrad exactly as the eight-answer path holds a price keyword: a hot hold
 * (`keyword:price_offer`, one alert), no reply, no drip.
 */
async function holdNinePriceKeyword(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  detail: Record<string, unknown>,
): Promise<AiDispatchOutcome> {
  const keywordReason = `keyword:${HOT_KEYWORD_TIER}`;
  await trace(supabase, {
    kind: "hold",
    name: "hot_wins",
    result: "held",
    detail: { ...detail, keyword: HOT_KEYWORD_TIER },
  }, a.runCtx);
  const flagOk = await markPropertyNeedsAttention(supabase, a.input.propertyId, keywordReason, a.runCtx);
  await completeClaim(supabase, a.input.propertyId, { claimId: a.claim.claimId, outcome: "escalated", flagOk });
  return { outcome: "escalated", reason: keywordReason };
}

/** A price keyword (or org escalation phrase of that tier) in the text; same test PR 2 uses. */
function hasHotPriceKeyword(inboundBody: string, escalationKeywords?: ReadonlyArray<string> | null): boolean {
  return isPriceKeyword(inboundBody, escalationKeywords);
}

/**
 * PR 2's hot-wins precedence for the nine answers: stop (asked_stop, hostile) and wrong person
 * always beat hot; talked_price / open_to_selling already are hot; every other answer yields to
 * a hot price keyword. Same phrase test PR 2 uses for the eight-answer path.
 */
const NINE_YIELDS_TO_HOT: ReadonlySet<string> = new Set(["maybe_later", "not_interested", "asked_who", "confirmed_owner", "just_ok", "needs_person"]);
function nineYieldsToHotKeyword(answer: string, inboundBody: string, escalationKeywords?: ReadonlyArray<string> | null): boolean {
  return NINE_YIELDS_TO_HOT.has(answer) && hasHotPriceKeyword(inboundBody, escalationKeywords);
}

async function nineHoldAndComplete(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  reason: string,
  outboundMessageId?: string | null,
): Promise<AiDispatchOutcome> {
  const flagOk = await holdWithRetry(supabase, a.input.propertyId, reason, a.runCtx);
  await completeClaim(supabase, a.input.propertyId, {
    claimId: a.claim.claimId,
    outcome: "escalated",
    flagOk,
    ...(outboundMessageId ? { outboundMessageId } : {}),
  });
  return { outcome: "escalated", reason };
}

/** Same refusal record the nurture auto-drip writes: a trace step plus a flag a person sees. */
async function nineRecordDrip(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  dripName: string,
  result: NineDripResult,
): Promise<boolean> {
  if (result.status === "refused") {
    await trace(supabase, {
      kind: "action",
      name: "drip_enrolled",
      result: "error",
      detail: { reason: result.reason, route: dripName, engine: "nine_questions" },
    }, a.runCtx);
    return markPropertyNeedsAttention(
      supabase,
      a.input.propertyId,
      result.reason === "drip_paused" ? "drip_paused" : `drip_enroll_failed:${result.reason}`,
      a.runCtx,
    );
  }
  await trace(supabase, {
    kind: "action",
    name: "drip_enrolled",
    result: "applied",
    detail: {
      status: result.status,
      route: dripName,
      engine: "nine_questions",
      sequenceId: result.sequenceId,
      ...(result.status === "enrolled" ? { enrollmentId: result.enrollmentId } : {}),
    },
  }, a.runCtx);
  return true;
}

/**
 * Hot answers (open_to_selling, talked_price) reuse TODAY's new_lead path unchanged:
 * promote atomically when the org's new_lead automation switch is on, otherwise
 * record the proposal and hold for a person. After a promotion it uses PR 2's hand-off
 * (`assignHotLeadToOwner`). This stays the single seam for hot handling.
 */
async function routeNineHot(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  r: { classificationRunId: string; evaluationRevision: number; result: NineQuestionResult },
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const { input } = a;
  const chosen = r.result.chosen!;
  const thresholds = await loadOrgThresholdMap(supabase, a.property.org_id);
  const newLead = thresholds.new_lead;
  const args = {
    propertyId: input.propertyId,
    conversationId: input.conversationId,
    inboundMessageId: input.inboundMessageId,
    classificationRunId: r.classificationRunId,
    outcome: "new_lead" as const,
    nativeConfidence: chosen.probability,
    thresholdAtDecision: r.result.cutoff,
    // The old new_lead settings version belongs to the 0.9 cutoff, not this 0.6 decision.
    thresholdVersion: null,
    expectedRevision: r.evaluationRevision,
  };
  if (newLead?.automationEnabled === true) {
    const applyResult = await applyJevLeadDecisionAtomically(supabase, args);
    if (applyResult.status === "applied" || applyResult.status === "already_qualified" || applyResult.status === "replayed") {
      await trace(supabase, { kind: "action", name: "promote_new_lead", result: "applied", detail: { status: applyResult.status, engine: "nine_questions" } }, a.runCtx);
      if (applyResult.status === "applied") {
        await recordLeadEvent({
          propertyId: input.propertyId,
          actorType: "system",
          eventType: LEAD_EVENT_TYPES.QUALIFIED,
          payload: { from: "prospect", to: "new_lead" },
        });
      }
      let handoffStatus: string | null = null;
      const handoffEscalation = await handOffHotLead(supabase, input.propertyId, a.claim, a.runCtx, input.inboundMessageId, (s) => {
        handoffStatus = s;
      });
      // A failed hand-off is a hot hold for a person: no reply text (the alert still fires).
      if (handoffEscalation) return handoffEscalation;
      // The approved hot reply (2026-10-20) goes out only AFTER the promotion and hand-off
      // above, so it can never delay or block the alert. It is skipped when the lead was
      // already a lead (already_qualified: a person already has it) or belongs to someone
      // else; either way the lead stays hot exactly as before.
      const action = actionForNineAnswer(r.result.answer);
      if (
        action.kind === "hot" &&
        action.reply &&
        applyResult.status !== "already_qualified" &&
        handoffStatus !== "owned_by_someone_else"
      ) {
        // The baseline every later check compares against: read right after the hand-off.
        const { data: afterHandoff } = await supabase
          .from("properties")
          .select("decision_context_revision")
          .eq("id", input.propertyId)
          .maybeSingle();
        if (afterHandoff) return sendNineHotReply(supabase, a, action.reply, r, afterHandoff.decision_context_revision);
      }
      if (action.kind === "hot" && action.reply) {
        await trace(supabase, {
          kind: "reply",
          name: "nine_hot_reply",
          result: "skipped",
          detail: { engine: "nine_questions", reply: action.reply, why: applyResult.status === "already_qualified" ? "already_a_lead" : handoffStatus === "owned_by_someone_else" ? "owned_by_someone_else" : "revision_unreadable" },
        }, a.runCtx);
      }
      await completeClaim(supabase, input.propertyId, { claimId: a.claim.claimId, outcome: "auto_closed" });
      return { outcome: "auto_closed", reason: "model:new_lead_promoted" };
    }
    const reason = "jev_new_lead_promotion_failed";
    await trace(supabase, { kind: "action", name: "promote_new_lead", result: "error", detail: { status: applyResult.status, engine: "nine_questions" } }, a.runCtx);
    let ourFlagAt: string | null = null;
    const flagOk = await markPropertyNeedsAttention(supabase, input.propertyId, reason, a.runCtx, NO_GUARD, (at) => {
      ourFlagAt = at;
    });
    await recordHotFailure(supabase, input.propertyId, input.inboundMessageId, reason, ourFlagAt);
    await completeClaim(supabase, input.propertyId, { claimId: a.claim.claimId, outcome: "escalated", errorMessage: applyResult.status, flagOk });
    return { outcome: "escalated", reason };
  }
  // Switch off: a person decides (the proposal row is the "needs a decision" record).
  await proposeJevLeadDecision(supabase, args);
  await trace(supabase, { kind: "hold", name: "nine_hot_lead", result: "held", detail: { reason: "hot_lead", answer: r.result.answer } }, a.runCtx);
  return nineHoldAndComplete(supabase, a, "hot_lead");
}

/**
 * A nine-question reply that could not go out only because the send window was
 * closed (see isNineDeferrableNotSent): instead of holding for a person, release
 * the claim and ask the caller to dispatch the same inbound again when both the
 * business-hours and the recipient's windows are open. The deferred run re-checks
 * the lead's decision_context_revision first (runNineQuestionsStep). Returns null
 * when it cannot be deferred (other reason, no computable window, loop bound hit):
 * the caller then holds exactly as before.
 */
async function maybeDeferNineReply(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  why: string,
  decision: { evaluationRevision: number; classificationRunId: string; result: NineQuestionResult },
  /** Hot reply only: the revision verified right after the hand-off (or carried by the hot deferral). */
  opts: { hotBaseline?: number } = {},
): Promise<AiRetryOutcome | null> {
  if (!isNineDeferrableNotSent(why, a.replyIneligibleReason)) return null;
  // A dispatch running without the reply delay (none configured, lookup failed, workflow
  // could not start) never sends an approved template: only the clamp-to-0 case may wait.
  if (a.input.replyDelayBypassed && a.input.replyDelayBypassReason !== "delay_not_applied") return null;
  if (!a.input.inboundMessageId) return null;
  const count = a.input.nineDeferral?.count ?? a.input.nineDeferCount ?? 0;
  if (count >= NINE_DEFER_MAX) return null;
  // The revision the deferred run must find. Our own refused pending row (fence refusal only)
  // moved it exactly once; anything else moving it means the lead changed: hold, don't defer.
  const ownRowBumps = why.endsWith(NINE_WINDOW_CLOSED_AT_FENCE) ? 1 : 0;
  const { data: liveRev, error: liveRevError } = await supabase
    .from("properties")
    .select("decision_context_revision")
    .eq("id", a.input.propertyId)
    .maybeSingle();
  if (liveRevError || !liveRev) return null;
  // A hot reply waits AFTER the promotion / hand-off, which move the revision themselves:
  // the deferred run instead requires the revision read here to be unchanged.
  // A hot reply: promotion and hand-off already moved the revision, so the baseline is the one
  // read right after the hand-off (or carried by the previous hot deferral). Only this attempt's
  // own refused pending row may have moved it since; anything else (a reassignment, a person
  // texting) drops the text instead of becoming the new baseline.
  const expected = opts.hotBaseline !== undefined ? opts.hotBaseline : decision.evaluationRevision;
  if (liveRev.decision_context_revision !== expected + ownRowBumps) return null;
  const phone = await resolveSendDestinationPhone(supabase, a.input);
  const delaySeconds = secondsUntilNineSendWindow(a.property.state, phone, a.now ?? new Date());
  if (delaySeconds === null) return null;
  // Released so the deferred re-dispatch of this same inbound can claim it again. As the
  // other retry paths: a lease that cannot be released means the retry could never run, so
  // nothing is scheduled and the caller holds for a person.
  const errorMessage = `nine_reply_deferred:${why}`;
  let released = await completeClaim(supabase, a.input.propertyId, {
    claimId: a.claim.claimId,
    outcome: "skipped",
    errorMessage,
    releaseLease: true,
  });
  if (!released) released = await expireAiResponseClaimLease(supabase, { claimId: a.claim.claimId, errorMessage });
  if (!released) {
    await trace(supabase, {
      kind: "gate",
      name: "retry_unschedulable",
      result: "error",
      detail: { engine: "nine_questions", why: "nine_reply_deferred" },
    }, a.runCtx);
    return null;
  }
  await trace(supabase, {
    kind: "action",
    name: "nine_reply_deferred",
    result: "applied",
    detail: { engine: "nine_questions", why, delaySeconds, deferral: count + 1 },
  }, a.runCtx);
  return {
    outcome: "retry",
    reason: "nine_reply_deferred",
    attempt: a.input.retryAttempt ?? 0,
    delaySeconds,
    nineDeferral: {
      count: count + 1,
      revision: liveRev.decision_context_revision,
      result: decision.result,
      classificationRunId: decision.classificationRunId,
      ...(opts.hotBaseline !== undefined ? { hotReply: true } : {}),
    },
  };
}

/**
 * The approved hot reply (Jarrad 2026-10-20) for asked_offer / named_price / open_to_selling.
 * Called only after the hot promotion + hand-off succeeded (or, on a deferred run, after the
 * revision check proved nothing changed since). Sent as fixed approved text through the same
 * send path as the nine identity reply, so every guard applies: consent / opt-out / suppression
 * and the send gates in sendResponderMessage, the outbound-mode hold, business hours and the
 * recipient's window + Florida cap (a closed window defers, never holds), the repeat guard
 * (the same text never goes twice to a property) and the provider fence.
 *
 * Never an extra hold: whatever happens to the text, the lead is already hot and on My Leads,
 * so a text that cannot go out is traced and the claim is closed (the send path's own guards
 * keep any flag they write themselves, e.g. the outbound-mode draft hold).
 */
async function sendNineHotReply(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  key: NineHotReply,
  r: { classificationRunId: string; evaluationRevision: number; result: NineQuestionResult },
  /** The lead's revision right after the hot hand-off (or carried by the hot deferral). */
  baseline: number,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const { input, property, claim, runCtx, templateCtx } = a;
  const body = NINE_HOT_REPLY_TEXTS[key];
  const promoted: AiDispatchOutcome = { outcome: "auto_closed", reason: "model:new_lead_promoted" };
  const notSent = async (why: string): Promise<AiDispatchOutcome | AiRetryOutcome> => {
    // A deferred run whose lead changed at the fence: someone acted on the lead, so drop the text.
    if (why !== NINE_DEFERRED_CONTEXT_CHANGED && why !== NINE_HOT_REPLY_CONTEXT_CHANGED) {
      const deferred = await maybeDeferNineReply(supabase, a, why, r, { hotBaseline: baseline });
      if (deferred) return deferred;
    }
    await trace(supabase, {
      kind: "reply",
      name: "nine_hot_reply",
      result: "skipped",
      detail: { engine: "nine_questions", reply: key, why },
    }, runCtx);
    await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "auto_closed", errorMessage: `nine_hot_reply_not_sent:${why}` });
    return promoted;
  };
  if (!templateCtx) return notSent("reply_ineligible");
  if (input.replyDelayBypassed) return notSent(input.replyDelayBypassReason ?? TEMPLATE_DROP_DELAY_UNAVAILABLE);
  const safety = validateAiReplyBody(body);
  if (!safety.ok) return notSent(`safety:${safety.reason}`);
  // Repeat guard: this exact text already went (or may have gone) to this property: never again.
  const repeat = await templateAlreadySentToProperty(supabase, property.org_id, input.propertyId, null, body);
  if (repeat !== "no") return notSent(repeat === "error" ? `${TEMPLATE_ALREADY_SENT}:lookup_failed` : TEMPLATE_ALREADY_SENT);
  // Fixed text, not a library template: check the recipient's clock and the Florida cap here
  // (the send path and the provider fence check them again).
  const window = await evaluateRecipientWindow(supabase, input);
  if (!window.ok) return notSent(`quiet_hours_recipient:${window.why}`);
  // Last look before sending: anyone who touched the lead since the hand-off (a reassignment,
  // a person texting) owns the conversation now, so the text is dropped.
  const { data: live, error: liveError } = await supabase
    .from("properties")
    .select("decision_context_revision")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (liveError || !live || live.decision_context_revision !== baseline) return notSent(NINE_HOT_REPLY_CONTEXT_CHANGED);
  const sent = await sendResponderMessage(supabase, {
    runContext: runCtx,
    input,
    body,
    model: templateCtx.model,
    confidence: 1,
    sentiment: "neutral",
    turn: templateCtx.currentTurn + 1,
    source: "llm",
    orgId: property.org_id,
    claimStartedAt: templateCtx.claimStartedAt,
    outboundMode: templateCtx.outboundMode,
    replyKind: "nine_hot_reply",
    windowDeferrable: true,
    approvedFixedText: true,
  });
  if (sent.outcome === "sent") {
    await trace(supabase, {
      kind: "reply",
      name: "nine_hot_reply",
      result: "applied",
      detail: { engine: "nine_questions", reply: key },
    }, runCtx);
    await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "auto_closed", outboundMessageId: sent.messageId });
    return promoted;
  }
  if (sent.outcome === "skipped" && (sent.reason === NINE_WINDOW_CLOSED || sent.reason === NINE_WINDOW_CLOSED_AT_FENCE || sent.reason === NINE_DEFERRED_CONTEXT_CHANGED)) {
    return notSent(sent.reason);
  }
  // Not sent and nothing stored (a transient provider problem): never re-run the hot path for
  // a text. A repeat dispatch would find the lead already promoted and send nothing anyway.
  if (sent.outcome === "retry") return notSent(`send_retry:${sent.reason}`);
  // escalated / skipped by a guard: the send path already settled its own flag, if any.
  await trace(supabase, {
    kind: "reply",
    name: "nine_hot_reply",
    result: "skipped",
    detail: { engine: "nine_questions", reply: key, why: `send_${sent.outcome}`, reason: sent.reason },
  }, runCtx);
  return settleClaimForSendOutcome(supabase, claim.claimId, sent, { orgId: property.org_id, input, body, runContext: runCtx });
}

/**
 * Jarrad's rule, approved verbatim 2026-10-20:
 * "If the homeowner says no again after already getting our not-interested reply, stop their drip, mark them Not interested, and send nothing."
 *
 * Runs only for a `not_interested` answer (at or above the cutoff: the engine's own
 * pick, never a keyword) after hostile / stop / price precedence. Returns null when
 * the property has not had the approved not-interested reply yet (the first no), or
 * its history is unreadable (the existing repeat guard then fails closed).
 */
async function routeNineRepeatNotInterested(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  r: { classificationRunId: string; evaluationRevision: number },
): Promise<AiDispatchOutcome | null> {
  const { input, property, claim, runCtx } = a;
  // Proof the first reply was RECEIVED: the provider accepted it. Anything less (none, only
  // pending / queued / failed rows, an unreadable history) is not this rule: the existing path
  // runs, and its repeat guard holds for a person whenever any copy might have gone out.
  if ((await notInterestedReplyAccepted(supabase, property.org_id, input.propertyId)) !== "yes") return null;
  const thresholds = await loadOrgThresholdMap(supabase, property.org_id);
  if (thresholds.not_interested?.automationEnabled !== true) {
    return nineHoldAndComplete(supabase, a, "nine_automation_disabled:not_interested");
  }
  await trace(supabase, {
    kind: "action",
    name: "nine_repeat_not_interested",
    result: "applied",
    detail: { engine: "nine_questions", rule: NINE_REPEAT_NOT_INTERESTED_RULE },
  }, runCtx);
  const reason = "nine_questions:not_interested_again";
  // The sanctioned disposition path (DNC lock, opt-out and stale-revision guards in the RPC).
  const closed = await setResponderDispo(supabase, {
    runContext: runCtx,
    propertyId: input.propertyId,
    conversationId: input.conversationId ?? null,
    inboundMessageId: input.inboundMessageId ?? null,
    dispo: "not_interested",
    reason,
    expectedRevision: r.evaluationRevision,
    undo: { orgId: property.org_id, classificationRunId: r.classificationRunId },
  });
  await traceDisposition(supabase, "not_interested", closed, false, runCtx);
  if (closed.updated && input.inboundMessageId) {
    await maybeAutoAcceptJevReview(supabase, input.inboundMessageId, r.classificationRunId);
  }
  const outcome = closeOutcome(closed, reason);
  if (closed.updated || (!closed.updated && closed.reason === "already_terminal")) {
    // Stop the drip for good (the paused "Not interested" enrolment included); the
    // helper records the lead event.
    try {
      const stopped = await pausePropertyEnrollments(supabase, {
        propertyId: input.propertyId,
        // An enrolment pause reason (sequences/pause-rules), not a hold reason.
        reason: NINE_REPEAT_NO_PAUSE_REASON,
        permanent: true,
      });
      await trace(supabase, {
        kind: "action",
        name: "drip_stopped",
        result: "applied",
        detail: { engine: "nine_questions", stopped: stopped.paused },
      }, runCtx);
    } catch (error) {
      reportError(error, { tags: { surface: "nine_repeat_not_interested_drip_stop" }, extra: { propertyId: input.propertyId } });
      await trace(supabase, {
        kind: "action",
        name: "drip_stopped",
        result: "error",
        detail: { engine: "nine_questions" },
      }, runCtx);
      return nineHoldAndComplete(supabase, a, NINE_REPEAT_NO_DRIP_STOP_FAILED);
    }
  }
  await completeClaim(supabase, input.propertyId, {
    claimId: claim.claimId,
    outcome: claimOutcomeOf(outcome),
    errorMessage: dispositionClaimError(closed),
  });
  return outcome;
}

/**
 * Refused at the provider fence because the lead changed after a deferral: never send the
 * stale decision and never drop it silently. Release the claim and re-dispatch the same
 * inbound shortly as a FRESH decision (the next run re-classifies and every gate applies).
 * Past the loop bound, or if the lease cannot be released, a person looks.
 */
async function redispatchNineFresh(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  decision: { evaluationRevision: number; classificationRunId: string; result: NineQuestionResult },
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const count = a.input.nineDeferral?.count ?? a.input.nineDeferCount ?? 0;
  if (count >= NINE_DEFER_MAX || !a.input.inboundMessageId) {
    return nineHoldAndComplete(supabase, a, NINE_DEFERRED_CONTEXT_CHANGED);
  }
  const errorMessage = "nine_reply_deferred:redispatch_fresh";
  let released = await completeClaim(supabase, a.input.propertyId, { claimId: a.claim.claimId, outcome: "skipped", errorMessage, releaseLease: true });
  if (!released) released = await expireAiResponseClaimLease(supabase, { claimId: a.claim.claimId, errorMessage });
  if (!released) return nineHoldAndComplete(supabase, a, NINE_DEFERRED_CONTEXT_CHANGED);
  await trace(supabase, {
    kind: "action",
    name: "nine_reply_deferred",
    result: "applied",
    detail: { engine: "nine_questions", why: "context_changed_at_fence", redispatch: "fresh", deferral: count + 1 },
  }, a.runCtx);
  return {
    outcome: "retry",
    reason: "nine_reply_deferred",
    attempt: a.input.retryAttempt ?? 0,
    delaySeconds: REPLY_RETRY_DELAY_SECONDS,
    nineDeferral: {
      count: count + 1,
      revision: decision.evaluationRevision,
      result: decision.result,
      classificationRunId: decision.classificationRunId,
      fresh: true,
    },
  };
}

/**
 * Routing v2 cutover (a): the live v2 engine for one inbound, behind routing_v2_flags.
 *
 * Returns null (= run today's nine-question step, byte for byte) unless the org's flags read
 * questions_live AND this property is canary-eligible. Otherwise:
 *   classify (Jev, Haiku per policy, DealMachine per price_check)
 *   -> immutable live decision row (routing_v2_live_decisions)
 *   -> one atomic transition from the STORED row (retire drip, enroll, queue reply + alerts)
 * Seller texts and owner alerts are queued in routing_v2_outbox and delivered by the outbox
 * consumer, which re-checks flags, newer replies, takeover and suppression at send time.
 * Anything that cannot be carried out exactly holds for a person with an existing reason.
 */
export async function runRoutingV2LiveStep(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
): Promise<AiDispatchOutcome | AiRetryOutcome | null> {
  const outcome = await runRoutingV2LiveStepInner(supabase, a);
  // H1(iii): per-property v2 decisions see each other. Texts in a burst are decided in
  // parallel: one can write a person hold (e.g. a possible stop) while another enrolls a drip.
  // Every v2 decision ends by re-reading the hold; a held lead keeps no active drip (paused for
  // the person, as the webhook pauses it). Whichever decision finishes last sees the other's
  // write, so the end state is always "held, drip paused". The outbox also refuses an auto
  // reply to a held lead (prepare). Jarrad Q2 default: a possible-stop hold stays with the person.
  if (outcome && outcome.outcome !== "retry" && a.input.routingV2Backfill?.mode !== "classify_only") await pauseDripsIfHeld(supabase, a.input.propertyId);
  return outcome;
}

async function pauseDripsIfHeld(supabase: SupabaseClient<Database>, propertyId: string): Promise<void> {
  try {
    const { data } = await supabase.from("properties").select("needs_human_attention").eq("id", propertyId).maybeSingle();
    if (data?.needs_human_attention !== true) return;
    await pausePropertyEnrollments(supabase, { propertyId, reason: "inbound_reply" });
  } catch (e) {
    reportError(e, { tags: { surface: "routing_v2_pause_drips_if_held" }, extra: { propertyId } });
  }
}

async function runRoutingV2LiveStepInner(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
): Promise<AiDispatchOutcome | AiRetryOutcome | null> {
  const { input, property, runCtx } = a;
  // A legacy deferral already owns this inbound's decision.
  if (input.nineDeferral || !input.inboundMessageId) return null;
  const flagRead = await readRoutingV2FlagsResult(supabase, property.org_id);
  if (!flagRead.ok) {
    // Unreadable flags (a database blip), not "off": a property v2 already routed (it has a v2
    // enrollment, which the webhook just paused) must not fall back to the legacy engine, which
    // neither retires that drip nor holds (H1(i): a paused drip on a lead nobody owns). A person
    // looks. A property v2 never touched keeps today's behaviour exactly.
    // "v2 already routed" = a v2 enrollment, a v2 decision / audit row, or a v2 outbox row (N-2).
    const loose = supabase as unknown as {
      from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> }; limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> } } };
    };
    const traces = await Promise.all([
      loose.from("sequence_enrollments").select("id").eq("property_id", input.propertyId).eq("routing_v2_engine", "v2").limit(1),
      loose.from("routing_v2_live_decisions").select("id").eq("property_id", input.propertyId).limit(1),
      loose.from("routing_v2_outbox").select("id").eq("property_id", input.propertyId).limit(1),
    ]);
    if (input.routingV2Backfill) return null; // the caller skips it (never legacy, never a hold from classify-only)
    if (traces.some((t) => t.error || (t.data ?? []).length > 0)) return nineHoldAndComplete(supabase, a, "nine_needs_person");
    return null;
  }
  const flags: RoutingV2Flags = flagRead.flags;
  if (!flags.questions_live || !isV2Eligible(flags, input.propertyId)) return null;
  const inboundMessageId = input.inboundMessageId;

  const { data: revisionRow, error: revisionError } = await supabase
    .from("properties")
    .select("decision_context_revision")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (revisionError || !revisionRow) return backfillClassifyOnlySkipOr(supabase, a, () => nineHoldAndComplete(supabase, a, "nine_needs_person"));
  const expectedRevision = revisionRow.decision_context_revision;

  // Backfill apply of a text an earlier classify-only run decided: record that decision now,
  // exactly as live (a safety decision with its atomic hold), then carry it out. No second
  // Jev / Haiku call. The row keeps the classify-time revision, so a lead that changed since
  // (a person acted, a text went out) makes the transition hold for a person instead of acting.
  if (input.routingV2Backfill && input.routingV2Backfill.mode !== "classify_only") {
    // Newest-inbound fence (Astra review 3): a newer seller text on this lead owns it. Checked
    // before anything is recorded, so no hold, suppression, close or alert comes from an older text.
    const newer = await backfillNewerInboundExists(supabase, input.propertyId, inboundMessageId);
    if (newer !== "no") {
      await completeClaim(supabase, input.propertyId, { claimId: a.claim.claimId, outcome: ROUTING_V2_BACKFILL_NEWER_INBOUND });
      return { outcome: "skipped", reason: ROUTING_V2_BACKFILL_NEWER_INBOUND };
    }
    if (input.routingV2Backfill.resumeRecordedDecision) {
      const recordedEarlier = await readLiveV2Evidence(supabase, inboundMessageId);
      if (recordedEarlier && (recordedEarlier.status === "decided" || recordedEarlier.status === "failed")) {
        if (recordedEarlier.property_id !== input.propertyId || recordedEarlier.org_id !== property.org_id) return nineHoldAndComplete(supabase, a, "nine_needs_person");
        return applyRoutingV2LiveEvidence(supabase, a, flags, recordedEarlier);
      }
    }
  }
  const storedRow = input.routingV2Backfill?.mode !== "classify_only" ? input.routingV2Backfill?.storedDecisionRow : undefined;
  if (storedRow) {
    if (storedRow.property_id !== input.propertyId || storedRow.org_id !== property.org_id || storedRow.inbound_message_id !== inboundMessageId) {
      return nineHoldAndComplete(supabase, a, "nine_needs_person");
    }
    if (input.routingV2Backfill?.mode === "sort_only" && storedRow.action) {
      storedRow.action = withSortOnlyPriceAlert(storedRow.action as V2Action);
    }
    const replayHold = v2SafetyHoldReason({
      kind: storedRow.status === "failed" ? "failed" : "decided",
      reason: (storedRow.failure_reason as string | null) ?? undefined,
      action: (storedRow.action as V2Action | null) ?? null,
    }, input);
    const replayed = await recordLiveV2DecisionRow(supabase, storedRow, replayHold);
    if (replayed === "hold_failed") {
      // Same fail-closed handling as a live safety decision whose hold could not be recorded.
      await pauseV2DripsFailClosed(supabase, input.propertyId);
      reportError(new Error("routing v2 backfill: replayed safety decision and hold could not be recorded"), {
        tags: { surface: "routing_v2_safety_decision" }, extra: { propertyId: input.propertyId, inboundMessageId },
      });
      await completeAiResponseClaim(supabase, { claimId: a.claim.claimId, outcome: "escalated", errorMessage: "v2_safety_hold_failed" });
      return { outcome: "escalated", reason: replayHold ?? "nine_needs_person" };
    }
    if (replayed === "failed") return nineHoldAndComplete(supabase, a, "nine_needs_person");
    const stored = await readLiveV2Evidence(supabase, inboundMessageId);
    if (!stored || stored.property_id !== input.propertyId || stored.org_id !== property.org_id) return nineHoldAndComplete(supabase, a, "nine_needs_person");
    return applyRoutingV2LiveEvidence(supabase, a, flags, stored);
  }

  let classification: Exclude<V2Classification, { kind: "off" }>;
  // Jev attempts actually made, for the spend ledger even if something after Jev throws.
  let jevAttempts: readonly JevAttemptOutcome[] = [];
  try {
    const { data: source } = await supabase.from("messages").select("created_at").eq("id", inboundMessageId).maybeSingle();
    const thread = await buildTwoWayThreadState(supabase, {
      propertyId: input.propertyId,
      contactId: input.contactId,
      conversationId: input.conversationId ?? null,
      excludeMessageId: inboundMessageId,
      sourceCreatedAt: source?.created_at ?? null,
    });
    const deps = v2ProviderDeps({
      jev: { fetch, apiKey: process.env.TYPESAFE_API_KEY ?? "", ...V2_LIVE_JEV_POLICY },
      haiku: { fetch, apiKey: process.env.ANTHROPIC_API_KEY_SANDRA ?? process.env.ANTHROPIC_API_KEY ?? "" },
      lookupValue: () => routingV2PropertyValue(supabase, property.org_id, input.propertyId),
    });
    const askJevCounted = deps.jev;
    deps.jev = async (request) => {
      try {
        const res = await askJevCounted(request);
        jevAttempts = res.attempts ?? ["ok"];
        return res;
      } catch (e) {
        if (e instanceof JevAttemptsError) jevAttempts = e.attempts;
        throw e;
      }
    };
    const result = await classifyV2(
      { flags, propertyId: input.propertyId, reply: input.inboundBody, thread, numberSourceQuestion: true },
      deps,
    );
    // classifyV2 only returns off when the flags say so; they were just read as on.
    classification = result.kind === "off" ? { ...V2_JEV_FAILED, jevAttempts } : result;
  } catch {
    // Thrown before Jev (thread build) = no attempt and no Jev ledger row; after it = its attempts.
    classification = { ...V2_JEV_FAILED, jevAttempts };
  }

  await recordV2ModelSpend(supabase, { orgId: property.org_id, propertyId: input.propertyId, inboundMessageId }, classification,
    (e) => reportError(e, { tags: { surface: "routing_v2_spend_ledger" }, extra: { inboundMessageId } }));
  if (input.routingV2Backfill?.mode === "sort_only" && classification.kind === "decided") {
    classification = { ...classification, action: withSortOnlyPriceAlert(classification.action) };
  }
  const decisionContext = { orgId: property.org_id, propertyId: input.propertyId, conversationId: input.conversationId ?? null, inboundMessageId, expectedRevision };
  if (input.routingV2Backfill?.mode === "classify_only") {
    // Backfill classify-only (Opus review B1): the decision row goes to the caller, NOT to the
    // recorder, so no decision row, hold, drip pause, reply cancel, alert or obligation is written.
    // A later backfill apply records and carries out this exact row.
    try {
      await input.routingV2Backfill.onClassified?.(liveDecisionRow(decisionContext, classification) as unknown as Record<string, unknown>);
    } catch {
      return backfillClassifyOnlySkipOr(supabase, a, () => nineHoldAndComplete(supabase, a, "nine_needs_person"));
    }
    await completeClaim(supabase, input.propertyId, { claimId: a.claim.claimId, outcome: ROUTING_V2_BACKFILL_CLASSIFY_ONLY });
    return { outcome: "skipped", reason: ROUTING_V2_BACKFILL_CLASSIFY_ONLY };
  }
  // Astra review of b6a00a0a2f17 (A): a safety decision is recorded together with its effects.
  const safetyHoldReason = v2SafetyHoldReason(classification, input);
  const recorded = await recordLiveV2Decision(supabase, decisionContext, classification, safetyHoldReason);
  if (recorded === "hold_failed") {
    // Nothing was recorded: no decision row, no hold. Fail closed now (the lead's v2 drips paused)
    // and close the claim as v2_safety_hold_failed: the apply gate blocks this lead's newer texts
    // and the sweep (per-property delivery or the cron) re-attempts the hold until it lands.
    await pauseV2DripsFailClosed(supabase, input.propertyId);
    reportError(new Error("routing v2: safety decision and hold could not be recorded"), {
      tags: { surface: "routing_v2_safety_decision" }, extra: { propertyId: input.propertyId, inboundMessageId },
    });
    await completeAiResponseClaim(supabase, { claimId: a.claim.claimId, outcome: "escalated", errorMessage: "v2_safety_hold_failed" });
    return { outcome: "escalated", reason: safetyHoldReason ?? "nine_needs_person" };
  }
  await testBarrier("dispatch:after_decision", { propertyId: input.propertyId, inboundMessageId });
  // A duplicate never acts on this run's classification: only the stored original does.
  const evidence = recorded === "failed" ? null : await readLiveV2Evidence(supabase, inboundMessageId);
  await trace(supabase, {
    kind: "action",
    name: "routing_v2_live_decision",
    result: evidence ? "applied" : "error",
    detail: { engine: "routing_v2", recorded, road: evidence?.road ?? null, status: evidence?.status ?? null },
  }, runCtx);
  if (!evidence || evidence.property_id !== input.propertyId || evidence.org_id !== property.org_id) {
    return nineHoldAndComplete(supabase, a, "nine_needs_person");
  }
  return applyRoutingV2LiveEvidence(supabase, a, flags, evidence);
}

/** Is the lead's current hold the one written for this inbound (hold_inbound_message_id)? */
async function backfillHoldIsFor(supabase: SupabaseClient<Database>, propertyId: string, inboundMessageId: string | null): Promise<boolean> {
  if (!inboundMessageId) return false;
  const { data, error } = await (supabase as unknown as { from: (t: string) => any }) // eslint-disable-line @typescript-eslint/no-explicit-any
    .from("properties").select("hold_inbound_message_id").eq("id", propertyId).maybeSingle();
  return !error && (data as { hold_inbound_message_id?: string | null } | null)?.hold_inbound_message_id === inboundMessageId;
}

/** A newer inbound SMS on the property than this one ("yes" / "no" / "error" = treat as newer). */
async function backfillNewerInboundExists(supabase: SupabaseClient<Database>, propertyId: string, inboundMessageId: string): Promise<"yes" | "no" | "error"> {
  const { data: me, error } = await supabase.from("messages").select("created_at").eq("id", inboundMessageId).maybeSingle();
  if (error || !me) return "error";
  const { data: newer, error: newerError } = await supabase.from("messages").select("id, created_at")
    .eq("property_id", propertyId).eq("direction", "inbound").eq("channel", "sms").gte("created_at", me.created_at)
    .neq("id", inboundMessageId).limit(20);
  if (newerError) return "error";
  return (newer ?? []).some((m) => m.created_at > me.created_at || m.id > inboundMessageId) ? "yes" : "no";
}

/** Classify-only never writes a hold: a path that would hold skips the text instead (counted). */
async function backfillClassifyOnlySkipOr(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  live: () => Promise<AiDispatchOutcome>,
): Promise<AiDispatchOutcome> {
  if (a.input.routingV2Backfill?.mode !== "classify_only") return live();
  await completeClaim(supabase, a.input.propertyId, { claimId: a.claim.claimId, outcome: ROUTING_V2_BACKFILL_CLASSIFY_UNAVAILABLE });
  return { outcome: "skipped", reason: ROUTING_V2_BACKFILL_CLASSIFY_UNAVAILABLE };
}

/**
 * The hold reason a stored decision's own path writes, for a SAFETY decision (a failed
 * classification, the stop road, a hold step); null for any other road. Mirrors
 * applyRoutingV2LiveEvidence so the atomic hold carries the same reason that path would write.
 */
function v2SafetyHoldReason(
  classification: { kind: string; reason?: string; action?: V2Action | null },
  input: AiDispatchInput,
): string | null {
  const hostile = isHostileInbound(input.inboundBody)
    ? (input.inboundMessageId ? `${HOSTILE_NEEDS_CONFIRM_REASON}:${input.inboundMessageId}` : HOSTILE_NEEDS_CONFIRM_REASON)
    : null;
  const failed = classification.kind === "failed";
  const step = liveStepFor({
    status: failed ? "failed" : "decided",
    action: failed ? null : classification.action ?? null,
    failure_reason: failed ? classification.reason ?? null : null,
  } as StoredLiveEvidence);
  if (step.kind === "failed") return hostile ?? `jev_automatic_failed:${step.reason}`;
  if (step.kind === "stop") return hostile ?? "nine_asked_stop";
  if (step.kind === "hold") return liveHoldReason(step.reason);
  return null;
}

/** Carry out one stored live v2 decision. Exported for the stage tests via the step above only. */
async function applyRoutingV2LiveEvidence(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  flags: RoutingV2Flags,
  evidence: StoredLiveEvidence,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const { input, claim, runCtx } = a;
  const inboundMessageId = input.inboundMessageId!;
  const step = liveStepFor(evidence);
  const holdWithAlerts = async (reason: "nine_asked_stop" | "nine_needs_person") => {
    // Owner alerts first (exactly once, no reply, no drip), then today's hold.
    const queued = await queueLiveHoldAlerts(supabase, evidence, {
      flags, propertyId: input.propertyId, contactId: input.contactId, inboundMessageId,
    });
    await trace(supabase, {
      kind: "hold",
      name: "routing_v2_hold",
      result: "held",
      detail: { engine: "routing_v2", road: evidence.road, alertsQueued: queued },
    }, runCtx);
    return nineHoldAndComplete(supabase, a, reason);
  };

  if (input.routingV2Backfill?.mode === "sort_only") {
    return applyRoutingV2SortOnly(supabase, a, flags, evidence, holdWithAlerts);
  }
  if (input.routingV2Backfill?.mode === "apply" && step.kind === "transition" && evidence.action && ROUTING_V2_BACKFILL_HOLD_ROADS.has(evidence.action.road)) {
    // An old reply on a road whose approved text only fits a fresh message: its owner alerts
    // are raised and a person looks; no reply, no drip.
    return holdWithAlerts("nine_needs_person");
  }
  if (step.kind === "failed") {
    // Same as today's nine engine on a failed classification: hostile wording waits for a
    // person's confirmation; otherwise the classifier-failure hold.
    if (isHostileInbound(input.inboundBody)) return holdHostileForConfirm(supabase, input, claim, runCtx);
    return nineHoldAndComplete(supabase, a, `jev_automatic_failed:${step.reason}`);
  }
  if (step.kind === "stop") return routeRoutingV2Stop(supabase, a, flags, evidence, holdWithAlerts);
  if (step.kind === "wrong_number" || step.kind === "bad_number") {
    return routeRoutingV2PhoneAction(supabase, a, flags, evidence, step.kind);
  }
  if (step.kind === "hold") return holdWithAlerts(liveHoldReason(step.reason));

  await testBarrier("dispatch:before_transition", { propertyId: input.propertyId, inboundMessageId });
  const applied = await applyStoredV2Transition(supabase, {
    orgId: evidence.org_id,
    propertyId: input.propertyId,
    contactId: input.contactId,
    inboundMessageId,
  });
  await trace(supabase, {
    kind: "action",
    name: "routing_v2_transition",
    result: applied.kind === "applied" ? "applied" : "skipped",
    detail: {
      engine: "routing_v2",
      road: evidence.road,
      ...(applied.kind === "applied"
        ? { outcome: applied.transition.outcome ?? null }
        : { reason: applied.reason, alertsQueued: applied.alertsQueued ?? null }),
    },
  }, runCtx);
  if (applied.kind === "applied") {
    await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "auto_closed" });
    // Deliver this property's queued reply now; the cron consumer is the backstop.
    runAfterResponse(async () => {
      await runRoutingV2OutboxReplies(supabase, { propertyId: input.propertyId, limit: 5 });
    });
    return { outcome: "auto_closed", reason: `routing_v2:${evidence.road}` };
  }
  if (applied.reason === "superseded") {
    // A newer seller text owns the thread; this one's owner alerts were still queued.
    await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "skipped", errorMessage: "routing_v2:superseded" });
    return { outcome: "skipped", reason: "superseded_by_newer_inbound" };
  }
  if (applied.reason === "held") {
    // A-2 F4: the lead is held for the seller's words / a person (the hold landed while this
    // text was being decided). No reply, no drip start; its owner alerts were queued. Not a new
    // hold: the lead is already with a person.
    await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "skipped", errorMessage: "routing_v2:already_held" });
    return { outcome: "skipped", reason: "routing_v2:already_held" };
  }
  // no_sequence, context_changed, flag_off, takeover / suppression, evidence problems: a person looks.
  return nineHoldAndComplete(supabase, a, "nine_needs_person");
}

/**
 * Backfill sort-only (replies older than --text-max-age-days): sort the lead from the stored
 * decision without ever texting the seller or starting a drip. Stops, bad numbers, holds and
 * failures take the live path (none of them sends). Wrong person / sold / tenant and not
 * interested are closed on THIS property through the existing AI disposition writer; hot and
 * alert roads raise their stored owner alerts and hold for a person; the rest is recorded only.
 */
async function applyRoutingV2SortOnly(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  flags: RoutingV2Flags,
  evidence: StoredLiveEvidence,
  holdWithAlerts: (reason: "nine_asked_stop" | "nine_needs_person") => Promise<AiDispatchOutcome>,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const { input, claim, runCtx } = a;
  const kind = routingV2SortOnlyKind(evidence);
  const step = liveStepFor(evidence);
  if (kind === "live_failed") {
    if (isHostileInbound(input.inboundBody)) return holdHostileForConfirm(supabase, input, claim, runCtx);
    return nineHoldAndComplete(supabase, a, `jev_automatic_failed:${step.kind === "failed" ? step.reason : "unknown"}`);
  }
  if (kind === "live_stop") return routeRoutingV2Stop(supabase, a, flags, evidence, holdWithAlerts);
  if (kind === "live_bad_number") return routeRoutingV2PhoneAction(supabase, a, flags, evidence, "bad_number");
  if (kind === "live_hold") return holdWithAlerts(step.kind === "hold" ? liveHoldReason(step.reason) : "nine_needs_person");
  if (kind === "alert_and_hold") return holdWithAlerts("nine_needs_person");
  if (kind === "close_wrong_number" || kind === "close_not_interested") {
    const dispo = kind === "close_wrong_number" ? "wrong_number" : "not_interested";
    // The disposition review's ai_reason (like the nine engine's `nine_questions:<answer>`), not a hold reason.
    const aiReason = `routing_v2_backfill_sort_only:${evidence.road ?? dispo}`;
    const result = await setResponderDispo(supabase, {
      runContext: runCtx,
      propertyId: input.propertyId,
      conversationId: input.conversationId ?? null,
      inboundMessageId: input.inboundMessageId ?? null,
      dispo,
      reason: aiReason,
      expectedRevision: evidence.expected_revision,
      ...(dispo === "wrong_number" ? { wrongScope: "this_property" as const } : {}),
    });
    await trace(supabase, {
      kind: "action", name: "routing_v2_backfill_sort_only", result: result.updated ? "applied" : "skipped",
      detail: { engine: "routing_v2", road: evidence.road, dispo, ...(result.updated ? {} : { reason: result.reason }) },
    }, runCtx);
    if (!result.updated && result.reason !== "already_terminal") return nineHoldAndComplete(supabase, a, "nine_needs_person");
    await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "auto_closed" });
    return { outcome: "auto_closed", reason: `routing_v2:backfill_sort_only:${dispo}` };
  }
  await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: ROUTING_V2_BACKFILL_SORT_ONLY_RECORDED });
  return { outcome: "skipped", reason: ROUTING_V2_BACKFILL_SORT_ONLY_RECORDED };
}

/** The owner alert (not a hold reason) a sort-only price text raises: the existing "Named a price". */
const SORT_ONLY_PRICE_ALERT = "named_price" as const;

/**
 * Sort-only (Astra review 2b-5): a hot road with no alert of its own (price check "too high":
 * reply only) gets the existing "Named a price" owner alert IN ITS STORED ACTION, before the
 * decision is recorded, so the recorded evidence and the queued alert agree (the database
 * validator compares them). Builder's reading of "alert hot roads", pending Jarrad; flagged in
 * the backfill report. Any other action is returned unchanged.
 */
export function withSortOnlyPriceAlert<T extends { road: string; steps: readonly V2Step[] } | null | undefined>(action: T): T {
  if (!action || action.road !== "price_check" || action.steps.some((s) => s.kind === "alert")) return action;
  return { ...action, steps: [...action.steps, { kind: "alert", reason: SORT_ONLY_PRICE_ALERT }] } as T;
}

/** Sort-only on a road with nothing to sort (reply / drip only): decision recorded, nothing else. */
export const ROUTING_V2_BACKFILL_SORT_ONLY_RECORDED = "routing_v2:backfill_sort_only:recorded";

/** The seller's number for a phone-level action: the inbound's own from address. */
async function routingV2InboundPhone(supabase: SupabaseClient<Database>, input: AiDispatchInput): Promise<string | null> {
  if (input.inboundFromPhone) return input.inboundFromPhone;
  if (!input.inboundMessageId) return null;
  const { data } = await supabase.from("messages").select("from_address").eq("id", input.inboundMessageId).maybeSingle();
  return data?.from_address ?? null;
}

/**
 * Cutover (c), PR-I: a stop / legal / hostile road. With model_stop_suppression on (and every
 * property on the phone eligible) a confident Jev stop writes the distinct `model_stop`
 * suppression and nothing is sent. Every other answer is today's human-review path: hostile
 * wording waits for a person's confirmation, anything else holds as a stop request.
 */
async function routeRoutingV2Stop(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  flags: RoutingV2Flags,
  evidence: StoredLiveEvidence,
  holdWithAlerts: (reason: "nine_asked_stop" | "nine_needs_person") => Promise<AiDispatchOutcome>,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const { input, claim, runCtx } = a;
  const decision = storedV2Decision(evidence);
  const phone = await routingV2InboundPhone(supabase, input);
  const outcome = decision && phone
    ? await executeV2Stop(supabase, {
        orgId: evidence.org_id,
        propertyId: input.propertyId,
        contactId: input.contactId,
        inboundMessageId: input.inboundMessageId!,
        phone,
        decision,
        final: storedFinalDecision(evidence),
      }, { readFlags: async () => flags })
    : MODEL_STOP_NO_PHONE;
  await trace(supabase, {
    kind: "action",
    name: "routing_v2_stop",
    result: outcome.kind === "suppressed" ? "applied" : "skipped",
    detail: { engine: "routing_v2", outcome: outcome.kind, ...("reason" in outcome ? { reason: outcome.reason } : {}) },
  }, runCtx);
  if (outcome.kind === "suppressed") {
    await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "opted_out" });
    return { outcome: "opted_out", reason: "routing_v2:model_stop" };
  }
  if (isHostileInbound(input.inboundBody)) return holdHostileForConfirm(supabase, input, claim, runCtx);
  return holdWithAlerts(outcome.kind === "not_stop" ? "nine_needs_person" : "nine_asked_stop");
}

/**
 * Cutover (c), PR-G: wrong person / sold / tenant, and the "no SMS capabilities" bounce.
 * Scope comes ONLY from the existing live text match (classifyWrongNumberScope). With
 * wrong_number_all on and scope "all" (or a bounce), the phone-wide action runs: one atomic
 * close of every property on the phone, then the approved wrong-number reply keyed by its
 * durable send id. Anything it does not take (flag off, scope this property, not applicable)
 * is today's nine-question route: approved reply + close this property only.
 */
async function routeRoutingV2PhoneAction(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  flags: RoutingV2Flags,
  evidence: StoredLiveEvidence,
  kind: "wrong_number" | "bad_number",
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const { input, property, claim, runCtx, templateCtx } = a;
  const decision = storedV2Decision(evidence);
  const phone = await routingV2InboundPhone(supabase, input);
  const wrongScope = kind === "wrong_number" ? classifyWrongNumberScope(input.inboundBody) : null;
  if (decision && phone) {
    const result = await runRoutingV2PhoneAction(supabase, {
      orgId: evidence.org_id,
      inboundMessageId: input.inboundMessageId!,
      fromPhone: phone,
      decision,
      wrongScope,
      final: storedFinalDecision(evidence),
      expectedRevision: evidence.expected_revision,
    }, {
      sendWrongNumberReply: routingV2WrongNumberReplySender(supabase, {
        orgId: property.org_id, input, turn: (templateCtx?.currentTurn ?? 0) + 1, runCtx,
      }),
    });
    await trace(supabase, {
      kind: "action",
      name: "routing_v2_phone_action",
      result: result.outcome === "applied" || result.outcome === "replayed" ? "applied" : "skipped",
      detail: { engine: "routing_v2", kind, outcome: result.outcome, ...("reason" in result ? { reason: result.reason } : {}) },
    }, runCtx);
    if (result.outcome === "applied" || result.outcome === "replayed") {
      // Closed phone-wide. A reply that failed / is unknown is recorded on the action for the
      // settler and the audit; the properties stay closed, as today's wrong-number path does.
      await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "auto_closed" });
      return { outcome: "auto_closed", reason: `routing_v2:${evidence.road}` };
    }
    if (result.outcome === "superseded") {
      await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "skipped", errorMessage: "routing_v2:superseded" });
      return { outcome: "skipped", reason: "superseded_by_newer_inbound" };
    }
    if (result.outcome === "suppressed") {
      await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "skipped", errorMessage: "routing_v2:phone_suppressed" });
      return { outcome: "skipped", reason: "routing_v2:phone_suppressed" };
    }
    if (result.outcome === "not_settled") {
      // Under 30 s old: re-dispatch the same inbound shortly (bounded like every reply retry);
      // the stored decision is reused, never a new classification's effects.
      const attempt = input.retryAttempt ?? 0;
      if (attempt >= REPLY_RETRY_MAX) return nineHoldAndComplete(supabase, a, "nine_needs_person");
      const errorMessage = "routing_v2_phone_action:not_settled";
      let released = await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "skipped", errorMessage, releaseLease: true });
      if (!released) released = await expireAiResponseClaimLease(supabase, { claimId: claim.claimId, errorMessage });
      if (!released) return nineHoldAndComplete(supabase, a, "nine_needs_person");
      return { outcome: "retry", reason: "reply_pending", attempt: attempt + 1, delaySeconds: Math.max(result.retryAfterSeconds, REPLY_RETRY_DELAY_SECONDS) };
    }
    if (result.outcome === "apply_failed") return nineHoldAndComplete(supabase, a, "nine_needs_person");
    // flag_off / not_applicable: today's route below.
  }
  if (kind === "bad_number" || !v2SliceAllowed(flags, "replies", input.propertyId)) {
    return nineHoldAndComplete(supabase, a, "nine_needs_person");
  }
  const chosen = evidence.provenance && evidence.provenance.by === "jev" ? evidence.provenance.probability : null;
  const closedHere = await closeNineWrongPersonThisProperty(supabase, a, {
    evaluationRevision: evidence.expected_revision,
    classificationRunId: null,
    chosenProbability: chosen,
  });
  // H1(i): today's this-property close leaves drips paused (setResponderDispo). On the v2 path
  // every reply ends the current drip, so the property's v2 drip (paused by the webhook) is
  // retired too; otherwise it sits paused on a closed lead nobody owns. Legacy drips: unchanged.
  if (closedHere.outcome === "auto_closed") {
    await retireV2DripsForProperty(supabase, input.propertyId, input.inboundMessageId ?? null);
  }
  return closedHere;
}

/** End every active or paused v2 enrollment on the property (ended_reason rerouted). Best effort. */
export async function retireV2DripsForProperty(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  inboundMessageId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await (supabase as unknown as {
    from: (t: string) => { update: (v: Record<string, unknown>) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { in: (k: string, v: string[]) => PromiseLike<{ error: { message: string } | null }> } } } };
  }).from("sequence_enrollments")
    .update({ status: "completed", completed_at: now, next_run_at: null, updated_at: now, ended_reason: "rerouted", retired_by_inbound_id: inboundMessageId })
    .eq("property_id", propertyId).eq("routing_v2_engine", "v2").in("status", ["active", "paused"]);
  if (error) reportError(new Error(error.message), { tags: { surface: "routing_v2_wrong_number_retire" }, extra: { propertyId } });
}

/**
 * The PR-G wrong-number reply transport: the approved wrong-number template only (exact
 * body), recipient window first, then the normal responder send with the action's durable
 * send id as the provider idempotency key and PR-G's stillAllowed inside the provider fence.
 */
function routingV2WrongNumberReplySender(
  supabase: SupabaseClient<Database>,
  ctx: { orgId: string; input: AiDispatchInput; turn: number; runCtx?: MaybeRunContext },
): SendWrongNumberReply {
  return async ({ requiredBody, sendId, stillAllowed }) => {
    const resolved = await resolveApprovedTemplateReply(supabase, {
      orgId: ctx.orgId, propertyId: ctx.input.propertyId, contactId: ctx.input.contactId,
      outcome: "wrong_number", outcomeConfidence: null, escalationReason: "not_applicable", decidedBy: "nine_questions",
    });
    if (resolved.kind !== "template" || resolved.body !== requiredBody) {
      return { sent: false, reason: resolved.kind === "none" ? resolved.reason : NINE_REPLY_TEXT_NOT_APPROVED, reachedProvider: false };
    }
    const window = await evaluateRecipientWindow(supabase, ctx.input);
    if (!window.ok) return { sent: false, reason: V2_OUTBOX_REASON.quietHours(window.why), reachedProvider: false };
    const { data: config } = await supabase.from("ai_responder_configs").select("model, outbound_mode")
      .eq("org_id", ctx.orgId).eq("active", true).maybeSingle();
    if (!config) return { sent: false, reason: V2_OUTBOX_REASON.configUnreadable, reachedProvider: false };
    const sent = await sendResponderMessage(supabase, {
      runContext: ctx.runCtx,
      input: ctx.input,
      body: resolved.body,
      model: config.model,
      confidence: 1,
      sentiment: "neutral",
      turn: ctx.turn,
      source: "approved_template",
      templateId: resolved.templateId,
      templateSource: resolved.source ?? resolved.body,
      replyKey: "wrong_number",
      orgId: ctx.orgId,
      claimStartedAt: null,
      outboundMode: config.outbound_mode,
      replyKind: "send_reply",
      windowDeferrable: true,
      providerIdempotencyKey: sendId,
      routingV2SendAllowed: stillAllowed,
    });
    if (sent.outcome === "sent") return { sent: true, outboundMessageId: sent.messageId };
    return { sent: false, reason: sent.reason, reachedProvider: sent.outcome !== "retry" && sent.reason.startsWith("send_timeout") };
  };
}

/**
 * Cutover (d): PR-G settler. Finishes phone-action replies a crash left pending / sending
 * (at most once; a `sending` row is only settled by its send id, never re-sent). Each row's
 * transport is built from the action's own source inbound.
 */
export async function settleRoutingV2PhoneRepliesForCron(supabase: SupabaseClient<Database>) {
  return settleUnsettledRoutingV2PhoneReplies(supabase, async (actionId) => {
    const { data: action } = await (supabase as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => PromiseLike<{ data: { org_id: string; source_inbound_message_id: string } | null }> } } } })
      .from("routing_v2_phone_actions").select("org_id, source_inbound_message_id").eq("id", actionId).maybeSingle();
    if (!action) throw new Error("routing v2 phone action not found");
    const { data: msg } = await supabase.from("messages")
      .select("property_id, contact_id, conversation_id, from_address, to_address, body")
      .eq("id", action.source_inbound_message_id).maybeSingle();
    if (!msg?.property_id || !msg.contact_id) throw new Error("routing v2 phone action source unreadable");
    const input: AiDispatchInput = {
      propertyId: msg.property_id, contactId: msg.contact_id, conversationId: msg.conversation_id ?? null,
      inboundFromPhone: msg.from_address ?? null, inboundToPhone: msg.to_address ?? null,
      inboundBody: msg.body ?? "", inboundMessageId: action.source_inbound_message_id,
    };
    return { sendWrongNumberReply: routingV2WrongNumberReplySender(supabase, { orgId: action.org_id, input, turn: 1 }) };
  });
}

/**
 * PR-E value lookup for the price check (only called while price_check is on). No API key
 * configured = no value (the approved fair-price reply + alert path). Ledger hooks are
 * always passed, so every HTTP attempt is accounted before it is sent.
 */
async function routingV2PropertyValue(
  supabase: SupabaseClient<Database>,
  orgId: string,
  propertyId: string,
): Promise<ValueLookupResult> {
  const apiKey = process.env.DEALMACHINE_API_KEY ?? "";
  if (!apiKey) return DEALMACHINE_NO_KEY;
  const { data } = await supabase.from("properties").select("address, city, state, zip").eq("id", propertyId).maybeSingle();
  const row = data as { address?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null;
  return lookupDealMachineValue(
    { orgId, propertyId, address: row ? { street: row.address ?? "", city: row.city ?? "", state: row.state ?? "", zip: row.zip ?? null } : null },
    {
      store: supabaseDealMachineCacheStore(supabase),
      callProvider: (address, hooks) => fetchDealMachineEstimatedValue(address, { apiKey, ...hooks }),
    },
  );
}

/** The DB-clock age check could not be read: wait (no claim), never send (a wait, not a hold). */
const V2_OUTBOX_EXPIRY_UNREADABLE = "expiry_unreadable";

/** A queued v2 reply older than this is never sent late; a person looks instead. */
export const ROUTING_V2_REPLY_MAX_AGE_MS = 24 * 3600_000;

type RoutingV2OutboxRow = {
  id: string; org_id: string; property_id: string; inbound_message_id: string;
  kind: "reply" | "alert"; payload: Record<string, unknown>; created_at: string;
  /** §5.4 taint inherited from the lead at insert (20261031131100). */
  test_run_id?: string | null;
};
type LooseRpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

/**
 * Routing v2 cutover (b): deliver ONE queued seller reply, at most once.
 * claim -> authorize (sets authorized_at once) -> sendResponderMessage, whose provider fence
 * calls routing_v2_check_authorized_outbox_send and whose provider submission is keyed by the
 * outbox id -> mark sent with the outbound message id as the receipt. A timeout / unknown
 * outcome is recorded and NEVER retried (reconcile settles it from the keyed message row).
 * Quiet hours / the Florida cap wait BEFORE any claim. Replies only: alerts go through the
 * hold-alert fan-out (routing_v2_alert_delivery_gate).
 */
export async function deliverRoutingV2OutboxReply(
  supabase: SupabaseClient<Database>,
  row: RoutingV2OutboxRow,
  now: () => number = Date.now,
): Promise<V2OutboxResult> {
  const db = supabase as unknown as LooseRpc;
  const rpcText = async (fn: string, args: Record<string, unknown>): Promise<string> => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return typeof data === "string" ? data : "unexpected_result";
  };
  // A-2 F2: a reply the seller did not get is a hold about our own reply (mechanics): written
  // only if no newer seller text exists; the newer text is routed by itself.
  // Astra review of a0c905d42390 (P1 #2): the result is never discarded. A hold that cannot be
  // written leaves the row's hold_pending set (the cron retries it; the drip check keeps the drip
  // waiting meanwhile) and pauses this property's v2 drips now (fail closed).
  const holdFor = async (why: string): Promise<boolean> => {
    const r = await writeV2Hold(supabase, row.property_id, row.inbound_message_id, `nine_reply_not_sent:${why}`, "mechanics");
    if (r === "error") {
      await pauseV2DripsFailClosed(supabase, row.property_id);
      return false;
    }
    const { error } = await (supabase as unknown as LooseRpc).rpc("routing_v2_mark_outbox_hold_written", { p_outbox_id: row.id });
    if (error && !/PGRST202|42883|does not exist|Could not find/i.test(error.message)) {
      reportError(new Error(error.message), { tags: { surface: "routing_v2_outbox_hold_written" }, extra: { outboxId: row.id } });
    }
    return true;
  };
  const intent: V2OutboxIntent = {
    id: row.id, orgId: row.org_id, propertyId: row.property_id, inboundMessageId: row.inbound_message_id,
    kind: row.kind, payload: row.payload,
  };
  if (row.kind !== "reply") return { kind: "skipped", reason: V2_OUTBOX_REASON.notAReply };
  const result = await deliverRoutingV2OutboxIntent(intent, row, supabase, rpcText, holdFor, now);
  // §13.3: a reply cancelled because its slice was switched off goes back to the human queue.
  if (result.kind === "skipped" && result.reason === "flag_off") {
    await holdWithRetry(supabase, row.property_id, "needs_reply");
  }
  return result;
}

async function deliverRoutingV2OutboxIntent(
  intent: V2OutboxIntent,
  row: RoutingV2OutboxRow,
  supabase: SupabaseClient<Database>,
  rpcText: (fn: string, args: Record<string, unknown>) => Promise<string>,
  holdFor: (why: string) => Promise<boolean>,
  now: () => number,
): Promise<V2OutboxResult> {
  return deliverV2Outbox(intent, {
    async prepare() {
      // Astra review of a0c905d42390 (P2 #3): the age is decided on the DB clock (the final fence
      // enforces it too). Only a database without the function falls back to the app clock.
      const { data: expiredData, error: expiredError } = await (supabase as unknown as LooseRpc).rpc("routing_v2_outbox_expired", { p_outbox_id: row.id });
      const expired = expiredError
        ? (/PGRST202|42883|does not exist|Could not find/i.test(expiredError.message) ? now() - Date.parse(row.created_at) > ROUTING_V2_REPLY_MAX_AGE_MS : null)
        : expiredData === true;
      if (expired === null) {
        // Review N-2: a persistent error would stall replies quietly; report it (the drip stays
        // blocked by reply_pending meanwhile, so this fails safe).
        reportError(new Error(expiredError?.message ?? "routing_v2_outbox_expired unreadable"), {
          tags: { surface: "routing_v2_outbox_expiry" }, extra: { outboxId: row.id },
        });
        return { kind: "wait", reason: V2_OUTBOX_EXPIRY_UNREADABLE };
      }
      if (expired) return { kind: "refused", reason: V2_OUTBOX_REASON.expired };
      const key = row.payload.key;
      if (typeof key !== "string") return { kind: "refused", reason: V2_OUTBOX_REASON.malformedIntent };
      const { data: msg } = await supabase
        .from("messages")
        .select("contact_id, conversation_id, from_address, to_address, body")
        .eq("id", row.inbound_message_id)
        .maybeSingle();
      if (!msg?.contact_id) return { kind: "refused", reason: V2_OUTBOX_REASON.inboundUnreadable };
      const input: AiDispatchInput = {
        propertyId: row.property_id,
        contactId: msg.contact_id,
        conversationId: msg.conversation_id ?? null,
        inboundFromPhone: msg.from_address ?? null,
        inboundToPhone: msg.to_address ?? null,
        inboundBody: msg.body ?? "",
        inboundMessageId: row.inbound_message_id,
      };
      // H1(iii): never an auto reply to a lead held for a person (a burst text may have held it
      // after this reply was queued). Refused = cancelled; the hold already exists.
      const { data: heldRow } = await supabase.from("properties").select("needs_human_attention").eq("id", row.property_id).maybeSingle();
      if (heldRow?.needs_human_attention === true) return { kind: "refused", reason: V2_OUTBOX_REASON.heldForPerson };
      const reply = await resolveV2Reply(supabase, { orgId: row.org_id, propertyId: row.property_id, contactId: msg.contact_id, key: key as V2AnyReplyKey });
      if (reply.kind !== "ready") return { kind: "refused", reason: reply.reason };
      const repeat = await templateAlreadySentToProperty(supabase, row.org_id, row.property_id, reply.templateId, reply.body);
      if (repeat !== "no") return { kind: "refused", reason: repeat === "error" ? `${TEMPLATE_ALREADY_SENT}:lookup_failed` : TEMPLATE_ALREADY_SENT };
      const window = await evaluateRecipientWindow(supabase, input);
      if (!window.ok) return { kind: "wait", reason: V2_OUTBOX_REASON.quietHours(window.why) };
      // A-2 C2: the property's own business-hours window too (the same check the send makes),
      // so a closed window waits before any claim instead of being refused and held. An unknown
      // state is not a window to wait for: it goes on to the send, which refuses it; that
      // refusal comes back as NINE_WINDOW_UNKNOWN_STATE (not a C1 no-op), so the lead is held.
      const { data: propState } = await supabase.from("properties").select("state").eq("id", row.property_id).maybeSingle();
      const propertyWindow = checkQuietHours((propState as { state?: string | null } | null)?.state ?? null);
      if (!propertyWindow.ok && propertyWindow.reason !== "unknown_state") {
        return { kind: "wait", reason: V2_OUTBOX_REASON.propertyWindow(propertyWindow.reason) };
      }
      const { data: config } = await supabase
        .from("ai_responder_configs")
        .select("model, outbound_mode")
        .eq("org_id", row.org_id)
        .eq("active", true)
        .maybeSingle();
      if (!config) return { kind: "refused", reason: V2_OUTBOX_REASON.configUnreadable };
      const turns = await countAiTurnsInThread(supabase, row.property_id, msg.contact_id, msg.conversation_id ?? null);
      return {
        kind: "ready",
        async send() {
          const sent = await sendResponderMessage(supabase, {
            routingV2OutboxId: row.id,
            ...(row.test_run_id ? { testRunId: row.test_run_id } : {}),
            input,
            body: reply.body,
            model: config.model,
            confidence: 1,
            sentiment: "neutral",
            turn: (turns ?? 0) + 1,
            orgId: row.org_id,
            claimStartedAt: null,
            outboundMode: config.outbound_mode,
            windowDeferrable: true,
            ...(reply.fixed
              // The fixed approved texts (identity, the three hot replies): same guards as today.
              ? { source: "llm" as const, approvedFixedText: true, replyKind: key === "identity" ? "identity" as const : "nine_hot_reply" as const }
              : { source: "approved_template" as const, templateId: reply.templateId, templateSource: reply.source, replyKey: key, replyKind: "send_reply" as const }),
          });
          if (sent.outcome === "sent") return { kind: "accepted", receiptId: sent.messageId };
          if (sent.outcome !== "retry" && sent.reason.startsWith("send_timeout")) return { kind: "unknown", reason: sent.reason };
          return { kind: "not_sent", reason: sent.reason };
        },
      };
    },
    claim: (id) => rpcText("routing_v2_claim_outbox", { p_outbox_id: id }),
    authorize: (id) => rpcText("routing_v2_authorize_outbox_send", { p_outbox_id: id }),
    async accepted(i, receiptId) {
      const r = await rpcText("routing_v2_mark_outbox_sent", { p_outbox_id: i.id, p_receipt: receiptId });
      if (r !== "ok") throw new Error(`routing_v2_mark_outbox_sent: ${r}`);
    },
    async reconcile(i, reason) {
      await rpcText("routing_v2_mark_outbox_unknown", { p_outbox_id: i.id, p_reason: reason });
    },
    async notSent(i, reason) {
      const marked = await rpcText("routing_v2_mark_outbox_not_sent", { p_outbox_id: i.id, p_reason: reason });
      // The seller did not get the reply: a person looks (today's nine-question hold family).
      // Only when THIS call cancelled the row: a row another consumer already sent, or the
      // provider fence already cancelled (superseded / takeover), never gets a false hold.
      // Stress A-2 (round 2): a reply overtaken by a newer seller text whose own dispatch is still
      // pending / scheduled (or already handled it) is not a failure; that dispatch routes it, and
      // a hold here would make it exit already_terminal. A newer text whose handler ended without
      // handling it, or never started (webhook died after the insert), still holds (review M-1).
      // Astra review of a0c905d42390 (P1 #2): the cancel itself decided the handoff, atomically:
      // "ok_no_hold" = overtaken by a newer text (A-2 F1) or a mechanics no-op while this inbound's
      // drip runs (A-2 C1); "ok" = cancelled with hold_pending (the drip waits until the hold lands).
      if (marked === "ok_no_hold") return;
      if (marked !== "ok") return;
      // A database still on the 330000 body returns plain "ok" for every cancel: keep its checks.
      if (isV2SupersededReason(reason)) return;
      await testBarrier("outbox:before_hold", { propertyId: row.property_id, inboundMessageId: row.inbound_message_id });
      if (isV2MechanicsNoOpReason(reason) && (await v2DripActiveForInbound(supabase, row))) return;
      await holdFor(reason.replace(/\s+/g, "_"));
    },
  });
}

/** The database clock (routing_v2_db_now); this server's clock only if it cannot be read. */
async function dbNowMs(supabase: SupabaseClient<Database>): Promise<number> {
  try {
    const { data, error } = await (supabase as unknown as LooseRpc).rpc("routing_v2_db_now", {});
    const ms = !error && typeof data === "string" ? Date.parse(data) : Number.NaN;
    return Number.isNaN(ms) ? Date.now() : ms;
  } catch {
    return Date.now();
  }
}

/** Fail closed: every active v2 drip of the property is paused for a person (best effort, reported). */
async function pauseV2DripsFailClosed(supabase: SupabaseClient<Database>, propertyId: string): Promise<void> {
  const { error } = await (supabase as unknown as {
    from: (t: string) => { update: (v: Record<string, unknown>) => { eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => PromiseLike<{ error: { message: string } | null }> } } } };
  }).from("sequence_enrollments")
    .update({ status: "paused", pause_reason: "held_for_person", updated_at: new Date().toISOString() })
    .eq("property_id", propertyId).eq("routing_v2_engine", "v2").eq("status", "active");
  if (error) reportError(new Error(error.message), { tags: { surface: "routing_v2_fail_closed_pause" }, extra: { propertyId } });
}

/** A queued v2 reply cancelled because something newer overtook it (the send gate's reasons). */
export function isV2SupersededReason(reason: string): boolean {
  return /^(superseded_before_send|superseded_by_newer_inbound)$/.test(reason);
}

/** A-2 C3: rule 3 fired ONLY because of our own older auto reply (no person's text involved). */
export function isOwnOlderAutoReplyOnly(decision: SendGateDecision): boolean {
  if (decision.action !== "skip" || decision.rule !== 3) return false;
  const triggers = decision.triggers ?? [];
  return triggers.length > 0 && triggers.every((t) => t === "ai_other_inbound");
}

/** Outbox send outcomes that are mechanics, not a person case, when the road's drip is running. */
export function isV2MechanicsNoOpReason(reason: string): boolean {
  return reason === TEMPLATE_ALREADY_SENT
    || reason === NINE_WINDOW_CLOSED
    || reason === NINE_WINDOW_CLOSED_AT_FENCE
    || reason === V2_OLDER_AUTO_REPLY_SENT;
}

/** Is the v2 drip this reply's inbound enrolled still active? A lookup error = no (hold). */
async function v2DripActiveForInbound(supabase: SupabaseClient<Database>, row: RoutingV2OutboxRow): Promise<boolean> {
  const { data, error } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> } } } } };
  }).from("sequence_enrollments").select("id")
    .eq("property_id", row.property_id).eq("routing_v2_inbound_id", row.inbound_message_id).eq("status", "active")
    .limit(1);
  return !error && (data ?? []).length > 0;
}

/**
 * A safety hold through routing_v2_write_hold (reviews B-1 / B-1'): holds an unheld lead, upgrades
 * a mechanics hold to safety (never the reverse), leaves any other hold as it is. "unavailable" =
 * the function is not deployed; "error" = any other failure (reported; callers retry / fail).
 */
export async function writeSafetyHold(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  inboundMessageId: string | null,
  reason: string,
): Promise<"held" | "upgraded" | "already_held" | "missing" | "unavailable" | "error"> {
  const db = supabase as unknown as LooseRpc;
  let data: unknown;
  let error: { message: string } | null;
  try {
    ({ data, error } = await db.rpc("routing_v2_write_hold", {
      p_property_id: propertyId, p_inbound_message_id: inboundMessageId, p_reason: reason, p_kind: "safety",
    }));
  } catch {
    // supabase-js returns errors rather than throwing; a client without rpc (older test
    // doubles) is treated like a missing function: the caller proves the flag by reading it.
    return "unavailable";
  }
  if (error) {
    if (/PGRST202|42883|does not exist|Could not find/i.test(error.message)) return "unavailable";
    reportError(new Error(error.message), { tags: { surface: "ai_responder_safety_hold" }, extra: { propertyId, reason } });
    return "error";
  }
  if (data === "held" || data === "upgraded" || data === "already_held") return data;
  reportError(new Error(`safety hold not written: ${String(data)}`), { tags: { surface: "ai_responder_safety_hold" }, extra: { propertyId, reason } });
  return "missing";
}

/**
 * The one writer of v2 holds (routing_v2_write_hold, 20261031131600), with bounded retries.
 * 'mechanics' = our own reply could not go out: written only if no newer seller text exists
 * ('superseded'); 'safety' = the seller's words / a person: always written. Returns 'error' when
 * the hold could not be written.
 */
export async function writeV2Hold(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  inboundMessageId: string,
  reason: string,
  kind: "mechanics" | "safety",
): Promise<"held" | "already_held" | "upgraded" | "superseded" | "missing" | "error"> {
  const db = supabase as unknown as LooseRpc;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await db.rpc("routing_v2_write_hold", {
      p_property_id: propertyId, p_inbound_message_id: inboundMessageId, p_reason: reason, p_kind: kind,
    });
    if (!error && typeof data === "string") return data as "held" | "already_held" | "upgraded" | "superseded" | "missing";
    if (attempt === 2) {
      reportError(new Error(error?.message ?? "routing_v2_write_hold: unexpected result"), {
        tags: { surface: "routing_v2_write_hold" }, extra: { propertyId, inboundMessageId, reason, kind },
      });
    }
  }
  return "error";
}

/** Routing v2 cutover (b)/(d): the outbox consumer (cron + an immediate kick after a transition). */
/** A hold that has failed this many times is reported on every further failure. */
export const ROUTING_V2_HOLD_REPORT_AFTER = 5;

/** A queued reply the seller did not get: today's hold reason family, no whitespace. */
export function routingV2OutboxHoldReason(cancelReason: string): string {
  if (cancelReason.startsWith("unknown:")) return "nine_reply_not_sent:send_outcome_unknown";
  const tail = cancelReason.replace(/^not_sent:/, "").replace(/\s+/g, "_");
  return `nine_reply_not_sent:${tail || "not_sent"}`;
}

/**
 * A-2 lease death (review of 30d35369b, N-1): a newer text that is saved but never stamped is
 * treated as "still inside its webhook" for WEBHOOK_PROCESSING_LEASE_MS, so an older reply is
 * cancelled without a hold. If that webhook then dies, nothing else picks the text up (a
 * redelivery inside the lease is acknowledged as a skip). This sweep, run by the outbox cron,
 * holds a person for a v2-live lead whose inbound SMS is older than the lease and still has no
 * responder stamp, no claim, no keyword exit and no v2 decision / audit row.
 * - Every text it examines is marked (processing.routingV2Sweep), so the next pass never picks it
 *   again: handled or not-v2 texts cannot pile up in front of a new dead one (review N-1). The
 *   mark is written only while the text still has no responder stamp, so it never overwrites a
 *   stamp being written at the same moment.
 * - "v2-live" is read from the flags at SWEEP time, not at the text's arrival (review N-2): a
 *   text that arrived just before the slice was switched on is also swept. Fail-safe: the worst
 *   case is a person looks at it.
 * - It stops when `shouldStop` says the cron is out of time (the rest wait for the next pass).
 */
export async function sweepUnstampedV2Inbounds(
  supabase: SupabaseClient<Database>,
  _nowMs: number = Date.now(),
  shouldStop: () => boolean = () => false,
  propertyId?: string,
): Promise<number> {
  // A-2 F3: candidates come from SQL, aged on the DB clock (never the app clock): an inbound SMS
  // with no stamp past the webhook lease, a 'delayed' stamp whose workflow never ran (scheduled
  // time past by the lease), or a claim still 'processing' long after its lease expired; none
  // with a v2 decision / audit row, a keyword exit, or a previous sweep mark.
  const db = supabase as unknown as LooseRpc;
  const { data, error } = await db.rpc("routing_v2_sweep_candidates", {
    p_lease_seconds: Math.round(WEBHOOK_PROCESSING_LEASE_MS / 1000), p_limit: 50,
    ...(propertyId ? { p_property_id: propertyId } : {}),
  });
  if (error) {
    if (!/PGRST202|42883|does not exist|Could not find/i.test(error.message)) {
      reportError(new Error(error.message), { tags: { surface: "routing_v2_unstamped_sweep" } });
    }
    return 0;
  }
  let held = 0;
  for (const m of (data ?? []) as Array<{ id: string; org_id: string; property_id: string; conversation_id: string | null; why: string; created_at?: string }>) {
    if (shouldStop()) break;
    // Astra review of b6a00a0a2f17 (B): an unrecovered safety obligation never ages out; one still
    // open after a day is reported (and stays a candidate until its hold lands).
    if ((m.why === "decision_unrecovered" || m.why === "safety_hold_failed") && m.created_at
        && Date.parse(m.created_at) < (await dbNowMs(supabase)) - 24 * 3600_000) {
      reportError(new Error("routing v2: a safety obligation is still unrecovered after 24 h"), {
        tags: { surface: "routing_v2_unstamped_sweep" }, extra: { messageId: m.id, propertyId: m.property_id, why: m.why },
      });
    }
    // Review B2: an unreadable v2 state is NOT "not v2". The text is left unmarked for the next
    // pass (a flaky database must never let a dead v2 text escape).
    const live = await routingV2LiveForSweep(supabase, m.org_id, m.property_id);
    if (live === "error") {
      reportError(new Error("routing v2 sweep: v2-live state unreadable; left for the next pass"), {
        tags: { surface: "routing_v2_unstamped_sweep" }, extra: { messageId: m.id, propertyId: m.property_id },
      });
      continue;
    }
    let result: "not_v2" | "held";
    if (live === "no") result = "not_v2";
    else {
      // A dead newest text is a person case about the seller's text (safety): always written.
      // Not marked "held" unless the hold is really there.
      const hold = await writeV2Hold(supabase, m.property_id, m.id, "nine_needs_person", "safety");
      if (hold === "error") {
        // Review N-1: the hold could not be written: fail closed now (the v2 drips paused); the
        // text stays unmarked, so the next pass re-attempts the hold.
        await pauseV2DripsFailClosed(supabase, m.property_id);
        continue;
      }
      if (hold === "missing") continue;
      await recordRoutingV2Audit(supabase, {
        orgId: m.org_id, propertyId: m.property_id, inboundMessageId: m.id, conversationId: m.conversation_id,
        note: `webhook_lease_expired_${m.why}`,
      }, (e) => reportError(e, { tags: { surface: "routing_v2_unstamped_sweep" } }));
      held++;
      result = "held";
    }
    // Server-side mark (jsonb_set): only on a text with no completed responder stamp.
    const { error: markError } = await db.rpc("routing_v2_mark_inbound_swept", { p_message_id: m.id, p_result: result });
    if (markError) reportError(new Error(markError.message), { tags: { surface: "routing_v2_unstamped_sweep_mark" }, extra: { messageId: m.id } });
  }
  return held;
}

/**
 * Is this lead on the routing v2 live path? (The early gate's single strict read and the sweep.)
 * Every read is error-checked: an unreadable flag row, config or
 * engine is "error", so the caller retries instead of deciding (review B2).
 */
export async function routingV2LiveForSweep(
  supabase: SupabaseClient<Database>,
  orgId: string,
  propertyId: string,
): Promise<"yes" | "no" | "error"> {
  try {
    const flags = await readRoutingV2FlagsResult(supabase, orgId);
    if (!flags.ok) return "error";
    if (!flags.flags.questions_live || !isV2Eligible(flags.flags, propertyId)) return "no";
    const { data: config, error } = await supabase.from("ai_responder_configs")
      .select("classifier_provider, classifier_mode").eq("org_id", orgId).eq("active", true).maybeSingle();
    if (error) return "error";
    if (config?.classifier_provider !== "jev" || config.classifier_mode !== "automatic") return "no";
    const engine = await readClassifierEngine(supabase, orgId);
    if (engine === "unreadable") return "error";
    return engine === "nine_questions" ? "yes" : "no";
  } catch {
    return "error";
  }
}

export async function runRoutingV2OutboxReplies(
  supabase: SupabaseClient<Database>,
  opts: { propertyId?: string; limit?: number; budgetMs?: number; now?: () => number } = {},
): Promise<{ released: number; reconciled: unknown; held: number; results: Array<{ id: string; result: V2OutboxResult | { kind: "error" } }> }> {
  const db = supabase as unknown as LooseRpc;
  const now = opts.now ?? Date.now;
  const started = now();
  let released = 0;
  let reconciled: unknown = null;
  let held = 0;
  if (!opts.propertyId) {
    const rel = await db.rpc("routing_v2_release_stale_outbox_claims", { p_older_than_seconds: 300 });
    if (rel.error) reportError(new Error(rel.error.message), { tags: { surface: "routing_v2_outbox_release" } });
    else released = typeof rel.data === "number" ? rel.data : 0;
    const rec = await db.rpc("routing_v2_reconcile_outbox", { p_older_than_seconds: 180, p_unknown_hold_minutes: 30 });
    if (rec.error) reportError(new Error(rec.error.message), { tags: { surface: "routing_v2_outbox_reconcile" } });
    else reconciled = rec.data;
    // Replies the seller did not get (never submitted, provider failed, outcome unknown too
    // long): write today's hold, then clear the marker. A crash between the two re-holds.
    // A newer text whose webhook died inside its lease (A-2): a person looks.
    // Respects the cron's time budget (review item 4): no new text is examined past it.
    const outOfTime = () => opts.budgetMs !== undefined && now() - started > opts.budgetMs;
    held += await sweepUnstampedV2Inbounds(supabase, now(), outOfTime).catch((e) => {
      reportError(e, { tags: { surface: "routing_v2_unstamped_sweep" } });
      return 0;
    });
    const due = await db.rpc("routing_v2_outbox_holds_due", { p_limit: 50 });
    if (due.error) reportError(new Error(due.error.message), { tags: { surface: "routing_v2_outbox_holds" } });
    for (const row of ((due.data ?? []) as Array<{ outbox_id: string; property_id: string; reason: string; attempts?: number }>)) {
      // A-2 F2: mechanics hold about this outbox row's own reply (superseded by a newer text = done).
      const { data: boxRow } = await supabase.from("routing_v2_outbox" as never).select("inbound_message_id").eq("id", row.outbox_id).maybeSingle();
      const inboundId = (boxRow as { inbound_message_id?: string } | null)?.inbound_message_id;
      const ok = inboundId
        ? (await writeV2Hold(supabase, row.property_id, inboundId, routingV2OutboxHoldReason(row.reason), "mechanics")) !== "error"
        : await holdWithRetry(supabase, row.property_id, routingV2OutboxHoldReason(row.reason));
      if (!ok) {
        // Stays pending and rotates to the back of the queue (holds_due stamps each attempt).
        // Astra review of a0c905d42390 (P1 #2): a hold that cannot be written never lets the drip go.
        await pauseV2DripsFailClosed(supabase, row.property_id);
        if ((row.attempts ?? 0) >= ROUTING_V2_HOLD_REPORT_AFTER) {
          reportError(new Error("routing v2 outbox hold keeps failing"), {
            tags: { surface: "routing_v2_outbox_holds" },
            extra: { outboxId: row.outbox_id, propertyId: row.property_id, attempts: row.attempts },
          });
        }
        continue;
      }
      const mark = await db.rpc("routing_v2_mark_outbox_hold_written", { p_outbox_id: row.outbox_id });
      if (mark.error) reportError(new Error(mark.error.message), { tags: { surface: "routing_v2_outbox_holds" } });
      else held++;
    }
  }
  if (opts.propertyId) {
    // Astra review of b6a00a0a2f17 (D): recovery never waits for the cron. The per-property
    // delivery (right after a dispatch) first runs this property's sweep step, so an unrecovered
    // safety obligation of an older text is held before anything for the newer one goes out.
    held += await sweepUnstampedV2Inbounds(supabase, Date.now(), () => false, opts.propertyId).catch((e) => {
      reportError(e, { tags: { surface: "routing_v2_unstamped_sweep" }, extra: { propertyId: opts.propertyId } });
      return 0;
    });
  }
  const { data, error } = await db.rpc("routing_v2_due_outbox_replies", {
    p_limit: opts.limit ?? 20,
    p_property_id: opts.propertyId ?? null,
  });
  if (error) {
    // Deployed ahead of the migration, or unreadable: nothing is sent.
    if (!/PGRST202|42883|does not exist|Could not find/i.test(error.message)) {
      reportError(new Error(error.message), { tags: { surface: "routing_v2_outbox_due" } });
    }
    return { released, reconciled, held, results: [] };
  }
  const results: Array<{ id: string; result: V2OutboxResult | { kind: "error" } }> = [];
  for (const row of (data ?? []) as RoutingV2OutboxRow[]) {
    // Time budget: never start a new claim once over it (the cron's own limit is 60 s).
    if (opts.budgetMs !== undefined && now() - started > opts.budgetMs) break;
    try {
      results.push({ id: row.id, result: await deliverRoutingV2OutboxReply(supabase, row) });
    } catch (e) {
      reportError(e, { tags: { surface: "routing_v2_outbox_deliver" }, extra: { outboxId: row.id } });
      results.push({ id: row.id, result: { kind: "error" } });
    }
  }
  return { released, reconciled, held, results };
}

/**
 * Today's nine-question wrong-person route, unchanged: the approved wrong-number reply, then
 * close THIS property only (a person decides anything phone-wide). Shared by the nine engine
 * and the routing v2 live hook (classificationRunId null = no Jev review row to link).
 */
async function closeNineWrongPersonThisProperty(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  d: { evaluationRevision: number; classificationRunId: string | null; chosenProbability: number | null },
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const { input, property, claim, runCtx, templateCtx } = a;
  // Same gates as the eight-answer wrong-number route: the label's automation switch
  // decides whether Sandra may act at all; otherwise a person closes it.
  const thresholds = await loadOrgThresholdMap(supabase, property.org_id);
  if (thresholds.wrong_number?.automationEnabled !== true) {
    return nineHoldAndComplete(supabase, a, "nine_automation_disabled:wrong_number");
  }
  // Close ONLY after the approved reply was accepted by the provider.
  if (!templateCtx) return nineHoldAndComplete(supabase, a, "nine_reply_not_sent:reply_ineligible");
  const wrongStep = await runApprovedTemplateStep(supabase, {
    input,
    property,
    ctx: templateCtx,
    claim,
    outcome: "wrong_number",
    nativeConfidence: d.chosenProbability,
    escalationReason: "not_applicable",
    decidedBy: "nine_questions",
    requiredBody: APPROVED_REPLY_TEXTS.wrong_number,
    runCtx,
  });
  if (wrongStep.kind === "stop") return wrongStep.outcome;
  if (!wrongStep.outboundMessageId || wrongStep.replyKey !== "wrong_number") {
    const why = wrongStep.notSentReason ?? "not_sent";
    return nineHoldAndComplete(supabase, a, why === NINE_REPLY_TEXT_NOT_APPROVED ? why : `nine_reply_not_sent:${why}`);
  }
  const messageId: string | null = wrongStep.outboundMessageId;
  // Our own reply is ONE outbound SMS row, which moves decision_context_revision by
  // exactly one (trg_messages_bump_decision_context_revision). Account for that and
  // nothing else: any further movement (a person texting, a takeover, an assignment)
  // means someone else changed the lead, so a person looks and nothing is closed.
  let closeRevision = d.evaluationRevision;
  if (messageId) {
    const { data: current } = await supabase
      .from("properties")
      .select("decision_context_revision")
      .eq("id", input.propertyId)
      .maybeSingle();
    if (!current) return nineHoldAndComplete(supabase, a, "nine_close_wrong_person_unreadable", messageId);
    const expectedAfterOwnReply = wrongPersonCloseRevision(d.evaluationRevision, current.decision_context_revision);
    if (expectedAfterOwnReply === null) {
      return nineHoldAndComplete(supabase, a, NINE_CLOSE_WRONG_PERSON_CONTEXT_CHANGED, messageId);
    }
    closeRevision = expectedAfterOwnReply;
  }
  const closed = await applyWrongNumber(supabase, {
    runContext: runCtx,
    propertyId: input.propertyId,
    conversationId: input.conversationId ?? null,
    inboundMessageId: input.inboundMessageId ?? null,
    // This property only: phone-wide suppression is a person's call.
    scope: "this_property",
    reason: "nine_questions:wrong_person",
    expectedRevision: closeRevision,
  });
  await traceDisposition(supabase, "wrong_number", closed, false, runCtx);
  // As the eight-answer route does for an applied wrong_number (this property only):
  // link the review to the run that decided it. A failure leaves it pending for a person.
  if (closed.updated && input.inboundMessageId && d.classificationRunId) {
    await maybeAutoAcceptJevReview(supabase, input.inboundMessageId, d.classificationRunId);
  }
  const closedOutcome = closeOutcome(closed, "nine_questions:wrong_person");
  await completeClaim(supabase, input.propertyId, {
    claimId: claim.claimId,
    outcome: claimOutcomeOf(closedOutcome),
    errorMessage: dispositionClaimError(closed),
    ...(messageId ? { outboundMessageId: messageId } : {}),
  });
  return closedOutcome;
}

export async function runNineQuestionsStep(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const { input, property, claim, runCtx, templateCtx } = a;
  if (input.nineDeferral?.hotReply) {
    // Only the approved hot reply text is waiting: the promotion, hand-off and alert already
    // happened. Send it only if nothing about the lead changed while it waited (a person
    // texting, calling, a status change...); otherwise drop the text, never re-decide.
    const deferral = input.nineDeferral;
    const { data: current, error: revisionError } = await supabase
      .from("properties")
      .select("decision_context_revision")
      .eq("id", input.propertyId)
      .maybeSingle();
    const action = actionForNineAnswer(deferral.result.answer);
    if (revisionError || !current || current.decision_context_revision !== deferral.revision || action.kind !== "hot" || !action.reply) {
      await trace(supabase, {
        kind: "reply",
        name: "nine_hot_reply",
        result: "skipped",
        detail: { engine: "nine_questions", why: "context_changed" },
      }, runCtx);
      await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "skipped", errorMessage: NINE_HOT_REPLY_CONTEXT_CHANGED });
      return { outcome: "skipped", reason: "nine_hot_reply_context_changed" };
    }
    return sendNineHotReply(supabase, a, action.reply, {
      classificationRunId: deferral.classificationRunId,
      evaluationRevision: deferral.revision,
      result: deferral.result,
    }, deferral.revision);
  }
  if (input.nineDeferral) {
    // A deferred reply: act only if nothing about the lead changed while it waited
    // (a new text, a takeover, a status / dispo change all move the revision).
    const { data: current, error: revisionError } = await supabase
      .from("properties")
      .select("decision_context_revision")
      .eq("id", input.propertyId)
      .maybeSingle();
    if (revisionError || !current) {
      // Unreadable: we cannot tell who owns the thread, so a person looks.
      return nineHoldAndComplete(supabase, a, NINE_DEFERRED_CONTEXT_CHANGED);
    }
    if (input.nineDeferral.fresh || current.decision_context_revision !== input.nineDeferral.revision) {
      // The lead's revision moves on many things that do NOT end the conversation (a campaign
      // text, a same-value re-import, an assignment...). So never drop the reply: discard the
      // carried decision and decide again from scratch. The normal gates then exit silently
      // when a newer inbound / a person's terminal dispo / an opt-out owns the thread.
      await trace(supabase, {
        kind: "action",
        name: "nine_reply_deferred",
        result: "applied",
        detail: { engine: "nine_questions", why: "context_changed", redispatch: "fresh" },
      }, runCtx);
      const count = input.nineDeferral.count;
      return runNineQuestionsStep(supabase, { ...a, input: { ...input, nineDeferral: undefined, nineDeferCount: count } });
    }
  }
  // A deferred run reuses the deferring run's decision: the revision check above proved the
  // lead did not change, so Jev is not asked again.
  const cls = input.nineDeferral
    ? {
        kind: "ok" as const,
        result: input.nineDeferral.result,
        classificationRunId: input.nineDeferral.classificationRunId,
        evaluationRevision: input.nineDeferral.revision,
      }
    : await runNineClassification(
        supabase,
        {
          orgId: property.org_id,
          propertyId: input.propertyId,
          contactId: input.contactId,
          conversationId: input.conversationId ?? null,
          inboundMessageId: input.inboundMessageId ?? null,
          inboundBody: input.inboundBody,
        },
        { fetch, typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "", runContext: runCtx },
      );
  if (cls.kind === "failed") {
    // Never falls back to the other engine: no trusted decision, so a person looks. A price
    // keyword still makes it a hot hold (alert only), as in the eight-answer path, but hostile
    // wording is checked first: that waits for a person's confirmation.
    if (isHostileInbound(input.inboundBody)) return holdHostileForConfirm(supabase, input, claim, runCtx);
    if (hasHotPriceKeyword(input.inboundBody, a.escalationKeywords)) {
      return holdNinePriceKeyword(supabase, a, { kind: "nine_questions", failed: cls.reason });
    }
    return nineHoldAndComplete(supabase, a, `jev_automatic_failed:${cls.reason}`);
  }
  const { result } = cls;
  const action = actionForNineAnswer(result.answer);
  await trace(supabase, {
    kind: "action",
    name: "nine_questions_route",
    result: "applied",
    detail: { engine: "nine_questions", answer: result.answer, action: action.kind },
  }, runCtx);

  // Hostile wording or a hostile answer: never an automatic reply, never an automatic DNC.
  if (isHostileInbound(input.inboundBody) || result.answer === "hostile") {
    return holdHostileForConfirm(supabase, input, claim, runCtx);
  }

  // PR 2: hot wins over everything but stop / hostile / wrong person (see nineYieldsToHotKeyword).
  if (nineYieldsToHotKeyword(result.answer, input.inboundBody, a.escalationKeywords)) {
    return holdNinePriceKeyword(supabase, a, { kind: "nine_questions", answer: result.answer });
  }

  if (action.kind === "hot") {
    return routeNineHot(supabase, a, { classificationRunId: cls.classificationRunId, evaluationRevision: cls.evaluationRevision, result });
  }

  if (result.answer === "not_interested") {
    const repeatNo = await routeNineRepeatNotInterested(supabase, a, {
      classificationRunId: cls.classificationRunId,
      evaluationRevision: cls.evaluationRevision,
    });
    if (repeatNo) return repeatNo;
  }

  if (action.kind === "continue_drip_if_last_was_drip") {
    return routeNineJustOk(supabase, a, cls.evaluationRevision);
  }

  if (action.kind === "wait_for_person") {
    // Spelled out so the hold-reason registry test sees each literal. Hostile never gets
    // here (held for confirmation above); anything else unreadable waits as needs_person.
    return nineHoldAndComplete(supabase, a, action.reason === "asked_stop" ? "nine_asked_stop" : "nine_needs_person");
  }

  if (action.kind === "drip_only") {
    const dripResult = await enrollNineDrip(supabase, {
      orgId: property.org_id,
      propertyId: input.propertyId,
      contactId: input.contactId,
      dripName: action.drip,
      skipFirstStep: false,
    });
    const flagOk = await nineRecordDrip(supabase, a, action.drip, dripResult);
    await completeClaim(supabase, input.propertyId, {
      claimId: claim.claimId,
      outcome: dripResult.status === "refused" ? "escalated" : "auto_closed",
      ...(dripResult.status === "refused" ? { flagOk } : {}),
    });
    return dripResult.status === "refused"
      ? { outcome: "escalated", reason: `drip_enroll_failed:${dripResult.reason}` }
      : { outcome: "auto_closed", reason: "nine_questions:confirmed_owner" };
  }

  const chosenProbability = result.chosen?.probability ?? null;

  if (action.kind === "reply_and_close_wrong_person") {
    return closeNineWrongPersonThisProperty(supabase, a, {
      evaluationRevision: cls.evaluationRevision,
      classificationRunId: cls.classificationRunId,
      chosenProbability,
    });
  }

  // reply_and_drip: the drip only starts after the reply was accepted by the provider.
  const noReply = async (why: string): Promise<AiDispatchOutcome | AiRetryOutcome> => {
    // Refused at the provider fence because the lead changed after a deferral: silent exit.
    // The send gate found a newer inbound (Q8 rule 1): that inbound's own run owns the thread.
    // Not sent and no extra nine hold: the gate already flagged a person if its table says so.
    if (why === "skipped:superseded_before_send" || why === "skipped:superseded_by_newer_inbound") {
      await trace(supabase, {
        kind: "action",
        name: "drip_enrolled",
        result: "skipped",
        detail: { why: "superseded", route: action.drip, engine: "nine_questions" },
      }, runCtx);
      await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "skipped", errorMessage: why });
      return { outcome: "skipped", reason: why.slice("skipped:".length) };
    }
    if (input.nineDeferral && why.endsWith(NINE_DEFERRED_CONTEXT_CHANGED)) {
      return redispatchNineFresh(supabase, a, {
        evaluationRevision: cls.evaluationRevision,
        classificationRunId: cls.classificationRunId,
        result,
      });
    }
    // Only a closed send window: wait for it to open instead of holding (A/B/C).
    const deferred = await maybeDeferNineReply(supabase, a, why, {
      evaluationRevision: cls.evaluationRevision,
      classificationRunId: cls.classificationRunId,
      result,
    });
    if (deferred) return deferred;
    await trace(supabase, {
      kind: "action",
      name: "drip_enrolled",
      result: "skipped",
      detail: { why: "reply_not_sent", detail: why, route: action.drip, engine: "nine_questions" },
    }, runCtx);
    return nineHoldAndComplete(supabase, a, why === NINE_REPLY_TEXT_NOT_APPROVED ? why : `nine_reply_not_sent:${why}`);
  };
  if (!templateCtx) return noReply("reply_ineligible");

  let messageId: string | null = null;
  if (action.reply === "identity") {
    if (input.replyDelayBypassed) return noReply(input.replyDelayBypassReason ?? TEMPLATE_DROP_DELAY_UNAVAILABLE);
    const safety = validateAiReplyBody(IDENTITY_REPLY_BODY);
    if (!safety.ok) return noReply(`safety:${safety.reason}`);
    const identityRepeat = await templateAlreadySentToProperty(supabase, property.org_id, input.propertyId, null, IDENTITY_REPLY_BODY);
    if (identityRepeat !== "no") {
      await trace(supabase, {
        kind: "reply",
        name: "template_reply",
        result: "skipped",
        detail: { replyKind: "identity", reason: TEMPLATE_ALREADY_SENT, ...(identityRepeat === "error" ? { lookup: "failed" } : {}) },
      }, runCtx);
      return noReply(TEMPLATE_ALREADY_SENT);
    }
    // The identity text is not a library template, so the send path's recipient-window
    // guards (approved_template only) would not stop it: check the recipient's clock here.
    // A closed window waits for it to open (see maybeDeferNineReply), as a template does.
    const identityWindow = await evaluateRecipientWindow(supabase, input);
    if (!identityWindow.ok) {
      await trace(supabase, {
        kind: "reply",
        name: "template_reply",
        result: "held",
        detail: { replyKind: "identity", window: identityWindow.why },
      }, runCtx);
      return noReply(`quiet_hours_recipient:${identityWindow.why}`);
    }
    const sent = await sendResponderMessage(supabase, {
      runContext: runCtx,
      input,
      body: IDENTITY_REPLY_BODY,
      model: templateCtx.model,
      confidence: 1,
      sentiment: "neutral",
      turn: templateCtx.currentTurn + 1,
      // As the wording shortcut does: a fixed approved text, not classed as a library template.
      source: "llm",
      orgId: property.org_id,
      claimStartedAt: templateCtx.claimStartedAt,
      outboundMode: templateCtx.outboundMode,
      replyKind: "identity",
      // Recipient window re-checked in the send path and at the provider fence; a
      // window-only refusal comes back unflagged so it can be deferred below.
      windowDeferrable: true,
      // Fixed approved text, not model-written: exempt from AI_RESPONDER_LLM_AUTOSEND=0 only.
      approvedFixedText: true,
    });
    if (
      sent.outcome === "skipped" &&
      (sent.reason === NINE_WINDOW_CLOSED || sent.reason === NINE_WINDOW_CLOSED_AT_FENCE || sent.reason === NINE_DEFERRED_CONTEXT_CHANGED)
    ) {
      return noReply(sent.reason);
    }
    if (sent.outcome === "retry") {
      return settleClaimForSendOutcome(supabase, claim.claimId, { ...sent, reply: undefined }, {
        orgId: property.org_id,
        input,
        body: IDENTITY_REPLY_BODY,
        runContext: runCtx,
      });
    }
    if (sent.outcome !== "sent") {
      await settleClaimForSendOutcome(supabase, claim.claimId, sent, { orgId: property.org_id, input, body: IDENTITY_REPLY_BODY, runContext: runCtx });
      await trace(supabase, {
        kind: "action",
        name: "drip_enrolled",
        result: "skipped",
        detail: { why: "reply_not_sent", detail: sent.outcome, route: action.drip, engine: "nine_questions" },
      }, runCtx);
      await holdWithRetry(supabase, input.propertyId, `nine_reply_not_sent:send_${sent.outcome}`, runCtx);
      return { outcome: "escalated", reason: `nine_reply_not_sent:send_${sent.outcome}` };
    }
    messageId = sent.messageId;
  } else {
    const label = action.reply === "nurture" ? "nurture" : "not_interested";
    const step = await runApprovedTemplateStep(supabase, {
      input,
      property,
      ctx: templateCtx,
      claim,
      outcome: label,
      nativeConfidence: chosenProbability,
      escalationReason: "not_applicable",
      decidedBy: "nine_questions",
      requiredBody: APPROVED_REPLY_TEXTS[label],
      windowDeferrable: true,
      runCtx,
    });
    if (step.kind === "stop") return step.outcome;
    if (!step.outboundMessageId || step.replyKey !== label) return noReply(step.notSentReason ?? "not_sent");
    messageId = step.outboundMessageId;
  }

  // "Maybe later" is the nurture outcome, so the org's nurture auto-drip switch governs it
  // (reply still went out; no enrolment, no hold: switching it off is a choice, not a failure).
  // The other three drips have no such switch today and are not governed by it.
  if (action.drip === "Maybe later" && !(await nineNurtureDripSwitchOn(supabase, property.org_id))) {
    await trace(supabase, {
      kind: "action",
      name: "drip_enrolled",
      result: "skipped",
      detail: { why: "drip_switch_off", route: action.drip, engine: "nine_questions" },
    }, runCtx);
    await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "auto_closed", outboundMessageId: messageId });
    return { outcome: "auto_closed", reason: `nine_questions:${result.answer}` };
  }
  const dripResult = await enrollNineDrip(supabase, {
    orgId: property.org_id,
    propertyId: input.propertyId,
    contactId: input.contactId,
    dripName: action.drip,
    skipFirstStep: action.skipFirstStep,
  });
  const flagOk = await nineRecordDrip(supabase, a, action.drip, dripResult);
  await completeClaim(supabase, input.propertyId, {
    claimId: claim.claimId,
    outcome: dripResult.status === "refused" ? "escalated" : "auto_closed",
    ...(dripResult.status === "refused" ? { flagOk } : {}),
    outboundMessageId: messageId,
  });
  return dripResult.status === "refused"
    ? { outcome: "escalated", reason: `drip_enroll_failed:${dripResult.reason}` }
    : { outcome: "auto_closed", reason: `nine_questions:${result.answer}` };
}

/** The drip paused by this inbound could not be resumed after a just_ok answer: a person looks. */
export const NINE_JUST_OK_DRIP_RESUME_FAILED = "nine_just_ok_drip_resume_failed";

/**
 * just_ok (Jarrad 2026-10-21): the homeowner only acknowledged our text ("Ok", a thumbs up).
 * Replay on 708 real replies 2026-10-21: just_ok was 100% precise.
 *
 * Acts ONLY when our last text to them (the same message Jev was shown as
 * our_last_text_to_homeowner) was a drip step (`metadata.sequence_enrollment_id`, written by
 * the sequence tick) or our approved check-back reply (the approved `not_interested` template,
 * `metadata.reply_key`, with the approved body). Then: no reply, no hold, and the drip the
 * inbound paused (`pause_reason = 'inbound_reply'`) is resumed so it simply continues.
 * Anything else (an offer question, a person's text, nothing readable) is needs_person.
 */
async function routeNineJustOk(
  supabase: SupabaseClient<Database>,
  a: NineStepArgs,
  evaluationRevision: number,
): Promise<AiDispatchOutcome> {
  const { input, claim, runCtx } = a;
  const lastWasDrip = await nineLastOutboundWasDripOrCheckBack(supabase, input);
  if (lastWasDrip === "no") {
    await trace(supabase, {
      kind: "action",
      name: "nine_just_ok",
      result: "skipped",
      detail: { engine: "nine_questions", why: "last_text_not_drip" },
    }, runCtx);
    return nineHoldAndComplete(supabase, a, "nine_needs_person");
  }
  // Freshness: anything that moved the lead since this inbound was evaluated (a newer text, a
  // person acting) owns the thread now, so this older "Ok" must not resume the drip.
  const revisionNow = async (): Promise<number | null> => {
    const { data, error: revError } = await supabase
      .from("properties")
      .select("decision_context_revision")
      .eq("id", input.propertyId)
      .maybeSingle();
    return revError || !data ? null : data.decision_context_revision;
  };
  // The revision baseline is read inside classification, so a newer inbound that landed just
  // before it would be inside both reads. Also require THIS inbound to be the newest one.
  const isStillNewest = async (): Promise<boolean> => {
    if (!input.inboundMessageId) return false;
    const { data: src } = await supabase.from("messages").select("created_at").eq("id", input.inboundMessageId).maybeSingle();
    if (!src) return false;
    let q = supabase
      .from("messages")
      .select("id")
      .eq("property_id", input.propertyId)
      .eq("direction", "inbound")
      .neq("id", input.inboundMessageId)
      .gte("created_at", src.created_at)
      .limit(1);
    q = input.conversationId ? q.eq("conversation_id", input.conversationId) : q.eq("contact_id", input.contactId);
    const { data: newer, error: newerError } = await q;
    return !newerError && (newer ?? []).length === 0;
  };
  const fresh = async () => (await revisionNow()) === evaluationRevision && (await isStillNewest());
  if (!(await fresh())) {
    await trace(supabase, {
      kind: "action",
      name: "nine_just_ok",
      result: "skipped",
      detail: { engine: "nine_questions", why: "context_changed" },
    }, runCtx);
    return nineHoldAndComplete(supabase, a, "nine_needs_person");
  }
  const { data: paused, error } = await supabase
    .from("sequence_enrollments")
    .select("id")
    .eq("property_id", input.propertyId)
    .eq("status", "paused")
    .eq("pause_reason", "inbound_reply");
  if (error) return nineHoldAndComplete(supabase, a, NINE_JUST_OK_DRIP_RESUME_FAILED);
  const resumed: string[] = [];
  const notResumed: Array<{ id: string; outcome: string }> = [];
  for (const row of paused ?? []) {
    // The expected reason is re-checked under the enrolment lock (a person taking over or a
    // Norma call in between is simply not resumed).
    const { data, error: rpcError } = await supabase.rpc("resume_sequence_enrollment", {
      p_enrollment_id: row.id,
      p_actor_user_id: null,
      p_expected_pause_reason: "inbound_reply",
    });
    const outcome = rpcError ? "error" : (data?.[0]?.outcome ?? "error");
    if (outcome === "resumed") resumed.push(row.id);
    else notResumed.push({ id: row.id, outcome });
  }
  // The resume RPC cannot check the lead's revision, so re-check after it: if anything moved the
  // lead during the resume, pause the drip again and let a person look.
  if (resumed.length > 0 && !(await fresh())) {
    // Re-pause and VERIFY; retried, because the hold flag alone does not stop the drip tick.
    let repaused = false;
    for (let attempt = 0; attempt < 3 && !repaused; attempt++) {
      try {
        await pausePropertyEnrollments(supabase, { propertyId: input.propertyId, reason: "inbound_reply" });
        const { data: still, error: stillError } = await supabase
          .from("sequence_enrollments")
          .select("id")
          .in("id", resumed)
          .eq("status", "active");
        repaused = !stillError && (still ?? []).length === 0;
      } catch (e) {
        reportError(e, { tags: { surface: "nine_just_ok_repause" }, extra: { propertyId: input.propertyId, attempt } });
      }
    }
    if (!repaused) {
      reportError(new Error("just_ok re-pause not verified"), { tags: { surface: "nine_just_ok_repause" }, extra: { propertyId: input.propertyId, resumed } });
      return nineHoldAndComplete(supabase, a, NINE_JUST_OK_DRIP_RESUME_FAILED);
    }
    return nineHoldAndComplete(supabase, a, "nine_needs_person");
  }
  if (resumed.length > 0) {
    await recordLeadEvent({
      propertyId: input.propertyId,
      actorType: "system",
      eventType: LEAD_EVENT_TYPES.SEQUENCE_RESUMED,
      payload: { count: resumed.length, enrollment_ids: resumed, reason: "nine_questions:just_ok" },
    });
  }
  // A resume that errored (or needs reconciliation) would leave the lead silent: a person looks.
  // not_paused / norma_hold mean someone else already owns the drip state: nothing to do.
  const failed = notResumed.filter(
    (r) => r.outcome !== "not_paused" && r.outcome !== "norma_hold" && r.outcome !== "pause_reason_changed",
  );
  await trace(supabase, {
    kind: "action",
    name: "nine_just_ok",
    result: failed.length > 0 ? "error" : "applied",
    detail: { engine: "nine_questions", resumed, notResumed },
  }, runCtx);
  if (failed.length > 0) return nineHoldAndComplete(supabase, a, NINE_JUST_OK_DRIP_RESUME_FAILED);
  await completeClaim(supabase, input.propertyId, { claimId: claim.claimId, outcome: "auto_closed" });
  return { outcome: "auto_closed", reason: "nine_questions:just_ok" };
}

/** Fails closed ("no") on any read problem or a missing source inbound. */
async function nineLastOutboundWasDripOrCheckBack(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
): Promise<"yes" | "no"> {
  if (!input.inboundMessageId) return "no";
  const { data: inbound, error: inboundError } = await supabase
    .from("messages")
    .select("created_at")
    .eq("id", input.inboundMessageId)
    .eq("property_id", input.propertyId)
    .maybeSingle();
  if (inboundError || !inbound) return "no";
  // Same thread scope and cut-off as buildTwoWayThreadState (what Jev was shown).
  let query = supabase
    .from("messages")
    .select("body, metadata, status")
    .eq("property_id", input.propertyId)
    .eq("direction", "outbound")
    .neq("id", input.inboundMessageId)
    .lte("created_at", inbound.created_at)
    .order("created_at", { ascending: false })
    .limit(1);
  query = input.conversationId ? query.eq("conversation_id", input.conversationId) : query.eq("contact_id", input.contactId);
  const { data: last, error } = await query.maybeSingle();
  if (error || !last) return "no";
  const meta = readJsonObject((last.metadata ?? null) as Json | null);
  // Only a text the provider actually took counts. A retired / failed / still-queued attempt
  // (its metadata may still carry reply_key or sequence_enrollment_id) is not proof the seller
  // saw it: fail closed to needs_person.
  if (last.status !== "sent" && last.status !== "delivered") return "no";
  if (meta.abortedBeforeProvider === true || meta.aborted_inbound_message_id != null) return "no";
  if (typeof meta.sequence_enrollment_id === "string" && meta.sequence_enrollment_id.length > 0) return "yes";
  if (meta.reply_key === "not_interested" && last.body === APPROVED_REPLY_TEXTS.not_interested) return "yes";
  return "no";
}

/** `ai_responder_configs.nurture_auto_drip`; any read problem counts as OFF (no enrolment). */
async function nineNurtureDripSwitchOn(supabase: SupabaseClient<Database>, orgId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("ai_responder_configs")
    .select("nurture_auto_drip")
    .eq("org_id", orgId)
    .eq("active", true)
    .maybeSingle();
  return !error && data?.nurture_auto_drip === true;
}

/**
 * PR 2's hot hand-off, the ONE place it is applied for both engines: assign the lead to Jarrad
 * and trace it. Returns null on success, or the escalated outcome (a hot hold: the alert cron
 * still texts Jarrad) when the hand-off failed. Never auto-closes a failed hand-off.
 */
async function handOffHotLead(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  claim: { claimId: string | null },
  runCtx?: MaybeRunContext,
  inboundMessageId?: string | null,
  onStatus?: (status: string) => void,
): Promise<AiDispatchOutcome | null> {
  const handoff = await assignHotLeadToOwner(supabase, propertyId, { inboundMessageId });
  onStatus?.(handoff.status);
  await trace(supabase, {
    kind: "action",
    name: "assign_hot_lead",
    result: handoff.status === "failed" ? "error" : "applied",
    detail: handoff.status === "failed"
      ? { status: handoff.status, reason: handoff.reason }
      : handoff.status === "owned_by_someone_else"
        ? { status: handoff.status, owner_user_id: handoff.ownerUserId }
        : handoff.status === "owned_by_someone_else_unrecorded"
          ? { status: handoff.status, owner_user_id: handoff.ownerUserId, note: handoff.detail }
        : handoff.status === "assigned_unrecorded"
          ? { status: handoff.status, assignee_user_id: handoff.assigneeUserId, note: handoff.detail }
          : { status: handoff.status, assignee_user_id: handoff.assigneeUserId },
  }, runCtx);
  if (handoff.status !== "failed" && handoff.status !== "assigned_unrecorded" && handoff.status !== "owned_by_someone_else_unrecorded") return null;
  // assigned_unrecorded: the lead IS on My Leads, but its note did not save; the hold keeps a person in the loop.
  const reason = handoff.status === "failed"
    ? HOT_LEAD_ASSIGN_FAILED_REASON
    : handoff.status === "owned_by_someone_else_unrecorded"
      ? HOT_ALERT_EVENT_FAILED_REASON
      : HOT_LEAD_EVENT_FAILED_REASON;
  let ourFlagAt: string | null = null;
  const flagOk = await markPropertyNeedsAttention(supabase, propertyId, reason, runCtx, NO_GUARD, (at) => {
    ourFlagAt = at;
  });
  // Shares the hold's alert key only when THIS call set the flag; otherwise its own key.
  await recordHotFailure(supabase, propertyId, inboundMessageId, reason, ourFlagAt);
  await completeClaim(supabase, propertyId, {
    claimId: claim.claimId,
    outcome: "escalated",
    flagOk,
    errorMessage: handoff.status === "failed" ? handoff.reason : handoff.detail,
  });
  return { outcome: "escalated", reason };
}
