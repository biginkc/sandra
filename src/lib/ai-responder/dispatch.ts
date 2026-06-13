import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { getConsentState } from "@/lib/messaging/consent";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import { sendSmsToContact } from "@/lib/messaging/send";
import type { Database, Json } from "@/lib/supabase/types";

import { listAdminUserIds } from "@/lib/auth/admins";
import { createNotification } from "@/lib/notifications/dispatch";

import { classifyAiSkip } from "./classify";
import {
  classifyProviderFailure,
  generateAiReply,
  type AnthropicLike,
} from "./generate";
import { humanizeReply } from "./humanize";
import { matchEscalationKeyword } from "./keywords";
import { validateAiReplyBody } from "./safety";
import type { AiMessageMetadata } from "./types";

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
  | { outcome: "skipped"; reason: string };

export type AiDispatchInput = {
  propertyId: string;
  contactId: string;
  conversationId?: string | null;
  inboundBody: string;
  inboundMessageId?: string | null;
};

const AI_REPLY_THREAD_DEBOUNCE_MS = 45_000;
const AI_REPLY_THREAD_DEBOUNCE_SECONDS = AI_REPLY_THREAD_DEBOUNCE_MS / 1000;
const AI_REPLY_THREAD_BUSY_WAIT_MS = AI_REPLY_THREAD_DEBOUNCE_MS;
const AI_REPLY_THREAD_BUSY_POLL_MS = 200;

export async function dispatchAiResponse(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  deps: {
    anthropic: AnthropicLike;
    debounceBusyPollMs?: number;
    debounceBusyWaitMs?: number;
  },
): Promise<AiDispatchOutcome> {
  if (input.inboundMessageId) {
    const existingReply = await findExistingAiReplyForInbound(
      supabase,
      input.inboundMessageId,
    );
    if (existingReply) {
      return { outcome: "skipped", reason: "already_replied" };
    }
  }

  // --------------------------------------------------------------------------
  // 1. Load property + org + config
  // --------------------------------------------------------------------------
  const { data: property } = await supabase
    .from("properties")
    .select("id, org_id, state, ai_responder_disabled")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (!property) {
    return { outcome: "skipped", reason: "property_not_found" };
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
  const keywordMatch = matchEscalationKeyword(input.inboundBody, {
    allowedPhrases: config?.escalation_keywords ?? undefined,
  });

  if (keywordMatch) {
    const reason = `keyword:${keywordMatch.tier}`;
    await markPropertyNeedsAttention(supabase, input.propertyId, reason);
    return { outcome: "escalated", reason };
  }

  const conversationId = input.conversationId ?? null;
  if (conversationId) {
    const syncError = await syncAiThreadConversationId(supabase, {
      contactId: input.contactId,
      conversationId,
      orgId: property.org_id,
      propertyId: input.propertyId,
    });
    if (syncError) {
      const reason = "thread_conversation_sync_error";
      await markPropertyNeedsAttention(supabase, input.propertyId, reason);
      return { outcome: "escalated", reason };
    }
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
    conversationId,
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

  if (conversationId) {
    const recentReply = await findRecentAiReplyInThread(
      supabase,
      conversationId,
      AI_REPLY_THREAD_DEBOUNCE_MS,
    );
    if (recentReply) {
      return { outcome: "skipped", reason: "duplicate_throttled" };
    }
  }

  let debounceClaimToken: string | null = null;
  let releaseDebounceClaim = false;

  try {
    if (conversationId) {
      const claim = await acquireAiReplyThreadDebounce(
        supabase,
        conversationId,
        {
          pollMs: deps.debounceBusyPollMs ?? AI_REPLY_THREAD_BUSY_POLL_MS,
          waitMs: deps.debounceBusyWaitMs ?? AI_REPLY_THREAD_BUSY_WAIT_MS,
        },
      );
      if (claim.status === "duplicate") {
        return { outcome: "skipped", reason: "duplicate_throttled" };
      }
      if (claim.status === "busy_timeout") {
        const reason = "thread_debounce_timeout";
        await markPropertyNeedsAttention(supabase, input.propertyId, reason);
        return { outcome: "escalated", reason };
      }
      if (claim.status === "error") {
        const reason = "thread_debounce_error";
        await markPropertyNeedsAttention(supabase, input.propertyId, reason);
        return { outcome: "escalated", reason };
      }
      if (claim.status === "claimed") {
        debounceClaimToken = claim.token;
        releaseDebounceClaim = true;
      }
    }

    // ------------------------------------------------------------------------
    // 4. Generate via Claude
    // ------------------------------------------------------------------------
    const conversation = await loadConversation(
      supabase,
      input.propertyId,
      input.contactId,
      conversationId,
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
      return { outcome: "escalated", reason };
    }

    // ------------------------------------------------------------------------
    // 5. Escalation gates on model output
    // ------------------------------------------------------------------------
    if (generated.action === "escalate") {
      const reason = `model:${generated.escalation_reason ?? "unspecified"}`;
      await markPropertyNeedsAttention(supabase, input.propertyId, reason);
      return { outcome: "escalated", reason };
    }

    if (generated.confidence < config!.min_confidence) {
      const reason = `low_confidence:${generated.confidence}`;
      await markPropertyNeedsAttention(supabase, input.propertyId, reason);
      return { outcome: "escalated", reason };
    }

    if (
      generated.sentiment === "frustrated" ||
      generated.sentiment === "hostile"
    ) {
      const reason = `sentiment:${generated.sentiment}`;
      await markPropertyNeedsAttention(supabase, input.propertyId, reason);
      return { outcome: "escalated", reason };
    }

    // ------------------------------------------------------------------------
    // 6. Humanizer second-pass — strips AI-tells the first-pass let through
    //    (em-dashes, AI vocabulary, formal-ish phrasing). Falls back to the
    //    original draft on any error so this NEVER blocks a send.
    // ------------------------------------------------------------------------
    const draft = generated.body?.trim() ?? "";
    const body = draft
      ? await humanizeReply(
          { draft, model: config!.model },
          { client: deps.anthropic },
        )
      : draft;

    // ------------------------------------------------------------------------
    // 7. Safety validator on the (humanized) body — defense in depth.
    // ------------------------------------------------------------------------
    const safety = validateAiReplyBody(body);
    if (!safety.ok) {
      const reason = `safety:${safety.reason}`;
      await markPropertyNeedsAttention(supabase, input.propertyId, reason);
      return { outcome: "escalated", reason };
    }

    // ------------------------------------------------------------------------
    // 8. Send via the existing pipeline (enforces quiet hours + consent
    //    one more time at send time). Stamp AI metadata on the row.
    // ------------------------------------------------------------------------
    const sendResult = await sendSmsToContact(supabase, {
      contactId: input.contactId,
      propertyId: input.propertyId,
      conversationId,
      body,
      metadata: input.inboundMessageId
        ? ({
            generated_by: "ai_responder_v1",
            inbound_message_id: input.inboundMessageId,
          } as Json)
        : null,
    });

    if (
      input.inboundMessageId &&
      sendResult.status === "db_error" &&
      isAiReplyDuplicateInsertError(sendResult.error)
    ) {
      const existingReply = await findExistingAiReplyForInbound(
        supabase,
        input.inboundMessageId,
      );
      if (existingReply) {
        return { outcome: "skipped", reason: "already_replied" };
      }
    }

    if (sendResult.status !== "sent" && sendResult.status !== "queued") {
      // Pipeline rejected (quiet-hours race, no phone, etc.). Escalate so
      // a human picks it up.
      const reason = `send_blocked:${sendResult.status}`;
      await markPropertyNeedsAttention(supabase, input.propertyId, reason);
      return { outcome: "escalated", reason };
    }

    const messageId = sendResult.messageId;
    const metadata: AiMessageMetadata = {
      generated_by: "ai_responder_v1",
      ...(input.inboundMessageId
        ? { inbound_message_id: input.inboundMessageId }
        : {}),
      model: config!.model,
      confidence: generated.confidence,
      sentiment: generated.sentiment,
      turn: currentTurn + 1,
    };
    const { data: messageRow, error: messageLookupError } = await supabase
      .from("messages")
      .select("metadata")
      .eq("id", messageId)
      .maybeSingle();
    if (messageLookupError) {
      reportError(new Error(messageLookupError.message), {
        tags: { surface: "ai_responder_message_metadata_lookup" },
        extra: { messageId, inboundMessageId: input.inboundMessageId ?? null },
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

    releaseDebounceClaim = false;
    return { outcome: "sent", messageId, confidence: generated.confidence };
  } finally {
    if (conversationId && debounceClaimToken && releaseDebounceClaim) {
      await releaseAiReplyThreadDebounce(
        supabase,
        conversationId,
        debounceClaimToken,
      );
    }
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

type AiReplyThreadDebounceClaim =
  | { status: "claimed"; token: string }
  | { status: "duplicate" }
  | { status: "busy" }
  | { status: "busy_timeout" }
  | { status: "unavailable" }
  | { status: "error" };

type AiReplyThreadDebounceClaimRow = {
  status?: string;
  token?: string | null;
};

async function claimAiReplyThreadDebounce(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  windowSeconds: number,
): Promise<AiReplyThreadDebounceClaim> {
  const { data, error } = await supabase.rpc(
    "claim_ai_responder_thread_debounce",
    {
      p_conversation_id: conversationId,
      p_window_seconds: windowSeconds,
    },
  );
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_thread_debounce_claim" },
      extra: { conversationId, windowSeconds, code: error.code ?? null },
    });
    if (isAiReplyThreadDebounceCompatibilityError(error)) {
      return { status: "unavailable" };
    }
    return { status: "error" };
  }

  const claim = readAiReplyThreadDebounceClaim(data);
  if (!claim) {
    reportError(new Error("invalid ai responder thread debounce claim payload"), {
      tags: { surface: "ai_responder_thread_debounce_claim_payload" },
      extra: { conversationId },
    });
    return { status: "error" };
  }

  if (claim.status === "claimed" && claim.token) {
    return { status: "claimed", token: claim.token };
  }
  if (claim.status === "duplicate") {
    return { status: "duplicate" };
  }
  if (claim.status === "busy") {
    return { status: "busy" };
  }
  if (claim.status === "unavailable") {
    return { status: "unavailable" };
  }
  return { status: "error" };
}

async function releaseAiReplyThreadDebounce(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  claimToken: string,
): Promise<void> {
  const { error } = await supabase.rpc(
    "release_ai_responder_thread_debounce",
    {
      p_claim_token: claimToken,
      p_conversation_id: conversationId,
    },
  );
  if (!error) return;

  reportError(new Error(error.message), {
    tags: { surface: "ai_responder_thread_debounce_release" },
    extra: { conversationId, code: error.code ?? null },
  });

  const { error: fallbackError } = await supabase
    .from("message_threads")
    .update({
      ai_responder_debounce_token: null,
      ai_responder_debounce_until: null,
    })
    .eq("conversation_id", conversationId)
    .eq("ai_responder_debounce_token", claimToken);
  if (fallbackError) {
    reportError(new Error(fallbackError.message), {
      tags: { surface: "ai_responder_thread_debounce_release_fallback" },
      extra: { conversationId },
    });
  }
}

async function acquireAiReplyThreadDebounce(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  timing: {
    pollMs: number;
    waitMs: number;
  },
): Promise<AiReplyThreadDebounceClaim> {
  const deadline = Date.now() + timing.waitMs;

  while (true) {
    const claim = await claimAiReplyThreadDebounce(
      supabase,
      conversationId,
      AI_REPLY_THREAD_DEBOUNCE_SECONDS,
    );

    if (claim.status === "claimed" || claim.status === "duplicate") {
      return claim;
    }

    if (claim.status === "unavailable" || claim.status === "error") {
      return claim;
    }

    if (Date.now() >= deadline) {
      const recentReply = await findRecentAiReplyInThread(
        supabase,
        conversationId,
        AI_REPLY_THREAD_DEBOUNCE_MS,
      );
      return recentReply
        ? { status: "duplicate" }
        : { status: "busy_timeout" };
    }

    await wait(timing.pollMs);

    const recentReply = await findRecentAiReplyInThread(
      supabase,
      conversationId,
      AI_REPLY_THREAD_DEBOUNCE_MS,
    );
    if (recentReply) {
      return { status: "duplicate" };
    }
  }
}

// ---------- helpers ---------------------------------------------------------

function readAiReplyThreadDebounceClaim(
  value: Json | null,
): AiReplyThreadDebounceClaimRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const claim = value as Record<string, Json>;
  return {
    status: typeof claim.status === "string" ? claim.status : undefined,
    token: typeof claim.token === "string" ? claim.token : null,
  };
}

function isAiReplyThreadDebounceCompatibilityError(error: {
  code?: string | null;
  message: string;
}): boolean {
  return (
    error.code === "PGRST202" ||
    error.code === "42703" ||
    error.message.includes(
      "Could not find the function public.claim_ai_responder_thread_debounce",
    ) ||
    error.message.includes("ai_responder_debounce_")
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncAiThreadConversationId(
  supabase: SupabaseClient<Database>,
  input: {
    contactId: string;
    conversationId: string;
    orgId: string;
    propertyId: string;
  },
): Promise<string | null> {
  const ownership = await validateConversationThreadOwnership(supabase, {
    contactId: input.contactId,
    conversationId: input.conversationId,
    orgId: input.orgId,
    propertyId: input.propertyId,
  });
  if (ownership.error) {
    return ownership.error;
  }

  if (
    ownership.currentConversationId &&
    ownership.currentConversationId !== input.conversationId
  ) {
    const { error: rebindError } = await supabase
      .from("messages")
      .update({
        conversation_id: input.conversationId,
      })
      .eq("channel", "sms")
      .eq("contact_id", input.contactId)
      .eq("property_id", input.propertyId)
      .eq("conversation_id", ownership.currentConversationId);
    if (rebindError) {
      return rebindError.message;
    }
  }

  const { error } = await supabase.from("message_threads").upsert(
    {
      org_id: input.orgId,
      channel: "sms",
      contact_id: input.contactId,
      property_id: input.propertyId,
      conversation_id: input.conversationId,
    },
    { onConflict: "channel,contact_id,property_id" },
  );
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_thread_conversation_sync" },
      extra: {
        contactId: input.contactId,
        conversationId: input.conversationId,
        propertyId: input.propertyId,
      },
    });
    return error.message;
  }
  return null;
}

async function validateConversationThreadOwnership(
  supabase: SupabaseClient<Database>,
  input: {
    contactId: string;
    conversationId: string;
    orgId: string;
    propertyId: string;
  },
): Promise<{
  currentConversationId: string | null;
  error: string | null;
}> {
  const { data: currentThread, error: currentThreadError } = await supabase
    .from("message_threads")
    .select("conversation_id")
    .eq("channel", "sms")
    .eq("contact_id", input.contactId)
    .eq("property_id", input.propertyId)
    .maybeSingle();
  if (currentThreadError) {
    return { currentConversationId: null, error: currentThreadError.message };
  }

  let ownerFound = currentThread?.conversation_id === input.conversationId;
  const { data: messageRow, error: messageError } = await supabase
    .from("messages")
    .select("contact_id, property_id")
    .eq("conversation_id", input.conversationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (messageError) {
    return {
      currentConversationId: currentThread?.conversation_id ?? null,
      error: messageError.message,
    };
  }
  if (
    messageRow &&
    (messageRow.contact_id !== input.contactId ||
      messageRow.property_id !== input.propertyId)
  ) {
    return {
      currentConversationId: currentThread?.conversation_id ?? null,
      error: "conversation belongs to another thread",
    };
  }
  ownerFound ||= Boolean(messageRow);

  const { data: threadRow, error: threadError } = await supabase
    .from("message_threads")
    .select("org_id, contact_id, property_id")
    .eq("conversation_id", input.conversationId)
    .limit(1)
    .maybeSingle();
  if (threadError) {
    return {
      currentConversationId: currentThread?.conversation_id ?? null,
      error: threadError.message,
    };
  }
  if (
    threadRow &&
    (threadRow.org_id !== input.orgId ||
      threadRow.contact_id !== input.contactId ||
      threadRow.property_id !== input.propertyId)
  ) {
    return {
      currentConversationId: currentThread?.conversation_id ?? null,
      error: "conversation belongs to another thread",
    };
  }
  ownerFound ||= Boolean(threadRow);

  if (!ownerFound) {
    return {
      currentConversationId: currentThread?.conversation_id ?? null,
      error: "conversation has no existing owner",
    };
  }

  return {
    currentConversationId: currentThread?.conversation_id ?? null,
    error: null,
  };
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
    .eq("channel", "sms")
    .eq("property_id", propertyId)
    .eq("direction", "outbound")
    .in("status", ["sent", "queued"])
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
