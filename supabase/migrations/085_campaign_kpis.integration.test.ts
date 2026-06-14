import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";

const serviceClient = createTestClient();
const createdUserIds: string[] = [];

type OrgUser = Awaited<ReturnType<typeof createOrgUser>> & {
  client: ReturnType<typeof clientForUser>;
};

function uniqueEmail(label: string): string {
  return `mig085-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
}

function uniquePhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

async function createUserForOrg(
  orgId: string,
  role: "owner" | "member" = "member",
): Promise<OrgUser> {
  const user = await createOrgUser(serviceClient, {
    orgId,
    email: uniqueEmail(`${orgId.slice(-3)}-${role}`),
    role,
  });
  createdUserIds.push(user.userId);
  return { ...user, client: clientForUser(user.jwt) };
}

async function insertContact(
  orgId = BMH_ORG_ID,
  label = "Campaign",
): Promise<string> {
  const { data, error } = await serviceClient
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_type: "person",
      first_name: label,
      last_name: "Contact",
      phone_1: uniquePhone(),
      phone_1_type: "mobile",
    } as never)
    .select("id")
    .single();
  expect(error).toBeNull();
  expect(data?.id).toBeTruthy();
  return data!.id;
}

async function insertProperty(
  orgId = BMH_ORG_ID,
  contactId?: string,
): Promise<string> {
  const { data, error } = await serviceClient
    .from("properties")
    .insert({
      org_id: orgId,
      address: `085 Campaign ${crypto.randomUUID()}`,
      state: "MO",
      status: "new_lead",
      homeowner_contact_id: contactId ?? null,
    } as never)
    .select("id")
    .single();
  expect(error).toBeNull();
  expect(data?.id).toBeTruthy();
  return data!.id;
}

async function insertCampaign(
  orgId = BMH_ORG_ID,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await serviceClient
    .from("campaigns")
    .insert({
      org_id: orgId,
      name: `Campaign ${crypto.randomUUID()}`,
      ...overrides,
    } as never)
    .select("id")
    .single();
  expect(error).toBeNull();
  expect(data?.id).toBeTruthy();
  return data!.id;
}

async function insertCampaignRecipient(args: {
  campaignId: string;
  propertyId: string;
  contactId?: string | null;
}): Promise<void> {
  const { error } = await serviceClient.from("campaign_recipients").insert({
    campaign_id: args.campaignId,
    property_id: args.propertyId,
    contact_id: args.contactId ?? null,
  } as never);
  expect(error).toBeNull();
}

async function insertMessage(
  orgId = BMH_ORG_ID,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await serviceClient
    .from("messages")
    .insert({
      org_id: orgId,
      channel: "sms",
      direction: "outbound",
      status: "sent",
      body: `085 message ${crypto.randomUUID()}`,
      ...overrides,
    } as never)
    .select("id")
    .single();
  expect(error).toBeNull();
  expect(data?.id).toBeTruthy();
  return data!.id;
}

beforeAll(async () => {
  await seedTwoOrgs(serviceClient);
});

beforeEach(async () => {
  await resetTenantTables(serviceClient);
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
  await resetTenantTables(serviceClient);
});

describe("Migration 085 — campaign KPI scoreboard RPC", () => {
  it("returns deduped counts and rates from attributed campaign traffic", async () => {
    const member = await createUserForOrg(BMH_ORG_ID);
    const campaignId = await insertCampaign();
    const otherCampaignId = await insertCampaign(BMH_ORG_ID, {
      name: `Other ${crypto.randomUUID()}`,
    });

    const contactA = await insertContact(BMH_ORG_ID, "A");
    const contactB = await insertContact(BMH_ORG_ID, "B");
    const contactC = await insertContact(BMH_ORG_ID, "C");
    const contactD = await insertContact(BMH_ORG_ID, "D");
    const contactE = await insertContact(BMH_ORG_ID, "E");

    const propertyA = await insertProperty(BMH_ORG_ID, contactA);
    const propertyB = await insertProperty(BMH_ORG_ID, contactB);
    const propertyC = await insertProperty(BMH_ORG_ID, contactC);
    const propertyD = await insertProperty(BMH_ORG_ID, contactD);
    const propertyE = await insertProperty(BMH_ORG_ID, contactE);

    await Promise.all([
      insertCampaignRecipient({ campaignId, propertyId: propertyA, contactId: contactA }),
      insertCampaignRecipient({ campaignId, propertyId: propertyB, contactId: contactB }),
      insertCampaignRecipient({ campaignId, propertyId: propertyC, contactId: contactC }),
      insertCampaignRecipient({ campaignId, propertyId: propertyD, contactId: contactD }),
      insertCampaignRecipient({ campaignId, propertyId: propertyE, contactId: contactE }),
    ]);

    const outboundA = await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "delivered",
      campaign_id: campaignId,
      property_id: propertyA,
      contact_id: contactA,
    });
    const outboundB = await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "sent",
      campaign_id: campaignId,
      property_id: propertyB,
      contact_id: contactB,
    });
    await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "failed",
      campaign_id: campaignId,
      property_id: propertyC,
      contact_id: contactC,
    });
    const outboundD = await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "delivered",
      campaign_id: campaignId,
      property_id: propertyD,
      contact_id: contactD,
    });
    const otherCampaignOutbound = await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "delivered",
      campaign_id: otherCampaignId,
      property_id: propertyE,
      contact_id: contactE,
    });

    await Promise.all([
      insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: contactA,
        property_id: propertyA,
        attributed_outbound_message_id: outboundA,
        body: "Tell me more",
      }),
      insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: contactA,
        property_id: propertyA,
        attributed_outbound_message_id: outboundA,
        body: "Still interested",
      }),
      insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: contactB,
        property_id: propertyB,
        attributed_outbound_message_id: outboundB,
        body: "STOP",
        metadata: { keyword: "stop" },
      }),
      insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: contactB,
        property_id: propertyB,
        attributed_outbound_message_id: outboundB,
        body: "stop again",
        metadata: { keyword: "stop" },
      }),
      insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: contactD,
        property_id: propertyD,
        attributed_outbound_message_id: outboundD,
        body: "help",
        metadata: { keyword: "help" },
      }),
      insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: contactE,
        property_id: propertyE,
        attributed_outbound_message_id: otherCampaignOutbound,
        body: "wrong campaign",
      }),
      insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: contactC,
        property_id: propertyC,
        attributed_outbound_message_id: null,
        body: "unattributed",
      }),
    ]);

    const { data, error } = await member.client.rpc("campaign_kpis", {
      p_campaign_id: campaignId,
    });

    expect(error).toBeNull();
    expect(data).toEqual([
      {
        audience: 5,
        attempted: 4,
        delivered: 2,
        delivered_rate: 50,
        failed: 1,
        failed_rate: 25,
        replied: 2,
        reply_rate: 50,
        opted_out: 1,
        opt_out_rate: 25,
      },
    ]);
  });

  it("rejects callers outside the campaign org", async () => {
    const outsider = await createUserForOrg(TEST_ORG_B_ID);
    const campaignId = await insertCampaign();

    const { data, error } = await outsider.client.rpc("campaign_kpis", {
      p_campaign_id: campaignId,
    });

    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
    expect(error?.message).toContain("caller is not authorized");
  });
});
