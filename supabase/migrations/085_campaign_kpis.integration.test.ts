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
  it("classifies campaign KPI replies and opt-outs with contact-based rates", async () => {
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
    const contactF = await insertContact(BMH_ORG_ID, "F");
    const contactG = await insertContact(BMH_ORG_ID, "G");

    const propertyA = await insertProperty(BMH_ORG_ID, contactA);
    const propertyA2 = await insertProperty(BMH_ORG_ID, contactA);
    const propertyB = await insertProperty(BMH_ORG_ID, contactB);
    const propertyC = await insertProperty(BMH_ORG_ID, contactC);
    const propertyD = await insertProperty(BMH_ORG_ID, contactD);
    const propertyE = await insertProperty(BMH_ORG_ID, contactE);
    const propertyF = await insertProperty(BMH_ORG_ID, contactF);
    const propertyG = await insertProperty(BMH_ORG_ID, contactG);

    await Promise.all([
      insertCampaignRecipient({ campaignId, propertyId: propertyA, contactId: contactA }),
      insertCampaignRecipient({ campaignId, propertyId: propertyA2, contactId: contactA }),
      insertCampaignRecipient({ campaignId, propertyId: propertyB, contactId: contactB }),
      insertCampaignRecipient({ campaignId, propertyId: propertyC, contactId: contactC }),
      insertCampaignRecipient({ campaignId, propertyId: propertyD, contactId: contactD }),
      insertCampaignRecipient({ campaignId, propertyId: propertyE, contactId: contactE }),
      insertCampaignRecipient({ campaignId, propertyId: propertyF, contactId: contactF }),
    ]);

    const outboundA = await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "delivered",
      campaign_id: campaignId,
      property_id: propertyA,
      contact_id: contactA,
    });
    const outboundA2 = await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "delivered",
      campaign_id: campaignId,
      property_id: propertyA2,
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
    const outboundE = await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "delivered",
      campaign_id: campaignId,
      property_id: propertyE,
      contact_id: contactE,
    });
    const outboundF = await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "delivered",
      campaign_id: campaignId,
      property_id: propertyF,
      contact_id: contactF,
    });
    const otherCampaignOutbound = await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "delivered",
      campaign_id: otherCampaignId,
      property_id: propertyG,
      contact_id: contactG,
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
        property_id: propertyA2,
        attributed_outbound_message_id: outboundA2,
        body: "STOP",
        metadata: { keyword: "stop" },
      }),
      insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: contactB,
        property_id: propertyB,
        attributed_outbound_message_id: outboundB,
        body: "Do not contact me",
        metadata: { keyword: "dnc" },
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
        attributed_outbound_message_id: outboundE,
        body: "wrong number",
        metadata: { keyword: "wrong_number" },
      }),
      insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: contactF,
        property_id: propertyF,
        attributed_outbound_message_id: outboundF,
        body: "Still interested",
      }),
      insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: contactG,
        property_id: propertyG,
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
    const row = data?.[0];
    expect(row?.replied).toBe(1); // Only contactF; STOP/DNC win, HELP/WRONG_NUMBER count as neither.
    expect(row?.opted_out).toBe(2); // contactA STOP + contactB DNC.
    expect(data).toEqual([
      {
        audience: 7,
        attempted: 7,
        delivered: 5,
        delivered_rate: 71.4,
        failed: 1,
        failed_rate: 14.3,
        replied: 1,
        reply_rate: 16.7,
        opted_out: 2,
        opt_out_rate: 33.3,
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
