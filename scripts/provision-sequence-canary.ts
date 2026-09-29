#!/usr/bin/env tsx
/** Owner-run, one-time fixture provisioning. Dry-run by default; --apply writes. Never run in CI. */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "../src/lib/supabase/types";
import { TWILIO_NUMBER } from "./sequence-canary-fixture";

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
    .select("id,org_id,first_name,last_name,phone_1_type,do_not_contact,sms_opted_out").eq("phone_1", TWILIO_NUMBER);
  if (contactError) throw contactError;
  if ((contacts?.length ?? 0) > 1 || contacts?.some((c) => c.org_id !== orgId ||
    c.first_name !== "Sequence" || c.last_name !== "Canary" || !c.phone_1_type ||
    c.do_not_contact || c.sms_opted_out)) throw new Error("Phone belongs to a non-fixture or ineligible contact");
  const { data: properties, error: propertyError } = await client.from("properties")
    .select("id,org_id,homeowner_contact_id,is_training,is_dnc_locked,deleted_at,status").eq("address", address).eq("org_id", orgId);
  if (propertyError) throw propertyError;
  if ((properties?.length ?? 0) > 1 || properties?.some((p) => p.is_training || p.is_dnc_locked || p.deleted_at || p.status !== "new_lead" ||
    (contacts?.[0] && p.homeowner_contact_id !== contacts[0].id))) throw new Error("Existing property conflicts with fixture contract");
  if (properties?.length && !contacts?.length) throw new Error("Fixture property exists without expected contact");
  const existingContactId = contacts?.[0]?.id;
  const existingPropertyId = properties?.[0]?.id;
  let hasConsent = false;
  if (existingContactId) {
    const { data: consent, error } = await client.from("consent_events").select("id")
      .eq("org_id", orgId).eq("contact_id", existingContactId).eq("channel", "sms")
      .eq("event_type", "opt_in_marketing_written").limit(1);
    if (error) throw error;
    hasConsent = Boolean(consent?.length);
  }
  console.log(JSON.stringify({ dryRun: !apply, orgId, contactId: existingContactId ?? null,
    propertyId: existingPropertyId ?? null, wouldCreate: {
      contact: !existingContactId, property: !existingPropertyId, consent: !hasConsent,
    } }, null, 2));
  if (!apply) return;
  let contactId = existingContactId;
  if (!contactId) {
    const { data, error } = await client.from("contacts").insert({ org_id: orgId,
      first_name: "Sequence", last_name: "Canary", phone_1: TWILIO_NUMBER, phone_1_type: "mobile" })
      .select("id").single();
    if (error || !data) throw error ?? new Error("Contact insert failed");
    contactId = data.id;
  }
  let propertyId = existingPropertyId;
  if (!propertyId) {
    const { data, error } = await client.from("properties").insert({ org_id: orgId, address,
      state: "MO", status: "new_lead", homeowner_contact_id: contactId, is_training: false })
      .select("id").single();
    if (error || !data) throw error ?? new Error("Property insert failed");
    propertyId = data.id;
  }
  if (!hasConsent) {
    const { error } = await client.from("consent_events").insert({ org_id: orgId, contact_id: contactId,
      channel: "sms", event_type: "opt_in_marketing_written", source: "sequence-canary-provision" });
    if (error) throw error;
  }
  console.log(`SEQUENCE_CANARY_PROPERTY_ID=${propertyId}`);
  console.log(`SEQUENCE_CANARY_CONTACT_ID=${contactId}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
