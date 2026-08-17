import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
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
import type { Database } from "@/lib/supabase/types";

type RpcResult<T> = {
  data: T | null;
  error: { message: string; code?: string } | null;
};
type LifecycleRpcClient = {
  rpc(
    fn: "fn_cancel_appointment",
    args: { p_task: string },
  ): Promise<RpcResult<{ task_id: string; status: string; ledger_id: string }>>;
  rpc(
    fn: "fn_reschedule_appointment",
    args: {
      p_task: string;
      p_new_start: string;
      p_new_end: string;
      p_timezone: string;
      p_idempotency_key?: string | null;
    },
  ): Promise<
    RpcResult<{
      task_id: string;
      old_task_id: string;
      calendar_chain_id: string;
      duplicate: boolean;
      ledger_id: string;
    }>
  >;
};

function rpc(client: SupabaseClient<Database>): LifecycleRpcClient {
  return client as unknown as LifecycleRpcClient;
}

const serviceClient = createTestClient();
const createdUserIds: string[] = [];

async function createUserForOrg(orgId = BMH_ORG_ID) {
  const user = await createOrgUser(serviceClient, {
    orgId,
    email: `cancel-history-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`,
    role: "member",
  });
  createdUserIds.push(user.userId);
  await serviceClient.from("user_integration_prefs").upsert({
    user_id: user.userId,
    channel: "google_calendar",
    timezone: "America/Chicago",
  });
  return { ...user, client: clientForUser(user.jwt) };
}

async function insertOpenAppointment(opts: {
  assigneeId: string;
  orgId?: string;
  chainId?: string;
  contactId?: string | null;
  propertyId?: string | null;
}) {
  const chainId = opts.chainId ?? randomUUID();
  const { data, error } = await serviceClient
    .from("tasks")
    .insert({
      org_id: opts.orgId ?? BMH_ORG_ID,
      type: "appointment",
      status: "open",
      title: "Cancel history contract",
      due_at: new Date(Date.now() + 3_600_000).toISOString(),
      end_at: new Date(Date.now() + 5_400_000).toISOString(),
      assignee_id: opts.assigneeId,
      created_by: opts.assigneeId,
      calendar_chain_id: chainId,
      contact_id: opts.contactId ?? null,
      related_property_id: opts.propertyId ?? null,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { taskId: data!.id, chainId };
}

async function finalizeChain(chainId: string) {
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

async function reschedule(client: SupabaseClient<Database>, taskId: string) {
  const { data, error } = await rpc(client).rpc("fn_reschedule_appointment", {
    p_task: taskId,
    p_new_start: new Date(Date.now() + 7_200_000).toISOString(),
    p_new_end: new Date(Date.now() + 9_000_000).toISOString(),
    p_timezone: "America/Chicago",
  });
  expect(error).toBeNull();
  return data!.task_id;
}

type TaskState = {
  status: string;
  outcome: string | null;
  calendar_generation: number;
  completed_at: string | null;
  completed_by: string | null;
};
async function readTask(taskId: string): Promise<TaskState> {
  const { data, error } = await serviceClient
    .from("tasks")
    .select("status, outcome, calendar_generation, completed_at, completed_by")
    .eq("id", taskId)
    .single();
  expect(error).toBeNull();
  return data as TaskState;
}

beforeAll(async () => {
  await seedTwoOrgs(serviceClient);
});
beforeEach(async () => {
  await resetTenantTables(serviceClient);
});
afterAll(async () => {
  for (const id of createdUserIds)
    await serviceClient.auth.admin.deleteUser(id);
  await resetTenantTables(serviceClient);
});

describe("Migration 20260816090000 — cancelled-chain read visibility", () => {
  it("cancels only the open successor and preserves its completed/rescheduled predecessor as audit history", async () => {
    const actor = await createUserForOrg();
    const original = await insertOpenAppointment({ assigneeId: actor.userId });
    const successorId = await reschedule(actor.client, original.taskId);
    await finalizeChain(original.chainId);
    const beforeCancel = await readTask(original.taskId);

    const { data, error } = await rpc(actor.client).rpc(
      "fn_cancel_appointment",
      { p_task: successorId },
    );
    expect(error).toBeNull();
    expect(data?.ledger_id).toMatch(/^[0-9a-f-]{36}$/);

    expect(await readTask(successorId)).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      calendar_generation: 1,
    });
    expect(await readTask(original.taskId)).toEqual(beforeCancel);
    expect(beforeCancel).toMatchObject({
      status: "completed",
      outcome: "rescheduled",
      calendar_generation: 1,
    });
    expect(beforeCancel.completed_at).not.toBeNull();
    expect(beforeCancel.completed_by).toBe(actor.userId);
  });

  it("preserves every predecessor in a multi-hop reschedule chain", async () => {
    const actor = await createUserForOrg();
    const hop1 = await insertOpenAppointment({ assigneeId: actor.userId });
    const hop2Id = await reschedule(actor.client, hop1.taskId);
    await finalizeChain(hop1.chainId);
    const hop3Id = await reschedule(actor.client, hop2Id);
    await finalizeChain(hop1.chainId);

    const before1 = await readTask(hop1.taskId);
    const before2 = await readTask(hop2Id);
    const { error } = await rpc(actor.client).rpc("fn_cancel_appointment", {
      p_task: hop3Id,
    });
    expect(error).toBeNull();
    expect(await readTask(hop1.taskId)).toEqual(before1);
    expect(await readTask(hop2Id)).toEqual(before2);
    expect(await readTask(hop3Id)).toMatchObject({ status: "cancelled" });
  });

  it("never treats a same-valued chain id in another organization as cancelled", async () => {
    const actorA = await createUserForOrg(BMH_ORG_ID);
    const actorB = await createUserForOrg(TEST_ORG_B_ID);
    const sharedChain = randomUUID();
    const orgA = await insertOpenAppointment({
      assigneeId: actorA.userId,
      orgId: BMH_ORG_ID,
      chainId: sharedChain,
    });
    const orgASuccessor = await reschedule(actorA.client, orgA.taskId);
    await finalizeChain(sharedChain);
    const orgB = await insertOpenAppointment({
      assigneeId: actorB.userId,
      orgId: TEST_ORG_B_ID,
      chainId: sharedChain,
    });

    const { error } = await rpc(actorB.client).rpc("fn_cancel_appointment", {
      p_task: orgB.taskId,
    });
    expect(error).toBeNull();
    expect(await readTask(orgA.taskId)).toMatchObject({
      status: "completed",
      outcome: "rescheduled",
    });
    expect(await readTask(orgASuccessor)).toMatchObject({ status: "open" });
  });

  it("leaves permanently DNC-locked completed history untouched", async () => {
    const actor = await createUserForOrg();
    const { data: contact } = await serviceClient
      .from("contacts")
      .insert({
        org_id: BMH_ORG_ID,
        contact_type: "person",
        first_name: "Immutable",
        phone_1: `+1816${String(Date.now()).slice(-7)}`,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    const original = await insertOpenAppointment({
      assigneeId: actor.userId,
      contactId: contact!.id,
    });
    const successor = await reschedule(actor.client, original.taskId);
    await finalizeChain(original.chainId);
    expect(
      (
        await rpc(actor.client).rpc("fn_cancel_appointment", {
          p_task: successor,
        })
      ).error,
    ).toBeNull();
    const auditBeforeRatchet = await readTask(original.taskId);

    expect(
      (
        await serviceClient
          .from("contacts")
          .update({ do_not_contact: true })
          .eq("id", contact!.id)
      ).error,
    ).toBeNull();
    expect(await readTask(original.taskId)).toEqual(auditBeforeRatchet);
    expect(auditBeforeRatchet).toMatchObject({
      status: "completed",
      outcome: "rescheduled",
    });
  });

  it("retains the not-open guard on a repeated cancel", async () => {
    const actor = await createUserForOrg();
    const task = await insertOpenAppointment({ assigneeId: actor.userId });
    expect(
      (
        await rpc(actor.client).rpc("fn_cancel_appointment", {
          p_task: task.taskId,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await rpc(actor.client).rpc("fn_cancel_appointment", {
          p_task: task.taskId,
        })
      ).error?.message,
    ).toMatch(/not open/i);
  });
});
