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
    if (mode === "enforce") {
      return {
        claimed: false,
        claimId: null,
        mode,
        reason: "already_claimed",
      };
    }
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
    if (mode === "enforce") {
      return {
        claimed: false,
        claimId: null,
        mode,
        reason: "already_claimed",
      };
    }
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

/**
 * Completes (or errors) a claim. Returns true when the write landed (or there
 * was no claim row to write), false when it failed (already reported). The
 * retry path depends on the result: a retry whose claim lease could not be
 * released can never run, so the caller must not schedule it.
 */
export async function completeAiResponseClaim(
  supabase: SupabaseClient<Database>,
  args: {
    claimId: string | null | undefined;
    outcome: string;
    outboundMessageId?: string | null;
    errorMessage?: string | null;
    /** Expire the lease now so the same inbound can be reclaimed (retry). */
    releaseLease?: boolean;
  },
): Promise<boolean> {
  if (!args.claimId) return true;
  const now = new Date().toISOString();
  try {
    const { error } = await supabase
      .from("ai_response_claims")
      .update({
        status: args.errorMessage ? "error" : "completed",
        completed_at: args.errorMessage ? null : now,
        outbound_message_id: args.outboundMessageId ?? null,
        outcome: args.outcome,
        error_message: args.errorMessage ?? null,
        ...(args.releaseLease ? { lease_expires_at: now } : {}),
        updated_at: now,
      })
      .eq("id", args.claimId);
    if (error) {
      reportError(new Error(error.message), {
        tags: { surface: "ai_response_claim_complete" },
        extra: { claimId: args.claimId, outcome: args.outcome },
      });
      return false;
    }
    return true;
  } catch (e) {
    reportError(e, {
      tags: { surface: "ai_response_claim_complete" },
      extra: { claimId: args.claimId, outcome: args.outcome },
    });
    return false;
  }
}

/**
 * Dedicated lease expiry for a retry whose normal completion write failed:
 * marks the claim `error` (retry_scheduled) with its lease already expired so
 * the re-dispatch of the same inbound can reclaim it. Returns false (error
 * surfaced) when even this fails; the caller must then dead-letter + flag
 * instead of scheduling a retry that cannot run.
 */
export async function expireAiResponseClaimLease(
  supabase: SupabaseClient<Database>,
  args: { claimId: string | null | undefined; errorMessage: string },
): Promise<boolean> {
  if (!args.claimId) return true;
  const now = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from("ai_response_claims")
      .update({
        status: "error",
        error_message: args.errorMessage,
        lease_expires_at: now,
        updated_at: now,
      })
      .eq("id", args.claimId)
      .select("id")
      .maybeSingle();
    if (error || !data) {
      reportError(new Error(error?.message ?? "claim row not found when expiring lease"), {
        tags: { surface: "ai_response_claim_expire_lease" },
        extra: { claimId: args.claimId },
      });
      return false;
    }
    return true;
  } catch (e) {
    reportError(e, {
      tags: { surface: "ai_response_claim_expire_lease" },
      extra: { claimId: args.claimId },
    });
    return false;
  }
}

/**
 * Template step crash window (PLAN 4.6): the approved template is sent BEFORE
 * the Jev outcome is applied (nurture / not_interested suppress automated
 * sends), so a crash between the two leaves a seller texted with no outcome
 * applied. The claim records the sent message id and this marker the moment the
 * send succeeds; the final `completeAiResponseClaim` overwrites it. A claim that
 * still carries the marker past its lease is swept (needs_human_attention,
 * reason `template_sent_outcome_missing`) and its marker becomes `..._missing`
 * so it is flagged once. A re-dispatch of the same inbound reads the marker and
 * never sends the template a second time.
 */
export const TEMPLATE_SENT_PENDING_OUTCOME = "template_sent_outcome_pending";
export const TEMPLATE_SENT_MISSING_OUTCOME = "template_sent_outcome_missing";

/** Record the sent template on the claim BEFORE the outcome is applied. False = the write did not land. */
export async function recordClaimTemplateSent(
  supabase: SupabaseClient<Database>,
  args: { claimId: string | null | undefined; outboundMessageId: string },
): Promise<boolean> {
  if (!args.claimId) return true;
  try {
    const { data, error } = await supabase
      .from("ai_response_claims")
      .update({
        outbound_message_id: args.outboundMessageId,
        outcome: TEMPLATE_SENT_PENDING_OUTCOME,
        updated_at: new Date().toISOString(),
      })
      .eq("id", args.claimId)
      .select("id")
      .maybeSingle();
    if (error || !data) {
      reportError(new Error(error?.message ?? "claim row not found when recording the sent template"), {
        tags: { surface: "ai_response_claim_record_template" },
        extra: { claimId: args.claimId },
      });
      return false;
    }
    return true;
  } catch (e) {
    reportError(e, {
      tags: { surface: "ai_response_claim_record_template" },
      extra: { claimId: args.claimId },
    });
    return false;
  }
}

/**
 * Did an earlier run of THIS claim already send its template? Returns the sent
 * message id, `null` when none, `"error"` when the claim cannot be read (the
 * caller fails closed: no second send).
 */
export async function loadClaimTemplateSent(
  supabase: SupabaseClient<Database>,
  claimId: string | null | undefined,
): Promise<string | null | "error"> {
  if (!claimId) return null;
  try {
    const { data, error } = await supabase
      .from("ai_response_claims")
      .select("outbound_message_id, outcome")
      .eq("id", claimId)
      .maybeSingle();
    if (error) {
      reportError(new Error(error.message), {
        tags: { surface: "ai_response_claim_load_template" },
        extra: { claimId },
      });
      return "error";
    }
    if (
      data?.outbound_message_id &&
      (data.outcome === TEMPLATE_SENT_PENDING_OUTCOME || data.outcome === TEMPLATE_SENT_MISSING_OUTCOME)
    ) {
      return data.outbound_message_id;
    }
    return null;
  } catch (e) {
    reportError(e, { tags: { surface: "ai_response_claim_load_template" }, extra: { claimId } });
    return "error";
  }
}

/**
 * Claims that sent a template and never applied the outcome: still carrying
 * the pending marker, not completed, lease expired. Index:
 * idx_ai_response_claims_template_pending (partial on the marker).
 */
export function staleTemplateSentClaimsQuery(
  supabase: SupabaseClient<Database>,
  args: { leaseExpiredBefore: string; limit: number },
) {
  return supabase
    .from("ai_response_claims")
    .select("id, org_id, property_id, outbound_message_id")
    .eq("outcome", TEMPLATE_SENT_PENDING_OUTCOME)
    .in("status", ["processing", "error"])
    .not("outbound_message_id", "is", null)
    .lt("lease_expires_at", args.leaseExpiredBefore)
    .order("lease_expires_at", { ascending: true })
    .limit(args.limit);
}

/** Retire the pending marker so a swept claim is flagged exactly once. True when this call won. */
export async function markClaimTemplateOutcomeMissing(
  supabase: SupabaseClient<Database>,
  claimId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("ai_response_claims")
    .update({
      outcome: TEMPLATE_SENT_MISSING_OUTCOME,
      status: "error",
      error_message: TEMPLATE_SENT_MISSING_OUTCOME,
      updated_at: new Date().toISOString(),
    })
    .eq("id", claimId)
    .eq("outcome", TEMPLATE_SENT_PENDING_OUTCOME)
    .select("id")
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_response_claim_mark_template_missing" },
      extra: { claimId },
    });
    return false;
  }
  return !!data;
}

function singleFlightMode(): SingleFlightMode {
  const raw = process.env.AI_RESPONDER_SINGLE_FLIGHT_MODE?.trim().toLowerCase();
  if (raw === "off" || raw === "shadow" || raw === "enforce") return raw;
  return "enforce";
}
