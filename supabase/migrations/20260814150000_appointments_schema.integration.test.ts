import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";
import { resetTenantTables } from "@tests/integration/reset";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import type { TablesInsert } from "@/lib/supabase/types";

/**
 * Raw Postgres connection string for the two-connection membership-race
 * test below. Mirrors `tests/integration/global-setup.ts`'s own lookup —
 * `TEST_SUPABASE_DB_URL` is read by global setup (the vitest main process)
 * but is NOT forwarded into worker `process.env` by
 * `vitest.integration.config.ts` (only URL/anon/service-role are), so test
 * files that need a raw connection must load `.env.test.local` themselves.
 */
function testDbUrl(): string {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) {
    throw new Error(
      "Missing TEST_SUPABASE_DB_URL in .env.test.local — see tests/integration/README.md.",
    );
  }
  return url;
}

const serviceClient = createTestClient();
const db = serviceClient;
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
  return data!.id;
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
  return data!.id;
}

// Partial<Insert> rather than the untyped Record it used to be: excess or
// misspelled columns on a call site now fail typecheck instead of silently
// no-opping through the old `db = serviceClient as any` cast. assignee_id
// and created_by stay mandatory on every call site (no safe FK default
// exists for them), matching every existing caller in this file.
type TaskOverrides = Partial<TablesInsert<"tasks">> &
  Pick<TablesInsert<"tasks">, "assignee_id" | "created_by">;

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

async function insertValidAppointment(
  overrides: Partial<TablesInsert<"tasks">> = {},
): Promise<{
  id: string;
  orgId: string;
  assigneeId: string;
  chainId: string;
}> {
  const assignee = await createUserForOrg(BMH_ORG_ID);
  const chainId = crypto.randomUUID();
  const dueAt = new Date(Date.now() + 3600_000).toISOString();
  const endAt = new Date(Date.now() + 7200_000).toISOString();
  // Two spreads (no explicit property before a spread that might also
  // carry it) so `overrides` can still win on any key without tripping
  // TS2783 ("specified more than once").
  const defaults: TaskOverrides = {
    type: "appointment",
    assignee_id: assignee.userId,
    created_by: assignee.userId,
    due_at: dueAt,
    end_at: endAt,
    calendar_chain_id: chainId,
  };
  const { data, error } = await insertTask({ ...defaults, ...overrides });
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
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();
      const { error } = await insertTask({
        type: "appointment",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        due_at: dueAt,
        end_at: endAt,
        calendar_chain_id: crypto.randomUUID(),
        status: "open",
        outcome: "held",
      });
      expect(error).not.toBeNull();
      // The tenant-integrity trigger's canonical-open INSERT rule fires
      // BEFORE the CHECK can (both reject this row) — accept either guard.
      expect(error?.message).toMatch(
        /tasks_outcome_check|violates check|created open and unclaimed/i,
      );
    });

    it("accepts a valid outcome on a completed appointment", async () => {
      // Round-14's trigger INSERT guard rejects a non-canonical creation
      // state outright (status must be 'open' on insert), so this can no
      // longer be a bare service-role INSERT of a completed+held row —
      // that would prove the trigger's guard, not the CHECK constraint
      // this test targets. Insert open (canonical), then move it to
      // completed/held through a flagged raw-pg transaction — same
      // escape-hatch pattern as every other appointment-owned-facet test
      // in this file.
      const appt = await insertValidAppointment();

      const conn = new Client({ connectionString: testDbUrl() });
      await conn.connect();
      await conn.query("set statement_timeout = 0");
      await conn.query("begin");
      await conn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      const result = await conn.query<{ id: string }>(
        `update tasks
           set status = 'completed', outcome = 'held', completed_at = now(), completed_by = $2
         where id = $1
         returning id`,
        [appt.id, appt.assigneeId],
      );
      await conn.query("commit");
      await conn.end().catch(() => {});

      expect(result.rows[0]?.id).toBe(appt.id);
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
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();
      const { error } = await insertTask({
        type: "appointment",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        due_at: dueAt,
        end_at: endAt,
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

  // Round-9: the outcome CHECK moved from a one-way OR (`outcome is null OR
  // ...`) to an equality between terminal status and a non-null outcome, so
  // both directions are enforced — an open appointment can no longer carry
  // an outcome, and a terminal one can no longer lack one. These exercise
  // the coupling through UPDATEs on an authenticated org member's own
  // client (not the service-role INSERTs above), since that's the path the
  // app's own outcome-recording flow (PR 3) actually uses.
  describe("appointment outcome coupling (authenticated client)", () => {
    async function createOpenAppointment(): Promise<{
      taskId: string;
      owner: Awaited<ReturnType<typeof createUserForOrg>>;
    }> {
      const owner = await createUserForOrg(BMH_ORG_ID, "owner");
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();
      const { data, error } = await insertTask({
        type: "appointment",
        assignee_id: owner.userId,
        created_by: owner.userId,
        due_at: dueAt,
        end_at: endAt,
        calendar_chain_id: crypto.randomUUID(),
      });
      expect(error).toBeNull();
      return { taskId: data!.id, owner };
    }

    // Round-13's lifecycle-state guard fires on ANY status/outcome change
    // to an appointment before the CHECK constraint gets a look, so these
    // four tests now run inside a flagged raw-pg transaction — same pattern
    // as every other appointment-owned facet's escape hatch below. Flagging
    // is what lets the CHECK-violation tests keep proving the CHECK itself
    // fires, instead of just re-proving the (already-tested) guard.
    let conn: Client;

    beforeEach(async () => {
      conn = new Client({ connectionString: testDbUrl() });
      await conn.connect();
      await conn.query("set statement_timeout = 0");
    });

    afterEach(async () => {
      await conn.query("rollback").catch(() => {});
      await conn.end().catch(() => {});
    });

    it("rejects status='completed' with a NULL outcome", async () => {
      const { taskId, owner } = await createOpenAppointment();
      await conn.query("begin");
      await conn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      await expect(
        conn.query(
          "update tasks set status = 'completed', completed_at = now(), completed_by = $2 where id = $1",
          [taskId, owner.userId],
        ),
      ).rejects.toThrow(/tasks_outcome_check|violates check/i);
    });

    it("rejects status='cancelled' with a NULL outcome", async () => {
      const { taskId } = await createOpenAppointment();
      await conn.query("begin");
      await conn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      await expect(
        conn.query("update tasks set status = 'cancelled' where id = $1", [taskId]),
      ).rejects.toThrow(/tasks_outcome_check|violates check/i);
    });

    it("rejects setting an outcome while the appointment stays open", async () => {
      const { taskId } = await createOpenAppointment();
      await conn.query("begin");
      await conn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      await expect(
        conn.query("update tasks set outcome = 'held' where id = $1", [taskId]),
      ).rejects.toThrow(/tasks_outcome_check|violates check/i);
    });

    it("accepts status='completed' with outcome='held', leaving due_at/end_at untouched (no time-move guard trip)", async () => {
      const { taskId, owner } = await createOpenAppointment();
      const { data: before } = await db
        .from("tasks")
        .select("due_at, end_at")
        .eq("id", taskId)
        .single();

      await conn.query("begin");
      await conn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      const result = await conn.query<{
        status: string;
        outcome: string;
        due_at: Date;
        end_at: Date;
      }>(
        `update tasks
           set status = 'completed', outcome = 'held', completed_at = now(), completed_by = $2
         where id = $1
         returning status, outcome, due_at, end_at`,
        [taskId, owner.userId],
      );
      await conn.query("commit");

      const row = result.rows[0];
      expect(row.status).toBe("completed");
      expect(row.outcome).toBe("held");
      expect(row.due_at.toISOString()).toBe(
        new Date((before as { due_at: string }).due_at).toISOString(),
      );
      expect(row.end_at.toISOString()).toBe(
        new Date((before as { end_at: string }).end_at).toISOString(),
      );
    });

    it("rejects an outcome set on a non-appointment task", async () => {
      const owner = await createUserForOrg(BMH_ORG_ID, "owner");
      const propertyId = await insertProperty();
      const { data, error: taskError } = await insertTask({
        assignee_id: owner.userId,
        created_by: owner.userId,
        related_property_id: propertyId,
      });
      expect(taskError).toBeNull();

      const { error } = await owner.client
        .from("tasks" as never)
        .update({ outcome: "held" } as never)
        .eq("id", data!.id);
      expect(error).not.toBeNull();
      expect((error as { message: string }).message).toMatch(
        /tasks_outcome_check|violates check/i,
      );
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
          end_at: new Date(Date.now() + 7200_000).toISOString(),
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

      // title is untouched by the relation re-checks under test here AND by
      // round-13's appointment lifecycle-state guard (status/outcome/
      // reminder_claimed_at/calendar_generation) — reminder_claimed_at
      // itself no longer works as the "unrelated column" here since it's
      // now lifecycle-owned (see the dedicated guard describe below).
      const { error } = await db
        .from("tasks")
        .update({ title: "Updated title" })
        .eq("id", appt.id);
      expect(error).toBeNull();
    });
  });

  // Round-9: org_id became flatly immutable on UPDATE — the trigger used to
  // revalidate a changed org_id against the new tenant's relations; now it
  // raises before any of that. A personal (unlinked) appointment has no
  // parent FK to fall back on for this guarantee (properties/contacts get
  // theirs from the composite parent FKs below), so this is the only layer
  // protecting it.
  describe("tasks_tenant_integrity_guard — org immutability", () => {
    async function createDualOrgUser() {
      const user = await createUserForOrg(BMH_ORG_ID);
      const { error } = await db.from("memberships").insert({
        user_id: user.userId,
        org_id: TEST_ORG_B_ID,
        role: "member",
      });
      expect(error).toBeNull();
      return user;
    }

    it("rejects an authenticated dual-org member's attempt to move a personal appointment's org_id to their other org", async () => {
      const dualUser = await createDualOrgUser();
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();
      const { data, error: taskError } = await insertTask({
        type: "appointment",
        assignee_id: dualUser.userId,
        created_by: dualUser.userId,
        due_at: dueAt,
        end_at: endAt,
        calendar_chain_id: crypto.randomUUID(),
      });
      expect(taskError).toBeNull();
      const taskId = data!.id;

      const { error } = await dualUser.client
        .from("tasks" as never)
        .update({ org_id: TEST_ORG_B_ID } as never)
        .eq("id", taskId);

      expect(error).not.toBeNull();
      expect((error as { message: string }).message).toMatch(
        /tasks cannot change org/i,
      );

      const { data: after } = await db
        .from("tasks")
        .select("org_id")
        .eq("id", taskId)
        .single();
      expect((after as { org_id: string }).org_id).toBe(BMH_ORG_ID);
    });

    it("rejects a service-role attempt to move a personal appointment's org_id", async () => {
      const appt = await insertValidAppointment();

      const { error } = await db
        .from("tasks")
        .update({ org_id: TEST_ORG_B_ID })
        .eq("id", appt.id);

      expect(error).not.toBeNull();
      expect((error as { message: string }).message).toMatch(
        /tasks cannot change org/i,
      );

      const { data: after } = await db
        .from("tasks")
        .select("org_id")
        .eq("id", appt.id)
        .single();
      expect((after as { org_id: string }).org_id).toBe(BMH_ORG_ID);
    });
  });

  describe("composite parent FKs — properties/contacts (id, org_id)", () => {
    // A dual-org membership is what makes these a meaningful test of the
    // FK at all: without it, RLS rejects TEST_ORG_B_ID writes outright for
    // an ordinary single-org caller and the attempt proves nothing about
    // the constraint added in this migration. With dual membership the
    // caller is plausibly allowed to touch rows scoped to either org, so
    // whichever layer actually stops the org_id move — RLS's WITH CHECK or
    // the composite (id, org_id) FK — the row must not move while a task
    // still references it under its old org_id. That's the guarantee
    // under test; the service-role variants below isolate the FK itself,
    // matching this file's existing convention (CHECK/trigger tests above
    // all assert directly against the service client) for the case where
    // fixtures can't stand up a dual-org authenticated caller.
    async function createDualOrgUser() {
      const user = await createUserForOrg(BMH_ORG_ID);
      const { error } = await db.from("memberships").insert({
        user_id: user.userId,
        org_id: TEST_ORG_B_ID,
        role: "member",
      });
      expect(error).toBeNull();
      return user;
    }

    it("rejects an authenticated dual-org user's attempt to move a referenced property's org_id", async () => {
      const dualUser = await createDualOrgUser();
      const propertyId = await insertProperty(BMH_ORG_ID);
      const { error: taskError } = await insertTask({
        assignee_id: dualUser.userId,
        created_by: dualUser.userId,
        related_property_id: propertyId,
      });
      expect(taskError).toBeNull();

      const { error } = await dualUser.client
        .from("properties" as never)
        .update({ org_id: TEST_ORG_B_ID } as never)
        .eq("id", propertyId);
      expect(error).not.toBeNull();

      const { data: after } = await db
        .from("properties")
        .select("org_id")
        .eq("id", propertyId)
        .single();
      expect((after as { org_id: string }).org_id).toBe(BMH_ORG_ID);
    });

    it("rejects an authenticated dual-org user's attempt to move a referenced contact's org_id", async () => {
      const dualUser = await createDualOrgUser();
      const propertyId = await insertProperty(BMH_ORG_ID);
      const contactId = await insertContact(BMH_ORG_ID);
      const { error: taskError } = await insertTask({
        assignee_id: dualUser.userId,
        created_by: dualUser.userId,
        related_property_id: propertyId,
        contact_id: contactId,
      });
      expect(taskError).toBeNull();

      const { error } = await dualUser.client
        .from("contacts" as never)
        .update({ org_id: TEST_ORG_B_ID } as never)
        .eq("id", contactId);
      expect(error).not.toBeNull();

      const { data: after } = await db
        .from("contacts")
        .select("org_id")
        .eq("id", contactId)
        .single();
      expect((after as { org_id: string }).org_id).toBe(BMH_ORG_ID);
    });

    it("service-role: rejects moving a referenced property's org_id (tasks_related_property_org_fkey)", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const { error: taskError } = await insertTask({
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
      });
      expect(taskError).toBeNull();

      const { error } = await db
        .from("properties")
        .update({ org_id: TEST_ORG_B_ID })
        .eq("id", propertyId);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/foreign key|violates/i);
    });

    it("service-role: rejects moving a referenced contact's org_id (tasks_contact_org_fkey)", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const contactId = await insertContact();
      const { error: taskError } = await insertTask({
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
        contact_id: contactId,
      });
      expect(taskError).toBeNull();

      const { error } = await db
        .from("contacts")
        .update({ org_id: TEST_ORG_B_ID })
        .eq("id", contactId);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/foreign key|violates/i);
    });

    it("deleting a referenced contact nulls only tasks.contact_id — org_id and the row itself survive", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const contactId = await insertContact();
      const { data, error: taskError } = await insertTask({
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
        contact_id: contactId,
      });
      expect(taskError).toBeNull();
      const taskId = data!.id;

      const { error: deleteError } = await db
        .from("contacts")
        .delete()
        .eq("id", contactId);
      expect(deleteError).toBeNull();

      const { data: after } = await db
        .from("tasks")
        .select("id, org_id, contact_id, related_property_id")
        .eq("id", taskId)
        .single();
      expect(after).toBeTruthy();
      const row = after as {
        id: string;
        org_id: string;
        contact_id: string | null;
        related_property_id: string | null;
      };
      expect(row.contact_id).toBeNull();
      expect(row.org_id).toBe(BMH_ORG_ID);
      expect(row.related_property_id).toBe(propertyId);
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

  // Proves the `FOR SHARE OF m` clause in tasks_tenant_integrity_guard()
  // (section 3 of this migration) actually serializes a task
  // insert/reassign against a concurrent membership suspension, rather
  // than both racing through under READ COMMITTED and reading a stale
  // membership snapshot.
  //
  // The Supabase JS client can't hold a transaction open across two
  // separate calls (every PostgREST request auto-commits), so this uses
  // two raw `pg` connections directly against the test project — the same
  // capability `tests/integration/global-setup.ts` already relies on for
  // its advisory-lock session. Each test asserts the second connection is
  // actually BLOCKED (raced against a timeout) before unblocking it, so a
  // regression that drops the lock (silent race instead of serialization)
  // fails loudly instead of just getting lucky on timing.
  //
  // What this proves — and what it does NOT: the trigger's actual contract
  // is ASSIGNMENT-TIME validation against a stable membership snapshot. It
  // does not, and must not, promise that a later suspension is blocked by
  // whatever open tasks that member happens to hold — revocation can never
  // be made blockable by dangling work, or an admin loses the ability to
  // suspend someone until every one of their tasks is manually reassigned
  // first. So "insert wins" (insert committed while a suspension was
  // blocked on the row lock) is a TOLERATED end state: the task keeps
  // pointing at the now-inactive assignee. The system's actual guarantee
  // for that state lives elsewhere — claims skip inactive-assignee tasks,
  // the owner view surfaces them for reassignment, and reassigning to
  // another inactive user still fails outright (asserted below). What this
  // does NOT prove: throughput under real contention, behavior with more
  // than two concurrent writers, or the UPDATE-path (reassign) trigger
  // firing under a live race — only the INSERT path is exercised here for
  // the race itself; the trigger's scope-gate for UPDATE is unconditional
  // on the same FOR SHARE clause, so the same lock behavior applies, but
  // that specific interleaving isn't separately exercised.
  describe("tasks_tenant_integrity_guard — membership-suspension race (raw pg, two connections)", () => {
    let connA: Client;
    let connB: Client;

    beforeEach(async () => {
      connA = new Client({ connectionString: testDbUrl() });
      connB = new Client({ connectionString: testDbUrl() });
      await connA.connect();
      await connB.connect();
      // Same reasoning as global-setup.ts: these connections deliberately
      // hold a transaction open while blocked on a row lock, which could
      // outlast a role-inherited statement_timeout.
      await connA.query("set statement_timeout = 0");
      await connB.query("set statement_timeout = 0");
    });

    afterEach(async () => {
      await connA.query("rollback").catch(() => {});
      await connB.query("rollback").catch(() => {});
      await connA.end().catch(() => {});
      await connB.end().catch(() => {});
    });

    /** Resolves "blocked" if `promise` is still pending after `ms`, else "resolved". Never throws on rejection — the caller awaits `promise` directly afterward for the real assertion. */
    async function stillBlockedAfter(
      promise: Promise<unknown>,
      ms: number,
    ): Promise<"blocked" | "resolved"> {
      const sentinel = Symbol("timeout");
      const raced = await Promise.race([
        promise.catch(() => sentinel),
        new Promise((resolve) => setTimeout(() => resolve(sentinel), ms)).then(
          () => "timeout-won" as const,
        ),
      ]);
      // If the timeout promise resolved first as itself (not via the real
      // promise settling, success or failure), the query is still pending.
      return raced === "timeout-won" ? "blocked" : "resolved";
    }

    it("suspend wins: a suspension committed while an insert is blocked on FOR SHARE fails the insert", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const chainId = crypto.randomUUID();
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();

      await connA.query("begin");
      await connA.query(
        "update memberships set access_status = 'suspended' where user_id = $1 and org_id = $2",
        [assignee.userId, BMH_ORG_ID],
      );
      // connA's UPDATE holds a ROW EXCLUSIVE lock on the membership row
      // until commit/rollback. connB's INSERT fires the trigger, whose
      // `FOR SHARE OF m` must block on that same row.
      const insertPromise = connB.query(
        `insert into tasks
           (org_id, type, status, title, due_at, end_at, assignee_id, created_by, calendar_chain_id)
         values ($1, 'appointment', 'open', 'Race test', $2, $3, $4, $4, $5)
         returning id`,
        [BMH_ORG_ID, dueAt, endAt, assignee.userId, chainId],
      );

      expect(await stillBlockedAfter(insertPromise, 1500)).toBe("blocked");

      // Commit the suspension: connB's blocked FOR SHARE proceeds and now
      // observes access_status = 'suspended' — the trigger must raise.
      await connA.query("commit");

      await expect(insertPromise).rejects.toThrow(/no active membership/i);
    });

    it("insert wins: an insert committed while a suspension is blocked on the row lock leaves the task in the tolerated dangling-assignee state — reassigning it to another inactive user still fails, to an active member still succeeds", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const chainId = crypto.randomUUID();
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();

      await connA.query("begin");
      const insertResult = await connA.query<{ id: string }>(
        `insert into tasks
           (org_id, type, status, title, due_at, end_at, assignee_id, created_by, calendar_chain_id)
         values ($1, 'appointment', 'open', 'Race test', $2, $3, $4, $4, $5)
         returning id`,
        [BMH_ORG_ID, dueAt, endAt, assignee.userId, chainId],
      );
      const taskId = insertResult.rows[0].id;

      // connA's still-open transaction holds the trigger's FOR SHARE lock
      // on the membership row. connB's UPDATE needs ROW EXCLUSIVE on that
      // same row and must block until connA commits or rolls back.
      const suspendPromise = connB.query(
        "update memberships set access_status = 'suspended' where user_id = $1 and org_id = $2",
        [assignee.userId, BMH_ORG_ID],
      );

      expect(await stillBlockedAfter(suspendPromise, 1500)).toBe("blocked");

      await connA.query("commit");
      await suspendPromise; // now unblocks and succeeds

      // The insert committed while the assignee was still active, validated
      // against a stable snapshot at that instant. It must exist, still
      // assigned to that now-suspended member, and the later suspension
      // must have committed cleanly too — the trigger does not, and must
      // not, retroactively block a suspension because of this dangling
      // task. This is the TOLERATED state, not a bug: revocation can never
      // be made blockable by open work.
      const { data, error } = await db
        .from("tasks")
        .select("id, assignee_id")
        .eq("id", taskId)
        .single();
      expect(error).toBeNull();
      expect((data as { assignee_id: string }).assignee_id).toBe(assignee.userId);

      const { data: membership } = await db
        .from("memberships")
        .select("access_status")
        .eq("user_id", assignee.userId)
        .eq("org_id", BMH_ORG_ID)
        .single();
      expect((membership as { access_status: string }).access_status).toBe("suspended");

      // The actual contract for this tolerated state: claims skip
      // inactive-assignee tasks and the owner view surfaces them for
      // reassignment — but reassignment itself is still validated at
      // assignment time. Reassigning to another inactive member must fail
      // exactly like the ordinary (non-race) reassign-to-suspended case;
      // reassigning to an active member must succeed and clear the
      // dangling state.
      //
      // This row is type='appointment' (inserted above for the race), and
      // round 11 added a reassignment guard scoped to exactly that type: a
      // bare assignee_id change on an appointment is rejected outright,
      // active target or not, unless the transaction carries the
      // sandra.allow_appointment_time_move escape hatch. Left unflagged,
      // both updates below would be rejected by that guard instead of by
      // the membership check this test actually exercises — the
      // reassign-to-active assertion would flip from proving membership
      // semantics to (silently) proving the wrong guard. Route both
      // through a flagged raw-pg transaction so the appointment guard is
      // bypassed and only the membership check can reject or allow them.
      const flaggedConn = new Client({ connectionString: testDbUrl() });
      await flaggedConn.connect();
      await flaggedConn.query("set statement_timeout = 0");

      const anotherSuspended = await createUserForOrg(BMH_ORG_ID);
      await setMembershipAccessStatus(anotherSuspended.userId, BMH_ORG_ID, "suspended");

      await flaggedConn.query("begin");
      await flaggedConn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      await expect(
        flaggedConn.query("update tasks set assignee_id = $1 where id = $2", [
          anotherSuspended.userId,
          taskId,
        ]),
      ).rejects.toThrow(/tasks_tenant_integrity_guard: assignee .* has no active membership/i);
      await flaggedConn.query("rollback").catch(() => {});

      const activeReplacement = await createUserForOrg(BMH_ORG_ID);
      await flaggedConn.query("begin");
      await flaggedConn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      const reassignResult = await flaggedConn.query<{ assignee_id: string }>(
        "update tasks set assignee_id = $1 where id = $2 returning assignee_id",
        [activeReplacement.userId, taskId],
      );
      expect(reassignResult.rows[0].assignee_id).toBe(activeReplacement.userId);
      await flaggedConn.query("commit");
      await flaggedConn.end().catch(() => {});

      const { data: reassigned, error: readBackError } = await db
        .from("tasks")
        .select("assignee_id")
        .eq("id", taskId)
        .single();
      expect(readBackError).toBeNull();
      expect((reassigned as { assignee_id: string }).assignee_id).toBe(
        activeReplacement.userId,
      );
    });
  });

  describe("cascade behavior", () => {
    it("deleting a property cascades to its task, then to the task's outbox and ledger rows", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const chainId = crypto.randomUUID();
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();
      const { data: task, error: taskError } = await insertTask({
        type: "appointment",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
        due_at: dueAt,
        end_at: endAt,
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

  // tasks_appointment_delete_guard (round-12): a direct DELETE of an
  // appointment (pg_trigger_depth() = 1) is rejected for every caller —
  // cancellation is lifecycle-owned. Parent-FK cascades fire the same
  // trigger at depth > 1 and must keep working (the property-cascade test
  // above already proves this at the DELETE level; the dedicated case
  // below re-proves it isolated from the outbox/ledger assertions). The
  // `sandra.allow_appointment_time_move` escape hatch (same flag as the
  // time-move/identity/reassignment guards) is the lifecycle RPCs' way in.
  describe("tasks_appointment_delete_guard trigger", () => {
    it.each([
      ["service-role", async () => db],
      [
        "authenticated org member",
        async () => (await createUserForOrg(BMH_ORG_ID, "owner")).client,
      ],
    ] as const)(
      "%s: rejects a direct DELETE of an appointment",
      async (_label, getClient) => {
        const appt = await insertValidAppointment();
        const client = await getClient();

        const { error } = await client
          .from("tasks" as never)
          .delete()
          .eq("id", appt.id);

        expect(error).not.toBeNull();
        expect((error as { message: string }).message).toMatch(
          /appointments are cancelled through the lifecycle, not deleted/i,
        );

        const { data: after } = await db
          .from("tasks")
          .select("id")
          .eq("id", appt.id);
        expect(after).toHaveLength(1);
      },
    );

    it("still allows a property-deletion cascade to remove its appointment (depth > 1 passes)", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();
      const { data: task, error: taskError } = await insertTask({
        type: "appointment",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
        due_at: dueAt,
        end_at: endAt,
        calendar_chain_id: crypto.randomUUID(),
      });
      expect(taskError).toBeNull();

      const { error: deleteError } = await db.from("properties").delete().eq("id", propertyId);
      expect(deleteError).toBeNull();

      const { data: after } = await db.from("tasks").select("id").eq("id", task!.id);
      expect(after).toHaveLength(0);
    });

    it("does not affect a direct DELETE of a non-appointment task", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const { data: task, error: taskError } = await insertTask({
        type: "follow_up",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        related_property_id: propertyId,
      });
      expect(taskError).toBeNull();

      const { error: deleteError } = await db.from("tasks").delete().eq("id", task!.id);
      expect(deleteError).toBeNull();

      const { data: after } = await db.from("tasks").select("id").eq("id", task!.id);
      expect(after).toHaveLength(0);
    });

    // Raw pg connection (same pattern as the other guards' escape hatches):
    // the Supabase JS client auto-commits every request, so it can't hold
    // set_config('...', true) (transaction-local) across the set_config
    // call and the subsequent DELETE in the same transaction.
    describe("escape hatch — sandra.allow_appointment_time_move covers delete too (raw pg, same transaction)", () => {
      let conn: Client;

      beforeEach(async () => {
        conn = new Client({ connectionString: testDbUrl() });
        await conn.connect();
        await conn.query("set statement_timeout = 0");
      });

      afterEach(async () => {
        await conn.query("rollback").catch(() => {});
        await conn.end().catch(() => {});
      });

      it("allows the DELETE (proving PR 3's lifecycle path) once the flag is set to 'on' in the same transaction", async () => {
        const appt = await insertValidAppointment();

        await conn.query("begin");
        await conn.query(
          "select set_config('sandra.allow_appointment_time_move', 'on', true)",
        );
        const result = await conn.query("delete from tasks where id = $1", [appt.id]);
        expect(result.rowCount).toBe(1);
        await conn.query("commit");

        const { data: after } = await db.from("tasks").select("id").eq("id", appt.id);
        expect(after).toHaveLength(0);
      });
    });
  });

  // Round-7 regression: the tenant-integrity trigger used to re-validate
  // ALL relations (including assignee) on any UPDATE, so the contact FK's
  // ON DELETE SET NULL — which only changes contact_id — dragged the
  // assignee re-check along with it. A historical (completed) task whose
  // assignee's membership had since been suspended could no longer have
  // its contact deleted: the SET NULL update would hit the assignee
  // membership check and fail closed, blocking an otherwise-unrelated
  // contact deletion. Scope-gating (only re-validate the relation that
  // actually changed) fixes this — proven directly against the trigger,
  // independent of any application code.
  describe("historical task assignee — contact deletion after membership suspension (round-7 regression)", () => {
    it("deleting a contact succeeds and nulls contact_id even though the task's assignee membership was since suspended", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const contactId = await insertContact(BMH_ORG_ID, "Historical Contact");
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();
      const { data, error: taskError } = await insertTask({
        type: "appointment",
        assignee_id: assignee.userId,
        created_by: assignee.userId,
        contact_id: contactId,
        due_at: dueAt,
        end_at: endAt,
        calendar_chain_id: crypto.randomUUID(),
      });
      expect(taskError).toBeNull();
      const taskId = data!.id;

      // Round-14's trigger INSERT guard rejects a non-canonical creation
      // state outright, so this historical completed+held row can no
      // longer be a bare service-role INSERT (round-9's rewritten
      // tasks_outcome_check already required the outcome; round-14 now
      // also requires the row be born open). Insert open above, then move
      // it to completed/held through a flagged raw-pg transaction — same
      // escape-hatch pattern as every other appointment-owned-facet test
      // in this file.
      const conn = new Client({ connectionString: testDbUrl() });
      await conn.connect();
      await conn.query("set statement_timeout = 0");
      await conn.query("begin");
      await conn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      await conn.query(
        `update tasks
           set status = 'completed', outcome = 'held', completed_at = now(), completed_by = $2
         where id = $1`,
        [taskId, assignee.userId],
      );
      await conn.query("commit");
      await conn.end().catch(() => {});

      await setMembershipAccessStatus(assignee.userId, BMH_ORG_ID, "suspended");

      const { error: deleteError } = await db
        .from("contacts")
        .delete()
        .eq("id", contactId);
      expect(deleteError).toBeNull();

      const { data: after } = await db
        .from("tasks")
        .select("id, contact_id, status, assignee_id, org_id")
        .eq("id", taskId)
        .single();
      expect(after).toBeTruthy();
      const row = after as {
        id: string;
        contact_id: string | null;
        status: string;
        assignee_id: string;
        org_id: string;
      };
      expect(row.contact_id).toBeNull();
      expect(row.status).toBe("completed");
      expect(row.assignee_id).toBe(assignee.userId);
      expect(row.org_id).toBe(BMH_ORG_ID);
    });
  });

  // Appointment time-move guard (section 3 of this migration): moving
  // due_at/end_at on a row whose OLD.type = 'appointment' is lifecycle-owned
  // — only the reschedule RPCs (PR 3) may do it, via the transaction-local
  // `sandra.allow_appointment_time_move` escape hatch. Any other caller,
  // authenticated or service-role, is rejected.
  describe("appointment time-move guard", () => {
    it("rejects a direct due_at update on an appointment via service-role", async () => {
      const appt = await insertValidAppointment();
      const newDueAt = new Date(Date.now() + 10800_000).toISOString();

      const { error } = await db
        .from("tasks")
        .update({ due_at: newDueAt })
        .eq("id", appt.id);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(
        /appointment times move only through the reschedule lifecycle/i,
      );
    });

    it("rejects a direct end_at update on an appointment via an authenticated org member", async () => {
      const owner = await createUserForOrg(BMH_ORG_ID, "owner");
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();
      const { data, error: taskError } = await insertTask({
        type: "appointment",
        assignee_id: owner.userId,
        created_by: owner.userId,
        due_at: dueAt,
        end_at: endAt,
        calendar_chain_id: crypto.randomUUID(),
      });
      expect(taskError).toBeNull();
      const taskId = data!.id;

      const newEndAt = new Date(Date.now() + 10800_000).toISOString();
      const { error } = await owner.client
        .from("tasks" as never)
        .update({ end_at: newEndAt } as never)
        .eq("id", taskId);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(
        /appointment times move only through the reschedule lifecycle/i,
      );
    });

    // Round-13 folded status/outcome/completed_at into the lifecycle-state
    // guard (a separate check further down the same trigger), so this now
    // needs the same sandra.allow_appointment_time_move flag as every other
    // appointment-owned facet — raw pg, same transaction pattern as the
    // escape-hatch describes, since the Supabase JS client can't hold a
    // transaction-local set_config across the set_config and UPDATE calls.
    it("completing an appointment (status/outcome/completed_at) succeeds when flagged, and leaves due_at/end_at untouched", async () => {
      const appt = await insertValidAppointment();
      const { data: before } = await db
        .from("tasks")
        .select("due_at, end_at")
        .eq("id", appt.id)
        .single();

      const conn = new Client({ connectionString: testDbUrl() });
      await conn.connect();
      await conn.query("set statement_timeout = 0");
      await conn.query("begin");
      await conn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      const result = await conn.query<{
        status: string;
        outcome: string;
        due_at: Date;
        end_at: Date;
      }>(
        `update tasks
           set status = 'completed', outcome = 'held', completed_at = now(), completed_by = $2
         where id = $1
         returning status, outcome, due_at, end_at`,
        [appt.id, appt.assigneeId],
      );
      await conn.query("commit");
      await conn.end().catch(() => {});

      const row = result.rows[0];
      expect(row.status).toBe("completed");
      expect(row.outcome).toBe("held");
      expect(row.due_at.toISOString()).toBe(
        new Date((before as { due_at: string }).due_at).toISOString(),
      );
      expect(row.end_at.toISOString()).toBe(
        new Date((before as { end_at: string }).end_at).toISOString(),
      );
    });

    // Raw pg connection (same pattern as the membership-race describe
    // above): the Supabase JS client auto-commits every request, so it
    // can't hold set_config('...', true) (transaction-local) across the
    // set_config call and the subsequent UPDATE in the same transaction.
    describe("escape hatch — sandra.allow_appointment_time_move (raw pg, same transaction)", () => {
      let conn: Client;

      beforeEach(async () => {
        conn = new Client({ connectionString: testDbUrl() });
        await conn.connect();
        await conn.query("set statement_timeout = 0");
      });

      afterEach(async () => {
        await conn.query("rollback").catch(() => {});
        await conn.end().catch(() => {});
      });

      it("allows a due_at move in the same transaction once the flag is set to 'on'", async () => {
        const appt = await insertValidAppointment();
        const newDueAt = new Date(Date.now() + 10800_000).toISOString();

        await conn.query("begin");
        await conn.query(
          "select set_config('sandra.allow_appointment_time_move', 'on', true)",
        );
        // Move end_at with due_at — end_at > due_at is CHECK-enforced, and
        // the real reschedule lifecycle always moves the pair together.
        const newEndAt = new Date(Date.parse(newDueAt) + 1800_000).toISOString();
        const result = await conn.query<{ due_at: Date }>(
          "update tasks set due_at = $1, end_at = $2 where id = $3 returning due_at",
          [newDueAt, newEndAt, appt.id],
        );
        expect(result.rows[0].due_at.toISOString()).toBe(newDueAt);
        await conn.query("commit");

        const { data: after } = await db
          .from("tasks")
          .select("due_at")
          .eq("id", appt.id)
          .single();
        expect(
          new Date((after as { due_at: string }).due_at).toISOString(),
        ).toBe(newDueAt);
      });

      it("the flag is transaction-local — a second, unflagged move in a new transaction still fails", async () => {
        const appt = await insertValidAppointment();
        const firstMove = new Date(Date.now() + 10800_000).toISOString();

        await conn.query("begin");
        await conn.query(
          "select set_config('sandra.allow_appointment_time_move', 'on', true)",
        );
        await conn.query("update tasks set due_at = $1, end_at = $2 where id = $3", [
          firstMove,
          new Date(Date.parse(firstMove) + 1800_000).toISOString(),
          appt.id,
        ]);
        await conn.query("commit");

        const secondMove = new Date(Date.now() + 14400_000).toISOString();
        await expect(
          conn.query("update tasks set due_at = $1, end_at = $2 where id = $3", [
            secondMove,
            new Date(Date.parse(secondMove) + 1800_000).toISOString(),
            appt.id,
          ]),
        ).rejects.toThrow(
          /appointment times move only through the reschedule lifecycle/i,
        );
      });
    });
  });

  // Identity-immutability guard (section 3 of this migration, round 8):
  // closes the gap the time-move guard alone left open. Before this, a
  // caller could flip an appointment's type away from 'appointment'
  // (clearing calendar_chain_id, nulling end_at, attaching a property — all
  // individually legal under the CHECK constraints), and the time-move
  // guard would no longer see OLD.type = 'appointment' on a subsequent
  // due_at move, since the row now reads as an ordinary task. Flipping
  // back afterward would silently resynchronize nothing. The guard fires
  // on any UPDATE that crosses the appointment boundary in either
  // direction, or that changes calendar_chain_id at all — gated behind the
  // same `sandra.allow_appointment_time_move` escape hatch the lifecycle
  // RPCs (PR 3) use.
  describe("appointment identity immutability guard", () => {
    it.each([
      ["service-role", async () => db],
      [
        "authenticated org member",
        async () => (await createUserForOrg(BMH_ORG_ID, "owner")).client,
      ],
    ] as const)(
      "%s: rejects flipping an appointment to type='custom' even while satisfying every other CHECK (property attached, chain and end_at cleared)",
      async (_label, getClient) => {
        const appt = await insertValidAppointment();
        const propertyId = await insertProperty();
        const client = await getClient();

        const { error } = await client
          .from("tasks" as never)
          .update({
            type: "custom",
            calendar_chain_id: null,
            end_at: null,
            related_property_id: propertyId,
          } as never)
          .eq("id", appt.id);

        expect(error).not.toBeNull();
        // Clearing end_at as part of the flip reads as a time change, so
        // the time-move rule can fire before the identity rule — the row is
        // rejected either way; accept both guard messages.
        expect((error as { message: string }).message).toMatch(
          /identity \(type\/calendar chain\) is immutable|times move only through the reschedule lifecycle/i,
        );

        const { data: after } = await db
          .from("tasks")
          .select("type, calendar_chain_id")
          .eq("id", appt.id)
          .single();
        expect((after as { type: string }).type).toBe("appointment");
        expect(
          (after as { calendar_chain_id: string | null }).calendar_chain_id,
        ).toBe(appt.chainId);
      },
    );

    it.each([
      ["service-role", async () => db],
      [
        "authenticated org member",
        async () => (await createUserForOrg(BMH_ORG_ID, "owner")).client,
      ],
    ] as const)(
      "%s: rejects changing calendar_chain_id alone, with type left untouched",
      async (_label, getClient) => {
        const appt = await insertValidAppointment();
        const client = await getClient();

        const { error } = await client
          .from("tasks" as never)
          .update({ calendar_chain_id: crypto.randomUUID() } as never)
          .eq("id", appt.id);

        expect(error).not.toBeNull();
        // Clearing end_at as part of the flip reads as a time change, so
        // the time-move rule can fire before the identity rule — the row is
        // rejected either way; accept both guard messages.
        expect((error as { message: string }).message).toMatch(
          /identity \(type\/calendar chain\) is immutable|times move only through the reschedule lifecycle/i,
        );
      },
    );

    it.each([
      ["service-role", async () => db],
      [
        "authenticated org member",
        async () => (await createUserForOrg(BMH_ORG_ID, "owner")).client,
      ],
    ] as const)(
      "%s: the multi-statement bypass sequence (flip → move due_at → flip back) never gets past the first statement",
      async (_label, getClient) => {
        const appt = await insertValidAppointment();
        const propertyId = await insertProperty();
        const client = await getClient();

        // Statement 1: the flip that, pre-round-8, would have escaped the
        // time-move guard by making the row no longer read as an
        // appointment. It must fail outright — statements 2 and 3 of the
        // attack (moving due_at, flipping back) are never reachable.
        const { error: flipError } = await client
          .from("tasks" as never)
          .update({
            type: "custom",
            calendar_chain_id: null,
            end_at: null,
            related_property_id: propertyId,
          } as never)
          .eq("id", appt.id);
        expect(flipError).not.toBeNull();

        const { data: unchanged } = await db
          .from("tasks")
          .select("type, calendar_chain_id, due_at")
          .eq("id", appt.id)
          .single();
        const row = unchanged as {
          type: string;
          calendar_chain_id: string | null;
          due_at: string;
        };
        expect(row.type).toBe("appointment");
        expect(row.calendar_chain_id).toBe(appt.chainId);

        // Statement 2 attempted anyway: with the row still reading as an
        // appointment, the (separate) time-move guard rejects it too — the
        // bypass gains nothing even if attempted out of order.
        const bypassDueAt = new Date(Date.now() + 10800_000).toISOString();
        const { error: moveError } = await db
          .from("tasks")
          .update({ due_at: bypassDueAt })
          .eq("id", appt.id);
        expect(moveError).not.toBeNull();

        const { data: stillUnchanged } = await db
          .from("tasks")
          .select("due_at")
          .eq("id", appt.id)
          .single();
        expect((stillUnchanged as { due_at: string }).due_at).toBe(row.due_at);
      },
    );

    // Raw pg connection (same pattern as the time-move escape hatch above):
    // the Supabase JS client auto-commits every request, so it can't hold
    // set_config('...', true) (transaction-local) across the set_config
    // call and the subsequent UPDATE in the same transaction.
    describe("escape hatch — sandra.allow_appointment_time_move covers identity too (raw pg, same transaction)", () => {
      let conn: Client;

      beforeEach(async () => {
        conn = new Client({ connectionString: testDbUrl() });
        await conn.connect();
        await conn.query("set statement_timeout = 0");
      });

      afterEach(async () => {
        await conn.query("rollback").catch(() => {});
        await conn.end().catch(() => {});
      });

      it("allows the type flip (proving PR 3's lifecycle path) once the flag is set to 'on' in the same transaction", async () => {
        const appt = await insertValidAppointment();
        const propertyId = await insertProperty();

        await conn.query("begin");
        await conn.query(
          "select set_config('sandra.allow_appointment_time_move', 'on', true)",
        );
        const result = await conn.query<{
          type: string;
          calendar_chain_id: string | null;
        }>(
          `update tasks
             set type = 'custom', calendar_chain_id = null, end_at = null,
                 related_property_id = $1
           where id = $2
           returning type, calendar_chain_id`,
          [propertyId, appt.id],
        );
        expect(result.rows[0].type).toBe("custom");
        expect(result.rows[0].calendar_chain_id).toBeNull();
        await conn.query("commit");

        const { data: after } = await db
          .from("tasks")
          .select("type, calendar_chain_id")
          .eq("id", appt.id)
          .single();
        expect((after as { type: string }).type).toBe("custom");
        expect(
          (after as { calendar_chain_id: string | null }).calendar_chain_id,
        ).toBeNull();
      });
    });
  });

  // Appointment reassignment guard (round 11, section 3 of this migration):
  // a bare assignee_id change on an appointment is lifecycle-owned, same as
  // time moves and identity — the reassign RPC (PR 3) needs to move the
  // Google event between accounts inside the flagged transaction. Every
  // test below reassigns to a freshly created, ACTIVE org member, so the
  // membership check (further down the same trigger) would happily allow
  // the change — the ONLY thing that can reject it is this guard.
  describe("appointment reassignment guard", () => {
    it.each([
      ["service-role", async () => db],
      [
        "authenticated org member",
        async () => (await createUserForOrg(BMH_ORG_ID, "owner")).client,
      ],
    ] as const)(
      "%s: rejects a direct assignee_id update on an appointment even when the target assignee is an active member",
      async (_label, getClient) => {
        const appt = await insertValidAppointment();
        const newAssignee = await createUserForOrg(BMH_ORG_ID);
        const client = await getClient();

        const { error } = await client
          .from("tasks" as never)
          .update({ assignee_id: newAssignee.userId } as never)
          .eq("id", appt.id);

        expect(error).not.toBeNull();
        expect((error as { message: string }).message).toMatch(
          /appointment reassignment goes through the calendar lifecycle/i,
        );

        const { data: after } = await db
          .from("tasks")
          .select("assignee_id")
          .eq("id", appt.id)
          .single();
        expect((after as { assignee_id: string }).assignee_id).toBe(
          appt.assigneeId,
        );
      },
    );

    // Raw pg connection (same pattern as the time-move / identity escape
    // hatches above): the Supabase JS client auto-commits every request, so
    // it can't hold set_config('...', true) (transaction-local) across the
    // set_config call and the subsequent UPDATE in the same transaction.
    describe("escape hatch — sandra.allow_appointment_time_move covers reassignment too (raw pg, same transaction)", () => {
      let conn: Client;

      beforeEach(async () => {
        conn = new Client({ connectionString: testDbUrl() });
        await conn.connect();
        await conn.query("set statement_timeout = 0");
      });

      afterEach(async () => {
        await conn.query("rollback").catch(() => {});
        await conn.end().catch(() => {});
      });

      it("allows the assignee_id change (proving PR 3's lifecycle path) once the flag is set to 'on' in the same transaction", async () => {
        const appt = await insertValidAppointment();
        const newAssignee = await createUserForOrg(BMH_ORG_ID);

        await conn.query("begin");
        await conn.query(
          "select set_config('sandra.allow_appointment_time_move', 'on', true)",
        );
        const result = await conn.query<{ assignee_id: string }>(
          "update tasks set assignee_id = $1 where id = $2 returning assignee_id",
          [newAssignee.userId, appt.id],
        );
        expect(result.rows[0].assignee_id).toBe(newAssignee.userId);
        await conn.query("commit");

        const { data: after } = await db
          .from("tasks")
          .select("assignee_id")
          .eq("id", appt.id)
          .single();
        expect((after as { assignee_id: string }).assignee_id).toBe(
          newAssignee.userId,
        );
      });
    });
  });

  // Appointment lifecycle-state guard (round 13, section 3 of this
  // migration): status/outcome, reminder_claimed_at, and calendar_generation
  // are lifecycle-owned like time/identity/reassignment above — a direct
  // REST write could otherwise close an appointment, suppress its
  // reminders, or fake a calendar version while satisfying every CHECK,
  // bypassing the ledger exactly like the DELETE case. Same
  // sandra.allow_appointment_time_move escape hatch as every other
  // appointment-owned facet; PR 3's RPCs (outcome, claim, reschedule,
  // reassign, cancel) set it transaction-locally.
  describe("appointment lifecycle-state guard (round 13)", () => {
    it.each([
      ["service-role", async () => db],
      [
        "authenticated org member",
        async () => (await createUserForOrg(BMH_ORG_ID, "owner")).client,
      ],
    ] as const)(
      "%s: rejects status='completed'+outcome='held' directly on an appointment",
      async (_label, getClient) => {
        const appt = await insertValidAppointment();
        const client = await getClient();

        const { error } = await client
          .from("tasks" as never)
          .update({
            status: "completed",
            outcome: "held",
            completed_at: new Date().toISOString(),
            completed_by: appt.assigneeId,
          } as never)
          .eq("id", appt.id);

        expect(error).not.toBeNull();
        expect((error as { message: string }).message).toMatch(
          /appointment lifecycle state changes only through the lifecycle/i,
        );

        const { data: after } = await db
          .from("tasks")
          .select("status, outcome")
          .eq("id", appt.id)
          .single();
        expect((after as { status: string }).status).toBe("open");
        expect((after as { outcome: string | null }).outcome).toBeNull();
      },
    );

    it.each([
      ["service-role", async () => db],
      [
        "authenticated org member",
        async () => (await createUserForOrg(BMH_ORG_ID, "owner")).client,
      ],
    ] as const)(
      "%s: rejects a direct reminder_claimed_at update on an appointment",
      async (_label, getClient) => {
        const appt = await insertValidAppointment();
        const client = await getClient();

        const { error } = await client
          .from("tasks" as never)
          .update({ reminder_claimed_at: new Date().toISOString() } as never)
          .eq("id", appt.id);

        expect(error).not.toBeNull();
        expect((error as { message: string }).message).toMatch(
          /appointment lifecycle state changes only through the lifecycle/i,
        );

        const { data: after } = await db
          .from("tasks")
          .select("reminder_claimed_at")
          .eq("id", appt.id)
          .single();
        expect(
          (after as { reminder_claimed_at: string | null }).reminder_claimed_at,
        ).toBeNull();
      },
    );

    it.each([
      ["service-role", async () => db],
      [
        "authenticated org member",
        async () => (await createUserForOrg(BMH_ORG_ID, "owner")).client,
      ],
    ] as const)(
      "%s: rejects a direct calendar_generation bump on an appointment",
      async (_label, getClient) => {
        const appt = await insertValidAppointment();
        const client = await getClient();

        const { error } = await client
          .from("tasks" as never)
          .update({ calendar_generation: 1 } as never)
          .eq("id", appt.id);

        expect(error).not.toBeNull();
        expect((error as { message: string }).message).toMatch(
          /appointment lifecycle state changes only through the lifecycle/i,
        );

        const { data: after } = await db
          .from("tasks")
          .select("calendar_generation")
          .eq("id", appt.id)
          .single();
        expect(
          (after as { calendar_generation: number }).calendar_generation,
        ).toBe(0);
      },
    );

    // Round-15: the trigger's UPDATE branch now folds completed_at,
    // completed_by, and snoozed_until into the same lifecycle-state guard
    // as status/outcome/reminder_claimed_at/calendar_generation — a direct
    // REST write could otherwise forge completion metadata or a snooze
    // deadline while leaving status untouched, satisfying every CHECK and
    // slipping past the round-13 tests above (which only exercise the
    // combined status+outcome+completed_at/by write). Same message, same
    // escape hatch.
    it.each([
      ["service-role", async () => db],
      [
        "authenticated org member",
        async () => (await createUserForOrg(BMH_ORG_ID, "owner")).client,
      ],
    ] as const)(
      "%s: rejects a metadata-only completed_at+completed_by forged update (status untouched)",
      async (_label, getClient) => {
        const appt = await insertValidAppointment();
        const client = await getClient();

        const { error } = await client
          .from("tasks" as never)
          .update({
            completed_at: new Date().toISOString(),
            completed_by: appt.assigneeId,
          } as never)
          .eq("id", appt.id);

        expect(error).not.toBeNull();
        expect((error as { message: string }).message).toMatch(
          /appointment lifecycle state changes only through the lifecycle/i,
        );

        const { data: after } = await db
          .from("tasks")
          .select("status, completed_at, completed_by")
          .eq("id", appt.id)
          .single();
        expect((after as { status: string }).status).toBe("open");
        expect(
          (after as { completed_at: string | null }).completed_at,
        ).toBeNull();
        expect(
          (after as { completed_by: string | null }).completed_by,
        ).toBeNull();
      },
    );

    it.each([
      ["service-role", async () => db],
      [
        "authenticated org member",
        async () => (await createUserForOrg(BMH_ORG_ID, "owner")).client,
      ],
    ] as const)(
      "%s: rejects a metadata-only snoozed_until forged update",
      async (_label, getClient) => {
        const appt = await insertValidAppointment();
        const client = await getClient();

        const { error } = await client
          .from("tasks" as never)
          .update({
            snoozed_until: new Date(Date.now() + 3600_000).toISOString(),
          } as never)
          .eq("id", appt.id);

        expect(error).not.toBeNull();
        expect((error as { message: string }).message).toMatch(
          /appointment lifecycle state changes only through the lifecycle/i,
        );

        const { data: after } = await db
          .from("tasks")
          .select("snoozed_until")
          .eq("id", appt.id)
          .single();
        expect(
          (after as { snoozed_until: string | null }).snoozed_until,
        ).toBeNull();
      },
    );

    // Raw pg connection (same pattern as the other lifecycle-guard escape
    // hatches above): the Supabase JS client auto-commits every request, so
    // it can't hold set_config('...', true) (transaction-local) across the
    // set_config call and the subsequent UPDATE in the same transaction.
    describe("escape hatch — sandra.allow_appointment_time_move covers lifecycle state too (raw pg, same transaction)", () => {
      let conn: Client;

      beforeEach(async () => {
        conn = new Client({ connectionString: testDbUrl() });
        await conn.connect();
        await conn.query("set statement_timeout = 0");
      });

      afterEach(async () => {
        await conn.query("rollback").catch(() => {});
        await conn.end().catch(() => {});
      });

      it("allows status='completed'+outcome='held' (proving PR 3's lifecycle path) once the flag is set to 'on' in the same transaction", async () => {
        const appt = await insertValidAppointment();

        await conn.query("begin");
        await conn.query(
          "select set_config('sandra.allow_appointment_time_move', 'on', true)",
        );
        const result = await conn.query<{ status: string; outcome: string }>(
          `update tasks
             set status = 'completed', outcome = 'held', completed_at = now(), completed_by = $2
           where id = $1
           returning status, outcome`,
          [appt.id, appt.assigneeId],
        );
        expect(result.rows[0].status).toBe("completed");
        expect(result.rows[0].outcome).toBe("held");
        await conn.query("commit");

        const { data: after } = await db
          .from("tasks")
          .select("status, outcome")
          .eq("id", appt.id)
          .single();
        expect((after as { status: string }).status).toBe("completed");
        expect((after as { outcome: string }).outcome).toBe("held");
      });

      it("allows a metadata-only completed_at+completed_by+snoozed_until update once the flag is set to 'on' in the same transaction", async () => {
        const appt = await insertValidAppointment();

        await conn.query("begin");
        await conn.query(
          "select set_config('sandra.allow_appointment_time_move', 'on', true)",
        );
        const result = await conn.query<{
          completed_at: string;
          completed_by: string;
          snoozed_until: string;
        }>(
          `update tasks
             set completed_at = now(),
                 completed_by = $2,
                 snoozed_until = now() + interval '1 hour'
           where id = $1
           returning completed_at, completed_by, snoozed_until`,
          [appt.id, appt.assigneeId],
        );
        expect(result.rows[0].completed_at).not.toBeNull();
        expect(result.rows[0].completed_by).toBe(appt.assigneeId);
        expect(result.rows[0].snoozed_until).not.toBeNull();
        await conn.query("commit");

        const { data: after } = await db
          .from("tasks")
          .select("completed_at, completed_by, snoozed_until")
          .eq("id", appt.id)
          .single();
        expect(
          (after as { completed_at: string }).completed_at,
        ).not.toBeNull();
        expect((after as { completed_by: string }).completed_by).toBe(
          appt.assigneeId,
        );
        expect(
          (after as { snoozed_until: string }).snoozed_until,
        ).not.toBeNull();
      });
    });
  });

  // Round-14: the trigger's INSERT branch (section 3 of this migration)
  // rejects an appointment INSERT that isn't born in canonical creation
  // state — status='open', outcome/reminder_claimed_at/completed_at/
  // completed_by/snoozed_until all NULL, calendar_generation 0 — unless
  // the transaction carries the same sandra.allow_appointment_time_move
  // escape hatch as every UPDATE/DELETE guard above. A forged INSERT
  // (rather than the create-then-UPDATE path exercised elsewhere) would
  // otherwise satisfy every CHECK while skipping the lifecycle RPCs and
  // ledger entirely, on the creation side instead of the mutation side.
  describe("tasks_tenant_integrity_guard — INSERT guard (round 14)", () => {
    function forgedInsertPayload(
      selfId: string,
      overrides: Partial<TablesInsert<"tasks">>,
    ) {
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();
      return {
        org_id: BMH_ORG_ID,
        type: "appointment",
        status: "open",
        title: "Forged insert",
        due_at: dueAt,
        end_at: endAt,
        assignee_id: selfId,
        created_by: selfId,
        calendar_chain_id: crypto.randomUUID(),
        ...overrides,
      };
    }

    async function serviceRoleCase(): Promise<{
      client: typeof db;
      selfId: string;
    }> {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      return { client: db, selfId: assignee.userId };
    }

    async function authenticatedMemberCase(): Promise<{
      client: Awaited<ReturnType<typeof createUserForOrg>>["client"];
      selfId: string;
    }> {
      const self = await createUserForOrg(BMH_ORG_ID, "owner");
      return { client: self.client, selfId: self.userId };
    }

    it.each([
      ["service-role", serviceRoleCase],
      ["authenticated org member", authenticatedMemberCase],
    ] as const)(
      "%s: rejects a forged INSERT with status='completed'+outcome='held'+completed_at/by set",
      async (_label, getCase) => {
        const { client, selfId } = await getCase();
        const { error } = await client
          .from("tasks" as never)
          .insert(
            forgedInsertPayload(selfId, {
              status: "completed",
              outcome: "held",
              completed_at: new Date().toISOString(),
              completed_by: selfId,
            }) as never,
          );
        expect(error).not.toBeNull();
        expect((error as { message: string }).message).toMatch(
          /appointments are created open and unclaimed/i,
        );
      },
    );

    it.each([
      ["service-role", serviceRoleCase],
      ["authenticated org member", authenticatedMemberCase],
    ] as const)(
      "%s: rejects a forged INSERT with reminder_claimed_at set",
      async (_label, getCase) => {
        const { client, selfId } = await getCase();
        const { error } = await client
          .from("tasks" as never)
          .insert(
            forgedInsertPayload(selfId, {
              reminder_claimed_at: new Date().toISOString(),
            }) as never,
          );
        expect(error).not.toBeNull();
        expect((error as { message: string }).message).toMatch(
          /appointments are created open and unclaimed/i,
        );
      },
    );

    it.each([
      ["service-role", serviceRoleCase],
      ["authenticated org member", authenticatedMemberCase],
    ] as const)(
      "%s: rejects a forged INSERT with calendar_generation=5",
      async (_label, getCase) => {
        const { client, selfId } = await getCase();
        const { error } = await client
          .from("tasks" as never)
          .insert(forgedInsertPayload(selfId, { calendar_generation: 5 }) as never);
        expect(error).not.toBeNull();
        expect((error as { message: string }).message).toMatch(
          /appointments are created open and unclaimed/i,
        );
      },
    );

    // Already covered end-to-end by the createTask-shape tests below, but
    // asserted here too for locality with the forged-insert cases above.
    it("accepts a canonical open insert", async () => {
      const appt = await insertValidAppointment();
      expect(appt.id).toBeTruthy();
    });

    // Raw pg connection (same pattern as every other guard's escape
    // hatch): the Supabase JS client auto-commits every request, so it
    // can't hold set_config('...', true) (transaction-local) across the
    // set_config call and the subsequent INSERT in the same transaction.
    it("escape hatch: a flagged raw-pg transaction insert of a terminal appointment succeeds", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();
      const chainId = crypto.randomUUID();

      const conn = new Client({ connectionString: testDbUrl() });
      await conn.connect();
      await conn.query("set statement_timeout = 0");
      await conn.query("begin");
      await conn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      const result = await conn.query<{
        id: string;
        status: string;
        outcome: string;
      }>(
        `insert into tasks
           (org_id, type, status, title, due_at, end_at, assignee_id, created_by,
            calendar_chain_id, outcome, completed_at, completed_by)
         values ($1, 'appointment', 'completed', 'Flagged terminal insert', $2, $3, $4, $4,
                 $5, 'held', now(), $4)
         returning id, status, outcome`,
        [BMH_ORG_ID, dueAt, endAt, assignee.userId, chainId],
      );
      await conn.query("commit");
      await conn.end().catch(() => {});

      expect(result.rows[0].status).toBe("completed");
      expect(result.rows[0].outcome).toBe("held");

      const { data: after } = await db
        .from("tasks")
        .select("status, outcome")
        .eq("id", result.rows[0].id)
        .single();
      expect((after as { status: string }).status).toBe("completed");
      expect((after as { outcome: string }).outcome).toBe("held");
    });
  });

  // createTask (src/lib/tasks/index.ts) builds its insert payload straight
  // from CreateTaskInput, under RLS, as the acting authenticated user — not
  // the service client used everywhere else in this file. These two tests
  // reproduce its exact insert shape end-to-end so a future change to the
  // chain invariant / linkage CHECKs / tenant-integrity trigger that breaks
  // the lib is caught here, not in production.
  describe("createTask insert shape under real RLS", () => {
    it("accepts a contact-only appointment insert shaped exactly like createTask's payload", async () => {
      const self = await createUserForOrg(BMH_ORG_ID);
      const contactId = await insertContact(BMH_ORG_ID, "Appt Contact");
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();

      // Mirrors createTask's insert exactly: related_property_id null,
      // contact_id set, calendar_chain_id generated at creation because
      // type === 'appointment' (the DB chain invariant requires this).
      const { data, error } = await self.client
        .from("tasks" as never)
        .insert({
          org_id: BMH_ORG_ID,
          assignee_id: self.userId,
          related_property_id: null,
          contact_id: contactId,
          type: "appointment",
          title: "Meet at coffee shop",
          description: null,
          due_at: dueAt,
          end_at: endAt,
          calendar_chain_id: crypto.randomUUID(),
          created_by: self.userId,
        } as never)
        .select("id, type, related_property_id, contact_id, calendar_chain_id")
        .single();

      expect(error).toBeNull();
      expect((data as { id: string } | null)?.id).toBeTruthy();
      expect(
        (data as { calendar_chain_id: string | null } | null)?.calendar_chain_id,
      ).toBeTruthy();
      expect(
        (data as { related_property_id: string | null } | null)?.related_property_id,
      ).toBeNull();
      expect((data as { contact_id: string | null } | null)?.contact_id).toBe(contactId);
    });

    it("accepts a legacy follow_up insert shaped like createTask's pre-appointments payload (no chain id)", async () => {
      const self = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const dueAt = new Date(Date.now() + 3600_000).toISOString();

      // Mirrors createTask's insert for a non-appointment type: end_at and
      // calendar_chain_id both null (input.type !== 'appointment'), a
      // property attached (still required for non-appointment types).
      const { data, error } = await self.client
        .from("tasks" as never)
        .insert({
          org_id: BMH_ORG_ID,
          assignee_id: self.userId,
          related_property_id: propertyId,
          contact_id: null,
          type: "follow_up",
          title: "Call back next week",
          description: null,
          due_at: dueAt,
          end_at: null,
          calendar_chain_id: null,
          created_by: self.userId,
        } as never)
        .select("id, type, calendar_chain_id")
        .single();

      expect(error).toBeNull();
      expect((data as { id: string } | null)?.id).toBeTruthy();
      expect(
        (data as { calendar_chain_id: string | null } | null)?.calendar_chain_id,
      ).toBeNull();
    });

    // These three mirror createTask's runtime pre-check (src/lib/tasks/index.ts)
    // against the DB's own bidirectional tasks_end_at_check — proving the two
    // layers agree on shape, exercised here as an authenticated org member
    // (not the service client used by insertTask elsewhere in this file),
    // matching the RLS path createTask actually runs under in production.
    it("rejects an appointment insert with NULL end_at (tasks_end_at_check)", async () => {
      const self = await createUserForOrg(BMH_ORG_ID);
      const dueAt = new Date(Date.now() + 3600_000).toISOString();

      const { error } = await self.client
        .from("tasks" as never)
        .insert({
          org_id: BMH_ORG_ID,
          assignee_id: self.userId,
          related_property_id: null,
          contact_id: null,
          type: "appointment",
          title: "No end time",
          description: null,
          due_at: dueAt,
          end_at: null,
          calendar_chain_id: crypto.randomUUID(),
          created_by: self.userId,
        } as never);

      expect(error).not.toBeNull();
      expect((error as { message: string }).message).toMatch(
        /tasks_end_at_check|violates check/i,
      );
    });

    it("rejects an appointment insert with end_at <= due_at (tasks_end_at_check)", async () => {
      const self = await createUserForOrg(BMH_ORG_ID);
      const dueAt = new Date(Date.now() + 3600_000).toISOString();

      const { error } = await self.client
        .from("tasks" as never)
        .insert({
          org_id: BMH_ORG_ID,
          assignee_id: self.userId,
          related_property_id: null,
          contact_id: null,
          type: "appointment",
          title: "End before start",
          description: null,
          due_at: dueAt,
          end_at: dueAt,
          calendar_chain_id: crypto.randomUUID(),
          created_by: self.userId,
        } as never);

      expect(error).not.toBeNull();
      expect((error as { message: string }).message).toMatch(
        /tasks_end_at_check|violates check/i,
      );
    });

    it("rejects a non-appointment insert carrying end_at (tasks_end_at_check)", async () => {
      const self = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty();
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      const endAt = new Date(Date.now() + 7200_000).toISOString();

      const { error } = await self.client
        .from("tasks" as never)
        .insert({
          org_id: BMH_ORG_ID,
          assignee_id: self.userId,
          related_property_id: propertyId,
          contact_id: null,
          type: "follow_up",
          title: "Follow up with an end_at it shouldn't have",
          description: null,
          due_at: dueAt,
          end_at: endAt,
          calendar_chain_id: null,
          created_by: self.userId,
        } as never);

      expect(error).not.toBeNull();
      expect((error as { message: string }).message).toMatch(
        /tasks_end_at_check|violates check/i,
      );
    });
  });
});
