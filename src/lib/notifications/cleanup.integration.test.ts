import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { runNotificationCleanup } from "./cleanup";

const supabase = createTestClient();

let _orgId: string | null = null;
async function getOrgId(): Promise<string> {
  if (_orgId) return _orgId;
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error("no organization seeded in test project");
  _orgId = data.id;
  return _orgId;
}

const createdAuthUsers: string[] = [];
async function createAuthUser(email: string): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: `test-pw-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createAuthUser failed: ${error?.message}`);
  }
  createdAuthUsers.push(data.user.id);
  return data.user.id;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("runNotificationCleanup (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  afterEach(async () => {
    for (const id of createdAuthUsers) {
      await supabase.auth.admin.deleteUser(id);
    }
    createdAuthUsers.length = 0;
  });

  it("deletes rows older than 90 days and leaves newer rows untouched", async () => {
    const orgId = await getOrgId();
    const userId = await createAuthUser(
      `cleanup-${Date.now()}@test.invalid`,
    );

    // Three rows at 91d (deletable), 89d (borderline keep), 1d (keep).
    // We seed with explicit created_at so we don't need to wait 90 days.
    const { error: seedErr } = await supabase.from("notifications").insert([
      {
        org_id: orgId,
        user_id: userId,
        event_type: "owner_message_added",
        entity_type: "property",
        entity_id: "00000000-0000-0000-0000-000000009001",
        title: "old",
        created_at: daysAgo(91),
      },
      {
        org_id: orgId,
        user_id: userId,
        event_type: "owner_message_added",
        entity_type: "property",
        entity_id: "00000000-0000-0000-0000-000000009002",
        title: "borderline",
        created_at: daysAgo(89),
      },
      {
        org_id: orgId,
        user_id: userId,
        event_type: "owner_message_added",
        entity_type: "property",
        entity_id: "00000000-0000-0000-0000-000000009003",
        title: "fresh",
        created_at: daysAgo(1),
      },
    ]);
    expect(seedErr).toBeNull();

    const r = await runNotificationCleanup(supabase);
    expect(r.deleted).toBe(1);

    const { data } = await supabase
      .from("notifications")
      .select("title")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    expect(data!.map((n) => n.title)).toEqual(["fresh", "borderline"]);
  });
});
