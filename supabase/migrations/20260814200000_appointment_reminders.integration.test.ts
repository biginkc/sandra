import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import {
  BMH_ORG_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import type { Database, TablesInsert } from "@/lib/supabase/types";

// ----------------------------------------------------------------------------
// fn_claim_appointment_reminders / fn_claim_reminder_retries are not (and,
// per this PR's scope, must not be) added to the generated
// Database["public"]["Functions"] map — same local-cast rationale as PR 1/2's
// hand-written RPC signatures.
// ----------------------------------------------------------------------------
type ClaimedReminderRow = {
  delivery_id: string;
  task_id: string;
  org_id: string;
  channel: "bell" | "slack" | "sms";
  attempts: number;
  task_title: string;
  task_due_at: string;
  task_end_at: string | null;
  assignee_id: string;
  assignee_timezone: string;
  assignee_reminder_phone: string | null;
};

type RpcResult<T> = { data: T | null; error: { message: string; code?: string } | null };

type ReminderRpcClient = {
  rpc(fn: "fn_claim_appointment_reminders"): Promise<RpcResult<ClaimedReminderRow[]>>;
  rpc(
    fn: "fn_claim_reminder_retries",
    args: { p_limit: number },
  ): Promise<RpcResult<ClaimedReminderRow[]>>;
};

function asReminderRpcClient(client: SupabaseClient<Database>): ReminderRpcClient {
  return client as unknown as ReminderRpcClient;
}

function claimAppointmentReminders(
  client: SupabaseClient<Database>,
): Promise<RpcResult<ClaimedReminderRow[]>> {
  return asReminderRpcClient(client).rpc("fn_claim_appointment_reminders");
}

function claimReminderRetries(
  client: SupabaseClient<Database>,
  limit = 50,
): Promise<RpcResult<ClaimedReminderRow[]>> {
  return asReminderRpcClient(client).rpc("fn_claim_reminder_retries", { p_limit: limit });
}

const serviceClient = createTestClient();
const db = serviceClient;
const createdUserIds: string[] = [];

/** Unauthenticated PostgREST client (anon role) — no session, no JWT. */
function anonClient(): SupabaseClient<Database> {
  const url = process.env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing TEST_SUPABASE_URL or TEST_SUPABASE_ANON_KEY.");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function uniqueEmail(label: string): string {
  return `mig20260814200000-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
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

async function setPrefs(
  userId: string,
  overrides: {
    slackEnabled?: boolean;
    smsEnabled?: boolean;
    reminderPhone?: string | null;
    timezone?: string;
  } = {},
): Promise<void> {
  type PrefsUpsertClient = {
    from(table: "user_integration_prefs"): {
      upsert(
        rows: {
          user_id: string;
          channel: string;
          enabled?: boolean;
          timezone?: string;
          reminder_phone?: string | null;
        }[],
        options: { onConflict: string },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
  const client = db as unknown as PrefsUpsertClient;
  const rows: {
    user_id: string;
    channel: string;
    enabled?: boolean;
    timezone?: string;
    reminder_phone?: string | null;
  }[] = [
    {
      user_id: userId,
      channel: "google_calendar",
      timezone: overrides.timezone ?? "America/Chicago",
    },
  ];
  if (overrides.slackEnabled !== undefined) {
    rows.push({ user_id: userId, channel: "slack", enabled: overrides.slackEnabled });
  }
  if (overrides.smsEnabled !== undefined || overrides.reminderPhone !== undefined) {
    rows.push({
      user_id: userId,
      channel: "sms_reminder",
      enabled: overrides.smsEnabled ?? false,
      reminder_phone: overrides.reminderPhone ?? null,
    });
  }
  const { error } = await client
    .from("user_integration_prefs")
    .upsert(rows, { onConflict: "user_id,channel" });
  expect(error).toBeNull();
}

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

/** Appointment due `minutesFromNow` from now, defaulting inside the
 *  reminder claim window (15 minutes out). */
async function insertDueAppointment(
  assigneeId: string,
  minutesFromNow = 15,
  overrides: Partial<TablesInsert<"tasks">> = {},
): Promise<{ id: string; chainId: string }> {
  const chainId = crypto.randomUUID();
  const dueAt = new Date(Date.now() + minutesFromNow * 60_000);
  const endAt = new Date(dueAt.getTime() + 1_800_000);
  const { data, error } = await insertTask({
    type: "appointment",
    assignee_id: assigneeId,
    created_by: assigneeId,
    org_id: BMH_ORG_ID,
    title: "Walkthrough with seller",
    due_at: dueAt.toISOString(),
    end_at: endAt.toISOString(),
    calendar_chain_id: chainId,
    ...overrides,
  });
  expect(error).toBeNull();
  return { id: data!.id, chainId };
}

beforeAll(async () => {
  await seedTwoOrgs(serviceClient);
});

beforeEach(async () => {
  await resetTenantTables(serviceClient);
});

afterEach(async () => {
  await resetTenantTables(serviceClient);
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
  await resetTenantTables(serviceClient);
});

describe("Migration 20260814200000 — appointment reminder claim RPCs", () => {
  describe("privileges", () => {
    it("rejects an anon call to fn_claim_appointment_reminders", async () => {
      const { error } = await claimAppointmentReminders(anonClient());
      expect(error).not.toBeNull();
    });

    it("rejects an authenticated (non-service-role) call to fn_claim_appointment_reminders", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      const { error } = await claimAppointmentReminders(member.client);
      expect(error).not.toBeNull();
    });

    it("rejects an authenticated call to fn_claim_reminder_retries", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      const { error } = await claimReminderRetries(member.client);
      expect(error).not.toBeNull();
    });
  });

  describe("window bounds", () => {
    it("claims an appointment due inside [now, now+30m] and stamps reminder_claimed_at", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, 15);

      const { data, error } = await claimAppointmentReminders(db);
      expect(error).toBeNull();
      const rows = (data ?? []).filter((r) => r.task_id === appt.id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.channel === "bell")).toBe(true);

      const { data: task } = await db
        .from("tasks")
        .select("reminder_claimed_at")
        .eq("id", appt.id)
        .single();
      expect(task?.reminder_claimed_at).not.toBeNull();
    });

    it("does not claim an appointment due more than 30 minutes out", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, 45);

      const { data, error } = await claimAppointmentReminders(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.task_id === appt.id)).toBe(false);

      const { data: task } = await db
        .from("tasks")
        .select("reminder_claimed_at")
        .eq("id", appt.id)
        .single();
      expect(task?.reminder_claimed_at).toBeNull();
    });

    it("does not claim an appointment whose due_at has already passed (no late reminders)", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, -10);

      const { data, error } = await claimAppointmentReminders(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.task_id === appt.id)).toBe(false);
    });
  });

  describe("inactive-assignee skip", () => {
    it("skips (never claims) an appointment whose assignee has no active membership", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, 10);
      await setMembershipAccessStatus(member.userId, BMH_ORG_ID, "suspended");

      const { data, error } = await claimAppointmentReminders(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.task_id === appt.id)).toBe(false);

      const { data: task } = await db
        .from("tasks")
        .select("reminder_claimed_at")
        .eq("id", appt.id)
        .single();
      expect(task?.reminder_claimed_at).toBeNull();
    });
  });

  describe("channel selection", () => {
    it("always includes bell, adds slack when enabled, adds sms only when enabled AND a phone is on file", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId, {
        slackEnabled: true,
        smsEnabled: true,
        reminderPhone: "+18165551234",
      });
      const appt = await insertDueAppointment(member.userId, 5);

      const { data, error } = await claimAppointmentReminders(db);
      expect(error).toBeNull();
      const channels = (data ?? [])
        .filter((r) => r.task_id === appt.id)
        .map((r) => r.channel)
        .sort();
      expect(channels).toEqual(["bell", "slack", "sms"]);
    });

    it("omits sms when enabled but no reminder_phone is on file (fail-closed)", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId, { smsEnabled: false, reminderPhone: null });
      const appt = await insertDueAppointment(member.userId, 5);

      const { data, error } = await claimAppointmentReminders(db);
      expect(error).toBeNull();
      const channels = (data ?? [])
        .filter((r) => r.task_id === appt.id)
        .map((r) => r.channel);
      expect(channels).not.toContain("sms");
    });

    it("omits every optional channel when the assignee has no prefs row at all", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      // No setPrefs call — assignee has zero user_integration_prefs rows.
      const appt = await insertDueAppointment(member.userId, 5);

      const { data, error } = await claimAppointmentReminders(db);
      expect(error).toBeNull();
      const channels = (data ?? [])
        .filter((r) => r.task_id === appt.id)
        .map((r) => r.channel);
      expect(channels).toEqual(["bell"]);
    });
  });

  describe("ON CONFLICT dedupe", () => {
    it("a second claim call never re-inserts delivery rows for an already-claimed appointment", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, 10);

      const first = await claimAppointmentReminders(db);
      expect(first.error).toBeNull();
      expect((first.data ?? []).some((r) => r.task_id === appt.id)).toBe(true);

      // Second call: reminder_claimed_at is already set, so the appointment
      // is no longer a claim candidate at all — proves the claim (not just
      // the insert) is idempotent.
      const second = await claimAppointmentReminders(db);
      expect(second.error).toBeNull();
      expect((second.data ?? []).some((r) => r.task_id === appt.id)).toBe(false);

      const { data: deliveries } = await db
        .from("task_reminder_deliveries")
        .select("id")
        .eq("task_id", appt.id);
      expect(deliveries?.length).toBe(1);
    });
  });

  describe("flag interaction with the tenant-integrity trigger", () => {
    it("stamping reminder_claimed_at succeeds without a direct authenticated write ever being allowed", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, 10);

      // The RPC succeeds (proves it set the transaction-local flag before
      // its own UPDATE — otherwise trg_tasks_tenant_integrity_guard would
      // reject the reminder_claimed_at change outright).
      const { error: claimError } = await claimAppointmentReminders(db);
      expect(claimError).toBeNull();

      // A direct authenticated UPDATE of reminder_claimed_at, outside any
      // RPC, must still be rejected by the trigger — the flag is
      // transaction-local to the RPC's own call, never ambient.
      const otherAppt = await insertDueAppointment(member.userId, 12);
      const { error: directError } = await member.client
        .from("tasks")
        .update({ reminder_claimed_at: new Date().toISOString() })
        .eq("id", otherAppt.id);
      expect(directError).not.toBeNull();
    });
  });

  describe("fn_claim_reminder_retries", () => {
    it("selects a failed delivery with attempts < 3 and skips one at attempts >= 3", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, 10);
      await claimAppointmentReminders(db);

      const { data: delivery } = await db
        .from("task_reminder_deliveries")
        .select("id")
        .eq("task_id", appt.id)
        .eq("channel", "bell")
        .single();
      expect(delivery).not.toBeNull();

      await db
        .from("task_reminder_deliveries")
        .update({ status: "failed", attempts: 2 })
        .eq("id", delivery!.id);

      const eligible = await claimReminderRetries(db);
      expect(eligible.error).toBeNull();
      expect((eligible.data ?? []).some((r) => r.delivery_id === delivery!.id)).toBe(true);

      await db
        .from("task_reminder_deliveries")
        .update({ attempts: 3 })
        .eq("id", delivery!.id);

      const exhausted = await claimReminderRetries(db);
      expect(exhausted.error).toBeNull();
      expect((exhausted.data ?? []).some((r) => r.delivery_id === delivery!.id)).toBe(false);
    });

    it("selects a pending delivery stuck for more than 10 minutes (crashed sweep)", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, 10);
      await claimAppointmentReminders(db);

      const { data: delivery } = await db
        .from("task_reminder_deliveries")
        .select("id")
        .eq("task_id", appt.id)
        .eq("channel", "bell")
        .single();

      await db
        .from("task_reminder_deliveries")
        .update({ created_at: new Date(Date.now() - 11 * 60_000).toISOString() })
        .eq("id", delivery!.id);

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.delivery_id === delivery!.id)).toBe(true);
    });

    it("does not select a still-fresh pending delivery", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, 10);
      await claimAppointmentReminders(db);

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      const rows = (data ?? []).filter((r) => r.task_id === appt.id);
      expect(rows.length).toBe(0);
    });
  });
});
