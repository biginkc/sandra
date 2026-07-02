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

  it("computes identical KPIs when outbound messages carry different sender numbers", async () => {
    // Dynamic sender selection stamps a per-campaign from_address on
    // outbound rows. The KPI scoreboard aggregates by campaign_id only —
    // mixing senders inside a campaign must not change any number.
    const member = await createUserForOrg(BMH_ORG_ID);
    const campaignId = await insertCampaign(BMH_ORG_ID, {
      sender_provider: "mock",
      sender_number: "+15551234567",
    });

    const contactA = await insertContact(BMH_ORG_ID, "SenderA");
    const contactB = await insertContact(BMH_ORG_ID, "SenderB");
    const propertyA = await insertProperty(BMH_ORG_ID, contactA);
    const propertyB = await insertProperty(BMH_ORG_ID, contactB);

    await Promise.all([
      insertCampaignRecipient({ campaignId, propertyId: propertyA, contactId: contactA }),
      insertCampaignRecipient({ campaignId, propertyId: propertyB, contactId: contactB }),
    ]);

    // Same campaign, two different senders.
    const outboundA = await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "delivered",
      campaign_id: campaignId,
      property_id: propertyA,
      contact_id: contactA,
      from_address: "+15551234567",
    });
    await insertMessage(BMH_ORG_ID, {
      direction: "outbound",
      status: "delivered",
      campaign_id: campaignId,
      property_id: propertyB,
      contact_id: contactB,
      from_address: "+15559999999",
    });

    await insertMessage(BMH_ORG_ID, {
      direction: "inbound",
      status: "received",
      contact_id: contactA,
      property_id: propertyA,
      attributed_outbound_message_id: outboundA,
      body: "Yes, tell me more",
    });

    const { data, error } = await member.client.rpc("campaign_kpis", {
      p_campaign_id: campaignId,
    });

    expect(error).toBeNull();
    expect(data).toEqual([
      {
        audience: 2,
        attempted: 2,
        delivered: 2,
        delivered_rate: 100,
        failed: 0,
        failed_rate: 0,
        replied: 1,
        reply_rate: 50,
        opted_out: 0,
        opt_out_rate: 0,
      },
    ]);
  });

  it("computes the same KPIs for canonical delivery settings and legacy sender columns", async () => {
    const member = await createUserForOrg(BMH_ORG_ID);
    const legacyCampaignId = await insertCampaign(BMH_ORG_ID, {
      sender_provider: "mock",
      sender_number: "+15551234567",
    });
    const settingsCampaignId = await insertCampaign(BMH_ORG_ID, {
      sender_provider: "mock",
      sender_number: "+15551234567",
    });
    const { error: settingsError } = await serviceClient
      .from("campaign_delivery_settings")
      .insert({
        campaign_id: settingsCampaignId,
        org_id: BMH_ORG_ID,
        provider: "mock",
        sender_number: "+15551234567",
        from_address: "+15551234567",
      } as never);
    expect(settingsError).toBeNull();

    async function seedOutcomes(campaignId: string, label: string) {
      const repliedContact = await insertContact(BMH_ORG_ID, `${label}Reply`);
      const failedContact = await insertContact(BMH_ORG_ID, `${label}Fail`);
      const optOutContact = await insertContact(BMH_ORG_ID, `${label}Stop`);
      const deliveredContact = await insertContact(BMH_ORG_ID, `${label}Delivered`);
      const repliedProperty = await insertProperty(BMH_ORG_ID, repliedContact);
      const failedProperty = await insertProperty(BMH_ORG_ID, failedContact);
      const optOutProperty = await insertProperty(BMH_ORG_ID, optOutContact);
      const deliveredProperty = await insertProperty(BMH_ORG_ID, deliveredContact);

      await Promise.all([
        insertCampaignRecipient({ campaignId, propertyId: repliedProperty, contactId: repliedContact }),
        insertCampaignRecipient({ campaignId, propertyId: failedProperty, contactId: failedContact }),
        insertCampaignRecipient({ campaignId, propertyId: optOutProperty, contactId: optOutContact }),
        insertCampaignRecipient({ campaignId, propertyId: deliveredProperty, contactId: deliveredContact }),
      ]);

      const repliedOutbound = await insertMessage(BMH_ORG_ID, {
        direction: "outbound",
        status: "delivered",
        campaign_id: campaignId,
        property_id: repliedProperty,
        contact_id: repliedContact,
        from_address: "+15551234567",
      });
      await insertMessage(BMH_ORG_ID, {
        direction: "outbound",
        status: "failed",
        campaign_id: campaignId,
        property_id: failedProperty,
        contact_id: failedContact,
        from_address: "+15551234567",
      });
      const optOutOutbound = await insertMessage(BMH_ORG_ID, {
        direction: "outbound",
        status: "delivered",
        campaign_id: campaignId,
        property_id: optOutProperty,
        contact_id: optOutContact,
        from_address: "+15551234567",
      });
      await insertMessage(BMH_ORG_ID, {
        direction: "outbound",
        status: "delivered",
        campaign_id: campaignId,
        property_id: deliveredProperty,
        contact_id: deliveredContact,
        from_address: "+15551234567",
      });
      await insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: repliedContact,
        property_id: repliedProperty,
        attributed_outbound_message_id: repliedOutbound,
        body: "Yes",
      });
      await insertMessage(BMH_ORG_ID, {
        direction: "inbound",
        status: "received",
        contact_id: optOutContact,
        property_id: optOutProperty,
        attributed_outbound_message_id: optOutOutbound,
        body: "STOP",
        metadata: { keyword: "stop" },
      });
    }

    await seedOutcomes(legacyCampaignId, "Legacy");
    await seedOutcomes(settingsCampaignId, "Settings");

    const { data: legacyData, error: legacyError } = await member.client.rpc(
      "campaign_kpis",
      { p_campaign_id: legacyCampaignId },
    );
    const { data: settingsData, error: dynamicError } = await member.client.rpc(
      "campaign_kpis",
      { p_campaign_id: settingsCampaignId },
    );

    expect(legacyError).toBeNull();
    expect(dynamicError).toBeNull();
    expect(settingsData).toEqual(legacyData);
    expect(settingsData).toEqual([
      {
        audience: 4,
        attempted: 4,
        delivered: 3,
        delivered_rate: 75,
        failed: 1,
        failed_rate: 25,
        replied: 1,
        reply_rate: 25,
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
