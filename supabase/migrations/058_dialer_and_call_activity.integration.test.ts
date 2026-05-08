import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

type OrgUser = Awaited<ReturnType<typeof createOrgUser>>;

function uniqueEmail(label: string): string {
  return `mig058-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}@bmhgroupkc.com`;
}

function uniquePhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

async function createUserForOrg(orgId: string): Promise<OrgUser> {
  const user = await createOrgUser(serviceClient, {
    orgId,
    email: uniqueEmail(orgId.slice(-3)),
    role: "member",
  });
  createdUserIds.push(user.userId);
  return user;
}

async function expectSelectable(table: string, columns: string): Promise<void> {
  const { error } = await (serviceClient as any)
    .from(table as never)
    .select(columns)
    .limit(0);
  expect(error).toBeNull();
}

async function expectColumnMissing(table: string, column: string): Promise<void> {
  const { error } = await (serviceClient as any)
    .from(table as never)
    .select(column)
    .limit(0);
  expect(error).not.toBeNull();
  expect(error?.message).toMatch(/column|schema cache|could not find/i);
}

async function insertContact(orgId = BMH_ORG_ID): Promise<string> {
  const { data, error } = await (serviceClient as any)
    .from("contacts" as never)
    .insert({
      org_id: orgId,
      contact_type: "person",
      first_name: "Migration",
      last_name: "Dialer",
      phone_1: uniquePhone(),
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

async function insertProperty(orgId = BMH_ORG_ID, contactId?: string): Promise<string> {
  const { data, error } = await (serviceClient as any)
    .from("properties" as never)
    .insert({
      org_id: orgId,
      address: `058 Dialer ${crypto.randomUUID()}`,
      state: "MO",
      status: "new_lead",
      homeowner_contact_id: contactId ?? null,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

async function insertBatch(orgId = BMH_ORG_ID): Promise<string> {
  const { data, error } = await (serviceClient as any)
    .from("dialer_batches" as never)
    .insert({
      org_id: orgId,
      title: "Migration 058 batch",
      source_kind: "selected_ids",
      source_meta: { test: true },
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

async function insertBatchItem(orgId = BMH_ORG_ID): Promise<{
  id: string;
  propertyId: string;
  contactId: string;
}> {
  const contactId = await insertContact(orgId);
  const propertyId = await insertProperty(orgId, contactId);
  const batchId = await insertBatch(orgId);
  const { data, error } = await (serviceClient as any)
    .from("dialer_batch_items" as never)
    .insert({
      batch_id: batchId,
      property_id: propertyId,
      contact_id: contactId,
      phone_e164: uniquePhone(),
      phone_label: "homeowner.phone_1",
      state: "MO",
      timezone: "America/Chicago",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { id: (data as { id: string }).id, propertyId, contactId };
}

async function insertActivity(orgId = BMH_ORG_ID): Promise<{
  id: string;
  propertyId: string;
  contactId: string;
}> {
  const item = await insertBatchItem(orgId);
  const { data, error } = await (serviceClient as any)
    .from("call_activities" as never)
    .insert({
      org_id: orgId,
      property_id: item.propertyId,
      contact_id: item.contactId,
      dialer_batch_item_id: item.id,
      jitter_attempt_id: crypto.randomUUID(),
      provider: "jitter",
      outcome: "no_answer",
      updated_at: "2000-01-01T00:00:00.000Z",
    })
    .select("id, property_id, contact_id")
    .single();
  expect(error).toBeNull();
  const row = data as { id: string; property_id: string; contact_id: string };
  return { id: row.id, propertyId: row.property_id, contactId: row.contact_id };
}

function migrationSql(): string {
  return fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/058_dialer_and_call_activity.sql"),
    "utf8",
  );
}

beforeAll(async () => {
  await seedTwoOrgs(serviceClient);
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
  await resetTenantTables(serviceClient);
});

describe("Migration 058 — dialer + call activity", () => {
  it("creates dialer_batches table with expected columns", async () => {
    await expectSelectable(
      "dialer_batches",
      "id, org_id, title, source_kind, source_meta, status, created_by_user_id, jitter_session_id, claimed_at, completed_at, created_at, updated_at",
    );
  });

  it("creates dialer_batch_items table with locked identity columns only", async () => {
    await expectSelectable(
      "dialer_batch_items",
      "id, batch_id, property_id, contact_id, phone_e164, phone_label, state, timezone, calling_window_start_hour, calling_window_end_hour, sort_order, status, last_call_activity_id, created_at, updated_at",
    );
    for (const column of [
      "eligible",
      "do_not_contact",
      "sms_opted_out",
      "suppression_snapshot",
      "last_eligibility_check_at",
      "is_in_window",
    ]) {
      await expectColumnMissing("dialer_batch_items", column);
    }
  });

  it("creates call_activities table with attempt-grain columns", async () => {
    await expectSelectable(
      "call_activities",
      "id, org_id, property_id, contact_id, dialer_batch_item_id, jitter_attempt_id, jitter_session_id, operator_user_id, started_at, ended_at, duration_seconds, outcome, disposition, do_not_call_requested, provider_call_id, provider, recording_status, transcript_status, error_code, error_message, raw_event_count, created_at, updated_at",
    );

    const item = await insertBatchItem();
    const attemptId = crypto.randomUUID();
    const payload = {
      org_id: BMH_ORG_ID,
      property_id: item.propertyId,
      contact_id: item.contactId,
      dialer_batch_item_id: item.id,
      jitter_attempt_id: attemptId,
      provider: "jitter",
    };
    const first = await (serviceClient as any)
      .from("call_activities" as never)
      .insert(payload);
    expect(first.error).toBeNull();
    const second = await (serviceClient as any)
      .from("call_activities" as never)
      .insert(payload);
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toMatch(/duplicate|unique/i);
  });

  it("creates call_recordings table linked to call_activities", async () => {
    const activity = await insertActivity();
    const { error } = await (serviceClient as any)
      .from("call_recordings" as never)
      .insert({
        call_activity_id: activity.id,
        status: "pending",
        storage_path: "calls/test.wav",
        duration_seconds: 12,
      });
    expect(error).toBeNull();
    await expectSelectable(
      "call_recordings",
      "id, call_activity_id, status, storage_path, duration_seconds, error_code, error_message, created_at, updated_at",
    );
  });

  it("creates call_transcripts table linked to call_activities", async () => {
    const activity = await insertActivity();
    const { error } = await (serviceClient as any)
      .from("call_transcripts" as never)
      .insert({
        call_activity_id: activity.id,
        status: "pending",
        text: "hello",
        language: "en",
      });
    expect(error).toBeNull();
    await expectSelectable(
      "call_transcripts",
      "id, call_activity_id, status, text, language, error_code, error_message, created_at, updated_at",
    );
  });

  it("widens webhook_consumers.consumer_type to include jitter_writeback", async () => {
    const { error } = await (serviceClient as any)
      .from("webhook_consumers" as never)
      .insert({
        name: `jitter-writeback-${crypto.randomUUID()}`,
        secret_hash: crypto.randomUUID().replaceAll("-", ""),
        consumer_type: "jitter_writeback",
        default_source: null,
        enabled: true,
      });
    expect(error).toBeNull();
  });

  it("isolates dialer_batches across orgs via RLS", async () => {
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID);
    const batchId = await insertBatch(BMH_ORG_ID);
    const { data, error } = await clientForUser(orgBUser.jwt)
      .from("dialer_batches" as never)
      .select("id")
      .eq("id", batchId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("isolates dialer_batch_items across orgs via RLS", async () => {
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID);
    const item = await insertBatchItem(BMH_ORG_ID);
    const { data, error } = await clientForUser(orgBUser.jwt)
      .from("dialer_batch_items" as never)
      .select("id")
      .eq("id", item.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("isolates call_activities across orgs via RLS", async () => {
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID);
    const activity = await insertActivity(BMH_ORG_ID);
    const { data, error } = await clientForUser(orgBUser.jwt)
      .from("call_activities" as never)
      .select("id")
      .eq("id", activity.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("isolates call_recordings across orgs via RLS", async () => {
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID);
    const activity = await insertActivity(BMH_ORG_ID);
    const { data: recording } = await (serviceClient as any)
      .from("call_recordings" as never)
      .insert({ call_activity_id: activity.id, status: "pending" })
      .select("id")
      .single();
    const { data, error } = await clientForUser(orgBUser.jwt)
      .from("call_recordings" as never)
      .select("id")
      .eq("id", (recording as { id: string }).id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("isolates call_transcripts across orgs via RLS", async () => {
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID);
    const activity = await insertActivity(BMH_ORG_ID);
    const { data: transcript } = await (serviceClient as any)
      .from("call_transcripts" as never)
      .insert({ call_activity_id: activity.id, status: "pending" })
      .select("id")
      .single();
    const { data, error } = await clientForUser(orgBUser.jwt)
      .from("call_transcripts" as never)
      .select("id")
      .eq("id", (transcript as { id: string }).id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("publishes call_activities on supabase_realtime", () => {
    expect(migrationSql()).toContain(
      "alter publication supabase_realtime add table public.call_activities",
    );
  });

  it("does NOT publish dialer_batches/dialer_batch_items/call_recordings/call_transcripts on supabase_realtime", () => {
    const sql = migrationSql();
    for (const table of [
      "dialer_batches",
      "dialer_batch_items",
      "call_recordings",
      "call_transcripts",
    ]) {
      expect(sql).not.toContain(
        `alter publication supabase_realtime add table public.${table}`,
      );
    }
  });

  it("dialer_batch_items.last_call_activity_id has FK to call_activities(id) ON DELETE SET NULL", async () => {
    const item = await insertBatchItem();
    const { error } = await (serviceClient as any)
      .from("dialer_batch_items" as never)
      .update({ last_call_activity_id: crypto.randomUUID() })
      .eq("id", item.id);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/foreign key|violates/i);
    expect(migrationSql()).toContain("dialer_batch_items_last_call_activity_id_fkey");
    expect(migrationSql()).toContain("on delete set null");
  });

  it("call_recordings INSERT bumps parent call_activities.recording_status and updated_at via trigger", async () => {
    const activity = await insertActivity();
    const { data: before } = await (serviceClient as any)
      .from("call_activities" as never)
      .select("updated_at")
      .eq("id", activity.id)
      .single();
    const { error } = await (serviceClient as any)
      .from("call_recordings" as never)
      .insert({ call_activity_id: activity.id, status: "pending" });
    expect(error).toBeNull();
    const { data: after } = await (serviceClient as any)
      .from("call_activities" as never)
      .select("recording_status, updated_at")
      .eq("id", activity.id)
      .single();
    expect((after as { recording_status: string }).recording_status).toBe("pending");
    expect(new Date((after as { updated_at: string }).updated_at).getTime()).toBeGreaterThan(
      new Date((before as { updated_at: string }).updated_at).getTime(),
    );
  });

  it("call_recordings UPDATE bumps parent call_activities.recording_status and updated_at via trigger", async () => {
    const activity = await insertActivity();
    const { data: recording } = await (serviceClient as any)
      .from("call_recordings" as never)
      .insert({ call_activity_id: activity.id, status: "pending" })
      .select("id")
      .single();
    const { data: before } = await (serviceClient as any)
      .from("call_activities" as never)
      .select("updated_at")
      .eq("id", activity.id)
      .single();
    await delay(25);
    const { error } = await (serviceClient as any)
      .from("call_recordings" as never)
      .update({ status: "available" })
      .eq("id", (recording as { id: string }).id);
    expect(error).toBeNull();
    const { data: after } = await (serviceClient as any)
      .from("call_activities" as never)
      .select("recording_status, updated_at")
      .eq("id", activity.id)
      .single();
    expect((after as { recording_status: string }).recording_status).toBe("available");
    expect(new Date((after as { updated_at: string }).updated_at).getTime()).toBeGreaterThan(
      new Date((before as { updated_at: string }).updated_at).getTime(),
    );
  });

  it("call_transcripts INSERT bumps parent call_activities.transcript_status and updated_at via trigger", async () => {
    const activity = await insertActivity();
    const { data: before } = await (serviceClient as any)
      .from("call_activities" as never)
      .select("updated_at")
      .eq("id", activity.id)
      .single();
    const { error } = await (serviceClient as any)
      .from("call_transcripts" as never)
      .insert({ call_activity_id: activity.id, status: "pending" });
    expect(error).toBeNull();
    const { data: after } = await (serviceClient as any)
      .from("call_activities" as never)
      .select("transcript_status, updated_at")
      .eq("id", activity.id)
      .single();
    expect((after as { transcript_status: string }).transcript_status).toBe("pending");
    expect(new Date((after as { updated_at: string }).updated_at).getTime()).toBeGreaterThan(
      new Date((before as { updated_at: string }).updated_at).getTime(),
    );
  });

  it("call_transcripts UPDATE bumps parent call_activities.transcript_status and updated_at via trigger", async () => {
    const activity = await insertActivity();
    const { data: transcript } = await (serviceClient as any)
      .from("call_transcripts" as never)
      .insert({ call_activity_id: activity.id, status: "pending" })
      .select("id")
      .single();
    const { data: before } = await (serviceClient as any)
      .from("call_activities" as never)
      .select("updated_at")
      .eq("id", activity.id)
      .single();
    await delay(25);
    const { error } = await (serviceClient as any)
      .from("call_transcripts" as never)
      .update({ status: "available" })
      .eq("id", (transcript as { id: string }).id);
    expect(error).toBeNull();
    const { data: after } = await (serviceClient as any)
      .from("call_activities" as never)
      .select("transcript_status, updated_at")
      .eq("id", activity.id)
      .single();
    expect((after as { transcript_status: string }).transcript_status).toBe("available");
    expect(new Date((after as { updated_at: string }).updated_at).getTime()).toBeGreaterThan(
      new Date((before as { updated_at: string }).updated_at).getTime(),
    );
  });
});
