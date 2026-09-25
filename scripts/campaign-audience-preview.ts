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
import { computeConsentState } from "../src/lib/messaging/consent";
import { shouldSuppressAutomatedSend } from "../src/lib/messaging/suppression";

const CHUNK = 250;
const PAGE = 1_000;

type Options = { listId: string; jobId: string; orgId: string; includeUnknown: boolean };
type Recipient = { propertyId: string; contactId: string | null };
type Contact = SmsPhoneContact & {
  id: string;
  do_not_contact: boolean | null;
  sms_opted_out: boolean | null;
};

function usage(): never {
  throw new Error(
    "Usage: tsx scripts/campaign-audience-preview.ts (--list-id <uuid> | --job-id <csv-import-job-uuid>) --org-id <uuid> [--include-unknown]",
  );
}

function parseOptions(argv: string[]): Options {
  let listId = "";
  let jobId = "";
  let orgId = "";
  let includeUnknown = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list-id") listId = argv[++i] ?? "";
    else if (arg === "--job-id") jobId = argv[++i] ?? "";
    else if (arg === "--org-id") orgId = argv[++i] ?? "";
    else if (arg === "--include-unknown") includeUnknown = true;
    else usage();
  }
  if ((!listId && !jobId) || (listId && jobId) || !orgId) usage();
  return { listId, jobId, orgId, includeUnknown };
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  const supabase = createAdminClient();
  const propertyIds: string[] = [];
  if (opts.listId) {
    const { data: list, error: listError } = await supabase.from("lists").select("id").eq("id", opts.listId).eq("org_id", opts.orgId).maybeSingle();
    if (listError || !list) throw new Error("List was not found in the specified organization.");
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
  } else {
    const { data: job, error: jobError } = await supabase.from("jobs").select("id").eq("id", opts.jobId).eq("org_id", opts.orgId).eq("type", "csv_import").maybeSingle();
    if (jobError || !job) throw new Error("CSV import job was not found in the specified organization.");
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from("job_items").select("property_id").eq("job_id", opts.jobId).in("status", ["success", "skipped"]).eq("compliance_locked", false).not("property_id", "is", null).order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw new Error(`CSV import cohort read: ${error.message}`);
      propertyIds.push(...(data ?? []).flatMap((row) => row.property_id ? [row.property_id] : []));
      if ((data ?? []).length < PAGE) break;
    }
  }

  const liveProperties = new Map<string, { homeowner_contact_id: string | null; outreach_dispo: string | null }>();
  const homeownerByProperty = new Map<string, string | null>();
  const assignsByProperty = new Map<string, Set<string>>();
  for (let i = 0; i < propertyIds.length; i += CHUNK) {
    const chunk = propertyIds.slice(i, i + CHUNK);
    const { data: properties, error: propertiesError } = await supabase
      .from("properties")
      .select("id, homeowner_contact_id, outreach_dispo")
      .eq("org_id", opts.orgId)
      .is("deleted_at", null).eq("status", "prospect").eq("is_dnc_locked", false)
      .in("id", chunk);
    if (propertiesError) throw new Error(`property read: ${propertiesError.message}`);
    properties?.forEach((row) => { homeownerByProperty.set(row.id, row.homeowner_contact_id); liveProperties.set(row.id, row); });

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

  const consentEventsByContact = new Map<string, Array<{ event_type: string; occurred_at: string }>>();
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const { data, error } = await supabase.from("consent_events").select("contact_id, event_type, occurred_at").eq("channel", "sms").in("contact_id", contactIds.slice(i, i + CHUNK));
    if (error) throw new Error(`consent read: ${error.message}`);
    for (const event of data ?? []) { const events = consentEventsByContact.get(event.contact_id) ?? []; events.push(event); consentEventsByContact.set(event.contact_id, events); }
  }

  const destinationRows: Array<{ phone: string; contact: Contact; outreachDispo: string | null }> = [];
  for (const recipient of recipients) {
    if (!recipient.contactId) continue;
    const contact = contacts.get(recipient.contactId);
    const property = liveProperties.get(recipient.propertyId);
    const destination = selectBestSmsPhone(contact);
    if (!contact || !property || !destination) continue;
    if (destination.lineType !== "mobile" && !(opts.includeUnknown && destination.lineType === "unknown")) continue;
    const phone = normalizePhone(destination.phone);
    if (phone) destinationRows.push({ phone, contact, outreachDispo: property.outreach_dispo });
  }
  const eligibleRows = destinationRows.filter(({ contact, outreachDispo }) => !shouldSuppressAutomatedSend({ outreachDispo, consentState: computeConsentState(consentEventsByContact.get(contact.id) ?? []), doNotContact: contact.do_not_contact, smsOptedOut: contact.sms_opted_out }));
  const eligiblePhones = new Set(eligibleRows.map((row) => row.phone));
  const suppressed = await loadSuppressedSmsPhoneSet(supabase, eligiblePhones, opts.orgId);
  const afterSuppression = new Set([...eligiblePhones].filter((phone) => !suppressed.has(phone)));

  // Counts only: never emit a phone, person, property, or address.
  console.log(`source cohort properties: ${new Set(propertyIds).size}`);
  console.log(`live prospect, non-DNC properties: ${liveProperties.size}`);
  console.log(`recipient rows: ${recipients.length}`);
  console.log(`resolved contacts: ${contacts.size}`);
  console.log(`mobile destination rows${opts.includeUnknown ? " (including unknown when selected)" : ""}: ${destinationRows.length}`);
  console.log(`destination rows after automated suppression gates: ${eligibleRows.length}`);
  console.log(`unique after automated suppression gates: ${eligiblePhones.size}`);
  console.log(`unique after org phone suppression (final audience): ${afterSuppression.size}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
