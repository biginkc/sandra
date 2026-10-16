import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Jev-only mode: ai_responder_configs.reply_generation defaults to 'llm' and
 * only an active org OWNER can change it, through fn_set_ai_reply_generation.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

let orgId: string;
let otherOrgId: string;
let configId: string;

async function setActor(userId: string) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
}
async function makeMember(org: string, role: "owner" | "member"): Promise<string> {
  const userId = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `m-${userId}@test.local`]);
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, $3, 'active')`, [org, userId, role]);
  return userId;
}
async function rpc(mode: string | null, id: string = configId) {
  return db.query("select public.fn_set_ai_reply_generation($1, $2) as r", [id, mode]);
}
async function expectCode(mode: string | null, code: string, id: string = configId) {
  await db.query("savepoint s");
  await expect(rpc(mode, id)).rejects.toMatchObject({ code });
  await db.query("rollback to savepoint s");
}

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
  await db.query("insert into public.organizations (id, name) values ($1, $2), ($3, $4)", [orgId, `RG ${orgId}`, otherOrgId, `RG ${otherOrgId}`]);
  await makeMember(orgId, "owner");
  await makeMember(otherOrgId, "owner");
  await db.query(
    `insert into public.ai_responder_configs (id, org_id, active, system_prompt) values ($1, $2, true, 'p')`,
    [configId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

describe("ai_responder_configs.reply_generation", () => {
  it("defaults to 'llm' (today's behaviour)", async () => {
    const row = (await db.query("select reply_generation from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row.reply_generation).toBe("llm");
  });

  it("rejects values outside llm|off at the table", async () => {
    await db.query("savepoint s");
    await expect(
      db.query("update public.ai_responder_configs set reply_generation = 'maybe' where id = $1", [configId]),
    ).rejects.toMatchObject({ code: "23514" });
    await db.query("rollback to savepoint s");
  });

  it("an active owner can switch to off and back, and the change is stamped", async () => {
    const owner = await makeMember(orgId, "owner");
    await setActor(owner);
    expect((await rpc("off")).rows[0].r).toMatchObject({ id: configId, replyGeneration: "off" });
    await db.query("reset role");
    let row = (await db.query("select reply_generation, reply_generation_changed_by, reply_generation_changed_at from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row.reply_generation).toBe("off");
    expect(row.reply_generation_changed_by).toBe(owner);
    expect(row.reply_generation_changed_at).not.toBeNull();
    await setActor(owner);
    await rpc("llm");
    await db.query("reset role");
    row = (await db.query("select reply_generation from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row.reply_generation).toBe("llm");
  });

  it("an ordinary member is refused and nothing changes", async () => {
    await setActor(await makeMember(orgId, "member"));
    await expectCode("off", "42501");
    await db.query("reset role");
    const row = (await db.query("select reply_generation from public.ai_responder_configs where id = $1", [configId])).rows[0];
    expect(row.reply_generation).toBe("llm");
  });

  it("an owner of a different org is refused", async () => {
    await setActor(await makeMember(otherOrgId, "owner"));
    await expectCode("off", "42501");
  });

  it("unknown config ids give the same FORBIDDEN", async () => {
    await setActor(await makeMember(orgId, "owner"));
    await expectCode("off", "42501", randomUUID());
  });

  it("invalid modes are refused", async () => {
    await setActor(await makeMember(orgId, "owner"));
    await expectCode("maybe", "22023");
    await expectCode(null, "22023");
  });

  it("an unauthenticated caller is refused", async () => {
    await db.query("set local role authenticated");
    await expectCode("off", "42501");
  });
});
