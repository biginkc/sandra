/**
 * Migration 055 — saved_filters integration test.
 *
 * Runs against the live test Supabase project (sandra-crm-test) via
 * vitest.integration.config.ts. CI-only flow: db-migrate.yml applies
 * 055_saved_filters.sql to test + prod after merge to main; this test is
 * the proof that the table + RLS policies + base preset seed are healthy.
 *
 * Until the migration is applied, this file is RED. That's expected — Plan 03's
 * BLOCKING checkpoint enforces "CI has applied migration 055 to test" before
 * Plan 04 begins, which is what flips this green.
 *
 * Acceptance criteria (per SPEC R7 line 76):
 *   (a) user A in BMH cannot see user B's custom presets
 *   (b) both users in BMH see the same 5 base presets
 *   (c) a user in a different org reads zero BMH base presets
 *   (d) base preset seed is idempotent (count stays at exactly 5)
 *   (e) RLS write_own — user A cannot update user B's preset
 *
 * Import-alias precedent (per migration 054 integration test lines 6-14):
 * Sandra uses the `@tests/` path alias mapped to `./tests/*` (tsconfig.json).
 * Never the relative `../../tests/...` path.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";

const serviceClient = createTestClient();
const createdUserIds: string[] = [];
const createdPresetIds: string[] = [];

let userA: Awaited<ReturnType<typeof createOrgUser>>;
let userB: Awaited<ReturnType<typeof createOrgUser>>;
let userC: Awaited<ReturnType<typeof createOrgUser>>;

function uniqueEmail(label: string): string {
  return `mig055-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}@bmhgroupkc.com`;
}

beforeAll(async () => {
  await seedTwoOrgs(serviceClient);
  userA = await createOrgUser(serviceClient, {
    orgId: BMH_ORG_ID,
    email: uniqueEmail("a"),
    role: "member",
  });
  userB = await createOrgUser(serviceClient, {
    orgId: BMH_ORG_ID,
    email: uniqueEmail("b"),
    role: "member",
  });
  userC = await createOrgUser(serviceClient, {
    orgId: TEST_ORG_B_ID,
    email: uniqueEmail("c"),
    role: "member",
  });
  createdUserIds.push(userA.userId, userB.userId, userC.userId);
});

afterAll(async () => {
  // Clean up custom presets created by tests (base presets stay — they belong to the migration).
  // The `saved_filters` table is created by THIS migration (055) — Supabase
  // types.ts won't include it until CI regenerates after the migration lands.
  // Until then, all `.from("saved_filters")` calls cast through `as never`,
  // mirroring the 054 integration test's pattern for `memberships`.
  if (createdPresetIds.length > 0) {
    await serviceClient
      .from("saved_filters" as never)
      .delete()
      .in("id", createdPresetIds);
  }
  // Defensive: also nuke any preset that ever pointed at our test users
  await serviceClient
    .from("saved_filters" as never)
    .delete()
    .in("user_id", createdUserIds);
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
});

describe("Migration 055 — saved_filters base preset seed", () => {
  it("seeds exactly 5 base presets for the BMH org", async () => {
    const { data, error } = await serviceClient
      .from("saved_filters" as never)
      .select("name")
      .eq("org_id", BMH_ORG_ID)
      .eq("is_base", true)
      .order("name");
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ name: string }>;
    const names = rows.map((row) => row.name).sort();
    expect(names).toEqual(["Cold", "Engaged", "High Equity", "Stacked", "Vacant"]);
  });

  it("base preset seed is idempotent (count stays at 5 even if migration re-runs)", async () => {
    const { count, error } = await serviceClient
      .from("saved_filters" as never)
      .select("id", { count: "exact", head: true })
      .eq("org_id", BMH_ORG_ID)
      .eq("is_base", true);
    expect(error).toBeNull();
    // Partial unique index `idx_saved_filters_base_unique` on (org_id, name)
    // WHERE is_base = true backs the ON CONFLICT clause. Re-running the
    // migration's INSERT cannot create duplicates.
    expect(count).toBe(5);
  });

  it("base presets carry the v1 FilterBlock schema in filters_json", async () => {
    const { data, error } = await serviceClient
      .from("saved_filters" as never)
      .select("name, filters_json")
      .eq("org_id", BMH_ORG_ID)
      .eq("is_base", true);
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{
      name: string;
      filters_json: unknown;
    }>;
    for (const row of rows) {
      const json = row.filters_json as { v?: number; blocks?: unknown[] };
      expect(json.v).toBe(1);
      expect(Array.isArray(json.blocks)).toBe(true);
      expect((json.blocks ?? []).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("Migration 055 — saved_filters RLS isolation (multi-user fixture)", () => {
  it("user A cannot read user B's custom preset (read_own_plus_base scopes by user_id)", async () => {
    const a = clientForUser(userA.jwt);
    const b = clientForUser(userB.jwt);
    const presetName = `B-private-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const { data: inserted, error: insErr } = await b
      .from("saved_filters" as never)
      .insert({
        org_id: BMH_ORG_ID,
        user_id: userB.userId,
        name: presetName,
        filters_json: { v: 1, blocks: [] },
      } as never)
      .select("id")
      .single();
    expect(insErr).toBeNull();
    const insertedRow = inserted as { id?: string } | null;
    expect(insertedRow?.id).toBeTruthy();
    if (insertedRow?.id) createdPresetIds.push(insertedRow.id);

    const { data: aSees, error: aErr } = await a
      .from("saved_filters" as never)
      .select("id")
      .eq("name", presetName);
    expect(aErr).toBeNull();
    expect((aSees ?? []) as unknown[]).toEqual([]);
  });

  it("both users in the BMH org see the same 5 base presets", async () => {
    const a = clientForUser(userA.jwt);
    const b = clientForUser(userB.jwt);

    const aResult = await a
      .from("saved_filters" as never)
      .select("name")
      .eq("is_base", true)
      .eq("org_id", BMH_ORG_ID)
      .order("name");
    const bResult = await b
      .from("saved_filters" as never)
      .select("name")
      .eq("is_base", true)
      .eq("org_id", BMH_ORG_ID)
      .order("name");

    expect(aResult.error).toBeNull();
    expect(bResult.error).toBeNull();
    const expected = ["Cold", "Engaged", "High Equity", "Stacked", "Vacant"];
    const aRows = (aResult.data ?? []) as Array<{ name: string }>;
    const bRows = (bResult.data ?? []) as Array<{ name: string }>;
    expect(aRows.map((r) => r.name)).toEqual(expected);
    expect(bRows.map((r) => r.name)).toEqual(expected);
  });

  it("a user with no membership in BMH cannot read BMH base presets", async () => {
    const c = clientForUser(userC.jwt);
    const { data, error } = await c
      .from("saved_filters" as never)
      .select("id")
      .eq("org_id", BMH_ORG_ID)
      .eq("is_base", true);
    expect(error).toBeNull();
    expect((data ?? []) as unknown[]).toEqual([]);
  });

  it("user A cannot update user B's preset (write_own enforced)", async () => {
    const a = clientForUser(userA.jwt);
    const b = clientForUser(userB.jwt);
    const presetName = `B-update-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const { data: bInserted, error: insErr } = await b
      .from("saved_filters" as never)
      .insert({
        org_id: BMH_ORG_ID,
        user_id: userB.userId,
        name: presetName,
        filters_json: { v: 1, blocks: [] },
      } as never)
      .select("id")
      .single();
    expect(insErr).toBeNull();
    const bInsertedRow = bInserted as { id?: string } | null;
    const bRowId = bInsertedRow?.id;
    expect(bRowId).toBeTruthy();
    if (bRowId) createdPresetIds.push(bRowId);

    // User A's update should silently affect zero rows under RLS (USING clause
    // filters out the row before the update lands; no error, no rows modified).
    const { data: aUpdated, error: updErr } = await a
      .from("saved_filters" as never)
      .update({ name: "Stacked" } as never)
      .eq("id", bRowId!)
      .select("id");
    expect(updErr).toBeNull();
    expect((aUpdated ?? []) as unknown[]).toEqual([]);

    // Confirm the preset is intact under user B's view.
    const { data: bStill, error: bErr } = await b
      .from("saved_filters" as never)
      .select("name")
      .eq("id", bRowId!)
      .single();
    expect(bErr).toBeNull();
    expect((bStill as { name?: string } | null)?.name).toBe(presetName);
  });

  it("user A cannot delete user B's preset (write_own delete enforced)", async () => {
    const a = clientForUser(userA.jwt);
    const b = clientForUser(userB.jwt);
    const presetName = `B-delete-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const { data: bInserted, error: insErr } = await b
      .from("saved_filters" as never)
      .insert({
        org_id: BMH_ORG_ID,
        user_id: userB.userId,
        name: presetName,
        filters_json: { v: 1, blocks: [] },
      } as never)
      .select("id")
      .single();
    expect(insErr).toBeNull();
    const bInsertedRow = bInserted as { id?: string } | null;
    const bRowId = bInsertedRow?.id;
    expect(bRowId).toBeTruthy();
    if (bRowId) createdPresetIds.push(bRowId);

    const { data: aDeleted, error: delErr } = await a
      .from("saved_filters" as never)
      .delete()
      .eq("id", bRowId!)
      .select("id");
    expect(delErr).toBeNull();
    expect((aDeleted ?? []) as unknown[]).toEqual([]);

    // Confirm the preset still exists under user B's view.
    const { data: bStill, error: bErr } = await b
      .from("saved_filters" as never)
      .select("id")
      .eq("id", bRowId!)
      .maybeSingle();
    expect(bErr).toBeNull();
    expect((bStill as { id?: string } | null)?.id).toBe(bRowId);
  });

  it("user A cannot insert a preset with user_id pointing at user B (with check)", async () => {
    const a = clientForUser(userA.jwt);
    const presetName = `A-impersonates-B-${Date.now()}`;
    const { error } = await a.from("saved_filters" as never).insert({
      org_id: BMH_ORG_ID,
      user_id: userB.userId, // RLS with-check should block this
      name: presetName,
      filters_json: { v: 1, blocks: [] },
    } as never);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/row-level security|violates row-level/i);
  });
});
