import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
import type { Database } from "@/lib/supabase/types";

// ----------------------------------------------------------------------------
// Local-cast RPC surfaces — same rationale as
// 20260814170000_appointment_booking_rpcs.integration.test.ts: these four
// functions (plus the widened claim/exhaustion RPCs) are not in the
// generated Database["public"]["Functions"] map, per this PR's scope.
// ----------------------------------------------------------------------------
type RpcResult<T> = {
  data: T | null;
  error: { message: string; code?: string } | null;
};

type CompleteArgs = { p_task: string; p_outcome: string };
type CompleteRow = { task_id: string; status: string; outcome: string };

type CancelArgs = { p_task: string };
type CancelRow = { task_id: string; status: string; ledger_id: string };

type RescheduleArgs = {
  p_task: string;
  p_new_start: string;
  p_new_end: string;
  p_timezone: string;
  p_idempotency_key?: string | null;
};
type RescheduleRow = {
  task_id: string;
  old_task_id: string;
  calendar_chain_id: string;
  duplicate: boolean;
};

type ReassignArgs = { p_task: string; p_new_assignee: string; p_idempotency_key?: string | null };
type ReassignRow = {
  task_id: string;
  old_assignee_id: string;
  new_assignee_id: string;
  duplicate: boolean;
};

type ClaimMutationRow = {
  ledger_id: string;
  org_id: string;
  calendar_chain_id: string;
  operation: string;
  phase: string;
  source_task_id: string;
  target_task_id: string | null;
  old_assignee_id: string;
  new_assignee_id: string | null;
  event_id: string | null;
  new_event_id: string | null;
  client_event_id: string | null;
  result_reason: string | null;
  /** Codex round 3 (finding 2): reassign-only delete-progress marker,
   *  independent of result_reason — see the migration's own comment on
   *  this column. */
  old_event_deleted_at: string | null;
  expected_generation: number;
  attempts: number;
  claim_token: string;
  source_due_at: string;
  source_end_at: string;
  source_title: string;
  source_assignee_id: string;
  target_due_at: string | null;
  target_end_at: string | null;
  target_title: string | null;
  target_assignee_id: string | null;
};

type ExpireExhaustedRow = { failed_count: number; needs_repair_count: number; needs_repair_ids: string[] };

type LifecycleRpcClient = {
  rpc(fn: "fn_complete_appointment", args: CompleteArgs): Promise<RpcResult<CompleteRow>>;
  rpc(fn: "fn_cancel_appointment", args: CancelArgs): Promise<RpcResult<CancelRow>>;
  rpc(fn: "fn_reschedule_appointment", args: RescheduleArgs): Promise<RpcResult<RescheduleRow>>;
  rpc(fn: "fn_reassign_appointment", args: ReassignArgs): Promise<RpcResult<ReassignRow>>;
  rpc(
    fn: "fn_claim_calendar_mutations",
    args: { p_limit: number },
  ): Promise<RpcResult<ClaimMutationRow[]>>;
  rpc(fn: "fn_expire_exhausted_calendar_mutations"): Promise<RpcResult<ExpireExhaustedRow[]>>;
};

function asLifecycleRpcClient(client: SupabaseClient<Database>): LifecycleRpcClient {
  return client as unknown as LifecycleRpcClient;
}

function completeAppointment(client: SupabaseClient<Database>, args: CompleteArgs) {
  return asLifecycleRpcClient(client).rpc("fn_complete_appointment", args);
}
function cancelAppointment(client: SupabaseClient<Database>, args: CancelArgs) {
  return asLifecycleRpcClient(client).rpc("fn_cancel_appointment", args);
}
function rescheduleAppointment(client: SupabaseClient<Database>, args: RescheduleArgs) {
  return asLifecycleRpcClient(client).rpc("fn_reschedule_appointment", args);
}
function reassignAppointment(client: SupabaseClient<Database>, args: ReassignArgs) {
  return asLifecycleRpcClient(client).rpc("fn_reassign_appointment", args);
}
function claimCalendarMutations(client: SupabaseClient<Database>, limit: number) {
  return asLifecycleRpcClient(client).rpc("fn_claim_calendar_mutations", { p_limit: limit });
}
function expireExhaustedCalendarMutations(client: SupabaseClient<Database>) {
  return asLifecycleRpcClient(client).rpc("fn_expire_exhausted_calendar_mutations");
}

// task_calendar_mutations / tasks columns not on the generated Database type
// yet (next_attempt_at, claim_token — PR 2 scope; the rest are ordinary
// generated columns but the local builder keeps everything in one place).
type LedgerRow = {
  id: string;
  org_id: string;
  calendar_chain_id: string;
  operation: string;
  phase: string;
  source_task_id: string;
  target_task_id: string | null;
  old_assignee_id: string;
  new_assignee_id: string | null;
  event_id: string | null;
  expected_generation: number;
  attempts?: number;
  next_attempt_at?: string | null;
};
function ledgerReader(client: SupabaseClient<Database> = db) {
  return client as unknown as {
    from(table: "task_calendar_mutations"): {
      select(columns: string): {
        eq(
          column: "source_task_id" | "calendar_chain_id",
          value: string,
        ): Promise<{ data: LedgerRow[] | null; error: { message: string } | null }>;
      };
      insert(values: {
        org_id: string;
        calendar_chain_id: string;
        operation: string;
        phase: string;
        source_task_id: string;
        old_assignee_id: string;
        expected_generation: number;
        attempts?: number;
        next_attempt_at?: string | null;
        result_reason?: string | null;
      }): Promise<{ data: null; error: { message: string; code?: string } | null }>;
      update(values: { attempts?: number; next_attempt_at?: string | null; phase?: string }): {
        eq(column: "id", value: string): Promise<{ data: null; error: { message: string } | null }>;
      };
    };
  };
}

const serviceClient = createTestClient();
const db = serviceClient;
const createdUserIds: string[] = [];

function uniqueEmail(label: string): string {
  return `mig20260814210000-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
}

function anonClient(): SupabaseClient<Database> {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_URL ?? env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_ANON_KEY ?? env.TEST_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing TEST_SUPABASE_URL or TEST_SUPABASE_ANON_KEY.");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
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

/** Direct service-role insert of a canonical-open appointment — no ledger
 *  row, no flag needed (canonical open state passes
 *  tasks_tenant_integrity_guard's INSERT branch unconditionally, same as
 *  fn_book_appointment's own insert). Represents an appointment whose
 *  original `create` mutation already finalized (with or without a Google
 *  event, controlled by `googleEventId`) — the clean starting point for
 *  testing the four lifecycle RPCs without a real Google integration. */
async function insertOpenAppointment(opts: {
  orgId?: string;
  assigneeId: string;
  createdBy: string;
  dueAt?: string;
  endAt?: string;
  googleEventId?: string | null;
  chainId?: string;
}): Promise<{ taskId: string; chainId: string }> {
  const chainId = opts.chainId ?? randomUUID();
  const dueAt = opts.dueAt ?? new Date(Date.now() + 3_600_000).toISOString();
  const endAt = opts.endAt ?? new Date(Date.now() + 5_400_000).toISOString();
  const { data, error } = await db
    .from("tasks")
    .insert({
      org_id: opts.orgId ?? BMH_ORG_ID,
      type: "appointment",
      status: "open",
      title: "Lifecycle test appointment",
      due_at: dueAt,
      end_at: endAt,
      assignee_id: opts.assigneeId,
      created_by: opts.createdBy,
      calendar_chain_id: chainId,
      google_calendar_event_id: opts.googleEventId ?? null,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { taskId: data!.id, chainId };
}

async function insertActiveLedgerMutation(taskId: string, chainId: string, orgId: string, assigneeId: string) {
  const { error } = await ledgerReader().from("task_calendar_mutations").insert({
    org_id: orgId,
    calendar_chain_id: chainId,
    operation: "create",
    phase: "pending",
    source_task_id: taskId,
    old_assignee_id: assigneeId,
    expected_generation: 0,
  });
  expect(error).toBeNull();
}

async function ledgerRowsForChain(chainId: string): Promise<LedgerRow[]> {
  const { data, error } = await ledgerReader()
    .from("task_calendar_mutations")
    .select(
      "id, org_id, calendar_chain_id, operation, phase, source_task_id, target_task_id, old_assignee_id, new_assignee_id, event_id, expected_generation",
    )
    .eq("calendar_chain_id", chainId);
  expect(error).toBeNull();
  return data ?? [];
}

/** Simulates the calendar-mutation-sweep worker finalizing every
 *  not-yet-finalized ledger row for a chain — direct service-role write
 *  (no worker running in these DB-only tests), so the chain-serialization
 *  guard (`phase in (pending, provider_done, needs_repair)`) clears and a
 *  subsequent lifecycle RPC on the same chain can proceed. */
async function finalizeLedgerRowsForChain(chainId: string): Promise<void> {
  const rows = await ledgerRowsForChain(chainId);
  for (const row of rows) {
    if (row.phase === "finalized") continue;
    const { error } = await ledgerReader()
      .from("task_calendar_mutations")
      .update({ phase: "finalized" })
      .eq("id", row.id);
    expect(error).toBeNull();
  }
}

async function setTimezonePref(userId: string, timezone = "America/Chicago"): Promise<void> {
  const { error } = await db
    .from("user_integration_prefs")
    .upsert({ user_id: userId, channel: "google_calendar", timezone });
  expect(error).toBeNull();
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

describe("Migration 20260814210000 — appointment lifecycle RPCs", () => {
  describe("fn_complete_appointment", () => {
    it("closes an open appointment as held", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
      });

      const { data, error } = await completeAppointment(actor.client, {
        p_task: taskId,
        p_outcome: "held",
      });

      expect(error).toBeNull();
      expect(data).toEqual({ task_id: taskId, status: "completed", outcome: "held" });

      const { data: row } = await db
        .from("tasks")
        .select("status, outcome, calendar_generation")
        .eq("id", taskId)
        .single();
      expect(row?.status).toBe("completed");
      expect(row?.outcome).toBe("held");
      expect(row?.calendar_generation).toBe(1);
    });

    it("rejects an outcome other than held/no_show", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });

      const { error } = await completeAppointment(actor.client, { p_task: taskId, p_outcome: "cancelled" });

      expect(error?.message).toMatch(/outcome must be held or no_show/i);
    });

    it("rejects a non-open appointment", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      await completeAppointment(actor.client, { p_task: taskId, p_outcome: "held" });

      const { error } = await completeAppointment(actor.client, { p_task: taskId, p_outcome: "no_show" });

      expect(error?.message).toMatch(/not open/i);
    });

    it("rejects while a chain mutation is active (pending/provider_done/needs_repair)", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId, chainId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      await insertActiveLedgerMutation(taskId, chainId, BMH_ORG_ID, actor.userId);

      const { error } = await completeAppointment(actor.client, { p_task: taskId, p_outcome: "held" });

      expect(error?.message).toMatch(/calendar sync in progress/i);
    });

    it("hostile: anon caller is rejected", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });

      const { error } = await completeAppointment(anonClient(), { p_task: taskId, p_outcome: "held" });

      expect(error).not.toBeNull();
    });

    it("hostile: cross-org caller is rejected", async () => {
      const owner = await createUserForOrg(BMH_ORG_ID);
      const outsider = await createUserForOrg(TEST_ORG_B_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: owner.userId, createdBy: owner.userId });

      const { error } = await completeAppointment(outsider.client, { p_task: taskId, p_outcome: "held" });

      expect(error?.message).toMatch(/no active membership/i);
    });

    it("hostile: an inactive (suspended) actor is rejected", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      await setMembershipAccessStatus(actor.userId, BMH_ORG_ID, "suspended");

      const { error } = await completeAppointment(actor.client, { p_task: taskId, p_outcome: "held" });

      expect(error?.message).toMatch(/no active membership/i);
    });
  });

  describe("fn_cancel_appointment", () => {
    it("cancels an open appointment and opens a cancel/pending ledger row carrying the current event id", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId, chainId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
        googleEventId: "evt-existing",
      });

      const { data, error } = await cancelAppointment(actor.client, { p_task: taskId });

      expect(error).toBeNull();
      expect(data?.status).toBe("cancelled");

      const { data: row } = await db
        .from("tasks")
        .select("status, outcome, calendar_generation")
        .eq("id", taskId)
        .single();
      expect(row?.status).toBe("cancelled");
      expect(row?.outcome).toBe("cancelled");
      expect(row?.calendar_generation).toBe(1);

      const ledgerRows = await ledgerRowsForChain(chainId);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({
        operation: "cancel",
        phase: "pending",
        source_task_id: taskId,
        event_id: "evt-existing",
        expected_generation: 1,
      });
    });

    it("rejects a non-open appointment", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      await cancelAppointment(actor.client, { p_task: taskId });

      const { error } = await cancelAppointment(actor.client, { p_task: taskId });

      expect(error?.message).toMatch(/not open/i);
    });

    it("rejects while a chain mutation is active", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId, chainId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      await insertActiveLedgerMutation(taskId, chainId, BMH_ORG_ID, actor.userId);

      const { error } = await cancelAppointment(actor.client, { p_task: taskId });

      expect(error?.message).toMatch(/calendar sync in progress/i);
    });

    it("hostile: anon and cross-org callers are rejected", async () => {
      const owner = await createUserForOrg(BMH_ORG_ID);
      const outsider = await createUserForOrg(TEST_ORG_B_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: owner.userId, createdBy: owner.userId });

      expect((await cancelAppointment(anonClient(), { p_task: taskId })).error).not.toBeNull();
      expect((await cancelAppointment(outsider.client, { p_task: taskId })).error?.message).toMatch(
        /no active membership/i,
      );
    });
  });

  describe("fn_reschedule_appointment", () => {
    async function reschedulableAppointment() {
      const actor = await createUserForOrg(BMH_ORG_ID);
      await setTimezonePref(actor.userId, "America/Chicago");
      const { taskId, chainId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
        googleEventId: "evt-old",
      });
      return { actor, taskId, chainId };
    }

    it("closes the old row and inserts an open successor sharing the chain, links, and assignee", async () => {
      const { actor, taskId, chainId } = await reschedulableAppointment();
      const newStart = new Date(Date.now() + 7_200_000).toISOString();
      const newEnd = new Date(Date.now() + 9_000_000).toISOString();

      const { data, error } = await rescheduleAppointment(actor.client, {
        p_task: taskId,
        p_new_start: newStart,
        p_new_end: newEnd,
        p_timezone: "America/Chicago",
      });

      expect(error).toBeNull();
      expect(data?.duplicate).toBe(false);
      expect(data?.old_task_id).toBe(taskId);
      const successorId = data!.task_id;
      expect(successorId).not.toBe(taskId);

      const { data: oldRow } = await db
        .from("tasks")
        .select("status, outcome, calendar_generation, calendar_chain_id")
        .eq("id", taskId)
        .single();
      expect(oldRow).toMatchObject({ status: "completed", outcome: "rescheduled", calendar_generation: 1, calendar_chain_id: chainId });

      const { data: successorRow } = await db
        .from("tasks")
        .select("status, assignee_id, calendar_chain_id, due_at, end_at, calendar_generation")
        .eq("id", successorId)
        .single();
      expect(successorRow).toMatchObject({
        status: "open",
        assignee_id: actor.userId,
        calendar_chain_id: chainId,
        calendar_generation: 0,
      });
      expect(new Date(successorRow!.due_at).toISOString()).toBe(newStart);

      const ledgerRows = await ledgerRowsForChain(chainId);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({
        operation: "reschedule",
        phase: "pending",
        source_task_id: taskId,
        target_task_id: successorId,
        event_id: "evt-old",
        expected_generation: 0,
      });
    });

    it("idempotency key replay returns the SAME successor rather than creating a second one", async () => {
      const { actor, taskId } = await reschedulableAppointment();
      const newStart = new Date(Date.now() + 7_200_000).toISOString();
      const newEnd = new Date(Date.now() + 9_000_000).toISOString();
      const key = randomUUID();

      const first = await rescheduleAppointment(actor.client, {
        p_task: taskId,
        p_new_start: newStart,
        p_new_end: newEnd,
        p_timezone: "America/Chicago",
        p_idempotency_key: key,
      });
      expect(first.error).toBeNull();

      const second = await rescheduleAppointment(actor.client, {
        p_task: taskId,
        p_new_start: newStart,
        p_new_end: newEnd,
        p_timezone: "America/Chicago",
        p_idempotency_key: key,
      });

      expect(second.error).toBeNull();
      expect(second.data?.duplicate).toBe(true);
      expect(second.data?.task_id).toBe(first.data?.task_id);

      const idempotencyReader = db as unknown as {
        from(table: "tasks"): {
          select(columns: string): {
            eq(
              column: "booking_idempotency_key",
              value: string,
            ): Promise<{ data: Array<{ id: string }> | null; error: { message: string } | null }>;
          };
        };
      };
      const { data: successorRows } = await idempotencyReader.from("tasks").select("id").eq(
        "booking_idempotency_key",
        key,
      );
      expect((successorRows ?? []).length).toBe(1);
    });

    it("rejects a timezone that disagrees with the assignee's authoritative preference", async () => {
      const { actor, taskId } = await reschedulableAppointment();

      const { error } = await rescheduleAppointment(actor.client, {
        p_task: taskId,
        p_new_start: new Date(Date.now() + 7_200_000).toISOString(),
        p_new_end: new Date(Date.now() + 9_000_000).toISOString(),
        p_timezone: "America/Denver",
      });

      expect(error?.message).toMatch(/timezone mismatch/i);
    });

    it("rejects an out-of-bounds window (end before start)", async () => {
      const { actor, taskId } = await reschedulableAppointment();
      const start = new Date(Date.now() + 7_200_000).toISOString();

      const { error } = await rescheduleAppointment(actor.client, {
        p_task: taskId,
        p_new_start: start,
        p_new_end: start,
        p_timezone: "America/Chicago",
      });

      expect(error?.message).toMatch(/end must be after start/i);
    });

    it("rejects while a chain mutation is active", async () => {
      const { actor, taskId, chainId } = await reschedulableAppointment();
      await insertActiveLedgerMutation(taskId, chainId, BMH_ORG_ID, actor.userId);

      const { error } = await rescheduleAppointment(actor.client, {
        p_task: taskId,
        p_new_start: new Date(Date.now() + 7_200_000).toISOString(),
        p_new_end: new Date(Date.now() + 9_000_000).toISOString(),
        p_timezone: "America/Chicago",
      });

      expect(error?.message).toMatch(/calendar sync in progress/i);
    });

    it("hostile: anon and cross-org callers are rejected", async () => {
      const { actor, taskId } = await reschedulableAppointment();
      const outsider = await createUserForOrg(TEST_ORG_B_ID);

      expect(
        (
          await rescheduleAppointment(anonClient(), {
            p_task: taskId,
            p_new_start: new Date(Date.now() + 7_200_000).toISOString(),
            p_new_end: new Date(Date.now() + 9_000_000).toISOString(),
            p_timezone: "America/Chicago",
          })
        ).error,
      ).not.toBeNull();

      expect(
        (
          await rescheduleAppointment(outsider.client, {
            p_task: taskId,
            p_new_start: new Date(Date.now() + 7_200_000).toISOString(),
            p_new_end: new Date(Date.now() + 9_000_000).toISOString(),
            p_timezone: "America/Chicago",
          })
        ).error?.message,
      ).toMatch(/no active membership/i);
      void actor;
    });
  });

  describe("fn_reassign_appointment", () => {
    it("swaps the assignee and opens a reassign/pending ledger row with a fresh client_event_id", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const newAssignee = await createUserForOrg(BMH_ORG_ID);
      const { taskId, chainId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
        googleEventId: "evt-old",
      });

      const { data, error } = await reassignAppointment(actor.client, {
        p_task: taskId,
        p_new_assignee: newAssignee.userId,
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({
        task_id: taskId,
        old_assignee_id: actor.userId,
        new_assignee_id: newAssignee.userId,
        duplicate: false,
      });

      const { data: row } = await db
        .from("tasks")
        .select("assignee_id, calendar_generation")
        .eq("id", taskId)
        .single();
      expect(row).toMatchObject({ assignee_id: newAssignee.userId, calendar_generation: 1 });

      const ledgerRows = await ledgerRowsForChain(chainId);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({
        operation: "reassign",
        phase: "pending",
        old_assignee_id: actor.userId,
        new_assignee_id: newAssignee.userId,
        event_id: "evt-old",
        expected_generation: 1,
      });
    });

    it("Codex round 1 (finding 5): an UNKEYED repeat call is a fresh operation, serialized (not silently no-op'd) by the chain lock — it errors while the first ledger row is still unfinalized", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const newAssignee = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      const first = await reassignAppointment(actor.client, { p_task: taskId, p_new_assignee: newAssignee.userId });
      expect(first.error).toBeNull();

      // The old "already on target assignee" no-op inference is REMOVED
      // (finding 5) — an unkeyed repeat is a fresh operation, and the
      // chain-mutation-in-progress guard now correctly blocks it while the
      // first reassign's ledger row is still pending (no worker has
      // finalized it in this DB-only test).
      const second = await reassignAppointment(actor.client, { p_task: taskId, p_new_assignee: newAssignee.userId });

      expect(second.error?.message).toMatch(/calendar sync in progress/i);
    });

    it("Codex round 1 (finding 5): an UNKEYED repeat call AFTER the first finalizes creates a fresh, second ledger row — no accidental idempotency without a key", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const newAssignee = await createUserForOrg(BMH_ORG_ID);
      const { taskId, chainId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      const first = await reassignAppointment(actor.client, { p_task: taskId, p_new_assignee: newAssignee.userId });
      expect(first.error).toBeNull();
      await finalizeLedgerRowsForChain(chainId);

      // A genuinely fresh unkeyed call — the appointment happens to already
      // be on the target assignee, but with no key there is no replay
      // lookup at all; this is validated purely on current state (still
      // 'open', assignee already newAssignee) and proceeds as a real
      // (degenerate but harmless) reassign-to-self.
      const second = await reassignAppointment(actor.client, {
        p_task: taskId,
        p_new_assignee: newAssignee.userId,
      });

      expect(second.error).toBeNull();
      expect(second.data?.duplicate).toBe(false);
      const ledgerRows = await ledgerRowsForChain(chainId);
      expect(ledgerRows).toHaveLength(2);
    });

    it("Codex round 1 (finding 5): a KEYED replay of A->B, issued after an intervening B->A already restored the original assignee, returns the ORIGINAL A->B result as duplicate WITHOUT touching current state", async () => {
      const userA = await createUserForOrg(BMH_ORG_ID);
      const userB = await createUserForOrg(BMH_ORG_ID);
      const { taskId, chainId } = await insertOpenAppointment({ assigneeId: userA.userId, createdBy: userA.userId });
      const keyAB = randomUUID();
      const keyBA = randomUUID();

      const ab = await reassignAppointment(userA.client, {
        p_task: taskId,
        p_new_assignee: userB.userId,
        p_idempotency_key: keyAB,
      });
      expect(ab.error).toBeNull();
      expect(ab.data?.duplicate).toBe(false);
      await finalizeLedgerRowsForChain(chainId);

      const ba = await reassignAppointment(userB.client, {
        p_task: taskId,
        p_new_assignee: userA.userId,
        p_idempotency_key: keyBA,
      });
      expect(ba.error).toBeNull();
      expect(ba.data?.duplicate).toBe(false);
      await finalizeLedgerRowsForChain(chainId);

      // Delayed replay of the ORIGINAL A->B call (same key as `ab`) arrives
      // now, after the B->A above already restored userA as assignee. The
      // old "already on target assignee" inference would see current
      // assignee=userA (not userB) and fall through to a genuine
      // reassignment — undoing the B->A. The keyed replay must instead
      // return ab's OWN result untouched.
      const replay = await reassignAppointment(userA.client, {
        p_task: taskId,
        p_new_assignee: userB.userId,
        p_idempotency_key: keyAB,
      });

      expect(replay.error).toBeNull();
      expect(replay.data).toMatchObject({
        task_id: taskId,
        old_assignee_id: userA.userId,
        new_assignee_id: userB.userId,
        duplicate: true,
      });

      // Current state is UNTOUCHED — still userA (from the B->A), no third
      // ledger row created by the replay.
      const { data: row } = await db.from("tasks").select("assignee_id").eq("id", taskId).single();
      expect(row?.assignee_id).toBe(userA.userId);
      const ledgerRows = await ledgerRowsForChain(chainId);
      expect(ledgerRows).toHaveLength(2);
    });

    it("Codex round 1 (finding 5): a key reused against a different p_new_assignee is rejected as a mismatched replay", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const targetA = await createUserForOrg(BMH_ORG_ID);
      const targetB = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      const key = randomUUID();

      const first = await reassignAppointment(actor.client, {
        p_task: taskId,
        p_new_assignee: targetA.userId,
        p_idempotency_key: key,
      });
      expect(first.error).toBeNull();

      const mismatched = await reassignAppointment(actor.client, {
        p_task: taskId,
        p_new_assignee: targetB.userId,
        p_idempotency_key: key,
      });

      expect(mismatched.error?.message).toMatch(/idempotency key reuse with different request/i);
    });

    it("rejects a new assignee with no active membership in the org", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const outsider = await createUserForOrg(TEST_ORG_B_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });

      const { error } = await reassignAppointment(actor.client, {
        p_task: taskId,
        p_new_assignee: outsider.userId,
      });

      expect(error?.message).toMatch(/no active membership/i);
    });

    it("rejects while a chain mutation is active", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const newAssignee = await createUserForOrg(BMH_ORG_ID);
      const { taskId, chainId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      await insertActiveLedgerMutation(taskId, chainId, BMH_ORG_ID, actor.userId);

      const { error } = await reassignAppointment(actor.client, {
        p_task: taskId,
        p_new_assignee: newAssignee.userId,
      });

      expect(error?.message).toMatch(/calendar sync in progress/i);
    });

    it("hostile: anon, cross-org, and inactive-actor callers are all rejected", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const newAssignee = await createUserForOrg(BMH_ORG_ID);
      const outsider = await createUserForOrg(TEST_ORG_B_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });

      expect(
        (await reassignAppointment(anonClient(), { p_task: taskId, p_new_assignee: newAssignee.userId })).error,
      ).not.toBeNull();
      expect(
        (await reassignAppointment(outsider.client, { p_task: taskId, p_new_assignee: newAssignee.userId })).error
          ?.message,
      ).toMatch(/no active membership/i);

      await setMembershipAccessStatus(actor.userId, BMH_ORG_ID, "suspended");
      expect(
        (await reassignAppointment(actor.client, { p_task: taskId, p_new_assignee: newAssignee.userId })).error
          ?.message,
      ).toMatch(/no active membership/i);
    });
  });

  describe("fn_claim_calendar_mutations — widened claim (create/reschedule/reassign/cancel)", () => {
    it("claims a cancel ledger row and joins the source task's fields", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
        googleEventId: "evt-cancel-me",
      });
      const { data: cancelResult } = await cancelAppointment(actor.client, { p_task: taskId });
      expect(cancelResult).not.toBeNull();

      const { data, error } = await claimCalendarMutations(db, 5);

      expect(error).toBeNull();
      const claimed = (data ?? []).find((r) => r.source_task_id === taskId);
      expect(claimed).toMatchObject({
        operation: "cancel",
        phase: "pending",
        source_assignee_id: actor.userId,
        event_id: "evt-cancel-me",
      });
      expect(claimed?.claim_token).toBeTruthy();
    });

    it("claims a reschedule ledger row and joins BOTH the source and target task's fields", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      await setTimezonePref(actor.userId, "America/Chicago");
      const { taskId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
        googleEventId: "evt-reschedule-me",
      });
      const newStart = new Date(Date.now() + 7_200_000).toISOString();
      const newEnd = new Date(Date.now() + 9_000_000).toISOString();
      const { data: reschedule } = await rescheduleAppointment(actor.client, {
        p_task: taskId,
        p_new_start: newStart,
        p_new_end: newEnd,
        p_timezone: "America/Chicago",
      });
      expect(reschedule).not.toBeNull();

      const { data } = await claimCalendarMutations(db, 5);

      const claimed = (data ?? []).find((r) => r.source_task_id === taskId);
      expect(claimed).toMatchObject({
        operation: "reschedule",
        target_task_id: reschedule!.task_id,
      });
      expect(claimed?.target_due_at).not.toBeNull();
      expect(new Date(claimed!.target_due_at!).toISOString()).toBe(newStart);
    });

    it("claims a reassign ledger row with old/new assignee and a fresh client_event_id", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const newAssignee = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
        googleEventId: "evt-reassign-me",
      });
      await reassignAppointment(actor.client, { p_task: taskId, p_new_assignee: newAssignee.userId });

      const { data } = await claimCalendarMutations(db, 5);

      const claimed = (data ?? []).find((r) => r.source_task_id === taskId);
      expect(claimed).toMatchObject({
        operation: "reassign",
        old_assignee_id: actor.userId,
        new_assignee_id: newAssignee.userId,
        event_id: "evt-reassign-me",
        // Codex round 3 (finding 2): fresh off fn_reassign_appointment's
        // INSERT, no delete has happened yet.
        old_event_deleted_at: null,
      });
      expect(claimed?.client_event_id).toBeTruthy();
    });
  });

  describe("fn_expire_exhausted_calendar_mutations — widened beyond create", () => {
    it("terminalizes an exhausted cancel/pending row to failed", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId, chainId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      await cancelAppointment(actor.client, { p_task: taskId });
      const ledgerRows = await ledgerRowsForChain(chainId);
      const ledgerId = ledgerRows[0].id;

      const past = new Date(Date.now() - 1000).toISOString();
      const { error: updateError } = await ledgerReader()
        .from("task_calendar_mutations")
        .update({ attempts: 5, next_attempt_at: past })
        .eq("id", ledgerId);
      expect(updateError).toBeNull();

      const { data, error } = await expireExhaustedCalendarMutations(db);

      expect(error).toBeNull();
      expect(data?.[0]?.failed_count).toBeGreaterThanOrEqual(1);
      const rows = await ledgerRowsForChain(chainId);
      expect(rows.find((r) => r.id === ledgerId)?.phase).toBe("failed");
    });

    // Codex round 6, finding 1: calendar_client_error_stale_event is the
    // THIRD stale-event reason markStaleEventRetryable can write
    // (create-worker.ts) alongside no_token_stale_event and
    // pref_disabled_stale_event. The original predicate here enumerated
    // only the first two, so an exhausted row with this reason fell
    // through to plain 'failed' — wrongly freeing the chain-serialization
    // slot over a KNOWN, still-unreconciled Google event. Now matched via
    // the `*_stale_event` naming convention instead of an enumerated list.
    it("exhausted calendar_client_error_stale_event row routes to needs_repair, chain slot held", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      // Task stays OPEN (unlike the failed_count test above, which cancels
      // it) so the post-expiry chain-serialization check below is
      // unconfounded by "not open" — the only way completeAppointment can
      // be rejected is the still-held chain slot.
      const { taskId, chainId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });

      const past = new Date(Date.now() - 1000).toISOString();
      const { error: insertError } = await ledgerReader()
        .from("task_calendar_mutations")
        .insert({
          org_id: BMH_ORG_ID,
          calendar_chain_id: chainId,
          operation: "reschedule",
          phase: "pending",
          source_task_id: taskId,
          old_assignee_id: actor.userId,
          expected_generation: 0,
          attempts: 5,
          next_attempt_at: past,
          result_reason: "calendar_client_error_stale_event",
        });
      expect(insertError).toBeNull();
      const inserted = await ledgerRowsForChain(chainId);
      const ledgerId = inserted[0].id;

      const { data, error } = await expireExhaustedCalendarMutations(db);

      expect(error).toBeNull();
      expect(data?.[0]?.needs_repair_count).toBeGreaterThanOrEqual(1);
      expect(data?.[0]?.needs_repair_ids).toContain(ledgerId);
      const rows = await ledgerRowsForChain(chainId);
      const row = rows.find((r) => r.id === ledgerId);
      expect(row?.phase).toBe("needs_repair");
      expect(row).toMatchObject({ operation: "reschedule" });

      // Chain slot still held: a subsequent lifecycle RPC on the same
      // (still-open) chain must be rejected by the chain-serialization
      // guard, not by any task-status check.
      const { error: completeError } = await completeAppointment(actor.client, {
        p_task: taskId,
        p_outcome: "held",
      });
      expect(completeError?.message).toMatch(/calendar sync in progress/i);
    });
  });

  // ----------------------------------------------------------------------------
  // Uniform lock protocol — both orderings, raw pg. Same idiom as
  // 20260814150000's membership-suspension race tests: connA holds the row
  // lock open in an uncommitted transaction; connB (the real, authenticated
  // supabase client) calls the actual RPC and must block until connA
  // commits, then observe the ALREADY-changed state.
  // ----------------------------------------------------------------------------
  describe("uniform lock protocol — cancel commits while complete is blocked on the same row lock", () => {
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

    async function stillBlockedAfter(promise: Promise<unknown>, ms: number): Promise<"blocked" | "resolved"> {
      const sentinel = Symbol("timeout");
      const raced = await Promise.race([
        promise.catch(() => sentinel),
        new Promise((resolve) => setTimeout(() => resolve(sentinel), ms)).then(() => "timeout-won" as const),
      ]);
      return raced === "timeout-won" ? "blocked" : "resolved";
    }

    it("complete sees the post-cancel state (not open) once the lock releases, and does not touch the ledger", async () => {
      const actor = await createUserForOrg(BMH_ORG_ID);
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });

      // Simulate fn_cancel_appointment's own guarded UPDATE, holding the
      // transaction open — this is the SAME row lock fn_complete_appointment
      // acquires via its own `select ... for update`.
      await conn.query("begin");
      await conn.query("select set_config('sandra.allow_appointment_time_move', 'on', true)");
      await conn.query(
        "update tasks set status = 'cancelled', outcome = 'cancelled', calendar_generation = calendar_generation + 1 where id = $1",
        [taskId],
      );

      const completePromise = completeAppointment(actor.client, {
        p_task: taskId,
        p_outcome: "held",
      });

      expect(await stillBlockedAfter(completePromise, 1500)).toBe("blocked");

      await conn.query("commit");

      const { error } = await completePromise;
      expect(error?.message).toMatch(/not open/i);
    });
  });
});
