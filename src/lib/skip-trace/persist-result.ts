import type { SupabaseClient } from "@supabase/supabase-js";

import {
  asLineType,
  lineTypeFromVendorLabel,
  type PhoneLineType,
} from "@/lib/messaging/line-type";
import type { Database } from "@/lib/supabase/types";

import type { SkipTraceResult } from "./types";

export type PersistOutcome = {
  status:
    | "matched"
    | "no_match"
    | "property_not_found"
    | "dnc_skipped"
    | "dnc_contact_ambiguous";
  contactId?: string;
  /** Present when provider phones resolved to more than one contact. No
   * property-contact link was guessed; contacts owning DNC-flagged numbers
   * were ratcheted before the fail-closed outcome was returned. */
  ambiguousContactIds?: string[];
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
  orgId: string,
  result: SkipTraceResult,
): Promise<PersistOutcome> {
  const { data: property } = await supabase
    .from("properties")
    .select("id, org_id, homeowner_contact_id, is_dnc_locked")
    .eq("id", result.propertyId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!property) {
    return { status: "property_not_found", phonesAdded: 0, emailsAdded: 0 };
  }
  if (property.is_dnc_locked) {
    return { status: "dnc_skipped", phonesAdded: 0, emailsAdded: 0 };
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
  const owner = result.persons.find((p) => p.isOwner) ?? result.persons[0];
  const hasDncPhone = owner.phones.some((p) => !!p.number && p.dnc);

  // Resolve every provider phone before selecting a contact. Stopping at the
  // first match can silently attach a property to whichever contact happened
  // to own the highest-ranked number while a lower-ranked (possibly DNC)
  // number belongs to somebody else. Lookup failures are fatal because a miss
  // and an unavailable lookup are not interchangeable for identity or DNC.
  const phoneResolution = await resolveContactsByPhone(
    supabase,
    property.org_id,
    owner,
  );
  const resolvedContactIds = new Set(phoneResolution.contactIds);
  if (property.homeowner_contact_id) {
    resolvedContactIds.add(property.homeowner_contact_id);
  }
  if (resolvedContactIds.size > 1) {
    const ambiguousContactIds = [...resolvedContactIds].sort();
    if (!hasDncPhone) {
      throw new Error(
        `contact resolution ambiguous: provider phones map to multiple contacts (${ambiguousContactIds.join(", ")})`,
      );
    }
    // Do not attach the property to an arbitrary contact. Ratchet every
    // contact that actually owns a DNC-flagged number; clean-number matches
    // remain untouched because permanent DNC is irreversible and ambiguity is
    // not evidence that an unrelated clean number is suppressed.
    for (const dncContactId of phoneResolution.dncContactIds) {
      await ratchetContactDnc(supabase, property.org_id, dncContactId);
    }
    return {
      status: "dnc_contact_ambiguous",
      ambiguousContactIds,
      phonesAdded: 0,
      emailsAdded: 0,
    };
  }

  // Resolve / create the contact. Two-phase lookup for the no-existing-
  // contact case: there's a global unique index on contacts.phone_1, so
  // if the owner's top-rank phone already belongs to some contact (a
  // shared owner across multiple properties is common in wholesale —
  // landlords with N rentals), we must REUSE that contact instead of
  // trying to insert a duplicate. Otherwise we hit
  // `contacts_phone_1_key` and lose the row.
  let contactId: string | null =
    property.homeowner_contact_id ?? phoneResolution.contactIds[0] ?? null;
  let createdContactId: string | null = null;
  if (!contactId) {
    contactId =
      // contacts_person_name_key is a partial unique index on
      // (lower(last_name), lower(first_name)) WHERE phone_1 IS NULL AND
      // email IS NULL — a name-only contact (created when a previous
      // property's persist couldn't fill any phone) collides
      // deterministically with every later insert for the same owner
      // (624 rows failed this way on 2026-06-12). Reuse it instead.
      await resolveContactByName(supabase, property.org_id, owner);
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
      if (newContact) {
        contactId = newContact.id;
        createdContactId = newContact.id;
      } else if (isUniqueViolation(contactErr?.message)) {
        // Raced another writer between lookup and insert — re-resolve
        // and reuse whoever won.
        const racedResolution = await resolveContactsByPhone(
          supabase,
          property.org_id,
          owner,
        );
        if (racedResolution.contactIds.length > 1) {
          const ambiguousContactIds = [...racedResolution.contactIds].sort();
          if (hasDncPhone) {
            for (const ambiguousContactId of racedResolution.dncContactIds) {
              await ratchetContactDnc(
                supabase,
                property.org_id,
                ambiguousContactId,
              );
            }
            return {
              status: "dnc_contact_ambiguous",
              ambiguousContactIds,
              phonesAdded: 0,
              emailsAdded: 0,
            };
          }
          throw new Error(
            `contact resolution ambiguous after create race: provider phones map to multiple contacts (${ambiguousContactIds.join(", ")})`,
          );
        }
        contactId =
          racedResolution.contactIds[0] ??
          (await resolveContactByName(supabase, property.org_id, owner));
        if (!contactId) {
          throw new Error(
            `failed to create contact: ${contactErr?.message ?? "unknown"}`,
          );
        }
      } else {
        throw new Error(
          `failed to create contact: ${contactErr?.message ?? "unknown"}`,
        );
      }
    }
  }

  // A phone/name match found for an unlinked property still needs a guarded,
  // positively confirmed link. Creating the contact is only one way to reach
  // this point; do not skip the link merely because resolution reused an
  // existing contact.
  if (!property.homeowner_contact_id) {
    const { data: linked, error: linkError } = await supabase
      .from("properties")
      .update({ homeowner_contact_id: contactId })
      .eq("id", property.id)
      .eq("org_id", property.org_id)
      .eq("is_dnc_locked", false)
      .select("id");
    if (linkError || !linked || linked.length !== 1) {
      const linkFailureMessage = (linkError as { message: string } | null)
        ?.message;
      if (createdContactId) {
        await supabase
          .from("contacts")
          .delete()
          .eq("id", createdContactId)
          .eq("org_id", property.org_id);
      }
      if (isDncLockedError(linkFailureMessage) || !linked?.length) {
        return { status: "dnc_skipped", phonesAdded: 0, emailsAdded: 0 };
      }
      throw new Error(
        `failed to link homeowner contact: ${linkFailureMessage ?? "property link not confirmed"}`,
      );
    }
  }

  // Load current contact phones/emails for dedupe + slot picking.
  const { data: currentContact, error: currentContactError } = await supabase
    .from("contacts")
    .select(
      "phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, email, first_name, last_name, do_not_contact",
    )
    .eq("id", contactId)
    .eq("org_id", property.org_id)
    .maybeSingle();

  if (currentContactError) {
    throw new Error(`contact lookup failed: ${currentContactError.message}`);
  }
  if (!currentContact) {
    throw new Error("contact lookup failed: linked contact not found");
  }
  if (currentContact.do_not_contact) {
    return { status: "dnc_skipped", contactId, phonesAdded: 0, emailsAdded: 0 };
  }

  // A provider DNC signal permanently locks the contact and its linked
  // properties. Ratchet that signal in its own statement: the database guard
  // intentionally rejects a false->true transition that also changes phone,
  // name, email, or organization fields. Once DNC is present, none of the
  // otherwise-clean provider fields below may be persisted.
  if (hasDncPhone) {
    await ratchetContactDnc(supabase, property.org_id, contactId);
    return { status: "dnc_skipped", contactId, phonesAdded: 0, emailsAdded: 0 };
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

  // Provider line-type per normalized number — used both to type newly
  // packed slots and to upgrade pre-existing 'unknown' slots the trace
  // just classified.
  const typeByNumber = new Map<string, PhoneLineType>();
  for (const p of owner.phones) {
    if (!p.number) continue;
    const t = lineTypeFromVendorLabel(p.type);
    if (t !== "unknown") typeByNumber.set(normalizePhone(p.number), t);
  }
  const typeForSlot = (
    number: string | null,
    current: string | null,
  ): PhoneLineType => {
    const known = number ? typeByNumber.get(number) : undefined;
    return known ?? asLineType(current);
  };

  // Mobile-first, then rank ascending; keep non-DNC, non-dup. Everything
  // downstream texts phone_1, so a known mobile must win slot 1 over a
  // lower-rank landline. Unlabeled phones are dropped entirely — the
  // skip-trace hard rule excludes new numbers with type 'unknown'; packing
  // one would make the result unsafe for bulk messaging.
  const candidatePhones = owner.phones
    .filter(
      (p) =>
        !!p.number && !p.dnc && lineTypeFromVendorLabel(p.type) !== "unknown",
    )
    .sort((a, b) => {
      const aMobile = lineTypeFromVendorLabel(a.type) === "mobile";
      const bMobile = lineTypeFromVendorLabel(b.type) === "mobile";
      if (aMobile !== bMobile) return aMobile ? -1 : 1;
      return a.rank - b.rank;
    });

  // Slot packing is re-runnable with a ban list so a phone_1 unique
  // conflict can drop ONLY the conflicting number and keep salvageable
  // lower-ranked ones (rather than reverting every slot wholesale).
  // Persist the E.164 form (provider-agnostic). Tracerfy returns raw
  // 10-digit strings ("8167416576"); Dialpad outbound + the dedupe
  // index work better with E.164 ("+18167416576").
  const bannedPhones = new Set<string>();
  const packSlots = (): { packed: (string | null)[]; added: number } => {
    const packed = [...slots];
    const seen = new Set(existing);
    let added = 0;
    for (const phone of candidatePhones) {
      const normalized = normalizePhone(phone.number);
      if (seen.has(normalized) || bannedPhones.has(normalized)) continue;
      const emptyIdx = packed.findIndex((s) => !s);
      if (emptyIdx === -1) break;
      packed[emptyIdx] = normalized;
      seen.add(normalized);
      added++;
    }
    return { packed, added };
  };
  const currentTypes = [
    currentContact.phone_1_type,
    currentContact.phone_2_type,
    currentContact.phone_3_type,
  ];

  // Derive per-slot types (packing preserves original positions, so
  // index alignment with currentTypes holds), then promote a known
  // mobile into slot 1 when slot 1 holds a landline — packing alone
  // only fills EMPTY slots, so without this a contact that already
  // carries a landline in slot 1 would stay untextable even after the
  // trace finds a mobile. Types travel with their numbers through the
  // swap. Banned numbers (phone_1 unique conflicts) can't be promoted.
  const finalizeSlots = (
    packed: (string | null)[],
  ): { numbers: (string | null)[]; types: PhoneLineType[] } => {
    const numbers = [...packed];
    const types = numbers.map((n, i) => typeForSlot(n, currentTypes[i]));
    if (types[0] === "landline") {
      const j = numbers.findIndex(
        (n, i) => i > 0 && !!n && types[i] === "mobile" && !bannedPhones.has(n),
      );
      if (j > 0) {
        [numbers[0], numbers[j]] = [numbers[j], numbers[0]];
        [types[0], types[j]] = [types[j], types[0]];
      }
    }
    return { numbers, types };
  };

  let { packed: packedSlots, added: phonesAdded } = packSlots();
  let { numbers: slotNumbers, types: slotTypes } = finalizeSlots(packedSlots);

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
    phone_1: slotNumbers[0],
    phone_1_type: slotTypes[0],
    phone_2: slotNumbers[1],
    phone_2_type: slotTypes[1],
    phone_3: slotNumbers[2],
    phone_3_type: slotTypes[2],
    email: emailToWrite,
  };
  if (!currentContact.first_name && owner.firstName) {
    updates.first_name = owner.firstName;
  }
  if (!currentContact.last_name && owner.lastName) {
    updates.last_name = owner.lastName;
  }

  // Apply the update, degrading granularly on unique-index conflicts:
  // phone_1 and lower(email) carry global partial unique indexes, so a
  // number/email that already belongs to ANOTHER contact must not sink
  // the whole write (names + remaining fields still land). A phone
  // conflict bans only the number that landed in phone_1 and re-packs,
  // so salvageable lower-ranked numbers still persist. The conflicting
  // value is reachable via its owning contact; dropping it loses
  // nothing. 38 email-key + 16 phone-key rows failed wholesale this
  // way on 2026-06-12. Attempts are bounded by the ways the update can
  // shrink (one per candidate phone + one for email + one clean pass);
  // exhausting them without a confirmed write is a FAILURE — falling
  // through would report matched for a write that never happened.
  // +3: one per candidate phone, one for email, one clean pass, plus a
  // possible conflict from promoting a PRE-EXISTING slot-2/3 mobile into
  // phone_1 (a number that was never a candidate this run).
  const maxAttempts = candidatePhones.length + 3;
  let updateConfirmed = false;
  let lastUpdateError = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { data: updatedContacts, error: updErr } = await supabase
      .from("contacts")
      .update(updates)
      .eq("id", contactId)
      .eq("org_id", property.org_id)
      .select("id");
    if (!updErr && updatedContacts?.length === 1) {
      updateConfirmed = true;
      break;
    }
    if (!updErr) {
      throw new Error("contact update failed: write was not confirmed");
    }
    lastUpdateError = updErr.message;
    if (isDncLockedError(updErr.message)) {
      return {
        status: "dnc_skipped",
        contactId,
        phonesAdded: 0,
        emailsAdded: 0,
      };
    }
    if (!isUniqueViolation(updErr.message)) {
      throw new Error(`contact update failed: ${updErr.message}`);
    }
    if (updErr.message.includes("contacts_phone_1_key")) {
      const conflicting = updates.phone_1;
      if (typeof conflicting === "string" && conflicting) {
        bannedPhones.add(conflicting);
      }
      const repacked = packSlots();
      packedSlots = repacked.packed;
      phonesAdded = repacked.added;
      ({ numbers: slotNumbers, types: slotTypes } = finalizeSlots(packedSlots));
      updates.phone_1 = slotNumbers[0];
      updates.phone_1_type = slotTypes[0];
      updates.phone_2 = slotNumbers[1];
      updates.phone_2_type = slotTypes[1];
      updates.phone_3 = slotNumbers[2];
      updates.phone_3_type = slotTypes[2];
      continue;
    }
    if (updErr.message.includes("contacts_email_key")) {
      updates.email = currentContact.email ?? null;
      emailsAdded = 0;
      continue;
    }
    throw new Error(`contact update failed: ${updErr.message}`);
  }
  if (!updateConfirmed) {
    throw new Error(
      `contact update failed after ${maxAttempts} degrade attempts: ${lastUpdateError}`,
    );
  }

  // Mailing address upsert. Skip-trace providers often discover the
  // owner's current mailing address as part of the response; capture
  // it into homeowner_details so future direct mail goes to the right
  // place. Only fills empty fields — never overwrites mailing data
  // the original CSV import already carried, which we treat as the
  // source of truth.
  const ownerMailing = owner.mailingAddress ?? result.mailingAddress ?? null;
  let mailingAdded = false;
  try {
    mailingAdded = await upsertOwnerMailing(supabase, {
      contactId,
      orgId: property.org_id,
      mailing: ownerMailing,
    });
  } catch (error) {
    if (
      isDncLockedError(error instanceof Error ? error.message : String(error))
    ) {
      return {
        status: "dnc_skipped",
        contactId,
        phonesAdded: 0,
        emailsAdded: 0,
      };
    }
    throw error;
  }

  return {
    status: "matched",
    contactId,
    phonesAdded,
    emailsAdded,
    mailingAddressAdded: mailingAdded,
  };
}

function isUniqueViolation(message: string | null | undefined): boolean {
  return !!message && message.includes("duplicate key value violates");
}

function isDncLockedError(message: string | null | undefined): boolean {
  return !!message && message.includes("DNC_LOCKED");
}

type OwnerPerson = {
  firstName?: string | null;
  lastName?: string | null;
  phones: Array<{ number: string; dnc: boolean; rank: number }>;
};

/** Find an existing contact in this org holding ANY of the owner's phones,
 *  in any of the contact's 3 slots. Checks every phone the provider
 *  returned, not just the top-ranked one — storage is capped at 3 slots,
 *  but identity matching has no such limit (Codex PR #310 round-4
 *  finding: this previously checked only `owner.phones[0]` by rank, so a
 *  DNC number further down the list — often the ONLY number matching the
 *  existing contact — was never even queried, and Sandra would spin up a
 *  suppressed duplicate while the real contact stayed callable). Includes
 *  DNC-flagged numbers — compliance status must never block identity
 *  matching: a DNC-only skip-trace hit still needs to find + ratchet the
 *  existing contact it's protecting. */
async function resolveContactsByPhone(
  supabase: SupabaseClient<Database>,
  orgId: string,
  owner: OwnerPerson,
): Promise<{ contactIds: string[]; dncContactIds: string[] }> {
  const candidates = new Map<string, boolean>();
  for (const phone of [...owner.phones].sort((a, b) => a.rank - b.rank)) {
    if (!phone.number) continue;
    const normalized = normalizePhone(phone.number);
    candidates.set(
      normalized,
      (candidates.get(normalized) ?? false) || phone.dnc,
    );
  }
  const contactIds = new Set<string>();
  const dncContactIds = new Set<string>();
  for (const [normalized, isDnc] of candidates) {
    const { data: existing, error } = await supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .or(
        `phone_1.eq.${normalized},phone_2.eq.${normalized},phone_3.eq.${normalized}`,
      );
    if (error) {
      throw new Error(
        `contact phone lookup failed for ${normalized}: ${error.message}`,
      );
    }
    for (const contact of existing ?? []) {
      contactIds.add(contact.id);
      if (isDnc) dncContactIds.add(contact.id);
    }
  }
  return {
    contactIds: [...contactIds],
    dncContactIds: [...dncContactIds],
  };
}

/** A DNC transition is successful only when exactly one row is returned, or
 * a follow-up read proves the contact was already DNC. A zero-row update can
 * mean a concurrent delete or stale identity; neither may be reported as a
 * successful compliance ratchet. */
async function ratchetContactDnc(
  supabase: SupabaseClient<Database>,
  orgId: string,
  contactId: string,
): Promise<void> {
  const { data: updated, error } = await supabase
    .from("contacts")
    .update({ do_not_contact: true })
    .eq("id", contactId)
    .eq("org_id", orgId)
    .eq("do_not_contact", false)
    .select("id");
  if (!error && updated?.length === 1) return;
  if (!error && updated && updated.length > 1) {
    throw new Error(
      `contact DNC ratchet failed: expected one row, updated ${updated.length}`,
    );
  }
  if (error && !isDncLockedError(error.message)) {
    throw new Error(`contact DNC ratchet failed: ${error.message}`);
  }

  const { data: current, error: readError } = await supabase
    .from("contacts")
    .select("do_not_contact")
    .eq("id", contactId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readError) {
    throw new Error(`contact DNC ratchet proof failed: ${readError.message}`);
  }
  if (!current) {
    throw new Error(
      "contact DNC ratchet failed: contact disappeared before the write was confirmed",
    );
  }
  if (!current.do_not_contact) {
    throw new Error(
      "contact DNC ratchet failed: zero rows updated and contact remains callable",
    );
  }
}

/** Find an existing NAME-ONLY person contact (no phone, no email) with
 *  the owner's exact name, case-insensitively — the population covered
 *  by the contacts_person_name_key partial unique index. */
async function resolveContactByName(
  supabase: SupabaseClient<Database>,
  orgId: string,
  owner: OwnerPerson,
): Promise<string | null> {
  const first = owner.firstName?.trim();
  const last = owner.lastName?.trim();
  if (!first || !last) return null;
  // ilike without wildcards = case-insensitive equality; escape the
  // pattern chars so a literal % or _ in a name can't widen the match.
  const escape = (v: string) => v.replace(/([%_\\])/g, "\\$1");
  const { data: existing, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("org_id", orgId)
    .eq("contact_type", "person")
    .ilike("first_name", escape(first))
    .ilike("last_name", escape(last))
    .is("phone_1", null)
    .is("email", null)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`contact name lookup failed: ${error.message}`);
  }
  return existing?.id ?? null;
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
    orgId: string;
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

  const { data: existing, error: readError } = await supabase
    .from("homeowner_details")
    .select(
      "contact_id, mailing_address, mailing_city, mailing_state, mailing_zip",
    )
    .eq("contact_id", args.contactId)
    .eq("org_id", args.orgId)
    .maybeSingle();
  if (readError) {
    throw new Error(`homeowner mailing lookup failed: ${readError.message}`);
  }

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

  const { error: writeError } = await supabase
    .from("homeowner_details")
    .upsert(
      { contact_id: args.contactId, org_id: args.orgId, ...merged },
      { onConflict: "contact_id" },
    );
  if (writeError) {
    if (isDncLockedError(writeError.message)) {
      throw new Error(`DNC_LOCKED: homeowner mailing write rejected`);
    }
    throw new Error(`homeowner mailing write failed: ${writeError.message}`);
  }

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
