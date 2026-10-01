import type { SupabaseClient } from "@supabase/supabase-js";

import { OPERATOR_TIME_ZONE } from "@/lib/messages/message-metrics";
import type { Database } from "@/lib/supabase/types";

export const DRIP_REPLY_CLEAR_WORKFLOW_OPERATIONS = [
  "ready_acquisition_offer",
  "log_acquisition_offer",
  "record_acquisition_contract",
  "decline_acquisition_offer",
  "handoff_acquisition_lead",
  "log_acquisition_attempt",
] as const;

export type InboxDripContext = {
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
  dripReplyLabels: Record<string, string>;
};

/** Shared header/pill and history-label computation for the row's property. */
export async function loadMessageDripContext(
  supabase: SupabaseClient<Database>,
  orgId: string,
  propertyId: string | null,
  messages: Database["public"]["Tables"]["messages"]["Row"][],
): Promise<InboxDripContext> {
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
    message.direction === "outbound" && message.created_at > reply.created_at &&
    message.campaign_id == null &&
    (message.metadata as { generated_by?: string } | null)?.generated_by == null &&
    !stepRunMessageIds.has(message.id));
  const repActed = Boolean(humanOutboundAfterReply || actionSinceReply?.some((result) => (result.data?.length ?? 0) > 0) ||
    attemptAfterReply?.data);
  const replied = Boolean(reply && !repActed && (pausedForReply || enrollment?.status === "completed"));
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

/** Load the latest 100 SMS and use the row's newest non-null property. */
export async function loadConversationDripContext(
  supabase: SupabaseClient<Database>,
  orgId: string,
  conversationId: string,
): Promise<InboxDripContext> {
  const result = await supabase.from("messages").select("*")
    .eq("org_id", orgId).eq("conversation_id", conversationId).eq("channel", "sms")
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100);
  if (result.error) throw new Error(`fetchInboxDetail messages: ${result.error.message}`);
  const ascending = [...(result.data ?? [])].reverse();
  const propertyId = [...ascending].reverse().find((message) => message.property_id !== null)?.property_id ?? null;
  return loadMessageDripContext(supabase, orgId, propertyId, ascending);
}
