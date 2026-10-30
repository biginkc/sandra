import type { SupabaseClient } from "@supabase/supabase-js";

import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";
import type { AiWrongScope } from "@/lib/ai-responder/types";
import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import type { FinalDecision } from "./haiku-policy";
import { shouldAskHaiku } from "./haiku-policy";
import { readRoutingV2Flags, v2SliceAllowedForAll } from "./flags";
import { DEFAULT_CUTOFF } from "./order";
import type { V2Decision } from "./route";

/**
 * Routing v2 PR-G (flag `wrong_number_all`, default off; also needs `questions_live`).
 *
 * - Wrong person, scope = all, Jev ≥0.60 → (A, one transaction) the existing wrong_number
 *   disposition on every property for that phone, drips paused, auto-accepted, one audit row per
 *   property, undoable; then (B) the EXISTING approved wrong-number reply
 *   (`APPROVED_REPLY_TEXTS.wrong_number`, template key `wrong_number`; sent by the caller's
 *   existing template step with the durable send id, never reworded here).
 * - "No SMS capabilities" bounce (code pre-check) → the existing bad_number disposition on the
 *   property it landed on. No reply.
 *
 * NOT WIRED into live dispatch: the cutover PR (BUILD-PLAN §6.3) calls `runRoutingV2PhoneAction`.
 * `flag_off` / `not_applicable` mean "run today's path"; `superseded` means a newer text from
 * the phone owns the thread; `not_settled` means the inbound is under 30 s old (call again after
 * `retryAfterSeconds`; nothing was written); `apply_failed` wrote nothing and may be retried; `applied` /
 * `replayed` carry the reply state (failed / unknown / skipped = a person should look).
 *
 * The v2 question set has no wrong-number scope question: the caller must supply `wrongScope`
 * from an existing source. Without it (null) nothing runs.
 */
export const WRONG_NUMBER_ALL_MIN_PROBABILITY = DEFAULT_CUTOFF;
export const WRONG_NUMBER_REPLY_KEY = "wrong_number" as const;
export const WRONG_NUMBER_REPLY_BODY = APPROVED_REPLY_TEXTS.wrong_number;

export type PhoneActionKind = "wrong_number_all" | "bad_number";

export type PhoneActionCandidate =
  | { kind: PhoneActionKind; signal: string; probability: number | null }
  | { kind: null; reason: string };

/** Pure: does this v2 decision qualify for a phone-level action? */
export function phoneActionCandidate(
  decision: V2Decision,
  wrongScope: AiWrongScope | null,
  final?: FinalDecision | null,
): PhoneActionCandidate {
  const p = decision.provenance;
  if (decision.road === "bad_number" && p.by === "code" && p.check === "bad_number") {
    return { kind: "bad_number", signal: "code:bad_number", probability: null };
  }
  if (decision.road !== "wrong_number_close" || p.by !== "jev" || p.signal === null) {
    return { kind: null, reason: "not_wrong_number" };
  }
  if (p.signal !== "wrong_person") return { kind: null, reason: "not_wrong_person" };
  if (!(p.probability >= WRONG_NUMBER_ALL_MIN_PROBABILITY)) return { kind: null, reason: "below_cutoff" };
  if (wrongScope !== "all") return { kind: null, reason: "scope_not_all" };
  // ORDER-TABLE: the Jev ≥0.60 road wins; in the 0.50–0.70 band Haiku decides; if Haiku is
  // unsure, Jev's road stands (applyHaikuPolicy → road wrong_number_close, by jev_haiku_unsure).
  // A Haiku hold/failure or a different Haiku road does not qualify. The SQL re-derives this from
  // the persisted decision row; this check only saves a round trip.
  if (shouldAskHaiku(decision)) {
    if (!final) return { kind: null, reason: "haiku_pending" };
    if (final.hold || final.road !== "wrong_number_close") return { kind: null, reason: "haiku_not_confirmed" };
  }
  return { kind: "wrong_number_all", signal: p.signal, probability: p.probability };
}

export type SendWrongNumberReply = (args: {
  templateKey: typeof WRONG_NUMBER_REPLY_KEY;
  requiredBody: typeof WRONG_NUMBER_REPLY_BODY;
  /**
   * Durable send id. The template step MUST use it as the provider idempotency key and store
   * it on the outbound message as `messages.idempotency_key`: crash recovery finds the reply
   * by this id only.
   */
  sendId: string;
  /**
   * Final send-boundary check (§13.2): fresh flags + canary for every target property. Call it
   * immediately before the provider call; if false, send nothing and return
   * `{ sent: false, reason: "not_allowed_at_send", reachedProvider: false }`.
   */
  stillAllowed: () => Promise<boolean>;
}) => Promise<
  | { sent: true; outboundMessageId: string }
  /** reachedProvider false = provably never handed to the provider (recorded as skipped/failed). */
  | { sent: false; reason: string; reachedProvider: boolean }
>;

export type RoutingV2PhoneActionInput = {
  orgId: string;
  inboundMessageId: string;
  /** The number that texted (messages.from_address). */
  fromPhone: string;
  decision: V2Decision;
  wrongScope: AiWrongScope | null;
  /** applyHaikuPolicy result when the decision was Haiku-eligible. */
  final?: FinalDecision | null;
  /** properties.decision_context_revision the decision was made against (optional). */
  expectedRevision?: number | null;
};

export type RoutingV2PhoneActionDeps = {
  /** The existing approved-template step (dispatch's runApprovedTemplateStep, wired by the cutover PR). */
  sendWrongNumberReply: SendWrongNumberReply;
};

export type ReplyState = "pending" | "sending" | "sent" | "failed" | "unknown" | "skipped" | "not_needed";

export type RoutingV2PhoneActionResult =
  | { outcome: "flag_off" }
  | { outcome: "not_applicable"; reason: string }
  | { outcome: "superseded"; reason: string }
  /** The inbound is under 30 s old (settle window): nothing written; retry after the delay. */
  | { outcome: "not_settled"; retryable: true; retryAfterSeconds: number }
  /** The atomic apply failed and rolled back: nothing was written; safe to retry. */
  | { outcome: "apply_failed"; retryable: true }
  | { outcome: "replayed"; actionId: string; actionStatus: string; replyState: ReplyState }
  | {
      outcome: "applied";
      kind: PhoneActionKind;
      actionId: string;
      applied: string[];
      skipped: Array<{ propertyId: string; reason: string }>;
      replyState: ReplyState;
    };

// New tables/functions are not in the generated types yet; keep the loose access in one place.
type Loose = {
  rpc: (fn: string, args?: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

async function stillAllowed(supabase: SupabaseClient<Database>, orgId: string, propertyIds: readonly string[]): Promise<boolean> {
  try {
    return v2SliceAllowedForAll(await readRoutingV2Flags(supabase, orgId), "wrong_number_all", propertyIds);
  } catch {
    return false;
  }
}

async function setReply(db: Loose, actionId: string, sendId: string, to: ReplyState, extra: { messageId?: string; reason?: string } = {}) {
  const { data, error } = await db.rpc("fn_routing_v2_phone_action_reply", {
    p_action_id: actionId,
    p_send_id: sendId,
    p_to: to,
    p_message_id: extra.messageId ?? null,
    p_reason: extra.reason ?? null,
  });
  if (error) throw new Error(String(error.message));
  return (data ?? {}) as { ok?: boolean; replyState?: ReplyState };
}

/**
 * B. Send the approved reply AFTER the apply committed. At most once: `pending → sending` is an
 * atomic transition taken before the provider call, and a `sending` row is only ever settled by
 * its send id (recover_reply), never re-sent. Properties stay closed whatever happens here, as
 * today's wrong-number path does.
 */
export async function settleRoutingV2PhoneActionReply(
  supabase: SupabaseClient<Database>,
  args: { orgId: string; actionId: string; sendId: string; replyState: ReplyState; propertyIds: readonly string[] },
  deps: RoutingV2PhoneActionDeps,
): Promise<ReplyState> {
  const db = supabase as unknown as Loose;
  if (args.replyState === "sending") {
    const { data, error } = await db.rpc("fn_routing_v2_phone_action_recover_reply", { p_action_id: args.actionId });
    if (error) throw new Error(String(error.message));
    return ((data ?? {}) as { replyState?: ReplyState }).replyState ?? "sending";
  }
  if (args.replyState !== "pending") return args.replyState;

  // E. Flags/canary off after the apply committed: record skipped, send nothing.
  if (!(await stillAllowed(supabase, args.orgId, args.propertyIds))) {
    const r = await setReply(db, args.actionId, args.sendId, "skipped", { reason: "flag_or_canary_off_before_send" });
    return r.replyState ?? "skipped";
  }
  const begun = await setReply(db, args.actionId, args.sendId, "sending");
  if (!begun.ok) return begun.replyState ?? "sending"; // another worker owns the send

  let sent: Awaited<ReturnType<SendWrongNumberReply>>;
  try {
    sent = await deps.sendWrongNumberReply({
      templateKey: WRONG_NUMBER_REPLY_KEY,
      requiredBody: WRONG_NUMBER_REPLY_BODY,
      sendId: args.sendId,
      stillAllowed: () => stillAllowed(supabase, args.orgId, args.propertyIds),
    });
  } catch (e) {
    reportError(e, { tags: { surface: "routing_v2_phone_action_reply" }, extra: { actionId: args.actionId } });
    // We cannot prove the provider never got it: recorded as unknown, never re-sent.
    return (await setReply(db, args.actionId, args.sendId, "unknown", { reason: "send_threw" })).replyState ?? "unknown";
  }
  if (sent.sent) {
    return (await setReply(db, args.actionId, args.sendId, "sent", { messageId: sent.outboundMessageId })).replyState ?? "sent";
  }
  const to: ReplyState = sent.reachedProvider ? "unknown" : "failed";
  return (await setReply(db, args.actionId, args.sendId, to, { reason: sent.reason })).replyState ?? to;
}

export async function runRoutingV2PhoneAction(
  supabase: SupabaseClient<Database>,
  input: RoutingV2PhoneActionInput,
  deps: RoutingV2PhoneActionDeps,
): Promise<RoutingV2PhoneActionResult> {
  // Flag off: one config read, nothing else (today's path runs unchanged). flags.ts is the
  // single parser; any error or malformed value reads as off.
  const flags = await readRoutingV2Flags(supabase, input.orgId);
  if (!(flags.questions_live && flags.wrong_number_all)) return { outcome: "flag_off" };

  const candidate = phoneActionCandidate(input.decision, input.wrongScope, input.final);
  if (candidate.kind === null) return { outcome: "not_applicable", reason: candidate.reason };
  const phone = normalizePhone(input.fromPhone);
  if (!phone) return { outcome: "not_applicable", reason: "phone_unusable" };

  const db = supabase as unknown as Loose;
  // A. Everything except the SMS, atomically (the RPC re-reads flags + canary itself).
  const { data, error } = await db.rpc("fn_routing_v2_phone_action_apply_all", {
    p_source_inbound_message_id: input.inboundMessageId,
    p_action: candidate.kind,
    p_phone: phone,
    p_decision: { signal: candidate.signal, probability: candidate.probability, wrong_scope: input.wrongScope },
    p_expected_revision: input.expectedRevision ?? null,
  });
  if (error) {
    reportError(new Error(String(error.message)), {
      tags: { surface: "routing_v2_phone_action_apply" },
      extra: { inboundMessageId: input.inboundMessageId },
    });
    return { outcome: "apply_failed", retryable: true };
  }
  const a = (data ?? {}) as {
    status?: string;
    reason?: string;
    actionId?: string;
    actionStatus?: string;
    sendId?: string;
    replyState?: ReplyState;
    applied?: string[];
    skipped?: Array<{ propertyId: string; reason: string }>;
    propertyIds?: string[];
    retryAfterSeconds?: number;
  };
  if (a.status === "superseded") return { outcome: "superseded", reason: a.reason ?? "superseded" };
  if (a.status === "not_settled") return { outcome: "not_settled", retryable: true, retryAfterSeconds: a.retryAfterSeconds ?? 30 };
  if (a.status === "not_applicable") return { outcome: "not_applicable", reason: a.reason ?? "not_applicable" };
  if ((a.status !== "applied" && a.status !== "replayed") || !a.actionId || !a.sendId || !a.replyState) {
    return { outcome: "apply_failed", retryable: true };
  }

  // B. Duplicate webhook of a committed action: only an unfinished reply is settled.
  let replyState = a.replyState;
  if (a.status === "replayed" && a.actionStatus !== "applied") {
    return { outcome: "replayed", actionId: a.actionId, actionStatus: a.actionStatus ?? "unknown", replyState };
  }
  if (replyState === "pending" || replyState === "sending") {
    try {
      replyState = await settleRoutingV2PhoneActionReply(
        supabase,
        { orgId: input.orgId, actionId: a.actionId, sendId: a.sendId, replyState, propertyIds: a.propertyIds ?? [] },
        deps,
      );
    } catch (e) {
      // The apply is committed; the reply stays pending/sending for the settler. Never swallowed silently.
      reportError(e, { tags: { surface: "routing_v2_phone_action_reply_state" }, extra: { actionId: a.actionId } });
    }
  }
  if (a.status === "replayed") {
    return { outcome: "replayed", actionId: a.actionId, actionStatus: a.actionStatus ?? "applied", replyState };
  }
  return { outcome: "applied", kind: candidate.kind, actionId: a.actionId, applied: a.applied ?? [], skipped: a.skipped ?? [], replyState };
}

/** Settler (cron): finishes replies left pending/sending by a crash. Sends at most once. */
export async function settleUnsettledRoutingV2PhoneReplies(
  supabase: SupabaseClient<Database>,
  deps: RoutingV2PhoneActionDeps,
  options: { olderThanSeconds?: number; limit?: number } = {},
): Promise<Array<{ actionId: string; replyState: ReplyState | "error" }>> {
  const db = supabase as unknown as Loose & { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data, error } = await db.rpc("fn_routing_v2_phone_action_unsettled_replies", {
    p_older_than_seconds: options.olderThanSeconds ?? 120,
    p_limit: options.limit ?? 25,
  });
  if (error) {
    reportError(new Error(String(error.message)), { tags: { surface: "routing_v2_phone_action_settler" } });
    return [];
  }
  const out: Array<{ actionId: string; replyState: ReplyState | "error" }> = [];
  for (const row of (data ?? []) as Array<{ action_id: string; org_id: string; reply_state: ReplyState }>) {
    try {
      const { data: action, error: readError } = await db
        .from("routing_v2_phone_actions")
        .select("send_id, property_ids")
        .eq("id", row.action_id)
        .maybeSingle();
      if (readError || !action) throw new Error(readError ? String(readError.message) : "action not found");
      const act = action as { send_id: string; property_ids: string[] };
      out.push({
        actionId: row.action_id,
        replyState: await settleRoutingV2PhoneActionReply(
          supabase,
          { orgId: row.org_id, actionId: row.action_id, sendId: act.send_id, replyState: row.reply_state, propertyIds: act.property_ids },
          deps,
        ),
      });
    } catch (e) {
      reportError(e, { tags: { surface: "routing_v2_phone_action_settler" }, extra: { actionId: row.action_id } });
      out.push({ actionId: row.action_id, replyState: "error" });
    }
  }
  return out;
}

export type UndoRoutingV2PhoneActionResult =
  | {
      ok: true;
      status: "undone" | "partial" | "already_undone";
      restored: string[];
      stateChanged: string[];
      skipped: Array<{ propertyId: string; reason: string }>;
      resumed: number;
      notResumed: Array<{ enrollmentId: string; outcome: string }>;
    }
  | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" | "BUSY" | "FAILED"; message: string };

/**
 * C. A person undoes the action, in one transaction under the phone lock: each property goes
 * back to its exact prior state unless something changed since (left alone, listed in
 * `skipped`), nothing is restored while the phone is suppressed, and exactly the drips this
 * action paused are resumed (each re-checked by resume_sequence_enrollment).
 */
export async function undoRoutingV2PhoneAction(
  userClient: SupabaseClient<Database>,
  actionId: string,
): Promise<UndoRoutingV2PhoneActionResult> {
  const db = userClient as unknown as Loose;
  const { data, error } = await db.rpc("fn_undo_routing_v2_phone_action", { p_action_id: actionId });
  if (error) {
    const m = String(error.message);
    if (m.includes("NOT_FOUND")) return { ok: false, code: "NOT_FOUND", message: "Nothing to undo." };
    if (m.includes("FORBIDDEN") || m.includes("AUTHENTICATION_REQUIRED")) {
      return { ok: false, code: "FORBIDDEN", message: "You cannot undo this." };
    }
    reportError(new Error(m), { tags: { surface: "routing_v2_phone_action_undo" }, extra: { actionId } });
    return { ok: false, code: "FAILED", message: "Could not undo. Try again." };
  }
  const r = (data ?? {}) as {
    status?: string;
    restored?: string[];
    stateChanged?: string[];
    skipped?: Array<{ propertyId: string; reason: string }>;
    resumed?: number;
    notResumed?: Array<{ enrollmentId: string; outcome: string }>;
  };
  if (r.status === "busy") return { ok: false, code: "BUSY", message: "Busy right now. Try again in a moment." };
  const status = r.status === "already_undone" ? "already_undone" : r.status === "partial" ? "partial" : "undone";
  return {
    ok: true,
    status,
    restored: r.restored ?? [],
    stateChanged: r.stateChanged ?? [],
    skipped: r.skipped ?? [],
    resumed: r.resumed ?? 0,
    notResumed: r.notResumed ?? [],
  };
}
