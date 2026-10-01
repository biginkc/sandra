import fs from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";
import { createSupabaseDirectCallStore } from "../../src/lib/direct-calling/store";
import { nextDirectCallState } from "../../src/lib/direct-calling/transitions";

const ORG = "00000000-0000-0000-0000-0000000d1c01";
const USER_A = "00000000-0000-0000-0000-0000000d1a01";
const USER_B = "00000000-0000-0000-0000-0000000d1a02";
const USER_C = "00000000-0000-0000-0000-0000000d1a03";
const JSONB_PARAMS = new Set(["p_patch", "p_cleanups"]);

/**
 * A Supabase-admin-shaped client backed by the test's own Postgres connection, so the REAL
 * createSupabaseDirectCallStore runs against the REAL SQL functions: every payload the store sends
 * (the TS serializer's output) is what direct_call_apply receives. rpc() is PostgREST's shape: a
 * scalar for scalar/void functions, rows otherwise; from() supports select(*).eq(col, v).single().
 */
function pgAdmin(pg: Client) {
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    const values = keys.map((k) => (JSONB_PARAMS.has(k) ? JSON.stringify(args[k]) : args[k]));
    const named = keys.map((k, i) => `${k} => $${i + 1}${JSONB_PARAMS.has(k) ? "::jsonb" : ""}`).join(", ");
    try {
      const res = await pg.query(`select * from public.${fn}(${named})`, values);
      const scalar = res.fields.length === 1 && res.fields[0].name === fn;
      const data = scalar ? (res.rows[0]?.[fn] === "" ? null : (res.rows[0]?.[fn] ?? null)) : res.rows;
      return { data, error: null };
    } catch (error) {
      const e = error as { message: string; code?: string };
      return { data: null, error: { message: e.message, code: e.code } };
    }
  };
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const read = async () => {
      const where = filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
      const res = await pg.query(`select * from public.${table} where ${where}`, filters.map(([, v]) => v));
      return res.rows[0] ?? null;
    };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => (filters.push([column, value]), builder),
      single: async () => {
        const data = await read();
        return { data, error: data ? null : { message: "no row" } };
      },
      maybeSingle: async () => ({ data: await read(), error: null }),
      insert: async (values: Record<string, unknown>) => {
        const keys = Object.keys(values);
        try {
          await pg.query(
            `insert into public.${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
            keys.map((k) => (values[k] !== null && typeof values[k] === "object" ? JSON.stringify(values[k]) : values[k])),
          );
          return { error: null };
        } catch (error) {
          const e = error as { message: string; code?: string };
          return { error: { message: e.message, code: e.code } };
        }
      },
    };
    return builder;
  };
  return { rpc, from } as never;
}

// The files wrap themselves in begin/commit; strip that so the test's own
// transaction can roll everything back.
const stripTx = (sql: string) => sql.replace(/^\s*(begin|commit);\s*$/gim, "");

it("applies twice, enforces one active call per operator, scopes reads, and rolls back", async () => {
  const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const migration = stripTx(fs.readFileSync("supabase/migrations/20261001200000_direct_calls.sql", "utf8"));
  const timingMigration = stripTx(fs.readFileSync("supabase/migrations/20261001210000_direct_call_duration_dispatch.sql", "utf8"));
  const timingRollback = stripTx(fs.readFileSync("supabase/rollbacks/20261001210000_direct_call_duration_dispatch.sql", "utf8"));
  const rollback = stripTx(fs.readFileSync("supabase/rollbacks/20261001200000_direct_calls.sql", "utf8"));
  await pg.query("begin");
  try {
    await pg.query(migration);
    await pg.query(migration);
    await pg.query(timingMigration);
    await pg.query(timingMigration);
    await pg.query("insert into public.organizations(id,name) values ($1,'Direct calls test') on conflict do nothing", [ORG]);
    for (const id of [USER_A, USER_B, USER_C]) {
      await pg.query("insert into auth.users (id) values ($1) on conflict do nothing", [id]);
      await pg.query("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')", [id, ORG]);
    }
    const store = createSupabaseDirectCallStore(pgAdmin(pg));
    const insertCall = (user: string, status: string, requestId: string) => pg.query(
      `insert into public.direct_calls (org_id, operator_user_id, destination_e164, caller_id_e164, status, client_request_id)
       values ($1, $2, '+15550000001', '+15550000002', $3, $4) returning id`,
      [ORG, user, status, requestId],
    );
    const begin = async (user: string, requestId: string, limit = 7200) =>
      (await pg.query("select * from public.direct_call_begin($1, $2, null, null, '', '+15550000002', $3, $4)", [ORG, user, requestId, limit])).rows[0];
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
    const bounded = await begin(USER_B, "00000000-0000-0000-0000-00000000bb02", 180);
    expect(bounded.outcome).toBe("created");
    expect((await pg.query("select time_limit_secs from public.direct_calls where operator_user_id=$1", [USER_B])).rows[0].time_limit_secs).toBe(180);
    await pg.query("update public.direct_calls set failure_reason='teardown_pending' where id=$1", [bounded.call_id]);
    expect(await store.markDialStarted(bounded.call_id, "browser", "2026-10-01T12:00:01.000Z", 30, 180)).toBe(false);
    expect((await pg.query("select dial_started_at from public.direct_call_cleanups where direct_call_id=$1", [bounded.call_id])).rows[0].dial_started_at).toBeNull();
    const timing = (await pg.query("select resolve_after, backstop_at, dial_started_at from public.direct_call_cleanups where direct_call_id=$1", [callId])).rows[0];
    expect(timing).toEqual({ resolve_after: null, backstop_at: null, dial_started_at: null });
    const browserDispatch = new Date("2026-10-01T12:00:40.000Z");
    expect(await store.markDialStarted(callId, "browser", browserDispatch.toISOString(), 30, 7200)).toBe(true);
    const browserTiming = (await pg.query("select extract(epoch from resolve_after - dial_started_at)::int as ra, extract(epoch from backstop_at - dial_started_at)::int as bk from public.direct_call_cleanups where direct_call_id=$1", [callId])).rows[0];
    expect(browserTiming).toEqual({ ra: 55, bk: 7300 }); // 10s marker allowance + 30s ring + 7200s active leg + 60s grace

    // apply, driven through the REAL store (its serializer builds the payloads): CAS on status, resolves the
    // Dial for a learned leg, and writes every cleanup row kind WITH its role and timings in the same statement.
    const applied = await store.updateIfStatus(
      callId, ["browser_connecting"],
      { status: "seller_dialing", browser_leg_id: "b-1", seller_dial_state: "pending" },
      [{ kind: "unresolved_dial", role: "seller", timeoutSecs: 30, timeLimitSecs: 7195 }],
    );
    expect(applied).toMatchObject({ status: "seller_dialing", browser_leg_id: "b-1", seller_dial_state: "pending" });
    expect(await open(callId)).toEqual([{ kind: "unresolved_dial", dial_role: "seller", leg_id: null }]); // browser resolved, seller open
    const sellerTiming = (await pg.query("select resolve_after, backstop_at, dial_started_at from public.direct_call_cleanups where direct_call_id=$1 and dial_role='seller'", [callId])).rows[0];
    expect(sellerTiming).toEqual({ resolve_after: null, backstop_at: null, dial_started_at: null });
    const sellerDispatch = new Date("2026-10-01T12:00:45.000Z");
    expect(await store.markDialStarted(callId, "seller", sellerDispatch.toISOString(), 30, 7195)).toBe(true);
    const sellerBound = (await pg.query("select extract(epoch from resolve_after - dial_started_at)::int as ra, extract(epoch from backstop_at - dial_started_at)::int as bk from public.direct_call_cleanups where direct_call_id=$1 and dial_role='seller'", [callId])).rows[0];
    expect(sellerBound).toEqual({ ra: 55, bk: 7295 }); // allowance + ring + seller active leg + grace begin at seller dispatch
    expect(await store.updateIfStatus(callId, ["browser_connecting"], { status: "failed" })).toBeNull(); // status moved: no write, no rows
    // failure_reason may be explicitly nulled; hangup of the browser ends it and queues the other leg.
    const ended = await store.updateIfStatus(callId, ["seller_dialing"], { status: "failed", failure_reason: null }, [{ kind: "leg", legId: "b-1" }]);
    expect(ended).toMatchObject({ status: "failed", failure_reason: null });
    expect(await open(callId)).toEqual([{ kind: "leg", dial_role: null, leg_id: "b-1" }, { kind: "unresolved_dial", dial_role: "seller", leg_id: null }]);
    // The seller Dial's leg arrives after the call ended: stored, Dial resolved, leg queued for hangup.
    expect((await pg.query("select public.direct_call_dial_succeeded($1, 's-1', 'seller') as stored", [callId])).rows[0].stored).toBe(true);
    expect(await open(callId)).toEqual([{ kind: "leg", dial_role: null, leg_id: "b-1" }, { kind: "leg", dial_role: null, leg_id: "s-1" }]);
    expect((await pg.query("select seller_leg_id, seller_dial_state from public.direct_calls where id=$1", [callId])).rows[0]).toEqual({ seller_leg_id: "s-1", seller_dial_state: "sent" });
    // A different leg for an already-stored role is queued, not stored.
    expect((await pg.query("select public.direct_call_dial_succeeded($1, 's-2', 'seller') as stored", [callId])).rows[0].stored).toBe(false);
    expect((await open(callId)).map((r) => r.leg_id)).toEqual(["b-1", "s-1", "s-2"]);

    // claim: due rows only, lease pushes next_attempt_at out; unresolved rows only once teardown has begun.
    const claim = async (now: string, limit = 50) => (await store.claimDueCleanups(USER_A, now, 20, limit)).map((r) => ({ leg_id: r.leg_id, kind: r.kind })).sort((x, y) => String(x.leg_id).localeCompare(String(y.leg_id)));
    const claimOne = async (now: string) => (await store.claimDueCleanups(USER_A, now, 20, 1)).map((r) => r.leg_id);
    expect((await claimOne(new Date(Date.now() + 1000).toISOString())).length).toBe(1); // one row at a time
    expect((await claim(new Date(Date.now() + 1000).toISOString())).length).toBe(2); // the other two
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

    // ---- #743-3: a hangup handler working from a stale snapshot must not leave a live seller leg -----------
    const PROP = "00000000-0000-0000-0000-0000000d1b01";
    await pg.query("insert into public.properties (id, org_id, address, state) values ($1, $2, '1 Test St', 'MO')", [PROP, ORG]);
    const NOW = new Date("2026-10-01T12:00:00.000Z");
    const begunC = await store.beginCall({ org_id: ORG, operator_user_id: USER_C, property_id: PROP, contact_id: null, destination_e164: "+15550000010", caller_id_e164: "+15550000002", time_limit_secs: 7200, client_request_id: "00000000-0000-0000-0000-00000000cc01" });
    expect(begunC.outcome).toBe("created");
    const idC = (begunC as { row: { id: string } }).row.id;
    const answered = nextDirectCallState({ ...(begunC as unknown as { row: Record<string, unknown> }).row, browser_leg_id: null, created_at: NOW.toISOString() } as never, { type: "call.answered", callControlId: "b-race", role: "browser", occurredAt: null, hangupCause: null }, NOW);
    await store.updateIfStatus(idC, ["browser_connecting"], answered.patch!, answered.cleanups);
    // The hangup handler reads the row now: seller_leg_id is still null.
    const snapshot = (await store.findById(idC))!;
    expect(snapshot).toMatchObject({ status: "seller_dialing", seller_leg_id: null });
    // The call.hangup webhook of the browser leg was recorded first (as the route does), then the concurrent
    // seller Dial response stores its leg and resolves its unresolved row...
    await store.insertEvent({ provider_event_id: "evt-b-race-hangup", direct_call_id: idC, event_type: "call.hangup", occurred_at: null, payload: { data: { event_type: "call.hangup", payload: { call_control_id: "b-race" } } } });
    expect(await store.dialSucceeded(idC, "s-race", "seller")).toBe(true);
    expect(await open(idC)).toEqual([]);
    // ...and only then the handler's status-only compare-and-set lands, from the stale snapshot.
    const stale = nextDirectCallState(snapshot, { type: "call.hangup", callControlId: "b-race", role: "browser", occurredAt: null, hangupCause: null }, NOW);
    expect(stale.cleanups).toEqual([]); // the TS side knows nothing of the seller leg
    const failed = await store.updateIfStatus(idC, [snapshot.status], stale.patch!, stale.cleanups);
    expect(failed).toMatchObject({ status: "failed", seller_leg_id: "s-race" });
    // SQL queued the seller leg under the row lock (and not the browser leg, whose hangup was received).
    expect(await open(idC)).toEqual([{ kind: "leg", dial_role: null, leg_id: "s-race" }]);

    // ---- resume_pending: set atomically with the unconnected terminal transition ----------------------
    expect(failed).toMatchObject({ resume_pending: true });
    const t0 = new Date(Date.now() + 5000).toISOString();
    expect((await store.claimPendingResumes(USER_C, t0, 30)).map((r) => r.id)).toEqual([idC]);
    expect(await store.claimPendingResumes(USER_C, t0, 30)).toEqual([]); // leased: a second session does not also resume
    expect((await store.claimPendingResumes(USER_C, new Date(Date.now() + 60_000).toISOString(), 30)).length).toBe(1); // lease expired
    await store.clearResumePending(idC);
    expect(await store.claimPendingResumes(USER_C, new Date(Date.now() + 120_000).toISOString(), 30)).toEqual([]);
    // Ownership rule: two live calls on one property; the first to fail does not flag, the last does.
    const PROP2 = "00000000-0000-0000-0000-0000000d1b02";
    await pg.query("insert into public.properties (id, org_id, address, state) values ($1, $2, '2 Test St', 'MO')", [PROP2, ORG]);
    await pg.query("update public.direct_call_cleanups set confirmed_at = now() where operator_user_id = $1", [USER_C]);
    const second = await store.beginCall({ org_id: ORG, operator_user_id: USER_C, property_id: PROP2, contact_id: null, destination_e164: "+15550000011", caller_id_e164: "+15550000002", time_limit_secs: 7200, client_request_id: "00000000-0000-0000-0000-00000000cc02" });
    const idC2 = (second as { row: { id: string } }).row.id;
    await pg.query("update public.direct_calls set property_id = $1 where operator_user_id = $2 and status not in ('ended','failed') and id <> $3", [PROP2, USER_B, idC2]);
    const firstOfTwo = await store.updateIfStatus(idC2, ["browser_connecting"], { status: "failed", failure_reason: "browser_dial_rejected", ended_at: NOW.toISOString() });
    expect(firstOfTwo).toMatchObject({ resume_pending: false }); // USER_B's live call still owns PROP2
    const connectedCall = await store.updateIfStatus((await pg.query("select id from public.direct_calls where operator_user_id=$1 and status not in ('ended','failed')", [USER_B])).rows[0].id, ["browser_connecting"], { status: "failed", ended_at: NOW.toISOString() });
    expect(connectedCall).toMatchObject({ resume_pending: true });

    // ---- set_target on a reservation cancelled during prepare (status 'ending') ----------------------------
    await pg.query("update public.direct_call_cleanups set confirmed_at = now() where operator_user_id = $1", [USER_C]);
    await pg.query("update public.direct_calls set status = 'failed' where operator_user_id = $1 and status not in ('ended','failed')", [USER_C]);
    const PROP3 = "00000000-0000-0000-0000-0000000d1b03";
    await pg.query("insert into public.properties (id, org_id, address, state) values ($1, $2, '3 Test St', 'MO')", [PROP3, ORG]);
    await pg.query("update public.direct_call_cleanups set confirmed_at = now() where operator_user_id = $1", [USER_C]);
    const third = await store.beginCall({ org_id: ORG, operator_user_id: USER_C, property_id: null, contact_id: null, destination_e164: "", caller_id_e164: "+15550000002", time_limit_secs: 7200, client_request_id: "00000000-0000-0000-0000-00000000cc03" });
    const idC3 = (third as { row: { id: string } }).row.id;
    await store.updateIfStatus(idC3, ["browser_connecting"], { status: "ending" }); // cancelled during prepare
    await store.setTarget(idC3, { property_id: PROP3, contact_id: null, destination_e164: "+15550000033" });
    expect(await store.findById(idC3)).toMatchObject({ status: "ending", property_id: PROP3, destination_e164: "+15550000033" });
    expect(await store.updateIfStatus(idC3, ["ending"], { status: "failed", ended_at: NOW.toISOString() })).toMatchObject({ resume_pending: true });
    // A target is never rewritten once the row is terminal or already has one.
    await store.setTarget(idC3, { property_id: null, contact_id: null, destination_e164: "+15559999999" });
    expect(await store.findById(idC3)).toMatchObject({ property_id: PROP3, destination_e164: "+15550000033" });

    await pg.query(timingRollback);
    await pg.query(rollback);
    const gone = await pg.query("select to_regclass('public.direct_calls') as t");
    expect(gone.rows[0].t).toBeNull();
  } finally {
    await pg.query("rollback");
    await pg.end();
  }
});
