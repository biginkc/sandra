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
  | {
      status: "provider_persist_failed";
      propertyId: string;
      error: string;
      verified: VerifiedAddress;
    }
  | { status: "no_result"; propertyId: string }
  | { status: "failed"; propertyId: string; error: string };

type PropertyCassUpdate = Database["public"]["Tables"]["properties"]["Update"];

type CassLookupClaim = {
  action: "claimed" | "reused" | "retry_blocked" | "ambiguous" | "dnc_locked";
  outcome: string | null;
  result_payload: Json | null;
  error_message: string | null;
};

type CassLookupRpcClient = {
  rpc(
    fn: "claim_cass_property_lookup",
    args: {
      p_job_id: string;
      p_org_id: string;
      p_property_id: string;
      p_provider_id: string;
    },
  ): Promise<{ data: CassLookupClaim[] | null; error: { message: string } | null }>;
  rpc(
    fn: "complete_cass_property_lookup",
    args: {
      p_job_id: string;
      p_org_id: string;
      p_property_id: string;
      p_state: "completed" | "retryable" | "ambiguous";
      p_outcome: string;
      p_result_payload: Json | null;
      p_error_message: string | null;
    },
  ): Promise<{ data: boolean | null; error: { message: string } | null }>;
};

function lookupRpcClient(
  supabase: SupabaseClient<Database>,
): CassLookupRpcClient {
  return supabase as unknown as CassLookupRpcClient;
}

function verifiedFromPayload(payload: Json | null): VerifiedAddress | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.standardized !== "string" ||
    !["unverified", "verified", "invalid", "ambiguous"].includes(
      String(candidate.cassStatus),
    ) ||
    typeof candidate.components !== "object" ||
    candidate.components === null
  ) {
    return null;
  }
  return candidate as unknown as VerifiedAddress;
}

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
  options?: {
    jobId?: string;
    afterProviderCheckpoint?: () => void | Promise<void>;
  },
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

      if (options?.jobId) {
        const { data, error } = await lookupRpcClient(supabase).rpc(
          "claim_cass_property_lookup",
          {
            p_job_id: options.jobId,
            p_org_id: property.org_id,
            p_property_id: property.id,
            p_provider_id: verifier.providerId,
          },
        );
        if (error || !data?.[0]) {
          return {
            status: "failed",
            propertyId,
            error: `paid-boundary lookup claim failed: ${error?.message ?? "no result"}`,
          };
        }
        const claim = data[0];
        if (claim.action === "dnc_locked") {
          return { status: "dnc_skipped", propertyId };
        }
        if (claim.action === "ambiguous") {
          return {
            status: "submission_unknown",
            propertyId,
            error: claim.error_message ?? "Prior provider submission is unresolved.",
          };
        }
        if (claim.action === "retry_blocked") {
          return {
            status: "provider_rejected",
            propertyId,
            error: claim.error_message ?? "Use the explicit retry action.",
          };
        }
        if (claim.action === "reused") {
          if (claim.outcome === "no_result") {
            return { status: "no_result", propertyId };
          }
          verified = verifiedFromPayload(claim.result_payload);
          if (!verified) {
            return {
              status: "failed",
              propertyId,
              error: "Saved CASS result is invalid.",
            };
          }
        }
      } else {
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
      }

      if (!verified) {
        providerCallStarted = true;
        try {
          verified = await verifier.verify(input);
        } catch (e) {
          if (options?.jobId) {
            const definiteReject =
              e instanceof ProviderError && typeof e.details?.status === "number";
            const { data: completed, error: completeError } = await lookupRpcClient(supabase).rpc(
              "complete_cass_property_lookup",
              {
                p_job_id: options.jobId,
                p_org_id: property.org_id,
                p_property_id: property.id,
                p_state: definiteReject ? "retryable" : "ambiguous",
                p_outcome: definiteReject ? "provider_rejected" : "transport_unknown",
                p_result_payload: null,
                p_error_message: e instanceof Error ? e.message : String(e),
              },
            );
            if (completeError || completed !== true) {
              return {
                status: "submission_unknown",
                propertyId,
                error: `provider outcome checkpoint failed: ${completeError?.message ?? "conflicting outcome"}`,
              };
            }
          }
          throw e;
        }

        if (options?.jobId) {
          const { data: completed, error: completeError } = await lookupRpcClient(supabase).rpc(
            "complete_cass_property_lookup",
            {
              p_job_id: options.jobId,
              p_org_id: property.org_id,
              p_property_id: property.id,
              p_state: "completed",
              p_outcome: verified ? "result" : "no_result",
              p_result_payload: verified ? (verified as unknown as Json) : null,
              p_error_message: null,
            },
          );
          if (completeError || completed !== true) {
            return {
              status: "submission_unknown",
              propertyId,
              error: `provider outcome checkpoint failed: ${completeError?.message ?? "conflicting outcome"}`,
            };
          }
          await options.afterProviderCheckpoint?.();
        }
      }
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
    if (cacheHit) {
      return { status: "failed", propertyId, error: updateError.message };
    }
    return {
      status: "provider_persist_failed",
      propertyId,
      error: updateError.message,
      verified,
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
