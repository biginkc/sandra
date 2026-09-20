import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { reportError } from "@/lib/errors/report";
import type { ResponderRoute } from "../ai-responder/route";
import type { AiStructuredOutput } from "../ai-responder/types";
import type { Database } from "../supabase/types";
import { buildTwoWayThreadState } from "./context";
import { resolvePolicyOutcome } from "./policy";
import { classifyWithJev, JevProviderError } from "./providers/jev-gateway";
import type { SmsClassificationDecision } from "./types";

const SCHEMA_VERSION = "1";
const POLICY_VERSION = "2026-09-20";
const JEV_MODEL = "jev-latest";

export type ClassifierProvider = "legacy" | "jev";
export type ClassifierMode = "shadow" | "automatic";

export type ClassificationBridgeInput = {
  orgId: string;
  propertyId: string;
  contactId: string;
  conversationId: string | null;
  inboundMessageId: string | null;
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
    }
  | { kind: "jev_nurture"; classificationRunId: string }
  | { kind: "jev_no_action"; classificationRunId: string };

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

  const thread = await buildTwoWayThreadState(supabase, {
    propertyId: input.propertyId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    excludeMessageId: input.inboundMessageId,
  });

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

  const classificationRunId = await persistRun(supabase, input, decision, stateHash).catch(
    (persistErr) => {
      reportError(persistErr, {
        tags: { surface: "sms_classification_persist" },
        extra: { propertyId: input.propertyId },
      });
      return null;
    },
  );
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
    return { kind: "jev_nurture", classificationRunId };
  }

  return {
    kind: "jev_route",
    route: resolved.route,
    assembled: resolved.assembled,
    classificationRunId,
    eligibleForAutoAccept: resolved.assembled.action !== "close_dnc",
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

async function persistRun(
  supabase: SupabaseClient<Database>,
  input: ClassificationBridgeInput,
  decision: SmsClassificationDecision,
  stateHash: string,
): Promise<string | null> {
  if (!input.conversationId || !input.inboundMessageId) return null;
  const { data, error } = await supabase
    .from("sms_classification_runs")
    .upsert(
      {
        org_id: input.orgId,
        property_id: input.propertyId,
        conversation_id: input.conversationId,
        source_inbound_message_id: input.inboundMessageId,
        state_hash: stateHash,
        schema_version: SCHEMA_VERSION,
        policy_version: POLICY_VERSION,
        provider: "jev",
        model: decision.model || JEV_MODEL,
        decision: {
          outcome: decision.outcome,
          wrongScope: decision.wrongScope,
          escalationReason: decision.escalationReason,
          probabilities: decision.probabilities,
        },
        resolved_outcome: decision.outcome,
        usage: decision.usage,
        latency_ms: decision.latencyMs,
      },
      {
        onConflict: "source_inbound_message_id,provider,model,schema_version,state_hash",
        ignoreDuplicates: false,
      },
    )
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
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
