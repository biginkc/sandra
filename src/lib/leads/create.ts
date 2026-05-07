import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeAddress,
  normalizeDisplayAddress,
  normalizeName,
  normalizePhone,
  normalizeStateCode,
  normalizeZip,
} from "@/lib/csv/normalize";
import type { Database } from "@/lib/supabase/types";

/**
 * Canonical list of `properties.source` values. Mirrors the DB CHECK
 * constraint defined in migration 030 (with vendor additions in
 * migration 053). Surfaces that ask for source (the import wizard, the
 * lead webhook, the manual form) all read from here so the vocabulary
 * stays in one place.
 *
 * The format-helper auto-detects the vendor from CSV headers and sets
 * the import wizard's Source dropdown — `titlepro`, `reisift`, and
 * `agent_outreach` were added so detection has a faithful
 * provenance value to assign.
 */
export const LEAD_SOURCES = [
  "dealmachine",
  "propstream",
  "titlepro",
  "reisift",
  "agent_outreach",
  "driving_for_dollars",
  "referral",
  "cold_call",
  "sms",
  "web_form",
  "direct_mail",
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

export type CreateLeadInput = {
  /** How the lead got into the pipeline. Required — drives KPI / attribution. */
  source: LeadSource;
  /** Property fields. Address + state are required; rest optional. */
  property: {
    address: string;
    city?: string | null;
    state: string;
    zip?: string | null;
    market?: string | null;
    /** Optional county_id (FK to counties.id). Per phase 02 D-04
     *  market and county_id are set together at write time — callers
     *  that have it (e.g. the manual-entry form once it adopts the
     *  county picker) should supply both. Webhooks that don't have
     *  it leave it null and the property is filled in later via CASS
     *  verification. */
    county_id?: string | null;
  };
  /** Optional contact info for the homeowner. If provided, dedups by
   *  phone_1 → email → name (matching the CSV ingest's contact dedup). */
  contact?: {
    first_name?: string | null;
    last_name?: string | null;
    phone_1?: string | null;
    email?: string | null;
  };
  /** Optional caller-supplied user id to stamp on `created_by`. Webhook
   *  callers leave this null. */
  createdBy?: string | null;
};

export type CreateLeadResult = {
  propertyId: string;
  /** True if the property already existed (matched by normalized address)
   *  and we just attached the contact + source. False = brand new row. */
  wasDuplicate: boolean;
  /** Resolved homeowner contact id, if a contact was provided. */
  contactId: string | null;
};

export type CreateLeadError = {
  code: "VALIDATION" | "INSERT_FAILED" | "INTERNAL";
  message: string;
  field?: string;
};

/**
 * Single creation path for new leads, shared between the lead-import
 * webhook (`POST /api/webhooks/leads/[secret]`) and the manual entry
 * form (`/leads/new`). Both surfaces validate + normalize at the edge
 * and call this — there is exactly one place properties + contacts get
 * inserted from a non-CSV source.
 *
 * Behaviour:
 *   - Property dedup by `address_normalized`. If a property already
 *     exists at that address, return its id with `wasDuplicate=true`
 *     and (if contact info was supplied) attach the contact as the
 *     homeowner only when the property has none yet.
 *   - Contact dedup by phone_1 → email → (first_name + last_name).
 *     Reuses the strict matching the CSV ingest uses so a re-submitted
 *     lead never spawns a duplicate contact row.
 *   - New property defaults to `status='new_lead'` — these surfaces
 *     are post-contact (cold call, form fill, inbound SMS), so the
 *     prospect → new_lead transition has effectively already happened.
 *     CSV imports stay on `prospect` because they're bulk pre-contact.
 *
 * Never throws on validation issues — returns a `CreateLeadError`
 * so callers can map cleanly to HTTP 400 / form field errors.
 */
export async function createLead(
  supabase: SupabaseClient<Database>,
  input: CreateLeadInput,
): Promise<{ ok: true; data: CreateLeadResult } | { ok: false; error: CreateLeadError }> {
  // ---- 1. Validate + normalize ---------------------------------------
  const addressRaw = input.property.address?.trim() ?? "";
  if (!addressRaw) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Property address is required.",
        field: "property.address",
      },
    };
  }
  const stateNorm = normalizeStateCode(input.property.state);
  if (!stateNorm) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Property state is required and must be a valid US state code.",
        field: "property.state",
      },
    };
  }
  if (!LEAD_SOURCES.includes(input.source)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid source "${input.source}". Allowed: ${LEAD_SOURCES.join(", ")}.`,
        field: "source",
      },
    };
  }

  const cityNorm = normalizeDisplayAddress(input.property.city) || null;
  const zipNorm = normalizeZip(input.property.zip ?? null);
  const addressNormalized = normalizeAddress(addressRaw);
  const phoneNorm = normalizePhone(input.contact?.phone_1 ?? null);
  const emailNorm = input.contact?.email?.trim().toLowerCase() || null;
  const firstNorm = normalizeName(input.contact?.first_name) || null;
  const lastNorm = normalizeName(input.contact?.last_name) || null;

  // ---- 2. Look up existing property by normalized address ------------
  let propertyId: string | null = null;
  let wasDuplicate = false;
  if (addressNormalized) {
    const { data: existing, error: lookupErr } = await supabase
      .from("properties")
      .select("id, homeowner_contact_id")
      .eq("address_normalized", addressNormalized)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (lookupErr) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: lookupErr.message },
      };
    }
    if (existing) {
      propertyId = existing.id;
      wasDuplicate = true;
    }
  }

  // ---- 3. Resolve / create contact (if any was supplied) -------------
  let contactId: string | null = null;
  const hasAnyContactField =
    !!phoneNorm || !!emailNorm || !!firstNorm || !!lastNorm;
  if (hasAnyContactField) {
    contactId = await resolveOrCreateContact(supabase, {
      first_name: firstNorm,
      last_name: lastNorm,
      phone_1: phoneNorm,
      email: emailNorm,
    });
  }

  // ---- 4. Create property if new, or attach contact to existing ------
  if (!propertyId) {
    const insertRow: Database["public"]["Tables"]["properties"]["Insert"] = {
      // Post-contact entry — promote past the prospect stage.
      status: "new_lead",
      address: addressRaw,
      city: cityNorm,
      state: stateNorm,
      zip: zipNorm,
      market: input.property.market ?? null,
      // Phase 02 D-04: market and county_id are set together at
      // write time. Null when the caller doesn't supply it (webhooks,
      // current-shape manual form) — CASS verification fills it later.
      county_id: input.property.county_id ?? null,
      address_normalized: addressNormalized,
      source: input.source,
      homeowner_contact_id: contactId,
      assigned_user_id: input.createdBy ?? null,
    };
    const { data: inserted, error: insertErr } = await supabase
      .from("properties")
      .insert(insertRow)
      .select("id")
      .single();
    if (insertErr || !inserted) {
      return {
        ok: false,
        error: {
          code: "INSERT_FAILED",
          message: insertErr?.message ?? "Property insert failed",
        },
      };
    }
    propertyId = inserted.id;
  } else if (contactId) {
    // Property existed already; attach contact as homeowner only if
    // the row has none yet. Don't clobber an existing homeowner — the
    // operator should reconcile via the unknown-triage flow.
    await supabase
      .from("properties")
      .update({ homeowner_contact_id: contactId })
      .eq("id", propertyId)
      .is("homeowner_contact_id", null);
  }

  return {
    ok: true,
    data: { propertyId, wasDuplicate, contactId },
  };
}

/**
 * Mirror of the CSV ingest's contact-dedup chain (see
 * `src/lib/csv/ingest.ts:540-595`):
 *   1. phone_1 match → reuse
 *   2. email match → reuse
 *   3. first/last name match (only for person-type, no phone, no email)
 *   4. Insert new
 *
 * Kept here as a separate helper rather than reusing the CSV one
 * because the CSV path takes a richer `contact` shape (homeowner_details
 * fields, role flags) we don't need from a webhook/form payload.
 */
async function resolveOrCreateContact(
  supabase: SupabaseClient<Database>,
  contact: {
    first_name: string | null;
    last_name: string | null;
    phone_1: string | null;
    email: string | null;
  },
): Promise<string | null> {
  if (contact.phone_1) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .eq("phone_1", contact.phone_1)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  if (contact.email) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .ilike("email", contact.email)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  if (
    !contact.phone_1 &&
    !contact.email &&
    contact.first_name &&
    contact.last_name
  ) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .ilike("first_name", contact.first_name)
      .ilike("last_name", contact.last_name)
      .eq("contact_type", "person")
      .is("phone_1", null)
      .is("email", null)
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      contact_type: "person",
      first_name: contact.first_name,
      last_name: contact.last_name,
      phone_1: contact.phone_1,
      email: contact.email,
    })
    .select("id")
    .single();
  if (error) {
    throw new Error(`contact insert: ${error.message}`);
  }
  return data.id;
}
