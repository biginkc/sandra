import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { getConsentState } from "@/lib/messaging/consent";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import { sendSmsToContact } from "@/lib/messaging/send";
import type { Database, Json } from "@/lib/supabase/types";

import { classifyAiSkip } from "./classify";
import { generateAiReply, type AnthropicLike } from "./generate";
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
 * cap-exceeded, outside-business-hours) just return silently.
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
  inboundBody: string;
};

export async function dispatchAiResponse(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  deps: { anthropic: AnthropicLike },
): Promise<AiDispatchOutcome> {
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
      "id, active, model, system_prompt, max_turns, min_confidence, escalation_keywords, business_hours_only, daily_send_cap",
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

  // --------------------------------------------------------------------------
  // 3. Skip classifier — consent, disabled, cap, turn, biz-hours
  // --------------------------------------------------------------------------
  const consentState = await getConsentState(supabase, input.contactId, "sms");
  const currentTurn = await countAiTurnsInThread(
    supabase,
    input.propertyId,
  );
  const orgSendsToday = await countAiSendsLast24h(supabase, property.org_id);
  const withinBusinessHours = checkQuietHours(property.state).ok;

  const decision = classifyAiSkip({
    config: config
      ? {
          active: config.active,
          business_hours_only: config.business_hours_only,
          max_turns: config.max_turns,
          daily_send_cap: config.daily_send_cap,
        }
      : null,
    consentState,
    propertyDisabled: property.ai_responder_disabled,
    currentTurn,
    orgSendsToday,
    withinBusinessHours,
  });

  if (decision.skip) {
    return { outcome: "skipped", reason: decision.reason };
  }

  // --------------------------------------------------------------------------
  // 4. Generate via Claude
  // --------------------------------------------------------------------------
  const conversation = await loadConversation(supabase, input.propertyId);
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
    reportError(e, {
      tags: { surface: "ai_responder_generate" },
      extra: { propertyId: input.propertyId },
    });
    await markPropertyNeedsAttention(supabase, input.propertyId, "generate_error");
    return { outcome: "escalated", reason: "generate_error" };
  }

  // --------------------------------------------------------------------------
  // 5. Escalation gates on model output
  // --------------------------------------------------------------------------
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

  // --------------------------------------------------------------------------
  // 6. Safety validator on the body (defense in depth)
  // --------------------------------------------------------------------------
  const body = generated.body?.trim() ?? "";
  const safety = validateAiReplyBody(body);
  if (!safety.ok) {
    const reason = `safety:${safety.reason}`;
    await markPropertyNeedsAttention(supabase, input.propertyId, reason);
    return { outcome: "escalated", reason };
  }

  // --------------------------------------------------------------------------
  // 7. Send via the existing pipeline (enforces quiet hours + consent
  //    one more time at send time). Stamp AI metadata on the row.
  // --------------------------------------------------------------------------
  const sendResult = await sendSmsToContact(supabase, {
    contactId: input.contactId,
    propertyId: input.propertyId,
    body,
  });

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
    model: config!.model,
    confidence: generated.confidence,
    sentiment: generated.sentiment,
    turn: currentTurn + 1,
  };
  await supabase
    .from("messages")
    .update({ metadata: metadata as unknown as Json })
    .eq("id", messageId);

  return { outcome: "sent", messageId, confidence: generated.confidence };
}

// ---------- helpers ---------------------------------------------------------

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

/**
 * Count AI-generated messages already sent on this property's thread.
 * Drives the `max_turns` cap.
 */
async function countAiTurnsInThread(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<number> {
  const { count } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .eq("direction", "outbound")
    .contains("metadata", { generated_by: "ai_responder_v1" });
  return count ?? 0;
}

/**
 * Count AI-generated messages for the org in the last 24h. Drives the
 * `daily_send_cap`.
 */
async function countAiSendsLast24h(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { count } = await supabase
    .from("messages")
    .select("*, properties!inner(org_id)", { count: "exact", head: true })
    .eq("direction", "outbound")
    .eq("properties.org_id", orgId)
    .contains("metadata", { generated_by: "ai_responder_v1" })
    .gte("created_at", since);
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
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const { data } = await supabase
    .from("messages")
    .select("direction, body, created_at")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: false })
    .limit(20);
  const rows = (data ?? []).slice().reverse(); // chronological
  return rows.map((r) => ({
    role: r.direction === "inbound" ? "user" : "assistant",
    content: r.body ?? "",
  }));
}
