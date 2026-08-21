import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import { pausePropertyEnrollments, resumeByProperty } from "@/lib/sequences/enrollment";

const serviceClient = createTestClient();
const createdUserIds: string[] = [];

type RpcResult<T> = {
  data: T | null;
  error: { message: string; code?: string } | null;
};

type BookingRpc = {
  rpc(
    fn: "fn_book_appointment",
    args: {
      p_org: string;
      p_assignee: string;
      p_start: string;
      p_end: string;
      p_timezone: string;
      p_title: string;
      p_contact: string | null;
      p_property: string | null;
      p_description: string | null;
      p_idempotency_key: string | null;
    },
  ): Promise<RpcResult<{ task_id: string; related_property_id: string | null }>>;
};

function asBookingRpc(client: ReturnType<typeof clientForUser>): BookingRpc {
  return client as unknown as BookingRpc;
}

async function seedContactAndProperty(): Promise<{ contactId: string; propertyId: string }> {
  const { data: contact, error: contactError } = await serviceClient
    .from("contacts")
    .insert({
      org_id: BMH_ORG_ID,
      first_name: "Softphone",
      last_name: `Integration ${crypto.randomUUID().slice(0, 8)}`,
      phone_1: `+1816555${Math.floor(Math.random() * 9000 + 1000)}`,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactError || !contact) throw new Error(contactError?.message ?? "contact seed failed");

  const { data: property, error: propertyError } = await serviceClient
    .from("properties")
    .insert({
      org_id: BMH_ORG_ID,
      address: `Softphone Integration ${crypto.randomUUID().slice(0, 8)}`,
      city: "Kansas City",
      state: "MO",
      status: "new_lead",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  if (propertyError || !property) throw new Error(propertyError?.message ?? "property seed failed");

  return { contactId: contact.id, propertyId: property.id };
}

beforeAll(async () => {
  await seedTwoOrgs(serviceClient);
  const user = await createOrgUser(serviceClient, {
    orgId: BMH_ORG_ID,
    email: `softphone-phase1-${Date.now()}@bmhgroupkc.com`,
    role: "member",
  });
  createdUserIds.push(user.userId);
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
  await resetTenantTables(serviceClient);
});

describe("softphone phase 1 database contracts", () => {
  it("writes a manual call activity with nullable lead links", async () => {
    const userId = createdUserIds[0];
    const { data, error } = await serviceClient
      .from("call_activities")
      .insert({
        org_id: BMH_ORG_ID,
        property_id: null,
        contact_id: null,
        jitter_attempt_id: `sandra-${crypto.randomUUID()}`,
        operator_user_id: userId,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_seconds: 12,
        outcome: "connected_human",
        disposition: "not_interested",
        notes: "Manual Phase 1 integration call",
        direction: "outbound",
        provider: "sandra_softphone",
        phone_e164: "+18165550123",
      })
      .select("property_id, contact_id, direction, provider, phone_e164, notes")
      .single();

    expect(error).toBeNull();
    expect(data).toMatchObject({
      property_id: null,
      contact_id: null,
      direction: "outbound",
      provider: "sandra_softphone",
      phone_e164: "+18165550123",
      notes: "Manual Phase 1 integration call",
    });
  });

  it("pauses sequence work for a live call and resumes only that reason on wrap", async () => {
    const { propertyId, contactId } = await seedContactAndProperty();
    const { data: sequence, error: sequenceError } = await serviceClient
      .from("sequences")
      .insert({ org_id: BMH_ORG_ID, name: `Softphone ${crypto.randomUUID().slice(0, 8)}` })
      .select("id")
      .single();
    expect(sequenceError).toBeNull();
    expect(sequence).not.toBeNull();

    const { error: stepError } = await serviceClient.from("sequence_steps").insert({
      sequence_id: sequence!.id,
      step_index: 0,
      action_type: "send_sms",
      template_body: "Call follow-up",
    });
    expect(stepError).toBeNull();

    const { data: enrollment, error: enrollmentError } = await serviceClient
      .from("sequence_enrollments")
      .insert({
        org_id: BMH_ORG_ID,
        sequence_id: sequence!.id,
        property_id: propertyId,
        contact_id: contactId,
        status: "active",
        next_run_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    expect(enrollmentError).toBeNull();
    expect(enrollment).not.toBeNull();

    await expect(
      pausePropertyEnrollments(serviceClient, {
        propertyId,
        reason: "call_in_progress",
      }),
    ).resolves.toMatchObject({ paused: 1 });

    const { data: paused } = await serviceClient
      .from("sequence_enrollments")
      .select("status, pause_reason")
      .eq("id", enrollment!.id)
      .single();
    expect(paused).toEqual({ status: "paused", pause_reason: "call_in_progress" });

    await expect(resumeByProperty(serviceClient, { propertyId })).resolves.toMatchObject({ resumed: 1 });
    const { data: resumed } = await serviceClient
      .from("sequence_enrollments")
      .select("status, pause_reason")
      .eq("id", enrollment!.id)
      .single();
    expect(resumed).toEqual({ status: "active", pause_reason: null });
  });

  it("uses the existing appointment booking RPC for a nurture callback", async () => {
    const userId = createdUserIds[0];
    // The shared fixture creates the authenticated member; retrieve its JWT by
    // creating a second fixture user so this test never relies on an admin JWT
    // or a secret value in the test process.
    const fresh = await createOrgUser(serviceClient, {
      orgId: BMH_ORG_ID,
      email: `softphone-callback-${Date.now()}@bmhgroupkc.com`,
      role: "member",
    });
    createdUserIds.push(fresh.userId);
    const caller = clientForUser(fresh.jwt);
    const { propertyId, contactId } = await seedContactAndProperty();
    const start = new Date(Date.now() + 48 * 60 * 60 * 1000);
    start.setSeconds(0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    const { data, error } = await asBookingRpc(caller).rpc("fn_book_appointment", {
      p_org: BMH_ORG_ID,
      p_assignee: userId,
      p_start: start.toISOString(),
      p_end: end.toISOString(),
      p_timezone: "America/Chicago",
      p_title: "Call back Softphone Integration",
      p_contact: contactId,
      p_property: propertyId,
      p_description: "Callback created from simulated softphone wrap-up",
      p_idempotency_key: crypto.randomUUID(),
    });

    expect(error).toBeNull();
    expect(data).toMatchObject({ task_id: expect.any(String), related_property_id: propertyId });
  });
});
