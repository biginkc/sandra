import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

import { resolveSmsConversationOrg } from "@/lib/messages/threading";

const serviceClient = createTestClient();
const createdUserIds: string[] = [];

beforeEach(async () => {
  await resetTenantTables(serviceClient);
  await seedTwoOrgs(serviceClient);
});

afterEach(async () => {
  for (const userId of createdUserIds.splice(0)) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
});

async function dualOrgMember() {
  const created = await createOrgUser(serviceClient, {
    orgId: BMH_ORG_ID,
    email: `conversation-org-guard-${crypto.randomUUID()}@bmhgroupkc.com`,
    role: "member",
  });
  createdUserIds.push(created.userId);
  const { error } = await serviceClient.from("memberships").insert({
    user_id: created.userId,
    org_id: TEST_ORG_B_ID,
    role: "member",
    access_status: "active",
  });
  if (error) throw new Error(`second membership seed failed: ${error.message}`);
  return clientForUser(created.jwt);
}

function messageRow(args: {
  orgId: string;
  conversationId: string;
  status: string;
  createdAt: string;
}) {
  return {
    org_id: args.orgId,
    channel: "sms" as const,
    direction: "inbound" as const,
    status: args.status,
    conversation_id: args.conversationId,
    contact_id: null,
    property_id: null,
    from_address: "+18165550123",
    to_address: "+18165550456",
    body: "tenant guard fixture",
    created_at: args.createdAt,
  };
}

describe("resolve_sms_conversation_org", () => {
  it("returns the sole active-membership-visible organization", async () => {
    const member = await dualOrgMember();
    const conversationId = crypto.randomUUID();
    const { error } = await serviceClient.from("messages").insert(
      messageRow({
        orgId: BMH_ORG_ID,
        conversationId,
        status: "received",
        createdAt: "2026-08-16T12:00:00Z",
      }),
    );
    expect(error).toBeNull();

    await expect(
      resolveSmsConversationOrg(member, conversationId),
    ).resolves.toBe(BMH_ORG_ID);
  });

  it("rejects an old queued or paused contactless cross-org row beyond 100 newer rows", async () => {
    const member = await dualOrgMember();
    const conversationId = crypto.randomUUID();
    const recent = Array.from({ length: 101 }, (_, index) =>
      messageRow({
        orgId: BMH_ORG_ID,
        conversationId,
        status: "received",
        createdAt: new Date(Date.UTC(2026, 7, 16, 12, index)).toISOString(),
      }),
    );
    const crossOrg = ["queued", "paused"].map((status, index) =>
      messageRow({
        orgId: TEST_ORG_B_ID,
        conversationId,
        status,
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, index)).toISOString(),
      }),
    );
    const { error } = await serviceClient
      .from("messages")
      .insert([...recent, ...crossOrg]);
    expect(error).toBeNull();

    await expect(
      resolveSmsConversationOrg(member, conversationId),
    ).rejects.toThrow("SMS_CONVERSATION_ORG_AMBIGUOUS");
  });
});
