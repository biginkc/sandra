import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import {
  BMH_ORG_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import type { Database } from "@/lib/supabase/types";

// ----------------------------------------------------------------------------
// Same local-cast rationale as 20260814210000_appointment_lifecycle_rpcs's
// own integration suite: fn_cancel_appointment / fn_reschedule_appointment
// aren't in the generated Database["public"]["Functions"] map.
// ----------------------------------------------------------------------------
type RpcResult<T> = {
  data: T | null;
  error: { message: string; code?: string } | null;
};

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

type LifecycleRpcClient = {
  rpc(fn: "fn_cancel_appointment", args: CancelArgs): Promise<RpcResult<CancelRow>>;
  rpc(fn: "fn_reschedule_appointment", args: RescheduleArgs): Promise<RpcResult<RescheduleRow>>;
};

function asLifecycleRpcClient(client: SupabaseClient<Database>): LifecycleRpcClient {
  return client as unknown as LifecycleRpcClient;
}

function cancelAppointment(client: SupabaseClient<Database>, args: CancelArgs) {
  return asLifecycleRpcClient(client).rpc("fn_cancel_appointment", args);
}
function rescheduleAppointment(client: SupabaseClient<Database>, args: RescheduleArgs) {
  return asLifecycleRpcClient(client).rpc("fn_reschedule_appointment", args);
}

// task_calendar_mutations columns not on the generated Database type yet —
// same read shape as the 20260814210000 suite, trimmed to what this file
// asserts on.
type LedgerRow = {
  id: string;
  operation: string;
  source_task_id: string;
};
function ledgerReader(client: SupabaseClient<Database> = db) {
  return client as unknown as {
    from(table: "task_calendar_mutations"): {
      select(columns: string): {
        eq(
          column: "calendar_chain_id",
          value: string,
        ): Promise<{ data: LedgerRow[] | null; error: { message: string } | null }>;
      };
    };
  };
}
async function ledgerRowsForChain(chainId: string): Promise<LedgerRow[]> {
  const { data, error } = await ledgerReader()
    .from("task_calendar_mutations")
    .select("id, operation, source_task_id")
    .eq("calendar_chain_id", chainId);
  expect(error).toBeNull();
  return data ?? [];
}

/** Reproduces calendar/queries.ts's `.in("status", ["open", "completed"])`
 *  filter — a row is calendar-visible iff this returns true. */
function isCalendarVisibleStatus(status: string): boolean {
  return status === "open" || status === "completed";
}

const serviceClient = createTestClient();
const db = serviceClient;
const createdUserIds: string[] = [];

function uniqueEmail(label: string): string {
  return `mig20260815120000-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
}

async function createUserForOrg() {
  const user = await createOrgUser(serviceClient, {
    orgId: BMH_ORG_ID,
    email: uniqueEmail("member"),
    role: "member",
  });
  createdUserIds.push(user.userId);
  return { ...user, client: clientForUser(user.jwt) };
}

/** Same shape as the 20260814210000 suite's own helper: a canonical-open
 *  appointment, no ledger row, no flag needed. */
async function insertOpenAppointment(opts: {
  assigneeId: string;
  createdBy: string;
  chainId?: string;
}): Promise<{ taskId: string; chainId: string }> {
  const chainId = opts.chainId ?? randomUUID();
  const dueAt = new Date(Date.now() + 3_600_000).toISOString();
  const endAt = new Date(Date.now() + 5_400_000).toISOString();
  const { data, error } = await db
    .from("tasks")
    .insert({
      org_id: BMH_ORG_ID,
      type: "appointment",
      status: "open",
      title: "Chain-visibility test appointment",
      due_at: dueAt,
      end_at: endAt,
      assignee_id: opts.assigneeId,
      created_by: opts.createdBy,
      calendar_chain_id: chainId,
      google_calendar_event_id: null,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { taskId: data!.id, chainId };
}

async function setTimezonePref(userId: string, timezone = "America/Chicago"): Promise<void> {
  const { error } = await db
    .from("user_integration_prefs")
    .upsert({ user_id: userId, channel: "google_calendar", timezone });
  expect(error).toBeNull();
}

type TaskRow = {
  status: string;
  outcome: string | null;
  calendar_generation: number;
  completed_at: string | null;
  completed_by: string | null;
};
async function readTask(taskId: string): Promise<TaskRow> {
  const { data, error } = await db
    .from("tasks")
    .select("status, outcome, calendar_generation, completed_at, completed_by")
    .eq("id", taskId)
    .single();
  expect(error).toBeNull();
  return data as TaskRow;
}

async function reschedule(
  client: SupabaseClient<Database>,
  taskId: string,
): Promise<{ successorId: string }> {
  const newStart = new Date(Date.now() + 7_200_000).toISOString();
  const newEnd = new Date(Date.now() + 9_000_000).toISOString();
  const { data, error } = await rescheduleAppointment(client, {
    p_task: taskId,
    p_new_start: newStart,
    p_new_end: newEnd,
    p_timezone: "America/Chicago",
  });
  expect(error).toBeNull();
  return { successorId: data!.task_id };
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

describe("Migration 20260815120000 — cancel chain visibility", () => {
  describe("fn_cancel_appointment — chain-aware cancel", () => {
    it("reschedule then cancel the successor: predecessor flips to cancelled/cancelled (calendar-invisible), successor is cancelled/cancelled too", async () => {
      const actor = await createUserForOrg();
      await setTimezonePref(actor.userId);
      const { taskId: predecessorId, chainId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
      });

      const { successorId } = await reschedule(actor.client, predecessorId);

      const predecessorAfterReschedule = await readTask(predecessorId);
      expect(predecessorAfterReschedule).toMatchObject({
        status: "completed",
        outcome: "rescheduled",
        calendar_generation: 1,
      });
      // Sanity: this is the exact stale state the bug left behind pre-fix —
      // status=completed IS in the calendar's visible-status set.
      expect(isCalendarVisibleStatus(predecessorAfterReschedule.status)).toBe(true);

      const { data: cancelResult, error: cancelError } = await cancelAppointment(actor.client, {
        p_task: successorId,
      });
      expect(cancelError).toBeNull();
      expect(cancelResult?.status).toBe("cancelled");

      const successorAfterCancel = await readTask(successorId);
      expect(successorAfterCancel).toMatchObject({
        status: "cancelled",
        outcome: "cancelled",
        calendar_generation: 1,
      });
      expect(isCalendarVisibleStatus(successorAfterCancel.status)).toBe(false);

      const predecessorAfterCancel = await readTask(predecessorId);
      expect(predecessorAfterCancel).toMatchObject({
        status: "cancelled",
        outcome: "cancelled",
        // Bumped once more on top of the reschedule-close bump (1 -> 2).
        calendar_generation: 2,
      });
      expect(isCalendarVisibleStatus(predecessorAfterCancel.status)).toBe(false);
      // completed_at/completed_by from the reschedule-close are preserved,
      // not touched by the chain-cancel flip.
      expect(predecessorAfterCancel.completed_at).toBe(predecessorAfterReschedule.completed_at);
      expect(predecessorAfterCancel.completed_by).toBe(predecessorAfterReschedule.completed_by);

      // Only the target's own cancel opens a ledger row — no ledger entry
      // is created for the predecessor (no outstanding Google-side work).
      const ledgerRows = await ledgerRowsForChain(chainId);
      expect(ledgerRows.filter((r) => r.operation === "cancel")).toHaveLength(1);
      expect(ledgerRows.find((r) => r.operation === "cancel")?.source_task_id).toBe(successorId);
    });

    it("multi-hop chain (reschedule, reschedule, cancel): every predecessor is flipped, not just the immediate one", async () => {
      const actor = await createUserForOrg();
      await setTimezonePref(actor.userId);
      const { taskId: hop1Id, chainId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
      });

      const { successorId: hop2Id } = await reschedule(actor.client, hop1Id);
      const { successorId: hop3Id } = await reschedule(actor.client, hop2Id);

      const { error: cancelError } = await cancelAppointment(actor.client, { p_task: hop3Id });
      expect(cancelError).toBeNull();

      const hop1 = await readTask(hop1Id);
      const hop2 = await readTask(hop2Id);
      const hop3 = await readTask(hop3Id);

      for (const row of [hop1, hop2, hop3]) {
        expect(row).toMatchObject({ status: "cancelled", outcome: "cancelled" });
        expect(isCalendarVisibleStatus(row.status)).toBe(false);
      }

      // Sanity on the chain identity — all three hops really do share one
      // calendar_chain_id (otherwise this test would trivially pass).
      const { data: chainRows, error: chainError } = await db
        .from("tasks")
        .select("id")
        .eq("calendar_chain_id", chainId);
      expect(chainError).toBeNull();
      expect((chainRows ?? []).map((r) => r.id).sort()).toEqual(
        [hop1Id, hop2Id, hop3Id].sort(),
      );
    });

    it("cancel of a never-rescheduled appointment is unaffected, and does not leak across chains", async () => {
      const actor = await createUserForOrg();
      await setTimezonePref(actor.userId);

      // Chain A: plain appointment, never rescheduled.
      const { taskId: plainTaskId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
      });

      // Chain B: rescheduled but its chain is NOT being cancelled — must
      // stay untouched by chain A's cancel (proves the chain-scoped WHERE
      // clause is scoped correctly and doesn't spill across chains).
      const { taskId: otherPredecessorId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
      });
      await reschedule(actor.client, otherPredecessorId);
      const otherPredecessorBefore = await readTask(otherPredecessorId);
      expect(otherPredecessorBefore).toMatchObject({ status: "completed", outcome: "rescheduled" });

      const { data, error } = await cancelAppointment(actor.client, { p_task: plainTaskId });
      expect(error).toBeNull();
      expect(data?.status).toBe("cancelled");

      const plainAfter = await readTask(plainTaskId);
      expect(plainAfter).toMatchObject({ status: "cancelled", outcome: "cancelled", calendar_generation: 1 });

      // Chain B's rescheduled predecessor is completely unaffected.
      const otherPredecessorAfter = await readTask(otherPredecessorId);
      expect(otherPredecessorAfter).toEqual(otherPredecessorBefore);
    });

    it("rejects cancelling an already-cancelled appointment (not-open guard still holds after the chain-visibility change)", async () => {
      const actor = await createUserForOrg();
      const { taskId } = await insertOpenAppointment({ assigneeId: actor.userId, createdBy: actor.userId });
      const first = await cancelAppointment(actor.client, { p_task: taskId });
      expect(first.error).toBeNull();

      const second = await cancelAppointment(actor.client, { p_task: taskId });

      expect(second.error?.message).toMatch(/not open/i);
    });
  });

  describe("fn_reschedule_appointment idempotency-replay path — unaffected by this migration", () => {
    it("a repeat call with the same idempotency key still returns the SAME successor, and a subsequent cancel still chain-cancels the one true predecessor", async () => {
      const actor = await createUserForOrg();
      await setTimezonePref(actor.userId);
      const { taskId: predecessorId, chainId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
      });
      const key = randomUUID();
      const newStart = new Date(Date.now() + 7_200_000).toISOString();
      const newEnd = new Date(Date.now() + 9_000_000).toISOString();

      const first = await rescheduleAppointment(actor.client, {
        p_task: predecessorId,
        p_new_start: newStart,
        p_new_end: newEnd,
        p_timezone: "America/Chicago",
        p_idempotency_key: key,
      });
      expect(first.error).toBeNull();
      expect(first.data?.duplicate).toBe(false);

      const replay = await rescheduleAppointment(actor.client, {
        p_task: predecessorId,
        p_new_start: newStart,
        p_new_end: newEnd,
        p_timezone: "America/Chicago",
        p_idempotency_key: key,
      });
      expect(replay.error).toBeNull();
      expect(replay.data?.duplicate).toBe(true);
      expect(replay.data?.task_id).toBe(first.data?.task_id);

      // Exactly one successor exists in the chain despite two reschedule
      // calls — the replay-before-validation path is untouched by this
      // migration.
      const { data: chainRows } = await db.from("tasks").select("id").eq("calendar_chain_id", chainId);
      expect((chainRows ?? []).length).toBe(2); // predecessor + the one successor

      const successorId = first.data!.task_id;
      const { error: cancelError } = await cancelAppointment(actor.client, { p_task: successorId });
      expect(cancelError).toBeNull();

      const predecessorAfter = await readTask(predecessorId);
      expect(predecessorAfter).toMatchObject({ status: "cancelled", outcome: "cancelled" });
    });
  });
});
