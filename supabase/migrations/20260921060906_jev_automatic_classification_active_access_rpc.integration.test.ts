import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Root review of edbd7bfe (jev-root-round13-review.md), finding 1: the
 * ai_responder_configs UPDATE RLS policy (054_memberships_and_rls_rewrite.sql)
 * accepts any membership row and never checks access_status/
 * deletion_prepared_at/access_expires_at. fn_update_jev_automatic_classification
 * (20260921060906_jev_automatic_classification_active_access_rpc.sql)
 * resolves the config's org from the DB itself and requires CURRENT
 * active membership. This proves, against real Postgres: active-member
 * success (atomic provider+mode write), and FORBIDDEN — no mutation —
 * for an inactive member, an expired member, a member of a DIFFERENT org
 * than the config belongs to, and a config id that doesn't exist.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

async function setActor(client: Client, userId: string) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
}

let orgId: string;
let configId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  configId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Jev automatic switch fixture ${orgId}`]);
  // hugo_membership_owner_guard requires every org to always have a
  // "permanent owner" row (owner, active, no deletion-prepared, no
  // access_expires_at) — inserting the actual test subject below with a
  // non-owner role, or a non-permanent owner config (expired/inactive/
  // deletion-prepared), would otherwise itself be rejected with
  // FINAL_OWNER_GUARD before the RPC under test is even reached. This
  // permanent owner is separate from, and irrelevant to, each test's
  // actual authorization subject.
  await makeMember({ role: "owner", accessStatus: "active", org: orgId });
  await db.query(
    `insert into public.ai_responder_configs (id, org_id, active, system_prompt, classifier_provider, classifier_mode)
     values ($1, $2, true, 'Test system prompt', 'legacy', 'shadow')`,
    [configId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function makeMember(
  overrides: Partial<{ accessStatus: string; deletionPreparedAt: string | null; accessExpiresAt: string | null; role: string; org: string }> = {},
): Promise<string> {
  const userId = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `member-${userId}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status, deletion_prepared_at, access_expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      overrides.org ?? orgId,
      userId,
      overrides.role ?? "member",
      overrides.accessStatus ?? "active",
      overrides.deletionPreparedAt ?? null,
      overrides.accessExpiresAt ?? null,
    ],
  );
  return userId;
}

async function callUpdate(userId: string, args: { configId: string; enabled: boolean }) {
  await setActor(db, userId);
  const { rows } = await db.query(
    `select public.fn_update_jev_automatic_classification($1, $2) as result`,
    [args.configId, args.enabled],
  );
  return rows[0].result;
}

describe("fn_update_jev_automatic_classification — active-access authorization (root review edbd7bfe, finding 1)", () => {
  it("active member: enabling atomically sets provider='jev' and mode='automatic'", async () => {
    const userId = await makeMember();
    const result = await callUpdate(userId, { configId, enabled: true });
    expect(result).toEqual({ id: configId, classifierProvider: "jev", classifierMode: "automatic" });

    const row = (await db.query("select classifier_provider, classifier_mode from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row).toEqual({ classifier_provider: "jev", classifier_mode: "automatic" });
  });

  it("active member: disabling atomically sets provider='legacy' and mode='shadow'", async () => {
    await db.query("update public.ai_responder_configs set classifier_provider = 'jev', classifier_mode = 'automatic' where id = $1", [configId]);
    const userId = await makeMember();
    const result = await callUpdate(userId, { configId, enabled: false });
    expect(result).toEqual({ id: configId, classifierProvider: "legacy", classifierMode: "shadow" });
  });

  it("inactive membership (access_status != 'active'): rejected with FORBIDDEN, no mutation", async () => {
    const userId = await makeMember({ accessStatus: "suspended" });
    await db.query("savepoint rejected_inactive");
    await expect(callUpdate(userId, { configId, enabled: true })).rejects.toMatchObject({ message: expect.stringContaining("FORBIDDEN") });
    await db.query("rollback to savepoint rejected_inactive");

    const row = (await db.query("select classifier_provider, classifier_mode from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row).toEqual({ classifier_provider: "legacy", classifier_mode: "shadow" });
  });

  it("expired access (access_expires_at in the past): rejected with FORBIDDEN, no mutation", async () => {
    const userId = await makeMember({ accessExpiresAt: "2020-01-01T00:00:00.000Z" });
    await db.query("savepoint rejected_expired");
    await expect(callUpdate(userId, { configId, enabled: true })).rejects.toMatchObject({ message: expect.stringContaining("FORBIDDEN") });
    await db.query("rollback to savepoint rejected_expired");

    const row = (await db.query("select classifier_provider from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row.classifier_provider).toBe("legacy");
  });

  it("deletion-prepared membership: rejected with FORBIDDEN, no mutation", async () => {
    const userId = await makeMember({ deletionPreparedAt: new Date().toISOString() });
    await db.query("savepoint rejected_deletion_prepared");
    await expect(callUpdate(userId, { configId, enabled: true })).rejects.toMatchObject({ message: expect.stringContaining("FORBIDDEN") });
    await db.query("rollback to savepoint rejected_deletion_prepared");
  });

  it("cross-org: active member of a DIFFERENT org than the config belongs to is rejected with FORBIDDEN, no mutation", async () => {
    const otherOrgId = randomUUID();
    await db.query("insert into public.organizations (id, name) values ($1, $2)", [otherOrgId, `Other org ${otherOrgId}`]);
    await makeMember({ role: "owner", accessStatus: "active", org: otherOrgId });
    const userId = await makeMember({ org: otherOrgId });

    await db.query("savepoint rejected_cross_org");
    await expect(callUpdate(userId, { configId, enabled: true })).rejects.toMatchObject({ message: expect.stringContaining("FORBIDDEN") });
    await db.query("rollback to savepoint rejected_cross_org");

    const row = (await db.query("select classifier_provider from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row.classifier_provider).toBe("legacy");
  });

  it("stale/nonexistent config id: rejected with FORBIDDEN (a truthful failure, never a silent zero-row success)", async () => {
    const userId = await makeMember();
    await db.query("savepoint rejected_stale_config");
    await expect(callUpdate(userId, { configId: randomUUID(), enabled: true })).rejects.toMatchObject({ message: expect.stringContaining("FORBIDDEN") });
    await db.query("rollback to savepoint rejected_stale_config");
  });
});
