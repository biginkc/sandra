import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

const RESPONSE_KIND = "sms_ai_responder_v1";
const CLAIM_LEASE_MS = 5 * 60_000;

type SingleFlightMode = "off" | "shadow" | "enforce";

export type AiResponseClaim =
  | { claimed: true; claimId: string | null; mode: SingleFlightMode }
  | {
      claimed: false;
      reason: "already_claimed" | "already_replied";
      claimId: string | null;
      mode: SingleFlightMode;
    };

export async function claimAiResponse(
  supabase: SupabaseClient<Database>,
  args: {
    orgId: string;
    inboundMessageId: string | null | undefined;
    propertyId: string;
    contactId: string;
    conversationId: string | null | undefined;
  },
): Promise<AiResponseClaim> {
  const mode = singleFlightMode();
  if (mode === "off" || !args.inboundMessageId) {
    return { claimed: true, claimId: null, mode };
  }

  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
  const { data: inserted, error } = await supabase
    .from("ai_response_claims")
    .insert({
      org_id: args.orgId,
      response_kind: RESPONSE_KIND,
      inbound_message_id: args.inboundMessageId,
      property_id: args.propertyId,
      contact_id: args.contactId,
      conversation_id: args.conversationId ?? null,
      status: "processing",
      claimed_at: now.toISOString(),
      lease_expires_at: leaseExpiresAt,
    })
    .select("id")
    .single();

  if (!error && inserted) {
    return { claimed: true, claimId: inserted.id, mode };
  }

  if (error?.code !== "23505") {
    reportError(new Error(error?.message ?? "missing AI response claim row"), {
      tags: { surface: "ai_response_claim_insert" },
      extra: { inboundMessageId: args.inboundMessageId },
    });
    return { claimed: true, claimId: null, mode };
  }

  const { data: existing, error: existingError } = await supabase
    .from("ai_response_claims")
    .select("id, status, lease_expires_at")
    .eq("inbound_message_id", args.inboundMessageId)
    .eq("response_kind", RESPONSE_KIND)
    .maybeSingle();
  if (existingError || !existing) {
    reportError(new Error(existingError?.message ?? "missing conflicting claim"), {
      tags: { surface: "ai_response_claim_lookup" },
      extra: { inboundMessageId: args.inboundMessageId },
    });
    return { claimed: true, claimId: null, mode };
  }

  if (existing.status === "completed") {
    if (mode !== "enforce") return { claimed: true, claimId: existing.id, mode };
    return {
      claimed: false,
      claimId: existing.id,
      mode,
      reason: "already_replied",
    };
  }

  const leaseExpires = new Date(existing.lease_expires_at).getTime();
  const freshLease = Number.isFinite(leaseExpires) && leaseExpires > Date.now();
  if (freshLease) {
    if (mode !== "enforce") return { claimed: true, claimId: existing.id, mode };
    return {
      claimed: false,
      claimId: existing.id,
      mode,
      reason: "already_claimed",
    };
  }

  const { data: reclaimed, error: reclaimError } = await supabase
    .from("ai_response_claims")
    .update({
      status: "processing",
      claimed_at: now.toISOString(),
      lease_expires_at: leaseExpiresAt,
      error_message: null,
      updated_at: now.toISOString(),
    })
    .eq("id", existing.id)
    .eq("lease_expires_at", existing.lease_expires_at)
    .select("id")
    .maybeSingle();
  if (reclaimError) {
    reportError(new Error(reclaimError.message), {
      tags: { surface: "ai_response_claim_reclaim" },
      extra: { inboundMessageId: args.inboundMessageId },
    });
  }
  if (reclaimed) {
    return { claimed: true, claimId: reclaimed.id, mode };
  }

  if (mode !== "enforce") return { claimed: true, claimId: existing.id, mode };
  return {
    claimed: false,
    claimId: existing.id,
    mode,
    reason: "already_claimed",
  };
}

export async function completeAiResponseClaim(
  supabase: SupabaseClient<Database>,
  args: {
    claimId: string | null | undefined;
    outcome: string;
    outboundMessageId?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  if (!args.claimId) return;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("ai_response_claims")
    .update({
      status: args.errorMessage ? "error" : "completed",
      completed_at: args.errorMessage ? null : now,
      outbound_message_id: args.outboundMessageId ?? null,
      outcome: args.outcome,
      error_message: args.errorMessage ?? null,
      updated_at: now,
    })
    .eq("id", args.claimId);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_response_claim_complete" },
      extra: { claimId: args.claimId, outcome: args.outcome },
    });
  }
}

function singleFlightMode(): SingleFlightMode {
  const raw = process.env.AI_RESPONDER_SINGLE_FLIGHT_MODE?.trim().toLowerCase();
  if (raw === "off" || raw === "shadow" || raw === "enforce") return raw;
  return "enforce";
}
