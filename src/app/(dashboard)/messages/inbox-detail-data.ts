import type { SupabaseClient } from "@supabase/supabase-js";

import {
  findLatestAuthoritativeSmsRoute,
} from "@/lib/messages/sms-parties";
import { OPERATOR_TIME_ZONE } from "@/lib/messages/message-metrics";
import type { AiDispositionReview } from "@/lib/messages/list-threads";
import {
  computeConsentState,
  type ConsentState,
} from "@/lib/messaging/consent";
import { resolveSmsConversationOrg } from "@/lib/messages/threading";
import { isSmsPhoneSuppressed } from "@/lib/messaging/opt-out-phone";
import {
  selectSmsPhoneByNumber,
  type SmsPhoneChoice,
} from "@/lib/messaging/sms-phone";
import type { Database } from "@/lib/supabase/types";

export const DRIP_REPLY_CLEAR_WORKFLOW_OPERATIONS = [
  "ready_acquisition_offer",
  "log_acquisition_offer",
  "record_acquisition_contract",
  "decline_acquisition_offer",
  "handoff_acquisition_lead",
  "log_acquisition_attempt",
] as const;

export function outboundStatusClearsDripReply(status: string): boolean {
  return status !== "failed";
}

export type InboxDetail = {
  /** The conversation UUID — same value as `conversationId`; kept as the
   *  field name the cockpit keys selection on. */
  threadId: string;
  conversationId: string;
  contactId: string;
  contactName: string | null;
  /** Actual customer-side phone on the latest SMS in this conversation. */
  threadCustomerPhone: string | null;
  /** Actual Sandra/business-side phone on the latest SMS in this conversation. */
  threadBusinessPhone: string | null;
  /** Backward-compatible alias for threadCustomerPhone. */
  contactPhone: string | null;
  /** Saved contact phone that matches the open thread, safe for replying. */
  replyToPhone: string | null;
  /** Exact saved slot classification for the open thread phone. */
  replyToPhoneLineType: SmsPhoneChoice["lineType"] | null;
  propertyId: string | null;
  propertyAddress: string | null;
  homeownerContactId: string | null;
  agentContactId: string | null;
  /** auth.users.id of the property's current assignee, or null. */
  assigneeId: string | null;
  /** Pipeline position — used to show/hide the dispo bar. */
  propertyStatus: string | null;
  /** Current outreach disposition, if any. */
  outreachDispo: string | null;
  /** Current conversation-scoped Sandra AI disposition awaiting review. */
  aiDispositionReview: AiDispositionReview | null;
  /** Existing contact-level suppression fields. These are channel/contact
   * restrictions, not proof that the property has the permanent DNC lock. */
  contactDoNotContact: boolean;
  contactSmsOptedOut: boolean;
  /** Canonical consent-event state. Null means the authoritative read failed. */
  smsConsentState: ConsentState | null;
  /** Durable phone-level suppression. Null means the authoritative read failed. */
  phoneSuppressed: boolean | null;
  /** Convenience bit for a fail-closed operator surface. */
  smsSafetyReadFailed: boolean;
  /** The only field that makes the entire property permanently read-only. */
  isDncLocked: boolean;
  drip: {
    enrollmentId: string;
    sequenceId: string;
    name: string;
    step: number;
    total: number;
    replied: boolean;
    status?: "active" | "paused" | "completed";
    timeZone?: string;
    stoppedAt: string | null;
  } | null;
  dripMessageLabels: Record<string, string>;
  dripReplyMessageIds: string[];
  dripReplyLabels?: Record<string, string>;
  initialMessages: Database["public"]["Tables"]["messages"]["Row"][];
};

/**
 * Server-side fetch for the side-panel: latest 100 messages for a
 * conversation plus enough contact + property metadata to render the
 * composer. Takes a CANONICAL conversation UUID — stale URL formats are
 * translated upstream by `canonicalizeThreadId`. Returns null when the
 * conversation has no messages (stale URL pointing at nothing).
 */
export async function fetchInboxDetail(
  supabase: SupabaseClient<Database>,
  conversationId: string,
): Promise<InboxDetail | null> {
  const conversationOrgId = await resolveSmsConversationOrg(
    supabase,
    conversationId,
  );
  if (!conversationOrgId) return null;

  const [messagesRes, reviewRes] = await Promise.all([
    supabase
      .from("messages")
      .select("*")
      .eq("channel", "sms")
      .eq("conversation_id", conversationId)
      .eq("org_id", conversationOrgId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("ai_disposition_reviews")
      .select(
        "id, property_id, status, disposition, ai_reason, source_inbound_message_id, created_at",
      )
      .eq("org_id", conversationOrgId)
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .maybeSingle(),
  ]);
  if (messagesRes.error) {
    throw new Error(`fetchInboxDetail messages: ${messagesRes.error.message}`);
  }
  if (reviewRes.error) {
    throw new Error(`fetchInboxDetail AI review: ${reviewRes.error.message}`);
  }
  const newestMessages = messagesRes.data;
  if (!newestMessages || newestMessages.length === 0) return null;

  if (newestMessages.some((message) => message.org_id !== conversationOrgId)) {
    throw new Error(
      "fetchInboxDetail isolation: conversation spans multiple organizations",
    );
  }

  const messages = [...newestMessages].reverse();

  const contactId = messages.find(
    (message) => message.contact_id !== null,
  )?.contact_id;
  if (!contactId) return null;

  // A pending Sandra review can legitimately point at an older source message
  // outside the 100-message display window. Prefer that review's property so
  // the queue item always opens with the controls needed to resolve it.
  const propertyId =
    reviewRes.data?.property_id ??
    [...messages].reverse().find((message) => message.property_id !== null)
      ?.property_id ??
    null;
  const sourceMessageInWindow = reviewRes.data
    ? messages.find(
        (message) => message.id === reviewRes.data!.source_inbound_message_id,
      )
    : null;

  const [contactRes, propertyRes, sourceMessageRes] = await Promise.all([
    supabase
      .from("contacts")
      .select(
        "org_id, first_name, last_name, entity_name, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out",
      )
      .eq("id", contactId)
      .eq("org_id", conversationOrgId)
      .maybeSingle(),
    propertyId
      ? supabase
          .from("properties")
          .select(
            "address, city, state, homeowner_contact_id, agent_contact_id, assigned_user_id, status, outreach_dispo, is_dnc_locked",
          )
          .eq("id", propertyId)
          .eq("org_id", conversationOrgId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    reviewRes.data && !sourceMessageInWindow
      ? supabase
          .from("messages")
          .select("id, body")
          .eq("id", reviewRes.data.source_inbound_message_id)
          .eq("org_id", conversationOrgId)
          .eq("conversation_id", conversationId)
          .eq("channel", "sms")
          .eq("direction", "inbound")
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (contactRes.error) {
    throw new Error(`fetchInboxDetail contact: ${contactRes.error.message}`);
  }
  if (propertyRes.error) {
    throw new Error(`fetchInboxDetail property: ${propertyRes.error.message}`);
  }
  if (sourceMessageRes.error) {
    throw new Error(
      `fetchInboxDetail AI review source: ${sourceMessageRes.error.message}`,
    );
  }
  const c = contactRes.data;
  const p = propertyRes.data;
  const authoritativeRoute = findLatestAuthoritativeSmsRoute(messages);
  const parties = authoritativeRoute?.parties ?? {
    customerPhone: null,
    businessPhone: null,
  };
  const replyPhoneChoice = selectSmsPhoneByNumber(c, parties.customerPhone);
  const replyToPhone =
    replyPhoneChoice?.lineType === "landline"
      ? null
      : (replyPhoneChoice?.phone ?? null);
  let smsConsentState: ConsentState | null = null;
  let phoneSuppressed: boolean | null = null;
  if (c) {
    const consentResult = await supabase
      .from("consent_events")
      .select("event_type, occurred_at")
      .eq("contact_id", contactId)
      .eq("org_id", conversationOrgId)
      .eq("channel", "sms")
      .order("occurred_at", { ascending: false })
      .limit(20);
    smsConsentState = consentResult.error
      ? null
      : computeConsentState(consentResult.data ?? []);
    phoneSuppressed = parties.customerPhone
      ? await isSmsPhoneSuppressed(
          supabase,
          parties.customerPhone,
          conversationOrgId,
        )
          .then((value) => value)
          .catch(() => null)
      : false;
  }

  const dripContext = await loadMessageDripContext(supabase, conversationOrgId, propertyId, messages);

  return {
    threadId: conversationId,
    conversationId,
    contactId,
    contactName: c
      ? (c.entity_name ??
        ([c.first_name, c.last_name].filter(Boolean).join(" ") || null))
      : null,
    threadCustomerPhone: parties.customerPhone,
    threadBusinessPhone: parties.businessPhone,
    contactPhone: parties.customerPhone,
    replyToPhone,
    replyToPhoneLineType: replyPhoneChoice?.lineType ?? null,
    propertyId,
    propertyAddress: p
      ? [p.address, p.city, p.state].filter(Boolean).join(", ")
      : null,
    homeownerContactId: p?.homeowner_contact_id ?? null,
    agentContactId: p?.agent_contact_id ?? null,
    assigneeId: p?.assigned_user_id ?? null,
    propertyStatus: p?.status ?? null,
    outreachDispo: p?.outreach_dispo ?? null,
    aiDispositionReview: reviewRes.data
      ? {
          id: reviewRes.data.id,
          status: "pending",
          disposition: reviewRes.data.disposition,
          reason: reviewRes.data.ai_reason,
          sourceInboundMessageId:
            reviewRes.data.source_inbound_message_id,
          sourceMessageBody:
            sourceMessageInWindow?.body ?? sourceMessageRes.data?.body ?? null,
          createdAt: reviewRes.data.created_at,
        }
      : null,
    contactDoNotContact: c?.do_not_contact ?? false,
    contactSmsOptedOut: c?.sms_opted_out ?? false,
    smsConsentState,
    phoneSuppressed,
    smsSafetyReadFailed: smsConsentState === null || phoneSuppressed === null,
    isDncLocked: p?.is_dnc_locked ?? false,
    ...dripContext,
    initialMessages: messages,
  };
}

async function loadMessageDripContext(
  supabase: SupabaseClient<Database>,
  orgId: string,
  propertyId: string | null,
  messages: Database["public"]["Tables"]["messages"]["Row"][],
): Promise<Pick<InboxDetail, "drip" | "dripMessageLabels" | "dripReplyMessageIds" | "dripReplyLabels">> {
  const outboundIds = messages.filter((m) => m.direction === "outbound").map((m) => m.id);
  const [enrollmentResult, runsResult] = await Promise.all([
    propertyId
      ? supabase.from("sequence_enrollments")
          .select("id, sequence_id, status, pause_reason, current_step_index, enrolled_at, updated_at")
          .eq("org_id", orgId).eq("property_id", propertyId)
          .in("status", ["active", "paused", "completed"])
          .order("enrolled_at", { ascending: false }).order("id", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    outboundIds.length
      ? supabase.from("sequence_step_runs")
          .select("message_id, enrollment_id, sequence_steps!inner(step_index, sequence_id), sequence_enrollments!inner(sequence_id, org_id)")
          .in("message_id", outboundIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (enrollmentResult.error) throw new Error(`fetchInboxDetail drip: ${enrollmentResult.error.message}`);
  if (runsResult.error) throw new Error(`fetchInboxDetail drip messages: ${runsResult.error.message}`);
  const enrollment = (enrollmentResult.data ?? []).reduce<NonNullable<typeof enrollmentResult.data>[number] | null>((chosen, row) => {
    const live = (status: string) => status === "active" || status === "paused";
    if (!chosen || (live(row.status) && !live(chosen.status)) ||
      (live(row.status) === live(chosen.status) &&
        (row.enrolled_at > chosen.enrolled_at ||
          (row.enrolled_at === chosen.enrolled_at && row.id > chosen.id)))) return row;
    return chosen;
  }, null);
  const runs = runsResult.data ?? [];
  const stepRunMessageIds = new Set(runs.map((run) => run.message_id));
  const sequenceIds = [...new Set([
    ...(enrollment ? [enrollment.sequence_id] : []),
    ...runs.filter((run) => run.sequence_enrollments?.org_id === orgId)
      .map((run) => run.sequence_steps.sequence_id),
  ])];
  const [sequencesResult, stepsResult] = await Promise.all([
    sequenceIds.length
      ? supabase.from("sequences").select("id, name").eq("org_id", orgId).in("id", sequenceIds)
      : Promise.resolve({ data: [], error: null }),
    sequenceIds.length
      ? supabase.from("sequence_steps").select("id, sequence_id").in("sequence_id", sequenceIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sequencesResult.error) throw new Error(`fetchInboxDetail drip names: ${sequencesResult.error.message}`);
  if (stepsResult.error) throw new Error(`fetchInboxDetail drip count: ${stepsResult.error.message}`);
  const names = new Map((sequencesResult.data ?? []).map((row) => [row.id, row.name]));
  const totals = new Map<string, number>();
  for (const step of stepsResult.data ?? []) totals.set(step.sequence_id, (totals.get(step.sequence_id) ?? 0) + 1);
  const dripMessageLabels: Record<string, string> = {};
  const dripMessageEnrollmentIds: Record<string, string> = {};
  for (const run of runs) {
    if (!run.message_id || run.sequence_enrollments?.org_id !== orgId) continue;
    const sequenceId = run.sequence_steps.sequence_id;
    const name = names.get(sequenceId);
    if (!name) continue;
    dripMessageLabels[run.message_id] = `Drip · ${name} · text ${run.sequence_steps.step_index + 1} of ${totals.get(sequenceId) ?? run.sequence_steps.step_index + 1}`;
    dripMessageEnrollmentIds[run.message_id] = run.enrollment_id;
  }
  const dripReplyLabels: Record<string, string> = {};
  const dripReplyEnrollmentIds: Record<string, string> = {};
  let pendingDripText: string | null = null;
  let pendingEnrollmentId: string | null = null;
  for (const message of messages) {
    if (dripMessageLabels[message.id]) {
      pendingDripText = dripMessageLabels[message.id];
      pendingEnrollmentId = dripMessageEnrollmentIds[message.id];
    } else if (message.direction === "inbound" && pendingDripText) {
      const match = pendingDripText.match(/text (\d+) of/);
      if (match) {
        dripReplyLabels[message.id] = `Reply to drip text ${match[1]}`;
        if (pendingEnrollmentId) dripReplyEnrollmentIds[message.id] = pendingEnrollmentId;
      }
      pendingDripText = null;
      pendingEnrollmentId = null;
    } else if (message.direction === "outbound" &&
      (message.metadata as { generated_by?: string } | null)?.generated_by !== "ai_responder_v1") {
      pendingDripText = null;
      pendingEnrollmentId = null;
    }
  }
  const dripReplyMessageIds = Object.keys(dripReplyLabels);
  const reply = messages.findLast((message) => dripReplyEnrollmentIds[message.id] === enrollment?.id) ?? null;
  const pausedForReply = enrollment?.status === "paused" &&
    ["inbound_reply", "rep_sms_human_takeover"].includes(enrollment.pause_reason ?? "");
  const actionSinceReply = reply && propertyId ? await Promise.all([
    supabase.from("lead_events").select("id").eq("org_id", orgId)
      .eq("property_id", propertyId).eq("event_type", "dispo_set")
      .eq("actor_type", "user").gt("created_at", reply.created_at).limit(1),
    supabase.from("lead_events").select("id").eq("org_id", orgId)
      .eq("property_id", propertyId).eq("event_type", "my_leads_workflow")
      .eq("actor_type", "user").in("payload->>operation", [...DRIP_REPLY_CLEAR_WORKFLOW_OPERATIONS])
      .gt("created_at", reply.created_at).limit(1),
  ]) : null;
  // The history RPC is ordered by occurred_at; clearing uses recorded_at.
  const attemptAfterReply = reply && propertyId
    ? await supabase.rpc("fn_has_acquisition_attempt_recorded_after" as never,
        { p_property_id: propertyId, p_after: reply.created_at } as never)
    : null;
  if (actionSinceReply?.[0].error) throw new Error(`fetchInboxDetail drip outcome: ${actionSinceReply[0].error.message}`);
  if (actionSinceReply?.[1].error) throw new Error(`fetchInboxDetail drip workflow: ${actionSinceReply[1].error.message}`);
  if (attemptAfterReply?.error) throw new Error(`fetchInboxDetail acquisition attempts: ${attemptAfterReply.error.message}`);
  const humanOutboundAfterReply = reply && messages.some((message) =>
    message.direction === "outbound" && outboundStatusClearsDripReply(message.status) && message.created_at > reply.created_at &&
    message.campaign_id == null &&
    (message.metadata as { generated_by?: string } | null)?.generated_by == null &&
    !stepRunMessageIds.has(message.id));
  const repActed = Boolean(humanOutboundAfterReply || actionSinceReply?.some((result) => (result.data?.length ?? 0) > 0) ||
    attemptAfterReply?.data);
  const replied = Boolean(reply && !repActed && (pausedForReply || enrollment?.status === "completed"));
  // TODO(PR-8): Align the inbox row icon and filter snapshot with this outstanding state.
  const name = enrollment ? names.get(enrollment.sequence_id) : null;
  return {
    drip: enrollment && name ? {
      enrollmentId: enrollment.id,
      sequenceId: enrollment.sequence_id,
      name,
      step: Math.min(enrollment.current_step_index + 1, totals.get(enrollment.sequence_id) ?? 0),
      total: totals.get(enrollment.sequence_id) ?? 0,
      replied,
      status: enrollment.status as "active" | "paused" | "completed",
      timeZone: OPERATOR_TIME_ZONE,
      stoppedAt: (pausedForReply || enrollment.status === "completed") ? reply?.created_at ?? null : null,
    } : null,
    dripMessageLabels,
    dripReplyMessageIds,
    dripReplyLabels,
  };
}
