import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import type { Database, Json } from "@/lib/supabase/types";

/**
 * A rep SMS is a human-owned conversation. Once the lead replies, the
 * conversation must remain in the assigned rep's hands until a person clears
 * the attention flag. This reason is deliberately stable because it is also
 * persisted in the existing attention read model.
 */
export const REP_SMS_HUMAN_TAKEOVER_REASON = "rep_sms_human_takeover";

const REP_SMS_WORKFLOW = "maria-through-mel";
const REP_SMS_PERSONA = "Mel";
const REP_SMS_ASSISTANT = "Maria";
const REP_SMS_TAKEOVER_LOOKUP_LIMIT = 50;

type RepSmsHumanMetadata = {
  workflow?: unknown;
  persona?: unknown;
  assistant?: unknown;
  actorUserId?: unknown;
  senderAssignmentId?: unknown;
};

type RepSmsOutboundRow = Pick<
  Database["public"]["Tables"]["messages"]["Row"],
  | "id"
  | "property_id"
  | "contact_id"
  | "created_at"
  | "sent_at"
  | "from_address"
  | "status"
  | "metadata"
>;

type RepSmsInboundRow = Pick<
  Database["public"]["Tables"]["messages"]["Row"],
  "id" | "created_at" | "sent_at"
>;

type MessageTimeRow = Pick<
  Database["public"]["Tables"]["messages"]["Row"],
  "created_at" | "sent_at"
>;

export type RepSmsHumanTakeoverSource = {
  outboundMessageId: string;
  propertyId: string;
  contactId: string;
  actorUserId: string;
  senderAssignmentId: string | null;
  fromNumber: string | null;
  messageStatus: string;
  sentAt: string;
};

/**
 * A lookup failure is materially different from finding no rep SMS. Callers
 * must retry the webhook when this occurs instead of treating the inbound as
 * an ordinary message or as a confirmed human takeover.
 */
export class RepSmsHumanTakeoverLookupError extends Error {
  readonly kind = "lookup" as const;

  constructor(message: string) {
    super(message);
    this.name = "RepSmsHumanTakeoverLookupError";
  }
}

/**
 * The source has been confirmed, but one of the durable takeover writes did
 * not complete. This is retryable; suppressing or acknowledging the webhook
 * before the next attempt would risk handing the conversation back to AI.
 */
export class RepSmsHumanTakeoverPersistenceError extends Error {
  readonly kind = "persistence" as const;

  constructor(message: string) {
    super(message);
    this.name = "RepSmsHumanTakeoverPersistenceError";
  }
}

function readObject(value: Json | null): Record<string, Json> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;
}

function readRepSmsMetadata(metadata: Json | null): RepSmsHumanMetadata | null {
  const root = readObject(metadata);
  const repSms = root?.repSms;
  if (!repSms || typeof repSms !== "object" || Array.isArray(repSms)) {
    return null;
  }
  return repSms as RepSmsHumanMetadata;
}

/**
 * True only for the server-created Maria-through-Mel metadata shape. The
 * assistant/persona checks prevent a future automated message from being
 * mistaken for a human takeover merely because it happens to carry a
 * `repSms` object.
 */
export function isMariaThroughMelRepSms(metadata: Json | null): boolean {
  const repSms = readRepSmsMetadata(metadata);
  return (
    repSms?.workflow === REP_SMS_WORKFLOW &&
    repSms.persona === REP_SMS_PERSONA &&
    repSms.assistant === REP_SMS_ASSISTANT &&
    typeof repSms.actorUserId === "string" &&
    repSms.actorUserId.trim().length > 0
  );
}

function messageTime(row: MessageTimeRow): string | null {
  return row.sent_at ?? row.created_at;
}

/**
 * A rep-SMS row can be present even when Sandra stopped it before crossing
 * the provider boundary. Those local outcomes must never establish a human
 * takeover. A pending/sending/unknown row remains eligible because a provider
 * request may have crossed the boundary before its durable result was written;
 * suppressing AI in that case is the safe outcome. A failed row is only
 * eligible when its metadata explicitly records an ambiguous provider result.
 */
function canEstablishRepSmsTakeover(row: RepSmsOutboundRow): boolean {
  const status = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  if (!status) return false;

  if (
    status === "blocked" ||
    status.startsWith("blocked_") ||
    status === "failed_not_dispatched" ||
    status === "queued" ||
    status === "paused" ||
    status === "provider_failed" ||
    status === "delivery_failed"
  ) {
    return false;
  }

  if (status !== "failed") return true;

  const root = readObject(row.metadata);
  return root?.providerOutcome === "provider_unknown";
}

/**
 * Find the latest human rep SMS that preceded this inbound event on the same
 * conversation. The lookup is tenant/property/contact scoped and compares
 * event time so an out-of-order provider callback cannot make a later send
 * look like the reply's owner.
 */
export async function findRepSmsHumanTakeoverSource(
  supabase: SupabaseClient<Database>,
  input: {
    conversationId: string | null;
    propertyId: string | null;
    contactId: string | null;
    inboundMessageId: string;
    inboundReceivedAt: string;
    inboundToNumber: string | null;
  },
): Promise<RepSmsHumanTakeoverSource | null> {
  if (!input.conversationId || !input.propertyId || !input.contactId) {
    return null;
  }

  // The inbound destination is the only trustworthy binding between a lead's
  // reply and one of the company's numbers. Require a canonical E.164 value;
  // falling back to arbitrary text here could attribute a reply to a different
  // company number (or to malformed provider data).
  const inboundToNumber = normalizePhone(input.inboundToNumber);
  if (!inboundToNumber) return null;

  const inboundTime = Date.parse(input.inboundReceivedAt);
  if (!Number.isFinite(inboundTime)) return null;
  const conversationId = input.conversationId;
  const propertyId = input.propertyId;
  const contactId = input.contactId;

  const scopedMessages = (
    direction: "outbound" | "inbound",
    select: string,
  ) =>
    supabase
      .from("messages")
      .select(select)
      .eq("channel", "sms")
      .eq("direction", direction)
      .eq("conversation_id", conversationId)
      .eq("property_id", propertyId)
      .eq("contact_id", contactId);

  // `sent_at` is the provider event time when available. The second query
  // covers legacy rows that never received one and uses created_at as their
  // effective event time. The outbound branches are ordered and bounded in
  // SQL to a 50-row horizon, while the prior-inbound branches only need their
  // latest row. A long-running conversation therefore cannot force this
  // webhook to materialize its entire message history in memory. We retain
  // the outbound window rather than limiting to one row because the newest
  // outbound may be a non-dispatch result or may belong to another company
  // number; those rows must not hide an older eligible Maria-through-Mel send.
  // A valid send older than this horizon is intentionally not considered.
  type LookupQueryResult = {
    data: unknown[] | null;
    error: { message: string } | null;
  };
  let results: [
    LookupQueryResult,
    LookupQueryResult,
    LookupQueryResult,
    LookupQueryResult,
  ];
  try {
    results = await Promise.all([
      scopedMessages(
        "outbound",
        "id, property_id, contact_id, created_at, sent_at, from_address, status, metadata",
      )
        .not("sent_at", "is", null)
        .lte("sent_at", input.inboundReceivedAt)
        .order("sent_at", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(REP_SMS_TAKEOVER_LOOKUP_LIMIT),
      scopedMessages(
        "outbound",
        "id, property_id, contact_id, created_at, sent_at, from_address, status, metadata",
      )
        .is("sent_at", null)
        .lte("created_at", input.inboundReceivedAt)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(REP_SMS_TAKEOVER_LOOKUP_LIMIT),
      scopedMessages("inbound", "id, created_at, sent_at")
        .neq("id", input.inboundMessageId)
        .not("sent_at", "is", null)
        .lte("sent_at", input.inboundReceivedAt)
        .order("sent_at", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
      scopedMessages("inbound", "id, created_at, sent_at")
        .neq("id", input.inboundMessageId)
        .is("sent_at", null)
        .lte("created_at", input.inboundReceivedAt)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
    ]);
  } catch (error) {
    throw new RepSmsHumanTakeoverLookupError(
      `findRepSmsHumanTakeoverSource query: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  const [outboundSentResult, outboundCreatedResult, inboundSentResult, inboundCreatedResult] = results;
  const queryError =
    outboundSentResult.error ??
    outboundCreatedResult.error ??
    inboundSentResult.error ??
    inboundCreatedResult.error;
  if (queryError) {
    throw new RepSmsHumanTakeoverLookupError(
      `findRepSmsHumanTakeoverSource query: ${queryError.message}`,
    );
  }

  // A newer inbound supersedes every older outbound handoff. This is the
  // conversation boundary that makes clearing attention durable: the old rep
  // SMS cannot reclaim a later inbound until a new rep SMS is sent.
  const inboundCandidates = [
    ...((inboundSentResult.data ?? []) as unknown as RepSmsInboundRow[]),
    ...((inboundCreatedResult.data ?? []) as unknown as RepSmsInboundRow[]),
  ];
  const latestPriorInbound =
    inboundCandidates
      .filter((candidate) => {
        const candidateTime = messageTime(candidate);
        const candidateTimestamp = candidateTime
          ? Date.parse(candidateTime)
          : Number.NaN;
        return (
          !!candidateTime &&
          Number.isFinite(candidateTimestamp) &&
          candidateTimestamp <= inboundTime
        );
      })
      .sort((left, right) => {
        const rightTime = Date.parse(messageTime(right) ?? "");
        const leftTime = Date.parse(messageTime(left) ?? "");
        if (rightTime !== leftTime) return rightTime - leftTime;
        return right.id.localeCompare(left.id);
      })[0] ?? null;
  const latestPriorInboundAt = latestPriorInbound
    ? messageTime(latestPriorInbound)
    : null;
  const latestPriorInboundTime = latestPriorInboundAt
    ? Date.parse(latestPriorInboundAt)
    : Number.NaN;
  if (latestPriorInbound && !Number.isFinite(latestPriorInboundTime)) {
    return null;
  }

  // Select the newest provider-attempted outbound on the inbound destination
  // number before the inbound event, then require that state to be the
  // server-created rep SMS. Non-dispatch rows are skipped, and other-number
  // sends are ignored, so neither can hide an older valid handoff. A genuinely
  // sent ordinary outbound on this same number remains the newest candidate
  // and therefore deliberately supersedes the older handoff.
  const rows = [
    ...((outboundSentResult.data ?? []) as unknown as RepSmsOutboundRow[]),
    ...((outboundCreatedResult.data ?? []) as unknown as RepSmsOutboundRow[]),
  ];
  const latestOutboundForInboundNumber = rows
    .filter((candidate) => {
      const candidateSentAt = messageTime(candidate);
      const candidateSentTime = candidateSentAt
        ? Date.parse(candidateSentAt)
        : Number.NaN;
      return (
        !!candidateSentAt &&
        Number.isFinite(candidateSentTime) &&
        candidateSentTime <= inboundTime &&
        normalizePhone(candidate.from_address) === inboundToNumber &&
        canEstablishRepSmsTakeover(candidate)
      );
    })
    .sort((left, right) => {
      const rightTime = Date.parse(messageTime(right) ?? "");
      const leftTime = Date.parse(messageTime(left) ?? "");
      if (rightTime !== leftTime) return rightTime - leftTime;
      const rightCreated = Date.parse(right.created_at);
      const leftCreated = Date.parse(left.created_at);
      if (rightCreated !== leftCreated) return rightCreated - leftCreated;
      return right.id.localeCompare(left.id);
    })[0] ?? null;
  if (
    !latestOutboundForInboundNumber ||
    !isMariaThroughMelRepSms(latestOutboundForInboundNumber.metadata)
  ) {
    return null;
  }
  const row = latestOutboundForInboundNumber;
  const normalizedFromNumber = normalizePhone(row.from_address);
  if (!normalizedFromNumber || normalizedFromNumber !== inboundToNumber) {
    return null;
  }
  const sentAt = messageTime(row);
  const sentTime = sentAt ? Date.parse(sentAt) : Number.NaN;
  if (
    !sentAt ||
    !Number.isFinite(sentTime) ||
    (latestPriorInbound && sentTime <= latestPriorInboundTime)
  ) {
    return null;
  }
  const repSms = readRepSmsMetadata(row.metadata);
  const actorUserId =
    typeof repSms?.actorUserId === "string" ? repSms.actorUserId.trim() : "";
  if (!actorUserId || !row.property_id || !row.contact_id) return null;
  return {
    outboundMessageId: row.id,
    propertyId: row.property_id,
    contactId: row.contact_id,
    actorUserId,
    senderAssignmentId:
      typeof repSms?.senderAssignmentId === "string"
        ? repSms.senderAssignmentId
        : null,
    fromNumber: normalizedFromNumber,
    messageStatus: row.status.trim().toLowerCase(),
    sentAt,
  };
}

/**
 * Persist the takeover marker after the inbound row exists. The existing
 * property attention flag is the established suppression/read-model gate;
 * the thread state makes the conversation-level ownership explicit and lets
 * delayed AI work observe the handoff after a reload.
 */
export async function recordRepSmsHumanTakeover(
  supabase: SupabaseClient<Database>,
  input: {
    propertyId: string;
    conversationId: string | null;
    inboundMessageId: string;
    source: RepSmsHumanTakeoverSource;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const { data: updated, error: propertyError } = await supabase
    .from("properties")
    .update({
      needs_human_attention: true,
      last_ai_escalation_reason: REP_SMS_HUMAN_TAKEOVER_REASON,
      last_ai_escalation_at: now,
      updated_at: now,
    })
    .eq("id", input.propertyId)
    .eq("needs_human_attention", false)
    .select("id")
    .maybeSingle();
  if (propertyError) {
    throw new RepSmsHumanTakeoverPersistenceError(
      `recordRepSmsHumanTakeover property: ${propertyError.message}`,
    );
  }

  if (input.conversationId) {
    const { error: threadError } = await supabase
      .from("message_threads")
      .update({
        ai_responder_status: "escalated",
        ai_responder_reason: REP_SMS_HUMAN_TAKEOVER_REASON,
        ai_responder_status_at: now,
        ai_responder_message_id: null,
        ai_last_delivery_status: null,
        ai_last_delivery_error: null,
        updated_at: now,
      })
      .eq("conversation_id", input.conversationId)
      .eq("property_id", input.propertyId);
    if (threadError) {
      throw new RepSmsHumanTakeoverPersistenceError(
        `recordRepSmsHumanTakeover thread: ${threadError.message}`,
      );
    }
  }

  // Use the existing attention event/read model, but retain a precise source
  // payload so the activity trail says this came from a human rep SMS rather
  // than an AI model decision. The unique source identity makes retries safe.
  await recordLeadEvent({
    propertyId: input.propertyId,
    actorType: "system",
    eventType: LEAD_EVENT_TYPES.AI_ESCALATED,
    sourceType: "messages.rep_sms_human_takeover",
    sourceId: input.inboundMessageId,
    payload: {
      reason: REP_SMS_HUMAN_TAKEOVER_REASON,
      sourceOutboundMessageId: input.source.outboundMessageId,
      repActorUserId: input.source.actorUserId,
      senderAssignmentId: input.source.senderAssignmentId,
      sourceMessageStatus: input.source.messageStatus,
    } as Json,
  });

  // `updated` is intentionally unused for behavior: a second inbound on an
  // already-attentioned lead still refreshes the durable conversation marker
  // and appends its own idempotent source event.
  void updated;
}

/**
 * Keep the existing property attention gate as a temporary fail-closed
 * fallback while the webhook is retried. This write is deliberately strict:
 * unlike the general AI escalation helper, a takeover fallback must report a
 * database failure to its caller so the webhook cannot be acknowledged.
 */
export async function persistRepSmsHumanTakeoverFallback(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("properties")
    .update({
      needs_human_attention: true,
      last_ai_escalation_reason: REP_SMS_HUMAN_TAKEOVER_REASON,
      last_ai_escalation_at: now,
      updated_at: now,
    })
    .eq("id", propertyId)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new RepSmsHumanTakeoverPersistenceError(
      `persistRepSmsHumanTakeoverFallback: ${error.message}`,
    );
  }
  if (!data) {
    throw new RepSmsHumanTakeoverPersistenceError(
      `persistRepSmsHumanTakeoverFallback: property ${propertyId} not found`,
    );
  }
}
