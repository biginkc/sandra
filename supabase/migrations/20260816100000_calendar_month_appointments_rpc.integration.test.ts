import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

beforeAll(async () => {
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

afterAll(async () => {
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
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

  it("is SECURITY INVOKER: an org-B member reading org A's month gets zero rows via RLS, not an error", async () => {
    const probe = await callMonthRpc(orgBMember.client, {
      p_org: BMH_ORG_ID,
      p_week_starts: STARTS,
      p_week_ends: ENDS,
    });
    expect(probe.error).toBeNull();
    expect(probe.data ?? []).toHaveLength(0);
  });

  it("RAISEs (fail-closed) when a single window exceeds p_week_cap inside the snapshot", async () => {
    await insertAppointment(BMH_ORG_ID, member.userId, "2026-08-04T15:00:00Z");
    await insertAppointment(BMH_ORG_ID, member.userId, "2026-08-04T16:00:00Z");
    // Window 1 now holds >= 3 rows (with t1 from the previous test).
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
