import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import type { FinalDecision } from "./haiku-policy";
import { ALL_OFF, readRoutingV2Flags, v2SliceAllowedForAll, type RoutingV2Flags } from "./flags";
import { decideV2StopAction, isStopDecision, type V2StopAction } from "./model-stop";
import type { V2Decision } from "./route";

/**
 * Routing v2 PR-I: carries out the stop decision (model-stop.ts). Not wired into live
 * dispatch: the routing v2 executor calls this for the `stop` road once the cutover PR
 * makes v2 live. Until then nothing calls it, and with the flag off nothing is written.
 *
 * Flags AND canary eligibility are checked twice (BUILD-PLAN §13.1/§13.2):
 * - here, from a fresh flags read (flags.ts) and the properties sharing the phone
 *   (fn_model_stop_phone_property_ids): every one of them must be eligible;
 * - again inside fn_apply_model_stop_suppression at write time, with the SQL twin of
 *   flags.ts (fn_routing_v2_property_eligible), so a flip between decision and write
 *   writes nothing.
 * Flag off, not eligible, or any failure → today's human-review path (a hold), never a send.
 */
type Loose = { rpc: (fn: string, args: Record<string, unknown>) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export type ModelStopInput = {
  orgId: string;
  propertyId: string;
  contactId: string | null;
  inboundMessageId: string;
  /** The seller's phone (the inbound's from address). */
  phone: string;
  decision: V2Decision;
  final: FinalDecision | null;
};

export type ModelStopDeps = {
  /** Fresh flags read; defaults to flags.ts readRoutingV2Flags. */
  readFlags?: () => Promise<RoutingV2Flags>;
};

export type ModelStopOutcome =
  | { kind: "not_stop" }
  /** Today's human-review path: flag off, not canary-eligible, or a failure. */
  | {
      kind: "human_review";
      reason: "flag_off" | "not_eligible" | "model_stop_failed:no_phone" | "model_stop_failed:eligibility" | "model_stop_failed:write";
    }
  | { kind: "suppressed"; suppressionId: string | null; status: "suppressed" | "already_suppressed" | "duplicate" }
  | { kind: "hold_alert"; alert: string; reason: string };

export async function executeV2Stop(
  admin: SupabaseClient<Database>,
  input: ModelStopInput,
  deps: ModelStopDeps = {},
): Promise<ModelStopOutcome> {
  if (!isStopDecision(input.decision, input.final)) return { kind: "not_stop" };
  let flags: RoutingV2Flags;
  try {
    flags = deps.readFlags ? await deps.readFlags() : await readRoutingV2Flags(admin, input.orgId);
  } catch {
    flags = ALL_OFF;
  }
  if (!(flags.questions_live && flags.model_stop_suppression)) return { kind: "human_review", reason: "flag_off" };

  // Same normalizer as the database side (dialpad_cti_normalize_us_phone).
  const phone = normalizePhone(input.phone);
  if (!phone) return { kind: "human_review", reason: "model_stop_failed:no_phone" };

  // Phone-level action (§13.1): every property on this phone must be eligible right now.
  let phonePropertyIds: string[];
  try {
    const { data, error } = await (admin as unknown as Loose).rpc("fn_model_stop_phone_property_ids", {
      p_org_id: input.orgId,
      p_phone_e164: phone,
      p_property_id: input.propertyId,
    });
    if (error) throw new Error(String(error.message));
    // null = the database could not decide the phone set (un-normalizable phone data): fail closed.
    if (data === null) return { kind: "human_review", reason: "not_eligible" };
    if (!Array.isArray(data) || !(data as unknown[]).every((v) => typeof v === "string")) {
      throw new Error("phone property ids: not a uuid array");
    }
    phonePropertyIds = data as string[];
  } catch (e) {
    reportError(e instanceof Error ? e : new Error(String(e)), {
      tags: { surface: "routing_v2_model_stop_eligibility" },
      extra: { propertyId: input.propertyId },
    });
    return { kind: "human_review", reason: "model_stop_failed:eligibility" };
  }
  const ids = Array.from(new Set([input.propertyId, ...phonePropertyIds]));
  if (!v2SliceAllowedForAll(flags, "model_stop_suppression", ids)) return { kind: "human_review", reason: "not_eligible" };

  const action: V2StopAction = decideV2StopAction({ decision: input.decision, final: input.final, modelStopSuppression: true });
  if (action.kind === "not_stop") return { kind: "not_stop" };
  if (action.kind === "human_review") return { kind: "human_review", reason: "flag_off" };
  if (action.kind === "hold_alert") return { kind: "hold_alert", alert: action.alert, reason: `model_stop_hold:${action.by}` };

  try {
    const { data, error } = await (admin as unknown as Loose).rpc("fn_apply_model_stop_suppression", {
      p_org_id: input.orgId,
      p_phone_e164: phone,
      p_inbound_message_id: input.inboundMessageId,
      p_property_id: input.propertyId,
      p_contact_id: input.contactId,
      p_detail: { step: action.step, signal: action.signal, probability: action.probability },
    });
    if (error) throw new Error(String(error.message));
    const r = (data ?? {}) as { status?: string; suppressionId?: string | null };
    if (r.status === "flag_off") return { kind: "human_review", reason: "flag_off" };
    if (r.status === "not_eligible") return { kind: "human_review", reason: "not_eligible" };
    if (r.status === "suppressed" || r.status === "already_suppressed" || r.status === "duplicate") {
      return { kind: "suppressed", suppressionId: r.suppressionId ?? null, status: r.status };
    }
    throw new Error(`unexpected status ${String(r.status)}`);
  } catch (e) {
    reportError(e instanceof Error ? e : new Error(String(e)), {
      tags: { surface: "routing_v2_model_stop_apply" },
      extra: { propertyId: input.propertyId, inboundMessageId: input.inboundMessageId },
    });
    // Fail safe: today's human-review path; nothing is sent.
    return { kind: "human_review", reason: "model_stop_failed:write" };
  }
}

export type LiftModelStopResult =
  | { ok: true; status: "lifted" | "already_lifted" }
  | { ok: false; code: "NOT_MODEL_STOP" | "NOT_FOUND" | "FORBIDDEN" | "FAILED"; message: string };

/**
 * Lifts a `model_stop` suppression (fn_lift_model_stop_suppression, audited). Carrier STOP,
 * DNC and human-confirmed rows are refused by the database, whatever the caller passes.
 * Must be called with the signed-in user's client (auth.uid() is the audited actor).
 */
export async function liftModelStopSuppression(
  userClient: SupabaseClient<Database>,
  suppressionId: string,
  note?: string | null,
): Promise<LiftModelStopResult> {
  const { data, error } = await (userClient as unknown as Loose).rpc("fn_lift_model_stop_suppression", {
    p_suppression_id: suppressionId,
    p_note: note ?? null,
  });
  if (error) {
    const m = String(error.message);
    if (m.includes("NOT_FOUND")) return { ok: false, code: "NOT_FOUND", message: "Nothing to undo." };
    if (m.includes("FORBIDDEN") || m.includes("AUTHENTICATION_REQUIRED")) {
      return { ok: false, code: "FORBIDDEN", message: "You cannot undo this." };
    }
    reportError(new Error(m), { tags: { surface: "routing_v2_model_stop_lift" }, extra: { suppressionId } });
    return { ok: false, code: "FAILED", message: "Could not undo. Try again." };
  }
  const status = (data as { status?: string } | null)?.status;
  if (status === "lifted" || status === "already_lifted") return { ok: true, status };
  if (status === "not_model_stop") {
    return { ok: false, code: "NOT_MODEL_STOP", message: "This number was opted out another way, so it stays blocked." };
  }
  reportError(new Error(`unexpected lift status ${String(status)}`), { tags: { surface: "routing_v2_model_stop_lift" }, extra: { suppressionId } });
  return { ok: false, code: "FAILED", message: "Could not undo. Try again." };
}
