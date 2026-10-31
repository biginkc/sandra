import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import type { V2Action, V2Step } from "./actions";
import type { V2Classification } from "./classify";
import type { ValueLookupResult } from "./dealmachine-value";
import { isV2Eligible, readRoutingV2Flags, type RoutingV2Flags } from "./flags";
import type { HaikuEligibility } from "./haiku-eligibility";
import type { FinalDecision } from "./haiku-policy";
import type { V2Decision } from "./route";
import { compileV2Transition } from "./transition-plan";

/** Classification / lookup results (not hold reasons). */
export const V2_JEV_FAILED: Extract<V2Classification, { kind: "failed" }> = Object.freeze({ kind: "failed", reason: "jev_failed" });
/** No DealMachine key configured: the approved no-value path (fair-price reply + alert). */
export const DEALMACHINE_NO_KEY: ValueLookupResult = Object.freeze({ kind: "no_value", reason: "no_api_key" });

/** The stop adapter could not run (no inbound phone): today's human-review path. */
export const MODEL_STOP_NO_PHONE = Object.freeze({ kind: "human_review" as const, reason: "model_stop_failed:no_phone" as const });

/**
 * Live v2 Jev call policy (A-4): the same bounded retries as the legacy classifier
 * (askJev's default: 2 retries with backoff on 429 / 5xx / timeout; auth and billing errors
 * never retry). A Jev call only reads, and the decision is recorded once per inbound
 * (routing_v2_live_decisions.inbound_message_id is unique), so a retry is idempotent.
 */
export const V2_LIVE_JEV_POLICY = Object.freeze({ maxRetries: 2, timeoutMs: 8000 });

type SpendRpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> };
const tokens = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/**
 * Spend ledger (A-6): one row per Jev call and per Haiku call for this inbound (count +
 * tokens, + cost when reported). Accounting only, never blocks or changes routing.
 */
export async function recordV2ModelSpend(
  db: SupabaseClient<Database>,
  ctx: { orgId: string; propertyId: string; inboundMessageId: string },
  result: V2Classification,
  report: (e: unknown) => void,
): Promise<void> {
  if (result.kind === "off") return;
  const rows: Array<Record<string, unknown>> = [{
    p_provider: "jev", p_outcome: result.kind === "decided" ? "decided" : result.reason,
    p_input_tokens: result.kind === "decided" ? tokens(result.jevUsage?.input_tokens) : null,
    p_output_tokens: result.kind === "decided" ? tokens(result.jevUsage?.output_tokens) : null,
    p_cost: null, p_cost_unit: "usd",
  }];
  if (result.kind === "decided" && result.haiku) {
    const h = result.haiku as { ok?: boolean; reason?: string; inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown };
    rows.push({
      p_provider: "haiku", p_outcome: h.ok ? "answered" : (h.reason ?? "failed"),
      p_input_tokens: tokens(h.inputTokens), p_output_tokens: tokens(h.outputTokens),
      p_cost: typeof h.costUsd === "number" && Number.isFinite(h.costUsd) ? h.costUsd : null, p_cost_unit: "usd",
    });
  }
  for (const row of rows) {
    try {
      const { error } = await (db as unknown as SpendRpc).rpc("fn_record_model_call", {
        ...row, p_org_id: ctx.orgId, p_property_id: ctx.propertyId, p_inbound_message_id: ctx.inboundMessageId,
      });
      if (error) throw new Error(error.message);
    } catch (e) {
      report(e);
    }
  }
}

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

/**
 * AUDIT (stress review): exactly one v2 audit row per inbound on a v2-live property. Called
 * after the live path has finished with an inbound (terminal stamp, keyword exit). If the v2
 * engine already recorded a decision this is a no-op (the inbound id is unique); otherwise a
 * `not_routed` row records why. Never throws, never changes the live path.
 */
export async function recordRoutingV2Audit(
  db: SupabaseClient<Database>,
  input: { orgId?: string | null; propertyId: string | null; inboundMessageId: string | null; conversationId?: string | null; /** Why v2 did not decide it (audit note, not a hold reason). */ note: string },
  report: (e: unknown) => void = () => {},
): Promise<"recorded" | "exists" | "skipped"> {
  try {
    if (!input.propertyId || !input.inboundMessageId) return "skipped";
    let orgId = input.orgId ?? null;
    if (!orgId) {
      const { data } = await db.from("properties").select("org_id").eq("id", input.propertyId).maybeSingle();
      orgId = (data as { org_id?: string } | null)?.org_id ?? null;
    }
    if (!orgId) return "skipped";
    const flags = await readRoutingV2Flags(db, orgId);
    if (!flags.questions_live || !isV2Eligible(flags, input.propertyId)) return "skipped";
    const { data: prop } = await db.from("properties").select("decision_context_revision").eq("id", input.propertyId).maybeSingle();
    const { error } = await (db as unknown as { from: (t: string) => { insert: (r: Record<string, unknown>) => PromiseLike<{ error: { code?: string; message: string } | null }> } })
      .from("routing_v2_live_decisions").insert({
        org_id: orgId, property_id: input.propertyId, conversation_id: input.conversationId ?? null,
        inbound_message_id: input.inboundMessageId, status: "not_routed", failure_reason: input.note.slice(0, 200),
        expected_revision: Math.max(0, Number((prop as { decision_context_revision?: number } | null)?.decision_context_revision ?? 0)),
      });
    if (!error) return "recorded";
    if (error.code === "23505") return "exists";
    throw new Error(error.message);
  } catch (e) {
    report(e);
    return "skipped";
  }
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
