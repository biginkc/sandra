import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { buildTwoWayThreadState } from "../context";
import { askJev, type FetchLike } from "../providers/jev-gateway";
import { buildV2JevRequest } from "./questions";
import { assertCompleteV2, routeV2 } from "./route";

/**
 * Routing v2 shadow hook (PR-A). When `ai_responder_configs.routing_v2_flags.shadow` is true,
 * asks Jev the v2 question set once and writes the v2 decision to `routing_v2_shadow_decisions`.
 * Record only: no sends, holds, enrollments, suppressions or Haiku calls. Never throws.
 */
export type RoutingV2ShadowInput = {
  orgId: string;
  propertyId: string;
  contactId: string;
  conversationId: string | null;
  inboundMessageId: string | null;
  inboundBody: string;
};

export type RoutingV2ShadowDeps = { fetch: FetchLike; typesafeApiKey: string; timeoutMs?: number };

export type RoutingV2ShadowResult = "off" | "decided" | "failed";

// The new column/table are not in the generated types yet; keep the untyped access in one place.
type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function readRoutingV2ShadowFlag(supabase: SupabaseClient<Database>, orgId: string): Promise<boolean> {
  try {
    const { data, error } = await (supabase as unknown as Loose)
      .from("ai_responder_configs")
      .select("routing_v2_flags")
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    if (error || !data) return false; // a missing column (before the migration) = off
    const flags = (data as { routing_v2_flags?: unknown }).routing_v2_flags;
    return typeof flags === "object" && flags !== null && (flags as Record<string, unknown>).shadow === true;
  } catch {
    return false;
  }
}

export async function runRoutingV2Shadow(
  supabase: SupabaseClient<Database>,
  input: RoutingV2ShadowInput,
  deps: RoutingV2ShadowDeps,
): Promise<RoutingV2ShadowResult> {
  try {
    if (!(await readRoutingV2ShadowFlag(supabase, input.orgId))) return "off";
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
