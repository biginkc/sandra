import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Fable review of 9cd4ec2b (fable-final-review-9cd4ec2b.json,
 * jev-root-round15-fable-fixes.md), finding 2 — P1 cutover policy
 * bypass: fn_update_jev_automatic_classification (round 14) enforces
 * owner-only authorization, but 054_memberships_and_rls_rewrite.sql's
 * ai_responder_configs_org_update RLS policy still permits ANY
 * membership row to UPDATE the table directly (any active member could
 * PATCH classifier_provider/classifier_mode via PostgREST, bypassing the
 * RPC entirely). This proves, against real Postgres, DIRECT table
 * updates specifically: an active ordinary member cannot change
 * classifier_provider/classifier_mode via a plain UPDATE, and an active
 * owner can. Also proves an unrelated column (system_prompt) stays
 * writable by an ordinary active member — app functionality (the
 * separate updateAiResponderConfig action) is preserved.
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
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Classifier cutover guard fixture ${orgId}`]);
  // hugo_membership_owner_guard requires every org to always have a
  // "permanent owner" row — inserting the actual test subject below with
  // role='member' would itself be rejected with FINAL_OWNER_GUARD before
  // the guard under test is even reached.
  await makeMember("owner");
  await db.query(
    `insert into public.ai_responder_configs (id, org_id, active, system_prompt, classifier_provider, classifier_mode)
     values ($1, $2, true, 'Test system prompt', 'legacy', 'shadow')`,
    [configId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function makeMember(role: "owner" | "member"): Promise<string> {
  const userId = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `member-${userId}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, $3, 'active')`,
    [orgId, userId, role],
  );
  return userId;
}

describe("ai_responder_configs classifier cutover columns are guarded against direct table writes (fable review 9cd4ec2b, finding 2)", () => {
  it("an active ORDINARY member cannot directly UPDATE classifier_provider/classifier_mode — no mutation", async () => {
    const userId = await makeMember("member");
    await setActor(db, userId);

    // Fable re-review of e5d001bb (jev-root-round17-fable2-fixes.md),
    // finding 1: superseded by the coherent owner-only RLS model
    // (20260921070946_ai_responder_configs_owner_only_rls.sql) — the
    // row is now excluded from the UPDATE's target set by RLS's USING
    // clause BEFORE this trigger ever runs, so a non-owner gets a
    // silent 0-row result, not the trigger's FORBIDDEN exception
    // (which still guards a same-org OWNER's classifier writes as
    // defense in depth, but RLS is now the primary boundary).
    const result = await db.query("update public.ai_responder_configs set classifier_provider = 'jev', classifier_mode = 'automatic' where id = $1", [configId]);
    expect(result.rowCount).toBe(0);

    const row = (await db.query("select classifier_provider, classifier_mode from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row).toEqual({ classifier_provider: "legacy", classifier_mode: "shadow" });
  });

  it("an active OWNER can directly UPDATE classifier_provider/classifier_mode", async () => {
    const userId = await makeMember("owner");
    await setActor(db, userId);

    await db.query("update public.ai_responder_configs set classifier_provider = 'jev', classifier_mode = 'automatic' where id = $1", [configId]);

    const row = (await db.query("select classifier_provider, classifier_mode from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row).toEqual({ classifier_provider: "jev", classifier_mode: "automatic" });
  });

  // Fable re-review of e5d001bb (jev-root-round17-fable2-fixes.md),
  // finding 1: superseded by the coherent owner-only RLS model in
  // 20260921070946_ai_responder_configs_owner_only_rls.sql — an ordinary
  // member can no longer write ANY column directly (not just the
  // classifier ones), closing the active=false-then-replace bypass. See
  // 20260921070946_ai_responder_configs_owner_only_rls.integration.test.ts
  // for full coverage of that policy.
  it("an active ordinary member CANNOT update an unrelated column (system_prompt) either, now that direct writes are owner-only", async () => {
    const userId = await makeMember("member");
    await setActor(db, userId);

    await db.query("savepoint rejected_unrelated_column");
    const result = await db.query("update public.ai_responder_configs set system_prompt = 'A brand new prompt' where id = $1", [configId]);
    // RLS silently affects zero rows rather than raising — the row exists
    // but isn't visible/writable to this caller under the owner-only
    // USING clause.
    expect(result.rowCount).toBe(0);
    await db.query("rollback to savepoint rejected_unrelated_column");

    const row = (await db.query("select system_prompt from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row.system_prompt).toBe("Test system prompt");
  });

  it("changing classifier_provider/classifier_mode to the SAME value they already hold is a no-op, not rejected (no actual change)", async () => {
    const userId = await makeMember("member");
    await setActor(db, userId);

    // legacy/shadow are already the row's values — this UPDATE changes
    // nothing, so the guard (which only fires when the value ACTUALLY
    // changes) must not reject it.
    await db.query("update public.ai_responder_configs set classifier_provider = 'legacy', classifier_mode = 'shadow' where id = $1", [configId]);

    const row = (await db.query("select classifier_provider, classifier_mode from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row).toEqual({ classifier_provider: "legacy", classifier_mode: "shadow" });
  });
});
