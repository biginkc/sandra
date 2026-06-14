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

async function expectSelectable(table: string, columns: string): Promise<void> {
  const { error } = await (serviceClient as any)
    .from(table as never)
    .select(columns)
    .limit(0);
  expect(error).toBeNull();
}

function uniqueEmail(label: string): string {
  return `mig084-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
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

async function insertContact(orgId = BMH_ORG_ID): Promise<string> {
  const { data, error } = await serviceClient
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_type: "person",
      first_name: "Campaign",
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
      address: `084 Campaign ${crypto.randomUUID()}`,
      state: "MO",
      status: "new_lead",
      homeowner_contact_id: contactId ?? null,
    })
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
}): Promise<string> {
  const { data, error } = await serviceClient
    .from("campaign_recipients")
    .insert({
      campaign_id: args.campaignId,
      property_id: args.propertyId,
      contact_id: args.contactId ?? null,
    } as never)
    .select("id")
    .single();
  expect(error).toBeNull();
  expect(data?.id).toBeTruthy();
  return data!.id;
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
      body: `084 message ${crypto.randomUUID()}`,
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

describe("Migration 084 — campaigns SMS v1 backbone", () => {
  it("creates the campaigns tables and new message columns", async () => {
    await expectSelectable(
      "campaigns",
      "id, org_id, name, channel, status, audience_snapshot, body, template_category, pace_seconds, skip_if_contacted, description, created_by, created_at, updated_at, archived_at",
    );
    await expectSelectable(
      "campaign_recipients",
      "id, campaign_id, property_id, contact_id, created_at",
    );
    await expectSelectable("messages", "campaign_id, attributed_outbound_message_id");
  });

  it("accepts launching status and one-shot blast content columns", async () => {
    const { data, error } = await serviceClient
      .from("campaigns")
      .insert({
        org_id: BMH_ORG_ID,
        name: "Launch State Campaign",
        status: "launching",
        body: "Hello from the blast",
        template_category: "marketing",
        pace_seconds: 45,
        skip_if_contacted: true,
      } as never)
      .select("status, body, template_category, pace_seconds, skip_if_contacted")
      .single();

    expect(error).toBeNull();
    expect(data).toMatchObject({
      status: "launching",
      body: "Hello from the blast",
      template_category: "marketing",
      pace_seconds: 45,
      skip_if_contacted: true,
    });
  });

  it("enforces case-insensitive campaign-name uniqueness only among active campaigns", async () => {
    const name = "June List";

    const first = await serviceClient
      .from("campaigns")
      .insert({
        org_id: BMH_ORG_ID,
        name,
      } as never)
      .select("id")
      .single();
    const duplicate = await serviceClient.from("campaigns").insert({
      org_id: BMH_ORG_ID,
      name: name.toLowerCase(),
    } as never);
    const otherOrg = await serviceClient.from("campaigns").insert({
      org_id: TEST_ORG_B_ID,
      name: name.toLowerCase(),
    } as never);

    expect(first.error).toBeNull();
    expect(first.data?.id).toBeTruthy();
    expect(duplicate.error?.code).toBe("23505");
    expect(duplicate.error?.message).toContain("idx_campaigns_org_lower_name_unique");
    expect(otherOrg.error).toBeNull();

    const archiveResult = await serviceClient
      .from("campaigns")
      .update({ archived_at: new Date().toISOString() } as never)
      .eq("id", first.data!.id);
    expect(archiveResult.error).toBeNull();

    const reusedName = await serviceClient.from("campaigns").insert({
      org_id: BMH_ORG_ID,
      name: name.toLowerCase(),
    } as never);
    expect(reusedName.error).toBeNull();
  });

  it("rejects a second outbound campaign message for the same property", async () => {
    const contactId = await insertContact();
    const propertyId = await insertProperty(BMH_ORG_ID, contactId);
    const campaignId = await insertCampaign();

    const firstOutbound = await serviceClient.from("messages").insert({
      org_id: BMH_ORG_ID,
      channel: "sms",
      direction: "outbound",
      status: "sent",
      body: "First blast send",
      campaign_id: campaignId,
      property_id: propertyId,
      contact_id: contactId,
    } as never);
    const duplicateOutbound = await serviceClient.from("messages").insert({
      org_id: BMH_ORG_ID,
      channel: "sms",
      direction: "outbound",
      status: "queued",
      body: "Duplicate blast send",
      campaign_id: campaignId,
      property_id: propertyId,
      contact_id: contactId,
    } as never);

    expect(firstOutbound.error).toBeNull();
    expect(duplicateOutbound.error?.code).toBe("23505");
    expect(duplicateOutbound.error?.message).toContain(
      "idx_messages_campaign_property_unique",
    );
  });

  it("preserves campaign history when messages reference it and only SET NULLs attributed outbound links", async () => {
    const contactId = await insertContact();
    const propertyId = await insertProperty(BMH_ORG_ID, contactId);
    const campaignId = await insertCampaign();
    await insertCampaignRecipient({ campaignId, propertyId, contactId });

    const sourceMessageId = await insertMessage(BMH_ORG_ID, {
      contact_id: contactId,
      property_id: propertyId,
    });
    const attributedMessageId = await insertMessage(BMH_ORG_ID, {
      direction: "inbound",
      status: "received",
      contact_id: contactId,
      property_id: propertyId,
      attributed_outbound_message_id: sourceMessageId,
    });
    await insertMessage(BMH_ORG_ID, {
      contact_id: contactId,
      property_id: propertyId,
      campaign_id: campaignId,
    });

    const sourceDelete = await serviceClient
      .from("messages")
      .delete()
      .eq("id", sourceMessageId);
    expect(sourceDelete.error).toBeNull();

    const { data: attributedRow, error: attributedFetchError } = await serviceClient
      .from("messages")
      .select("attributed_outbound_message_id")
      .eq("id", attributedMessageId)
      .single();
    expect(attributedFetchError).toBeNull();
    expect(attributedRow?.attributed_outbound_message_id).toBeNull();

    const campaignDelete = await serviceClient
      .from("campaigns")
      .delete()
      .eq("id", campaignId);
    expect(campaignDelete.error?.code).toBe("23503");
    expect(campaignDelete.error?.message).toMatch(/campaign|foreign key/i);
  });

  it("cascades recipient rows on campaign-only deletes and keeps recipient FKs consistent", async () => {
    const contactId = await insertContact();
    const propertyId = await insertProperty(BMH_ORG_ID, contactId);
    const campaignId = await insertCampaign();
    const recipientId = await insertCampaignRecipient({
      campaignId,
      propertyId,
      contactId,
    });

    const recipientOnlyCampaignDelete = await serviceClient
      .from("campaigns")
      .delete()
      .eq("id", campaignId);
    expect(recipientOnlyCampaignDelete.error).toBeNull();

    const { data: deletedRecipientRows, error: deletedRecipientError } =
      await serviceClient
        .from("campaign_recipients")
        .select("id")
        .eq("id", recipientId);
    expect(deletedRecipientError).toBeNull();
    expect(deletedRecipientRows).toHaveLength(0);

    const campaignId2 = await insertCampaign();
    const contactId2 = await insertContact();
    const propertyId2 = await insertProperty(BMH_ORG_ID, contactId2);
    const recipientId2 = await insertCampaignRecipient({
      campaignId: campaignId2,
      propertyId: propertyId2,
      contactId: contactId2,
    });

    const propertyUnlink = await serviceClient
      .from("properties")
      .update({ homeowner_contact_id: null })
      .eq("id", propertyId2);
    expect(propertyUnlink.error).toBeNull();

    const contactDelete = await serviceClient
      .from("contacts")
      .delete()
      .eq("id", contactId2);
    expect(contactDelete.error).toBeNull();

    const { data: recipientAfterContactDelete, error: recipientContactError } =
      await serviceClient
        .from("campaign_recipients")
        .select("contact_id")
        .eq("id", recipientId2)
        .single();
    expect(recipientContactError).toBeNull();
    expect(recipientAfterContactDelete?.contact_id).toBeNull();

    const propertyDelete = await serviceClient
      .from("properties")
      .delete()
      .eq("id", propertyId2);
    expect(propertyDelete.error).toBeNull();

    const { data: recipientAfterPropertyDelete, error: recipientPropertyError } =
      await serviceClient
        .from("campaign_recipients")
        .select("id")
        .eq("id", recipientId2);
    expect(recipientPropertyError).toBeNull();
    expect(recipientAfterPropertyDelete).toHaveLength(0);
  });

  it("scopes campaigns and recipients by org membership and denies app-user deletes", async () => {
    const bmhUser = await createUserForOrg(BMH_ORG_ID);
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID);
    const contactId = await insertContact();
    const propertyId = await insertProperty(BMH_ORG_ID, contactId);
    const campaignId = await insertCampaign(BMH_ORG_ID, { name: "Scoped Campaign" });

    const { data: ownCampaignRows, error: ownCampaignError } = await bmhUser.client
      .from("campaigns")
      .select("id, org_id")
      .eq("id", campaignId);
    expect(ownCampaignError).toBeNull();
    expect(ownCampaignRows).toHaveLength(1);
    expect(ownCampaignRows?.[0]?.org_id).toBe(BMH_ORG_ID);

    const { data: crossCampaignRows, error: crossCampaignError } = await orgBUser.client
      .from("campaigns")
      .select("id")
      .eq("id", campaignId);
    expect(crossCampaignError).toBeNull();
    expect(crossCampaignRows).toHaveLength(0);

    const blockedCampaignInsert = await orgBUser.client.from("campaigns").insert({
      org_id: BMH_ORG_ID,
      name: "Blocked Cross Org Campaign",
    } as never);
    expect(blockedCampaignInsert.error?.message).toMatch(
      /row-level security|violates row-level/i,
    );

    const ownRecipientInsert = await bmhUser.client
      .from("campaign_recipients")
      .insert({
        campaign_id: campaignId,
        property_id: propertyId,
        contact_id: contactId,
      } as never)
      .select("id")
      .single();
    expect(ownRecipientInsert.error).toBeNull();

    const { data: crossRecipientRows, error: crossRecipientError } = await orgBUser.client
      .from("campaign_recipients")
      .select("id")
      .eq("id", ownRecipientInsert.data!.id);
    expect(crossRecipientError).toBeNull();
    expect(crossRecipientRows).toHaveLength(0);

    const blockedRecipientInsert = await orgBUser.client
      .from("campaign_recipients")
      .insert({
        campaign_id: campaignId,
        property_id: propertyId,
      } as never);
    expect(blockedRecipientInsert.error?.message).toMatch(
      /row-level security|violates row-level/i,
    );

    const deleteAttempt = await bmhUser.client
      .from("campaigns")
      .delete()
      .eq("id", campaignId)
      .select("id");
    if (deleteAttempt.error) {
      expect(deleteAttempt.error.message).toMatch(/row-level security|permission denied/i);
    } else {
      expect(deleteAttempt.data).toHaveLength(0);
    }

    const { data: campaignAfterDeleteAttempt, error: campaignAfterDeleteError } =
      await serviceClient.from("campaigns").select("id").eq("id", campaignId);
    expect(campaignAfterDeleteError).toBeNull();
    expect(campaignAfterDeleteAttempt).toHaveLength(1);
  });
});
