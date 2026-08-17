import { Client } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";
import { resetTenantTables } from "@tests/integration/reset";
import {
  BMH_ORG_ID,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";

const db = createTestClient();
const createdUserIds: string[] = [];
let assigneeId: string;

function uniquePhone(): string {
  return `+1816${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
}

function testDbUrl(): string {
  const url =
    process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
  if (!url) throw new Error("Missing TEST_SUPABASE_DB_URL");
  return url;
}

async function insertContact(doNotContact = false): Promise<string> {
  const { data, error } = await db
    .from("contacts")
    .insert({
      org_id: BMH_ORG_ID,
      contact_type: "person",
      first_name: "Contact deletion guard",
      phone_1: uniquePhone(),
      phone_1_type: "mobile",
      do_not_contact: doNotContact,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function insertContactAppointment(
  contactId: string,
  relatedPropertyId?: string,
): Promise<string> {
  const dueAt = new Date(Date.now() + 3_600_000).toISOString();
  const { data, error } = await db
    .from("tasks")
    .insert({
      org_id: BMH_ORG_ID,
      type: "appointment",
      status: "open",
      title: "Contact delete guard appointment",
      assignee_id: assigneeId,
      created_by: assigneeId,
      contact_id: contactId,
      related_property_id: relatedPropertyId ?? null,
      due_at: dueAt,
      end_at: new Date(new Date(dueAt).getTime() + 30 * 60_000).toISOString(),
      calendar_chain_id: crypto.randomUUID(),
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function markAppointmentHeld(taskId: string): Promise<void> {
  const conn = new Client({ connectionString: testDbUrl() });
  await conn.connect();
  try {
    await conn.query("begin");
    await conn.query(
      "select set_config('sandra.allow_appointment_time_move', 'on', true)",
    );
    await conn.query(
      `update public.tasks
       set status = 'completed', outcome = 'held',
           completed_at = now(), completed_by = $2
       where id = $1`,
      [taskId, assigneeId],
    );
    await conn.query("commit");
  } catch (error) {
    await conn.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await conn.end();
  }
}

beforeEach(async () => {
  await resetTenantTables(db);
  await seedTwoOrgs(db);
  const assignee = await createOrgUser(db, {
    orgId: BMH_ORG_ID,
    email: `mig20260816110000-${Date.now()}-${crypto.randomUUID()}@bmhgroupkc.com`,
    role: "member",
  });
  assigneeId = assignee.userId;
  createdUserIds.push(assignee.userId);
});

afterEach(async () => {
  await resetTenantTables(db);
  for (const userId of createdUserIds) {
    await db.auth.admin.deleteUser(userId);
  }
  createdUserIds.length = 0;
});

afterAll(async () => {
  await resetTenantTables(db);
});

describe("Migration 20260816110000 — contact delete DNC guard", () => {
  it("allows an unlocked contact delete and performs nested FK SET NULL", async () => {
    const contactId = await insertContact();
    const taskId = await insertContactAppointment(contactId);

    const { error: deleteError } = await db
      .from("contacts")
      .delete()
      .eq("id", contactId);
    expect(deleteError).toBeNull();

    const { data: task, error: taskError } = await db
      .from("tasks")
      .select("contact_id, status")
      .eq("id", taskId)
      .single();
    expect(taskError).toBeNull();
    expect(task).toMatchObject({ contact_id: null, status: "open" });
  });

  it("allows an unlocked contact delete on historical work after the assignee is suspended", async () => {
    const contactId = await insertContact();
    const taskId = await insertContactAppointment(contactId);
    await markAppointmentHeld(taskId);
    expect(
      (
        await db
          .from("memberships")
          .update({ access_status: "suspended" })
          .eq("user_id", assigneeId)
          .eq("org_id", BMH_ORG_ID)
      ).error,
    ).toBeNull();

    const { error: deleteError } = await db
      .from("contacts")
      .delete()
      .eq("id", contactId);
    expect(deleteError).toBeNull();

    const { data: task, error: taskError } = await db
      .from("tasks")
      .select("contact_id, status, assignee_id")
      .eq("id", taskId)
      .single();
    expect(taskError).toBeNull();
    expect(task).toMatchObject({
      contact_id: null,
      status: "completed",
      assignee_id: assigneeId,
    });
  });

  it("rejects deleting a contact-only permanent-DNC record", async () => {
    const contactId = await insertContact(true);
    const { error } = await db.from("contacts").delete().eq("id", contactId);
    expect(error?.message).toMatch(/DNC_LOCKED.*cannot be deleted/i);

    const { data: contact } = await db
      .from("contacts")
      .select("id")
      .eq("id", contactId);
    expect(contact).toHaveLength(1);
  });

  it("rejects directly clearing a task's permanent-DNC contact", async () => {
    const contactId = await insertContact();
    const taskId = await insertContactAppointment(contactId);
    expect(
      (
        await db
          .from("contacts")
          .update({ do_not_contact: true })
          .eq("id", contactId)
      ).error,
    ).toBeNull();

    const { error } = await db
      .from("tasks")
      .update({ contact_id: null })
      .eq("id", taskId);
    expect(error?.message).toMatch(/DNC_LOCKED.*read-only/i);

    const { data: task } = await db
      .from("tasks")
      .select("contact_id")
      .eq("id", taskId)
      .single();
    expect(task?.contact_id).toBe(contactId);
  });

  it("does not let nested FK cleanup bypass a task's locked-property guard", async () => {
    const homeownerContactId = await insertContact();
    const taskContactId = await insertContact();
    const { data: property, error: propertyError } = await db
      .from("properties")
      .insert({
        org_id: BMH_ORG_ID,
        address: `Contact delete guard ${crypto.randomUUID()}`,
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: homeownerContactId,
      })
      .select("id")
      .single();
    expect(propertyError).toBeNull();
    const taskId = await insertContactAppointment(taskContactId, property!.id);
    expect(
      (
        await db
          .from("contacts")
          .update({ do_not_contact: true })
          .eq("id", homeownerContactId)
      ).error,
    ).toBeNull();

    const { error } = await db
      .from("contacts")
      .delete()
      .eq("id", taskContactId);
    expect(error?.message).toMatch(
      /DNC_LOCKED.*related records are read-only/i,
    );

    const { data: contact } = await db
      .from("contacts")
      .select("id")
      .eq("id", taskContactId);
    expect(contact).toHaveLength(1);
    const { data: task } = await db
      .from("tasks")
      .select("contact_id")
      .eq("id", taskId)
      .single();
    expect(task?.contact_id).toBe(taskContactId);
  });
});
