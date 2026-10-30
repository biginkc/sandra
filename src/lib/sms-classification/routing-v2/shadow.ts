import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { buildTwoWayThreadState } from "../context";
import { askJev, type FetchLike } from "../providers/jev-gateway";
import { askHaiku, formatHaikuThread } from "./haiku";
import { applyHaikuPolicy } from "./haiku-policy";
import { buildV2JevRequest } from "./questions";
import { assertCompleteV2, routeV2 } from "./route";

/**
 * Routing v2 shadow hook (PR-A). When `ai_responder_configs.routing_v2_flags.shadow` is true,
 * asks Jev the v2 question set once and writes the v2 decision to `routing_v2_shadow_decisions`.
 * Record only: no sends, holds, enrollments or suppressions. Never throws.
 * PR-D: when `routing_v2_flags.haiku` is also true and the decision is Haiku-eligible, asks Haiku
 * and records its answer plus the policy's final road in the `haiku` column (still record only).
 */
export type RoutingV2ShadowInput = {
  orgId: string;
  propertyId: string;
  contactId: string;
  conversationId: string | null;
  inboundMessageId: string | null;
  inboundBody: string;
};

export type RoutingV2ShadowDeps = {
  fetch: FetchLike;
  typesafeApiKey: string;
  timeoutMs?: number;
  /** PR-D: Sandra's Anthropic key (defaults to env ANTHROPIC_API_KEY_SANDRA, then ANTHROPIC_API_KEY); only used when flags.haiku is true. Never logged. */
  anthropicApiKey?: string;
  haikuTimeoutMs?: number;
  haikuSleep?: (ms: number) => Promise<void>;
};

export type RoutingV2ShadowResult = "off" | "decided" | "failed";

// The new column/table are not in the generated types yet; keep the untyped access in one place.
type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export type RoutingV2ShadowFlags = { shadow: boolean; haiku: boolean };

export async function readRoutingV2Flags(supabase: SupabaseClient<Database>, orgId: string): Promise<RoutingV2ShadowFlags> {
  const off = { shadow: false, haiku: false };
  try {
    const { data, error } = await (supabase as unknown as Loose)
      .from("ai_responder_configs")
      .select("routing_v2_flags")
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    if (error || !data) return off; // a missing column (before the migration) = off
    const flags = (data as { routing_v2_flags?: unknown }).routing_v2_flags;
    if (typeof flags !== "object" || flags === null) return off;
    const f = flags as Record<string, unknown>;
    return { shadow: f.shadow === true, haiku: f.shadow === true && f.haiku === true };
  } catch {
    return off;
  }
}

export async function readRoutingV2ShadowFlag(supabase: SupabaseClient<Database>, orgId: string): Promise<boolean> {
  return (await readRoutingV2Flags(supabase, orgId)).shadow;
}

export async function runRoutingV2Shadow(
  supabase: SupabaseClient<Database>,
  input: RoutingV2ShadowInput,
  deps: RoutingV2ShadowDeps,
): Promise<RoutingV2ShadowResult> {
  try {
    const flags = await readRoutingV2Flags(supabase, input.orgId);
    if (!flags.shadow) return "off";
    const base = {
      org_id: input.orgId,
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
      const result = await askJev(
        buildV2JevRequest({ our_last_text_to_homeowner: lastOutbound ? lastOutbound.body : null, homeowner_reply: input.inboundBody }),
        { fetch: deps.fetch, apiKey: deps.typesafeApiKey, maxRetries: 0, timeoutMs: deps.timeoutMs ?? 8000 },
      );
      const complete = assertCompleteV2(result.answers ?? {});
      if (!complete.ok) {
        await write({ status: "failed", failure_reason: `incomplete:${complete.missing.join(",")}`, model: result.model ?? null, latency_ms: result.latencyMs });
        return "failed";
      }
      const d = routeV2({ reply: input.inboundBody, probabilities: complete.probabilities, propertyType: complete.propertyType });
      let haiku: Record<string, unknown> | undefined;
      if (flags.haiku) {
        const h = d.haiku
          ? await askHaiku(
              formatHaikuThread([...thread, { direction: "inbound", body: input.inboundBody }]),
              { fetch: deps.fetch, apiKey: deps.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY_SANDRA ?? process.env.ANTHROPIC_API_KEY ?? "", timeoutMs: deps.haikuTimeoutMs, sleep: deps.haikuSleep },
            )
          : null;
        const final = applyHaikuPolicy(d, h, complete.probabilities);
        haiku = {
          asked: h !== null,
          option: h?.ok ? h.option : null,
          confidence: h?.ok ? h.confidence : null,
          failure_reason: h && !h.ok ? h.reason : null,
          latency_ms: h?.latencyMs ?? null,
          attempts: h?.attempts ?? 0,
          input_tokens: h?.inputTokens ?? null,
          output_tokens: h?.outputTokens ?? null,
          cost_usd: h?.costUsd ?? null,
          final_road: final.road,
          final_by: final.by,
          hold: final.hold,
          alert: final.alert,
        };
      }
      await write({
        ...(haiku ? { haiku } : {}),
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
      await write({ status: "failed", failure_reason: e instanceof Error ? e.message.slice(0, 200) : "unknown" }).catch(() => {});
      return "failed";
    }
  } catch (e) {
    try {
      reportError(e, { tags: { surface: "routing_v2_shadow" }, extra: { propertyId: input.propertyId } });
    } catch {
      /* swallow: shadow never affects live */
    }
    return "failed";
  }
}
