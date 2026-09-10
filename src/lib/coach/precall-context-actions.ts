"use server";
import { createClient } from "@/lib/supabase/server";
import { repDisplayName, repFileNumberIdentity } from "./rep-display-name";
import type { CoachCallContext } from "./types";
import { loadCoachCallContext } from "./coach-context-actions";

export async function loadPrecallContext(input: {
  propertyId: string | null;
  sellerPhoneE164: string | null;
  repPhoneE164: string | null;
}) {
  const client = await createClient();
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) throw new Error("Sign in to load call details.");
  try {
    return {
      operatorId: user.id,
      context: await loadCoachCallContext(input),
      error: null,
    };
  } catch {
    const context: CoachCallContext = {
      sellerName: null,
      propertyAddress: null,
      propertyCounty: null,
      repName: repDisplayName(user),
      authenticatedRepName: repFileNumberIdentity(user),
      repPhoneE164: input.repPhoneE164,
      motivation: null,
      leadId: null,
      sellerPhoneE164: input.sellerPhoneE164,
      coldCallerName: null,
      yearBuilt: null,
      leadSource: null,
      occupancy: null,
    };
    return {
      operatorId: user.id,
      context,
      error: "Could not load property details. You can still call.",
    };
  }
}

/** Revalidate the operator and selected target at the actual start boundary. */
export async function prepareSetupCall(input: {
  operatorId: string | null;
  propertyId: string | null;
  phoneE164: string;
}) {
  const client = await createClient();
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (
    error ||
    !user ||
    (input.operatorId !== null && user.id !== input.operatorId)
  )
    return {
      ok: false as const,
      error: "Your signed-in rep changed. Select the homeowner again.",
    };
  const {
    inspectLeadCall,
    inspectManualCall,
    prepareLeadCall,
    prepareManualCall,
  } = await import("@/lib/dialer/actions");
  const inspected = input.propertyId
    ? await inspectLeadCall(input.propertyId)
    : await inspectManualCall(input.phoneE164);
  if (!inspected.ok) return inspected;
  if (
    inspected.data.propertyId !== input.propertyId ||
    inspected.data.phoneE164 !== input.phoneE164
  )
    return {
      ok: false as const,
      error: "The selected call target changed. Select the homeowner again.",
    };
  const prepared = await (input.propertyId
    ? prepareLeadCall(input.propertyId)
    : prepareManualCall(input.phoneE164));
  return prepared.ok ? { ...prepared, operatorId: user.id } : prepared;
}
