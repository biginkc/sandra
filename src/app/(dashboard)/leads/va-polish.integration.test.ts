import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

// Wire the action's internal createClient() to our test client so it hits
// sandra-crm-test. Hoisted by vi.mock.
const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

// eslint-disable-next-line import/first
import {
  createLeadNote,
  markMessagesReadForProperty,
  markMessagesReadForThread,
  updateLeadAssignee,
} from "@/app/(dashboard)/leads/actions";

describe("VA polish seams — Feature 1 integration", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
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
      const { id } = await seedProperty();
      // Use a synthesized UUID; the FK to auth.users only enforces existence
      // when a user row is present, and in test-reset state the property
      // table accepts any uuid for the assigned_user_id column. The
      // realistic flow uses auth.users.id values, but the test only needs
      // to verify the column flips.
      const fakeUserId = "00000000-0000-0000-0000-000000000aaa";

      // Seed: insert an auth user with that id so the FK satisfies.
      const { error: userErr } = await testClient.auth.admin.createUser({
        email: "assignee-test@example.com",
        password: "irrelevant-for-test",
        email_confirm: true,
        user_metadata: { id: fakeUserId },
      });
      if (userErr) throw userErr;
      // createUser doesn't let us pick the id; read it back.
      const { data: users } = await testClient.auth.admin.listUsers({
        perPage: 200,
      });
      const createdUserId = users?.users.find(
        (u) => u.email === "assignee-test@example.com",
      )?.id;
      expect(createdUserId).toBeTruthy();

      const result = await updateLeadAssignee(id, createdUserId!);
      expect(result.ok).toBe(true);

      const { data } = await testClient
        .from("properties")
        .select("assigned_user_id")
        .eq("id", id)
        .single();
      expect(data?.assigned_user_id).toBe(createdUserId);

      // Cleanup the test user so repeat runs stay clean.
      await testClient.auth.admin.deleteUser(createdUserId!);
    });

    it("clears assignment when passed null", async () => {
      const { id } = await seedProperty();
      const { data: userData } = await testClient.auth.admin.createUser({
        email: "unassign-test@example.com",
        password: "irrelevant",
        email_confirm: true,
      });
      const userId = userData.user!.id;

      await updateLeadAssignee(id, userId);
      const clearResult = await updateLeadAssignee(id, null);
      expect(clearResult.ok).toBe(true);

      const { data } = await testClient
        .from("properties")
        .select("assigned_user_id")
        .eq("id", id)
        .single();
      expect(data?.assigned_user_id).toBeNull();

      await testClient.auth.admin.deleteUser(userId);
    });

    it("bumps updated_at on assignment change", async () => {
      const { id } = await seedProperty();
      const { data: before } = await testClient
        .from("properties")
        .select("updated_at")
        .eq("id", id)
        .single();
      await new Promise((r) => setTimeout(r, 50));
      await updateLeadAssignee(id, null); // no-op change; still bumps timestamp
      const { data: after } = await testClient
        .from("properties")
        .select("updated_at")
        .eq("id", id)
        .single();
      expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
        new Date(before!.updated_at).getTime(),
      );
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
