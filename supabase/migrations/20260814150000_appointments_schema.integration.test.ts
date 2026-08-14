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
const db = serviceClient as any;
const createdUserIds: string[] = [];

function uniqueEmail(label: string): string {
  return `mig20260814-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
}

function uniquePhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

async function createUserForOrg(orgId: string, role: "owner" | "member" = "member") {
  const user = await createOrgUser(serviceClient, {
    orgId,
    email: uniqueEmail(`${orgId.slice(-3)}-${role}`),
    role,
  });
  createdUserIds.push(user.userId);
  return { ...user, client: clientForUser(user.jwt) };
}

async function setMembershipAccessStatus(
  userId: string,
  orgId: string,
  status: "active" | "suspended",
): Promise<void> {
  const { error } = await db
    .from("memberships")
    .update({ access_status: status })
    .eq("user_id", userId)
    .eq("org_id", orgId);
  expect(error).toBeNull();
}

async function insertContact(orgId = BMH_ORG_ID, label = "Contact"): Promise<string> {
  const { data, error } = await db
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_type: "person",
      first_name: label,
      last_name: "Test",
      phone_1: uniquePhone(),
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data.id as string;
}

async function insertProperty(orgId = BMH_ORG_ID, contactId?: string | null): Promise<string> {
  const { data, error } = await db
    .from("properties")
    .insert({
      org_id: orgId,
      address: `appt-schema ${crypto.randomUUID()}`,
      state: "MO",
      status: "new_lead",
      homeowner_contact_id: contactId ?? null,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data.id as string;
}

type TaskOverrides = Record<string, unknown>;

async function insertTask(
  overrides: TaskOverrides,
): Promise<{ data: { id: string } | null; error: { message: string; code?: string } | null }> {
  const base = {
    org_id: BMH_ORG_ID,
    type: "follow_up",
    status: "open",
    title: "Test task",
    due_at: new Date(Date.now() + 3600_000).toISOString(),
  };
  const { data, error } = await db
    .from("tasks")
    .insert({ ...base, ...overrides })
    .select("id")
    .single();
  return { data, error };
}

async function insertValidAppointment(overrides: TaskOverrides = {}): Promise<{
  id: string;
  orgId: string;
  assigneeId: string;
  chainId: string;
}> {
  const assignee = await createUserForOrg(BMH_ORG_ID);
  const chainId = crypto.randomUUID();
  const dueAt = new Date(Date.now() + 3600_000).toISOString();
  const endAt = new Date(Date.now() + 7200_000).toISOString();
  const { data, error } = await insertTask({
    type: "appointment",
    assignee_id: assignee.userId,
    created_by: assignee.userId,
    due_at: dueAt,
    end_at: endAt,
    calendar_chain_id: chainId,
    ...overrides,
  });
  expect(error).toBeNull();
  return {
    id: data!.id,
    orgId: (overrides.org_id as string) ?? BMH_ORG_ID,
    assigneeId: assignee.userId,
    chainId,
  };
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

describe("Migration 20260814150000 — appointments schema", () => {
  describe("tasks CHECK constraints", () => {
    it("rejects a non-appointment task with no related_property_id (linkage check)", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { error } = await insertTask({
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: null,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_related_property_linkage_check|violates check/i);
    });

    it("accepts an appointment task with no related_property_id (personal block)", async () => {
      const appt = await insertValidAppointment();
      expect(appt.id).toBeTruthy();
    });

    it("rejects end_at <= due_at on an appointment (end_at check)", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const dueAt = new Date(Date.now() + 3600_000);
      const { error } = await insertTask({
        type: "appointment",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        due_at: dueAt.toISOString(),
        end_at: dueAt.toISOString(),
        calendar_chain_id: crypto.randomUUID(),
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_end_at_check|violates check/i);
    });

    it("rejects end_at set on a non-appointment task (end_at check)", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const { error } = await insertTask({
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
        end_at: new Date(Date.now() + 7200_000).toISOString(),
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_end_at_check|violates check/i);
    });

    it("rejects an outcome on an open appointment (outcome check)", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { error } = await insertTask({
        type: "appointment",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        calendar_chain_id: crypto.randomUUID(),
        status: "open",
        outcome: "held",
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_outcome_check|violates check/i);
    });

    it("accepts a valid outcome on a completed appointment", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { data, error } = await insertTask({
        type: "appointment",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        calendar_chain_id: crypto.randomUUID(),
        status: "completed",
        outcome: "held",
      });
      expect(error).toBeNull();
      expect(data?.id).toBeTruthy();
    });

    it("rejects reminder_claimed_at on a non-appointment task", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const { error } = await insertTask({
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
        reminder_claimed_at: new Date().toISOString(),
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_reminder_claimed_at_check|violates check/i);
    });

    it("rejects an appointment task with no calendar_chain_id (chain invariant)", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { error } = await insertTask({
        type: "appointment",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        calendar_chain_id: null,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_calendar_chain_invariant_check|violates check/i);
    });

    it("rejects a non-appointment task carrying a calendar_chain_id (chain invariant)", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const { error } = await insertTask({
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
        calendar_chain_id: crypto.randomUUID(),
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_calendar_chain_invariant_check|violates check/i);
    });

    it("widens tasks.type to accept 'appointment' and properties.outreach_dispo to accept 'booked_appointment'", async () => {
      const appt = await insertValidAppointment();
      expect(appt.id).toBeTruthy();

      const propertyId = await insertProperty();
      const { error } = await db
        .from("properties")
        .update({ outreach_dispo: "booked_appointment" })
        .eq("id", propertyId);
      expect(error).toBeNull();
    });
  });

  describe("user_integration_prefs — SMS reminder fail-closed", () => {
    it("rejects a reminder_phone that is not E.164", async () => {
      const user = await createUserForOrg(BMH_ORG_ID);
      const { error } = await db.from("user_integration_prefs").insert({
        user_id: user.userId,
        channel: "sms_reminder",
        reminder_phone: "5551234567",
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(
        /user_integration_prefs_reminder_phone_format_check|violates check/i,
      );
    });

    it("accepts a valid E.164 reminder_phone on the sms_reminder channel", async () => {
      const user = await createUserForOrg(BMH_ORG_ID);
      const { error } = await db.from("user_integration_prefs").insert({
        user_id: user.userId,
        channel: "sms_reminder",
        reminder_phone: "+15551234567",
      });
      expect(error).toBeNull();
    });

    it("rejects a reminder_phone set on a non-sms_reminder channel", async () => {
      const user = await createUserForOrg(BMH_ORG_ID);
      const { error } = await db.from("user_integration_prefs").insert({
        user_id: user.userId,
        channel: "slack",
        reminder_phone: "+15551234567",
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(
        /user_integration_prefs_reminder_phone_channel_check|violates check/i,
      );
    });
  });

  describe("tasks_tenant_integrity_guard trigger", () => {
    it("rejects a task whose contact is in a different org", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const foreignContactId = await insertContact(TEST_ORG_B_ID);
      const propertyId = await insertProperty();
      const { error } = await insertTask({
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
        contact_id: foreignContactId,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_tenant_integrity_guard/i);
    });

    it("rejects a task whose property is in a different org", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const foreignPropertyId = await insertProperty(TEST_ORG_B_ID);
      const { error } = await insertTask({
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: foreignPropertyId,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_tenant_integrity_guard/i);
    });

    it("rejects a task assigned to a user with no membership in the org", async () => {
      const outsider = await createUserForOrg(TEST_ORG_B_ID);
      const propertyId = await insertProperty();
      const { error } = await insertTask({
        assignee_id: outsider.userId,
        created_by: outsider.userId,
        related_property_id: propertyId,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_tenant_integrity_guard/i);
    });

    it("rejects an INSERT assigning a task to a suspended-membership user", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      await setMembershipAccessStatus(assignee.userId, BMH_ORG_ID, "suspended");
      const propertyId = await insertProperty();
      const { error } = await insertTask({
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_tenant_integrity_guard/i);
    });

    it("rejects reassigning an existing task to a suspended-membership user", async () => {
      const activeAssignee = await createUserForOrg(BMH_ORG_ID);
      const suspended = await createUserForOrg(BMH_ORG_ID);
      await setMembershipAccessStatus(suspended.userId, BMH_ORG_ID, "suspended");
      const propertyId = await insertProperty();
      const { data } = await insertTask({
        assignee_id: activeAssignee.userId,
        created_by: activeAssignee.userId,
        related_property_id: propertyId,
      });
      expect(data?.id).toBeTruthy();

      const { error } = await db
        .from("tasks")
        .update({ assignee_id: suspended.userId })
        .eq("id", data!.id);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/tasks_tenant_integrity_guard/i);
    });

    it("lets an authenticated caller assign a task to an active teammate (RLS-hidden membership case)", async () => {
      const owner = await createUserForOrg(BMH_ORG_ID, "owner");
      const teammate = await createUserForOrg(BMH_ORG_ID, "member");

      const { data, error } = await owner.client
        .from("tasks" as never)
        .insert({
          org_id: BMH_ORG_ID,
          type: "appointment",
          status: "open",
          title: "Teammate booking",
          due_at: new Date(Date.now() + 3600_000).toISOString(),
          assignee_id: teammate.userId,
          created_by: owner.userId,
          calendar_chain_id: crypto.randomUUID(),
        } as never)
        .select("id")
        .single();
      expect(error).toBeNull();
      expect((data as { id: string } | null)?.id).toBeTruthy();
    });

    it("scope-gating: updating an unrelated column succeeds even after the assignee's membership was deactivated post-creation", async () => {
      const appt = await insertValidAppointment();
      await setMembershipAccessStatus(appt.assigneeId, BMH_ORG_ID, "suspended");

      const { error } = await db
        .from("tasks")
        .update({ reminder_claimed_at: new Date().toISOString() })
        .eq("id", appt.id);
      expect(error).toBeNull();
    });
  });

  describe("notifications — bell exactly-once", () => {
    it("rejects a second task_appointment_reminder notification for the same (user, entity)", async () => {
      const user = await createUserForOrg(BMH_ORG_ID);
      const entityId = crypto.randomUUID();
      const payload = {
        org_id: BMH_ORG_ID,
        user_id: user.userId,
        event_type: "task_appointment_reminder",
        entity_type: "task",
        entity_id: entityId,
        title: "Appointment reminder",
        body: "Upcoming appointment",
      };
      const first = await db.from("notifications").insert(payload);
      expect(first.error).toBeNull();
      const second = await db.from("notifications").insert(payload);
      expect(second.error).not.toBeNull();
      expect(second.error?.message).toMatch(/duplicate|unique/i);
    });

    it("allows two task_appointment_reminder notifications for different entities", async () => {
      const user = await createUserForOrg(BMH_ORG_ID);
      const base = {
        org_id: BMH_ORG_ID,
        user_id: user.userId,
        event_type: "task_appointment_reminder",
        entity_type: "task",
        title: "Appointment reminder",
        body: "Upcoming appointment",
      };
      const first = await db.from("notifications").insert({ ...base, entity_id: crypto.randomUUID() });
      const second = await db.from("notifications").insert({ ...base, entity_id: crypto.randomUUID() });
      expect(first.error).toBeNull();
      expect(second.error).toBeNull();
    });
  });

  describe("task_reminder_deliveries — composite FK + org isolation", () => {
    it("rejects an outbox row whose org_id disagrees with its task's org", async () => {
      const appt = await insertValidAppointment();
      const { error } = await db.from("task_reminder_deliveries").insert({
        org_id: TEST_ORG_B_ID,
        task_id: appt.id,
        channel: "bell",
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/foreign key|violates/i);
    });

    it("accepts an outbox row whose org_id matches its task's org", async () => {
      const appt = await insertValidAppointment();
      const { error } = await db.from("task_reminder_deliveries").insert({
        org_id: BMH_ORG_ID,
        task_id: appt.id,
        channel: "bell",
      });
      expect(error).toBeNull();
    });

    it("isolates task_reminder_deliveries across orgs via RLS", async () => {
      const appt = await insertValidAppointment();
      const { data: row } = await db
        .from("task_reminder_deliveries")
        .insert({ org_id: BMH_ORG_ID, task_id: appt.id, channel: "slack" })
        .select("id")
        .single();
      const outsider = await createUserForOrg(TEST_ORG_B_ID);
      const { data, error } = await outsider.client
        .from("task_reminder_deliveries" as never)
        .select("id")
        .eq("id", (row as { id: string }).id);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("denies an INSERT from an active same-org member (server-owned table)", async () => {
      const appt = await insertValidAppointment();
      const member = await createUserForOrg(BMH_ORG_ID);
      const { error } = await member.client
        .from("task_reminder_deliveries" as never)
        .insert({ org_id: BMH_ORG_ID, task_id: appt.id, channel: "bell" } as never);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/row-level security|permission denied/i);
    });

    it("denies an UPDATE from an active same-org member (server-owned table)", async () => {
      const appt = await insertValidAppointment();
      const { data: row } = await db
        .from("task_reminder_deliveries")
        .insert({ org_id: BMH_ORG_ID, task_id: appt.id, channel: "slack" })
        .select("id")
        .single();
      const member = await createUserForOrg(BMH_ORG_ID);
      const { data, error } = await member.client
        .from("task_reminder_deliveries" as never)
        .update({ sent_at: new Date().toISOString() } as never)
        .eq("id", (row as { id: string }).id)
        .select("id");
      if (error) {
        expect(error.message).toMatch(/row-level security|permission denied/i);
      } else {
        expect(data).toHaveLength(0);
      }
      const { data: after } = await db
        .from("task_reminder_deliveries")
        .select("sent_at")
        .eq("id", (row as { id: string }).id)
        .single();
      expect((after as { sent_at: string | null }).sent_at).toBeNull();
    });

    it("denies a DELETE from an active same-org member (server-owned table)", async () => {
      const appt = await insertValidAppointment();
      const { data: row } = await db
        .from("task_reminder_deliveries")
        .insert({ org_id: BMH_ORG_ID, task_id: appt.id, channel: "sms" })
        .select("id")
        .single();
      const member = await createUserForOrg(BMH_ORG_ID);
      const { data, error } = await member.client
        .from("task_reminder_deliveries" as never)
        .delete()
        .eq("id", (row as { id: string }).id)
        .select("id");
      if (error) {
        expect(error.message).toMatch(/row-level security|permission denied/i);
      } else {
        expect(data).toHaveLength(0);
      }
      const { data: after } = await db
        .from("task_reminder_deliveries")
        .select("id")
        .eq("id", (row as { id: string }).id);
      expect(after).toHaveLength(1);
    });
  });

  describe("task_calendar_mutations — composite FK + org isolation", () => {
    it("rejects a ledger row whose org_id disagrees with its task's org", async () => {
      const appt = await insertValidAppointment();
      const { error } = await db.from("task_calendar_mutations").insert({
        org_id: TEST_ORG_B_ID,
        calendar_chain_id: appt.chainId,
        operation: "create",
        source_task_id: appt.id,
        old_assignee_id: appt.assigneeId,
        expected_generation: 0,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/foreign key|violates/i);
    });

    it("rejects a ledger row whose calendar_chain_id disagrees with its task's chain", async () => {
      const appt = await insertValidAppointment();
      const { error } = await db.from("task_calendar_mutations").insert({
        org_id: BMH_ORG_ID,
        calendar_chain_id: crypto.randomUUID(),
        operation: "create",
        source_task_id: appt.id,
        old_assignee_id: appt.assigneeId,
        expected_generation: 0,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/foreign key|violates/i);
    });

    it("accepts a ledger row whose org_id and calendar_chain_id agree with its task", async () => {
      const appt = await insertValidAppointment();
      const { error } = await db.from("task_calendar_mutations").insert({
        org_id: BMH_ORG_ID,
        calendar_chain_id: appt.chainId,
        operation: "create",
        source_task_id: appt.id,
        old_assignee_id: appt.assigneeId,
        expected_generation: 0,
      });
      expect(error).toBeNull();
    });

    it("serializes concurrent mutations on the same chain via the partial unique index", async () => {
      const appt = await insertValidAppointment();
      const first = await db.from("task_calendar_mutations").insert({
        org_id: BMH_ORG_ID,
        calendar_chain_id: appt.chainId,
        operation: "create",
        phase: "pending",
        source_task_id: appt.id,
        old_assignee_id: appt.assigneeId,
        expected_generation: 0,
      });
      expect(first.error).toBeNull();
      const second = await db.from("task_calendar_mutations").insert({
        org_id: BMH_ORG_ID,
        calendar_chain_id: appt.chainId,
        operation: "reschedule",
        phase: "provider_done",
        source_task_id: appt.id,
        old_assignee_id: appt.assigneeId,
        expected_generation: 0,
      });
      expect(second.error).not.toBeNull();
      expect(second.error?.message).toMatch(/duplicate|unique/i);
    });

    it("isolates task_calendar_mutations across orgs via RLS", async () => {
      const appt = await insertValidAppointment();
      const { data: row } = await db
        .from("task_calendar_mutations")
        .insert({
          org_id: BMH_ORG_ID,
          calendar_chain_id: appt.chainId,
          operation: "create",
          source_task_id: appt.id,
          old_assignee_id: appt.assigneeId,
          expected_generation: 0,
        })
        .select("id")
        .single();
      const outsider = await createUserForOrg(TEST_ORG_B_ID);
      const { data, error } = await outsider.client
        .from("task_calendar_mutations" as never)
        .select("id")
        .eq("id", (row as { id: string }).id);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("denies an INSERT from an active same-org member (server-owned table)", async () => {
      const appt = await insertValidAppointment();
      const member = await createUserForOrg(BMH_ORG_ID);
      const { error } = await member.client
        .from("task_calendar_mutations" as never)
        .insert({
          org_id: BMH_ORG_ID,
          calendar_chain_id: appt.chainId,
          operation: "create",
          source_task_id: appt.id,
          old_assignee_id: appt.assigneeId,
          expected_generation: 0,
        } as never);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/row-level security|permission denied/i);
    });

    it("denies an UPDATE from an active same-org member (server-owned table)", async () => {
      const appt = await insertValidAppointment();
      const { data: row } = await db
        .from("task_calendar_mutations")
        .insert({
          org_id: BMH_ORG_ID,
          calendar_chain_id: appt.chainId,
          operation: "create",
          source_task_id: appt.id,
          old_assignee_id: appt.assigneeId,
          expected_generation: 0,
        })
        .select("id")
        .single();
      const member = await createUserForOrg(BMH_ORG_ID);
      const { data, error } = await member.client
        .from("task_calendar_mutations" as never)
        .update({ phase: "finalized" } as never)
        .eq("id", (row as { id: string }).id)
        .select("id");
      if (error) {
        expect(error.message).toMatch(/row-level security|permission denied/i);
      } else {
        expect(data).toHaveLength(0);
      }
      const { data: after } = await db
        .from("task_calendar_mutations")
        .select("phase")
        .eq("id", (row as { id: string }).id)
        .single();
      expect((after as { phase: string }).phase).toBe("pending");
    });

    it("denies a DELETE from an active same-org member (server-owned table)", async () => {
      const appt = await insertValidAppointment();
      const { data: row } = await db
        .from("task_calendar_mutations")
        .insert({
          org_id: BMH_ORG_ID,
          calendar_chain_id: appt.chainId,
          operation: "create",
          source_task_id: appt.id,
          old_assignee_id: appt.assigneeId,
          expected_generation: 0,
        })
        .select("id")
        .single();
      const member = await createUserForOrg(BMH_ORG_ID);
      const { data, error } = await member.client
        .from("task_calendar_mutations" as never)
        .delete()
        .eq("id", (row as { id: string }).id)
        .select("id");
      if (error) {
        expect(error.message).toMatch(/row-level security|permission denied/i);
      } else {
        expect(data).toHaveLength(0);
      }
      const { data: after } = await db
        .from("task_calendar_mutations")
        .select("id")
        .eq("id", (row as { id: string }).id);
      expect(after).toHaveLength(1);
    });
  });

  describe("cascade behavior", () => {
    it("deleting a property cascades to its task, then to the task's outbox and ledger rows", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const chainId = crypto.randomUUID();
      const { data: task, error: taskError } = await insertTask({
        type: "appointment",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
        calendar_chain_id: chainId,
      });
      expect(taskError).toBeNull();
      const taskId = task!.id;

      const { data: outboxRow, error: outboxError } = await db
        .from("task_reminder_deliveries")
        .insert({ org_id: BMH_ORG_ID, task_id: taskId, channel: "bell" })
        .select("id")
        .single();
      expect(outboxError).toBeNull();

      const { data: ledgerRow, error: ledgerError } = await db
        .from("task_calendar_mutations")
        .insert({
          org_id: BMH_ORG_ID,
          calendar_chain_id: chainId,
          operation: "create",
          source_task_id: taskId,
          old_assignee_id: assignee.userId,
          expected_generation: 0,
        })
        .select("id")
        .single();
      expect(ledgerError).toBeNull();

      const { error: deleteError } = await db.from("properties").delete().eq("id", propertyId);
      expect(deleteError).toBeNull();

      const { data: taskAfter } = await db.from("tasks").select("id").eq("id", taskId);
      expect(taskAfter).toHaveLength(0);

      const { data: outboxAfter } = await db
        .from("task_reminder_deliveries")
        .select("id")
        .eq("id", (outboxRow as { id: string }).id);
      expect(outboxAfter).toHaveLength(0);

      const { data: ledgerAfter } = await db
        .from("task_calendar_mutations")
        .select("id")
        .eq("id", (ledgerRow as { id: string }).id);
      expect(ledgerAfter).toHaveLength(0);
    });
  });
});
