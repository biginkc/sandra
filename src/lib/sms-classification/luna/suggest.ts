import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { recordStep, type MaybeRunContext } from "@/lib/pipeline-runs";
import type { Database } from "@/lib/supabase/types";

import { buildTwoWayThreadState } from "../context";
import type { JevOutcome } from "../types";
import { classifyWithLuna, type LunaResult } from "./client";
import { lunaModelFromEnv, lunaSuggestionsEnabled, LUNA_TIMEOUT_MS } from "./config";
import { lunaEligibility } from "./eligibility";

export type LunaSuggestInput = {
  orgId: string;
  propertyId: string;
  contactId: string;
  conversationId: string | null;
  inboundMessageId: string;
  inboundBody: string;
  /** The outcome Jev landed on below its threshold. */
  jevOutcome: JevOutcome;
  escalationKeywords?: ReadonlyArray<string> | null;
  runContext?: MaybeRunContext;
};

export type LunaSuggestDeps = {
  fetch: typeof fetch;
  env?: Record<string, string | undefined>;
  classify?: typeof classifyWithLuna;
};

export type LunaSuggestOutcome =
  | { status: "skipped"; reason: string }
  | { status: "stored"; outcome: JevOutcome; confidence: number }
  | { status: "duplicate" }
  | { status: "error"; reason: string };

/**
 * Ask Luna for a fallback suggestion on a below-threshold hold and store it.
 * NEVER throws and NEVER applies anything: the stored row is only read by the
 * hold card. Callers run this off the inbound pipeline (see dispatch.ts); the
 * result is recorded as a pipeline step `luna_suggest` (ids/enums/numbers only,
 * never message text).
 */
export async function requestLunaSuggestion(
  supabase: SupabaseClient<Database>,
  input: LunaSuggestInput,
  deps: LunaSuggestDeps,
): Promise<LunaSuggestOutcome> {
  const env = deps.env ?? process.env;
  const step = (result: "pass" | "skipped" | "error", detail: Record<string, unknown>) =>
    recordStep(supabase, input.runContext, { kind: "action", name: "luna_suggest", result, detail });
  try {
    const gate = lunaEligibility({
      enabled: lunaSuggestionsEnabled(env),
      jevOutcome: input.jevOutcome,
      inboundBody: input.inboundBody,
      escalationKeywords: input.escalationKeywords,
    });
    if (!gate.ask) {
      // A disabled feature is silent: no call, no step, no noise.
      if (gate.reason !== "disabled") await step("skipped", { reason: gate.reason, jevOutcome: input.jevOutcome });
      return { status: "skipped", reason: gate.reason };
    }

    // Dispatch retry: a suggestion already exists, so do not pay for another call.
    const { data: existing } = await supabase
      .from("luna_suggestions")
      .select("id")
      .eq("inbound_message_id", input.inboundMessageId)
      .limit(1)
      .maybeSingle();
    if (existing) {
      await step("skipped", { reason: "already_suggested" });
      return { status: "duplicate" };
    }

    const { data: source } = await supabase
      .from("messages")
      .select("created_at")
      .eq("id", input.inboundMessageId)
      .eq("property_id", input.propertyId)
      .eq("direction", "inbound")
      .maybeSingle();
    if (!source) {
      await step("skipped", { reason: "source_message_not_found" });
      return { status: "skipped", reason: "source_message_not_found" };
    }
    const prior = await buildTwoWayThreadState(supabase, {
      propertyId: input.propertyId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      excludeMessageId: input.inboundMessageId,
      sourceCreatedAt: source.created_at,
    });
    const thread = [...prior, { direction: "inbound" as const, body: input.inboundBody }];

    const result: LunaResult = await (deps.classify ?? classifyWithLuna)(
      {
        apiKey: (env.OPENAI_API_KEY ?? "").trim(),
        model: lunaModelFromEnv(env),
        timeoutMs: LUNA_TIMEOUT_MS,
      },
      thread,
      { fetch: deps.fetch },
    );
    if (result.status === "error") {
      await step("error", { reason: result.error, model: result.model, latencyMs: result.latencyMs });
      return { status: "error", reason: result.error };
    }

    const { error } = await supabase.from("luna_suggestions").insert({
      org_id: input.orgId,
      property_id: input.propertyId,
      inbound_message_id: input.inboundMessageId,
      outcome: result.outcome,
      confidence: result.confidence,
      model: result.model,
    });
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        // Dispatch retry: the first suggestion stands.
        await step("skipped", { reason: "already_suggested" });
        return { status: "duplicate" };
      }
      throw new Error(error.message);
    }
    await step("pass", {
      jevOutcome: input.jevOutcome,
      outcome: result.outcome,
      confidence: result.confidence,
      model: result.model,
      latencyMs: result.latencyMs,
    });
    return { status: "stored", outcome: result.outcome, confidence: result.confidence };
  } catch (e) {
    reportError(e, { tags: { surface: "luna_suggest" }, extra: { propertyId: input.propertyId } });
    try {
      await step("error", { reason: "unexpected" });
    } catch {
      // Evidence only; nothing more to do.
    }
    return { status: "error", reason: "unexpected" };
  }
}
