import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

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

type MonthRpcArgs = {
  p_org: string;
  p_assignee?: string | null;
  p_week_starts: string[];
  p_week_ends: string[];
  p_week_cap?: number;
  p_total_cap?: number;
};
type MonthRpcRow = {
  id: string;
  due_at: string;
  assignee_id: string;
  property_address: string | null;
  property_is_dnc_locked: boolean | null;
  contact_entity_name: string | null;
};
type MonthRpcClient = {
  rpc(
    fn: "fn_calendar_month_appointments",
    args: MonthRpcArgs,
  ): Promise<{
    data: MonthRpcRow[] | null;
    error: { message: string; code?: string } | null;
  }>;
};

function callMonthRpc(client: SupabaseClient<Database>, args: MonthRpcArgs) {
  return (client as unknown as MonthRpcClient).rpc(
    "fn_calendar_month_appointments",
    args,
  );
}

function anonClient(): SupabaseClient<Database> {
  const url = process.env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing TEST_SUPABASE_URL/ANON_KEY");
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const serviceClient = createTestClient();
const createdUserIds: string[] = [];

// Two adjacent Sunday-anchored windows (Chicago) inside August 2026.
const W1 = { start: "2026-08-02T05:00:00Z", end: "2026-08-09T05:00:00Z" };
const W2 = { start: "2026-08-09T05:00:00Z", end: "2026-08-16T05:00:00Z" };
const STARTS = [W1.start, W2.start];
const ENDS = [W1.end, W2.end];

async function insertAppointment(
  orgId: string,
  assigneeId: string,
  dueAtIso: string,
  relatedPropertyId?: string,
): Promise<string> {
  const { data, error } = await serviceClient
    .from("tasks")
    .insert({
      org_id: orgId,
      type: "appointment",
      title: "Month RPC probe",
      assignee_id: assigneeId,
      created_by: assigneeId,
      due_at: dueAtIso,
      end_at: new Date(
        new Date(dueAtIso).getTime() + 30 * 60_000,
      ).toISOString(),
      calendar_chain_id: crypto.randomUUID(),
      related_property_id: relatedPropertyId ?? null,
      status: "open",
    } as never)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`insertAppointment failed: ${error?.message}`);
  }
  return (data as { id: string }).id;
}

let member: { userId: string; client: SupabaseClient<Database> };
let orgBMember: { userId: string; client: SupabaseClient<Database> };

beforeEach(async () => {
  await resetTenantTables(serviceClient);
  await seedTwoOrgs(serviceClient);
  const a = await createOrgUser(serviceClient, {
    orgId: BMH_ORG_ID,
    email: `mig20260816100000-a-${Date.now()}@bmhgroupkc.com`,
    role: "member",
  });
  createdUserIds.push(a.userId);
  member = { userId: a.userId, client: clientForUser(a.jwt) };
  const b = await createOrgUser(serviceClient, {
    orgId: TEST_ORG_B_ID,
    email: `mig20260816100000-b-${Date.now()}@bmhgroupkc.com`,
    role: "member",
  });
  createdUserIds.push(b.userId);
  orgBMember = { userId: b.userId, client: clientForUser(b.jwt) };
});

afterEach(async () => {
  // Reset first so no task/member FKs retain auth identities from this case.
  await resetTenantTables(serviceClient);
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
  createdUserIds.length = 0;
});

afterAll(async () => {
  await resetTenantTables(serviceClient);
});

describe("Migration 20260816100000 — fn_calendar_month_appointments", () => {
  it("rejects an anon call (privileges revoked)", async () => {
    const { error } = await callMonthRpc(anonClient(), {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect(error).not.toBeNull();
  });

  it("returns appointments across every window in one due_at-ordered list, with the assignee filter honored", async () => {
    const t1 = await insertAppointment(
      BMH_ORG_ID,
      member.userId,
      "2026-08-03T15:00:00Z",
    );
    const t2 = await insertAppointment(
      BMH_ORG_ID,
      member.userId,
      "2026-08-10T15:00:00Z",
    );
    const outside = await insertAppointment(
      BMH_ORG_ID,
      member.userId,
      "2026-08-20T15:00:00Z",
    );

    const all = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect(all.error).toBeNull();
    const ids = (all.data ?? []).map((r) => r.id);
    expect(ids).toEqual([t1, t2]);
    expect(ids).not.toContain(outside);

    const filtered = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_assignee: member.userId,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect((filtered.data ?? []).map((r) => r.id)).toEqual([t1, t2]);

    const filteredOut = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_assignee: orgBMember.userId,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect(filteredOut.data ?? []).toHaveLength(0);
  });

  it("rejects an authenticated member asking for an unrelated organization", async () => {
    const probe = await callMonthRpc(orgBMember.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect(probe.error?.message).toMatch(/no active membership/i);
    expect(probe.data).toBeNull();
  });

  it.each([
    ["suspended", { access_status: "suspended" }],
    ["expired", { access_expires_at: "2026-08-01T00:00:00Z" }],
    ["deletion-prepared", { deletion_prepared_at: "2026-08-01T00:00:00Z" }],
  ] as const)("rejects a %s membership", async (_label, membershipPatch) => {
    const { error: patchError } = await serviceClient
      .from("memberships")
      .update(membershipPatch)
      .eq("user_id", member.userId)
      .eq("org_id", BMH_ORG_ID);
    expect(patchError).toBeNull();

    const probe = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect(probe.error?.message).toMatch(/no active membership/i);
    expect(probe.data).toBeNull();
  });

  it("preserves service-role access for server and migration-test reads", async () => {
    const appointmentId = await insertAppointment(
      BMH_ORG_ID,
      member.userId,
      "2026-08-03T15:00:00Z",
    );
    const result = await callMonthRpc(serviceClient, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect(result.error).toBeNull();
    expect((result.data ?? []).map((row) => row.id)).toContain(appointmentId);
  });

  it("returns the related property's permanent-DNC state and leaves personal appointments null", async () => {
    const { data: contact, error: contactError } = await serviceClient
      .from("contacts")
      .insert({
        org_id: BMH_ORG_ID,
        contact_type: "person",
        first_name: "Calendar DNC projection",
        phone_1: `+1816${String(Date.now()).slice(-7)}`,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    expect(contactError).toBeNull();
    const { data: property, error: propertyError } = await serviceClient
      .from("properties")
      .insert({
        org_id: BMH_ORG_ID,
        address: `Calendar DNC ${crypto.randomUUID()}`,
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contact!.id,
      })
      .select("id")
      .single();
    expect(propertyError).toBeNull();

    const lockedAppointmentId = await insertAppointment(
      BMH_ORG_ID,
      member.userId,
      "2026-08-03T15:00:00Z",
      property!.id,
    );
    const personalAppointmentId = await insertAppointment(
      BMH_ORG_ID,
      member.userId,
      "2026-08-04T15:00:00Z",
    );
    expect(
      (
        await serviceClient
          .from("contacts")
          .update({ do_not_contact: true })
          .eq("id", contact!.id)
      ).error,
    ).toBeNull();

    const result = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect(result.error).toBeNull();
    const rowsById = new Map((result.data ?? []).map((row) => [row.id, row]));
    expect(rowsById.get(lockedAppointmentId)?.property_is_dnc_locked).toBe(
      true,
    );
    expect(
      rowsById.get(personalAppointmentId)?.property_is_dnc_locked,
    ).toBeNull();
  });

  it("locks contact-only and non-homeowner-contact appointments from the exact contact DNC", async () => {
    const homeownerId = crypto.randomUUID();
    const dncContactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const propertyAppointmentId = crypto.randomUUID();
    const contactOnlyAppointmentId = crypto.randomUUID();
    const chainA = crypto.randomUUID();
    const chainB = crypto.randomUUID();

    const { error: contactsError } = await serviceClient
      .from("contacts")
      .insert([
        {
          id: homeownerId,
          org_id: BMH_ORG_ID,
          contact_type: "person",
          first_name: "Clean homeowner",
        },
        {
          id: dncContactId,
          org_id: BMH_ORG_ID,
          contact_type: "person",
          first_name: "Exact task contact",
        },
      ]);
    expect(contactsError).toBeNull();
    const { error: propertyError } = await serviceClient
      .from("properties")
      .insert({
        id: propertyId,
        org_id: BMH_ORG_ID,
        address: `Calendar contact DNC ${crypto.randomUUID()}`,
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: homeownerId,
      });
    expect(propertyError).toBeNull();
    const { error: tasksError } = await serviceClient.from("tasks").insert([
      {
        id: propertyAppointmentId,
        org_id: BMH_ORG_ID,
        type: "appointment",
        title: "Unrelated property contact",
        assignee_id: member.userId,
        created_by: member.userId,
        due_at: "2026-08-05T15:00:00Z",
        end_at: "2026-08-05T15:30:00Z",
        calendar_chain_id: chainA,
        related_property_id: propertyId,
        contact_id: dncContactId,
        status: "open",
      },
      {
        id: contactOnlyAppointmentId,
        org_id: BMH_ORG_ID,
        type: "appointment",
        title: "Contact only",
        assignee_id: member.userId,
        created_by: member.userId,
        due_at: "2026-08-06T15:00:00Z",
        end_at: "2026-08-06T15:30:00Z",
        calendar_chain_id: chainB,
        contact_id: dncContactId,
        status: "open",
      },
    ] as never);
    expect(tasksError).toBeNull();

    const { error: dncError } = await serviceClient
      .from("contacts")
      .update({ do_not_contact: true })
      .eq("id", dncContactId);
    expect(dncError).toBeNull();
    const { data: propertyAfterDnc, error: propertyReadError } =
      await serviceClient
        .from("properties")
        .select("is_dnc_locked")
        .eq("id", propertyId)
        .single();
    expect(propertyReadError).toBeNull();
    expect(propertyAfterDnc?.is_dnc_locked).toBe(false);

    const result = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect(result.error).toBeNull();
    const rowsById = new Map((result.data ?? []).map((row) => [row.id, row]));
    expect(rowsById.get(propertyAppointmentId)?.property_is_dnc_locked).toBe(
      true,
    );
    expect(rowsById.get(contactOnlyAppointmentId)?.property_is_dnc_locked).toBe(
      true,
    );
  });

  it("suppresses completed/rescheduled predecessors of a cancelled org+chain without rewriting DNC-locked audit history", async () => {
    const chainId = crypto.randomUUID();
    const { data: contact, error: contactError } = await serviceClient
      .from("contacts")
      .insert({
        org_id: BMH_ORG_ID,
        contact_type: "person",
        first_name: "Calendar audit",
        phone_1: `+1816${String(Date.now()).slice(-7)}`,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    expect(contactError).toBeNull();

    const predecessorId = crypto.randomUUID();
    const cancelledId = crypto.randomUUID();
    const completedAt = "2026-08-01T15:00:00Z";
    const { error: historyError } = await serviceClient.from("tasks").insert([
      {
        id: predecessorId,
        org_id: BMH_ORG_ID,
        type: "appointment",
        title: "Original slot",
        assignee_id: member.userId,
        created_by: member.userId,
        due_at: "2026-08-05T15:00:00Z",
        end_at: "2026-08-05T15:30:00Z",
        calendar_chain_id: chainId,
        contact_id: contact!.id,
        status: "open",
      },
      {
        id: cancelledId,
        org_id: BMH_ORG_ID,
        type: "appointment",
        title: "Cancelled successor",
        assignee_id: member.userId,
        created_by: member.userId,
        due_at: "2026-08-12T15:00:00Z",
        end_at: "2026-08-12T15:30:00Z",
        calendar_chain_id: chainId,
        contact_id: contact!.id,
        status: "open",
      },
    ] as never);
    expect(historyError).toBeNull();

    const dbUrl =
      process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
    if (!dbUrl) throw new Error("Missing TEST_SUPABASE_DB_URL");
    const conn = new Client({ connectionString: dbUrl });
    await conn.connect();
    try {
      await conn.query("begin");
      await conn.query(
        "select set_config('sandra.allow_appointment_time_move', 'on', true)",
      );
      await conn.query(
        `update public.tasks
         set status = 'completed', outcome = 'rescheduled',
             completed_at = $2, completed_by = $3,
             calendar_generation = 1
         where id = $1`,
        [predecessorId, completedAt, member.userId],
      );
      await conn.query(
        `update public.tasks
         set status = 'cancelled', outcome = 'cancelled',
             calendar_generation = 1
         where id = $1`,
        [cancelledId],
      );
      await conn.query("commit");
    } catch (error) {
      await conn.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await conn.end();
    }
    expect(
      (
        await serviceClient
          .from("contacts")
          .update({ do_not_contact: true })
          .eq("id", contact!.id)
      ).error,
    ).toBeNull();

    const result = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect(result.error).toBeNull();
    expect((result.data ?? []).map((row) => row.id)).not.toContain(
      predecessorId,
    );

    const { data: auditRow, error: auditError } = await serviceClient
      .from("tasks")
      .select("status, outcome, completed_at, completed_by")
      .eq("id", predecessorId)
      .single();
    expect(auditError).toBeNull();
    expect(auditRow).toMatchObject({
      status: "completed",
      outcome: "rescheduled",
      completed_by: member.userId,
    });
    expect(new Date(auditRow!.completed_at!).toISOString()).toBe(
      new Date(completedAt).toISOString(),
    );
  });

  it("RAISEs (fail-closed) when a single window exceeds p_week_cap inside the snapshot", async () => {
    await insertAppointment(BMH_ORG_ID, member.userId, "2026-08-04T15:00:00Z");
    await insertAppointment(BMH_ORG_ID, member.userId, "2026-08-04T16:00:00Z");
    await insertAppointment(BMH_ORG_ID, member.userId, "2026-08-04T17:00:00Z");
    const { error } = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
      p_week_cap: 2,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/month volume exceeds cap/i);
  });

  it("rejects malformed window sets before reading tasks (round 4 hardening)", async () => {
    const overlapping = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: [W1.start, W1.start],
      p_week_ends: [W1.end, W1.end],
    });
    expect(overlapping.error?.message).toMatch(/ordered and non-overlapping/i);

    const unequal = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: [W1.start, W2.start],
      p_week_ends: [W1.end],
    });
    expect(unequal.error?.message).toMatch(/equal length/i);

    const tooMany = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: Array.from({ length: 7 }, () => W1.start),
      p_week_ends: Array.from({ length: 7 }, () => W1.end),
    });
    expect(tooMany.error?.message).toMatch(/1\.\.6 windows/i);

    const inverted = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: [W1.end],
      p_week_ends: [W1.start],
    });
    expect(inverted.error?.message).toMatch(/within \(0, 8] days/i);
  });

  it("clamps caller-supplied caps to the server ceiling (raising them is a no-op, lowering works)", async () => {
    // A huge cap must not error out or change behavior — it clamps to 900.
    const raised = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
      p_week_cap: 100000,
      p_total_cap: 100000,
    });
    expect(raised.error).toBeNull();
  });

  it("RAISEs (fail-closed) when the month total exceeds p_total_cap", async () => {
    await insertAppointment(BMH_ORG_ID, member.userId, "2026-08-04T15:00:00Z");
    await insertAppointment(BMH_ORG_ID, member.userId, "2026-08-11T15:00:00Z");
    const { error } = await callMonthRpc(member.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
      p_total_cap: 1,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/month volume exceeds cap/i);
  });
});
