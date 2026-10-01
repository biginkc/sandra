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
    const begin = async (user: string, requestId: string) =>
      (await pg.query("select * from public.direct_call_begin($1, $2, null, null, '', '+15550000002', $3)", [ORG, user, requestId])).rows[0];
    const open = async (callId: string) =>
      (await pg.query("select kind, dial_role, leg_id from public.direct_call_cleanups where direct_call_id=$1 and confirmed_at is null order by kind, leg_id", [callId])).rows;

    // Second fence: the partial unique index on non-terminal calls.
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
    const id = first.rows[0].id;

    // Busy = a non-terminal call OR any unconfirmed cleanup row, from one predicate.
    expect((await pg.query("select public.direct_call_operator_busy($1) as b", [USER_A])).rows[0].b).toBe("call");
    expect((await begin(USER_A, "00000000-0000-0000-0000-00000000aa03")).outcome).toBe("busy_call");
    expect((await begin(USER_A, "00000000-0000-0000-0000-00000000aa01"))).toMatchObject({ outcome: "duplicate_request", call_id: id });
    await pg.query("update public.direct_calls set status='ended' where id=$1", [id]);
    expect((await pg.query("select public.direct_call_operator_busy($1) as b", [USER_A])).rows[0].b).toBeNull();

    // A terminal call holds the lock while a leg row or an unresolved Dial is unconfirmed (#743-1/#743-2).
    await pg.query("select public.direct_call_cleanup_add_leg($1, 'leg-1')", [id]);
    await pg.query("select public.direct_call_cleanup_add_leg($1, 'leg-1')", [id]);
    expect(await open(id)).toEqual([{ kind: "leg", dial_role: null, leg_id: "leg-1" }]);
    expect((await pg.query("select public.direct_call_operator_busy($1) as b", [USER_A])).rows[0].b).toBe("cleanup");
    expect((await begin(USER_A, "00000000-0000-0000-0000-00000000aa04")).outcome).toBe("busy_cleanup");
    await pg.query("savepoint leg_unique");
    await expect(pg.query("insert into public.direct_call_cleanups (org_id, operator_user_id, direct_call_id, kind, leg_id) values ($1,$2,$3,'leg','leg-1')", [ORG, USER_A, id])).rejects.toMatchObject({ code: "23505" });
    await pg.query("rollback to savepoint leg_unique");
    await pg.query("update public.direct_call_cleanups set confirmed_at = now() where leg_id='leg-1'");
    expect((await pg.query("select public.direct_call_operator_busy($1) as b", [USER_A])).rows[0].b).toBeNull();

    // begin: inserts the call AND the browser Dial's unresolved row atomically; a different operator is independent.
    const begun = await begin(USER_A, "00000000-0000-0000-0000-00000000aa05");
    expect(begun.outcome).toBe("created");
    const callId = begun.call_id;
    expect(await open(callId)).toEqual([{ kind: "unresolved_dial", dial_role: "browser", leg_id: null }]);
    expect((await begin(USER_B, "00000000-0000-0000-0000-00000000bb02")).outcome).toBe("created");
    const timing = (await pg.query("select extract(epoch from resolve_after - created_at)::int as ra, extract(epoch from backstop_at - created_at)::int as bk from public.direct_call_cleanups where direct_call_id=$1", [callId])).rows[0];
    expect(timing).toEqual({ ra: 45, bk: 7260 });

    // apply: CAS on status, resolves the Dial for a learned leg, writes the cleanup rows in the same statement.
    const applied = await pg.query(
      "select * from public.direct_call_apply($1, array['browser_connecting'], $2::jsonb, $3::jsonb)",
      [callId, JSON.stringify({ status: "seller_dialing", browser_leg_id: "b-1", seller_dial_state: "pending" }),
       JSON.stringify([{ kind: "unresolved_dial", role: "seller", timeout_secs: 30, time_limit_secs: 7195 }])],
    );
    expect(applied.rows[0]).toMatchObject({ status: "seller_dialing", browser_leg_id: "b-1", seller_dial_state: "pending" });
    expect(await open(callId)).toEqual([{ kind: "unresolved_dial", dial_role: "seller", leg_id: null }]); // browser resolved, seller open
    const stale = await pg.query("select * from public.direct_call_apply($1, array['browser_connecting'], '{\"status\":\"failed\"}'::jsonb, '[]'::jsonb)", [callId]);
    expect(stale.rows).toEqual([]); // status moved: no write, no rows
    // failure_reason may be explicitly nulled; hangup of the browser ends it and queues the other leg.
    const ended = await pg.query(
      "select * from public.direct_call_apply($1, array['seller_dialing'], $2::jsonb, $3::jsonb)",
      [callId, JSON.stringify({ status: "failed", failure_reason: null }), JSON.stringify([{ kind: "leg", leg_id: "b-1" }])],
    );
    expect(ended.rows[0]).toMatchObject({ status: "failed", failure_reason: null });
    expect(await open(callId)).toEqual([{ kind: "leg", dial_role: null, leg_id: "b-1" }, { kind: "unresolved_dial", dial_role: "seller", leg_id: null }]);
    // The seller Dial's leg arrives after the call ended: stored, Dial resolved, leg queued for hangup.
    expect((await pg.query("select public.direct_call_dial_succeeded($1, 's-1', 'seller') as stored", [callId])).rows[0].stored).toBe(true);
    expect(await open(callId)).toEqual([{ kind: "leg", dial_role: null, leg_id: "b-1" }, { kind: "leg", dial_role: null, leg_id: "s-1" }]);
    expect((await pg.query("select seller_leg_id, seller_dial_state from public.direct_calls where id=$1", [callId])).rows[0]).toEqual({ seller_leg_id: "s-1", seller_dial_state: "sent" });
    // A different leg for an already-stored role is queued, not stored.
    expect((await pg.query("select public.direct_call_dial_succeeded($1, 's-2', 'seller') as stored", [callId])).rows[0].stored).toBe(false);
    expect((await open(callId)).map((r) => r.leg_id)).toEqual(["b-1", "s-1", "s-2"]);

    // claim: due rows only, lease pushes next_attempt_at out; unresolved rows only once teardown has begun.
    const claim = async (now: string) => (await pg.query("select leg_id, kind from public.direct_call_cleanup_claim($1, $2::timestamptz, 20) order by leg_id", [USER_A, now])).rows;
    expect((await claim(new Date(Date.now() + 1000).toISOString())).map((r) => r.leg_id)).toEqual(["b-1", "s-1", "s-2"]);
    expect(await claim(new Date(Date.now() + 2000).toISOString())).toEqual([]); // leased
    expect((await claim(new Date(Date.now() + 60_000).toISOString())).length).toBe(3); // lease expired
    await pg.query("update public.direct_call_cleanups set confirmed_at = now() where direct_call_id=$1", [callId]);

    // An unresolved dial of a LIVE call is not claimable; once the call is ending it is.
    const live = await begin(USER_A, "00000000-0000-0000-0000-00000000aa06");
    expect(live.outcome).toBe("created");
    const farFuture = new Date(Date.now() + 3600_000).toISOString();
    expect(await claim(farFuture)).toEqual([]);
    await pg.query("update public.direct_calls set status='ending' where id=$1", [live.call_id]);
    expect((await claim(farFuture)).map((r) => r.kind)).toEqual(["unresolved_dial"]);
    // dial_rejected resolves it.
    await pg.query("select public.direct_call_dial_rejected($1, 'browser')", [live.call_id]);
    expect(await open(live.call_id)).toEqual([]);
    await pg.query("update public.direct_calls set status='failed' where id=$1", [live.call_id]);

    // Reservation lifecycle: target filled in; a refused-prepare reservation is discarded with its rows.
    const reserved = await begin(USER_A, "00000000-0000-0000-0000-00000000aa07");
    await pg.query("select public.direct_call_set_target($1, null, null, '+15550000009')", [reserved.call_id]);
    expect((await pg.query("select destination_e164 from public.direct_calls where id=$1", [reserved.call_id])).rows[0].destination_e164).toBe("+15550000009");
    await pg.query("select public.direct_call_discard_reservation($1)", [reserved.call_id]);
    expect((await pg.query("select count(*)::int as n from public.direct_calls where id=$1", [reserved.call_id])).rows[0].n).toBe(0);
    expect((await pg.query("select count(*)::int as n from public.direct_call_cleanups where direct_call_id=$1", [reserved.call_id])).rows[0].n).toBe(0);

    // Cancel by request id: an existing call is returned; otherwise a terminal tombstone blocks a late start.
    const cancelNew = (await pg.query("select * from public.direct_call_cancel_request($1, $2, '00000000-0000-0000-0000-00000000aa08')", [ORG, USER_A])).rows[0];
    expect(cancelNew.outcome).toBe("tombstoned");
    expect((await pg.query("select status, failure_reason from public.direct_calls where id=$1", [cancelNew.call_id])).rows[0]).toEqual({ status: "failed", failure_reason: "cancelled_before_start" });
    expect((await begin(USER_A, "00000000-0000-0000-0000-00000000aa08"))).toMatchObject({ outcome: "duplicate_request", call_id: cancelNew.call_id });
    expect((await pg.query("select * from public.direct_call_cancel_request($1, $2, '00000000-0000-0000-0000-00000000aa08')", [ORG, USER_A])).rows[0]).toMatchObject({ outcome: "existing", call_id: cancelNew.call_id });
    expect((await pg.query("select public.direct_call_operator_busy($1) as b", [USER_A])).rows[0].b).toBeNull(); // tombstone holds no lock

    // Functions and the cleanup table are service-role only.
    await pg.query("savepoint fn_authed");
    try {
      await pg.query("set local role authenticated");
      await pg.query("savepoint fn_a");
      await expect(pg.query("select public.direct_call_operator_busy($1)", [USER_A])).rejects.toMatchObject({ code: "42501" });
      await pg.query("rollback to savepoint fn_a");
      await expect(pg.query("select * from public.direct_call_cleanups")).rejects.toMatchObject({ code: "42501" });
    } finally { await pg.query("rollback to savepoint fn_authed"); }
    await pg.query(
      "insert into public.direct_call_events (provider_event_id, event_type, payload) values ('evt-1','call.answered','{}')",
    );
    await pg.query("savepoint dup_event");
    await expect(pg.query(
      "insert into public.direct_call_events (provider_event_id, event_type, payload) values ('evt-1','call.answered','{}')",
    )).rejects.toMatchObject({ code: "23505" });
    await pg.query("rollback to savepoint dup_event");

    // seller_dial_state is a checked column with no default.
    const callB = await pg.query("select id, seller_dial_state from public.direct_calls where operator_user_id=$1", [USER_B]);
    expect(callB.rows[0].seller_dial_state).toBeNull();
    await pg.query("savepoint bad_dial_state");
    await expect(pg.query("update public.direct_calls set seller_dial_state='bogus' where operator_user_id=$1", [USER_B])).rejects.toMatchObject({ code: "23514" });
    await pg.query("rollback to savepoint bad_dial_state");

    // Event reads need active org membership as well as ownership of the call.
    await pg.query("insert into public.direct_call_events (provider_event_id, direct_call_id, event_type, payload) values ('evt-b','"+callB.rows[0].id+"','call.answered','{}')");
    await pg.query("savepoint events_member");
    try {
      await pg.query("set local role authenticated");
      await pg.query("select set_config('request.jwt.claim.sub', $1, true)", [USER_B]);
      expect((await pg.query("select provider_event_id from public.direct_call_events")).rows.map((r) => r.provider_event_id)).toEqual(["evt-b"]);
    } finally { await pg.query("rollback to savepoint events_member"); }
    await pg.query("update public.memberships set access_status='suspended' where user_id=$1", [USER_B]);
    await pg.query("savepoint events_removed");
    try {
      await pg.query("set local role authenticated");
      await pg.query("select set_config('request.jwt.claim.sub', $1, true)", [USER_B]);
      expect((await pg.query("select provider_event_id from public.direct_call_events")).rows).toEqual([]);
    } finally { await pg.query("rollback to savepoint events_removed"); }
    await pg.query("update public.memberships set access_status='active' where user_id=$1", [USER_B]);

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
