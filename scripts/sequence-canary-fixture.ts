import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";
import { shouldSuppressAutomatedSend } from "../src/lib/messaging/suppression";

export const RECEIVER_NUMBER = "+13107540662";
export const SENDILLO_SENDER = "+18164876899";
export const FIXTURE_ADDRESS = "E2E PROD SMOKE — permanent sequence canary — NOT A PROSPECT";
export const VERIFICATION_CONTACT_PREFIX = "d158a56c";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type FixtureIds = { userId: string; propertyId: string; contactId: string };

export function assertFreshCanaryFixture(
  contacts: readonly { id: string; first_name?: string | null; last_name?: string | null }[],
  properties: readonly { id: string }[],
  namedContacts: readonly { id: string }[] = [],
  verificationContactId?: string,
): void {
  if (properties.length) throw new Error("Existing property matches canary address; fresh creation required");
  if (namedContacts.length || contacts.some((row) => row.first_name === "Sequence" && row.last_name === "Canary")) {
    throw new Error("Existing canary-created contact; fresh creation required");
  }
  if (contacts.length && (!verificationContactId || !UUID.test(verificationContactId) ||
      !verificationContactId.startsWith(VERIFICATION_CONTACT_PREFIX))) {
    throw new Error("Full 09-26 verification contact ID is required");
  }
  if (contacts.some((row) => row.id !== verificationContactId)) {
    throw new Error("Unexpected contact on receiver number; fresh creation required");
  }
}

export function assertCanaryReceipt(row: {
  id: string; body: string | null; to_address: string | null; from_address: string | null;
  provider: string | null; external_id: string | null; status: string; sent_at: string | null; delivered_at: string | null;
}, sentBody: string): string {
  if (row.body !== sentBody || row.to_address !== RECEIVER_NUMBER || row.from_address !== SENDILLO_SENDER ||
      row.provider !== "sendillo" || !row.external_id?.trim() || row.status !== "delivered" ||
      !row.sent_at || !row.delivered_at) throw new Error(`Canary message ${row.id} failed delivery proof`);
  return row.id;
}
export function assertDeliveryWebhook(row: {
  id: string; provider: string; external_id: string; event_type: string;
  signature_verified: boolean; processing_status: string;
}, externalId: string): string {
  if (row.provider !== "sendillo" || row.external_id !== externalId || row.event_type !== "sms_status_delivered" ||
      row.signature_verified !== true || row.processing_status !== "processed") {
    throw new Error(`Canary webhook ${row.id} failed delivery proof`);
  }
  return row.id;
}
export function fixtureIds(env: Record<string, string | undefined>): FixtureIds {
  const ids = { userId: env.SEQUENCE_CANARY_USER_ID, propertyId: env.SEQUENCE_CANARY_PROPERTY_ID, contactId: env.SEQUENCE_CANARY_CONTACT_ID };
  for (const [name, value] of Object.entries(ids)) if (!value || !UUID.test(value)) throw new Error(`Invalid canary ${name} UUID`);
  return ids as FixtureIds;
}
export function assertCentralSendWindow(now: Date): void {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const day = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  if (!day || ["Sat", "Sun"].includes(day) || hour < 8 || hour >= 20) throw new Error("Outside Mon–Fri 08:00–20:00 Central send window");
}
/** Fail-closed send eligibility gate, before enrollment and before dispatch. */
export async function preflightFixture(client: SupabaseClient<Database>, ids: FixtureIds, now = new Date()): Promise<string> {
  for (const [name, value] of Object.entries(ids)) if (!UUID.test(value)) throw new Error(`Invalid canary ${name} UUID`);
  assertCentralSendWindow(now);
  const { data: auth, error: authError } = await client.auth.admin.getUserById(ids.userId);
  if (authError || !auth?.user) throw new Error(`Canary user missing: ${authError?.message ?? ids.userId}`);
  const { data: property, error: propertyError } = await client.from("properties")
    .select("id,org_id,homeowner_contact_id,address,state,ai_responder_disabled,skip_trace_disabled,outreach_dispo,is_dnc_locked,is_training,status,deleted_at")
    .eq("id", ids.propertyId).maybeSingle();
  if (propertyError || !property) throw new Error(`Canary property missing: ${propertyError?.message ?? ids.propertyId}`);
  const { data: organization, error: orgError } = await client.from("organizations").select("id").eq("id", property.org_id).maybeSingle();
  if (orgError || !organization) throw new Error("Canary organization missing");
  const { data: contact, error: contactError } = await client.from("contacts")
    .select("id,org_id,first_name,last_name,phone_1,phone_1_type,phone_2,phone_3,do_not_contact,sms_opted_out")
    .eq("id", ids.contactId).maybeSingle();
  if (contactError || !contact) throw new Error(`Canary contact missing: ${contactError?.message ?? ids.contactId}`);
  if (property.org_id !== contact.org_id || property.homeowner_contact_id !== ids.contactId ||
      property.address !== FIXTURE_ADDRESS || property.is_dnc_locked || property.is_training || property.deleted_at ||
      property.status !== "new_lead" || property.state !== "MO" || !property.ai_responder_disabled || !property.skip_trace_disabled ||
      shouldSuppressAutomatedSend({ outreachDispo: property.outreach_dispo }) ||
      contact.first_name !== "Sequence" || contact.last_name !== "Canary" ||
      contact.phone_1 !== RECEIVER_NUMBER || contact.phone_1_type !== "mobile" ||
      contact.phone_2 !== null || contact.phone_3 !== null || contact.do_not_contact || contact.sms_opted_out) {
    throw new Error("Canary fixture identity, org, status, or send eligibility mismatch");
  }
  const { data: suppressions, error: suppressionError } = await client.from("sms_phone_suppressions")
    .select("id").eq("org_id", property.org_id).eq("channel", "sms").eq("phone_e164", RECEIVER_NUMBER);
  if (suppressionError || !suppressions || suppressions.length) throw new Error("Canary receiver suppression lookup failed or phone suppressed");
  const { data: consent, error: consentError } = await client.from("consent_events")
    .select("id,event_type").eq("org_id", property.org_id).eq("contact_id", ids.contactId)
    .eq("channel", "sms").order("occurred_at", { ascending: false }).limit(1);
  if (consentError || !consent?.length || !["opt_in_marketing_written", "opt_in_marketing_verbal"].includes(consent[0].event_type)) {
    throw new Error(`Canary SMS consent missing or revoked: ${consentError?.message ?? ids.contactId}`);
  }
  for (const column of ["homeowner_contact_id", "agent_contact_id"] as const) {
    const { data: related, error } = await client.from("properties").select("id").eq(column, ids.contactId);
    if (error || !related || related.some((row) => row.id !== ids.propertyId)) throw new Error("Canary contact has another property relationship or lookup failed");
  }
  const { data: linked, error: linkedError } = await client.from("property_contacts").select("property_id").eq("contact_id", ids.contactId);
  if (linkedError || !linked || linked.some((row) => row.property_id !== ids.propertyId)) {
    throw new Error("Canary contact has another property relationship or lookup failed");
  }
  return property.org_id;
}

/** Called at the last local boundary before either immediate or queued provider dispatch. */
export async function assertCanaryDispatchEligibility(
  client: SupabaseClient<Database>,
  input: { propertyId: string | null; contactId: string | null; to: string | null; from: string | null; provider: string; body: string },
): Promise<void> {
  if (!input.propertyId || (!input.body.includes("PROD-SMOKE") && input.propertyId !== process.env.SEQUENCE_CANARY_PROPERTY_ID)) return;
  const { data: property, error } = await client.from("properties").select("address").eq("id", input.propertyId).maybeSingle();
  if (error) throw new Error(`Canary dispatch property lookup failed: ${error.message}`);
  if (property?.address !== FIXTURE_ADDRESS) throw new Error("Canary dispatch fixture marker mismatch");
  const userId = process.env.SEQUENCE_CANARY_USER_ID;
  if (!userId || !UUID.test(userId) || input.contactId !== process.env.SEQUENCE_CANARY_CONTACT_ID ||
      input.propertyId !== process.env.SEQUENCE_CANARY_PROPERTY_ID ||
      input.to !== RECEIVER_NUMBER || input.from !== SENDILLO_SENDER || input.provider !== "sendillo") {
    throw new Error("Canary dispatch identity or Sendillo sender mismatch");
  }
  await preflightFixture(client, { userId, propertyId: input.propertyId, contactId: input.contactId });
}
