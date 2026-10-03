import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { createOrgUser, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

// Local-only: needs Postgres at 127.0.0.1:54329 (designation setup) plus the
// local API stack. Run with `vitest run --config vitest.local-integration.config.ts`.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { DISPO_SET: "dispo_set", OPTED_OUT: "opted_out" },
  recordLeadEvent: vi.fn(async () => undefined),
}));

const testClient = createTestClient();
let actorId = "";
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const client = Object.create(testClient) as typeof testClient;
    Object.defineProperty(client, "auth", { value: {
      ...testClient.auth,
      getUser: async () => ({ data: { user: { id: actorId } }, error: null }),
    } });
    return client;
  },
}));

import { setInboxDispoAndStartDrip, setOutreachDispo } from "@/app/(dashboard)/messages/dispo-actions";
import { saveOutreachDispo } from "./outreach-dispo";

async function setAcquisitions(orgId: string, userId: string, enabled: boolean) {
  const url = process.env.TEST_SUPABASE_DB_URL;
  if (!url) throw new Error("Missing TEST_SUPABASE_DB_URL");
  const target = new URL(url);
  if (target.hostname !== "127.0.0.1" || target.port !== "54329") {
    throw new Error("outreach-dispo integration requires local Postgres at 127.0.0.1:54329");
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${userId}:${orgId}:${userId}`]);
    await db.query("update public.memberships set acquisitions_enabled=$3 where user_id=$1 and org_id=$2", [userId, orgId, enabled]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

async function seedProperty(label: string) {
  const { data: contact, error: contactError } = await testClient.from("contacts")
    .insert({ first_name: label, last_name: "Test", phone_1: "+18165550123", phone_1_type: "mobile" })
    .select("id").single();
  if (contactError || !contact) throw contactError ?? new Error("contact seed failed");
  const { data: property, error: propertyError } = await testClient.from("properties")
    .insert({ address: `1 ${label} Ln`, state: "MO", status: "new_lead", homeowner_contact_id: contact.id })
    .select("id").single();
  if (propertyError || !property) throw propertyError ?? new Error("property seed failed");
  return { contactId: contact.id, propertyId: property.id };
}

let orgId = "";
beforeEach(async () => {
  await resetTenantTables(testClient);
  orgId = await getCanonicalTestOrgId(testClient);
  actorId = (await createOrgUser(testClient, {
    orgId, email: `dispo-${randomUUID()}@example.test`, role: "member",
  })).userId;
});

// reset_tenant_tables() cannot re-seed an Acquisitions designation, so always
// leave the acting member un-designated.
afterEach(async () => {
  if (actorId) await setAcquisitions(orgId, actorId, false);
});

describe("server-side Messages workspace gate", () => {
  it("rejects an Acquisitions member on both exported actions and writes nothing", async () => {
    await setAcquisitions(orgId, actorId, true);
    const { propertyId, contactId } = await seedProperty("Gate");
    const { data: sequence } = await testClient.from("sequences")
      .insert({ org_id: orgId, name: `Gate ${randomUUID()}`, active: true }).select("id").single();

    expect(await setOutreachDispo(propertyId, "opted_out"))
      .toEqual({ ok: false, error: "Messages workspace access is unavailable." });
    expect(await setInboxDispoAndStartDrip(propertyId, "needs_sequence", sequence!.id))
      .toEqual({ ok: false, error: "Messages workspace access is unavailable." });

    const { data: property } = await testClient.from("properties")
      .select("outreach_dispo").eq("id", propertyId).single();
    expect(property?.outreach_dispo).toBeNull();
    const { data: contact } = await testClient.from("contacts")
      .select("sms_opted_out").eq("id", contactId).single();
    expect(contact?.sms_opted_out).toBe(false);
    const { data: consent } = await testClient.from("consent_events").select("id").eq("contact_id", contactId);
    expect(consent).toEqual([]);
    const { data: enrollments } = await testClient.from("sequence_enrollments").select("id").eq("property_id", propertyId);
    expect(enrollments).toEqual([]);
  });

  it("still lets the dialer path (shared saver) save for an Acquisitions member", async () => {
    await setAcquisitions(orgId, actorId, true);
    const { propertyId } = await seedProperty("Dialer");

    expect(await saveOutreachDispo(propertyId, "not_interested")).toEqual({ ok: true });

    const { data: property } = await testClient.from("properties")
      .select("outreach_dispo").eq("id", propertyId).single();
    expect(property?.outreach_dispo).toBe("not_interested");
  });
});
