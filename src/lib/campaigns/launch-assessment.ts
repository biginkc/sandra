import { normalizePhone } from "@/lib/csv/normalize";
import { classifySmsPhoneAvailability, selectBestSmsPhone, type SmsPhoneContact } from "@/lib/messaging/sms-phone";
import { evaluateAutomatedSuppression } from "@/lib/messaging/suppression";

export type PreviewContact = SmsPhoneContact & { do_not_contact: boolean; sms_opted_out: boolean };
export type PreviewProperty = { org_id: string; outreach_dispo: string | null; is_dnc_locked: boolean; deleted_at: string | null };

/** Read-only estimate using the sender's suppression policy. Each relationship
 * has exactly one outcome; only eligible destinations are deduplicated. */
export function assessCampaignLaunch(input: {
  rows: { propertyId: string; contactId: string | null }[];
  contacts: Map<string, PreviewContact>;
  properties: Map<string, PreviewProperty>;
  optedOut: Set<string>;
  suppressedPhonesByOrg: Map<string, Set<string>>;
  priorSuccessful: Set<string>;
  skipIfContacted: boolean;
}) {
  const counts = { recipientCount: input.rows.length, estimatedQueueableCount: 0,
    successfulPriorContactCount: 0, missingContactCount: 0, landlineCount: 0,
    unknownLineTypeCount: 0, optedOutCount: 0, dncCount: 0,
    propertySuppressedCount: 0, phoneSuppressedCount: 0, duplicateDestinationCount: 0 };
  const destinations = new Set<string>();
  for (const row of input.rows) {
    const property = input.properties.get(row.propertyId);
    const contact = row.contactId ? input.contacts.get(row.contactId) : undefined;
    if (!property || property.deleted_at || property.is_dnc_locked) { counts.propertySuppressedCount++; continue; }
    if (!contact || !row.contactId) { counts.missingContactCount++; continue; }
    const suppression = evaluateAutomatedSuppression({
      outreachDispo: property.outreach_dispo, doNotContact: contact.do_not_contact,
      smsOptedOut: contact.sms_opted_out,
      consentState: input.optedOut.has(row.contactId) ? "opted_out" : null,
    });
    if (suppression.suppressed) {
      if (suppression.source === "do_not_contact") counts.dncCount++;
      else if (suppression.source === "sms_opted_out" || suppression.source === "consent_state") counts.optedOutCount++;
      else counts.propertySuppressedCount++;
      continue;
    }
    const phone = normalizePhone(selectBestSmsPhone(contact)?.phone);
    if (phone && input.suppressedPhonesByOrg.get(property.org_id)?.has(phone)) { counts.phoneSuppressedCount++; continue; }
    if (input.skipIfContacted && input.priorSuccessful.has(row.propertyId)) { counts.successfulPriorContactCount++; continue; }
    const lineType = classifySmsPhoneAvailability(contact);
    if (!phone || lineType === "none") { counts.missingContactCount++; continue; }
    if (lineType === "landline") { counts.landlineCount++; continue; }
    if (lineType === "unknown") { counts.unknownLineTypeCount++; continue; }
    const key = `${property.org_id}:${phone}`;
    if (destinations.has(key)) { counts.duplicateDestinationCount++; continue; }
    destinations.add(key);
    counts.estimatedQueueableCount++;
  }
  return counts;
}
