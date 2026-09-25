#!/usr/bin/env tsx
/**
 * Read-only audience counts for a saved list. This deliberately shares the
 * campaign recipient preference (Assigns contacts, else homeowner) and SMS
 * destination/suppression primitives without exposing recipient data.
 */

import { createAdminClient } from "../src/lib/supabase/admin";
import { normalizePhone } from "../src/lib/csv/normalize";
import { loadSuppressedSmsPhoneSet } from "../src/lib/messaging/phone-suppression-read";
import { selectBestSmsPhone, type SmsPhoneContact } from "../src/lib/messaging/sms-phone";

const CHUNK = 250;
const PAGE = 1_000;

type Options = { listId: string; orgId: string; includeUnknown: boolean };
type Recipient = { propertyId: string; contactId: string | null };
type Contact = SmsPhoneContact & {
  id: string;
  do_not_contact: boolean | null;
  sms_opted_out: boolean | null;
};

function usage(): never {
  throw new Error(
    "Usage: tsx scripts/campaign-audience-preview.ts --list-id <uuid> --org-id <uuid> [--include-unknown]",
  );
}

function parseOptions(argv: string[]): Options {
  let listId = "";
  let orgId = "";
  let includeUnknown = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list-id") listId = argv[++i] ?? "";
    else if (arg === "--org-id") orgId = argv[++i] ?? "";
    else if (arg === "--include-unknown") includeUnknown = true;
    else usage();
  }
  if (!listId || !orgId) usage();
  return { listId, orgId, includeUnknown };
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  const supabase = createAdminClient();
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("id")
    .eq("id", opts.listId)
    .eq("org_id", opts.orgId)
    .maybeSingle();
  if (listError || !list) throw new Error("List was not found in the specified organization.");

  const propertyIds: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("property_lists")
      .select("property_id")
      .eq("list_id", opts.listId)
      .eq("org_id", opts.orgId)
      .order("property_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`list membership read: ${error.message}`);
    propertyIds.push(...(data ?? []).map((row) => row.property_id));
    if ((data ?? []).length < PAGE) break;
  }

  const homeownerByProperty = new Map<string, string | null>();
  const assignsByProperty = new Map<string, Set<string>>();
  for (let i = 0; i < propertyIds.length; i += CHUNK) {
    const chunk = propertyIds.slice(i, i + CHUNK);
    const { data: properties, error: propertiesError } = await supabase
      .from("properties")
      .select("id, homeowner_contact_id")
      .eq("org_id", opts.orgId)
      .in("id", chunk);
    if (propertiesError) throw new Error(`property read: ${propertiesError.message}`);
    properties?.forEach((row) => homeownerByProperty.set(row.id, row.homeowner_contact_id));

    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("property_contacts")
        .select("property_id, contact_id")
        .eq("org_id", opts.orgId)
        .eq("relationship", "assigns_contact")
        .in("property_id", chunk)
        .order("property_id", { ascending: true })
        .order("contact_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Assigns contact read: ${error.message}`);
      data?.forEach((row) => {
        const contacts = assignsByProperty.get(row.property_id) ?? new Set<string>();
        contacts.add(row.contact_id);
        assignsByProperty.set(row.property_id, contacts);
      });
      if ((data ?? []).length < PAGE) break;
    }
  }

  const recipients: Recipient[] = [];
  for (const [propertyId, homeownerId] of homeownerByProperty) {
    const assigns = assignsByProperty.get(propertyId);
    if (assigns?.size) assigns.forEach((contactId) => recipients.push({ propertyId, contactId }));
    else recipients.push({ propertyId, contactId: homeownerId });
  }

  const contactIds = Array.from(new Set(recipients.flatMap((row) => row.contactId ? [row.contactId] : [])));
  const contacts = new Map<string, Contact>();
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out")
      .in("id", contactIds.slice(i, i + CHUNK));
    if (error) throw new Error(`contact read: ${error.message}`);
    (data ?? []).forEach((row) => contacts.set(row.id, row as Contact));
  }

  const mobileRows: Array<{ phone: string; contact: Contact }> = [];
  for (const recipient of recipients) {
    if (!recipient.contactId) continue;
    const contact = contacts.get(recipient.contactId);
    const destination = selectBestSmsPhone(contact);
    if (!contact || !destination) continue;
    if (destination.lineType !== "mobile" && !(opts.includeUnknown && destination.lineType === "unknown")) continue;
    const phone = normalizePhone(destination.phone);
    if (phone) mobileRows.push({ phone, contact });
  }
  const uniquePhones = new Set(mobileRows.map((row) => row.phone));
  const afterContactFlags = new Set(
    mobileRows
      .filter((row) => !row.contact.do_not_contact && !row.contact.sms_opted_out)
      .map((row) => row.phone),
  );
  const suppressed = await loadSuppressedSmsPhoneSet(supabase, afterContactFlags, opts.orgId);
  const afterSuppression = new Set([...afterContactFlags].filter((phone) => !suppressed.has(phone)));

  // Counts only: never emit a phone, person, property, or address.
  console.log(`properties: ${propertyIds.length}`);
  console.log(`recipient rows: ${recipients.length}`);
  console.log(`mobile rows${opts.includeUnknown ? " (including unknown when selected)" : ""}: ${mobileRows.length}`);
  console.log(`unique normalized mobile phones: ${uniquePhones.size}`);
  console.log(`unique after per-contact opt-out flags: ${afterContactFlags.size}`);
  console.log(`unique after org phone suppression: ${afterSuppression.size}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
