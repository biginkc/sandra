#!/usr/bin/env tsx
/** Owner-run, one-time fixture provisioning. Dry-run by default; --apply writes. Never run in CI. */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "../src/lib/supabase/types";
import { assertFreshCanaryFixture, TWILIO_NUMBER } from "./sequence-canary-fixture";

const localPath = path.resolve(process.cwd(), ".env.local");
const local: Record<string, string> = {};
if (fs.existsSync(localPath)) for (const line of fs.readFileSync(localPath, "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) local[match[1]] = match[2].replace(/^["']|["']$/g, "");
}
const env = { ...local, ...process.env };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const apply = process.argv.includes("--apply");
const orgId = env.SEQUENCE_CANARY_ORG_ID ?? "";
const userId = env.SEQUENCE_CANARY_USER_ID ?? "";
if (process.env.CI || !env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !UUID.test(orgId) || !UUID.test(userId)) {
  throw new Error("Run outside CI with prod URL, service key, SEQUENCE_CANARY_ORG_ID, and SEQUENCE_CANARY_USER_ID");
}
if (env.NEXT_PUBLIC_SUPABASE_URL.includes("ncsngxlcyxylaeskiteu")) throw new Error("Test project URL refused");
const client = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const address = "E2E PROD SMOKE — permanent sequence canary";

async function main() {
  const { data: auth, error: authError } = await client.auth.admin.getUserById(userId);
  if (authError || !auth?.user) throw new Error(`Canary user missing: ${authError?.message ?? userId}`);
  const { data: organization, error: orgError } = await client.from("organizations").select("id").eq("id", orgId).maybeSingle();
  if (orgError || !organization) throw new Error(`Organization missing: ${orgError?.message ?? orgId}`);
  const { data: contacts, error: contactError } = await client.from("contacts")
    .select("id").or(`phone_1.eq.${TWILIO_NUMBER},phone_2.eq.${TWILIO_NUMBER},phone_3.eq.${TWILIO_NUMBER}`);
  if (contactError) throw contactError;
  const { data: namedContacts, error: namedError } = await client.from("contacts")
    .select("id").eq("first_name", "Sequence").eq("last_name", "Canary");
  if (namedError) throw namedError;
  const matchingContacts = [...new Map([...(contacts ?? []), ...(namedContacts ?? [])].map((row) => [row.id, row])).values()];
  const { data: properties, error: propertyError } = await client.from("properties")
    .select("id").eq("address", address);
  if (propertyError) throw propertyError;
  console.log(JSON.stringify({ dryRun: !apply, orgId, contactId: matchingContacts[0]?.id ?? null,
    propertyId: properties?.[0]?.id ?? null, wouldCreate: {
      contact: !matchingContacts.length, property: !properties?.length, consent: !matchingContacts.length,
    } }, null, 2));
  if (!apply) return;
  assertFreshCanaryFixture(matchingContacts, properties ?? []);
  const { data: contact, error: contactInsertError } = await client.from("contacts").insert({ org_id: orgId,
    first_name: "Sequence", last_name: "Canary", phone_1: TWILIO_NUMBER, phone_1_type: "mobile" })
    .select("id").single();
  if (contactInsertError || !contact) throw contactInsertError ?? new Error("Contact insert failed");
  const contactId = contact.id;
  const { data: property, error: propertyInsertError } = await client.from("properties").insert({ org_id: orgId, address,
    state: "MO", status: "new_lead", homeowner_contact_id: contactId, is_training: false })
    .select("id").single();
  if (propertyInsertError || !property) throw propertyInsertError ?? new Error("Property insert failed");
  const propertyId = property.id;
  const { error: consentInsertError } = await client.from("consent_events").insert({ org_id: orgId, contact_id: contactId,
    channel: "sms", event_type: "opt_in_marketing_written", source: "sequence-canary-provision" });
  if (consentInsertError) throw consentInsertError;
  console.log(`SEQUENCE_CANARY_PROPERTY_ID=${propertyId}`);
  console.log(`SEQUENCE_CANARY_CONTACT_ID=${contactId}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
