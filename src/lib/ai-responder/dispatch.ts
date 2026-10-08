import { randomUUID } from "node:crypto";
import { after } from "next/server";

import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { ensureConversationIdForThread } from "@/lib/messages/threading";
import { applyPhoneLevelOptOut, isSmsPhoneSuppressed } from "@/lib/messaging/opt-out-phone";
import { getConsentStateStrict } from "@/lib/messaging/consent";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import {
  checkFloridaCap,
  checkRecipientQuietHours,
} from "@/lib/messaging/quiet-hours-recipient";
import { sendSmsToContact } from "@/lib/messaging/send";
import { normalizePhone } from "@/lib/csv/normalize";
import { selectBestSmsPhone, selectSmsPhoneByNumber } from "@/lib/messaging/sms-phone";
import { shouldSuppressAutomatedSend } from "@/lib/messaging/suppression";
import { pausePropertyEnrollments } from "@/lib/sequences/enrollment";
import type { Database, Json } from "@/lib/supabase/types";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";

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
import { matchEscalationKeyword } from "./keywords";
import { resolveResponderOutcome, type ResponderRoute } from "./route";
import { validateAiReplyBody } from "./safety";
import { resolveApprovedTemplateReply } from "./template-reply";
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
};

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
  | "needs_human_attention"
  | "org_id"
  | "outreach_dispo"
  | "state"
>;

export type AiDispatchPreGateResult =
  | { ok: true; property: AiDispatchPropertyGateRow }
  | { ok: false; outcome: AiDispatchOutcome };

export async function applyKeywordEscalation(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    inboundBody: string;
    escalationKeywords?: ReadonlyArray<string> | null;
    runContext?: MaybeRunContext;
  },
): Promise<{ escalated: true; reason: string } | { escalated: false }> {
  const keywordMatch = matchEscalationKeyword(args.inboundBody, {
    allowedPhrases: args.escalationKeywords ?? undefined,
  });
  if (!keywordMatch) {
    await trace(
      supabase,
      { kind: "gate", name: "escalation_keyword", result: "pass" },
      args.runContext,
    );
    return { escalated: false };
  }

  const reason = `keyword:${keywordMatch.tier}`;
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
  await markPropertyNeedsAttention(
    supabase,
    args.propertyId,
    reason,
    args.runContext,
  );
  return { escalated: true, reason };
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
      "id, org_id, state, ai_responder_disabled, outreach_dispo, needs_human_attention, homeowner_contact_id",
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
  if (isTerminalAiResponderProperty(property)) {
    await blocked("already_terminal");
    return {
      ok: false,
      outcome: silentSkip("already_terminal", 0),
    };
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
    });
    if (evaluation.ok) {
      const decision = evaluation.decision;
      // Rule 0 reasons other than a terminal property (consent, org off,
      // disabled property) keep their existing downstream handling (the skip
      // classifier still lets Jev classify): silent, nothing flagged here,
      // and rules 1-6 must not run for a dead lead.
      const passThrough = decision.action === "skip" && decision.rule === 0 && decision.reason !== "already_terminal";
      const plan = passThrough ? null : skipPlanFor(decision, "early");
      if (plan) {
        await blocked(plan.trace);
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
  return { ok: true, property };
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

  const { data: config } = await supabase
    .from("ai_responder_configs")
    .select(
      "id, active, model, system_prompt, max_turns, min_confidence, escalation_keywords, business_hours_only, classifier_provider, classifier_mode, outbound_mode, reply_generation",
    )
    .eq("org_id", property.org_id)
    .eq("active", true)
    .maybeSingle();

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
  const keywordEscalation = await applyKeywordEscalation(supabase, {
    propertyId: input.propertyId,
    inboundBody: input.inboundBody,
    escalationKeywords: config?.escalation_keywords ?? null,
    runContext: deps.runContext,
  });

  if (keywordEscalation.escalated) {
    return { outcome: "escalated", reason: keywordEscalation.reason };
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

  if (input.conversationId) {
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

  if (isIdentityQuestion(input.inboundBody)) {
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
    return settleClaimForSendOutcome(supabase, responseClaim.claimId, outcome, {
      orgId: property.org_id,
      input,
      body: IDENTITY_REPLY_BODY,
      runContext: deps.runContext,
    });
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
  };
  const classificationResult = await classifyAndHandleNonRouteOutcomes(
    supabase,
    input,
    property,
    config,
    responseClaim,
    deps.runContext,
    templateCtx,
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
    model: string;
    system_prompt: string;
    min_confidence: number;
    reply_generation?: string | null;
  },
  currentTurn: number,
  runCtx?: MaybeRunContext,
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
        escalation_keywords?: ReadonlyArray<string> | null;
      }
    | null
    | undefined,
  responseClaim: { claimId: string | null },
  runCtx?: MaybeRunContext,
  /** Present only on the reply-eligible path: absent = no template step. */
  templateCtx?: TemplateStepContext,
): Promise<
  | { handled: true; outcome: AiDispatchOutcome | AiRetryOutcome }
  | { handled: false; classification: ClassificationBridgeResult }
> {
  const classification = await classifyForDispatch(
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
    // Root review of dbbb12e6, finding 1: effect + revision guard +
    // audit insert now happen atomically inside ONE RPC call — see
    // applyJevLeadDecisionAtomically's doc comment.
    //
    // Approved-template reply first (Phase 4): nurture is a human-owned
    // disposition that suppresses automated sends, so the reply must go out
    // before the outcome is applied.
    let templateMessageId: string | null = null;
    if (templateCtx) {
      const step = await runApprovedTemplateStep(supabase, {
        input,
        property,
        ctx: templateCtx,
        claim: responseClaim,
        outcome: "nurture",
        nativeConfidence: classification.nativeConfidence,
        escalationReason: classification.escalationReason,
        runCtx,
      });
      if (step.kind === "stop") return { handled: true, outcome: step.outcome };
      templateMessageId = step.outboundMessageId;
    }
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
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: "auto_closed",
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
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: silentSkipClaimOutcome(0),
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
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: "auto_closed",
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
    await markPropertyNeedsAttention(supabase, input.propertyId, reason, runCtx);
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
    // classify+generate call, unchanged from today.
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
    case "opt_out":
      const isJevBelowThresholdOptOut = classification.kind === "jev_route" && !classification.eligibleForAutoAccept;
      const optOutResult = isJevBelowThresholdOptOut
        ? // Q6 (Jarrad, 2026-10-08): below threshold goes to human review
          // everywhere. Defer only; the phone is NOT suppressed until a
          // human confirms (keyword STOP still suppresses upstream).
          await proposeDeferredJevDisposition(supabase, {
            runContext: runCtx,
            propertyId: input.propertyId,
            conversationId: input.conversationId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            classificationRunId: classification.classificationRunId,
            dispo: "opted_out",
            reason: route.reason,
            expectedRevision: jevRevision!,
          })
        : await applyResponderOptOut(supabase, {
            propertyId: input.propertyId,
            contactId: input.contactId,
            conversationId: input.conversationId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            inboundFromPhone: input.inboundFromPhone ?? null,
            orgId: property.org_id,
            reason: route.reason,
            expectedRevision: jevRevision,
          });
      await traceDisposition(
        supabase,
        "opted_out",
        optOutResult,
        isJevBelowThresholdOptOut,
        runCtx,
      );
      if (!optOutResult.updated) {
        const outcome = closeOutcome(optOutResult, route.reason);
        await completeClaim(supabase, input.propertyId, {
          claimId: responseClaim.claimId,
          outcome: claimOutcomeOf(outcome),
          errorMessage: dispositionClaimError(optOutResult),
        });
        return outcome;
      }
      if (jevAutoAccept && input.inboundMessageId) {
        await maybeAutoAcceptJevReview(
          supabase,
          input.inboundMessageId,
          jevAutoAccept.classificationRunId,
        );
      }
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: "opted_out",
      });
      return { outcome: "opted_out", reason: route.reason };
    case "close_dnc": {
      // Jev-driven dnc: phone suppressed immediately, review + hold written,
      // outreach_dispo deferred to a human. PLAN §8 Q4 OPEN — prod
      // behaviour preserved until Jarrad decides. Legacy dnc is
      // completely unchanged — applyResponderDnc still applies
      // everything immediately, exactly as it does today.
      const isJevDnc = classification.kind === "jev_route";
      const dncResult = isJevDnc
        ? await proposeJevDncSuppression(supabase, {
          runContext: runCtx,
            propertyId: input.propertyId,
            contactId: input.contactId,
            conversationId: input.conversationId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            inboundFromPhone: input.inboundFromPhone ?? null,
            orgId: property.org_id,
            classificationRunId: classification.classificationRunId,
            reason: route.reason,
            expectedRevision: jevRevision!,
          })
        : await applyResponderDnc(supabase, {
            propertyId: input.propertyId,
            contactId: input.contactId,
            conversationId: input.conversationId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            inboundFromPhone: input.inboundFromPhone ?? null,
            orgId: property.org_id,
            reason: route.reason,
          });
      await traceDisposition(supabase, "dnc", dncResult, isJevDnc, runCtx);
      const dncOutcome = closeOutcome(dncResult, route.reason);
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: claimOutcomeOf(dncOutcome),
        errorMessage: dispositionClaimError(dncResult),
      });
      return dncOutcome;
    }
    case "auto_close_wrong_number":
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
          })
        : await applyWrongNumber(supabase, {
          runContext: runCtx,
            propertyId: input.propertyId,
            contactId: input.contactId,
            conversationId: input.conversationId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            inboundFromPhone: input.inboundFromPhone ?? null,
            orgId: property.org_id,
            scope: route.scope,
            reason: route.reason,
            expectedRevision: jevRevision,
          });
      await traceDisposition(
        supabase,
        "wrong_number",
        wrongNumberResult,
        isJevBelowThresholdWrongNumber,
        runCtx,
      );
      const wrongNumberOutcome = closeOutcome(wrongNumberResult, route.reason);
      if (jevAutoAccept && wrongNumberResult.updated && input.inboundMessageId) {
        await maybeAutoAcceptJevReview(
          supabase,
          input.inboundMessageId,
          jevAutoAccept.classificationRunId,
        );
      }
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: claimOutcomeOf(wrongNumberOutcome),
        errorMessage: dispositionClaimError(wrongNumberResult),
      });
      return wrongNumberOutcome;
    case "auto_close":
      let autoCloseTemplateMessageId: string | null = null;
      if (templateCtx && classification.kind === "jev_route" && classification.eligibleForAutoAccept) {
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
          runCtx,
        });
        if (step.kind === "stop") return step.outcome;
        autoCloseTemplateMessageId = step.outboundMessageId;
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
      await completeClaim(supabase, input.propertyId, {
        claimId: responseClaim.claimId,
        outcome: claimOutcomeOf(autoCloseOutcome),
        errorMessage: dispositionClaimError(autoCloseResult),
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
};

type TemplateStepResult =
  /**
   * Carry on with today's flow (apply the outcome); `outboundMessageId` when a
   * template went out. A template that was refused or held (quiet hours, hold
   * mode, any gate) also continues, with no message id: see the doc below.
   */
  | { kind: "continue"; outboundMessageId: string | null }
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
async function runApprovedTemplateStep(
  supabase: SupabaseClient<Database>,
  a: {
    input: AiDispatchInput;
    property: AiDispatchPropertyGateRow;
    ctx: TemplateStepContext;
    claim: { claimId: string | null };
    outcome: "nurture" | "not_interested";
    nativeConfidence: number | null;
    /** Jev's human-follow-up answer; only `not_applicable` allows a template. */
    escalationReason: JevEscalationReason | null;
    runCtx?: MaybeRunContext;
  },
): Promise<TemplateStepResult> {
  const { input, property, ctx, claim, runCtx } = a;
  const resolved = await resolveApprovedTemplateReply(supabase, {
    orgId: property.org_id,
    propertyId: input.propertyId,
    contactId: input.contactId,
    outcome: a.outcome,
    outcomeConfidence: a.nativeConfidence,
    escalationReason: a.escalationReason,
    // The responder does not ask Jev for a reply intent yet, so only
    // any-intent mappings match until it does.
    replyIntent: null,
  });
  if (resolved.kind === "none") {
    if (
      resolved.reason === "human_follow_up" ||
      resolved.reason === "template_unavailable" ||
      resolved.reason === "render_failed" ||
      resolved.reason === "lookup_failed"
    ) {
      await trace(supabase, {
        kind: "reply",
        name: "template_reply",
        result: "skipped",
        detail: { outcome: a.outcome, reason: resolved.reason },
      }, runCtx);
    }
    return { kind: "continue", outboundMessageId: null };
  }

  // The randomized reply delay was bypassed (workflow could not start): never
  // send a template instantly. Drop it; the outcome still applies.
  if (input.replyDelayBypassed) {
    await trace(supabase, {
      kind: "reply",
      name: "template_reply",
      result: "skipped",
      detail: {
        outcome: a.outcome,
        templateId: resolved.templateId,
        mappingId: resolved.mappingId,
        reason: "delay_unavailable",
        disposition: "dropped_outcome_applies",
      },
    }, runCtx);
    return { kind: "continue", outboundMessageId: null };
  }

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
    return { kind: "continue", outboundMessageId: null };
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
    return { kind: "continue", outboundMessageId: alreadySent === "error" ? null : alreadySent };
  }

  const sent = await sendResponderMessage(supabase, {
    runContext: runCtx,
    input,
    body: resolved.body,
    model: ctx.model,
    confidence: a.nativeConfidence ?? 1,
    sentiment: "neutral",
    turn: ctx.currentTurn + 1,
    source: "approved_template",
    templateId: resolved.templateId,
    orgId: property.org_id,
    claimStartedAt: ctx.claimStartedAt,
    outboundMode: ctx.outboundMode,
    replyKind: "send_reply",
  });
  const detail = {
    templateId: resolved.templateId,
    mappingId: resolved.mappingId,
    outcome: a.outcome,
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
    // Durable BEFORE the outcome is applied. If this write fails the sweeper
    // cannot see a crash, so tell a human now rather than risk silence.
    const recorded = await recordClaimTemplateSent(supabase, {
      claimId: claim.claimId,
      outboundMessageId: sent.messageId,
    });
    if (!recorded) {
      await markPropertyNeedsAttention(supabase, input.propertyId, "template_sent_outcome_missing", runCtx);
    }
    return { kind: "continue", outboundMessageId: sent.messageId };
  }
  // Nothing was sent. Held (hold mode / recipient window / any gate) or
  // silently refused: the outcome still applies (see the doc above).
  if (sent.outcome !== "retry") return { kind: "continue", outboundMessageId: null };

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
      kind: "send_reply" | "deescalate_close" | "identity";
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
  if (args.source === "llm" && process.env.AI_RESPONDER_LLM_AUTOSEND?.trim() === "0") {
    return { hold: true, reason: "llm_autosend_off" };
  }
  return { hold: false };
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
  },
): Promise<GateEvaluation> {
  const nowMs = Date.now();

  // Rule 0 evidence (suppression / disabled / consent / terminal): silent by
  // design and decided before anything else is read.
  const silent = await loadSilentExit(supabase, input, opts.property ?? null, opts.humanActor === true);
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
    // `draft_held` (the flag that put the draft on the rail). Any other flag
    // reason still refuses, with the reason shown.
    if (shouldSuppressAutomatedSend({ outreachDispo: property.outreach_dispo })) {
      return { ok: true, reason: "already_terminal" };
    }
    if (property.needs_human_attention && property.last_ai_escalation_reason !== HUMAN_SEND_EXEMPT_FLAG_REASON) {
      return {
        ok: true,
        reason: `already_flagged:${property.last_ai_escalation_reason ?? "unknown"}`,
      };
    }
  } else if (isTerminalAiResponderProperty(property)) {
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
    let query = supabase
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
  const plan = skipPlanFor(decision, "presend")!;
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
    const flagged = await markPropertyNeedsAttention(
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
  if (resolveOutboundPolicy({ source: args.source, dbMode: liveMode }).hold) return refuse("fence:hold");
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
): Promise<number | null> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
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
): Promise<RecipientWindowVerdict> {
  const phone = await resolveSendDestinationPhone(supabase, input);
  const window = checkRecipientQuietHours(phone);
  if (!window.ok) {
    return { ok: false, why: window.reason, state: window.state, localTime: window.localTime };
  }
  if (window.florida) {
    const cap = checkFloridaCap(
      phone ? await countRecentOutboundTexts(supabase, input.contactId, phone) : null,
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
  });
  if (initialPolicy.hold) {
    const evaluation = await evaluateSendGate(supabase, args.input, {
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
  if (args.source === "approved_template") {
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
    let existing = new Set<string>();
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
  const livePolicy = resolveOutboundPolicy({ source: args.source, dbMode: liveMode });
  if (livePolicy.hold) {
    return await holdReplyAsDraft(supabase, args, livePolicy.reason, guard);
  }

  return deliverResponderMessage(supabase, args, attempt);
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
    beforeProviderSubmit: (ctx) => fenceProviderSubmit(supabase, attempt, args, ctx),
    metadata: args.input.inboundMessageId
      ? ({
          generated_by: "ai_responder_v1",
          inbound_message_id: args.input.inboundMessageId,
        } as Json)
      : null,
  });

  if (sendResult.status === "blocked_before_provider") {
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
      const livePolicy = resolveOutboundPolicy({ source: args.source, dbMode: liveMode });
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
      ? { reply_source: "approved_template" as const, template_id: args.templateId ?? null }
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
  },
): Promise<ResponderDispoResult> {
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

    if (args.dispo === "wrong_number") {
      await pausePropertyEnrollments(supabase, {
        propertyId: args.propertyId,
        reason: "inbound_reply",
        permanent: false,
        actor: { actorType: "ai" },
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
async function applyResponderOptOut(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    contactId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    inboundFromPhone: string | null;
    orgId: string;
    reason: string;
    expectedRevision?: number;
  },
): Promise<ResponderDispoResult> {
  const contact = await loadContactPhone(supabase, args.contactId);
  await applyPhoneLevelOptOut(supabase, {
    contactId: args.contactId,
    fromPhone: args.inboundFromPhone ?? contact.phone ?? "",
    orgId: args.orgId,
    source: "ai_responder",
    sourceDetail: { propertyId: args.propertyId, reason: args.reason } as Json,
    occurredAt: new Date(),
    providerId: "ai_responder",
    surface: "stop",
    idempotencyKey: `ai-responder:${args.propertyId}:${args.contactId}:${args.reason}`,
    leadEvent: {
      propertyId: args.propertyId,
      actorType: "ai",
      trigger: "ai_responder",
    },
  });
  const result = await setResponderDispo(supabase, {
    propertyId: args.propertyId,
    conversationId: args.conversationId,
    inboundMessageId: args.inboundMessageId,
    dispo: "opted_out",
    reason: args.reason,
    expectedRevision: args.expectedRevision,
  });
  return result;
}

async function applyResponderDnc(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    contactId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    inboundFromPhone: string | null;
    orgId: string;
    reason: string;
    expectedRevision?: number;
  },
): Promise<ResponderDispoResult> {
  const contact = await loadContactPhone(supabase, args.contactId);
  await applyPhoneLevelOptOut(supabase, {
    contactId: args.contactId,
    fromPhone: args.inboundFromPhone ?? contact.phone ?? "",
    orgId: args.orgId,
    source: "ai_responder_threat",
    sourceDetail: { propertyId: args.propertyId, reason: args.reason } as Json,
    occurredAt: new Date(),
    providerId: "ai_responder",
    surface: "dnc",
    idempotencyKey: `ai-responder-dnc:${args.propertyId}:${args.contactId}:${args.reason}`,
    leadEvent: {
      propertyId: args.propertyId,
      actorType: "ai",
      trigger: "ai_responder",
    },
  });
  const result = await setResponderDispo(supabase, {
    propertyId: args.propertyId,
    conversationId: args.conversationId,
    inboundMessageId: args.inboundMessageId,
    dispo: "dnc",
    reason: args.reason,
    expectedRevision: args.expectedRevision,
  });
  return result;
}

/**
 * Jev-driven dnc: suppress the phone IMMEDIATELY (same applyPhoneLevelOptOut
 * call and `ai-responder-dnc-proposed:` key as origin/main), while the
 * pending review row + hold are still written and outreach_dispo stays
 * unwritten until a human confirms via `fn_confirm_ai_disposition_review`.
 * PLAN §8 Q4 OPEN — prod behaviour preserved until Jarrad decides.
 * (Q6 still holds opted_out below threshold; only dnc is restored here.)
 */
async function proposeJevDncSuppression(
  supabase: SupabaseClient<Database>,
  args: {
    runContext?: MaybeRunContext;
    propertyId: string;
    contactId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    inboundFromPhone: string | null;
    orgId: string;
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

  const contact = await loadContactPhone(supabase, args.contactId);
  await applyPhoneLevelOptOut(supabase, {
    contactId: args.contactId,
    fromPhone: args.inboundFromPhone ?? contact.phone ?? "",
    orgId: args.orgId,
    source: "ai_responder_threat",
    sourceDetail: { propertyId: args.propertyId, reason: args.reason } as Json,
    occurredAt: new Date(),
    providerId: "ai_responder",
    surface: "dnc",
    idempotencyKey: `ai-responder-dnc-proposed:${args.propertyId}:${args.contactId}:${args.reason}`,
    leadEvent: {
      propertyId: args.propertyId,
      actorType: "ai",
      trigger: "ai_responder",
    },
  });

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
  // "proposed" and "replayed" both mean a pending review + hold now exist
  // and the phone is already suppressed; outreach_dispo waits for a human.
  return { updated: true };
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
  // same convention as proposeJevDncSuppression's `updated: true`. The
  // outreach_dispo write itself is intentionally still pending.
  return { updated: true };
}

async function applyWrongNumber(
  supabase: SupabaseClient<Database>,
  args: {
    runContext?: MaybeRunContext;
    propertyId: string;
    contactId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    inboundFromPhone: string | null;
    orgId: string;
    scope: AiWrongScope;
    reason: string;
    expectedRevision?: number;
  },
): Promise<ResponderDispoResult> {
  const result = await setResponderDispo(supabase, {
    runContext: args.runContext,
    propertyId: args.propertyId,
    conversationId: args.conversationId,
    inboundMessageId: args.inboundMessageId,
    dispo: "wrong_number",
    reason: args.reason,
    expectedRevision: args.expectedRevision,
  });
  if (args.scope !== "all") return result;
  if (!result.updated) return result;

  const contact = await loadContactPhone(supabase, args.contactId);
  await applyPhoneLevelOptOut(supabase, {
    contactId: args.contactId,
    fromPhone: args.inboundFromPhone ?? contact.phone ?? "",
    orgId: args.orgId,
    source: "ai_responder_wrong_number",
    sourceDetail: {
      propertyId: args.propertyId,
      reason: args.reason,
      wrong_scope: args.scope,
    } as Json,
    occurredAt: new Date(),
    providerId: "ai_responder",
    surface: "dnc",
    idempotencyKey: `ai-responder-wrong-number:${args.propertyId}:${args.contactId}`,
    leadEvent: {
      propertyId: args.propertyId,
      actorType: "ai",
      trigger: "ai_responder",
    },
  });
  return result;
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
    // Nothing matched `needs_human_attention = false`: either a human was
    // already told (the flag exists: success) or the property is gone / the
    // write silently matched nothing. Prove which before claiming success.
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
