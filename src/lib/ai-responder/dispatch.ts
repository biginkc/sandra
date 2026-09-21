import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { qualifyProperty } from "@/lib/leads/qualify";
import { assertNotTrainingTarget } from "@/lib/leads/training";
import { applyPhoneLevelOptOut } from "@/lib/messaging/opt-out-phone";
import { getConsentState } from "@/lib/messaging/consent";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import { sendSmsToContact } from "@/lib/messaging/send";
import { selectBestSmsPhone } from "@/lib/messaging/sms-phone";
import { shouldSuppressAutomatedSend } from "@/lib/messaging/suppression";
import { pausePropertyEnrollments } from "@/lib/sequences/enrollment";
import type { Database, Json } from "@/lib/supabase/types";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";

import { listAdminUserIds } from "@/lib/auth/admins";
import { createNotification } from "@/lib/notifications/dispatch";
import {
  classifyForDispatch,
  type ClassificationBridgeResult,
} from "@/lib/sms-classification/dispatch-bridge";

import { claimAiResponse, completeAiResponseClaim } from "./claims";
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
import type {
  AiMessageMetadata,
  AiStructuredOutput,
  AiWrongScope,
} from "./types";

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
};

export type AiDispatchOptions = {
  checkSuperseded?: boolean;
};

const AI_REPLY_THREAD_DEBOUNCE_MS = 45_000;
const DEESCALATION_TEMPLATE_WITH_NAME =
  "So sorry to bug you. Sounds like you get a lot of these. Are you {first_name}? Just want to make sure we don't bother you again.";
const DEESCALATION_TEMPLATE_GENERIC =
  "So sorry to bug you. Sounds like you get a lot of these. Are you the owner here? Want to make sure we don't bother you again.";

type ResponderDispoResult =
  | { updated: true }
  | {
      updated: false;
      reason: "already_terminal" | "db_error" | "replayed_other_disposition";
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
  },
): Promise<{ escalated: true; reason: string } | { escalated: false }> {
  const keywordMatch = matchEscalationKeyword(args.inboundBody, {
    allowedPhrases: args.escalationKeywords ?? undefined,
  });
  if (!keywordMatch) return { escalated: false };

  const reason = `keyword:${keywordMatch.tier}`;
  await markPropertyNeedsAttention(supabase, args.propertyId, reason);
  return { escalated: true, reason };
}

export async function checkAiResponderDispatchPreGates(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  options: AiDispatchOptions = {},
): Promise<AiDispatchPreGateResult> {
  if (input.inboundMessageId) {
    const existingReply = await findExistingAiReplyForInbound(
      supabase,
      input.inboundMessageId,
    );
    if (existingReply) {
      return {
        ok: false,
        outcome: { outcome: "skipped", reason: "already_replied" },
      };
    }

    if (options.checkSuperseded === true) {
      const latestInbound = await findLatestInboundInThread(supabase, input);
      if (latestInbound && latestInbound.id !== input.inboundMessageId) {
        return {
          ok: false,
          outcome: {
            outcome: "skipped",
            reason: "superseded_by_newer_inbound",
          },
        };
      }
    }
  }

  const { data: property } = await supabase
    .from("properties")
    .select(
      "id, org_id, state, ai_responder_disabled, outreach_dispo, needs_human_attention, homeowner_contact_id",
    )
    .eq("id", input.propertyId)
    .maybeSingle();
  if (!property) {
    return {
      ok: false,
      outcome: { outcome: "skipped", reason: "property_not_found" },
    };
  }
  if (isTerminalAiResponderProperty(property)) {
    return {
      ok: false,
      outcome: { outcome: "skipped", reason: "already_terminal" },
    };
  }

  return { ok: true, property };
}

export async function dispatchAiResponse(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  deps: { anthropic: AnthropicLike } & AiDispatchOptions,
): Promise<AiDispatchOutcome> {
  // --------------------------------------------------------------------------
  // 1. Load property + org + config
  // --------------------------------------------------------------------------
  const preGates = await checkAiResponderDispatchPreGates(supabase, input, {
    checkSuperseded: deps.checkSuperseded,
  });
  if (!preGates.ok) return preGates.outcome;
  const { property } = preGates;

  const { data: config } = await supabase
    .from("ai_responder_configs")
    .select(
      "id, active, model, system_prompt, max_turns, min_confidence, escalation_keywords, business_hours_only, classifier_provider, classifier_mode",
    )
    .eq("org_id", property.org_id)
    .eq("active", true)
    .maybeSingle();

  // --------------------------------------------------------------------------
  // 2. Keyword gate (runs even without a config so we surface the right
  //    signal on lead detail regardless). If no config and no match,
  //    we'll skip below.
  // --------------------------------------------------------------------------
  const keywordEscalation = await applyKeywordEscalation(supabase, {
    propertyId: input.propertyId,
    inboundBody: input.inboundBody,
    escalationKeywords: config?.escalation_keywords ?? null,
  });

  if (keywordEscalation.escalated) {
    return { outcome: "escalated", reason: keywordEscalation.reason };
  }

  // --------------------------------------------------------------------------
  // 3. Skip classifier — consent, disabled, turn, biz-hours. No volume
  //    cap: provider/API credits are the only cap (Jarrad's standing rule).
  // --------------------------------------------------------------------------
  const consentState = await getConsentState(supabase, input.contactId, "sms");
  const currentTurn = await countAiTurnsInThread(
    supabase,
    input.propertyId,
    input.contactId,
    input.conversationId ?? null,
  );
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

  if (decision.skip) {
    // Classify/reply-eligibility decoupling (Jev workflow, 2026-09-20):
    // `decision.skip` governs whether Sandra may SEND an automated reply
    // (org-wide off, no consent, per-property AI-responder disabled —
    // a VA-controlled human-takeover kill switch, see
    // `setAiResponderDisabled` — or the reply-pacing gates: daily
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
      );
      if (outcome) return outcome;
      // use_legacy or jev_no_action — Jev had nothing actionable to
      // apply, so the original skip reason (reply-pacing, not a Jev
      // decision) still stands.
    }

    return { outcome: "skipped", reason: decision.reason };
  }

  if (input.conversationId) {
    const recentReply = await findRecentAiReplyInThread(
      supabase,
      input.conversationId,
      AI_REPLY_THREAD_DEBOUNCE_MS,
    );
    if (recentReply) {
      return { outcome: "skipped", reason: "duplicate_throttled" };
    }
  }

  const responseClaim = await claimAiResponse(supabase, {
    orgId: property.org_id,
    inboundMessageId: input.inboundMessageId,
    propertyId: input.propertyId,
    contactId: input.contactId,
    conversationId: input.conversationId ?? null,
  });
  if (!responseClaim.claimed) {
    return {
      outcome: "skipped",
      reason:
        responseClaim.reason === "already_replied"
          ? "already_replied"
          : "already_claimed",
    };
  }

  if (isIdentityQuestion(input.inboundBody)) {
    const safety = validateAiReplyBody(IDENTITY_REPLY_BODY);
    if (!safety.ok) {
      const reason = `safety:${safety.reason}`;
      await markPropertyNeedsAttention(supabase, input.propertyId, reason);
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: "escalated",
      });
      return { outcome: "escalated", reason };
    }
    const outcome = await sendResponderMessage(supabase, {
      input,
      body: IDENTITY_REPLY_BODY,
      model: config!.model,
      confidence: 1,
      sentiment: "neutral",
      turn: currentTurn + 1,
    });
    await completeAiResponseClaim(supabase, {
      claimId: responseClaim.claimId,
      outcome: outcome.outcome,
      outboundMessageId: outcome.outcome === "sent" ? outcome.messageId : null,
    });
    return outcome;
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
  const classificationResult = await classifyAndHandleNonRouteOutcomes(
    supabase,
    input,
    property,
    config,
    responseClaim,
  );
  if (classificationResult.handled) return classificationResult.outcome;
  const classification = classificationResult.classification;


  return resolveAndApplyRoute(
    supabase,
    input,
    property,
    { model: config!.model, system_prompt: config!.system_prompt, min_confidence: config!.min_confidence },
    deps,
    currentTurn,
    responseClaim,
    classification,
  );
}

/**
 * Runs Jev classification and, for the three outcomes that never touch
 * the reply pipeline (nurture, below-threshold/human-gated "needs a
 * decision", new_lead promotion), applies the effect and returns the
 * terminal outcome directly. Returns `handled: false` for
 * `use_legacy`/`jev_no_action` (nothing to apply here) or a `jev_route`
 * classification — the caller still resolves/applies that route itself
 * via `resolveAndApplyRoute`, kept separate because a `jev_route` MAY, in
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
 * had nothing to apply (`use_legacy`/`jev_no_action`) or — should never
 * happen for an actual Jev decision, defended anyway — a `jev_route`
 * whose route would have sent a reply.
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
  },
  currentTurn: number,
): Promise<AiDispatchOutcome | null> {
  const responseClaim = await claimAiResponse(supabase, {
    orgId: property.org_id,
    inboundMessageId: input.inboundMessageId,
    propertyId: input.propertyId,
    contactId: input.contactId,
    conversationId: input.conversationId ?? null,
  });
  if (!responseClaim.claimed) {
    return {
      outcome: "skipped",
      reason:
        responseClaim.reason === "already_replied"
          ? "already_replied"
          : "already_claimed",
    };
  }

  const classificationResult = await classifyAndHandleNonRouteOutcomes(
    supabase,
    input,
    property,
    config,
    responseClaim,
  );
  if (classificationResult.handled) return classificationResult.outcome;
  const classification = classificationResult.classification;

  if (classification.kind !== "jev_route") {
    // use_legacy or jev_no_action — nothing for Jev to apply; the
    // original reply-pacing skip reason stands (handled by the caller).
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
    await markPropertyNeedsAttention(supabase, input.propertyId, "jev_unexpected_send_route");
    await completeAiResponseClaim(supabase, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
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
    responseClaim,
    classification,
  );
}

async function classifyAndHandleNonRouteOutcomes(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  property: AiDispatchPropertyGateRow,
  config: { classifier_provider?: string | null; classifier_mode?: string | null } | null | undefined,
  responseClaim: { claimId: string | null },
): Promise<
  | { handled: true; outcome: AiDispatchOutcome }
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
    { fetch, typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "" },
  );

  if (classification.kind === "jev_nurture") {
    const nurtureResult = await setOutreachDispoNurture(supabase, input.propertyId);
    if (nurtureResult.ok) {
      await autoApplyJevLeadDecision(supabase, {
        propertyId: input.propertyId,
        conversationId: input.conversationId,
        inboundMessageId: input.inboundMessageId,
        classificationRunId: classification.classificationRunId,
        outcome: "nurture",
        nativeConfidence: classification.nativeConfidence,
        thresholdAtDecision: classification.thresholdAtDecision,
      });
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: "auto_closed",
      });
      return { handled: true, outcome: { outcome: "auto_closed", reason: "model:nurture" } };
    }
    if (nurtureResult.alreadyTerminal) {
      // Benign, not an error: something more specific than nurture is
      // already set (possibly by a human while Jev was classifying) —
      // nurture must never downgrade it. Skip silently, same treatment
      // as the legacy path's "already_terminal" RPC status.
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: "skipped",
      });
      return { handled: true, outcome: { outcome: "skipped", reason: "already_terminal" } };
    }
    await completeAiResponseClaim(supabase, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
      errorMessage: nurtureResult.error,
    });
    await markPropertyNeedsAttention(supabase, input.propertyId, "nurture_write_failed");
    return { handled: true, outcome: { outcome: "escalated", reason: "nurture_write_failed" } };
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
      });
    }
    await markPropertyNeedsAttention(supabase, input.propertyId, reason);
    await completeAiResponseClaim(supabase, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
    });
    return { handled: true, outcome: { outcome: "escalated", reason } };
  }

  if (classification.kind === "jev_promote_new_lead") {
    // new_lead at/above the org's configured threshold. Promote through
    // the same sanctioned primitive the legacy Haiku qualifier and manual
    // qualify actions use — never appointment booking, never a raw
    // properties.status write here.
    const qualifyOutcome = await qualifyProperty(
      supabase,
      input.propertyId,
      "system:jev_auto_promote",
    );
    if (qualifyOutcome.status === "qualified" || qualifyOutcome.status === "already_qualified") {
      await autoApplyJevLeadDecision(supabase, {
        propertyId: input.propertyId,
        conversationId: input.conversationId,
        inboundMessageId: input.inboundMessageId,
        classificationRunId: classification.classificationRunId,
        outcome: "new_lead",
        nativeConfidence: classification.nativeConfidence,
        thresholdAtDecision: classification.thresholdAtDecision,
      });
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: "auto_closed",
      });
      return { handled: true, outcome: { outcome: "auto_closed", reason: "model:new_lead_promoted" } };
    }
    // "failed" (including DNC-locked) or "not_found": never silently drop
    // a Jev-detected new lead — surface it for a human exactly like the
    // below-threshold case above, rather than treating a promotion failure
    // as a skip.
    const reason = "jev_new_lead_promotion_failed";
    if (qualifyOutcome.status === "failed") {
      reportError(new Error(qualifyOutcome.message), {
        tags: { surface: "ai_responder_jev_new_lead_promotion" },
        extra: { propertyId: input.propertyId },
      });
    }
    await markPropertyNeedsAttention(supabase, input.propertyId, reason);
    await completeAiResponseClaim(supabase, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
    });
    return { handled: true, outcome: { outcome: "escalated", reason } };
  }

  return { handled: false, classification };
}

async function resolveAndApplyRoute(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  property: AiDispatchPropertyGateRow,
  config: {
    model: string;
    system_prompt: string;
    min_confidence: number;
  },
  deps: { anthropic: AnthropicLike },
  currentTurn: number,
  responseClaim: { claimId: string | null },
  classification: ClassificationBridgeResult,
): Promise<AiDispatchOutcome> {
  let generated: AiStructuredOutput;
  let route: ResponderRoute;
  let jevAutoAccept: { classificationRunId: string } | null = null;

  if (classification.kind === "jev_route") {
    generated = classification.assembled;
    route = classification.route;
    if (classification.eligibleForAutoAccept) {
      jevAutoAccept = { classificationRunId: classification.classificationRunId };
    }
  } else {
    // use_legacy or jev_no_action — both fall through to the existing
    // combined Claude classify+generate call, unchanged from today.
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
      await markPropertyNeedsAttention(supabase, input.propertyId, reason);
      if (providerFailure) {
        await notifyAdminsOfProviderFailure(supabase, {
          orgId: property.org_id,
          propertyId: input.propertyId,
          failure: providerFailure,
        });
      }
      await completeAiResponseClaim(supabase, {
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
      await markPropertyNeedsAttention(supabase, input.propertyId, reason);
      await completeAiResponseClaim(supabase, {
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
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: "skipped",
      });
      return { outcome: "skipped", reason: "replayed_other_disposition" };
    }
  }
  if (
    route.kind === "send_reply" &&
    generated.confidence < config!.min_confidence
  ) {
    const reason = `low_confidence:${generated.confidence}`;
    await markPropertyNeedsAttention(supabase, input.propertyId, reason);
    await completeAiResponseClaim(supabase, {
      claimId: responseClaim.claimId,
      outcome: "escalated",
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
        });
      }
      await markPropertyNeedsAttention(
        supabase,
        input.propertyId,
        route.reason,
      );
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: "escalated",
      });
      return { outcome: "escalated", reason: route.reason };
    case "opt_out":
      const optOutResult = await applyResponderOptOut(supabase, {
        propertyId: input.propertyId,
        contactId: input.contactId,
        conversationId: input.conversationId ?? null,
        inboundMessageId: input.inboundMessageId ?? null,
        inboundFromPhone: input.inboundFromPhone ?? null,
        orgId: property.org_id,
        reason: route.reason,
      });
      if (!optOutResult.updated) {
        const outcome = closeOutcome(optOutResult, route.reason);
        await completeAiResponseClaim(supabase, {
          claimId: responseClaim.claimId,
          outcome: outcome.outcome,
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
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: "opted_out",
      });
      return { outcome: "opted_out", reason: route.reason };
    case "close_dnc": {
      // Jev-driven dnc: suppress now, defer the outreach_dispo write to
      // human confirmation (Option B, 2026-09-20). Legacy dnc is
      // completely unchanged — applyResponderDnc still applies
      // everything immediately, exactly as it does today.
      const isJevDnc = classification.kind === "jev_route";
      const dncResult = isJevDnc
        ? await proposeJevDncSuppression(supabase, {
            propertyId: input.propertyId,
            contactId: input.contactId,
            conversationId: input.conversationId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            inboundFromPhone: input.inboundFromPhone ?? null,
            orgId: property.org_id,
            reason: route.reason,
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
      const dncOutcome = closeOutcome(dncResult, route.reason);
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: dncOutcome.outcome,
        errorMessage: dispositionClaimError(dncResult),
      });
      return dncOutcome;
    }
    case "auto_close_wrong_number":
      const wrongNumberResult = await applyWrongNumber(supabase, {
        propertyId: input.propertyId,
        contactId: input.contactId,
        conversationId: input.conversationId ?? null,
        inboundMessageId: input.inboundMessageId ?? null,
        inboundFromPhone: input.inboundFromPhone ?? null,
        orgId: property.org_id,
        scope: route.scope,
        reason: route.reason,
      });
      const wrongNumberOutcome = closeOutcome(wrongNumberResult, route.reason);
      if (jevAutoAccept && wrongNumberResult.updated && input.inboundMessageId) {
        await maybeAutoAcceptJevReview(
          supabase,
          input.inboundMessageId,
          jevAutoAccept.classificationRunId,
        );
      }
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: wrongNumberOutcome.outcome,
        errorMessage: dispositionClaimError(wrongNumberResult),
      });
      return wrongNumberOutcome;
    case "auto_close":
      const autoCloseResult = await setResponderDispo(supabase, {
        propertyId: input.propertyId,
        conversationId: input.conversationId ?? null,
        inboundMessageId: input.inboundMessageId ?? null,
        dispo: route.dispo,
        reason: route.reason,
      });
      const autoCloseOutcome = closeOutcome(autoCloseResult, route.reason);
      if (jevAutoAccept && autoCloseResult.updated && input.inboundMessageId) {
        await maybeAutoAcceptJevReview(
          supabase,
          input.inboundMessageId,
          jevAutoAccept.classificationRunId,
        );
      }
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: autoCloseOutcome.outcome,
        errorMessage: dispositionClaimError(autoCloseResult),
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
        await markPropertyNeedsAttention(supabase, input.propertyId, reason);
        await completeAiResponseClaim(supabase, {
          claimId: responseClaim.claimId,
          outcome: "escalated",
        });
        return { outcome: "escalated", reason };
      }

      const sent = await sendResponderMessage(supabase, {
        input,
        body: bodyResult.body,
        model: config!.model,
        confidence: generated.confidence,
        sentiment: generated.sentiment,
        turn: currentTurn + 1,
      });
      if (sent.outcome !== "sent") {
        await completeAiResponseClaim(supabase, {
          claimId: responseClaim.claimId,
          outcome: sent.outcome,
        });
        return sent;
      }

      if (route.kind === "deescalate_close") {
        const closeResult = await setResponderDispo(supabase, {
          propertyId: input.propertyId,
          conversationId: input.conversationId ?? null,
          inboundMessageId: input.inboundMessageId ?? null,
          dispo: "not_interested",
          reason: route.reason,
        });
        const outcome = closeOutcome(closeResult, route.reason);
        await completeAiResponseClaim(supabase, {
          claimId: responseClaim.claimId,
          outcome: outcome.outcome,
          outboundMessageId: sent.messageId,
          errorMessage: dispositionClaimError(closeResult),
        });
        return outcome;
      }

      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: "sent",
        outboundMessageId: sent.messageId,
      });
      return sent;
    }
    default:
      return assertNeverRoute(route);
  }
}


async function findExistingAiReplyForInbound(
  supabase: SupabaseClient<Database>,
  inboundMessageId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .eq("channel", "sms")
    .eq("direction", "outbound")
    .contains("metadata", {
      generated_by: "ai_responder_v1",
      inbound_message_id: inboundMessageId,
    })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_existing_reply_lookup" },
      extra: { inboundMessageId },
    });
    return null;
  }
  return data ?? null;
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

async function findLatestInboundInThread(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
): Promise<{ id: string } | null> {
  let query = supabase
    .from("messages")
    .select("id")
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
    return null;
  }
  return data ?? null;
}

async function findRecentAiReplyInThread(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  windowMs: number,
): Promise<{ id: string } | null> {
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

  return (
    data?.find((reply) => {
      const effectiveTimestamp =
        reply.status === "pending"
          ? reply.created_at
          : (reply.sent_at ?? reply.created_at);
      return effectiveTimestamp >= cutoff;
    }) ?? null
  );
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

async function sendResponderMessage(
  supabase: SupabaseClient<Database>,
  args: {
    input: AiDispatchInput;
    body: string;
    model: string;
    confidence: number;
    sentiment: AiMessageMetadata["sentiment"];
    turn: number;
  },
): Promise<
  Extract<AiDispatchOutcome, { outcome: "sent" | "escalated" | "skipped" }>
> {
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
      await markPropertyNeedsAttention(supabase, args.input.propertyId, reason);
      return { outcome: "escalated", reason };
    }
  }
  const sendResult = await sendSmsToContact(supabase, {
    origin: "automated",
    contactId: args.input.contactId,
    propertyId: args.input.propertyId,
    body: args.body,
    from: inboundToPhone ?? undefined,
    to: args.input.inboundFromPhone ?? undefined,
    requireStickyFrom: true,
    metadata: args.input.inboundMessageId
      ? ({
          generated_by: "ai_responder_v1",
          inbound_message_id: args.input.inboundMessageId,
        } as Json)
      : null,
  });

  if (
    args.input.inboundMessageId &&
    sendResult.status === "db_error" &&
    isAiReplyDuplicateInsertError(sendResult.error)
  ) {
    const existingReply = await findExistingAiReplyForInbound(
      supabase,
      args.input.inboundMessageId,
    );
    if (existingReply) {
      return { outcome: "skipped", reason: "already_replied" };
    }
  }

  if (
    sendResult.status === "blocked_terminal_dispo" ||
    sendResult.status === "blocked_automated_suppressed"
  ) {
    return { outcome: "skipped", reason: "already_terminal" };
  }

  if (sendResult.status !== "sent" && sendResult.status !== "queued") {
    const reason = `send_blocked:${sendResult.status}`;
    await markPropertyNeedsAttention(supabase, args.input.propertyId, reason);
    return { outcome: "escalated", reason };
  }

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
      } as Json,
    })
    .eq("id", messageId);

  return { outcome: "sent", messageId, confidence: args.confidence };
}

async function setResponderDispo(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    dispo: "wrong_number" | "not_interested" | "opted_out" | "dnc";
    reason: string;
  },
): Promise<ResponderDispoResult> {
  if (!args.conversationId || !args.inboundMessageId) {
    const reason = "ai_disposition_missing_thread_identity";
    await markPropertyNeedsAttention(supabase, args.propertyId, reason);
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
      },
    );
    if (error) {
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
 * — see 20260920235450_jev_lead_decisions.sql). Best-effort: the caller's
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
  });
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "jev_lead_decision_propose" },
      extra: { propertyId: args.propertyId, outcome: args.outcome },
    });
  }
}

/**
 * Records an already-applied (auto-accepted) new_lead or nurture
 * decision, for the Review Jev audit view. Called AFTER the real effect
 * (qualifyProperty / setOutreachDispoNurture) already succeeded — same
 * "effect first, record second" ordering as maybeAutoAcceptJevReview.
 * Best-effort for the same reason: the effect already landed.
 */
async function autoApplyJevLeadDecision(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    conversationId: string | null | undefined;
    inboundMessageId: string | null | undefined;
    classificationRunId: string;
    outcome: "new_lead" | "nurture";
    nativeConfidence: number | null;
    thresholdAtDecision: number | null;
  },
): Promise<void> {
  if (!args.conversationId || !args.inboundMessageId) return;
  const { error } = await supabase.rpc("fn_auto_apply_jev_lead_decision", {
    p_property_id: args.propertyId,
    p_conversation_id: args.conversationId,
    p_source_inbound_message_id: args.inboundMessageId,
    p_classification_run_id: args.classificationRunId,
    p_outcome: args.outcome,
    p_native_confidence: args.nativeConfidence,
    p_threshold_at_decision: args.thresholdAtDecision,
  });
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "jev_lead_decision_auto_apply" },
      extra: { propertyId: args.propertyId, outcome: args.outcome },
    });
  }
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
async function setOutreachDispoNurture(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<
  | { ok: true }
  | { ok: false; alreadyTerminal: true }
  | { ok: false; alreadyTerminal: false; error: string }
> {
  try {
    await assertNotTrainingTarget(supabase, { propertyId });
  } catch (error) {
    return {
      ok: false,
      alreadyTerminal: false,
      error: error instanceof Error ? error.message : "Training eligibility could not be verified.",
    };
  }

  const { data: prop, error: propErr } = await supabase
    .from("properties")
    .select("id, outreach_dispo")
    .eq("id", propertyId)
    .maybeSingle();
  if (propErr || !prop) {
    return { ok: false, alreadyTerminal: false, error: propErr?.message ?? "Property not found" };
  }

  if (prop.outreach_dispo !== null && prop.outreach_dispo !== "nurture") {
    return { ok: false, alreadyTerminal: true };
  }
  if (prop.outreach_dispo === "nurture") {
    return { ok: true }; // idempotent — already in the target state
  }

  const { error: updateErr, data: updated } = await supabase
    .from("properties")
    .update({
      outreach_dispo: "nurture",
      follow_up_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", propertyId)
    .is("outreach_dispo", null) // re-checked at write time, not just read time
    .select("id")
    .maybeSingle();
  if (updateErr) return { ok: false, alreadyTerminal: false, error: updateErr.message };
  if (!updated) {
    // Changed between our SELECT and this UPDATE — treat as terminal
    // rather than retrying, since we don't know what it changed TO.
    return { ok: false, alreadyTerminal: true };
  }

  await recordLeadEvent({
    propertyId,
    actorType: "ai",
    eventType: LEAD_EVENT_TYPES.DISPO_SET,
    payload: { from: null, to: "nurture", reason: "model:nurture" },
  });
  return { ok: true };
}

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
  });
  return result;
}

/**
 * Astra PR review finding (2026-09-20, BLOCKING) + Jarrad's "Option B"
 * resolution: for a Jev-driven dnc decision (never for legacy — that
 * path is unchanged, `applyResponderDnc` above), suppress the phone
 * immediately (same `applyPhoneLevelOptOut` call, same as legacy — the
 * safety-critical part doesn't wait), but do NOT write
 * `properties.outreach_dispo='dnc'` yet. That write is deferred to a
 * human via `fn_confirm_ai_disposition_review`
 * (`20260920120000_sms_classification_runs.sql`'s extension of it) —
 * the actual disposition/paperwork side of a DNC decision, as opposed
 * to the immediate stop-texting safety action, is what waits for
 * confirmation.
 */
async function proposeJevDncSuppression(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    contactId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    inboundFromPhone: string | null;
    orgId: string;
    reason: string;
  },
): Promise<ResponderDispoResult> {
  if (!args.conversationId || !args.inboundMessageId) {
    const reason = "ai_disposition_missing_thread_identity";
    await markPropertyNeedsAttention(supabase, args.propertyId, reason);
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
      p_ai_reason: args.reason,
    },
  );
  if (error) {
    await markPropertyNeedsAttention(supabase, args.propertyId, "dnc_proposal_write_failed");
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_propose_dnc" },
      extra: { propertyId: args.propertyId, reason: args.reason },
    });
    return { updated: false, reason: "db_error" };
  }

  const status = readAiDispositionRpcStatus(data);
  if (status === "already_terminal") return { updated: false, reason: "already_terminal" };
  // "proposed" and "replayed" both mean suppression + a pending review
  // now exist — the phone is stopped, which is what `updated: true`
  // signals to the caller. The disposition write itself is intentionally
  // still pending, not reflected in this boolean.
  return { updated: true };
}

async function applyWrongNumber(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    contactId: string;
    conversationId: string | null;
    inboundMessageId: string | null;
    inboundFromPhone: string | null;
    orgId: string;
    scope: AiWrongScope;
    reason: string;
  },
): Promise<ResponderDispoResult> {
  const result = await setResponderDispo(supabase, {
    propertyId: args.propertyId,
    conversationId: args.conversationId,
    inboundMessageId: args.inboundMessageId,
    dispo: "wrong_number",
    reason: args.reason,
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
    return { outcome: "skipped", reason: "already_terminal" };
  }
  if (result.reason === "replayed_other_disposition") {
    return { outcome: "skipped", reason: "replayed_other_disposition" };
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
): Promise<void> {
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
    return;
  }
  if (updated) {
    await recordLeadEvent({
      propertyId,
      actorType: "ai",
      eventType: LEAD_EVENT_TYPES.AI_ESCALATED,
      payload: { from: false, to: true, reason },
    });
  }
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
): Promise<number> {
  let query = supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .eq("direction", "outbound")
    .contains("metadata", { generated_by: "ai_responder_v1" });
  query = conversationId
    ? query.eq("conversation_id", conversationId)
    : query.eq("contact_id", contactId);
  const { count } = await query;
  return count ?? 0;
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
