/**
 * saved-filters server actions — multi-user RLS integration test.
 *
 * Runs against the live test Supabase project (sandra-crm-test) via
 * vitest.integration.config.ts. CI-only flow: db-migrate.yml has already
 * applied 055_saved_filters.sql + 056_drop_recursive_memberships.sql so this
 * test can rely on the table existing and RLS being healthy.
 *
 * Why mock @/lib/supabase/server:
 *   The actions internally call createClient() to get a server-side supabase
 *   client. We swap that out for a per-user client (clientForUser(jwt)) so
 *   the JWT in the headers identifies as user A / B / C — and so
 *   requireOrgMembership's auth.getUser() returns the corresponding user.
 *   The pattern mirrors migration 054's integration test (lines 16-23).
 *
 * Tests cover (per SPEC R7 line 76 + R6):
 *   - createSavedFilter: success path, RLS denial for non-member, name +
 *     filters_json validation
 *   - updateSavedFilter: user A cannot update user B's row (RLS write_own)
 *   - deleteSavedFilter: user A cannot delete user B's row (RLS write_own)
 *   - togglePinSavedFilter: own preset works, base preset cannot be starred
 *
 * Cleanup: each test creates fresh users with unique emails; afterAll deletes
 * them via auth.admin.deleteUser. saved_filters rows attached to deleted users
 * are removed by ON DELETE CASCADE on the FK to auth.users.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
} from "@tests/integration/fixtures/multi-user";

// Hoisted mocks — Sandra's canonical pattern from migration 054 integration test.
const mocks = vi.hoisted(() => ({
  serverClient: undefined as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mocks.serverClient,
}));

// `revalidatePath` requires a Next.js request scope (the static generation
// store) which isn't present when invoking server actions directly from
// vitest. Stub it out — the call site is exercised but the side effect
// (cache invalidation) is irrelevant to RLS verification. Same pattern used
// by src/app/(dashboard)/leads/actions.test.ts.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// eslint-disable-next-line import/first
import {
  createSavedFilter,
  deleteSavedFilter,
  togglePinSavedFilter,
  updateSavedFilter,
} from "./saved-filters";

const serviceClient = createTestClient();
const createdUserIds: string[] = [];
const createdPresetIds: string[] = [];

let userA: Awaited<ReturnType<typeof createOrgUser>>;
let userB: Awaited<ReturnType<typeof createOrgUser>>;
let userC: Awaited<ReturnType<typeof createOrgUser>>;

function uniqueEmail(label: string): string {
  return `act0505-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}@bmhgroupkc.com`;
}

beforeAll(async () => {
  // seedTwoOrgs is idempotent — migration 055's integration test seeds the
  // same two orgs; running it again is a no-op (upsert by id).
  await serviceClient.from("organizations").upsert([
    { id: BMH_ORG_ID, name: "BMH Group" },
    { id: TEST_ORG_B_ID, name: "Test Org B" },
  ]);

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
  if (createdPresetIds.length > 0) {
    await serviceClient
      .from("saved_filters")
      .delete()
      .in("id", createdPresetIds);
  }
  // Defensive cleanup — any preset created with a user_id we tracked.
  await serviceClient
    .from("saved_filters")
    .delete()
    .in("user_id", createdUserIds);
  for (const uid of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(uid);
  }
});

describe("createSavedFilter (RLS write_own + with-check)", () => {
  it("allows a BMH member to create a preset for themselves", async () => {
    mocks.serverClient = clientForUser(userA.jwt);
    const result = await createSavedFilter({
      orgId: BMH_ORG_ID,
      name: `A-create-${Date.now()}`,
      filtersJson: { v: 1, blocks: [] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toMatch(/^[0-9a-f-]{36}$/);
      createdPresetIds.push(result.data.id);
    }
  });

  it("rejects a non-member of the org (requireOrgMembership throws)", async () => {
    mocks.serverClient = clientForUser(userC.jwt);
    const result = await createSavedFilter({
      orgId: BMH_ORG_ID,
      name: `C-create-${Date.now()}`,
      filtersJson: { v: 1, blocks: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // requireOrgMembership throws AuthorizationError; errFromUnknown maps
      // it to code "AUTHORIZATION" (errorNameToCode strips trailing "Error").
      // Either AUTHORIZATION or CREATE_FILTER_FAILED is acceptable; the
      // important thing is the action does NOT succeed.
      expect(result.error.code).toMatch(
        /AUTHORIZATION|CREATE_FILTER_FAILED/,
      );
    }
  });

  it("rejects empty / whitespace-only name", async () => {
    mocks.serverClient = clientForUser(userA.jwt);
    const result = await createSavedFilter({
      orgId: BMH_ORG_ID,
      name: "   ",
      filtersJson: { v: 1, blocks: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CREATE_FILTER_FAILED");
  });

  it("rejects bad filters_json shape (wrong version field)", async () => {
    mocks.serverClient = clientForUser(userA.jwt);
    const result = await createSavedFilter({
      orgId: BMH_ORG_ID,
      name: `bad-shape-${Date.now()}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filtersJson: { v: 99, blocks: [] } as any,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CREATE_FILTER_FAILED");
  });
});

describe("updateSavedFilter (RLS write_own enforced)", () => {
  it("user A cannot update user B's preset (silent RLS denial → action error)", async () => {
    // userB creates the row
    mocks.serverClient = clientForUser(userB.jwt);
    const created = await createSavedFilter({
      orgId: BMH_ORG_ID,
      name: `B-update-target-${Date.now()}`,
      filtersJson: { v: 1, blocks: [] },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    createdPresetIds.push(id);

    // userA tries to update — RLS USING clause filters the row out, update
    // affects 0 rows, action returns UPDATE_FILTER_FAILED.
    mocks.serverClient = clientForUser(userA.jwt);
    const result = await updateSavedFilter({
      orgId: BMH_ORG_ID,
      id,
      name: "hijacked-by-A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UPDATE_FILTER_FAILED");
      expect(result.error.message).toMatch(/not found|RLS/i);
    }

    // Confirm B's row is intact.
    const bClient = clientForUser(userB.jwt);
    const { data: stillThere } = await bClient
      .from("saved_filters")
      .select("name")
      .eq("id", id)
      .single();
    expect(stillThere?.name).not.toBe("hijacked-by-A");
  });

  it("user A can update their own preset", async () => {
    mocks.serverClient = clientForUser(userA.jwt);
    const created = await createSavedFilter({
      orgId: BMH_ORG_ID,
      name: `A-own-update-${Date.now()}`,
      filtersJson: { v: 1, blocks: [] },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    createdPresetIds.push(id);

    const newName = `A-renamed-${Date.now()}`;
    const updated = await updateSavedFilter({
      orgId: BMH_ORG_ID,
      id,
      name: newName,
    });
    expect(updated.ok).toBe(true);
  });
});

describe("deleteSavedFilter (RLS write_own delete enforced)", () => {
  it("user A cannot delete user B's preset", async () => {
    mocks.serverClient = clientForUser(userB.jwt);
    const created = await createSavedFilter({
      orgId: BMH_ORG_ID,
      name: `B-delete-target-${Date.now()}`,
      filtersJson: { v: 1, blocks: [] },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    createdPresetIds.push(id);

    mocks.serverClient = clientForUser(userA.jwt);
    const result = await deleteSavedFilter({ orgId: BMH_ORG_ID, id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DELETE_FILTER_FAILED");

    // B's row still exists.
    const bClient = clientForUser(userB.jwt);
    const { data } = await bClient
      .from("saved_filters")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    expect(data?.id).toBe(id);
  });
});

describe("togglePinSavedFilter (RLS + base-preset constraint)", () => {
  it("user can star and unstar their own preset", async () => {
    mocks.serverClient = clientForUser(userA.jwt);
    const created = await createSavedFilter({
      orgId: BMH_ORG_ID,
      name: `A-star-${Date.now()}`,
      filtersJson: { v: 1, blocks: [] },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    createdPresetIds.push(id);

    const star = await togglePinSavedFilter({
      orgId: BMH_ORG_ID,
      id,
      starred: true,
    });
    expect(star.ok).toBe(true);
    if (star.ok) expect(star.data.starred).toBe(true);

    const unstar = await togglePinSavedFilter({
      orgId: BMH_ORG_ID,
      id,
      starred: false,
    });
    expect(unstar.ok).toBe(true);
    if (unstar.ok) expect(unstar.data.starred).toBe(false);
  });

  it("user cannot star a base preset (base.user_id IS NULL → write_own denies)", async () => {
    // Find a base preset seeded by migration 055.
    const aClient = clientForUser(userA.jwt);
    const { data: bases } = await aClient
      .from("saved_filters")
      .select("id")
      .eq("is_base", true)
      .eq("org_id", BMH_ORG_ID)
      .limit(1);
    expect(bases?.length).toBe(1);
    if (!bases || bases.length === 0) return;
    const baseId = bases[0].id;

    mocks.serverClient = clientForUser(userA.jwt);
    const result = await togglePinSavedFilter({
      orgId: BMH_ORG_ID,
      id: baseId,
      starred: true,
    });
    // RLS write_own filters base presets out of the UPDATE — affects 0 rows.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOGGLE_PIN_FAILED");
  });

  it("user A cannot star user B's preset", async () => {
    mocks.serverClient = clientForUser(userB.jwt);
    const created = await createSavedFilter({
      orgId: BMH_ORG_ID,
      name: `B-star-target-${Date.now()}`,
      filtersJson: { v: 1, blocks: [] },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    createdPresetIds.push(id);

    mocks.serverClient = clientForUser(userA.jwt);
    const result = await togglePinSavedFilter({
      orgId: BMH_ORG_ID,
      id,
      starred: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOGGLE_PIN_FAILED");
  });
});
