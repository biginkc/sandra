import type { SupabaseClient } from "@supabase/supabase-js";

import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";
import type { AiWrongScope } from "@/lib/ai-responder/types";
import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import type { FinalDecision } from "./haiku-policy";
import { shouldAskHaiku } from "./haiku-policy";
import { DEFAULT_CUTOFF } from "./order";
import type { V2Decision } from "./route";

/**
 * Routing v2 PR-G (flag `wrong_number_all`, default off; also needs `questions_live`).
 *
 * - Wrong person, scope = all, Jev ≥0.60 → the EXISTING approved wrong-number reply
 *   (`APPROVED_REPLY_TEXTS.wrong_number`, template key `wrong_number`; sent by the caller's
 *   existing template step, never reworded here), then the existing wrong_number disposition on
 *   every property for that phone, auto-accepted, one audit row per property, undoable.
 * - "No SMS capabilities" bounce (code pre-check) → the existing bad_number disposition on the
 *   property it landed on. No reply.
 *
 * NOT WIRED into live dispatch: the cutover PR (BUILD-PLAN §6.3) calls `runRoutingV2PhoneAction`.
 * Any result other than `applied` / `replayed` means "run today's path" (flag_off,
 * not_applicable) or "hold for a person" (reply_not_sent, not_applied).
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
  // A Jev answer in the 0.50–0.70 band goes to Haiku first; only a confirmed road may act.
  if (shouldAskHaiku(decision)) {
    if (!final) return { kind: null, reason: "haiku_pending" };
    if (final.hold || final.road !== "wrong_number_close") return { kind: null, reason: "haiku_not_confirmed" };
  }
  return { kind: "wrong_number_all", signal: p.signal, probability: p.probability };
}

export type SendWrongNumberReply = (args: {
  templateKey: typeof WRONG_NUMBER_REPLY_KEY;
  requiredBody: typeof WRONG_NUMBER_REPLY_BODY;
}) => Promise<{ sent: true; outboundMessageId: string } | { sent: false; reason: string }>;

export type PauseEnrollments = (propertyId: string) => Promise<string[]>;

export type RoutingV2PhoneActionInput = {
  orgId: string;
  inboundMessageId: string;
  /** The number that texted (messages.from_address). */
  fromPhone: string;
  decision: V2Decision;
  wrongScope: AiWrongScope | null;
  /** applyHaikuPolicy result when the decision was Haiku-eligible. */
  final?: FinalDecision | null;
};

export type RoutingV2PhoneActionDeps = {
  /** The existing approved-template step (dispatch's runApprovedTemplateStep, wired by the cutover PR). */
  sendWrongNumberReply: SendWrongNumberReply;
  /** Existing sequence pause (pausePropertyEnrollments, reason inbound_reply, not permanent); returns paused ids. */
  pauseEnrollments: PauseEnrollments;
};

export type RoutingV2PhoneActionResult =
  | { outcome: "flag_off" }
  | { outcome: "not_applicable"; reason: string }
  | { outcome: "replayed"; actionId: string; actionStatus: string }
  | { outcome: "reply_not_sent"; actionId: string; reason: string }
  | { outcome: "not_applied"; actionId: string; reason: string }
  | {
      outcome: "applied";
      kind: PhoneActionKind;
      actionId: string;
      applied: string[];
      skipped: Array<{ propertyId: string; reason: string }>;
    };

// New tables/functions are not in the generated types yet; keep the loose access in one place.
type Loose = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args?: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/** True only when both `questions_live` and `wrong_number_all` are exactly true. Errors = off. */
export async function readWrongNumberAllFlag(supabase: SupabaseClient<Database>, orgId: string): Promise<boolean> {
  try {
    const { data, error } = await (supabase as unknown as Loose)
      .from("ai_responder_configs")
      .select("routing_v2_flags")
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    if (error || !data) return false;
    const f = (data as { routing_v2_flags?: unknown }).routing_v2_flags;
    if (typeof f !== "object" || f === null) return false;
    const flags = f as Record<string, unknown>;
    return flags.questions_live === true && flags.wrong_number_all === true;
  } catch {
    return false;
  }
}

export async function runRoutingV2PhoneAction(
  supabase: SupabaseClient<Database>,
  input: RoutingV2PhoneActionInput,
  deps: RoutingV2PhoneActionDeps,
): Promise<RoutingV2PhoneActionResult> {
  // Flag off: one config read, nothing else (today's path runs unchanged).
  if (!(await readWrongNumberAllFlag(supabase, input.orgId))) return { outcome: "flag_off" };

  const candidate = phoneActionCandidate(input.decision, input.wrongScope, input.final);
  if (candidate.kind === null) return { outcome: "not_applicable", reason: candidate.reason };
  const phone = normalizePhone(input.fromPhone);
  if (!phone) return { outcome: "not_applicable", reason: "phone_unusable" };

  const db = supabase as unknown as Loose;
  const { data: claim, error: claimError } = await db.rpc("fn_routing_v2_phone_action_claim", {
    p_source_inbound_message_id: input.inboundMessageId,
    p_action: candidate.kind,
    p_phone: phone,
    p_decision: { signal: candidate.signal, probability: candidate.probability, wrong_scope: input.wrongScope },
  });
  if (claimError) {
    reportError(new Error(String(claimError.message)), {
      tags: { surface: "routing_v2_phone_action_claim" },
      extra: { inboundMessageId: input.inboundMessageId },
    });
    return { outcome: "not_applicable", reason: "claim_failed" };
  }
  const c = claim as { status?: string; actionId?: string; actionStatus?: string; reason?: string } | null;
  if (c?.status === "replayed" && c.actionId) {
    return { outcome: "replayed", actionId: c.actionId, actionStatus: c.actionStatus ?? "unknown" };
  }
  if (c?.status !== "claimed" || !c.actionId) {
    return { outcome: "not_applicable", reason: c?.reason ?? "claim_unexpected" };
  }
  const actionId = c.actionId;

  let replyMessageId: string | null = null;
  if (candidate.kind === "wrong_number_all") {
    let sent: Awaited<ReturnType<SendWrongNumberReply>>;
    try {
      sent = await deps.sendWrongNumberReply({ templateKey: WRONG_NUMBER_REPLY_KEY, requiredBody: WRONG_NUMBER_REPLY_BODY });
    } catch (e) {
      reportError(e, { tags: { surface: "routing_v2_phone_action_reply" }, extra: { actionId } });
      sent = { sent: false, reason: "send_threw" };
    }
    if (!sent.sent) {
      await db
        .from("routing_v2_phone_actions")
        .update({ status: "not_applied", not_applied_reason: `reply_not_sent:${sent.reason}` })
        .eq("id", actionId)
        .eq("status", "claimed");
      return { outcome: "reply_not_sent", actionId, reason: sent.reason };
    }
    replyMessageId = sent.outboundMessageId;
  }

  const { data: applied, error: applyError } = await db.rpc("fn_routing_v2_phone_action_apply", {
    p_action_id: actionId,
    p_reply_message_id: replyMessageId,
  });
  if (applyError) {
    reportError(new Error(String(applyError.message)), { tags: { surface: "routing_v2_phone_action_apply" }, extra: { actionId } });
    return { outcome: "not_applied", actionId, reason: "apply_failed" };
  }
  const a = applied as {
    status?: string;
    actionStatus?: string;
    reason?: string;
    applied?: string[];
    skipped?: Array<{ propertyId: string; reason: string }>;
  } | null;
  if (a?.status === "replayed") return { outcome: "replayed", actionId, actionStatus: a.actionStatus ?? "unknown" };
  if (a?.status !== "applied") return { outcome: "not_applied", actionId, reason: a?.reason ?? "apply_unexpected" };

  // As setResponderDispo does for a wrong_number: pause the property's drips and keep the ids for undo.
  if (candidate.kind === "wrong_number_all") {
    for (const propertyId of a.applied ?? []) {
      try {
        const ids = await deps.pauseEnrollments(propertyId);
        if (ids.length === 0) continue;
        const { error } = await db
          .from("routing_v2_phone_action_properties")
          .update({ paused_enrollment_ids: ids })
          .eq("action_id", actionId)
          .eq("property_id", propertyId)
          .is("undone_at", null);
        if (error) throw new Error(String(error.message));
      } catch (e) {
        reportError(e, { tags: { surface: "routing_v2_phone_action_pause" }, extra: { actionId, propertyId } });
      }
    }
  }
  return { outcome: "applied", kind: candidate.kind, actionId, applied: a.applied ?? [], skipped: a.skipped ?? [] };
}

export type UndoRoutingV2PhoneActionResult =
  | { ok: true; status: "undone" | "partial" | "already_undone"; restored: string[]; stateChanged: string[]; resumed: number; resumeFailed: number }
  | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" | "FAILED"; message: string };

/**
 * A person undoes the action: each property goes back to its exact prior state unless someone
 * changed it since (left alone, listed in `stateChanged`); then the drips this action paused are
 * resumed (the resume RPC re-checks the pause reason, so a person's own pause is kept).
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
  const r = (data ?? {}) as { status?: string; restored?: string[]; stateChanged?: string[]; enrollmentIds?: string[] };
  let resumed = 0;
  let resumeFailed = 0;
  for (const enrollmentId of r.enrollmentIds ?? []) {
    const { data: rows, error: resumeError } = await db.rpc("resume_sequence_enrollment", {
      p_enrollment_id: enrollmentId,
      p_expected_pause_reason: "inbound_reply",
    });
    if (resumeError) {
      resumeFailed += 1;
      reportError(new Error(String(resumeError.message)), { tags: { surface: "routing_v2_phone_action_undo_resume" }, extra: { actionId, enrollmentId } });
      continue;
    }
    if ((rows as Array<{ outcome?: string }> | null)?.[0]?.outcome === "resumed") resumed += 1;
  }
  const status = r.status === "already_undone" ? "already_undone" : r.status === "partial" ? "partial" : "undone";
  return { ok: true, status, restored: r.restored ?? [], stateChanged: r.stateChanged ?? [], resumed, resumeFailed };
}
