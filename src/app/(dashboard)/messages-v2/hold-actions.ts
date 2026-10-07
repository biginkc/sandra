import type { SupabaseClient } from "@supabase/supabase-js";

import type { HumanDraftSendInput, HumanDraftSendResult } from "@/lib/ai-responder/dispatch";
import { err, ok, type Result } from "@/lib/errors/result";
import type { LeadEventType, RecordLeadEventInput } from "@/lib/events";
import type {
  MaybeRunContext,
  RecordStepInput,
} from "@/lib/pipeline-runs";
import type { Database, Json } from "@/lib/supabase/types";

import type { SeenDraft } from "./hold-action-types";
import type { HoldSeen } from "./types";

/**
 * Messages v2 Phase 1 hold actions: Send, Edit (then send), Take over, Assign,
 * Dismiss. The functions here are plain and take their collaborators as a
 * `deps` object (the server-action wrapper in ./actions.ts supplies the real
 * ones after authorizing the caller as owner || acquisitions), so they test
 * without any module mocking.
 *
 * Every send goes through `sendHumanDraft` (the single responder chokepoint),
 * which re-runs the Q8 table and the suppression / consent / quiet-hours /
 * "still the latest inbound" / "no reply since" checks at click time. Every
 * completed action writes a `lead_events` row (actor_type = user) and a
 * pipeline step. Neither ever carries message text.
 */

type Admin = SupabaseClient<Database>;

export type HoldActionDeps = {
  /** Service-role client (draft/message reads and writes the user's RLS client cannot do). */
  admin: Admin;
  orgId: string;
  userId: string;
  sendHumanDraft: (supabase: Admin, input: HumanDraftSendInput) => Promise<HumanDraftSendResult>;
  recordLeadEvent: (input: RecordLeadEventInput) => Promise<void>;
  resumeRun: (admin: Admin, runId: string | null | undefined) => Promise<MaybeRunContext>;
  recordStep: (admin: Admin, ctx: MaybeRunContext, step: RecordStepInput) => Promise<void>;
  /** The existing lead assignment action (leads/actions.ts). */
  updateLeadAssignee: (propertyId: string, userId: string | null) => Promise<Result<null>>;
  reportError: (error: unknown, context?: { tags?: Record<string, string>; extra?: Record<string, unknown> }) => void;
};

/** Longest reply a human may send from a hold (SMS concatenation ceiling, not a content rule). */
export const MAX_EDIT_LENGTH = 1600;
/** Longest dismiss note. */
export const MAX_DISMISS_REASON_LENGTH = 500;

const DRAFT_COLUMNS =
  "id, org_id, run_id, property_id, conversation_id, inbound_message_id, body, edited_body, edited_at, status";

/** Lease on the property while a human send is in flight (Dismiss / Take over refuse while it is held). */
const SEND_LEASE_SECONDS = 120;

type DraftRow = {
  id: string;
  org_id: string;
  run_id: string | null;
  property_id: string | null;
  conversation_id: string | null;
  inbound_message_id: string | null;
  body: string;
  edited_body: string | null;
  edited_at: string | null;
  status: string;
};

const fail = (code: string, message: string, details?: Record<string, unknown>) =>
  err({ code, message, ...(details ? { details } : {}) });

async function loadDraft(d: HoldActionDeps, draftId: string): Promise<Result<DraftRow>> {
  const { data, error } = await d.admin
    .from("ai_reply_drafts")
    .select(DRAFT_COLUMNS)
    .eq("id", draftId)
    .maybeSingle();
  if (error) return fail("DRAFT_LOOKUP_FAILED", "Could not load that draft. Try again.");
  const row = data as DraftRow | null;
  // Another org's draft is indistinguishable from a missing one.
  if (!row || row.org_id !== d.orgId) return fail("DRAFT_NOT_FOUND", "That draft no longer exists.");
  if (row.status !== "pending") {
    return fail("DRAFT_NOT_PENDING", "That draft was already handled. Refresh the page.");
  }
  return ok(row);
}

async function loadProperty(d: HoldActionDeps, propertyId: string): Promise<Result<{ id: string }>> {
  const { data, error } = await d.admin
    .from("properties")
    .select("id, org_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (error) return fail("PROPERTY_LOOKUP_FAILED", "Could not load that lead. Try again.");
  const row = data as { id: string; org_id: string } | null;
  if (!row || row.org_id !== d.orgId) return fail("PROPERTY_NOT_FOUND", "That lead no longer exists.");
  return ok({ id: row.id });
}

async function latestRunContext(d: HoldActionDeps, propertyId: string): Promise<MaybeRunContext> {
  try {
    const { data } = await d.admin
      .from("pipeline_runs")
      .select("id")
      .eq("property_id", propertyId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const id = (data as { id: string } | null)?.id;
    return id ? await d.resumeRun(d.admin, id) : null;
  } catch (e) {
    d.reportError(e, { tags: { surface: "hold_action_run_lookup" }, extra: { propertyId } });
    return null;
  }
}

type HoldEvent = {
  propertyId: string;
  eventType: LeadEventType;
  payload: Json;
};

async function audit(
  d: HoldActionDeps,
  ctx: MaybeRunContext,
  step: RecordStepInput,
  events: HoldEvent[],
): Promise<void> {
  // Neither write may fail an action that already happened.
  try {
    await d.recordStep(d.admin, ctx, step);
  } catch (e) {
    d.reportError(e, { tags: { surface: "hold_action_step" } });
  }
  for (const event of events) {
    try {
      await d.recordLeadEvent({ ...event, actorType: "user", actorId: d.userId } as RecordLeadEventInput);
    } catch (e) {
      d.reportError(e, { tags: { surface: "hold_action_lead_event" } });
    }
  }
}

/** A provider timeout: the text may or may not have gone out. */
export const SEND_TIMEOUT_MESSAGE =
  "Send timed out at the provider — the text may have gone out; do not re-send until the thread updates.";

const isSendTimeout = (reason: string) => reason.includes("send_timeout");

function refusalMessage(reason: string, retryable: boolean): string {
  if (isSendTimeout(reason)) return SEND_TIMEOUT_MESSAGE;
  const spaced = reason.replace(/[_:]+/g, " ");
  return retryable
    ? `Not sent: the conversation was busy (${spaced}). Try again in a moment.`
    : `Not sent: ${spaced}. The draft is still on the rail.`;
}

async function performSend(
  d: HoldActionDeps,
  draft: DraftRow,
  body: string,
  edited: boolean,
): Promise<Result<{ messageId: string }>> {
  if (!draft.property_id || !draft.inbound_message_id) {
    return fail("DRAFT_NOT_SENDABLE", "This draft is not tied to a seller text, so it cannot be sent from here.");
  }
  const { data: inbound, error: inboundError } = await d.admin
    .from("messages")
    .select("id, contact_id, conversation_id, from_address")
    .eq("id", draft.inbound_message_id)
    .maybeSingle();
  const inboundRow = inbound as
    | { id: string; contact_id: string | null; conversation_id: string | null; from_address: string | null }
    | null;
  if (inboundError || !inboundRow?.contact_id) {
    return fail("DRAFT_NOT_SENDABLE", "Could not find the seller text this draft answers.");
  }

  const ctx = await d.resumeRun(d.admin, draft.run_id);
  const sent = await d.sendHumanDraft(d.admin, {
    orgId: d.orgId,
    propertyId: draft.property_id,
    contactId: inboundRow.contact_id,
    conversationId: draft.conversation_id ?? inboundRow.conversation_id,
    inboundMessageId: draft.inbound_message_id,
    inboundFromPhone: inboundRow.from_address,
    body,
    userId: d.userId,
    edited,
    runContext: ctx,
  });

  if (sent.status === "refused") {
    await audit(
      d,
      ctx,
      {
        kind: "gate",
        name: "human_send_refused",
        result: "block",
        detail: { reason: sent.reason, retryable: sent.retryable, flagged: sent.flagged, draftId: draft.id, edited },
      },
      [],
    );
    return fail(isSendTimeout(sent.reason) ? "SEND_TIMEOUT" : "SEND_REFUSED", refusalMessage(sent.reason, sent.retryable), {
      reason: sent.reason,
      retryable: sent.retryable,
      flagged: sent.flagged,
    });
  }

  // The text is out. Everything below is bookkeeping and must not turn a sent
  // message into a reported failure (a repeat click would be refused by the
  // one-reply-per-inbound guard anyway).
  const now = new Date().toISOString();
  try {
    const { error } = await d.admin
      .from("ai_reply_drafts")
      .update({
        status: "sent",
        resolved_by: d.userId,
        resolved_at: now,
        resolution_reason: edited ? "sent_edited" : "sent",
        sent_message_id: sent.messageId,
      })
      .eq("id", draft.id)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
  } catch (e) {
    d.reportError(e, { tags: { surface: "hold_action_draft_resolve" }, extra: { draftId: draft.id } });
  }
  const events: HoldEvent[] = [
    {
      propertyId: draft.property_id,
      eventType: "hold_reply_sent",
      payload: { draft_id: draft.id, edited, message_id: sent.messageId, via: "messages_v2" },
    },
  ];
  try {
    const { data: cleared, error } = await d.admin
      .from("properties")
      .update({
        needs_human_attention: false,
        last_ai_escalation_reason: null,
        last_ai_escalation_at: null,
        updated_at: now,
      })
      .eq("id", draft.property_id)
      .eq("needs_human_attention", true)
      .eq("last_ai_escalation_reason", "draft_held")
      .select("id");
    if (error) throw new Error(error.message);
    if (Array.isArray(cleared) && cleared.length > 0) {
      events.push({
        propertyId: draft.property_id,
        eventType: "ai_escalation_cleared",
        payload: { from: true, to: false, via: "messages_v2", action: "send" },
      });
    }
  } catch (e) {
    d.reportError(e, { tags: { surface: "hold_action_flag_clear" }, extra: { propertyId: draft.property_id } });
  }
  await audit(
    d,
    ctx,
    {
      kind: "reply",
      name: "human_send",
      result: "sent",
      detail: { outboundMessageId: sent.messageId, draftId: draft.id, edited, actor: "human" },
    },
    events,
  );
  return ok({ messageId: sent.messageId });
}

export const HOLD_STALE_MESSAGE = "This thread changed — reload";

const DRAFT_CHANGED_MESSAGE =
  "This draft changed after you opened it, so nothing was sent. The card is reloading; check the text and try again.";

/** Refuses unless the draft is exactly what the clicker saw (text and edit version). */
function checkSeen(draft: DraftRow, seen: SeenDraft): Result<null> {
  const current = draft.edited_body ?? draft.body;
  if (current !== seen.body || (draft.edited_at ?? null) !== (seen.editedAt ?? null)) {
    return fail("DRAFT_CHANGED", DRAFT_CHANGED_MESSAGE);
  }
  return ok(null);
}

/**
 * Runs a send under the per-property lease (the same lease table the send path
 * uses). Dismiss / Take over refuse while it is held, and take it themselves,
 * so a send and a resolve can never interleave.
 */
async function withPropertyLease<T>(
  d: HoldActionDeps,
  propertyId: string,
  run: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const holder = `hold-send:${d.userId}:${crypto.randomUUID()}`;
  const { data, error } = await d.admin.rpc("fn_reserve_ai_send", {
    p_conversation_id: propertyId,
    p_holder: holder,
    p_lease_seconds: SEND_LEASE_SECONDS,
  });
  if (error) {
    d.reportError(new Error(error.message), { tags: { surface: "hold_action_lease" }, extra: { propertyId } });
    return fail("SEND_BUSY", "Could not start the send. Nothing was sent; try again.");
  }
  if (data !== true) {
    return fail("SEND_BUSY", "Another action on this thread is in progress. Nothing was sent; try again in a moment.");
  }
  try {
    return await run();
  } finally {
    try {
      const released = await d.admin.rpc("fn_release_ai_send", { p_conversation_id: propertyId, p_holder: holder });
      if (released.error) throw new Error(released.error.message);
    } catch (e) {
      d.reportError(e, { tags: { surface: "hold_action_lease_release" }, extra: { propertyId } });
    }
  }
}

/** Send the draft the clicker saw, exactly as they saw it. */
export async function sendHeldDraft(
  d: HoldActionDeps,
  input: { draftId: string; seen: SeenDraft },
): Promise<Result<{ messageId: string }>> {
  const first = await loadDraft(d, input.draftId);
  if (!first.ok) return first;
  if (!first.data.property_id) {
    return fail("DRAFT_NOT_SENDABLE", "This draft is not tied to a seller text, so it cannot be sent from here.");
  }
  return withPropertyLease(d, first.data.property_id, async () => {
    // Re-read under the lease: a Dismiss that finished first leaves it discarded.
    const draft = await loadDraft(d, input.draftId);
    if (!draft.ok) return draft;
    const seen = checkSeen(draft.data, input.seen);
    if (!seen.ok) return seen;
    const body = (draft.data.edited_body ?? draft.data.body).trim();
    return performSend(d, draft.data, body, draft.data.edited_body !== null);
  });
}

/** Record the edit on the draft row, then send the edited text. */
export async function editAndSendHeldDraft(
  d: HoldActionDeps,
  input: { draftId: string; body: string; seen: SeenDraft },
): Promise<Result<{ messageId: string }>> {
  const body = input.body.trim();
  if (!body || body.length > MAX_EDIT_LENGTH) {
    return fail(
      "INVALID_BODY",
      body ? `Keep the reply under ${MAX_EDIT_LENGTH + 1} characters.` : "Write the reply before sending.",
    );
  }
  const first = await loadDraft(d, input.draftId);
  if (!first.ok) return first;
  if (!first.data.property_id) {
    return fail("DRAFT_NOT_SENDABLE", "This draft is not tied to a seller text, so it cannot be sent from here.");
  }
  return withPropertyLease(d, first.data.property_id, async () => {
    const draft = await loadDraft(d, input.draftId);
    if (!draft.ok) return draft;
    // The edit is based on the text they saw; if the draft moved, nothing is written or sent.
    const seen = checkSeen(draft.data, input.seen);
    if (!seen.ok) return seen;

    const { data: updated, error } = await d.admin
      .from("ai_reply_drafts")
      .update({ edited_body: body, edited_by: d.userId, edited_at: new Date().toISOString() })
      .eq("id", draft.data.id)
      .eq("status", "pending")
      .select("id");
    if (error) return fail("DRAFT_EDIT_FAILED", "Could not save your edit. Nothing was sent.");
    if (!Array.isArray(updated) || updated.length === 0) {
      return fail("DRAFT_NOT_PENDING", "That draft was already handled. Refresh the page.");
    }
    return performSend(d, draft.data, body, true);
  });
}

async function resolveHold(
  d: HoldActionDeps,
  propertyId: string,
  action: "take_over" | "dismiss",
  reason: string | null,
  seen: HoldSeen,
): Promise<Result<Record<string, unknown>>> {
  const property = await loadProperty(d, propertyId);
  if (!property.ok) return property;
  const ctx = await latestRunContext(d, propertyId);
  const { data, error } = await d.admin.rpc("fn_resolve_hold", {
    p_org_id: d.orgId,
    p_property_id: propertyId,
    p_user_id: d.userId,
    p_action: action,
    p_reason: reason,
    p_seen_through: seen.through,
    p_flag_reason: seen.flagReason,
    p_flag_at: seen.flagAt,
  });
  if (error) {
    if (error.message.includes("SEND_IN_PROGRESS")) {
      return fail("SEND_IN_PROGRESS", "A reply is being sent on this thread. Nothing was changed; try again in a moment.");
    }
    d.reportError(new Error(error.message), { tags: { surface: "hold_action_resolve" }, extra: { propertyId, action } });
    return fail("HOLD_RESOLVE_FAILED", "Could not update that hold. Nothing was changed.");
  }
  const counts = (data ?? {}) as Record<string, unknown>;
  if (counts.status === "STALE") {
    return fail("HOLD_STALE", HOLD_STALE_MESSAGE);
  }
  const detail = {
    decisionsSuperseded: counts.decisionsSuperseded ?? 0,
    reviewsSuperseded: counts.reviewsSuperseded ?? 0,
    draftsDiscarded: counts.draftsDiscarded ?? 0,
  };
  const cleared = {
    propertyId,
    eventType: "ai_escalation_cleared" as const,
    payload: {
      from: counts.wasFlagged === false ? false : true,
      to: false,
      via: "messages_v2",
      action: action === "dismiss" ? "dismiss" : "take_over",
      ...(reason ? { reason } : {}),
    },
  };
  const events: HoldEvent[] = [];
  if (counts.flagCleared !== false) events.push(cleared);
  // The toggle is logged only when this action actually switched the responder off.
  if (action === "take_over" && counts.responderChanged === true) {
    events.push({
      propertyId,
      eventType: "ai_responder_toggled" as const,
      payload: { from: false, to: true, via: "messages_v2" },
    });
  }
  await audit(
    d,
    ctx,
    {
      kind: "hold",
      name: action,
      result: "applied",
      detail: action === "dismiss" ? { ...detail, hasReason: true } : detail,
    },
    events,
  );
  return ok(detail);
}

/** Mark the property human-owned (AI responder off, hold cleared) and point at the lead. */
export async function takeOverHold(
  d: HoldActionDeps,
  input: { propertyId: string; seen: HoldSeen },
): Promise<Result<{ leadHref: string }>> {
  const done = await resolveHold(d, input.propertyId, "take_over", null, input.seen);
  if (!done.ok) return done;
  return ok({ leadHref: `/leads/${input.propertyId}` });
}

/** Clear the hold with a required reason. Re-arms automation for the property. */
export async function dismissHold(
  d: HoldActionDeps,
  input: { propertyId: string; reason: string; seen: HoldSeen },
): Promise<Result<null>> {
  const reason = input.reason.trim();
  if (!reason) return fail("REASON_REQUIRED", "Say why you are dismissing this hold.");
  if (reason.length > MAX_DISMISS_REASON_LENGTH) {
    return fail("REASON_TOO_LONG", `Keep the reason under ${MAX_DISMISS_REASON_LENGTH + 1} characters.`);
  }
  const done = await resolveHold(d, input.propertyId, "dismiss", reason, input.seen);
  if (!done.ok) return done;
  return ok(null);
}

/** Assign the property to a teammate through the existing lead assignment action. */
export async function assignHold(
  d: HoldActionDeps,
  input: { propertyId: string; assigneeId: string | null },
): Promise<Result<null>> {
  const property = await loadProperty(d, input.propertyId);
  if (!property.ok) return property;
  const assigned = await d.updateLeadAssignee(input.propertyId, input.assigneeId);
  if (!assigned.ok) return assigned;
  const ctx = await latestRunContext(d, input.propertyId);
  // updateLeadAssignee already wrote the `assigned` lead event with this user as actor.
  await audit(
    d,
    ctx,
    { kind: "action", name: "assign", result: "applied", detail: { assigneeId: input.assigneeId } },
    [],
  );
  return ok(null);
}
