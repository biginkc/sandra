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

import { kickCalendarMutationSync } from "./inline-sync-kick";

/**
 * Proves, against the real DB, the exact production bug this PR fixes:
 *
 *   1. `fn_book_appointment` opens a `task_calendar_mutations` row
 *      (operation='create', phase='pending') in the same transaction as
 *      the appointment.
 *   2. Every lifecycle RPC (here, `fn_reschedule_appointment`) raises
 *      "calendar sync in progress" while that row sits un-finalized — so,
 *      absent this PR, the caller is stuck until the next
 *      calendar-mutation-sweep cron tick (every 5 minutes).
 *   3. `kickCalendarMutationSync` — the exact function every action that
 *      opens a ledger row now calls right after its RPC commits — claims and
 *      finalizes that row immediately (org has no Google token configured,
 *      matching the prod evidence this bug was diagnosed from: every
 *      mutation finalizes on its first worker attempt with reason
 *      `no_token`), clearing the lock.
 *   4. `fn_reschedule_appointment` on the same task now succeeds.
 *
 * This exercises the REAL targeted claim RPC and the
 * REAL `processClaimedCalendarMutation` worker dispatch (both imported
 * transitively through `kickCalendarMutationSync`, not re-implemented or
 * stubbed here) — the same "simulate worker finalization" step
 * `20260814210000_appointment_lifecycle_rpcs.integration.test.ts`'s own
 * `finalizeLedgerRowsForChain` helper takes with a raw phase UPDATE, done
 * here by actually running the worker code this PR ships instead.
 */

type BookAppointmentArgs = {
  p_org: string;
  p_assignee: string;
  p_start: string;
  p_end: string;
  p_timezone: string;
  p_title: string;
  p_contact?: string | null;
  p_property?: string | null;
  p_description?: string | null;
  p_idempotency_key?: string | null;
};
type BookAppointmentRow = {
  task_id: string;
  calendar_chain_id: string;
  already_qualified: boolean;
  duplicate: boolean;
  related_property_id: string | null;
  contact_id: string | null;
};

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

type RpcResult<T> = {
  data: T | null;
  error: { message: string; code?: string } | null;
};

type InlineKickTestRpcClient = {
  rpc(
    fn: "fn_book_appointment",
    args: BookAppointmentArgs,
  ): Promise<RpcResult<BookAppointmentRow>>;
  rpc(
    fn: "fn_reschedule_appointment",
    args: RescheduleArgs,
  ): Promise<RpcResult<RescheduleRow>>;
};

function asRpcClient(
  client: SupabaseClient<Database>,
): InlineKickTestRpcClient {
  return client as unknown as InlineKickTestRpcClient;
}

function bookAppointment(
  client: SupabaseClient<Database>,
  args: BookAppointmentArgs,
) {
  return asRpcClient(client).rpc("fn_book_appointment", args);
}

function rescheduleAppointment(
  client: SupabaseClient<Database>,
  args: RescheduleArgs,
) {
  return asRpcClient(client).rpc("fn_reschedule_appointment", args);
}

type LedgerRow = {
  id: string;
  phase: string;
  result_reason: string | null;
  operation: string;
  attempts: number;
};
function ledgerRowsForTask(
  taskId: string,
): Promise<{ data: LedgerRow[] | null; error: unknown }> {
  return (
    db as unknown as {
      from(table: "task_calendar_mutations"): {
        select(columns: string): {
          eq(
            column: "source_task_id",
            value: string,
          ): Promise<{ data: LedgerRow[] | null; error: unknown }>;
        };
      };
    }
  )
    .from("task_calendar_mutations")
    .select("id, phase, result_reason, operation, attempts")
    .eq("source_task_id", taskId);
}

function windowArgs() {
  return {
    p_start: new Date(Date.now() + 3_600_000).toISOString(),
    p_end: new Date(Date.now() + 5_400_000).toISOString(),
  };
}

const serviceClient = createTestClient();
const db = serviceClient;
const createdUserIds: string[] = [];

function uniqueEmail(label: string): string {
  return `inline-sync-kick-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
}

async function createUserForOrg(orgId: string) {
  const user = await createOrgUser(serviceClient, {
    orgId,
    email: uniqueEmail(orgId.slice(-3)),
    role: "member",
  });
  createdUserIds.push(user.userId);
  return { ...user, client: clientForUser(user.jwt) };
}

beforeAll(async () => {
  // processClaimedCalendarCreation reaches getDecryptedToken, which needs
  // OAUTH_TOKEN_ENCRYPTION_KEY set before it can even conclude "no token
  // stored" (the no_token path this suite exercises — no oauth row exists
  // for the seeded users, so the key's value never decrypts anything).
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY ??=
    "integration-test-key-never-decrypts-anything";
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

describe("kickCalendarMutationSync — real DB: booking lock cleared inline instead of waiting on the cron sweep", () => {
  it("reschedule is locked out right after booking, and kickCalendarMutationSync clears it so the retry succeeds", async () => {
    const booker = await createUserForOrg(BMH_ORG_ID);
    const assignee = await createUserForOrg(BMH_ORG_ID);
    const { p_start, p_end } = windowArgs();

    // Seed an older unrelated backlog row first. A global oldest-first
    // inline claim would consume this row's attempt instead of the task the
    // user just changed — the regression this targeted RPC prevents.
    const unrelatedWindow = {
      p_start: new Date(Date.now() + 1_800_000).toISOString(),
      p_end: new Date(Date.now() + 2_700_000).toISOString(),
    };
    const { data: unrelated, error: unrelatedError } = await bookAppointment(
      booker.client,
      {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        ...unrelatedWindow,
        p_timezone: "America/Chicago",
        p_title: "Older unrelated backlog",
      },
    );
    expect(unrelatedError).toBeNull();

    // Step 1: book — fn_book_appointment opens the target create ledger row
    // (phase='pending') in the same transaction as the task.
    const { data: booked, error: bookErr } = await bookAppointment(
      booker.client,
      {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Walkthrough",
      },
    );
    expect(bookErr).toBeNull();
    expect(booked).not.toBeNull();
    const taskId = booked!.task_id;

    const ledgerBefore = await ledgerRowsForTask(taskId);
    expect(ledgerBefore.data).toHaveLength(1);
    expect(ledgerBefore.data![0]).toMatchObject({
      operation: "create",
      phase: "pending",
    });

    // Step 2: chain locked — the create row hasn't finalized yet, so the
    // very next lifecycle RPC on this appointment raises. This is the bug
    // in production: absent an inline kick, this window lasts up to 5
    // minutes (the cron sweep's own schedule).
    const newStart = new Date(Date.now() + 7_200_000).toISOString();
    const newEnd = new Date(Date.now() + 9_000_000).toISOString();
    const { data: lockedReschedule, error: lockedErr } =
      await rescheduleAppointment(booker.client, {
        p_task: taskId,
        p_new_start: newStart,
        p_new_end: newEnd,
        p_timezone: "America/Chicago",
      });
    expect(lockedReschedule).toBeNull();
    expect(lockedErr).not.toBeNull();
    expect(lockedErr?.message).toMatch(/calendar sync in progress/i);

    // Step 3: the inline kick — the exact function every appointment
    // server action now calls right after its RPC commits. No Google
    // token is configured for `assignee` (fresh test user), so this
    // finalizes the create row as a no-op (`no_token`) without ever
    // calling Google — same as prod's org-with-no-token evidence.
    await kickCalendarMutationSync(db, taskId);

    const ledgerAfter = await ledgerRowsForTask(taskId);
    expect(ledgerAfter.data).toHaveLength(1);
    expect(ledgerAfter.data![0]).toMatchObject({
      operation: "create",
      phase: "finalized",
      result_reason: "no_token",
      attempts: 1,
    });

    const unrelatedLedger = await ledgerRowsForTask(unrelated!.task_id);
    expect(unrelatedLedger.data).toHaveLength(1);
    expect(unrelatedLedger.data![0]).toMatchObject({
      operation: "create",
      phase: "pending",
      attempts: 0,
    });

    // Step 4: the lock is gone — the SAME reschedule call that raised
    // above now succeeds.
    const { data: reschedule, error: rescheduleErr } =
      await rescheduleAppointment(booker.client, {
        p_task: taskId,
        p_new_start: newStart,
        p_new_end: newEnd,
        p_timezone: "America/Chicago",
      });
    expect(rescheduleErr).toBeNull();
    expect(reschedule).not.toBeNull();
    expect(reschedule!.old_task_id).toBe(taskId);
  });

  it("does not expose the targeted claim RPC to an authenticated member", async () => {
    const member = await createUserForOrg(BMH_ORG_ID);
    const result = await (
      member.client as unknown as {
        rpc(
          fn: "fn_claim_calendar_mutation_for_task",
          args: { p_source_task: string },
        ): Promise<{ error: { message: string } | null }>;
      }
    ).rpc("fn_claim_calendar_mutation_for_task", {
      p_source_task: "00000000-0000-0000-0000-000000000001",
    });

    expect(result.error?.message).toMatch(/permission denied/i);
  });
});
