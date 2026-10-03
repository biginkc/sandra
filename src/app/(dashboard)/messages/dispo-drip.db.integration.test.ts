import { beforeEach, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { createOrgUser, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

// Server actions run outside a Next request here; the fixture user is a plain
// (non-Acquisitions) member so it passes assertMessagesWorkspaceAccess().
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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

import { setInboxDispoAndStartDrip } from "./dispo-actions";

beforeEach(async () => {
  await resetTenantTables(testClient);
  const orgId = await getCanonicalTestOrgId(testClient);
  actorId = (await createOrgUser(testClient, {
    orgId, email: `drip-${crypto.randomUUID()}@example.test`, role: "member",
  })).userId;
});

it("saves needs_sequence and creates an active enrollment for the selected drip", async () => {
  const orgId = await getCanonicalTestOrgId(testClient);
  const { data: contact, error: contactError } = await testClient.from("contacts")
    .insert({ first_name: "Drip", last_name: "Test", phone_1: "+18165550123", phone_1_type: "mobile" })
    .select("id").single();
  if (contactError || !contact) throw contactError ?? new Error("contact seed failed");
  const { data: property, error: propertyError } = await testClient.from("properties")
    .insert({ address: "1 Follow Up Ln", state: "MO", status: "new_lead", homeowner_contact_id: contact.id })
    .select("id").single();
  if (propertyError || !property) throw propertyError ?? new Error("property seed failed");
  const { data: sequence, error: sequenceError } = await testClient.from("sequences")
    .insert({ org_id: orgId, name: `Follow up ${crypto.randomUUID()}`, active: true })
    .select("id").single();
  if (sequenceError || !sequence) throw sequenceError ?? new Error("sequence seed failed");
  const { error: stepError } = await testClient.from("sequence_steps").insert({
    sequence_id: sequence.id, step_index: 0, delay_after_previous_minutes: 60,
    action_type: "send_sms", template_body: "Hello there",
  });
  if (stepError) throw stepError;

  const result = await setInboxDispoAndStartDrip(property.id, "needs_sequence", sequence.id);
  expect(result).toMatchObject({ ok: true, enrollment: { status: "enrolled" } });
  const { data: savedProperty } = await testClient.from("properties").select("outreach_dispo")
    .eq("id", property.id).single();
  expect(savedProperty?.outreach_dispo).toBe("needs_sequence");
  const { data: enrollment } = await testClient.from("sequence_enrollments")
    .select("status").eq("property_id", property.id).eq("sequence_id", sequence.id).single();
  expect(enrollment?.status).toBe("active");
});

it.each([
  ["dead", "Dead"],
  ["closed", "Closed"],
  ["offer_sent", "Offer sent"],
  ["under_contract", "Under contract"],
])("saves needs_sequence but does not enroll a %s lead", async (status, label) => {
  const orgId = await getCanonicalTestOrgId(testClient);
  const { data: contact, error: contactError } = await testClient.from("contacts")
    .insert({ first_name: "Drip", last_name: "Refused", phone_1: "+18165550123", phone_1_type: "mobile" })
    .select("id").single();
  if (contactError || !contact) throw contactError ?? new Error("contact seed failed");
  const { data: property, error: propertyError } = await testClient.from("properties")
    .insert({ address: "2 Follow Up Ln", state: "MO", status, homeowner_contact_id: contact.id })
    .select("id").single();
  if (propertyError || !property) throw propertyError ?? new Error("property seed failed");
  const { data: sequence, error: sequenceError } = await testClient.from("sequences")
    .insert({ org_id: orgId, name: `Follow up ${crypto.randomUUID()}`, active: true })
    .select("id").single();
  if (sequenceError || !sequence) throw sequenceError ?? new Error("sequence seed failed");
  const { error: stepError } = await testClient.from("sequence_steps").insert({
    sequence_id: sequence.id, step_index: 0, delay_after_previous_minutes: 60,
    action_type: "send_sms", template_body: "Hello there",
  });
  if (stepError) throw stepError;

  expect(await setInboxDispoAndStartDrip(property.id, "needs_sequence", sequence.id))
    .toEqual({ ok: true, enrollment: { status: "skipped", reason: `This lead is marked ${label}, so a drip can't start.` } });
  const { data: savedProperty } = await testClient.from("properties").select("outreach_dispo")
    .eq("id", property.id).single();
  expect(savedProperty?.outreach_dispo).toBe("needs_sequence");
  const { data: enrollments } = await testClient.from("sequence_enrollments")
    .select("id").eq("property_id", property.id).eq("sequence_id", sequence.id);
  expect(enrollments).toEqual([]);
});
