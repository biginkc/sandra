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
type LooseFrom = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        is: (k: string, v: null) => { limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: { code?: string; message: string } | null }> };
      };
    };
  };
};
const MISSING = /PGRST202|PGRST205|42883|42P01|does not exist|Could not find/i;

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
 * Is any safety obligation of this lead unresolved? "unknown" = could not be read (callers fail
 * closed); a database without the store is "no".
 */
export async function hasUnresolvedSafetyObligation(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<"yes" | "no" | "unknown"> {
  try {
    const { data, error } = await (supabase as unknown as LooseFrom).from("routing_v2_safety_obligations")
      .select("id").eq("property_id", propertyId).is("resolved_at", null).limit(1);
    if (error) return MISSING.test(error.message) ? "no" : "unknown";
    return (data ?? []).length > 0 ? "yes" : "no";
  } catch (e) {
    if (e instanceof TypeError) return "no"; // a client double without this table / chain
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
