import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeAddress,
  normalizeDisplayAddress,
  normalizeName,
  normalizePhone,
  normalizeStateCode,
  normalizeZip,
} from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import { telnyxLookupFromEnv } from "@/lib/line-type-lookup/telnyx";
import type { PhoneLineType } from "@/lib/messaging/line-type";
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
export type LeadMotivation = "hot" | "warm" | "cold";

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
  /** Historical creator fallback used as the default assignee. Webhook
   *  callers leave this null. */
  createdBy?: string | null;
  /** Explicit board owner. Omitted callers retain the historical behavior
   *  of assigning the creator; null intentionally leaves the lead unassigned. */
  assignedUserId?: string | null;
  /** Optional seller motivation captured by the quick-entry form. */
  motivationLevel?: LeadMotivation | null;
};

export type CreateLeadResult = {
  propertyId: string;
  /** True if the property already existed (matched by normalized address).
   *  Duplicate requests do not modify the property or create a contact. */
  wasDuplicate: boolean;
  /** Resolved homeowner contact id for a newly created lead. Duplicate
   *  results return null because submitted contact data was not processed. */
  contactId: string | null;
  /** Set when the submitted phone could not be classified (Telnyx
   *  unconfigured / unreachable / unknown line type) and was therefore
   *  not saved as a phone slot (hard rule, migration 080). The number
   *  is preserved verbatim on the contact's notes for manual recovery —
   *  callers must surface this degraded outcome, not report plain
   *  success. */
  phoneDropped: string | null;
};

export type CreateLeadError = {
  code: "VALIDATION" | "INSERT_FAILED" | "INTERNAL" | "REPAIR_REQUIRED";
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
 *     before resolving or creating any submitted contact.
 *   - A new property claims the unique address before contact work. This
 *     makes a concurrent unique-index loser an explicit duplicate without
 *     creating an orphan contact.
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
  if (
    input.motivationLevel !== undefined &&
    input.motivationLevel !== null &&
    !(["hot", "warm", "cold"] as const).includes(input.motivationLevel)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Motivation must be hot, warm, cold, or not set.",
        field: "motivationLevel",
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
  if (addressNormalized) {
    const { data: existing, error: lookupErr } = await supabase
      .from("properties")
      .select("id")
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
      return {
        ok: true,
        data: {
          propertyId: existing.id,
          wasDuplicate: true,
          contactId: null,
          phoneDropped: null,
        },
      };
    }
  }

  // ---- 3. Claim the property address before creating a contact --------
  // The unique address index is the final race arbiter. Inserting the
  // property first ensures a concurrent loser returns the winner as a
  // duplicate without ever creating an unattached contact.
  const insertRow: Database["public"]["Tables"]["properties"]["Insert"] = {
    status: "new_lead",
    address: addressRaw,
    city: cityNorm,
    state: stateNorm,
    zip: zipNorm,
    market: input.property.market ?? null,
    county_id: input.property.county_id ?? null,
    address_normalized: addressNormalized,
    source: input.source,
    homeowner_contact_id: null,
    assigned_user_id:
      input.assignedUserId === undefined
        ? (input.createdBy ?? null)
        : input.assignedUserId,
    motivation_level: input.motivationLevel ?? null,
  };
  const { data: inserted, error: insertErr } = await supabase
    .from("properties")
    .insert(insertRow)
    .select("id")
    .single();
  if (insertErr || !inserted) {
    if (insertErr?.code === "23505" && addressNormalized) {
      const { data: winner, error: winnerError } = await supabase
        .from("properties")
        .select("id")
        .eq("address_normalized", addressNormalized)
        .is("deleted_at", null)
        .limit(1)
        .maybeSingle();
      if (!winnerError && winner) {
        return {
          ok: true,
          data: {
            propertyId: winner.id,
            wasDuplicate: true,
            contactId: null,
            phoneDropped: null,
          },
        };
      }
    }
    return {
      ok: false,
      error: {
        code: "INSERT_FAILED",
        message: insertErr?.message ?? "Property insert failed",
      },
    };
  }
  const propertyId = inserted.id;

  // ---- 4. Resolve / create contact (if any was supplied) -------------
  let contactId: string | null = null;
  let phoneDropped: string | null = null;
  const hasAnyContactField =
    !!phoneNorm || !!emailNorm || !!firstNorm || !!lastNorm;
  if (hasAnyContactField) {
    let resolved: Awaited<ReturnType<typeof resolveOrCreateContact>>;
    try {
      resolved = await resolveOrCreateContact(supabase, {
        first_name: firstNorm,
        last_name: lastNorm,
        phone_1: phoneNorm,
        email: emailNorm,
      });
    } catch (error) {
      const cleanup = await cleanupClaimedLead(supabase, propertyId, null);
      if (!cleanup.ok) return cleanup;
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message:
            error instanceof Error
              ? error.message
              : "The homeowner contact could not be created.",
        },
      };
    }
    contactId = resolved.id;
    phoneDropped = resolved.phoneDropped;
    const { data: attached, error: attachError } = await supabase
      .from("properties")
      .update({ homeowner_contact_id: contactId })
      .eq("id", propertyId)
      .is("homeowner_contact_id", null)
      .select("id")
      .maybeSingle();
    if (attachError || !attached) {
      const cleanup = await cleanupClaimedLead(
        supabase,
        propertyId,
        resolved.created ? contactId : null,
      );
      if (!cleanup.ok) return cleanup;
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message:
            attachError?.message ??
            "The lead was created, but its homeowner could not be attached.",
        },
      };
    }
  }

  return {
    ok: true,
    data: { propertyId, wasDuplicate: false, contactId, phoneDropped },
  };
}

async function cleanupClaimedLead(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  newlyCreatedContactId: string | null,
): Promise<{ ok: true } | { ok: false; error: CreateLeadError }> {
  try {
    // Delete the claimed property first. If the attach write reached the DB
    // but its response was lost, this releases its homeowner FK before the
    // contact cleanup. Selecting the deleted id proves this was not an
    // RLS-hidden or stale no-op.
    const { data: removedProperty, error: propertyCleanupError } = await supabase
      .from("properties")
      .delete()
      .eq("id", propertyId)
      .select("id")
      .maybeSingle();
    if (propertyCleanupError || !removedProperty) {
      const reason =
        propertyCleanupError?.message ?? "the claimed property was not deleted";
      reportError(new Error(`lead create compensation failed: ${reason}`), {
        tags: { surface: "lead_create_cleanup" },
        extra: { propertyId, newlyCreatedContactId },
      });
      return repairRequired(propertyId, reason);
    }

    if (newlyCreatedContactId) {
      const { data: removedContact, error: contactCleanupError } = await supabase
        .from("contacts")
        .delete()
        .eq("id", newlyCreatedContactId)
        .select("id")
        .maybeSingle();
      if (contactCleanupError || !removedContact) {
        const reason =
          contactCleanupError?.message ?? "the new contact was not deleted";
        reportError(new Error(`lead create compensation failed: ${reason}`), {
          tags: { surface: "lead_create_cleanup" },
          extra: { propertyId, newlyCreatedContactId },
        });
        return repairRequired(propertyId, reason);
      }
    }

    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    reportError(error, {
      tags: { surface: "lead_create_cleanup" },
      extra: { propertyId, newlyCreatedContactId },
    });
    return repairRequired(propertyId, reason);
  }
}

function repairRequired(
  propertyId: string,
  reason: string,
): { ok: false; error: CreateLeadError } {
  return {
    ok: false,
    error: {
      code: "REPAIR_REQUIRED",
      message: `Lead creation could not be rolled back for property ${propertyId}. Do not retry until this record is repaired. (${reason})`,
    },
  };
}

/**
 * Mirror of the CSV ingest's contact-dedup chain (see
 * `src/lib/csv/ingest.ts:540-595`), with the phone match widened to all
 * three slots — triage and skip-trace populate phone_2/phone_3, and a
 * number already known there must reuse that contact (a phone_1-only
 * check created duplicates AND a pointless paid lookup, and downstream
 * inbound threading returns ambiguous_contact on multi-contact numbers):
 *   1. any-slot phone match → reuse
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
): Promise<{ id: string | null; phoneDropped: string | null; created: boolean }> {
  if (contact.phone_1) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .or(
        `phone_1.eq.${contact.phone_1},phone_2.eq.${contact.phone_1},phone_3.eq.${contact.phone_1}`,
      )
      .limit(1)
      .maybeSingle();
    if (data) return { id: data.id, phoneDropped: null, created: false };
  }
  if (contact.email) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .ilike("email", contact.email)
      .limit(1)
      .maybeSingle();
    if (data) return { id: data.id, phoneDropped: null, created: false };
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
    if (data) return { id: data.id, phoneDropped: null, created: false };
  }
  // Hard rule (migration 080): a phone can't be saved with type
  // 'unknown'. Lead phones arrive untyped, so classify at intake via
  // Telnyx when configured. When the lookup is unavailable or fails,
  // the number can't go into a phone slot — preserve it verbatim on
  // the contact's notes (durable, visible on the lead page) and flag
  // the degraded outcome to the caller; never silently succeed.
  let phoneType: PhoneLineType = "unknown";
  if (contact.phone_1) {
    try {
      const lookup = telnyxLookupFromEnv();
      const types = await lookup.classify([contact.phone_1]);
      phoneType = types.get(contact.phone_1) ?? "unknown";
    } catch {
      // ConfigurationError (no TELNYX_API_KEY) or transport failure.
    }
    if (phoneType === "unknown") {
      reportError(
        new Error("lead phone unclassified at intake — parked on notes"),
        {
          tags: { surface: "lead_create_phone_unclassified" },
          extra: { phone: contact.phone_1 },
        },
      );
    }
  }
  const phoneClassified = phoneType !== "unknown";
  const phoneDropped = !phoneClassified ? contact.phone_1 : null;
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      contact_type: "person",
      first_name: contact.first_name,
      last_name: contact.last_name,
      phone_1: phoneClassified ? contact.phone_1 : null,
      phone_1_type: phoneClassified ? phoneType : "unknown",
      email: contact.email,
      notes: phoneDropped
        ? `Unclassified phone from lead intake (line-type lookup unavailable): ${phoneDropped}`
        : null,
    })
    .select("id")
    .single();
  if (error) {
    throw new Error(`contact insert: ${error.message}`);
  }
  return { id: data.id, phoneDropped, created: true };
}
