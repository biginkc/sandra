import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import type { SkipTraceResult } from "./types";

export type PersistOutcome = {
  status: "matched" | "no_match" | "property_not_found";
  contactId?: string;
  phonesAdded: number;
  emailsAdded: number;
  /** True when the provider returned an owner mailing address that
   *  filled at least one previously-empty field on homeowner_details. */
  mailingAddressAdded?: boolean;
};

/**
 * Take a skip-trace result and write it back to the property's
 * `homeowner_contact_id`:
 *   - if no contact exists, create one (with name from the result if
 *     the provider returned it)
 *   - fill `phone_1` if empty, then `phone_2`, then `phone_3`
 *   - dedupe by E.164 — same phone already on this contact won't add
 *     to a second slot
 *   - skip phones flagged DNC at write time (defensive belt; UI/sequence
 *     logic enforces this elsewhere too)
 *   - set `email` if empty
 *
 * Idempotent: re-running with the same result is a no-op.
 */
export async function persistSkipTraceResult(
  supabase: SupabaseClient<Database>,
  result: SkipTraceResult,
): Promise<PersistOutcome> {
  const { data: property } = await supabase
    .from("properties")
    .select("id, org_id, homeowner_contact_id")
    .eq("id", result.propertyId)
    .maybeSingle();

  if (!property) {
    return { status: "property_not_found", phonesAdded: 0, emailsAdded: 0 };
  }

  if (!result.hit || result.persons.length === 0) {
    return {
      status: "no_match",
      contactId: property.homeowner_contact_id ?? undefined,
      phonesAdded: 0,
      emailsAdded: 0,
    };
  }

  // Pick the best person — owner first, then highest-rank phone holder.
  const owner =
    result.persons.find((p) => p.isOwner) ??
    result.persons[0];

  // Resolve / create the contact. Two-phase lookup for the no-existing-
  // contact case: there's a global unique index on contacts.phone_1, so
  // if the owner's top-rank phone already belongs to some contact (a
  // shared owner across multiple properties is common in wholesale —
  // landlords with N rentals), we must REUSE that contact instead of
  // trying to insert a duplicate. Otherwise we hit
  // `contacts_phone_1_key` and lose the row.
  let contactId = property.homeowner_contact_id;
  if (!contactId) {
    const topPhone = owner.phones
      .filter((p) => !!p.number && !p.dnc)
      .sort((a, b) => a.rank - b.rank)[0]?.number;
    if (topPhone) {
      const normalized = normalizePhone(topPhone);
      const { data: existing } = await supabase
        .from("contacts")
        .select("id")
        .eq("org_id", property.org_id)
        .or(
          `phone_1.eq.${normalized},phone_2.eq.${normalized},phone_3.eq.${normalized}`,
        )
        .limit(1)
        .maybeSingle();
      if (existing) {
        contactId = existing.id;
      }
    }
    if (!contactId) {
      const { data: newContact, error: contactErr } = await supabase
        .from("contacts")
        .insert({
          org_id: property.org_id,
          first_name: owner.firstName ?? "",
          last_name: owner.lastName ?? "",
        })
        .select("id")
        .single();
      if (contactErr || !newContact) {
        throw new Error(
          `failed to create contact: ${contactErr?.message ?? "unknown"}`,
        );
      }
      contactId = newContact.id;
    }
    await supabase
      .from("properties")
      .update({ homeowner_contact_id: contactId })
      .eq("id", property.id);
  }

  // Load current contact phones/emails for dedupe + slot picking.
  const { data: currentContact } = await supabase
    .from("contacts")
    .select("phone_1, phone_2, phone_3, email, first_name, last_name")
    .eq("id", contactId)
    .maybeSingle();

  if (!currentContact) {
    return {
      status: "no_match",
      contactId,
      phonesAdded: 0,
      emailsAdded: 0,
    };
  }

  // Build new phone slots.
  const existing = new Set<string>(
    [currentContact.phone_1, currentContact.phone_2, currentContact.phone_3]
      .filter((v): v is string => !!v)
      .map(normalizePhone),
  );

  const slots: (string | null)[] = [
    currentContact.phone_1 ?? null,
    currentContact.phone_2 ?? null,
    currentContact.phone_3 ?? null,
  ];

  // Sort person's phones by rank ascending, then keep non-DNC, non-dup.
  const candidatePhones = owner.phones
    .filter((p) => !!p.number && !p.dnc)
    .sort((a, b) => a.rank - b.rank);

  let phonesAdded = 0;
  for (const phone of candidatePhones) {
    const normalized = normalizePhone(phone.number);
    if (existing.has(normalized)) continue;
    const emptyIdx = slots.findIndex((s) => !s);
    if (emptyIdx === -1) break;
    // Persist the E.164 form (provider-agnostic). Tracerfy returns raw
    // 10-digit strings ("8167416576"); Dialpad outbound + the dedupe
    // index work better with E.164 ("+18167416576").
    slots[emptyIdx] = normalized;
    existing.add(normalized);
    phonesAdded++;
  }

  // Email: take rank-1 if we don't already have one.
  let emailToWrite: string | null = currentContact.email ?? null;
  let emailsAdded = 0;
  if (!emailToWrite && owner.emails.length > 0) {
    const top = [...owner.emails].sort((a, b) => a.rank - b.rank)[0];
    emailToWrite = top.email;
    emailsAdded = 1;
  }

  // Backfill names if missing.
  const updates: Database["public"]["Tables"]["contacts"]["Update"] = {
    phone_1: slots[0],
    phone_2: slots[1],
    phone_3: slots[2],
    email: emailToWrite,
  };
  if (!currentContact.first_name && owner.firstName) {
    updates.first_name = owner.firstName;
  }
  if (!currentContact.last_name && owner.lastName) {
    updates.last_name = owner.lastName;
  }

  const { error: updErr } = await supabase
    .from("contacts")
    .update(updates)
    .eq("id", contactId);
  if (updErr) {
    throw new Error(`contact update failed: ${updErr.message}`);
  }

  // Mailing address upsert. Skip-trace providers often discover the
  // owner's current mailing address as part of the response; capture
  // it into homeowner_details so future direct mail goes to the right
  // place. Only fills empty fields — never overwrites mailing data
  // the original CSV import already carried, which we treat as the
  // source of truth.
  const ownerMailing = owner.mailingAddress ?? result.mailingAddress ?? null;
  const mailingAdded = await upsertOwnerMailing(supabase, {
    contactId,
    mailing: ownerMailing,
  });

  return {
    status: "matched",
    contactId,
    phonesAdded,
    emailsAdded,
    mailingAddressAdded: mailingAdded,
  };
}

/**
 * Upsert homeowner_details with provider-returned mailing fields. Only
 * fills NULL fields on an existing row, preserving CSV-imported values.
 * Inserts a fresh row when the contact has no homeowner_details yet.
 *
 * Returns true when at least one mailing field was newly written.
 */
async function upsertOwnerMailing(
  supabase: SupabaseClient<Database>,
  args: {
    contactId: string;
    mailing: {
      street?: string | null;
      city?: string | null;
      state?: string | null;
      zip?: string | null;
    } | null;
  },
): Promise<boolean> {
  if (!args.mailing) return false;
  const incoming = {
    mailing_address: args.mailing.street?.trim() || null,
    mailing_city: args.mailing.city?.trim() || null,
    mailing_state: args.mailing.state?.trim() || null,
    mailing_zip: args.mailing.zip?.trim() || null,
  };
  // Nothing usable came back.
  if (
    !incoming.mailing_address &&
    !incoming.mailing_city &&
    !incoming.mailing_state &&
    !incoming.mailing_zip
  ) {
    return false;
  }

  const { data: existing } = await supabase
    .from("homeowner_details")
    .select("contact_id, mailing_address, mailing_city, mailing_state, mailing_zip")
    .eq("contact_id", args.contactId)
    .maybeSingle();

  // Compute the merged values: keep whatever's already there, fill blanks.
  const merged = {
    mailing_address: existing?.mailing_address ?? incoming.mailing_address,
    mailing_city: existing?.mailing_city ?? incoming.mailing_city,
    mailing_state: existing?.mailing_state ?? incoming.mailing_state,
    mailing_zip: existing?.mailing_zip ?? incoming.mailing_zip,
  };

  // Did we actually fill any blank?
  const wroteSomething =
    (incoming.mailing_address && !existing?.mailing_address) ||
    (incoming.mailing_city && !existing?.mailing_city) ||
    (incoming.mailing_state && !existing?.mailing_state) ||
    (incoming.mailing_zip && !existing?.mailing_zip);

  if (!wroteSomething && existing) return false;

  await supabase
    .from("homeowner_details")
    .upsert(
      { contact_id: args.contactId, ...merged },
      { onConflict: "contact_id" },
    );

  return !!wroteSomething;
}

/**
 * Convert a raw provider-returned phone string into E.164 format.
 * Strips non-digits (and a leading `+` if present), then:
 *   - 10 digits  → assume US, prepend `+1`
 *   - 11 digits starting with 1 → prepend `+`
 *   - already E.164 (`+...`)    → kept as-is
 *   - anything else             → returned with `+` removed but no
 *                                  guess (caller can decide what to do)
 *
 * Exported so the unit tests + future callers (e.g. wrong-party
 * blocklist matcher) can use it without duplicating the rules.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.replace(/[^\d+]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.length === 10) return `+1${trimmed}`;
  if (trimmed.length === 11 && trimmed.startsWith("1")) return `+${trimmed}`;
  return trimmed;
}
