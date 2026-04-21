"use server";

import { ConfigurationError } from "@/lib/errors/classes";
import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { getAddressVerifier } from "@/lib/enrichment/registry";
import type { CassStatus, VerifiedAddress } from "@/lib/enrichment/types";
import type { Database, Json } from "@/lib/supabase/types";

export type PropertyStatus =
  | "new_lead"
  | "contacted"
  | "interested"
  | "offer_sent"
  | "offer_declined"
  | "under_contract"
  | "closed"
  | "dead";

const VALID_STATUSES: readonly PropertyStatus[] = [
  "new_lead",
  "contacted",
  "interested",
  "offer_sent",
  "offer_declined",
  "under_contract",
  "closed",
  "dead",
];

type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
type HomeownerDetailsRow =
  Database["public"]["Tables"]["homeowner_details"]["Row"];
type AgentDetailsRow = Database["public"]["Tables"]["agent_details"]["Row"];
type PropertyRow = Database["public"]["Tables"]["properties"]["Row"];

export type DetailedLead = PropertyRow & {
  homeowner: (ContactRow & { homeowner_details: HomeownerDetailsRow | null }) | null;
  agent: (ContactRow & { agent_details: AgentDetailsRow | null }) | null;
};

export async function getLeadDetail(
  propertyId: string,
): Promise<Result<DetailedLead | null>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("properties")
      .select(
        `*,
         homeowner:contacts!properties_homeowner_contact_id_fkey(
           *,
           homeowner_details(*)
         ),
         agent:contacts!properties_agent_contact_id_fkey(
           *,
           agent_details(*)
         )`,
      )
      .eq("id", propertyId)
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: error.message },
      };
    }
    return ok(data as DetailedLead | null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "get_lead_detail" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "LEAD_FETCH_FAILED");
  }
}

export type VerifyResult = {
  cassStatus: CassStatus;
  standardized: string;
  isVacant: boolean | null;
};

export async function verifyLeadAddress(
  propertyId: string,
): Promise<Result<VerifyResult>> {
  let verifier;
  try {
    verifier = getAddressVerifier();
  } catch (e) {
    if (e instanceof ConfigurationError) {
      return {
        ok: false,
        error: {
          code: "PROVIDER_NOT_CONFIGURED",
          message: e.message,
        },
      };
    }
    throw e;
  }

  if (!verifier) {
    return {
      ok: false,
      error: {
        code: "PROVIDER_NOT_CONFIGURED",
        message:
          "Address verification is off. Set ADDRESS_VERIFIER_PROVIDER in .env.local to enable it.",
      },
    };
  }

  try {
    const supabase = await createClient();

    const { data: property, error: fetchError } = await supabase
      .from("properties")
      .select("id, address, city, state, zip")
      .eq("id", propertyId)
      .maybeSingle();

    if (fetchError) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: fetchError.message },
      };
    }
    if (!property) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }

    const verified = await verifier.verify({
      address: property.address,
      city: property.city,
      state: property.state,
      zip: property.zip,
    });

    if (!verified) {
      return {
        ok: false,
        error: {
          code: "VERIFICATION_FAILED",
          message: "Provider returned no result.",
        },
      };
    }

    const updates: Database["public"]["Tables"]["properties"]["Update"] = {
      cass_status: verified.cassStatus,
      cass_verified_at: new Date().toISOString(),
      cass_raw_response: verified.raw as Json,
      updated_at: new Date().toISOString(),
    };
    // Only overwrite address_normalized when CASS produced a useful answer.
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
      return {
        ok: false,
        error: {
          code: "VERIFICATION_PERSIST_FAILED",
          message: updateError.message,
        },
      };
    }

    return ok({
      cassStatus: verified.cassStatus,
      standardized: verified.standardized,
      isVacant: verified.isVacant ?? null,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "verify_lead_address" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "VERIFICATION_FAILED");
  }
}

export async function updatePropertyStatus(
  propertyId: string,
  status: PropertyStatus,
): Promise<Result<null>> {
  if (!VALID_STATUSES.includes(status)) {
    return {
      ok: false,
      error: {
        code: "INVALID_STATUS",
        message: `Unknown status: ${status}`,
      },
    };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("properties")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", propertyId);

    if (error) {
      return {
        ok: false,
        error: {
          code: "STATUS_UPDATE_FAILED",
          message: error.message,
        },
      };
    }

    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_property_status" },
      extra: { propertyId, status },
    });
    return errFromUnknown(e, "STATUS_UPDATE_FAILED");
  }
}
