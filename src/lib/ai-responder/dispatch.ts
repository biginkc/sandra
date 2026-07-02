import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { applyPhoneLevelOptOut } from "@/lib/messaging/opt-out-phone";
import { getConsentState } from "@/lib/messaging/consent";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import { sendSmsToContact } from "@/lib/messaging/send";
import { selectBestSmsPhone } from "@/lib/messaging/sms-phone";
import { SUPPRESSED_DISPOS } from "@/lib/messaging/suppression";
import { pausePropertyEnrollments } from "@/lib/sequences/enrollment";
import type { Database, Json } from "@/lib/supabase/types";

import { listAdminUserIds } from "@/lib/auth/admins";
import { createNotification } from "@/lib/notifications/dispatch";

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
import type { AiMessageMetadata, AiWrongScope } from "./types";

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
  inboundBody: string;
  inboundMessageId?: string | null;
};

const AI_REPLY_THREAD_DEBOUNCE_MS = 45_000;
const HUMAN_ONLY_DISPOS = new Set(["nurture", "callback_requested"]);

const DEESCALATION_TEMPLATE_WITH_NAME =
  "So sorry to bug you. Sounds like you get a lot of these. Are you {first_name}? Just want to make sure we don't bother you again.";
const DEESCALATION_TEMPLATE_GENERIC =
  "So sorry to bug you. Sounds like you get a lot of these. Are you the owner here? Want to make sure we don't bother you again.";

type ResponderDispoResult =
  | { updated: true }
  | { updated: false; reason: "already_terminal" | "db_error" };

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

export async function dispatchAiResponse(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  deps: { anthropic: AnthropicLike },
): Promise<AiDispatchOutcome> {
  if (input.inboundMessageId) {
    const existingReply = await findExistingAiReplyForInbound(
      supabase,
      input.inboundMessageId,
    );
    if (existingReply) {
      return { outcome: "skipped", reason: "already_replied" };
    }

    const latestInbound = await findLatestInboundInThread(supabase, input);
    if (latestInbound && latestInbound.id !== input.inboundMessageId) {
      return { outcome: "skipped", reason: "superseded_by_newer_inbound" };
    }
  }

  // --------------------------------------------------------------------------
  // 1. Load property + org + config
  // --------------------------------------------------------------------------
  const { data: property } = await supabase
    .from("properties")
    .select("id, org_id, state, ai_responder_disabled, outreach_dispo, needs_human_attention, homeowner_contact_id")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (!property) {
    return { outcome: "skipped", reason: "property_not_found" };
  }
  if (
    property.needs_human_attention ||
    (property.outreach_dispo &&
      (SUPPRESSED_DISPOS.has(
        property.outreach_dispo as Parameters<typeof SUPPRESSED_DISPOS.has>[0],
      ) ||
        HUMAN_ONLY_DISPOS.has(property.outreach_dispo)))
  ) {
    return { outcome: "skipped", reason: "already_terminal" };
  }

  const { data: config } = await supabase
    .from("ai_responder_configs")
    .select(
      "id, active, model, system_prompt, max_turns, min_confidence, escalation_keywords, business_hours_only",
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
  // 4. Generate via Claude
  // --------------------------------------------------------------------------
  const conversation = await loadConversation(
    supabase,
    input.propertyId,
    input.contactId,
    input.conversationId ?? null,
  );
  // Append the current inbound body (it was just inserted by the
  // webhook; include it explicitly so the model sees it).
  conversation.push({ role: "user", content: input.inboundBody });

  let generated;
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

  const route = resolveResponderOutcome(generated);
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
      await markPropertyNeedsAttention(supabase, input.propertyId, route.reason);
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: "escalated",
      });
      return { outcome: "escalated", reason: route.reason };
    case "opt_out":
      const optOutResult = await applyResponderOptOut(supabase, {
        propertyId: input.propertyId,
        contactId: input.contactId,
        inboundFromPhone: input.inboundFromPhone ?? null,
        orgId: property.org_id,
        reason: route.reason,
      });
      if (!optOutResult.updated) {
        const outcome = closeOutcome(optOutResult, route.reason);
        await completeAiResponseClaim(supabase, {
          claimId: responseClaim.claimId,
          outcome: outcome.outcome,
        });
        return outcome;
      }
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: "opted_out",
      });
      return { outcome: "opted_out", reason: route.reason };
    case "close_dnc":
      const dncResult = await applyResponderDnc(supabase, {
        propertyId: input.propertyId,
        contactId: input.contactId,
        inboundFromPhone: input.inboundFromPhone ?? null,
        orgId: property.org_id,
        reason: route.reason,
      });
      const dncOutcome = closeOutcome(dncResult, route.reason);
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: dncOutcome.outcome,
      });
      return dncOutcome;
    case "auto_close_wrong_number":
      const wrongNumberResult = await applyWrongNumber(supabase, {
        propertyId: input.propertyId,
        contactId: input.contactId,
        inboundFromPhone: input.inboundFromPhone ?? null,
        orgId: property.org_id,
        scope: route.scope,
        reason: route.reason,
      });
      const wrongNumberOutcome = closeOutcome(wrongNumberResult, route.reason);
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: wrongNumberOutcome.outcome,
      });
      return wrongNumberOutcome;
    case "auto_close":
      const autoCloseResult = await setResponderDispo(supabase, {
        propertyId: input.propertyId,
        dispo: route.dispo,
        reason: route.reason,
      });
      const autoCloseOutcome = closeOutcome(autoCloseResult, route.reason);
      await completeAiResponseClaim(supabase, {
        claimId: responseClaim.claimId,
        outcome: autoCloseOutcome.outcome,
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
          dispo: "not_interested",
          reason: route.reason,
        });
        const outcome = closeOutcome(closeResult, route.reason);
        await completeAiResponseClaim(supabase, {
          claimId: responseClaim.claimId,
          outcome: outcome.outcome,
          outboundMessageId: sent.messageId,
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
          : reply.sent_at ?? reply.created_at;
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
): Promise<Extract<AiDispatchOutcome, { outcome: "sent" | "escalated" | "skipped" }>> {
  const sendResult = await sendSmsToContact(supabase, {
    contactId: args.input.contactId,
    propertyId: args.input.propertyId,
    body: args.body,
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

  if (sendResult.status === "blocked_terminal_dispo") {
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
    dispo: "wrong_number" | "not_interested" | "opted_out" | "dnc";
    reason: string;
  },
): Promise<ResponderDispoResult> {
  const { data: current, error: currentError } = await supabase
    .from("properties")
    .select("outreach_dispo, needs_human_attention")
    .eq("id", args.propertyId)
    .maybeSingle();
  if (currentError) {
    reportError(new Error(currentError.message), {
      tags: { surface: "ai_responder_dispo_read" },
      extra: { propertyId: args.propertyId, reason: args.reason },
    });
    return { updated: false, reason: "db_error" };
  }
  if (!shouldUpdateDispo(current?.outreach_dispo ?? null, args.dispo)) {
    return { updated: false, reason: "already_terminal" };
  }
  if (current?.needs_human_attention) {
    return { updated: false, reason: "already_terminal" };
  }

  const now = new Date().toISOString();
  const allowedCurrentDispos = allowedCurrentDisposFor(args.dispo);
  const { data: updated, error } = await supabase
    .from("properties")
    .update({
      outreach_dispo: args.dispo,
      needs_human_attention: false,
      last_ai_escalation_reason: null,
      updated_at: now,
    })
    .eq("id", args.propertyId)
    .eq("needs_human_attention", false)
    .or(
      `outreach_dispo.is.null,outreach_dispo.in.(${allowedCurrentDispos.join(",")})`,
    )
    .select("id")
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_set_dispo" },
      extra: { propertyId: args.propertyId, dispo: args.dispo, reason: args.reason },
    });
    return { updated: false, reason: "db_error" };
  }
  if (!updated) {
    return { updated: false, reason: "already_terminal" };
  }

  if (args.dispo === "wrong_number") {
    await pausePropertyEnrollments(supabase, {
      propertyId: args.propertyId,
      reason: "inbound_reply",
      permanent: false,
    });
  }
  return { updated: true };
}

async function applyResponderOptOut(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    contactId: string;
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
  });
  const result = await setResponderDispo(supabase, {
    propertyId: args.propertyId,
    dispo: "opted_out",
    reason: args.reason,
  });
  if (!result.updated && result.reason === "db_error") {
    throw new Error("ai_responder opt-out disposition write failed");
  }
  return result;
}

async function applyResponderDnc(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    contactId: string;
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
  });
  const result = await setResponderDispo(supabase, {
    propertyId: args.propertyId,
    dispo: "dnc",
    reason: args.reason,
  });
  if (!result.updated && result.reason === "db_error") {
    throw new Error("ai_responder dnc disposition write failed");
  }
  return result;
}

async function applyWrongNumber(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    contactId: string;
    inboundFromPhone: string | null;
    orgId: string;
    scope: AiWrongScope;
    reason: string;
  },
): Promise<ResponderDispoResult> {
  const result = await setResponderDispo(supabase, {
    propertyId: args.propertyId,
    dispo: "wrong_number",
    reason: args.reason,
  });
  if (args.scope !== "all") return result;
  if (!result.updated && result.reason === "db_error") return result;

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
  });
  return result;
}

async function loadContactPhone(
  supabase: SupabaseClient<Database>,
  contactId: string,
): Promise<{ phone: string | null; firstName: string | null }> {
  const { data, error } = await supabase
    .from("contacts")
    .select("phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, first_name")
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
): Extract<AiDispatchOutcome, { outcome: "auto_closed" | "skipped" | "escalated" }> {
  if (result.updated) {
    return { outcome: "auto_closed", reason };
  }
  if (result.reason === "already_terminal") {
    return { outcome: "skipped", reason: "already_terminal" };
  }
  return { outcome: "escalated", reason: "disposition_write_failed" };
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

function shouldUpdateDispo(
  current: string | null,
  next: "wrong_number" | "not_interested" | "opted_out" | "dnc",
): boolean {
  const severity: Record<string, number> = {
    not_interested: 1,
    wrong_number: 2,
    opted_out: 3,
    dnc: 4,
  };
  if (
    next !== "opted_out" &&
    next !== "dnc" &&
    current !== null &&
    (HUMAN_ONLY_DISPOS.has(current) || current === "bad_number")
  ) {
    return false;
  }
  return (severity[next] ?? 0) >= (current ? (severity[current] ?? 0) : 0);
}

function allowedCurrentDisposFor(
  next: "wrong_number" | "not_interested" | "opted_out" | "dnc",
): string[] {
  switch (next) {
    case "not_interested":
      return ["not_interested"];
    case "wrong_number":
      return ["not_interested", "wrong_number"];
    case "opted_out":
      return ["not_interested", "wrong_number", "opted_out"];
    case "dnc":
      return ["not_interested", "wrong_number", "opted_out", "dnc"];
  }
}

function assertNeverRoute(value: never): never {
  throw new Error(`Unhandled responder route: ${JSON.stringify(value)}`);
}

async function markPropertyNeedsAttention(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("properties")
    .update({
      needs_human_attention: true,
      last_ai_escalation_reason: reason,
      last_ai_escalation_at: now,
      updated_at: now,
    })
    .eq("id", propertyId);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_mark_attention" },
      extra: { propertyId, reason },
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
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
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
