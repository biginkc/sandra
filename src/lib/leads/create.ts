import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeAddress,
  normalizeDisplayAddress,
  normalizeName,
  normalizePhone,
  normalizeStateCode,
  normalizeZip,
} from "@/lib/csv/normalize";
import { ConfigurationError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import {
  telnyxLookupFromEnv,
  type TelnyxLookupOutcome,
} from "@/lib/line-type-lookup/telnyx";
import { LEAD_SOURCES, type LeadSource } from "@/lib/leads/sources";
import { asLineType, type PhoneLineType } from "@/lib/messaging/line-type";
import type { Database } from "@/lib/supabase/types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEAD_PHONE_LOOKUP_TIMEOUT_MS = 5_000;

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
export type LeadMotivation = "hot" | "warm" | "cold";

export type CreateLeadInput = {
  /** Tenant boundary for every lookup and write. Required even for service-role callers. */
  orgId: string;
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
  /** True when the phone was saved but its line type could not be verified. */
  phoneUnverified: boolean;
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
 *   - Contact resolution happens before the property insert, then the new
 *     property is inserted once with its homeowner already attached. No
 *     concurrent caller can observe an incomplete property row.
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
): Promise<
  { ok: true; data: CreateLeadResult } | { ok: false; error: CreateLeadError }
> {
  // ---- 1. Validate + normalize ---------------------------------------
  const orgId = input.orgId?.trim() ?? "";
  if (!orgId) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Organization is required.",
        field: "orgId",
      },
    };
  }
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
        message:
          "Property state is required and must be a valid US state code.",
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
  const phoneRaw = input.contact?.phone_1?.trim() ?? "";
  const phoneNorm = normalizePhone(phoneRaw || null);
  if (phoneRaw && !phoneNorm) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Enter a valid 10-digit US phone number.",
        field: "contact.phone_1",
      },
    };
  }
  const emailNorm = input.contact?.email?.trim().toLowerCase() || null;
  const firstNorm = normalizeName(input.contact?.first_name) || null;
  const lastNorm = normalizeName(input.contact?.last_name) || null;

  // ---- 2. Look up existing property by normalized address ------------
  if (addressNormalized) {
    const { data: existing, error: lookupErr } = await supabase
      .from("properties")
      .select("id")
      .eq("org_id", orgId)
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
          phoneUnverified: false,
        },
      };
    }
  }

  // ---- 3. Resolve / create contact before exposing the property --------
  // The property is inserted only once, already complete. If another request
  // wins the unique-address race, only a contact created by this request is
  // eligible for cleanup; an exposed property is never compensated away.
  let resolvedContact: Awaited<ReturnType<typeof resolveOrCreateContact>> = {
    id: null,
    phoneUnverified: false,
    created: false,
  };
  const hasAnyContactField =
    !!phoneNorm || !!emailNorm || !!firstNorm || !!lastNorm;
  if (hasAnyContactField) {
    try {
      resolvedContact = await resolveOrCreateContact(supabase, orgId, {
        first_name: firstNorm,
        last_name: lastNorm,
        phone_1: phoneNorm,
        email: emailNorm,
      });
    } catch (error) {
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
  }

  const insertRow: Database["public"]["Tables"]["properties"]["Insert"] = {
    org_id: orgId,
    status: "new_lead",
    address: addressRaw,
    city: cityNorm,
    state: stateNorm,
    zip: zipNorm,
    market: input.property.market ?? null,
    county_id: input.property.county_id ?? null,
    address_normalized: addressNormalized,
    source: input.source,
    homeowner_contact_id: resolvedContact.id,
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
    let duplicatePropertyId: string | null = null;
    if (insertErr?.code === "23505" && addressNormalized) {
      const { data: winner, error: winnerError } = await supabase
        .from("properties")
        .select("id")
        .eq("org_id", orgId)
        .eq("address_normalized", addressNormalized)
        .is("deleted_at", null)
        .limit(1)
        .maybeSingle();
      if (!winnerError && winner) {
        duplicatePropertyId = winner.id;
      }
    }

    if (resolvedContact.created && resolvedContact.id) {
      const cleanup = await cleanupNewContactIfUnreferenced(
        supabase,
        orgId,
        resolvedContact.id,
      );
      if (!cleanup.ok) return cleanup;
    }

    if (duplicatePropertyId) {
      return {
        ok: true,
        data: {
          propertyId: duplicatePropertyId,
          wasDuplicate: true,
          contactId: null,
          phoneUnverified: false,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "INSERT_FAILED",
        message: insertErr?.message ?? "Property insert failed",
      },
    };
  }

  const actor =
    input.createdBy && UUID_PATTERN.test(input.createdBy)
      ? ({ actorType: "user", actorId: input.createdBy } as const)
      : ({ actorType: "system" } as const);
  await recordLeadEvent({
    propertyId: inserted.id,
    ...actor,
    eventType: LEAD_EVENT_TYPES.LEAD_CREATED,
    payload: { source: input.source },
    sourceType: "properties.created",
    sourceId: inserted.id,
  });

  return {
    ok: true,
    data: {
      propertyId: inserted.id,
      wasDuplicate: false,
      contactId: resolvedContact.id,
      phoneUnverified: resolvedContact.phoneUnverified,
    },
  };
}

async function cleanupNewContactIfUnreferenced(
  supabase: SupabaseClient<Database>,
  orgId: string,
  contactId: string,
): Promise<{ ok: true } | { ok: false; error: CreateLeadError }> {
  try {
    const { data: reference, error: referenceError } = await supabase
      .from("properties")
      .select("id")
      .eq("org_id", orgId)
      .eq("homeowner_contact_id", contactId)
      .limit(1)
      .maybeSingle();
    if (referenceError) {
      return contactRepairRequired(contactId, referenceError.message);
    }
    if (reference) return { ok: true };

    // A foreign key closes the race between the reference check and delete:
    // if another request attaches this contact meanwhile, deletion fails and
    // the verification below proves whether the contact is now referenced.
    const { data: removedContact, error: contactCleanupError } = await supabase
      .from("contacts")
      .delete()
      .eq("org_id", orgId)
      .eq("id", contactId)
      .select("id")
      .maybeSingle();
    if (!contactCleanupError && removedContact) return { ok: true };

    const [{ data: remaining, error: remainingError }, { data: newReference }] =
      await Promise.all([
        supabase
          .from("contacts")
          .select("id")
          .eq("org_id", orgId)
          .eq("id", contactId)
          .maybeSingle(),
        supabase
          .from("properties")
          .select("id")
          .eq("org_id", orgId)
          .eq("homeowner_contact_id", contactId)
          .limit(1)
          .maybeSingle(),
      ]);
    if (!remainingError && !remaining) return { ok: true };
    if (newReference) return { ok: true };

    const reason =
      contactCleanupError?.message ??
      remainingError?.message ??
      "the new contact could not be removed or proven referenced";
    reportError(new Error(`lead create contact cleanup failed: ${reason}`), {
      tags: { surface: "lead_create_cleanup" },
      extra: { contactId },
    });
    return contactRepairRequired(contactId, reason);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    reportError(error, {
      tags: { surface: "lead_create_cleanup" },
      extra: { contactId },
    });
    return contactRepairRequired(contactId, reason);
  }
}

function contactRepairRequired(
  contactId: string,
  reason: string,
): { ok: false; error: CreateLeadError } {
  return {
    ok: false,
    error: {
      code: "REPAIR_REQUIRED",
      message: `Lead creation left contact ${contactId} in an uncertain state. Do not retry until this record is repaired. (${reason})`,
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
  orgId: string,
  contact: ContactIdentity,
): Promise<{ id: string | null; phoneUnverified: boolean; created: boolean }> {
  const existingContact = await findExistingContact(supabase, orgId, contact);
  if (existingContact) {
    if (existingContact.matchedBy === "phone") {
      return {
        id: existingContact.id,
        phoneUnverified: existingContact.matchedPhoneType === "unknown",
        created: false,
      };
    }
    if (!contact.phone_1) {
      return { id: existingContact.id, phoneUnverified: false, created: false };
    }

    const classification = await classifyLeadPhone(contact.phone_1);
    if (classification.lineType === "unknown") {
      await saveUnverifiedLeadPhone(
        supabase,
        orgId,
        contact,
        existingContact.id,
      );
      return { id: existingContact.id, phoneUnverified: true, created: false };
    }
    await appendVerifiedPhone(
      supabase,
      orgId,
      existingContact.id,
      contact.phone_1,
      classification.lineType,
    );
    return { id: existingContact.id, phoneUnverified: false, created: false };
  }

  const classification = contact.phone_1
    ? await classifyLeadPhone(contact.phone_1)
    : null;
  if (contact.phone_1 && classification?.lineType === "unknown") {
    const contactId = await saveUnverifiedLeadPhone(
      supabase,
      orgId,
      contact,
      null,
    );
    return { id: contactId, phoneUnverified: true, created: true };
  }

  const phoneType = classification?.lineType ?? "unknown";
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_type: "person",
      first_name: contact.first_name,
      last_name: contact.last_name,
      phone_1: contact.phone_1,
      phone_1_type: phoneType,
      email: contact.email,
      notes: null,
    })
    .select("id")
    .single();
  if (error) {
    // A second request can create the same dedup identity after our lookup.
    // Re-read after a unique conflict and mark it reused; only rows created
    // by this request may ever enter compensating cleanup.
    if (error.code === "23505") {
      const racedContact = await findExistingContact(supabase, orgId, contact);
      if (racedContact) {
        return {
          id: racedContact.id,
          phoneUnverified:
            racedContact.matchedBy === "phone" &&
            racedContact.matchedPhoneType === "unknown",
          created: false,
        };
      }
    }
    throw new Error(`contact insert: ${error.message}`);
  }
  return { id: data.id, phoneUnverified: false, created: true };
}

type ContactIdentity = {
  first_name: string | null;
  last_name: string | null;
  phone_1: string | null;
  email: string | null;
};

type ExistingContactMatch = {
  id: string;
  matchedBy: "phone" | "email" | "name";
  matchedPhoneType: PhoneLineType | null;
};

type LeadPhoneClassification = {
  lineType: PhoneLineType;
  status: TelnyxLookupOutcome["status"] | "unavailable";
  reason: TelnyxLookupOutcome["reason"] | "configuration_missing";
  httpStatus: number | null;
};

async function classifyLeadPhone(
  phone: string,
): Promise<LeadPhoneClassification> {
  let result: LeadPhoneClassification;
  try {
    result = await telnyxLookupFromEnv().classifyOne(
      phone,
      AbortSignal.timeout(LEAD_PHONE_LOOKUP_TIMEOUT_MS),
    );
  } catch (error) {
    result = {
      lineType: "unknown",
      status: "unavailable",
      reason:
        error instanceof ConfigurationError
          ? "configuration_missing"
          : "transport_unknown",
      httpStatus: null,
    };
  }

  if (result.lineType === "unknown") {
    reportError(new Error("lead phone line type unverified at intake"), {
      tags: {
        surface: "lead_create_phone_unverified",
        lookup_status: result.status,
        lookup_reason: result.reason,
      },
      extra: { httpStatus: result.httpStatus },
    });
  }
  return result;
}

async function saveUnverifiedLeadPhone(
  supabase: SupabaseClient<Database>,
  orgId: string,
  contact: ContactIdentity,
  contactId: string | null,
): Promise<string> {
  const { data, error } = await supabase
    .rpc("save_unverified_lead_phone", {
      p_org_id: orgId,
      p_phone: contact.phone_1!,
      p_contact_id: contactId,
      p_first_name: contact.first_name,
      p_last_name: contact.last_name,
      p_email: contact.email,
    })
    .single();
  if (error || !data) {
    if (error?.code === "23505") {
      const racedContact = await findExistingContact(supabase, orgId, contact);
      if (racedContact?.matchedBy === "phone") return racedContact.id;
    }
    throw new Error(
      `unverified phone save: ${error?.message ?? "no result returned"}`,
    );
  }
  if (data.outcome === "no_open_phone_slot") {
    throw new Error(
      "This contact already has three phone numbers. Remove one before adding another.",
    );
  }
  return data.contact_id;
}

async function appendVerifiedPhone(
  supabase: SupabaseClient<Database>,
  orgId: string,
  contactId: string,
  phone: string,
  phoneType: Exclude<PhoneLineType, "unknown">,
): Promise<void> {
  const [
    { data: contact, error: contactError },
    { data: lockedProperty, error: lockError },
  ] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, phone_1, phone_2, phone_3, do_not_contact")
      .eq("org_id", orgId)
      .eq("id", contactId)
      .maybeSingle(),
    supabase
      .from("properties")
      .select("id")
      .eq("org_id", orgId)
      .eq("homeowner_contact_id", contactId)
      .eq("is_dnc_locked", true)
      .limit(1)
      .maybeSingle(),
  ]);
  if (contactError || !contact) {
    throw new Error(
      `contact phone append: ${contactError?.message ?? "contact not found"}`,
    );
  }
  if (lockError) throw new Error(`contact DNC check: ${lockError.message}`);
  if (contact.do_not_contact || lockedProperty) {
    throw new Error(
      "This contact is locked by do-not-call rules. The new phone was not added.",
    );
  }
  if (
    phone === contact.phone_1 ||
    phone === contact.phone_2 ||
    phone === contact.phone_3
  ) {
    return;
  }

  const slot =
    contact.phone_1 === null
      ? 1
      : contact.phone_2 === null
        ? 2
        : contact.phone_3 === null
          ? 3
          : null;
  if (slot === null) {
    throw new Error(
      "This contact already has three phone numbers. Remove one before adding another.",
    );
  }
  const phoneColumn = `phone_${slot}` as "phone_1" | "phone_2" | "phone_3";
  const typeColumn = `${phoneColumn}_type` as
    "phone_1_type" | "phone_2_type" | "phone_3_type";
  const updateRow: Database["public"]["Tables"]["contacts"]["Update"] = {
    [phoneColumn]: phone,
    [typeColumn]: phoneType,
  };
  const { data: updated, error: updateError } = await supabase
    .from("contacts")
    .update(updateRow)
    .eq("org_id", orgId)
    .eq("id", contactId)
    .is(phoneColumn, null)
    .select("id")
    .maybeSingle();
  if (updateError)
    throw new Error(`contact phone append: ${updateError.message}`);
  if (!updated) {
    const racedContact = await findExistingContact(supabase, orgId, {
      first_name: null,
      last_name: null,
      phone_1: phone,
      email: null,
    });
    if (racedContact?.id === contactId) return;
    throw new Error(
      "This contact changed while the phone was being saved. Try again.",
    );
  }
}

async function findExistingContact(
  supabase: SupabaseClient<Database>,
  orgId: string,
  contact: ContactIdentity,
): Promise<ExistingContactMatch | null> {
  if (contact.phone_1) {
    const { data, error } = await supabase
      .from("contacts")
      .select(
        "id, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type",
      )
      .eq("org_id", orgId)
      .or(
        `phone_1.eq.${contact.phone_1},phone_2.eq.${contact.phone_1},phone_3.eq.${contact.phone_1}`,
      )
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`contact phone lookup: ${error.message}`);
    if (data) {
      const matchedPhoneType =
        data.phone_1 === contact.phone_1
          ? asLineType(data.phone_1_type)
          : data.phone_2 === contact.phone_1
            ? asLineType(data.phone_2_type)
            : asLineType(data.phone_3_type);
      return { id: data.id, matchedBy: "phone", matchedPhoneType };
    }
  }
  if (contact.email) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .ilike("email", contact.email)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`contact email lookup: ${error.message}`);
    if (data)
      return { id: data.id, matchedBy: "email", matchedPhoneType: null };
  }
  if (
    !contact.phone_1 &&
    !contact.email &&
    contact.first_name &&
    contact.last_name
  ) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .ilike("first_name", contact.first_name)
      .ilike("last_name", contact.last_name)
      .eq("contact_type", "person")
      .is("phone_1", null)
      .is("email", null)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`contact name lookup: ${error.message}`);
    if (data) return { id: data.id, matchedBy: "name", matchedPhoneType: null };
  }
  return null;
}
