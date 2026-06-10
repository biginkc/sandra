import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import {
  createNotification,
  dispatchJobCompleted,
  dispatchOwnerMessageAdded,
  dispatchPropertyAssigned,
} from "./dispatch";

const supabase = createTestClient();

// Minimal org lookup — every property/notification needs an org_id.
let _orgId: string | null = null;
async function getOrgId(): Promise<string> {
  if (_orgId) return _orgId;
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error("no organization seeded in test project");
  _orgId = data.id;
  return _orgId;
}

// Track auth users created during a test so afterEach can delete them.
// The test project is shared; leaking users would compound across runs.
const createdAuthUsers: string[] = [];

async function createAuthUser(email: string): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: `test-pw-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createAuthUser(${email}) failed: ${error?.message}`);
  }
  createdAuthUsers.push(data.user.id);
  return data.user.id;
}

async function seedProperty(
  opts: { assignedUserId?: string | null; address?: string } = {},
): Promise<string> {
  const { data, error } = await supabase
    .from("properties")
    .insert({
      address: opts.address ?? "123 Dispatch Test Ln",
      state: "MO",
      status: "prospect",
      assigned_user_id: opts.assignedUserId ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedProperty failed: ${error?.message}`);
  return data.id;
}

async function seedJob(opts: {
  createdBy: string | null;
  status: "completed" | "failed" | "partial" | "canceled";
  succeeded: number;
  failed: number;
}): Promise<string> {
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      type: "cass_dsf2_ncoa",
      status: opts.status,
      created_by: opts.createdBy,
      total_items: opts.succeeded + opts.failed,
      succeeded_items: opts.succeeded,
      failed_items: opts.failed,
      title: "test job",
      provider: "mock",
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedJob failed: ${error?.message}`);
  return data.id;
}

describe("notifications/dispatch (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  afterEach(async () => {
    // Delete auth users created by this test so we don't leak into the
    // shared test project. resetTenantTables doesn't touch auth.users.
    for (const id of createdAuthUsers) {
      await supabase.auth.admin.deleteUser(id);
    }
    createdAuthUsers.length = 0;
  });

  // --------------------------------------------------------------------------
  // createNotification (tests 12–14)
  // --------------------------------------------------------------------------
  describe("createNotification", () => {
    it("writes a row that round-trips all fields", async () => {
      const orgId = await getOrgId();
      const userId = await createAuthUser(
        `notif-rt-${Date.now()}@test.invalid`,
      );
      const entityId = "00000000-0000-0000-0000-000000001111";
      const r = await createNotification(supabase, {
        orgId,
        eventType: "owner_message_added",
        entityType: "property",
        entityId,
        payload: { propertyAddress: "999 Round Trip Rd" },
        recipients: [userId],
      });
      expect(r.inserted).toBe(1);

      const { data } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", userId);
      expect(data).toHaveLength(1);
      expect(data![0]).toMatchObject({
        org_id: orgId,
        user_id: userId,
        event_type: "owner_message_added",
        entity_type: "property",
        entity_id: entityId,
        title: "New SMS reply",
        read_at: null,
      });
      expect(data![0].body).toContain("999 Round Trip Rd");
    });

    it("is a no-op with empty recipients — returns inserted:0, throws no error", async () => {
      const orgId = await getOrgId();
      const r = await createNotification(supabase, {
        orgId,
        eventType: "owner_message_added",
        entityType: "property",
        entityId: "00000000-0000-0000-0000-000000001112",
        payload: { propertyAddress: "X" },
        recipients: [],
      });
      expect(r.inserted).toBe(0);

      const { count } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true });
      expect(count).toBe(0);
    });

    it("fans out one row per recipient for N recipients", async () => {
      const orgId = await getOrgId();
      const a = await createAuthUser(`fan-a-${Date.now()}@test.invalid`);
      const b = await createAuthUser(`fan-b-${Date.now()}@test.invalid`);
      const c = await createAuthUser(`fan-c-${Date.now()}@test.invalid`);
      const r = await createNotification(supabase, {
        orgId,
        eventType: "property_assigned",
        entityType: "property",
        entityId: "00000000-0000-0000-0000-000000001113",
        payload: {
          propertyAddress: "Fanout Ln",
          assignerName: "tester",
        },
        recipients: [a, b, c],
      });
      expect(r.inserted).toBe(3);

      const { data } = await supabase
        .from("notifications")
        .select("user_id")
        .in("user_id", [a, b, c]);
      expect(data).toHaveLength(3);
    });
  });

  // --------------------------------------------------------------------------
  // dispatchOwnerMessageAdded (tests 15–17)
  // --------------------------------------------------------------------------
  describe("dispatchOwnerMessageAdded", () => {
    it("assigned property → one notification for the assignee", async () => {
      const assignee = await createAuthUser(
        `owner-assigned-${Date.now()}@test.invalid`,
      );
      const admin = await createAuthUser(
        `owner-admin-${Date.now()}@test.invalid`,
      );
      const propertyId = await seedProperty({
        assignedUserId: assignee,
        address: "111 Assigned Ave",
      });
      const messageId = "00000000-0000-4000-8000-000000000151";

      const r = await dispatchOwnerMessageAdded(supabase, {
        messageId,
        propertyId,
        adminUserIds: [admin],
      });
      expect(r.inserted).toBe(1);

      const { data } = await supabase
        .from("notifications")
        .select("user_id, event_type, entity_type, entity_id, read_at")
        .eq("event_type", "owner_message_added");
      expect(data).toHaveLength(1);
      expect(data![0]).toMatchObject({
        user_id: assignee,
        entity_type: "message",
        entity_id: messageId,
        read_at: null,
      });
    });

    it("unassigned property → notifies every admin (not non-admins)", async () => {
      const admin = await createAuthUser(
        `owner-fallback-admin-${Date.now()}@test.invalid`,
      );
      const nonAdmin = await createAuthUser(
        `owner-fallback-user-${Date.now()}@test.invalid`,
      );
      const propertyId = await seedProperty({ assignedUserId: null });
      const messageId = "00000000-0000-4000-8000-000000000152";

      const r = await dispatchOwnerMessageAdded(supabase, {
        messageId,
        propertyId,
        adminUserIds: [admin],
      });
      expect(r.inserted).toBe(1);

      const { data } = await supabase
        .from("notifications")
        .select("user_id")
        .eq("event_type", "owner_message_added");
      expect(data).toHaveLength(1);
      expect(data![0].user_id).toBe(admin);
      expect(data!.some((n) => n.user_id === nonAdmin)).toBe(false);
    });

    it("unassigned property with zero admins → zero notifications, no error", async () => {
      const propertyId = await seedProperty({ assignedUserId: null });

      const r = await dispatchOwnerMessageAdded(supabase, {
        messageId: "00000000-0000-4000-8000-000000000153",
        propertyId,
        adminUserIds: [],
      });
      expect(r.inserted).toBe(0);

      const { count } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true });
      expect(count).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // dispatchPropertyAssigned (tests 22–25)
  // --------------------------------------------------------------------------
  describe("dispatchPropertyAssigned", () => {
    it("notifies the new assignee for every affected property, not the actor", async () => {
      const actor = await createAuthUser(
        `assigner-${Date.now()}@test.invalid`,
      );
      const assignee = await createAuthUser(
        `assignee-${Date.now()}@test.invalid`,
      );
      const p1 = await seedProperty({ address: "1 Bulk Ln" });
      const p2 = await seedProperty({ address: "2 Bulk Ln" });
      const p3 = await seedProperty({ address: "3 Bulk Ln" });

      const r = await dispatchPropertyAssigned(supabase, {
        propertyIds: [p1, p2, p3],
        newAssigneeId: assignee,
        actorId: actor,
        assignerName: "tester",
      });
      expect(r.inserted).toBe(3);

      const { data: forAssignee } = await supabase
        .from("notifications")
        .select("entity_id")
        .eq("user_id", assignee)
        .eq("event_type", "property_assigned");
      expect(forAssignee).toHaveLength(3);
      expect(new Set(forAssignee!.map((n) => n.entity_id))).toEqual(
        new Set([p1, p2, p3]),
      );

      const { count: forActor } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("user_id", actor);
      expect(forActor).toBe(0);
    });

    it("suppresses self-assign (decision #1)", async () => {
      const self = await createAuthUser(`self-${Date.now()}@test.invalid`);
      const p1 = await seedProperty();

      const r = await dispatchPropertyAssigned(supabase, {
        propertyIds: [p1],
        newAssigneeId: self,
        actorId: self,
        assignerName: "self",
      });
      expect(r.inserted).toBe(0);

      const { count } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true });
      expect(count).toBe(0);
    });

    it("unassign (newAssigneeId = null) emits no notifications", async () => {
      const actor = await createAuthUser(`un-${Date.now()}@test.invalid`);
      const p1 = await seedProperty();

      const r = await dispatchPropertyAssigned(supabase, {
        propertyIds: [p1],
        newAssigneeId: null,
        actorId: actor,
        assignerName: "tester",
      });
      expect(r.inserted).toBe(0);
    });

    it("reassignment notifies only each new assignee — no 'removed from you' for prior (decision #3)", async () => {
      const actor = await createAuthUser(`ra-${Date.now()}@test.invalid`);
      const userB = await createAuthUser(`rb-${Date.now()}@test.invalid`);
      const userC = await createAuthUser(`rc-${Date.now()}@test.invalid`);
      const p1 = await seedProperty();

      await dispatchPropertyAssigned(supabase, {
        propertyIds: [p1],
        newAssigneeId: userB,
        actorId: actor,
        assignerName: "tester",
      });
      await dispatchPropertyAssigned(supabase, {
        propertyIds: [p1],
        newAssigneeId: userC,
        actorId: actor,
        assignerName: "tester",
      });

      const { count: forB } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userB);
      const { count: forC } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userC);
      expect(forB).toBe(1);
      expect(forC).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // dispatchJobCompleted (tests 26–27)
  // --------------------------------------------------------------------------
  describe("dispatchJobCompleted", () => {
    it("notifies the job creator when a CASS job transitions to completed", async () => {
      const creator = await createAuthUser(
        `creator-${Date.now()}@test.invalid`,
      );
      const jobId = await seedJob({
        createdBy: creator,
        status: "completed",
        succeeded: 5,
        failed: 0,
      });

      const r = await dispatchJobCompleted(supabase, { jobId });
      expect(r.inserted).toBe(1);

      const { data } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", creator);
      expect(data).toHaveLength(1);
      expect(data![0]).toMatchObject({
        event_type: "bulk_action_completed",
        entity_type: "job",
        entity_id: jobId,
        read_at: null,
      });
      expect(data![0].title.toLowerCase()).toContain("address verification");
      expect(data![0].body).toContain("5");
      expect(data![0].body).toContain("0");
    });

    it("body reflects state on failed + partial terminations", async () => {
      const creator = await createAuthUser(
        `creator-state-${Date.now()}@test.invalid`,
      );
      const failedJob = await seedJob({
        createdBy: creator,
        status: "failed",
        succeeded: 0,
        failed: 10,
      });
      const partialJob = await seedJob({
        createdBy: creator,
        status: "partial",
        succeeded: 7,
        failed: 3,
      });

      await dispatchJobCompleted(supabase, { jobId: failedJob });
      await dispatchJobCompleted(supabase, { jobId: partialJob });

      const { data } = await supabase
        .from("notifications")
        .select("title, body, entity_id")
        .eq("user_id", creator)
        .order("created_at", { ascending: true });
      expect(data).toHaveLength(2);
      const failedNotif = data!.find((n) => n.entity_id === failedJob);
      const partialNotif = data!.find((n) => n.entity_id === partialJob);
      expect(failedNotif!.title.toLowerCase()).toContain("failed");
      expect(partialNotif!.title.toLowerCase()).toMatch(/error|partial/);
      expect(partialNotif!.body).toContain("7");
      expect(partialNotif!.body).toContain("3");
    });

    it("no notification when the job has no created_by (system-created jobs)", async () => {
      const jobId = await seedJob({
        createdBy: null,
        status: "completed",
        succeeded: 1,
        failed: 0,
      });

      const r = await dispatchJobCompleted(supabase, { jobId });
      expect(r.inserted).toBe(0);
    });
  });
});
