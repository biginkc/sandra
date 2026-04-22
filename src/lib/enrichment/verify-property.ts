import type { SupabaseClient } from "@supabase/supabase-js";

import { ConfigurationError } from "@/lib/errors/classes";
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
): Promise<VerifyPropertyOutcome> {
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

  const { data: property, error: fetchError } = await supabase
    .from("properties")
    .select("id, address, city, state, zip")
    .eq("id", propertyId)
    .maybeSingle();

  if (fetchError) {
    return { status: "failed", propertyId, error: fetchError.message };
  }
  if (!property) return { status: "not_found", propertyId };

  const input: AddressInput = {
    address: property.address,
    city: property.city,
    state: property.state,
    zip: property.zip,
  };

  let verified: VerifiedAddress | null = null;
  let cacheHit = false;
  try {
    verified = await lookupCassCache(supabase, input);
    if (verified) {
      cacheHit = true;
    } else {
      verified = await verifier.verify(input);
      if (verified) {
        // Write-through. Don't block the caller on cache insert failures —
        // a failed write just means the next lookup pays the API cost.
        await writeCassCache(supabase, input, verified);
      }
    }
  } catch (e) {
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

  const { error: updateError } = await supabase
    .from("properties")
    .update(updates)
    .eq("id", propertyId);

  if (updateError) {
    return { status: "failed", propertyId, error: updateError.message };
  }

  return {
    status: verified.cassStatus === "verified" ? "verified" : "stored_with_status",
    propertyId,
    cacheHit,
    verified,
  };
}
