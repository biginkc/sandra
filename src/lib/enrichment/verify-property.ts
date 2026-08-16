import type { SupabaseClient } from "@supabase/supabase-js";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";
import type { Database, Json } from "@/lib/supabase/types";
import { lookupCassCache, writeCassCache } from "./cass-cache";
import { getAddressVerifier } from "./registry";
import type { AddressInput, VerifiedAddress } from "./types";

export type VerifyPropertyOutcome =
  | {
      status: "verified" | "stored_with_status";
      propertyId: string;
      cacheHit: boolean;
      verified: VerifiedAddress;
    }
  | { status: "not_found"; propertyId: string }
  | { status: "provider_off"; propertyId: string }
  | { status: "dnc_skipped"; propertyId: string }
  | { status: "submission_unknown"; propertyId: string; error: string }
  | { status: "provider_rejected"; propertyId: string; error: string }
  | { status: "provider_persist_failed"; propertyId: string; error: string }
  | { status: "no_result"; propertyId: string }
  | { status: "failed"; propertyId: string; error: string };

type PropertyCassUpdate = Database["public"]["Tables"]["properties"]["Update"];

/**
 * Core "verify one property" operation, shared by:
 *   - the manual Verify button on /leads/[id]
 *   - the CASS child job that runs after every CSV import
 *
 * Cache-through behavior: consult cass_cache by raw input address, fall
 * through to the provider on miss (or stale entry), persist the result
 * back into the cache and onto the property row.
 *
 * Never throws — returns a discriminated outcome so the caller (server
 * action or job worker) can render or log as it sees fit.
 */
export async function verifyPropertyAddress(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  expectedOrgId: string,
): Promise<VerifyPropertyOutcome> {
  const { data: property, error: fetchError } = await supabase
    .from("properties")
    .select("id, org_id, address, city, state, zip, is_dnc_locked")
    .eq("id", propertyId)
    .eq("org_id", expectedOrgId)
    .maybeSingle();

  if (fetchError) {
    return { status: "failed", propertyId, error: fetchError.message };
  }
  if (!property || property.org_id !== expectedOrgId) {
    return { status: "not_found", propertyId };
  }
  if (property.is_dnc_locked) return { status: "dnc_skipped", propertyId };

  const input: AddressInput = {
    address: property.address,
    city: property.city,
    state: property.state,
    zip: property.zip,
  };

  let verified: VerifiedAddress | null = null;
  let cacheHit = false;
  let providerCallStarted = false;
  try {
    verified = await lookupCassCache(supabase, input);
    if (verified) {
      cacheHit = true;
    } else {
      let verifier;
      try {
        verifier = getAddressVerifier();
      } catch (e) {
        if (e instanceof ConfigurationError) {
          return { status: "provider_off", propertyId };
        }
        throw e;
      }
      if (!verifier) return { status: "provider_off", propertyId };

      const { data: paidClaim, error: paidClaimError } = await (
        supabase as unknown as {
          rpc(
            fn: "claim_paid_property_enrichment",
            args: { p_property_id: string; p_org_id: string },
          ): Promise<{ data: boolean | null; error: { message: string } | null }>;
        }
      ).rpc("claim_paid_property_enrichment", {
        p_property_id: property.id,
        p_org_id: property.org_id,
      });
      if (paidClaimError) {
        return {
          status: "failed",
          propertyId,
          error: `paid-boundary DNC claim failed: ${paidClaimError.message}`,
        };
      }
      if (paidClaim !== true) {
        return { status: "dnc_skipped", propertyId };
      }

      providerCallStarted = true;
      verified = await verifier.verify(input);
    }
  } catch (e) {
    if (
      providerCallStarted &&
      e instanceof ProviderError &&
      typeof e.details?.status === "number"
    ) {
      return { status: "provider_rejected", propertyId, error: e.message };
    }
    if (providerCallStarted) {
      return {
        status: "submission_unknown",
        propertyId,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    return {
      status: "failed",
      propertyId,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (!verified) return { status: "no_result", propertyId };

  const updates: PropertyCassUpdate = {
    cass_status: verified.cassStatus,
    cass_verified_at: new Date().toISOString(),
    cass_raw_response: verified.raw as Json,
    updated_at: new Date().toISOString(),
  };
  if (verified.cassStatus === "verified" && verified.standardized) {
    updates.address_normalized = verified.standardized.toLowerCase();
  }
  if (verified.lat != null) updates.lat = verified.lat;
  if (verified.lon != null) updates.lon = verified.lon;
  if (verified.isVacant != null) updates.is_vacant = verified.isVacant;
  if (verified.isResidential != null)
    updates.is_residential = verified.isResidential;
  if (verified.fipsCode) updates.fips_code = verified.fipsCode;

  const { data: updated, error: updateError } = await supabase
    .from("properties")
    .update(updates)
    .eq("id", propertyId)
    .eq("org_id", property.org_id)
    .eq("is_dnc_locked", false)
    .select("id");

  if (updateError) {
    if (updateError.message.includes("DNC_LOCKED")) {
      return { status: "dnc_skipped", propertyId };
    }
    return {
      status: cacheHit ? "failed" : "provider_persist_failed",
      propertyId,
      error: updateError.message,
    };
  }
  if (!updated || updated.length !== 1) {
    return { status: "dnc_skipped", propertyId };
  }

  if (!cacheHit) {
    try {
      await writeCassCache(supabase, input, verified);
    } catch {
      // The property result is already durable. Cache failure cannot make a
      // paid response retryable or turn a successful verification into loss.
    }
  }

  return {
    status: verified.cassStatus === "verified" ? "verified" : "stored_with_status",
    propertyId,
    cacheHit,
    verified,
  };
}
