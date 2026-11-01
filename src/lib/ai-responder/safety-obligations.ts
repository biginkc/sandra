import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

/**
 * Routing v2 safety obligations (migration 20261031132300): the one representation of "a person
 * must still be told about this lead". Every helper here is best effort and reports its own
 * failures; callers keep failing closed around them.
 */
type LooseRpc = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
const MISSING = /PGRST202|PGRST205|42883|42P01|does not exist|Could not find/i;
const DENIED = /42501|permission denied/i;

export type ObligationSource = "decision" | "keyword" | "rep_takeover" | "legacy" | "hold_failed";

/** Open (or reuse) an unresolved obligation. Returns false only when it could not be recorded. */
export async function openSafetyObligation(
  supabase: SupabaseClient<Database>,
  a: { propertyId: string; inboundMessageId: string | null; reason: string; source: ObligationSource },
): Promise<boolean> {
  try {
    const { error } = await (supabase as unknown as LooseRpc).rpc("routing_v2_open_obligation", {
      p_property_id: a.propertyId, p_inbound_message_id: a.inboundMessageId, p_reason: a.reason, p_source: a.source,
    });
    if (!error) return true;
    if (MISSING.test(error.message)) return false;
    reportError(new Error(error.message), { tags: { surface: "routing_v2_safety_obligation_open" }, extra: { propertyId: a.propertyId } });
    return false;
  } catch (e) {
    reportError(e, { tags: { surface: "routing_v2_safety_obligation_open" }, extra: { propertyId: a.propertyId } });
    return false;
  }
}

/**
 * Is any safety obligation of this lead unresolved? Asks the database's own predicate
 * (routing_v2_has_unresolved_obligation), so the open obligation rows AND the fallback marker
 * (v2_safety_obligation_unrecorded) are one answer everywhere (Opus N1 at 46ee0f732bc1).
 * "unknown" = could not be read (callers fail closed); a database without the predicate is "no".
 */
export async function hasUnresolvedSafetyObligation(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<"yes" | "no" | "unknown"> {
  const ask = (client: unknown) => (client as LooseRpc).rpc("routing_v2_has_unresolved_obligation", { p_property_id: propertyId });
  try {
    let { data, error } = await ask(supabase);
    if (error && DENIED.test(`${(error as { code?: string }).code ?? ""} ${error.message}`)) {
      // The predicate is service-role only. A send released from a person's session (user-scoped
      // client, e.g. the outbox "Send next" button) asks with the server's admin client, so a lead
      // without an obligation is never refused just because the caller cannot run it.
      const { createAdminClient } = await import("@/lib/supabase/admin");
      ({ data, error } = await ask(createAdminClient()));
    }
    if (error) return MISSING.test(error.message) ? "no" : "unknown";
    if (data === true) return "yes";
    if (data === false) return "no";
    return "unknown";
  } catch (e) {
    // Opus N4 on #956: never "no" from an exception; the caller fails closed.
    reportError(e, { tags: { surface: "routing_v2_safety_obligation_read" }, extra: { propertyId } });
    return "unknown";
  }
}

/** A person resolved the lead (the real clear paths call this right before they clear the hold). */
export async function resolveSafetyObligationsByPerson(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<void> {
  try {
    const { error } = await (supabase as unknown as LooseRpc).rpc("routing_v2_resolve_obligations_by_person", { p_property_id: propertyId });
    if (error && !MISSING.test(error.message)) {
      reportError(new Error(error.message), { tags: { surface: "routing_v2_safety_obligation_person" }, extra: { propertyId } });
    }
  } catch (e) {
    if (!(e instanceof TypeError)) reportError(e, { tags: { surface: "routing_v2_safety_obligation_person" }, extra: { propertyId } });
  }
}

/**
 * Opus B4 on #956: the obligation itself could not be written on a failure path. Write the durable
 * fallback marker on the inbound's claim (completed, so never reclaimed); the one predicate treats
 * it as unresolved and the sweep promotes it. Returns false only when the marker failed too.
 */
export async function markObligationUnrecorded(
  supabase: SupabaseClient<Database>,
  a: {
    propertyId: string; inboundMessageId: string | null; reason: string;
    /** The run's own claim (id + claimed_at as taken): the marker is written only while that claim is still this run's. */
    claimId?: string | null; claimedAt?: string | null;
  },
): Promise<boolean> {
  try {
    const { data, error } = await (supabase as unknown as LooseRpc).rpc("routing_v2_mark_obligation_unrecorded", {
      p_property_id: a.propertyId, p_inbound_message_id: a.inboundMessageId, p_reason: a.reason,
      p_claim_id: a.claimId ?? null, p_claimed_at: a.claimedAt ?? null,
    });
    if (error) {
      reportError(new Error(error.message), { tags: { surface: "routing_v2_safety_obligation_fallback" }, extra: { propertyId: a.propertyId } });
      return false;
    }
    return data === true;
  } catch (e) {
    reportError(e, { tags: { surface: "routing_v2_safety_obligation_fallback" }, extra: { propertyId: a.propertyId } });
    return false;
  }
}

/** The sweep turns fallback markers into real obligations (flags on or off). Returns how many. */
export async function promoteUnrecordedObligationMarkers(
  supabase: SupabaseClient<Database>,
  a: { limit: number; propertyId?: string | null },
): Promise<number> {
  try {
    const { data, error } = await (supabase as unknown as LooseRpc).rpc("routing_v2_promote_unrecorded_markers", {
      p_limit: a.limit, p_property_id: a.propertyId ?? null,
    });
    if (error) {
      if (!MISSING.test(error.message)) reportError(new Error(error.message), { tags: { surface: "routing_v2_safety_obligation_promote" } });
      return 0;
    }
    return typeof data === "number" ? data : 0;
  } catch (e) {
    reportError(e, { tags: { surface: "routing_v2_safety_obligation_promote" } });
    return 0;
  }
}
