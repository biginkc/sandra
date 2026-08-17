import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  rpc(
    fn: "fn_cancel_appointment",
    args: CancelArgs,
  ): Promise<RpcResult<CancelRow>>;
  rpc(
    fn: "fn_reschedule_appointment",
    args: RescheduleArgs,
  ): Promise<RpcResult<RescheduleRow>>;
};

function asLifecycleRpcClient(
  client: SupabaseClient<Database>,
): LifecycleRpcClient {
  return client as unknown as LifecycleRpcClient;
}

function cancelAppointment(client: SupabaseClient<Database>, args: CancelArgs) {
  return asLifecycleRpcClient(client).rpc("fn_cancel_appointment", args);
}
function rescheduleAppointment(
  client: SupabaseClient<Database>,
  args: RescheduleArgs,
) {
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
        ): Promise<{
          data: LedgerRow[] | null;
          error: { message: string } | null;
        }>;
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

/** Stands in for the calendar-mutation-sweep worker between real RPC
 *  calls: every lifecycle RPC opens its own pending ledger row, and the
 *  NEXT lifecycle call on the same chain would trip the "calendar sync in
 *  progress" guard until the worker terminalizes it. That guard has its
 *  own coverage in the 20260814210000 suite — this suite is about
 *  chain-cancel visibility, so the ledger is finalized between calls the
 *  same way the worker would after a successful (no-token no-op) sync. */
async function finalizeChainLedger(chainId: string): Promise<void> {
  const { error } = await (
    serviceClient as unknown as {
      from(table: "task_calendar_mutations"): {
        update(values: { phase: string }): {
          eq(
            column: "calendar_chain_id",
            value: string,
          ): {
            in(
              column: "phase",
              values: string[],
            ): Promise<{ error: { message: string } | null }>;
          };
        };
      };
    }
  )
    .from("task_calendar_mutations")
    .update({ phase: "finalized" })
    .eq("calendar_chain_id", chainId)
    .in("phase", ["pending", "provider_done", "needs_repair"]);
  expect(error).toBeNull();
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
  return `mig20260816090000-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
}

async function createUserForOrg(orgId = BMH_ORG_ID) {
  const user = await createOrgUser(serviceClient, {
    orgId,
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
  orgId?: string;
  chainId?: string;
  contactId?: string | null;
  propertyId?: string | null;
}): Promise<{ taskId: string; chainId: string }> {
  const chainId = opts.chainId ?? randomUUID();
  const dueAt = new Date(Date.now() + 3_600_000).toISOString();
  const endAt = new Date(Date.now() + 5_400_000).toISOString();
  const { data, error } = await db
    .from("tasks")
    .insert({
      org_id: opts.orgId ?? BMH_ORG_ID,
      type: "appointment",
      status: "open",
      title: "Chain-visibility test appointment",
      due_at: dueAt,
      end_at: endAt,
      assignee_id: opts.assigneeId,
      created_by: opts.createdBy,
      calendar_chain_id: chainId,
      google_calendar_event_id: null,
      contact_id: opts.contactId ?? null,
      related_property_id: opts.propertyId ?? null,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { taskId: data!.id, chainId };
}

async function insertContact(label: string): Promise<string> {
  const { data, error } = await db
    .from("contacts")
    .insert({
      org_id: BMH_ORG_ID,
      contact_type: "person",
      first_name: label,
      last_name: "Backfill Guard",
      phone_1: `+1816${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function insertProperty(contactId: string): Promise<string> {
  const { data, error } = await db
    .from("properties")
    .insert({
      org_id: BMH_ORG_ID,
      address: `DNC backfill ${randomUUID()}`,
      state: "MO",
      status: "new_lead",
      homeowner_contact_id: contactId,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

function testDbUrl(): string {
  const env = loadTestEnv();
  const value = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!value) throw new Error("Missing TEST_SUPABASE_DB_URL");
  return value;
}

function migrationBackfillSql(): string {
  const migration = readFileSync(
    path.join(
      process.cwd(),
      "supabase/migrations/20260816090000_cancel_chain_visibility.sql",
    ),
    "utf8",
  );
  const start = migration.indexOf(
    "select set_config('sandra.allow_appointment_time_move', 'on', true);",
  );
  const end = migration.lastIndexOf("\ncommit;");
  if (start < 0 || end <= start)
    throw new Error("Unable to locate migration backfill SQL");
  return migration.slice(start, end);
}

async function setTimezonePref(
  userId: string,
  timezone = "America/Chicago",
): Promise<void> {
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

describe("Migration 20260816090000 — cancel chain visibility", () => {
  describe("fn_cancel_appointment — chain-aware cancel", () => {
    it("reschedule then cancel the successor: predecessor flips to cancelled/cancelled (calendar-invisible), successor is cancelled/cancelled too", async () => {
      const actor = await createUserForOrg();
      await setTimezonePref(actor.userId);
      const { taskId: predecessorId, chainId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
      });

      const { successorId } = await reschedule(actor.client, predecessorId);
      await finalizeChainLedger(chainId);

      const predecessorAfterReschedule = await readTask(predecessorId);
      expect(predecessorAfterReschedule).toMatchObject({
        status: "completed",
        outcome: "rescheduled",
        calendar_generation: 1,
      });
      // Sanity: this is the exact stale state the bug left behind pre-fix —
      // status=completed IS in the calendar's visible-status set.
      expect(isCalendarVisibleStatus(predecessorAfterReschedule.status)).toBe(
        true,
      );

      const { data: cancelResult, error: cancelError } =
        await cancelAppointment(actor.client, {
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
      expect(isCalendarVisibleStatus(predecessorAfterCancel.status)).toBe(
        false,
      );
      // completed_at/completed_by from the reschedule-close are preserved,
      // not touched by the chain-cancel flip.
      expect(predecessorAfterCancel.completed_at).toBe(
        predecessorAfterReschedule.completed_at,
      );
      expect(predecessorAfterCancel.completed_by).toBe(
        predecessorAfterReschedule.completed_by,
      );

      // Only the target's own cancel opens a ledger row — no ledger entry
      // is created for the predecessor (no outstanding Google-side work).
      const ledgerRows = await ledgerRowsForChain(chainId);
      expect(ledgerRows.filter((r) => r.operation === "cancel")).toHaveLength(
        1,
      );
      expect(
        ledgerRows.find((r) => r.operation === "cancel")?.source_task_id,
      ).toBe(successorId);
    });

    it("multi-hop chain (reschedule, reschedule, cancel): every predecessor is flipped, not just the immediate one", async () => {
      const actor = await createUserForOrg();
      await setTimezonePref(actor.userId);
      const { taskId: hop1Id, chainId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
      });

      const { successorId: hop2Id } = await reschedule(actor.client, hop1Id);
      await finalizeChainLedger(chainId);
      const { successorId: hop3Id } = await reschedule(actor.client, hop2Id);
      await finalizeChainLedger(chainId);

      const { error: cancelError } = await cancelAppointment(actor.client, {
        p_task: hop3Id,
      });
      expect(cancelError).toBeNull();

      const hop1 = await readTask(hop1Id);
      const hop2 = await readTask(hop2Id);
      const hop3 = await readTask(hop3Id);

      for (const row of [hop1, hop2, hop3]) {
        expect(row).toMatchObject({
          status: "cancelled",
          outcome: "cancelled",
        });
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
      expect(otherPredecessorBefore).toMatchObject({
        status: "completed",
        outcome: "rescheduled",
      });

      const { data, error } = await cancelAppointment(actor.client, {
        p_task: plainTaskId,
      });
      expect(error).toBeNull();
      expect(data?.status).toBe("cancelled");

      const plainAfter = await readTask(plainTaskId);
      expect(plainAfter).toMatchObject({
        status: "cancelled",
        outcome: "cancelled",
        calendar_generation: 1,
      });

      // Chain B's rescheduled predecessor is completely unaffected.
      const otherPredecessorAfter = await readTask(otherPredecessorId);
      expect(otherPredecessorAfter).toEqual(otherPredecessorBefore);
    });

    it("never crosses organizations when two tenants choose the same chain id, including the historical backfill", async () => {
      const orgAActor = await createUserForOrg(BMH_ORG_ID);
      const orgBActor = await createUserForOrg(TEST_ORG_B_ID);
      await setTimezonePref(orgAActor.userId);
      await setTimezonePref(orgBActor.userId);
      const sharedChainId = randomUUID();

      const orgA = await insertOpenAppointment({
        assigneeId: orgAActor.userId,
        createdBy: orgAActor.userId,
        orgId: BMH_ORG_ID,
        chainId: sharedChainId,
      });
      const { successorId: orgASuccessorId } = await reschedule(
        orgAActor.client,
        orgA.taskId,
      );
      await finalizeChainLedger(sharedChainId);

      const orgB = await insertOpenAppointment({
        assigneeId: orgBActor.userId,
        createdBy: orgBActor.userId,
        orgId: TEST_ORG_B_ID,
        chainId: sharedChainId,
      });
      const orgBCancel = await cancelAppointment(orgBActor.client, {
        p_task: orgB.taskId,
      });
      expect(orgBCancel.error).toBeNull();

      // Cancelling org B must not rewrite org A's rescheduled history.
      expect(await readTask(orgA.taskId)).toMatchObject({
        status: "completed",
        outcome: "rescheduled",
      });
      expect(await readTask(orgASuccessorId)).toMatchObject({ status: "open" });

      // Nor may the historical backfill use org B's cancelled terminal row
      // as evidence that org A's same-id chain is terminal.
      const conn = new Client({ connectionString: testDbUrl() });
      await conn.connect();
      try {
        await conn.query("begin");
        await conn.query(migrationBackfillSql());
        await conn.query("commit");
      } catch (error) {
        await conn.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        await conn.end();
      }
      expect(await readTask(orgA.taskId)).toMatchObject({
        status: "completed",
        outcome: "rescheduled",
      });
    });

    it("rejects cancelling an already-cancelled appointment (not-open guard still holds after the chain-visibility change)", async () => {
      const actor = await createUserForOrg();
      const { taskId } = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
      });
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
      const { data: chainRows } = await db
        .from("tasks")
        .select("id")
        .eq("calendar_chain_id", chainId);
      expect((chainRows ?? []).length).toBe(2); // predecessor + the one successor

      const successorId = first.data!.task_id;
      await finalizeChainLedger(chainId);
      const { error: cancelError } = await cancelAppointment(actor.client, {
        p_task: successorId,
      });
      expect(cancelError).toBeNull();

      const predecessorAfter = await readTask(predecessorId);
      expect(predecessorAfter).toMatchObject({
        status: "cancelled",
        outcome: "cancelled",
      });
    });
  });

  describe("one-time backfill — permanent DNC compatibility", () => {
    it("skips property-linked and contact-only locked history while still cleaning an unlocked chain", async () => {
      const actor = await createUserForOrg();
      await setTimezonePref(actor.userId);

      const propertyContactId = await insertContact("Property linked");
      const propertyId = await insertProperty(propertyContactId);
      const contactOnlyId = await insertContact("Contact only");

      const propertyChain = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
        contactId: propertyContactId,
        propertyId,
      });
      const contactChain = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
        contactId: contactOnlyId,
      });
      const unlockedChain = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
      });

      for (const chain of [propertyChain, contactChain, unlockedChain]) {
        const { successorId } = await reschedule(actor.client, chain.taskId);
        await finalizeChainLedger(chain.chainId);
        const cancelled = await cancelAppointment(actor.client, {
          p_task: successorId,
        });
        expect(cancelled.error).toBeNull();
      }

      // Recreate the exact historical stale shape that existed before this
      // migration. This must happen before either permanent lock ratchets,
      // because locked task history is intentionally immutable.
      const conn = new Client({ connectionString: testDbUrl() });
      await conn.connect();
      try {
        await conn.query("begin");
        await conn.query(
          "select set_config('sandra.allow_appointment_time_move', 'on', true)",
        );
        await conn.query(
          `update public.tasks
             set status = 'completed', outcome = 'rescheduled'
           where id = any($1::uuid[])`,
          [[propertyChain.taskId, contactChain.taskId, unlockedChain.taskId]],
        );
        await conn.query("commit");

        const propertyDnc = await db
          .from("contacts")
          .update({ do_not_contact: true })
          .eq("id", propertyContactId);
        expect(propertyDnc.error).toBeNull();
        const contactDnc = await db
          .from("contacts")
          .update({ do_not_contact: true })
          .eq("id", contactOnlyId);
        expect(contactDnc.error).toBeNull();

        const { data: lockedProperty, error: propertyError } = await db
          .from("properties")
          .select("is_dnc_locked")
          .eq("id", propertyId)
          .single();
        expect(propertyError).toBeNull();
        expect(lockedProperty?.is_dnc_locked).toBe(true);

        await conn.query("begin");
        await conn.query(migrationBackfillSql());
        await conn.query("commit");
      } catch (error) {
        await conn.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        await conn.end();
      }

      expect(await readTask(propertyChain.taskId)).toMatchObject({
        status: "completed",
        outcome: "rescheduled",
      });
      expect(await readTask(contactChain.taskId)).toMatchObject({
        status: "completed",
        outcome: "rescheduled",
      });
      expect(await readTask(unlockedChain.taskId)).toMatchObject({
        status: "cancelled",
        outcome: "cancelled",
      });
    });

    it("waits for a concurrent permanent-DNC ratchet, then skips its newly locked history without aborting", async () => {
      const actor = await createUserForOrg();
      await setTimezonePref(actor.userId);
      const contactId = await insertContact("Concurrent ratchet");
      const chain = await insertOpenAppointment({
        assigneeId: actor.userId,
        createdBy: actor.userId,
        contactId,
      });
      const { successorId } = await reschedule(actor.client, chain.taskId);
      await finalizeChainLedger(chain.chainId);
      const cancelled = await cancelAppointment(actor.client, {
        p_task: successorId,
      });
      expect(cancelled.error).toBeNull();

      const setup = new Client({ connectionString: testDbUrl() });
      await setup.connect();
      try {
        await setup.query("begin");
        await setup.query(
          "select set_config('sandra.allow_appointment_time_move', 'on', true)",
        );
        await setup.query(
          `update public.tasks
             set status = 'completed', outcome = 'rescheduled'
           where id = $1`,
          [chain.taskId],
        );
        await setup.query("commit");
      } catch (error) {
        await setup.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        await setup.end();
      }

      const ratchet = new Client({ connectionString: testDbUrl() });
      const backfill = new Client({ connectionString: testDbUrl() });
      await ratchet.connect();
      await backfill.connect();
      try {
        await ratchet.query("begin");
        await ratchet.query(
          "update public.contacts set do_not_contact = true where id = $1",
          [contactId],
        );

        await backfill.query("begin");
        let backfillSettled = false;
        const backfillRun = backfill
          .query(migrationBackfillSql())
          .finally(() => {
            backfillSettled = true;
          });

        // The backfill must be waiting on the contact lock held by the
        // uncommitted ratchet, not racing ahead with a stale unlocked read.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(backfillSettled).toBe(false);

        await ratchet.query("commit");
        await backfillRun;
        await backfill.query("commit");
      } catch (error) {
        await ratchet.query("rollback").catch(() => undefined);
        await backfill.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        await ratchet.end();
        await backfill.end();
      }

      expect(await readTask(chain.taskId)).toMatchObject({
        status: "completed",
        outcome: "rescheduled",
      });
    });
  });
});
