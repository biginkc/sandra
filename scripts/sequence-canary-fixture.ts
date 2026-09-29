import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";

export const TWILIO_NUMBER = "+18148097074";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FixtureIds = { userId: string; propertyId: string; contactId: string };
export function assertFreshCanaryFixture(contacts: readonly { id: string }[], properties: readonly { id: string }[]): void {
  if (contacts.length) throw new Error("Existing contact matches canary phone; fresh creation required");
  if (properties.length) throw new Error("Existing property matches canary address; fresh creation required");
}

type CanaryReceipt = {
  id: string; body: string; to_number: string; from_number: string;
  provider: string; external_id: string | null; signature_verified: boolean;
};
export function assertCanaryReceipt(row: CanaryReceipt, sentBody: string, expectedSender: string): string {
  if (row.body !== sentBody || row.to_number !== TWILIO_NUMBER || row.from_number !== expectedSender ||
      row.provider !== "twilio" || !row.external_id?.trim() || row.signature_verified !== true) {
    throw new Error(`Canary receipt ${row.id} failed body, receiver, sender, provider SID, or signature verification`);
  }
  return row.id;
}
export function fixtureIds(env: Record<string, string | undefined>): FixtureIds {
  const ids = {
    userId: env.SEQUENCE_CANARY_USER_ID,
    propertyId: env.SEQUENCE_CANARY_PROPERTY_ID,
    contactId: env.SEQUENCE_CANARY_CONTACT_ID,
  };
  for (const [name, value] of Object.entries(ids)) {
    if (!value || !UUID.test(value)) throw new Error(`Invalid canary ${name} UUID`);
  }
  return ids as FixtureIds;
}

/** Read-only gate. Call before any smoke insert or cleanup delete. */
export async function preflightFixture(client: SupabaseClient<Database>, ids: FixtureIds): Promise<string> {
  for (const [name, value] of Object.entries(ids)) {
    if (!UUID.test(value)) throw new Error(`Invalid canary ${name} UUID`);
  }
  const { data: auth, error: authError } = await client.auth.admin.getUserById(ids.userId);
  if (authError || !auth?.user) throw new Error(`Canary user missing: ${authError?.message ?? ids.userId}`);
  const { data: property, error: propertyError } = await client.from("properties")
    .select("id,org_id,homeowner_contact_id,is_dnc_locked,is_training,status,deleted_at")
    .eq("id", ids.propertyId).maybeSingle();
  if (propertyError || !property) throw new Error(`Canary property missing: ${propertyError?.message ?? ids.propertyId}`);
  const { data: contact, error: contactError } = await client.from("contacts")
    .select("id,org_id,phone_1,phone_1_type,phone_2,phone_3,do_not_contact,sms_opted_out")
    .eq("id", ids.contactId).maybeSingle();
  if (contactError || !contact) throw new Error(`Canary contact missing: ${contactError?.message ?? ids.contactId}`);
  if (property.org_id !== contact.org_id || property.homeowner_contact_id !== ids.contactId ||
      property.is_dnc_locked || property.is_training || property.deleted_at || property.status !== "new_lead" ||
      contact.phone_1 !== TWILIO_NUMBER || contact.phone_1_type !== "mobile" ||
      contact.phone_2 !== null || contact.phone_3 !== null || contact.do_not_contact || contact.sms_opted_out) {
    throw new Error("Canary fixture identity, org, status, or send eligibility mismatch");
  }
  const { data: consent, error: consentError } = await client.from("consent_events")
    .select("id,event_type").eq("org_id", property.org_id).eq("contact_id", ids.contactId)
    .eq("channel", "sms").order("occurred_at", { ascending: false }).limit(1);
  if (consentError || !consent?.length || !["opt_in_marketing_written", "opt_in_marketing_verbal"].includes(consent[0].event_type)) {
    throw new Error(`Canary SMS consent missing or revoked: ${consentError?.message ?? ids.contactId}`);
  }
  for (const column of ["homeowner_contact_id", "agent_contact_id"] as const) {
    const { data: related, error } = await client.from("properties").select("id").eq(column, ids.contactId);
    if (error) throw error;
    if (related?.some((row) => row.id !== ids.propertyId)) throw new Error("Canary contact has another property relationship");
  }
  const { data: linked, error: linkedError } = await client.from("property_contacts")
    .select("property_id").eq("contact_id", ids.contactId);
  if (linkedError) throw linkedError;
  if (linked?.some((row) => row.property_id !== ids.propertyId)) {
    throw new Error("Canary contact has another property relationship");
  }
  return property.org_id;
}
