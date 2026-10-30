import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import type { V2Action, V2Step } from "./actions";
import type { V2Classification } from "./classify";
import type { ValueLookupResult } from "./dealmachine-value";
import type { RoutingV2Flags } from "./flags";
import type { HaikuEligibility } from "./haiku-eligibility";
import type { FinalDecision } from "./haiku-policy";
import type { V2Decision } from "./route";
import { compileV2Transition } from "./transition-plan";

/** Classification / lookup results (not hold reasons). */
export const V2_JEV_FAILED: Extract<V2Classification, { kind: "failed" }> = Object.freeze({ kind: "failed", reason: "jev_failed" });
/** No DealMachine key configured: the approved no-value path (fair-price reply + alert). */
export const DEALMACHINE_NO_KEY: ValueLookupResult = Object.freeze({ kind: "no_value", reason: "no_api_key" });

/**
 * Outbox delivery refusal reasons (not hold reasons: a refused reply holds as
 * `nine_reply_not_sent:<reason>`, an existing registered family).
 */
export const V2_OUTBOX_REASON = Object.freeze({
  notAReply: "not_a_reply",
  expired: "expired",
  malformedIntent: "malformed_intent",
  inboundUnreadable: "inbound_unreadable",
  configUnreadable: "config_unreadable",
  quietHours: (why: string) => `quiet_hours_recipient:${why}`,
});

/**
 * Routing v2 cutover (a): the live dispatch glue that is independent of dispatch.ts.
 *
 * Every live effect is driven by the STORED decision row (routing_v2_live_decisions), never
 * by a freshly computed classification: a duplicate webhook / retry that classifies again
 * cannot swap the effects of the first, recorded decision.
 */
export type StoredLiveEvidence = {
  status: "decided" | "failed";
  org_id: string;
  property_id: string;
  road: string | null;
  jev_road: string | null;
  provenance: V2Decision["provenance"] | null;
  haiku_eligibility: HaikuEligibility;
  haiku: {
    final_road: FinalDecision["road"];
    final_by: FinalDecision["by"];
    hold: boolean;
    alert: string | null;
    failure_reason: string | null;
  } | null;
  opportunity_alert: boolean | null;
  action: V2Action | null;
  expected_revision: number;
  failure_reason: string | null;
};

type Loose = {
  from: (table: string) => {
    select: (cols: string) => { eq: (k: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> } };
  };
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

const EVIDENCE_COLUMNS =
  "status, org_id, property_id, road, jev_road, provenance, haiku_eligibility, haiku, opportunity_alert, action, expected_revision, failure_reason";

/** The durable decision for this inbound, or null when unreadable / missing. */
export async function readLiveV2Evidence(db: SupabaseClient<Database>, inboundMessageId: string): Promise<StoredLiveEvidence | null> {
  try {
    const { data, error } = await (db as unknown as Loose)
      .from("routing_v2_live_decisions").select(EVIDENCE_COLUMNS).eq("inbound_message_id", inboundMessageId).maybeSingle();
    if (error || !data) return null;
    return data as StoredLiveEvidence;
  } catch {
    return null;
  }
}

/** The original Jev decision, rebuilt from evidence (for the stop / phone adapters' own checks). */
export function storedV2Decision(e: StoredLiveEvidence): V2Decision | null {
  if (e.status !== "decided" || !e.provenance) return null;
  return {
    road: (e.jev_road ?? null) as V2Decision["road"],
    provenance: e.provenance,
    haiku: e.haiku_eligibility ?? null,
    opportunityAlert: e.opportunity_alert === true,
  };
}

/** applyHaikuPolicy's result as recorded (null when the Haiku policy did not run). */
export function storedFinalDecision(e: StoredLiveEvidence): FinalDecision | null {
  const h = e.haiku;
  if (!h) return null;
  return { road: h.final_road, by: h.final_by, hold: h.hold, alert: h.alert, failureReason: h.failure_reason };
}

export type V2LiveStep =
  /** Jev failed or was incomplete: today's classifier-failure hold. */
  | { kind: "failed"; reason: string }
  /** Stop / legal / hostile road: the PR-I stop adapter decides (suppress, or hold + alert). */
  | { kind: "stop" }
  /** Wrong person / sold / tenant: approved reply + close (phone-wide only via PR-G). */
  | { kind: "wrong_number" }
  /** "No SMS capabilities" bounce: PR-G bad-number adapter, else today's hold. */
  | { kind: "bad_number" }
  /** Any other hold (Haiku unsure / error, possible stop, needs a person): hold + stored alerts. */
  | { kind: "hold"; reason: Extract<V2Step, { kind: "hold" }>["reason"] }
  /** Normal road: one atomic transition (retire drip, enroll, queue reply + alerts). */
  | { kind: "transition" };

export function liveStepFor(e: StoredLiveEvidence): V2LiveStep {
  if (e.status === "failed" || !e.action) return { kind: "failed", reason: e.failure_reason ?? "evidence_missing" };
  const steps = e.action.steps;
  if (e.action.road === "stop") return { kind: "stop" };
  if (steps.some((s) => s.kind === "wrong_number_close")) return { kind: "wrong_number" };
  if (e.action.road === "bad_number") return { kind: "bad_number" };
  const hold = steps.find((s): s is Extract<V2Step, { kind: "hold" }> => s.kind === "hold");
  if (hold) return { kind: "hold", reason: hold.reason };
  return { kind: "transition" };
}

/** Existing, registered hold reasons only (hold-alerts KNOWN_HOLD_REASONS). */
export function liveHoldReason(reason: Extract<V2Step, { kind: "hold" }>["reason"]): "nine_asked_stop" | "nine_needs_person" {
  return reason === "asked_stop" ? "nine_asked_stop" : "nine_needs_person";
}

/**
 * Queue the stored action's owner alerts for a held decision (exactly once; no reply, no drip).
 * Returns the number queued, or null when nothing could be recorded (the hold still stands).
 */
export async function queueLiveHoldAlerts(
  db: SupabaseClient<Database>,
  e: StoredLiveEvidence,
  input: { flags: RoutingV2Flags; propertyId: string; contactId: string; inboundMessageId: string },
): Promise<number | null> {
  if (!e.action || !e.action.steps.some((s) => s.kind === "alert")) return 0;
  try {
    const alertsOnly: V2Action = { road: e.action.road, steps: e.action.steps.filter((s) => s.kind === "alert") };
    const plan = compileV2Transition(alertsOnly, input);
    const { data, error } = await (db as unknown as Loose).rpc("routing_v2_record_live_hold", {
      p_inbound_message_id: input.inboundMessageId,
      p_property_id: input.propertyId,
      p_decision: plan,
    });
    if (error || !data) return null;
    const r = data as { outcome?: string; alerts_queued?: number; replayed?: boolean };
    if (r.replayed) return 0;
    return r.outcome === "held" && typeof r.alerts_queued === "number" ? r.alerts_queued : null;
  } catch {
    return null;
  }
}
