import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { buildTwoWayThreadState } from "../context";
import { askJev, JevProviderError, type FetchLike } from "../providers/jev-gateway";
import { buildV2JevRequest } from "./questions";
import { assertCompleteV2, routeV2 } from "./route";

/**
 * Sanitized failure category. Never raw error text: Jev error messages can embed upstream
 * bodies that echo homeowner message content.
 */
export function shadowFailureReason(e: unknown, phase: "db" | "jev" = "db"): string {
  if (e instanceof JevProviderError) {
    if (e.kind === "timeout") return "jev_timeout";
    if (typeof e.status === "number") return `jev_http_${e.status}`;
    if (e.kind === "invalid_response") return "jev_invalid_response";
    return `jev_${e.kind}`;
  }
  if (phase === "jev") return e instanceof SyntaxError ? "jev_invalid_response" : "jev_network_error";
  return "db_error";
}

/**
 * Routing v2 shadow hook (PR-A). When `ai_responder_configs.routing_v2_flags.shadow` is true,
 * asks Jev the v2 question set once and writes the v2 decision to `routing_v2_shadow_decisions`.
 * Record only: no sends, holds, enrollments, suppressions or Haiku calls. Never throws.
 *
 * Runs only AFTER a live caller has stamped its terminal outcome (the inbound webhook via
 * `after()`, the delay workflow as its own step), never inside the live dispatch, so it can
 * neither delay nor alter a live step. Only orgs on the automatic nine-questions engine shadow.
 */
export type RoutingV2ShadowInput = {
  /** Resolved from the property when the caller does not have it. */
  orgId?: string | null;
  propertyId: string;
  contactId: string;
  conversationId: string | null;
  inboundMessageId: string | null;
  inboundBody: string;
  /** The live engine's terminal outcome (for error context only; never changes the v2 decision). */
  liveOutcome?: string | null;
};

export type RoutingV2ShadowDeps = { fetch: FetchLike; typesafeApiKey: string; timeoutMs?: number };

export type RoutingV2ShadowResult = "off" | "skipped" | "decided" | "failed";

// The new column/table are not in the generated types yet; keep the untyped access in one place.
type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function readRoutingV2ShadowFlag(supabase: SupabaseClient<Database>, orgId: string): Promise<boolean> {
  try {
    const { data, error } = await (supabase as unknown as Loose)
      .from("ai_responder_configs")
      .select("routing_v2_flags, classifier_provider, classifier_engine, classifier_mode")
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    if (error || !data) return false; // a missing column (before the migration) = off
    const row = data as {
      routing_v2_flags?: unknown;
      classifier_provider?: unknown;
      classifier_engine?: unknown;
      classifier_mode?: unknown;
    };
    // Shadow only orgs whose live engine is the automatic nine-questions path.
    if (row.classifier_provider !== "jev" || row.classifier_engine !== "nine_questions" || row.classifier_mode !== "automatic") {
      return false;
    }
    const flags = row.routing_v2_flags;
    return typeof flags === "object" && flags !== null && (flags as Record<string, unknown>).shadow === true;
  } catch {
    return false;
  }
}

/** True when a shadow row already exists for this inbound (retry/deferral/redelivery): skip Jev. */
async function shadowAlreadyRecorded(supabase: SupabaseClient<Database>, inboundMessageId: string): Promise<boolean> {
  const { data, error } = await (supabase as unknown as Loose)
    .from("routing_v2_shadow_decisions")
    .select("id")
    .eq("inbound_message_id", inboundMessageId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(String(error.message));
  return Boolean(data);
}

/**
 * Fire-and-forget for request handlers: schedules the shadow with Next's `after()` so the
 * provider webhook response is not held; outside a request scope falls back to a detached
 * promise. Never throws, never awaited by the caller.
 */
export function scheduleRoutingV2Shadow(
  supabase: SupabaseClient<Database>,
  input: RoutingV2ShadowInput,
  deps: RoutingV2ShadowDeps,
  scheduler: (task: () => Promise<void>) => void = after,
): void {
  const task = async () => {
    await runRoutingV2Shadow(supabase, input, deps).catch(() => undefined);
  };
  try {
    scheduler(task);
  } catch {
    void task();
  }
}

export async function runRoutingV2Shadow(
  supabase: SupabaseClient<Database>,
  input: RoutingV2ShadowInput,
  deps: RoutingV2ShadowDeps,
): Promise<RoutingV2ShadowResult> {
  try {
    let orgId = input.orgId ?? null;
    if (!orgId) {
      const { data } = await supabase.from("properties").select("org_id").eq("id", input.propertyId).maybeSingle();
      orgId = (data as { org_id?: string } | null)?.org_id ?? null;
    }
    if (!orgId || !(await readRoutingV2ShadowFlag(supabase, orgId))) return "off";
    if (input.inboundMessageId && (await shadowAlreadyRecorded(supabase, input.inboundMessageId))) return "skipped";
    const base = {
      org_id: orgId,
      property_id: input.propertyId,
      conversation_id: input.conversationId,
      inbound_message_id: input.inboundMessageId,
    };
    const write = async (row: Record<string, unknown>) => {
      const { error } = await (supabase as unknown as Loose).from("routing_v2_shadow_decisions").insert({ ...base, ...row });
      if (error && !/duplicate key/i.test(String(error.message))) {
        reportError(new Error(String(error.message)), { tags: { surface: "routing_v2_shadow_write" }, extra: { propertyId: input.propertyId } });
      }
    };
    let phase: "db" | "jev" = "db";
    try {
      let sourceCreatedAt: string | null = null;
      if (input.inboundMessageId) {
        const { data } = await supabase.from("messages").select("created_at").eq("id", input.inboundMessageId).maybeSingle();
        sourceCreatedAt = data?.created_at ?? null;
      }
      const thread = await buildTwoWayThreadState(supabase, {
        propertyId: input.propertyId,
        contactId: input.contactId,
        conversationId: input.conversationId,
        excludeMessageId: input.inboundMessageId,
        sourceCreatedAt,
      });
      const lastOutbound = [...thread].reverse().find((m) => m.direction === "outbound");
      phase = "jev";
      const result = await askJev(
        buildV2JevRequest({ our_last_text_to_homeowner: lastOutbound ? lastOutbound.body : null, homeowner_reply: input.inboundBody }),
        { fetch: deps.fetch, apiKey: deps.typesafeApiKey, maxRetries: 0, timeoutMs: deps.timeoutMs ?? 8000 },
      );
      phase = "db";
      const complete = assertCompleteV2(result.answers ?? {});
      if (!complete.ok) {
        await write({ status: "failed", failure_reason: `incomplete:${complete.missing.join(",")}`, model: result.model ?? null, latency_ms: result.latencyMs });
        return "failed";
      }
      const d = routeV2({ reply: input.inboundBody, probabilities: complete.probabilities, propertyType: complete.propertyType });
      await write({
        status: "decided",
        road: d.road,
        provenance: d.provenance,
        haiku_eligibility: d.haiku,
        opportunity_alert: d.opportunityAlert,
        probabilities: complete.probabilities,
        property_type: complete.propertyType,
        model: result.model ?? null,
        latency_ms: result.latencyMs,
      });
      return "decided";
    } catch (e) {
      await write({ status: "failed", failure_reason: shadowFailureReason(e, phase) }).catch(() => {});
      return "failed";
    }
  } catch (e) {
    try {
      reportError(e, { tags: { surface: "routing_v2_shadow" }, extra: { propertyId: input.propertyId, liveOutcome: input.liveOutcome ?? null } });
    } catch {
      /* swallow: shadow never affects live */
    }
    return "failed";
  }
}
