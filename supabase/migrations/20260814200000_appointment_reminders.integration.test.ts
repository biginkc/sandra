import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";
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
/** Codex round 2: fn_claim_appointment_reminders now mints a claim_token +
 *  2-minute lease (next_attempt_at) on every row it inserts, same as
 *  fn_claim_reminder_retries always has — both RPCs return this same
 *  fencing-complete shape. */
type ClaimedReminderRow = {
  delivery_id: string;
  task_id: string;
  org_id: string;
  channel: "bell" | "slack" | "sms";
  attempts: number;
  claim_token: string;
  claimed_status: "pending" | "failed";
  task_title: string;
  task_due_at: string;
  task_end_at: string | null;
  assignee_id: string;
  assignee_timezone: string;
  assignee_reminder_phone: string | null;
  /** Codex round 4 (finding 3): only `fn_claim_reminder_retries` returns
   *  this — non-null means a prior attempt already reached the provider
   *  before crashing on its own mark-sent write; absent (undefined) on
   *  every `fn_claim_appointment_reminders` row, which shares this same
   *  row shape in this test file's RPC typing. */
  provider_message_id?: string | null;
};

type RpcResult<T> = { data: T | null; error: { message: string; code?: string } | null };

type ReminderRpcClient = {
  rpc(
    fn: "fn_claim_appointment_reminders",
    args?: { p_limit: number },
  ): Promise<RpcResult<ClaimedReminderRow[]>>;
  rpc(
    fn: "fn_claim_reminder_retries",
    args: { p_limit: number },
  ): Promise<RpcResult<ClaimedReminderRow[]>>;
};

function asReminderRpcClient(client: SupabaseClient<Database>): ReminderRpcClient {
  return client as unknown as ReminderRpcClient;
}

/** Codex round 3 (finding 1): fn_claim_appointment_reminders now takes
 *  `p_limit` (default 1, matching the sweep route's one-appointment-at-a-
 *  time claim loop). Omitting `limit` here keeps every pre-existing
 *  single-appointment test unchanged (default 1 claims that one
 *  appointment); tests exercising the limit itself pass it explicitly. */
function claimAppointmentReminders(
  client: SupabaseClient<Database>,
  limit?: number,
): Promise<RpcResult<ClaimedReminderRow[]>> {
  return asReminderRpcClient(client).rpc(
    "fn_claim_appointment_reminders",
    limit === undefined ? undefined : { p_limit: limit },
  );
}

function claimReminderRetries(
  client: SupabaseClient<Database>,
  limit = 50,
): Promise<RpcResult<ClaimedReminderRow[]>> {
  return asReminderRpcClient(client).rpc("fn_claim_reminder_retries", { p_limit: limit });
}

/** `claim_token` / `next_attempt_at` are added by this migration but, per
 *  its own scope, must not be added to the generated
 *  `Database["public"]["Tables"]` map yet (same rationale as the RPC row
 *  shapes above) — so direct writes/reads/`.eq()` filters on those columns
 *  need this local cast, same idiom as `create-worker.ts`'s
 *  `LedgerLeaseUpdateClient` / reminders.ts's `DeliveryUpdateClient`. */
type FencedDeliveryUpdateBuilder = {
  eq(column: "id" | "claim_token" | "status", value: string): FencedDeliveryUpdateBuilder;
  select(columns: "id"): PromiseLike<{
    data: { id: string }[] | null;
    error: { message: string } | null;
  }>;
};
type ReminderDeliveryFencingClient = {
  from(table: "task_reminder_deliveries"): {
    update(values: {
      status?: string;
      attempts?: number;
      sent_at?: string | null;
      created_at?: string;
      next_attempt_at?: string | null;
      /** Codex round 12 (finding 2): also not yet in the generated
       *  Database["public"]["Tables"] map — same local-cast rationale. */
      dispatching_at?: string | null;
    }): FencedDeliveryUpdateBuilder;
    select(columns: "status, claim_token"): {
      eq(column: "id", value: string): {
        single(): Promise<{
          data: { status: string; claim_token: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};
function asReminderDeliveryFencingClient(
  client: SupabaseClient<Database>,
): ReminderDeliveryFencingClient {
  return client as unknown as ReminderDeliveryFencingClient;
}

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
      // Explicit: PostgREST bulk upserts unify columns across rows, so when
      // a slack/sms row in the same payload carries `enabled`, omitting it
      // here sends NULL (not the column default) and violates NOT NULL.
      enabled: true,
      timezone: overrides.timezone ?? "America/Chicago",
    },
  ];
  // Every row carries explicit enabled + timezone for the same
  // column-unification reason as above (timezone is NOT NULL).
  if (overrides.slackEnabled !== undefined) {
    rows.push({
      user_id: userId,
      channel: "slack",
      enabled: overrides.slackEnabled,
      timezone: overrides.timezone ?? "America/Chicago",
    });
  }
  if (overrides.smsEnabled !== undefined || overrides.reminderPhone !== undefined) {
    rows.push({
      user_id: userId,
      channel: "sms_reminder",
      enabled: overrides.smsEnabled ?? false,
      timezone: overrides.timezone ?? "America/Chicago",
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

  // Codex round 3 (finding 1): the sweep route now calls this RPC with
  // p_limit=1 in a budget-checked loop instead of one unbounded call — see
  // the route's own module comment and the migration header block above.
  describe("p_limit — one appointment claimed at a time", () => {
    it("p_limit bounds how many due appointments a single call claims, oldest due_at first", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const soonest = await insertDueAppointment(member.userId, 5);
      const later = await insertDueAppointment(member.userId, 20);

      const { data, error } = await claimAppointmentReminders(db, 1);
      expect(error).toBeNull();
      const taskIds = new Set((data ?? []).map((r) => r.task_id));
      expect(taskIds.has(soonest.id)).toBe(true);
      expect(taskIds.has(later.id)).toBe(false);

      const { data: laterTask } = await db
        .from("tasks")
        .select("reminder_claimed_at")
        .eq("id", later.id)
        .single();
      // Left UNCLAIMED, not claimed-but-undelivered — reminder_claimed_at
      // still null, so this appointment is still a live candidate.
      expect(laterTask?.reminder_claimed_at).toBeNull();
    });

    it("near-due overflow left unclaimed by a limited call is claimed by the very next call (stands in for the next sweep, still inside the 30-minute window)", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const first = await insertDueAppointment(member.userId, 5);
      const overflow = await insertDueAppointment(member.userId, 25);

      const sweepOne = await claimAppointmentReminders(db, 1);
      expect(sweepOne.error).toBeNull();
      expect((sweepOne.data ?? []).some((r) => r.task_id === first.id)).toBe(true);
      expect((sweepOne.data ?? []).some((r) => r.task_id === overflow.id)).toBe(false);

      // "Next sweep" — same call, standing in for the cron firing again 5
      // minutes later. overflow.due_at is still comfortably inside
      // [now, now+30m], so it's a live candidate and gets claimed cleanly.
      const sweepTwo = await claimAppointmentReminders(db, 1);
      expect(sweepTwo.error).toBeNull();
      const overflowRow = (sweepTwo.data ?? []).find((r) => r.task_id === overflow.id);
      expect(overflowRow).toBeTruthy();
      expect(overflowRow?.claimed_status).toBe("pending");

      const { data: overflowTask } = await db
        .from("tasks")
        .select("reminder_claimed_at")
        .eq("id", overflow.id)
        .single();
      expect(overflowTask?.reminder_claimed_at).not.toBeNull();
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

      await asReminderDeliveryFencingClient(db)
        .from("task_reminder_deliveries")
        .update({
          status: "failed",
          attempts: 2,
          // Expire the initial claim's 2-minute lease — a freshly-failed row
          // is retry-eligible only once next_attempt_at has passed (the
          // outcome write deliberately leaves the lease untouched).
          next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
        })
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

      // Codex round 2: fn_claim_appointment_reminders now stamps its own
      // 2-minute lease (next_attempt_at) on insert, same as a retry claim
      // does. Backdating created_at alone no longer simulates a genuinely
      // stalled row — in production the lease would ALSO be long expired
      // by the time 10 real minutes have passed, so this test backdates
      // both to match.
      await asReminderDeliveryFencingClient(db)
        .from("task_reminder_deliveries")
        .update({
          created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
          next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
        })
        .eq("id", delivery!.id)
        .select("id"); // trigger execution — same PostgrestFilterBuilder either way

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

    it("the attempts<3 cap also gates the stale-pending branch, not just failed", async () => {
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
        .update({ attempts: 3, created_at: new Date(Date.now() - 11 * 60_000).toISOString() })
        .eq("id", delivery!.id);

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.delivery_id === delivery!.id)).toBe(false);
    });

    it("Codex round 7 (finding 1): never selects a timeout_ambiguous delivery, even with attempts < 3 and a stale created_at — excluded by construction, not an extra predicate", async () => {
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

      // The sweep route (route.ts, withDeliveryDeadline) transitions a row
      // here when its own per-delivery deadline elapses while the provider
      // call is still in flight — the CHECK constraint (this migration)
      // accepts it, but it must never come back out through the retry
      // claim while ambiguous, regardless of how low attempts is or how
      // stale created_at looks (both would make it eligible if it were
      // status='failed' or 'pending').
      await db
        .from("task_reminder_deliveries")
        .update({
          status: "timeout_ambiguous",
          attempts: 0,
          created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
        })
        .eq("id", delivery!.id);

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.delivery_id === delivery!.id)).toBe(false);
    });

    // Codex round 12 (finding 2): 'dispatching' is excluded from
    // fn_claim_reminder_retries's eligibility the SAME way timeout_ambiguous
    // is — never added to the candidates CTE's status IN-list — so a row a
    // worker crashed on between the provider accepting the message and its
    // own outcome write landing can never be reclaimed and resent.
    it("Codex round 12 (finding 2): never selects a 'dispatching' delivery, even with attempts < 3 and a stale created_at — excluded by construction", async () => {
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

      // The status CHECK constraint accepts 'dispatching' — the value
      // reminders.ts's markDispatching fences a row into right before its
      // Slack/SMS provider call.
      await asReminderDeliveryFencingClient(db)
        .from("task_reminder_deliveries")
        .update({
          status: "dispatching",
          attempts: 0,
          created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
        })
        .eq("id", delivery!.id);

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.delivery_id === delivery!.id)).toBe(false);
    });

    // Codex round 12 (finding 2): crash-boundary simulation — a row swept
    // into 'dispatching' (a worker legitimately owned it and was about to
    // call the provider) whose worker then crashed. The NEXT sweep's retry
    // claim must never resend it, regardless of how long it's been stuck —
    // only the route's own `sweepStaleDispatchingReminders` (a separate,
    // >10-minute reconciliation path, not this RPC) is allowed to move it
    // out of 'dispatching'.
    it("Codex round 12 (finding 2): crash-boundary simulation — a row left 'dispatching' past 10 minutes is still never picked up by the next retry claim", async () => {
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

      await asReminderDeliveryFencingClient(db)
        .from("task_reminder_deliveries")
        .update({
          status: "dispatching",
          dispatching_at: new Date(Date.now() - 15 * 60_000).toISOString(),
          created_at: new Date(Date.now() - 15 * 60_000).toISOString(),
        })
        .eq("id", delivery!.id);

      // Simulate several sweep intervals passing — the retry claim must
      // never resend it. (The stale-dispatching reconciliation sweep that
      // WOULD eventually move this row to timeout_ambiguous lives in
      // route.ts, not this RPC, and is covered by that route's own unit
      // tests.)
      for (let i = 0; i < 3; i += 1) {
        const { data, error } = await claimReminderRetries(db);
        expect(error).toBeNull();
        expect((data ?? []).some((r) => r.delivery_id === delivery!.id)).toBe(false);
      }
    });
  });

  /** Direct writes to tasks.status/outcome/due_at for an appointment row are
   *  blocked by trg_tasks_tenant_integrity_guard (20260814150000) unless
   *  `sandra.allow_appointment_time_move` is set transaction-locally — the
   *  trigger fires for every role, service-role PostgREST writes included.
   *  These revalidation tests need to move an appointment past-due or
   *  cancel it WITHOUT going through the (PR 3, separately-tested)
   *  lifecycle RPCs, so they open a raw pg connection and set the flag
   *  themselves — same idiom as the lifecycle migration's uniform-lock-
   *  protocol test (20260814210000...integration.test.ts:869-877). */
  async function flaggedTaskUpdate(sql: string, params: unknown[]): Promise<void> {
    const conn = new Client({ connectionString: testDbUrl() });
    await conn.connect();
    try {
      await conn.query("begin");
      await conn.query("select set_config('sandra.allow_appointment_time_move', 'on', true)");
      await conn.query(sql, params);
      await conn.query("commit");
    } finally {
      await conn.end();
    }
  }

  describe("fn_claim_appointment_reminders — lease/fencing (Codex round 2)", () => {
    it("mints a claim_token and leaves the row status=pending (claimed_status) on every freshly-inserted row", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, 10);

      const { data, error } = await claimAppointmentReminders(db);
      expect(error).toBeNull();
      const claimed = (data ?? []).find((r) => r.task_id === appt.id && r.channel === "bell");
      expect(claimed?.claim_token).toBeTruthy();
      expect(claimed?.claimed_status).toBe("pending");
    });

    // Codex round 2 (finding 2): before this, an initial-claim row's
    // claim_token/next_attempt_at were NULL, so a slow initial worker's
    // eventual sent/failed write was scoped only by delivery id — nothing
    // stopped it from clobbering a retry worker's outcome (or vice versa)
    // once the stale-pending path (fn_claim_reminder_retries, >10min old)
    // reclaimed the same still-pending row out from under it. Two separate
    // client connections stand in for the two overlapping workers: the
    // "initial" worker holds the token from the primary claim; the "retry"
    // worker calls fn_claim_reminder_retries against the SAME row once it
    // looks stalled, and gets a fresh token. Both then race to write the
    // delivery outcome exactly as `markDelivery` (reminders.ts) does — a
    // fenced UPDATE ... WHERE id=<mine> AND claim_token=<mine> AND
    // status=<claimedStatus>.
    it("overlapping initial+retry claim: a stalled initial worker's fenced write is a no-op once the retry claim reclaims the same row (two-connection race)", async () => {
      const initialWorkerConn = db;
      const retryWorkerConn = createTestClient();

      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, 10);

      const { data: initialClaim, error: initialClaimError } =
        await claimAppointmentReminders(initialWorkerConn);
      expect(initialClaimError).toBeNull();
      const initialRow = (initialClaim ?? []).find(
        (r) => r.task_id === appt.id && r.channel === "bell",
      );
      expect(initialRow?.claim_token).toBeTruthy();
      const staleToken = initialRow!.claim_token;

      // Simulate the initial worker stalling past its lease AND past the
      // stale-pending threshold (both created_at and next_attempt_at need
      // to be in the past — see the sibling test above this one for why).
      await asReminderDeliveryFencingClient(db)
        .from("task_reminder_deliveries")
        .update({
          created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
          next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
        })
        .eq("id", initialRow!.delivery_id)
        .select("id");

      const { data: retryClaim, error: retryClaimError } =
        await claimReminderRetries(retryWorkerConn);
      expect(retryClaimError).toBeNull();
      const retryRow = (retryClaim ?? []).find((r) => r.delivery_id === initialRow!.delivery_id);
      expect(retryRow).toBeTruthy();
      expect(retryRow!.claim_token).not.toBe(staleToken);
      const freshToken = retryRow!.claim_token;

      // The stalled initial worker finally finishes and tries to write its
      // outcome with the TOKEN IT WAS ORIGINALLY HANDED — same fenced shape
      // as reminders.ts's markDelivery. Zero rows must match: the row now
      // belongs to the retry worker's token.
      const staleWrite = await asReminderDeliveryFencingClient(initialWorkerConn)
        .from("task_reminder_deliveries")
        .update({ status: "sent", attempts: 1, sent_at: new Date().toISOString() })
        .eq("id", initialRow!.delivery_id)
        .eq("claim_token", staleToken)
        .eq("status", "pending")
        .select("id");
      expect(staleWrite.error).toBeNull();
      expect(staleWrite.data ?? []).toHaveLength(0);

      // The retry worker's own fenced write, with the fresh token, succeeds.
      const retryWrite = await asReminderDeliveryFencingClient(retryWorkerConn)
        .from("task_reminder_deliveries")
        .update({ status: "sent", attempts: retryRow!.attempts, sent_at: new Date().toISOString() })
        .eq("id", initialRow!.delivery_id)
        .eq("claim_token", freshToken)
        .eq("status", retryRow!.claimed_status)
        .select("id");
      expect(retryWrite.error).toBeNull();
      expect(retryWrite.data ?? []).toHaveLength(1);

      const { data: finalRow } = await asReminderDeliveryFencingClient(db)
        .from("task_reminder_deliveries")
        .select("status, claim_token")
        .eq("id", initialRow!.delivery_id)
        .single();
      expect(finalRow?.status).toBe("sent");
      expect(finalRow?.claim_token).toBe(freshToken);
    });
  });

  describe("fn_claim_reminder_retries — lease/fencing + revalidation (Codex round 1)", () => {
    async function failedBellDelivery(minutesFromNow = 10) {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId);
      const appt = await insertDueAppointment(member.userId, minutesFromNow);
      await claimAppointmentReminders(db);
      const { data: delivery } = await db
        .from("task_reminder_deliveries")
        .select("id")
        .eq("task_id", appt.id)
        .eq("channel", "bell")
        .single();
      await asReminderDeliveryFencingClient(db)
        .from("task_reminder_deliveries")
        .update({
          status: "failed",
          attempts: 1,
          // Expire the initial claim's lease (see the first retry test).
          next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
        })
        .eq("id", delivery!.id);
      return { member, appt, deliveryId: delivery!.id };
    }

    it("returns a fresh claim_token and the pre-claim status (claimed_status), and leases the row (next lookalike claim excludes it)", async () => {
      const { deliveryId } = await failedBellDelivery();

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      const claimed = (data ?? []).find((r) => r.delivery_id === deliveryId);
      expect(claimed?.claim_token).toBeTruthy();
      expect(claimed?.claimed_status).toBe("failed");

      // Leased (next_attempt_at pushed out ~2 minutes) — an immediate
      // second claim call must not see it again.
      const second = await claimReminderRetries(db);
      expect(second.error).toBeNull();
      expect((second.data ?? []).some((r) => r.delivery_id === deliveryId)).toBe(false);
    });

    it("two concurrent claims never return the same delivery row (FOR UPDATE SKIP LOCKED)", async () => {
      const a = await failedBellDelivery();
      const b = await failedBellDelivery();

      const [first, second] = await Promise.all([
        claimReminderRetries(db, 1),
        claimReminderRetries(db, 1),
      ]);
      expect(first.error).toBeNull();
      expect(second.error).toBeNull();

      const firstIds = (first.data ?? []).map((r) => r.delivery_id);
      const secondIds = (second.data ?? []).map((r) => r.delivery_id);
      const overlap = firstIds.filter((id) => secondIds.includes(id));
      expect(overlap).toHaveLength(0);
      // Between the two size-1 claims, both eligible rows were claimed
      // exactly once (order not guaranteed).
      expect([...firstIds, ...secondIds].sort()).toEqual([a.deliveryId, b.deliveryId].sort());
    });

    it("suppresses (terminal, never delivers) a retry whose assignee lost active membership since the original claim", async () => {
      const { member, deliveryId } = await failedBellDelivery();
      await setMembershipAccessStatus(member.userId, BMH_ORG_ID, "suspended");

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.delivery_id === deliveryId)).toBe(false);

      const { data: row } = await db
        .from("task_reminder_deliveries")
        .select("status, last_error")
        .eq("id", deliveryId)
        .single();
      expect(row?.status).toBe("suppressed");
      expect(row?.last_error).toMatch(/assignee_inactive/);
    });

    it("suppresses a slack retry whose channel was disabled since the original claim", async () => {
      const member = await createUserForOrg(BMH_ORG_ID);
      await setPrefs(member.userId, { slackEnabled: true });
      const appt = await insertDueAppointment(member.userId, 10);
      await claimAppointmentReminders(db);
      const { data: delivery } = await db
        .from("task_reminder_deliveries")
        .select("id")
        .eq("task_id", appt.id)
        .eq("channel", "slack")
        .single();
      expect(delivery).not.toBeNull();
      await asReminderDeliveryFencingClient(db)
        .from("task_reminder_deliveries")
        .update({
          status: "failed",
          attempts: 1,
          // Expire the initial claim's lease (see the first retry test).
          next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
        })
        .eq("id", delivery!.id);

      await setPrefs(member.userId, { slackEnabled: false });

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.delivery_id === delivery!.id)).toBe(false);

      const { data: row } = await db
        .from("task_reminder_deliveries")
        .select("status, last_error")
        .eq("id", delivery!.id)
        .single();
      expect(row?.status).toBe("suppressed");
      expect(row?.last_error).toMatch(/channel_disabled/);
    });

    it("suppresses a retry whose appointment was cancelled since the original claim", async () => {
      const { appt, deliveryId } = await failedBellDelivery();
      await flaggedTaskUpdate(
        "update tasks set status = 'cancelled', outcome = 'cancelled' where id = $1",
        [appt.id],
      );

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.delivery_id === deliveryId)).toBe(false);

      const { data: row } = await db
        .from("task_reminder_deliveries")
        .select("status, last_error")
        .eq("id", deliveryId)
        .single();
      expect(row?.status).toBe("suppressed");
      expect(row?.last_error).toMatch(/appointment_not_open/);
    });

    it("suppresses a retry whose appointment's due_at passed more than the 15-minute grace ago", async () => {
      const { appt, deliveryId } = await failedBellDelivery(10);
      // Codex round 3 (finding 1): grace is 15 minutes — this must be
      // clearly past it (20 minutes) to still exercise suppression; a
      // due_at inside the grace is covered by the "delivers within the
      // 15-minute grace window" test below.
      await flaggedTaskUpdate("update tasks set due_at = $2 where id = $1", [
        appt.id,
        new Date(Date.now() - 20 * 60_000).toISOString(),
      ]);

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.delivery_id === deliveryId)).toBe(false);

      const { data: row } = await db
        .from("task_reminder_deliveries")
        .select("status, last_error")
        .eq("id", deliveryId)
        .single();
      expect(row?.status).toBe("suppressed");
      expect(row?.last_error).toMatch(/appointment_due_passed/);
    });

    // Codex round 3 (finding 1): fn_claim_appointment_reminders now claims
    // one appointment at a time inside the sweep route's budget loop, so a
    // near-due appointment can be claimed with only seconds left before
    // due_at. If that delivery isn't sent before the sweep's budget runs
    // out, it sits pending and isn't retry-eligible until the stale-pending
    // threshold (10 minutes) — by which point due_at has already passed.
    // Without the grace window, THIS retry pass (the very first one that
    // could ever pick the row back up) would suppress it outright. This
    // test proves the compounding hazard is closed: a due_at inside the
    // 15-minute grace still delivers.
    it("delivers a retry whose appointment's due_at passed within the 15-minute grace window (the overflow-claim compounding hazard)", async () => {
      const { appt, deliveryId } = await failedBellDelivery(10);
      // 8 minutes past due — comfortably inside the 15-minute grace, and
      // past the worst case this closes (claimed the instant due_at
      // arrived, first retry-eligible 10 minutes later).
      await flaggedTaskUpdate("update tasks set due_at = $2 where id = $1", [
        appt.id,
        new Date(Date.now() - 8 * 60_000).toISOString(),
      ]);

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      const claimed = (data ?? []).find((r) => r.delivery_id === deliveryId);
      expect(claimed).toBeTruthy();

      const { data: row } = await db
        .from("task_reminder_deliveries")
        .select("status, last_error")
        .eq("id", deliveryId)
        .single();
      // Still eligible for delivery — status is left as-is (failed, from
      // failedBellDelivery), NOT transitioned to suppressed, and the claim
      // bumped attempts/leased the row same as any other still-valid retry.
      expect(row?.status).toBe("failed");
    });
  });

  // ----------------------------------------------------------------------------
  // Raw-pg proof that the claim genuinely locks (FOR UPDATE SKIP LOCKED),
  // not merely that two RPC calls happen not to race — same idiom as the
  // lifecycle RPCs' uniform-lock-protocol tests
  // (20260814210000...integration.test.ts).
  // ----------------------------------------------------------------------------
  describe("fn_claim_reminder_retries — row lock holds for the statement's duration", () => {
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

    it("a delivery row locked by an open transaction is skipped (not double-claimed) by a concurrent claim", async () => {
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
      await asReminderDeliveryFencingClient(db)
        .from("task_reminder_deliveries")
        .update({
          status: "failed",
          attempts: 1,
          // Expire the initial claim's lease (see the first retry test).
          next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
        })
        .eq("id", delivery!.id);

      await conn.query("begin");
      await conn.query('select id from task_reminder_deliveries where id = $1 for update', [
        delivery!.id,
      ]);

      const { data, error } = await claimReminderRetries(db);
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.delivery_id === delivery!.id)).toBe(false);

      await conn.query("commit");
    });
  });
});
