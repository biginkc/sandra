import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { recordStep, type MaybeRunContext } from "@/lib/pipeline-runs";
import { enrollLead } from "@/lib/sequences/enrollment";
import type { Database } from "@/lib/supabase/types";
import { buildTwoWayThreadState } from "@/lib/sms-classification/context";
import {
  actionForNineAnswer,
  classifyNineQuestions,
  type NineDripName,
  type NineQuestionResult,
} from "@/lib/sms-classification/nine-questions";
import { JevProviderError } from "@/lib/sms-classification/providers/jev-gateway";
import { JEV_MODEL } from "@/lib/sms-classification/questions";

/**
 * Engine half of Messages v2 PR 3 (Jarrad's nine questions). Everything here is
 * free of the dispatch pipeline: classify + persist the decision, and look up /
 * enrol the named drips. The orchestration (which reply, which hold) lives in
 * `dispatch.ts` (`runNineQuestionsStep`) because it needs the send path.
 */

export const CLASSIFIER_ENGINES = ["outcome_v1", "nine_questions"] as const;
export type ClassifierEngine = (typeof CLASSIFIER_ENGINES)[number];

/** `sms_classification_runs.schema_version` of rows written by this engine. */
export const NINE_SCHEMA_VERSION = "nine_questions_v1";
export const NINE_POLICY_VERSION = "2026-10-15-nine-questions";

/** Hold reason when the engine switch cannot be read: neither engine runs, a person looks. */
export const CLASSIFIER_ENGINE_UNREADABLE = "classifier_engine_unreadable";

/** Only "the column is not there yet" (a database before the migration) may mean outcome_v1. */
export function isMissingEngineColumnError(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code === "42703") return true;
  const m = error.message ?? "";
  return /classifier_engine/i.test(m) && /(does not exist|could not find|schema cache)/i.test(m);
}

/**
 * The org's engine. Read on its own (not in the big config select) so that code
 * reaching a database without the column yet keeps today's eight-answer path.
 * Any OTHER read error, or no active row, is `unreadable`: the caller must hold the message for a
 * person and run neither engine (the switch state is unknown).
 */
export async function readClassifierEngine(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<ClassifierEngine | "unreadable"> {
  const { data, error } = await supabase
    .from("ai_responder_configs")
    .select("classifier_engine")
    .eq("org_id", orgId)
    .eq("active", true)
    .maybeSingle();
  if (error) return isMissingEngineColumnError(error) ? "outcome_v1" : "unreadable";
  // Callers only ask after finding an active config, so no row means the switch state is unknown.
  if (!data) return "unreadable";
  const engine: unknown = data.classifier_engine;
  return engine === "nine_questions" || engine === "outcome_v1" ? engine : "unreadable";
}

/** What the tape / audit rows carry so the UI can tell the engines apart. */
/**
 * `shadowMode` records under `shadow_engine` instead of `engine`, so the tape
 * (which reads `engine`) ignores a record-only run.
 */
export function nineDecisionRecord(result: NineQuestionResult, shadowMode = false): Record<string, unknown> {
  return {
    [shadowMode ? "shadow_engine" : "engine"]: "nine_questions",
    answer: result.answer,
    probabilities: result.probabilities,
    chosen: result.chosen,
    cutoff: result.cutoff,
  };
}

export type NineClassificationInput = {
  orgId: string;
  propertyId: string;
  contactId: string;
  conversationId: string | null;
  inboundMessageId: string | null;
  inboundBody: string;
};

export type NineClassificationOutcome =
  | {
      kind: "ok";
      result: NineQuestionResult;
      classificationRunId: string;
      /** properties.decision_context_revision read BEFORE the Jev call (same rule as the eight-answer path). */
      evaluationRevision: number;
      /** The last text we sent before this inbound (what the homeowner answered). */
      ourLastText: string | null;
    }
  | { kind: "failed"; reason: string };

function isDuplicateKeyError(message: string): boolean {
  return (
    message.includes("idx_sms_classification_runs_logical_key") ||
    message.includes("duplicate key value violates unique constraint")
  );
}

/**
 * One Jev call (all nine questions), persisted to `sms_classification_runs`
 * (insert-only) and recorded as a `jev/classify` step. Never throws; a failure
 * is returned so the caller holds the message for a person.
 *
 * A hot answer (open_to_selling / talked_price / asked_offer / named_price / asked_call) stores `resolved_outcome =
 * 'new_lead'` because the existing promotion RPC verifies the run it cites; every
 * other answer stores null so no eight-answer view reads it as an outcome.
 */
export async function runNineClassification(
  supabase: SupabaseClient<Database>,
  input: NineClassificationInput,
  deps: { fetch: typeof fetch; typesafeApiKey: string; runContext?: MaybeRunContext; shadow?: boolean },
): Promise<NineClassificationOutcome> {
  const shadow = deps.shadow === true;
  const failed = async (reason: string): Promise<NineClassificationOutcome> => {
    // Shadow writes no failure rows: nothing for the eight-answer queue or tape to pick up.
    if (!shadow && input.conversationId && input.inboundMessageId) {
      const { error } = await supabase.from("sms_classification_runs").insert({
        org_id: input.orgId,
        property_id: input.propertyId,
        conversation_id: input.conversationId,
        source_inbound_message_id: input.inboundMessageId,
        state_hash: `failed:${reason}`,
        schema_version: NINE_SCHEMA_VERSION,
        policy_version: NINE_POLICY_VERSION,
        provider: "jev",
        model: JEV_MODEL,
        decision: { engine: "nine_questions" },
        fallback_reason: reason,
      });
      if (error && !isDuplicateKeyError(error.message)) {
        reportError(new Error(error.message), { tags: { surface: "nine_questions_failed_run" }, extra: { propertyId: input.propertyId } });
      }
    }
    await recordStep(supabase, deps.runContext, {
      // Shadow must not look like the eight-answer classify step (the tape reads the first jev/classify).
      kind: shadow ? "shadow" : "jev",
      name: shadow ? "nine_classify" : "classify",
      result: "error",
      detail: { [shadow ? "shadow_engine" : "engine"]: "nine_questions", reason },
    });
    return { kind: "failed", reason };
  };

  const { data: prop, error: revError } = await supabase
    .from("properties")
    .select("decision_context_revision")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (revError || !prop) return failed("missing_revision_baseline");
  const evaluationRevision = prop.decision_context_revision;

  let sourceCreatedAt: string | null = null;
  if (input.inboundMessageId) {
    const { data: msg, error } = await supabase
      .from("messages")
      .select("created_at")
      .eq("id", input.inboundMessageId)
      .eq("property_id", input.propertyId)
      .eq("direction", "inbound")
      .maybeSingle();
    if (error || !msg) return failed("source_message_not_found");
    sourceCreatedAt = msg.created_at;
  }

  const priorThread = await buildTwoWayThreadState(supabase, {
    propertyId: input.propertyId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    excludeMessageId: input.inboundMessageId,
    sourceCreatedAt,
  });
  const lastOutbound = [...priorThread].reverse().find((m) => m.direction === "outbound");
  const ourLastText = lastOutbound ? lastOutbound.body : null;
  const state = { our_last_text_to_homeowner: ourLastText, homeowner_reply: input.inboundBody };

  let result: NineQuestionResult;
  try {
    result = await classifyNineQuestions(state, { fetch: deps.fetch, apiKey: deps.typesafeApiKey });
  } catch (e) {
    const kind = e instanceof JevProviderError ? e.kind : "unknown";
    reportError(e, { tags: { surface: "nine_questions_jev", reason: kind }, extra: { propertyId: input.propertyId } });
    return failed(kind);
  }

  if (!input.conversationId || !input.inboundMessageId) return failed("audit_persist_failed");
  const stateHash = createHash("sha256").update(JSON.stringify(state)).digest("hex");
  const hot = actionForNineAnswer(result.answer).kind === "hot";
  const row = {
    org_id: input.orgId,
    property_id: input.propertyId,
    conversation_id: input.conversationId,
    source_inbound_message_id: input.inboundMessageId,
    state_hash: stateHash,
    schema_version: NINE_SCHEMA_VERSION,
    policy_version: NINE_POLICY_VERSION,
    provider: "jev" as const,
    model: result.model ?? JEV_MODEL,
    decision: { ...nineDecisionRecord(result, shadow), evaluationRevision },
    resolved_outcome: hot && !shadow ? "new_lead" : null,
    usage: result.usage,
    latency_ms: result.latencyMs,
  };
  let classificationRunId: string | null = null;
  const { data: inserted, error: insertError } = await supabase
    .from("sms_classification_runs")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (!insertError && inserted) classificationRunId = inserted.id;
  else if (insertError && isDuplicateKeyError(insertError.message)) {
    const { data: existing } = await supabase
      .from("sms_classification_runs")
      .select("id")
      .eq("source_inbound_message_id", input.inboundMessageId)
      .eq("provider", "jev")
      .eq("model", row.model)
      .eq("schema_version", NINE_SCHEMA_VERSION)
      .eq("state_hash", stateHash)
      .maybeSingle();
    classificationRunId = existing?.id ?? null;
  } else if (insertError) {
    reportError(new Error(insertError.message), { tags: { surface: "nine_questions_persist" }, extra: { propertyId: input.propertyId } });
  }
  if (!classificationRunId) return failed("audit_persist_failed");

  await recordStep(supabase, deps.runContext, {
    kind: shadow ? "shadow" : "jev",
    name: shadow ? "nine_classify" : "classify",
    result: "pass",
    detail: {
      ...nineDecisionRecord(result, shadow),
      classificationRunId,
      model: result.model,
      latencyMs: result.latencyMs,
    },
  });
  return { kind: "ok", result, classificationRunId, evaluationRevision, ourLastText };
}

export type NineDripResult =
  | { status: "enrolled"; sequenceId: string; enrollmentId: string }
  | { status: "already_enrolled"; sequenceId: string }
  | { status: "refused"; reason: string };

/**
 * Enrol the lead in the org's drip with this EXACT name, through the same
 * `enrollLead` the button and the nurture auto-drip use (phone, landline,
 * consent, suppression, DNC lock, Norma hold, inactive drip and the one-live-drip
 * rule are all enforced there). Reversible and idempotent: a repeat finds the
 * live enrolment and returns `already_enrolled`; nothing but the enrolment is
 * written (no disposition change). Never throws.
 */
export async function enrollNineDrip(
  supabase: SupabaseClient<Database>,
  a: {
    orgId: string;
    propertyId: string;
    dripName: NineDripName;
    skipFirstStep: boolean;
    /** The contact who sent the inbound; texted only when the lead has no saved homeowner (see `enrollLead`). */
    contactId?: string;
    /** Earliest first text (see `enrollLead`); dispatch omits it. */
    firstSendNotBefore?: Date;
  },
): Promise<NineDripResult> {
  try {
    const { data: sequences, error } = await supabase
      .from("sequences")
      .select("id")
      .eq("org_id", a.orgId)
      .eq("name", a.dripName)
      .is("archived_at", null);
    if (error) return { status: "refused", reason: "drip_lookup_failed" };
    if (!sequences || sequences.length === 0) return { status: "refused", reason: "drip_not_found" };
    if (sequences.length > 1) return { status: "refused", reason: "drip_name_ambiguous" };
    const sequenceId = sequences[0]!.id;

    const outcome = await enrollLead(supabase, {
      propertyId: a.propertyId,
      sequenceId,
      enrolledByUserId: null,
      ...(a.skipFirstStep ? { skipFirstStep: true } : {}),
      ...(a.contactId ? { contactId: a.contactId } : {}),
      ...(a.firstSendNotBefore ? { firstSendNotBefore: a.firstSendNotBefore } : {}),
    });
    if (outcome.status === "enrolled") return { status: "enrolled", sequenceId, enrollmentId: outcome.enrollmentId };
    if (outcome.status !== "duplicate_active") {
      return { status: "refused", reason: outcome.status === "failed" ? "enroll_failed" : outcome.status };
    }
    // The same drip already holds this lead. A PAUSED enrolment sends nothing, so
    // the lead would go silent: report it instead of calling it done.
    const { data: live, error: liveError } = await supabase
      .from("sequence_enrollments")
      .select("status")
      .eq("property_id", a.propertyId)
      .eq("sequence_id", sequenceId)
      .in("status", ["active", "paused"])
      .limit(1)
      .maybeSingle();
    if (liveError || !live) return { status: "refused", reason: "drip_status_unreadable" };
    if (live.status === "paused") return { status: "refused", reason: "drip_paused" };
    return { status: "already_enrolled", sequenceId };
  } catch (error) {
    reportError(error, { tags: { surface: "nine_questions_drip" }, extra: { propertyId: a.propertyId, dripName: a.dripName } });
    return { status: "refused", reason: "enroll_threw" };
  }
}
