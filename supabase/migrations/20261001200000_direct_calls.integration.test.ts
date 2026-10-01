import fs from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

const ORG = "00000000-0000-0000-0000-0000000d1c01";
const USER_A = "00000000-0000-0000-0000-0000000d1a01";
const USER_B = "00000000-0000-0000-0000-0000000d1a02";
// The files wrap themselves in begin/commit; strip that so the test's own
// transaction can roll everything back.
const stripTx = (sql: string) => sql.replace(/^\s*(begin|commit);\s*$/gim, "");

it("applies twice, enforces one active call per operator, scopes reads, and rolls back", async () => {
  const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const migration = stripTx(fs.readFileSync("supabase/migrations/20261001200000_direct_calls.sql", "utf8"));
  const rollback = stripTx(fs.readFileSync("supabase/rollbacks/20261001200000_direct_calls.sql", "utf8"));
  await pg.query("begin");
  try {
    await pg.query(migration);
    await pg.query(migration);
    await pg.query("insert into public.organizations(id,name) values ($1,'Direct calls test') on conflict do nothing", [ORG]);
    for (const id of [USER_A, USER_B]) {
      await pg.query("insert into auth.users (id) values ($1) on conflict do nothing", [id]);
      await pg.query("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')", [id, ORG]);
    }
    const insertCall = (user: string, status: string, requestId: string) => pg.query(
      `insert into public.direct_calls (org_id, operator_user_id, destination_e164, caller_id_e164, status, client_request_id)
       values ($1, $2, '+15550000001', '+15550000002', $3, $4) returning id`,
      [ORG, user, status, requestId],
    );
    const first = await insertCall(USER_A, "browser_connecting", "00000000-0000-0000-0000-00000000aa01");

    await pg.query("savepoint dup_active");
    await expect(insertCall(USER_A, "connected", "00000000-0000-0000-0000-00000000aa02")).rejects.toMatchObject({ code: "23505" });
    await pg.query("rollback to savepoint dup_active");

    await pg.query("savepoint dup_request");
    await expect(insertCall(USER_A, "ended", "00000000-0000-0000-0000-00000000aa01")).rejects.toMatchObject({ code: "23505" });
    await pg.query("rollback to savepoint dup_request");

    await pg.query("savepoint bad_status");
    await expect(insertCall(USER_B, "bogus", "00000000-0000-0000-0000-00000000bb01")).rejects.toMatchObject({ code: "23514" });
    await pg.query("rollback to savepoint bad_status");

    // A terminal call frees the operator for a new one.
    await pg.query("update public.direct_calls set status='ended' where id=$1", [first.rows[0].id]);
    await insertCall(USER_A, "browser_connecting", "00000000-0000-0000-0000-00000000aa03");
    await insertCall(USER_B, "browser_connecting", "00000000-0000-0000-0000-00000000bb02");

    await pg.query(
      "insert into public.direct_call_events (provider_event_id, event_type, payload) values ('evt-1','call.answered','{}')",
    );
    await pg.query("savepoint dup_event");
    await expect(pg.query(
      "insert into public.direct_call_events (provider_event_id, event_type, payload) values ('evt-1','call.answered','{}')",
    )).rejects.toMatchObject({ code: "23505" });
    await pg.query("rollback to savepoint dup_event");

    // Authenticated: sees only own rows, cannot write.
    await pg.query("savepoint authed");
    try {
      await pg.query("set local role authenticated");
      await pg.query("select set_config('request.jwt.claim.sub', $1, true)", [USER_A]);
      const own = await pg.query("select operator_user_id from public.direct_calls");
      expect(own.rows.length).toBeGreaterThan(0);
      expect(own.rows.every((r) => r.operator_user_id === USER_A)).toBe(true);
      await expect(pg.query("update public.direct_calls set status='ended'")).rejects.toMatchObject({ code: "42501" });
    } finally { await pg.query("rollback to savepoint authed"); }

    await pg.query("savepoint anon");
    try {
      await pg.query("set local role anon");
      await expect(pg.query("select * from public.direct_calls")).rejects.toMatchObject({ code: "42501" });
    } finally { await pg.query("rollback to savepoint anon"); }

    await pg.query(rollback);
    const gone = await pg.query("select to_regclass('public.direct_calls') as t");
    expect(gone.rows[0].t).toBeNull();
  } finally {
    await pg.query("rollback");
    await pg.end();
  }
});
