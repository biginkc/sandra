import { JEV_MODEL, JEV_SCHEMA_VERSION, JEV_POLICY_VERSION } from "./questions";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { reportError } from "@/lib/errors/report";
import type { ResponderRoute } from "../ai-responder/route";
import type { AiStructuredOutput } from "../ai-responder/types";
import type { Database } from "../supabase/types";
import { buildTwoWayThreadState } from "./context";
import { resolvePolicyOutcome } from "./policy";
import { classifyWithJev, JevProviderError } from "./providers/jev-gateway";
import { loadOrgThresholdMap, resolveThresholdDecision } from "./thresholds";
import type { SmsClassificationDecision } from "./types";

const SCHEMA_VERSION = JEV_SCHEMA_VERSION;
const POLICY_VERSION = JEV_POLICY_VERSION;

export type ClassifierProvider = "legacy" | "jev";
export type ClassifierMode = "shadow" | "automatic";

export type ClassificationBridgeInput = {
  orgId: string;
  propertyId: string;
  contactId: string;
  conversationId: string | null;
  inboundMessageId: string | null;
  /** The current inbound message's text. `buildTwoWayThreadState` excludes
   *  it (its row already exists in `messages` by dispatch time, same as
   *  `loadConversation`'s exclusion) — this is appended explicitly so Jev
   *  actually sees the message it's classifying, not just prior history.
   *  Astra PR review finding (2026-09-20): this was missing entirely. */
  inboundBody: string;
};

/**
 * Fable reviewed the plan and recommended (2026-09-20 ruling): per-org
 * canary only (schema default stays `shadow`, never a blanket default),
 * AND legacy stays running in parallel during the canary window so
 * there's a real Jev-vs-legacy diff to monitor, dropping legacy only
 * after live agreement holds.
 *
 * Jarrad explicitly overrode the second part the same day: he does not
 * want legacy Claude called at all for `automatic`-mode orgs — he will
 * do his own manual review of Jev's decisions via the audit table
 * instead of an automated diff. The per-org canary (schema default
 * `shadow`, `automatic` requires an explicit per-org flip) is UNCHANGED
 * and still in force — only the "keep legacy running during canary"
 * requirement is overridden. `dnc`'s hard human-gate is unaffected by
 * either ruling: it stays DB-enforced regardless of mode.
 *
 * `classifyForDispatch` below implements Jarrad's version: when the
 * bridge returns `jev_route`, the caller (`dispatch.ts`) must skip the
 * legacy `generateAiReply` call entirely for that message, not run it
 * for comparison. When it returns `use_legacy` (provider is `legacy`,
 * mode is `shadow`, or Jev failed/returned no_action/nurture), the
 * caller calls legacy exactly as it does today.
 */
export type ClassificationBridgeResult =
  | {
      kind: "use_legacy";
      classificationRunId: string | null;
    }
  | {
      kind: "jev_route";
      route: ResponderRoute;
      assembled: AiStructuredOutput;
      classificationRunId: string;
      /** dnc always stays pending regardless of mode — see the DB
       *  constraint in 20260920120000_sms_classification_runs.sql. */
      eligibleForAutoAccept: boolean;
      /** Native confidence + the threshold compared against it (null when
       *  not thresholdable, e.g. dnc). Carried through so a below-threshold
       *  new_lead escalate can still be recorded in jev_lead_decisions with
       *  the real numbers, not just a generic attention flag. */
      nativeConfidence: number | null;
      thresholdAtDecision: number | null;
      /** The threshold SETTINGS ROW'S version actually used at decision
       *  time — null exactly when thresholdAtDecision is null (root
       *  final-review P2: the version, not just the numeric cutoff, must
       *  be recorded, since two different settings versions can share the
       *  same number). */
      thresholdVersion: number | null;
    }
  | {
      kind: "jev_nurture";
      classificationRunId: string;
      nativeConfidence: number | null;
      thresholdAtDecision: number | null;
      thresholdVersion: number | null;
    }
  | { kind: "jev_no_action"; classificationRunId: string }
  /**
   * Outcome resolved but is below its org threshold, missing/invalid
   * confidence, or has no configured threshold — and has no existing
   * disposition-review infra to fall back on (currently only `nurture`;
   * `wrong_number`/`not_interested`/`opted_out` stay on `jev_route` with
   * `eligibleForAutoAccept: false`, which already lands them in the
   * existing pending-review path). The caller must NOT apply any effect
   * for this outcome — only propose a `jev_lead_decisions` row (nurture)
   * or mark the property for human attention.
   */
  | {
      kind: "jev_needs_decision";
      classificationRunId: string;
      outcome: SmsClassificationDecision["outcome"];
      nativeConfidence: number | null;
      thresholdAtDecision: number | null;
      thresholdVersion: number | null;
    }
  /**
   * new_lead resolved above its org threshold. The caller must call the
   * sanctioned promotion primitive (`qualifyProperty`) — never appointment
   * booking — and must not also route this through `resolveResponderOutcome`.
   */
  | {
      kind: "jev_promote_new_lead";
      classificationRunId: string;
      nativeConfidence: number | null;
      thresholdAtDecision: number | null;
      thresholdVersion: number | null;
    };

/**
 * Runs Jev alongside the caller's already-computed legacy decision
 * (never in place of it — the caller calls `generateAiReply` itself,
 * unconditionally, exactly as it does today). Persists an audit row for
 * every attempt, including failures. Returns `use_legacy` whenever Jev
 * shouldn't override the dispatched effect — provider isn't `jev`, mode
 * isn't `automatic`, Jev failed, or Jev returned `no_action`/`nurture`
 * (those are logged via their own `kind`, not silently folded into
 * `use_legacy`, so a caller can still act on nurture even in
 * legacy-effect mode if it chooses to).
 *
 * Never throws — a Jev outage of any kind degrades to `use_legacy`.
 */
export async function classifyForDispatch(
  supabase: SupabaseClient<Database>,
  input: ClassificationBridgeInput,
  config: {
    classifierProvider: ClassifierProvider;
    classifierMode: ClassifierMode;
  },
  deps: {
    fetch: typeof fetch;
    typesafeApiKey: string;
  },
): Promise<ClassificationBridgeResult> {
  if (config.classifierProvider !== "jev") {
    return { kind: "use_legacy", classificationRunId: null };
  }

  const priorThread = await buildTwoWayThreadState(supabase, {
    propertyId: input.propertyId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    excludeMessageId: input.inboundMessageId,
  });
  // Append the current inbound explicitly, matching loadConversation's
  // exact pattern in dispatch.ts — buildTwoWayThreadState excludes it by
  // id, so without this Jev only ever sees prior history, never the
  // message it's actually supposed to classify.
  const thread = [
    ...priorThread,
    { direction: "inbound" as const, body: input.inboundBody, sentAt: new Date().toISOString() },
  ];

  const state = { propertyId: input.propertyId };
  const stateHash = hashState(thread, state);

  let decision: SmsClassificationDecision;
  try {
    decision = await classifyWithJev(
      { conversationId: input.conversationId ?? input.propertyId, thread, state, includeReplyIntent: false },
      { fetch: deps.fetch, apiKey: deps.typesafeApiKey },
    );
  } catch (e) {
    const kind = e instanceof JevProviderError ? e.kind : "unknown";
    reportError(e, {
      tags: { surface: "sms_classification_jev", reason: kind },
      extra: { propertyId: input.propertyId },
    });
    await persistFailedRun(supabase, input, kind).catch(() => {});
    return { kind: "use_legacy", classificationRunId: null };
  }

  // Per-outcome native-confidence cutoffs (jev_outcome_thresholds) are a
  // second, independent gate inside `automatic` mode — the org-level
  // classifier_mode switch below answers "is Jev allowed to drive effects
  // for this org at all"; this answers "is THIS outcome, at THIS
  // confidence, above the bar this org configured for it". Loaded fresh
  // on every classification (no caching) so a threshold edit through
  // fn_set_jev_outcome_threshold takes effect on the very next inbound
  // with no deployment. Computed BEFORE persisting (even in shadow mode,
  // where it's never acted on) so the audit row for every outcome —
  // not just new_lead/nurture's dedicated jev_lead_decisions rows —
  // carries the actual threshold compared against, for Review Jev.
  const thresholds = await loadOrgThresholdMap(supabase, input.orgId);
  const thresholdDecision = resolveThresholdDecision(decision, thresholds);
  // Record the actual measured confidence whenever it's a valid number —
  // even when human-gated for a reason unrelated to the confidence value
  // itself (e.g. no_threshold_configured) — so the audit trail isn't
  // reported as "no confidence" just because there was nothing to
  // compare it against. thresholdAtDecision, by contrast, is genuinely
  // absent (not just unused) whenever thresholdDecision didn't compare
  // against one.
  const nativeConfidence =
    typeof decision.outcomeConfidence === "number" &&
    Number.isFinite(decision.outcomeConfidence) &&
    decision.outcomeConfidence >= 0 &&
    decision.outcomeConfidence <= 1
      ? decision.outcomeConfidence
      : null;
  const thresholdAtDecision =
    "minConfidence" in thresholdDecision ? thresholdDecision.minConfidence : null;
  const thresholdVersion =
    "thresholdVersion" in thresholdDecision ? thresholdDecision.thresholdVersion : null;

  const classificationRunId = await persistRun(supabase, input, decision, stateHash, {
    nativeConfidence,
    thresholdAtDecision,
    thresholdVersion,
  }).catch((persistErr) => {
    reportError(persistErr, {
      tags: { surface: "sms_classification_persist" },
      extra: { propertyId: input.propertyId },
    });
    return null;
  });
  if (!classificationRunId) {
    // Audit write failed — still allow the decision through if the mode
    // says to use it, but without a run id there is nothing to link an
    // auto-accept to, so eligibleForAutoAccept below is always false in
    // that case.
    return { kind: "use_legacy", classificationRunId: null };
  }

  if (config.classifierMode !== "automatic") {
    // shadow (the schema default, and the only mode any org should be
    // in until Jarrad explicitly canaries it — Fable ruling, 2026-09-20):
    // decision computed and persisted above for comparison ONLY. This
    // applies uniformly to every Jev outcome, including nurture/
    // no_action — shadow mode must never act on any Jev result, not
    // just route-shaped ones, or "shadow" stops meaning "audit only".
    return { kind: "use_legacy", classificationRunId };
  }

  const resolved = await resolvePolicyOutcome(decision);

  if (resolved.kind === "no_action") {
    return { kind: "jev_no_action", classificationRunId };
  }

  if (resolved.kind === "nurture") {
    // Unlike wrong_number/not_interested/opted_out below, nurture has no
    // existing ai_disposition_reviews path to fall back on when it isn't
    // eligible to auto-apply — it either applies today via
    // setOutreachDispoNurture, or (new behavior) the caller must leave the
    // property alone and flag it for a human instead of silently closing
    // it at a confidence the org hasn't configured to trust.
    return thresholdDecision.status === "auto_apply"
      ? { kind: "jev_nurture", classificationRunId, nativeConfidence, thresholdAtDecision, thresholdVersion }
      : {
          kind: "jev_needs_decision",
          classificationRunId,
          outcome: decision.outcome,
          nativeConfidence,
          thresholdAtDecision,
          thresholdVersion,
        };
  }

  if (resolved.assembled.action === "escalate") {
    // new_lead. Above-threshold is the net-new capability: the caller
    // must promote via `qualifyProperty`, never through
    // `resolveResponderOutcome`/appointment booking. Below-threshold
    // still escalates via the existing `jev_route` handling in
    // dispatch.ts (eligibleForAutoAccept is always false for `escalate`),
    // but now carries nativeConfidence/thresholdAtDecision so the caller
    // can also propose a real jev_lead_decisions row instead of only a
    // generic attention flag.
    if (thresholdDecision.status === "auto_apply") {
      return {
        kind: "jev_promote_new_lead",
        classificationRunId,
        nativeConfidence,
        thresholdAtDecision,
        thresholdVersion,
      };
    }
    return {
      kind: "jev_route",
      route: resolved.route,
      assembled: resolved.assembled,
      classificationRunId,
      eligibleForAutoAccept: false,
      nativeConfidence,
      thresholdAtDecision,
      thresholdVersion,
    };
  }

  // wrong_number / not_interested / opted_out / dnc. dnc's
  // thresholdDecision is always `human_gated` (resolveThresholdDecision
  // never auto-applies it), so `eligibleForAutoAccept` stays false for it
  // exactly as before — this is not a behavior change for dnc, just the
  // same false arrived at through the threshold engine instead of a
  // hardcoded action-name check. Below-threshold / missing-confidence for
  // the other three already lands on the existing pending
  // ai_disposition_reviews row (fn_apply_ai_disposition_with_review always
  // creates it; only auto-accept is conditional) — that pending row IS the
  // Needs-a-decision case for these three outcomes, no new plumbing
  // required.
  return {
    kind: "jev_route",
    route: resolved.route,
    nativeConfidence,
    thresholdAtDecision,
    thresholdVersion,
    assembled: resolved.assembled,
    classificationRunId,
    eligibleForAutoAccept: thresholdDecision.status === "auto_apply",
  };
}

function hashState(
  thread: Awaited<ReturnType<typeof buildTwoWayThreadState>>,
  state: Record<string, unknown>,
): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ thread, state }));
  return h.digest("hex");
}

/**
 * Astra PR review finding (2026-09-20): `.upsert()` requires UPDATE
 * privilege even when no row actually conflicts — Postgres checks
 * statement shape, not the runtime path. `service_role` only has
 * SELECT/INSERT on this table (migration:
 * `revoke all ... grant select, insert on table public.sms_classification_runs
 * to service_role`), deliberately, since the table is meant to be
 * immutable audit evidence. Every real call would have failed with a
 * permissions error and silently fallen back to legacy without ever
 * persisting a successful classification.
 *
 * Fixed: plain `.insert()`, no `upsert`/`on_conflict` option at all —
 * INSERT-only, no UPDATE required. On a real duplicate (same logical
 * evaluation key), Postgres raises a genuine unique-violation error
 * (caught below via `isDuplicateKeyError`), not a silent no-op — fetch
 * the existing row's id separately in that case rather than expecting
 * `ON CONFLICT DO NOTHING` semantics we never asked Postgres for.
 */
async function persistRun(
  supabase: SupabaseClient<Database>,
  input: ClassificationBridgeInput,
  decision: SmsClassificationDecision,
  stateHash: string,
  audit: { nativeConfidence: number | null; thresholdAtDecision: number | null; thresholdVersion: number | null },
): Promise<string | null> {
  if (!input.conversationId || !input.inboundMessageId) return null;
  const row = {
    org_id: input.orgId,
    property_id: input.propertyId,
    conversation_id: input.conversationId,
    source_inbound_message_id: input.inboundMessageId,
    state_hash: stateHash,
    schema_version: SCHEMA_VERSION,
    policy_version: POLICY_VERSION,
    provider: "jev" as const,
    model: decision.model || JEV_MODEL,
    decision: {
      outcome: decision.outcome,
      outcomeConfidence: decision.outcomeConfidence ?? null,
      wrongScope: decision.wrongScope,
      escalationReason: decision.escalationReason,
      probabilities: decision.probabilities,
      // Root direct-review finding (2026-09-20): the wrong_number/
      // not_interested/opted_out/dnc review path had no persisted
      // threshold context at all (only jev_lead_decisions' own dedicated
      // columns did) — Review Jev was displaying fabricated nulls
      // instead of the real recorded value. nativeConfidence here is the
      // SAME validated value as thresholdAtDecision below — persisted
      // for every outcome, not just new_lead/nurture.
      nativeConfidence: audit.nativeConfidence,
      thresholdAtDecision: audit.thresholdAtDecision,
      // Root final-review P2: the threshold SETTINGS ROW's version, not
      // just the numeric cutoff — two versions can share the same number.
      thresholdVersion: audit.thresholdVersion,
    },
    resolved_outcome: decision.outcome,
    usage: decision.usage,
    latency_ms: decision.latencyMs,
  };

  const { data, error } = await supabase
    .from("sms_classification_runs")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (!error && data) return data.id;
  if (error && !isDuplicateKeyError(error.message)) throw new Error(error.message);

  // Real duplicate (identical logical evaluation key already persisted,
  // e.g. a dispatch retry) — fetch the existing row rather than treating
  // this as a failure.
  const { data: existing, error: lookupErr } = await supabase
    .from("sms_classification_runs")
    .select("id")
    .eq("source_inbound_message_id", input.inboundMessageId)
    .eq("provider", "jev")
    .eq("model", row.model)
    .eq("schema_version", SCHEMA_VERSION)
    .eq("state_hash", stateHash)
    .maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);
  return existing?.id ?? null;
}

function isDuplicateKeyError(message: string): boolean {
  return (
    message.includes("idx_sms_classification_runs_logical_key") ||
    message.includes("duplicate key value violates unique constraint")
  );
}

async function persistFailedRun(
  supabase: SupabaseClient<Database>,
  input: ClassificationBridgeInput,
  fallbackReason: string,
): Promise<void> {
  if (!input.conversationId || !input.inboundMessageId) return;
  await supabase.from("sms_classification_runs").insert({
    org_id: input.orgId,
    property_id: input.propertyId,
    conversation_id: input.conversationId,
    source_inbound_message_id: input.inboundMessageId,
    state_hash: `failed:${Date.now()}`,
    schema_version: SCHEMA_VERSION,
    policy_version: POLICY_VERSION,
    provider: "jev",
    model: JEV_MODEL,
    decision: {},
    fallback_reason: fallbackReason,
  });
}
