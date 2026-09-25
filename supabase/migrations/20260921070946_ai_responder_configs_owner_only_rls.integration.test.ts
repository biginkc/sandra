import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Fable re-review of e5d001bb (fable-final-review-e5d001bb.json,
 * jev-root-round17-fable2-fixes.md), finding 1 — P1 cutover
 * authorization lifecycle bypass: the round-15 UPDATE-only trigger left
 * INSERT/DELETE open at "any membership row"
 * (054_memberships_and_rls_rewrite.sql). An ordinary active member could
 * PATCH active=false (a non-classifier column) or DELETE the active row,
 * then INSERT a brand-new active row with classifier_provider='jev'/
 * classifier_mode='automatic' — cutting the org over without ever
 * touching the guarded UPDATE path. This proves, against real Postgres,
 * every lifecycle path the new owner-only RLS policies
 * (20260921070946_ai_responder_configs_owner_only_rls.sql) close: an
 * ordinary member cannot deactivate the active row, delete it, insert a
 * replacement, or reassign org_id — while an active owner's legitimate
 * settings writes and cutover writes still work.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

async function setActor(client: Client, userId: string) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
}

let orgId: string;
let otherOrgId: string;
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
  otherOrgId = randomUUID();
  configId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Owner-only RLS fixture ${orgId}`]);
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [otherOrgId, `Owner-only RLS other org ${otherOrgId}`]);
  // hugo_membership_owner_guard requires every org to always have a
  // "permanent owner" row.
  await makeMember(orgId, "owner");
  await makeMember(otherOrgId, "owner");
  await db.query(
    `insert into public.ai_responder_configs (id, org_id, active, system_prompt, classifier_provider, classifier_mode)
     values ($1, $2, true, 'Test system prompt', 'legacy', 'shadow')`,
    [configId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function makeMember(org: string, role: "owner" | "member"): Promise<string> {
  const userId = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `member-${userId}@test.local`]);
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, $3, 'active')`, [org, userId, role]);
  return userId;
}

describe("ai_responder_configs INSERT/UPDATE/DELETE are owner-only (fable re-review e5d001bb, finding 1)", () => {
  it("an active ORDINARY member cannot deactivate the active config (UPDATE active=false) — no mutation", async () => {
    const userId = await makeMember(orgId, "member");
    await setActor(db, userId);

    const result = await db.query("update public.ai_responder_configs set active = false where id = $1", [configId]);
    expect(result.rowCount).toBe(0);

    const row = (await db.query("select active from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row.active).toBe(true);
  });

  it("an active ORDINARY member cannot DELETE the active config row", async () => {
    const userId = await makeMember(orgId, "member");
    await setActor(db, userId);

    const result = await db.query("delete from public.ai_responder_configs where id = $1", [configId]);
    expect(result.rowCount).toBe(0);

    const row = (await db.query("select id from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row).toBeDefined();
  });

  it("an active ORDINARY member cannot INSERT a new active row for their own org (the deactivate-then-replace bypass)", async () => {
    const userId = await makeMember(orgId, "member");
    await setActor(db, userId);

    await db.query("savepoint rejected_insert");
    await expect(
      db.query(
        `insert into public.ai_responder_configs (id, org_id, active, system_prompt, classifier_provider, classifier_mode)
         values ($1, $2, true, 'Malicious prompt', 'jev', 'automatic')`,
        [randomUUID(), orgId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await db.query("rollback to savepoint rejected_insert");
  });

  it("an active ORDINARY member cannot reassign org_id to move a config to a different org", async () => {
    const userId = await makeMember(orgId, "member");
    await setActor(db, userId);

    const result = await db.query("update public.ai_responder_configs set org_id = $1 where id = $2", [otherOrgId, configId]);
    expect(result.rowCount).toBe(0);

    const row = (await db.query("select org_id from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row.org_id).toBe(orgId);
  });

  it("an active OWNER of the config's org can deactivate it, delete it, and insert a replacement — legitimate lifecycle still works", async () => {
    const userId = await makeMember(orgId, "owner");
    await setActor(db, userId);

    await db.query("update public.ai_responder_configs set active = false where id = $1", [configId]);
    let row = (await db.query("select active from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row.active).toBe(false);

    await db.query("delete from public.ai_responder_configs where id = $1", [configId]);
    const deleted = await db.query("select id from public.ai_responder_configs where id = $1", [configId]);
    expect(deleted.rows).toHaveLength(0);

    const newConfigId = randomUUID();
    await db.query(
      `insert into public.ai_responder_configs (id, org_id, active, system_prompt, classifier_provider, classifier_mode)
       values ($1, $2, true, 'Owner replacement prompt', 'jev', 'automatic')`,
      [newConfigId, orgId],
    );
    row = (await db.query("select active, classifier_provider, classifier_mode from public.ai_responder_configs where id = $1", [newConfigId])).rows[0];
    expect(row).toEqual({ active: true, classifier_provider: "jev", classifier_mode: "automatic" });
  });

  it("an active owner of a DIFFERENT org cannot insert a config into orgId (not their own org)", async () => {
    const userId = await makeMember(otherOrgId, "owner");
    await setActor(db, userId);

    await db.query("savepoint rejected_cross_org_insert");
    await expect(
      db.query(
        `insert into public.ai_responder_configs (id, org_id, active, system_prompt, classifier_provider, classifier_mode)
         values ($1, $2, true, 'Cross-org prompt', 'jev', 'automatic')`,
        [randomUUID(), orgId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await db.query("rollback to savepoint rejected_cross_org_insert");
  });

  it("SELECT visibility is unaffected — any active member (not just an owner) can still read the config", async () => {
    const userId = await makeMember(orgId, "member");
    await setActor(db, userId);

    const row = (await db.query("select id, classifier_provider from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row).toEqual({ id: configId, classifier_provider: "legacy" });
  });
});
