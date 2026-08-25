import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

// Wire the action's internal createClient() to our test client so it hits
// sandra-crm-test. Hoisted by vi.mock.
const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

import {
  createLeadNote,
  markMessagesReadForProperty,
  markMessagesReadForThread,
  updateLeadAssignee,
} from "@/app/(dashboard)/leads/actions";

const createdAuthUsers: string[] = [];

async function createActiveAssignee(
  orgId: string,
  prefix: string,
): Promise<string> {
  const created = await createOrgUser(testClient, {
    orgId,
    email: `${prefix}-${crypto.randomUUID()}@test.invalid`,
    role: "member",
  });
  createdAuthUsers.push(created.userId);
  return created.userId;
}

describe("VA polish seams — Feature 1 integration", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
  });

  afterEach(async () => {
    for (const userId of createdAuthUsers.splice(0)) {
      await testClient.auth.admin.deleteUser(userId);
    }
  });

  async function seedProperty(): Promise<{ id: string; orgId: string }> {
    const { data, error } = await testClient
      .from("properties")
      .insert({ address: "1 Test St", state: "MO", status: "new_lead" })
      .select("id, org_id")
      .single();
    if (error || !data) throw error ?? new Error("seed property failed");
    return { id: data.id, orgId: data.org_id };
  }

  // ---------------------------------------------------------------------------
  // updateLeadAssignee
  // ---------------------------------------------------------------------------
  describe("updateLeadAssignee", () => {
    it("assigns a user to a property", async () => {
      const { id, orgId } = await seedProperty();
      const createdUserId = await createActiveAssignee(orgId, "assignee-test");

      const result = await updateLeadAssignee(id, createdUserId);
      expect(result.ok).toBe(true);

      const { data } = await testClient
        .from("properties")
        .select("assigned_user_id")
        .eq("id", id)
        .single();
      expect(data?.assigned_user_id).toBe(createdUserId);

      const { data: events } = await testClient
        .from("lead_events")
        .select("event_type, payload")
        .eq("property_id", id);
      expect(events).toEqual([
        {
          event_type: "assigned",
          payload: { from: null, to: createdUserId },
        },
      ]);
    });

    it("clears assignment when passed null", async () => {
      const { id, orgId } = await seedProperty();
      const userId = await createActiveAssignee(orgId, "unassign-test");

      await updateLeadAssignee(id, userId);
      const clearResult = await updateLeadAssignee(id, null);
      expect(clearResult.ok).toBe(true);

      const { data } = await testClient
        .from("properties")
        .select("assigned_user_id")
        .eq("id", id)
        .single();
      expect(data?.assigned_user_id).toBeNull();

      const { data: events } = await testClient
        .from("lead_events")
        .select("event_type, payload")
        .eq("property_id", id);
      expect(events).toHaveLength(2);
      expect(events).toEqual(
        expect.arrayContaining([
          {
            event_type: "assigned",
            payload: { from: userId, to: null },
          },
        ]),
      );
    });

    it("does not bump updated_at or append an event for an unchanged assignment", async () => {
      const { id } = await seedProperty();
      const { data: before } = await testClient
        .from("properties")
        .select("updated_at")
        .eq("id", id)
        .single();
      await new Promise((r) => setTimeout(r, 50));
      await updateLeadAssignee(id, null);
      const { data: after } = await testClient
        .from("properties")
        .select("updated_at")
        .eq("id", id)
        .single();
      expect(after!.updated_at).toBe(before!.updated_at);
      const { count } = await testClient
        .from("lead_events")
        .select("id", { count: "exact", head: true })
        .eq("property_id", id);
      expect(count).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // markMessagesReadForProperty
  // ---------------------------------------------------------------------------
  describe("markMessagesReadForProperty", () => {
    it("marks all unread inbound messages on a property as read", async () => {
      const { id: propertyId, orgId } = await seedProperty();
      // Insert two inbound (unread) + one outbound on this property.
      const { error: insertErr } = await testClient.from("messages").insert([
        {
          channel: "sms",
          direction: "inbound",
          body: "hi there",
          property_id: propertyId,
          org_id: orgId,
          status: "received",
        },
        {
          channel: "sms",
          direction: "inbound",
          body: "still there?",
          property_id: propertyId,
          org_id: orgId,
          status: "received",
        },
        {
          channel: "sms",
          direction: "outbound",
          body: "hey",
          property_id: propertyId,
          org_id: orgId,
          status: "sent",
        },
      ]);
      if (insertErr) throw insertErr;

      const result = await markMessagesReadForProperty(propertyId);
      expect(result.ok).toBe(true);

      const { data: rows } = await testClient
        .from("messages")
        .select("direction, read_at")
        .eq("property_id", propertyId)
        .order("created_at", { ascending: true });

      expect(rows).toHaveLength(3);
      // Two inbound rows now have read_at set…
      const inbound = rows!.filter((r) => r.direction === "inbound");
      expect(inbound).toHaveLength(2);
      for (const r of inbound) {
        expect(r.read_at).not.toBeNull();
      }
      // …and the outbound row is untouched (read_at stays null).
      const outbound = rows!.filter((r) => r.direction === "outbound");
      expect(outbound).toHaveLength(1);
      expect(outbound[0]!.read_at).toBeNull();
    });

    it("leaves messages on other properties alone", async () => {
      const a = await seedProperty();
      const b = await seedProperty();
      await testClient.from("messages").insert([
        {
          channel: "sms",
          direction: "inbound",
          body: "on A",
          property_id: a.id,
          org_id: a.orgId,
          status: "received",
        },
        {
          channel: "sms",
          direction: "inbound",
          body: "on B",
          property_id: b.id,
          org_id: b.orgId,
          status: "received",
        },
      ]);

      await markMessagesReadForProperty(a.id);

      const { data: aRows } = await testClient
        .from("messages")
        .select("read_at")
        .eq("property_id", a.id);
      const { data: bRows } = await testClient
        .from("messages")
        .select("read_at")
        .eq("property_id", b.id);
      expect(aRows![0]!.read_at).not.toBeNull();
      expect(bRows![0]!.read_at).toBeNull();
    });
  });

  describe("markMessagesReadForThread", () => {
    it("marks only the selected conversation thread as read", async () => {
      const { id: propertyId, orgId } = await seedProperty();
      const { data: contactA } = await testClient
        .from("contacts")
        .insert({
          first_name: "A",
          last_name: "Thread",
          phone_1: "+18165550101",
          phone_1_type: "mobile",
        })
        .select("id")
        .single();
      const { data: contactB } = await testClient
        .from("contacts")
        .insert({
          first_name: "B",
          last_name: "Thread",
          phone_1: "+18165550102",
          phone_1_type: "mobile",
        })
        .select("id")
        .single();

      const convoA = "11111111-1111-4111-8111-111111111111";
      const convoB = "22222222-2222-4222-8222-222222222222";

      await testClient.from("messages").insert([
        {
          channel: "sms",
          direction: "inbound",
          body: "thread A",
          property_id: propertyId,
          contact_id: contactA!.id,
          conversation_id: convoA,
          org_id: orgId,
          status: "received",
        },
        {
          channel: "sms",
          direction: "inbound",
          body: "thread B",
          property_id: propertyId,
          contact_id: contactB!.id,
          conversation_id: convoB,
          org_id: orgId,
          status: "received",
        },
      ]);

      const result = await markMessagesReadForThread(convoA);
      expect(result.ok).toBe(true);

      const { data: rows } = await testClient
        .from("messages")
        .select("conversation_id, read_at")
        .eq("property_id", propertyId)
        .order("created_at", { ascending: true });

      expect(rows).toHaveLength(2);
      expect(rows?.find((row) => row.conversation_id === convoA)?.read_at).not.toBeNull();
      expect(rows?.find((row) => row.conversation_id === convoB)?.read_at).toBeNull();
    });

    it("refuses a shared conversation UUID across organizations before changing any row", async () => {
      await seedTwoOrgs(testClient);
      const conversationId = crypto.randomUUID();
      const recentRows = Array.from({ length: 101 }, (_, index) => ({
        org_id: BMH_ORG_ID,
        channel: "sms" as const,
        direction: "inbound" as const,
        status: "received",
        conversation_id: conversationId,
        contact_id: null,
        property_id: null,
        from_address: "+18165550101",
        to_address: "+18165550102",
        body: `recent ${index}`,
        created_at: new Date(Date.UTC(2026, 7, 16, 12, index)).toISOString(),
      }));
      const { error: seedError } = await testClient.from("messages").insert([
        ...recentRows,
        {
          org_id: TEST_ORG_B_ID,
          channel: "sms",
          direction: "inbound",
          status: "paused",
          conversation_id: conversationId,
          contact_id: null,
          property_id: null,
          from_address: "+18165550103",
          to_address: "+18165550104",
          body: "old contactless collision",
          created_at: "2020-01-01T00:00:00Z",
        },
      ]);
      expect(seedError).toBeNull();

      const result = await markMessagesReadForThread(conversationId);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "MARK_READ_FAILED",
          message: expect.stringContaining("SMS_CONVERSATION_ORG_AMBIGUOUS"),
        },
      });

      const { data: unread } = await testClient
        .from("messages")
        .select("read_at")
        .eq("conversation_id", conversationId);
      expect(unread).toHaveLength(102);
      expect(unread?.every((row) => row.read_at === null)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // createLeadNote
  // ---------------------------------------------------------------------------
  describe("createLeadNote", () => {
    // createLeadNote reads the authenticated user via supabase.auth.getUser().
    // Our test client is service-role — there's no user session — so the
    // action returns UNAUTHENTICATED. We validate the input-rejection paths
    // here and leave the happy path to end-to-end verification.

    it("rejects an empty note body", async () => {
      const { id } = await seedProperty();
      const result = await createLeadNote(id, "   ");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("EMPTY_BODY");
    });

    it("rejects a body over 5000 characters", async () => {
      const { id } = await seedProperty();
      const result = await createLeadNote(id, "a".repeat(5001));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("BODY_TOO_LONG");
    });

    it("rejects a call from an unauthenticated session", async () => {
      const { id } = await seedProperty();
      const result = await createLeadNote(id, "legit body");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("UNAUTHENTICATED");
    });
  });
});
