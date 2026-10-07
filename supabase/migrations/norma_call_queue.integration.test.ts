// RED tests for the Norma call queue migration. NOTE: when the migration number is
// reserved this file is renamed to `<version>_norma_call_queue.integration.test.ts`.
// Contract: docs/norma/queue-sql-contract.md (plan memoized-scribbling-reddy, v8 + rounds C..H).
// Local-only: one rollback-only transaction on a loopback database, SAVEPOINT per test.
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STATE_TO_TZ } from "../../src/lib/messaging/quiet-hours";
import { openConcurrentFixture, openQueueFixture, type ConcurrentFixture, type QueueFixture } from "@tests/integration/norma-queue-fixture";

const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres";

// ---------------------------------------------------------------------------
// Fixed virtual clock (Chicago = UTC-6 in January 2030). Window: Mon-Sat, HALF-OPEN [09:00, 19:30) local.
// SQL reads wall-clock time ONLY through norma_private.fn_norma_wallclock() (default clock_timestamp());
// every test `create or replace`s it inside its rollback savepoint (see setWall / run). Nothing here depends
// on the real clock and nothing is skipped.
// ---------------------------------------------------------------------------
const V_OPEN = "2030-01-07T17:00:00Z"; // Mon 11:00 Chicago, open
const V_SUNDAY = "2030-01-06T17:00:00Z"; // Sun 11:00 Chicago, closed
const V_SAT_1929 = "2030-01-06T01:29:00Z"; // Sat 19:29 Chicago, open
const V_SAT_1931 = "2030-01-06T01:31:00Z"; // Sat 19:31 Chicago, closed
const V_SAT_192959 = "2030-01-06T01:29:59Z"; // Sat 19:29:59 Chicago, open (last open second)
const V_SAT_1930 = "2030-01-06T01:30:00Z"; // Sat 19:30:00 Chicago, closed (half-open upper bound)
const V_MON_0859 = "2030-01-07T14:59:00Z"; // Mon 08:59 Chicago, closed
const V_MON_085959 = "2030-01-07T14:59:59Z"; // Mon 08:59:59 Chicago, closed
const V_MON_0900 = "2030-01-07T15:00:00Z"; // Mon 09:00:00 Chicago, open (half-open lower bound)
const V_MON_0901 = "2030-01-07T15:01:00Z"; // Mon 09:01 Chicago, open
const V_NOT_DUE = "2000-01-03T17:00:00Z"; // Monday in the past: before any entry's next_attempt_at
const WALL_DEFAULT = "2030-01-07T14:00:00Z"; // default pinned wall clock: Mon 08:00 Chicago, window closed
const NEXT_OPEN = "2030-01-07T15:00:00Z"; // Mon 09:00 Chicago: next window open from WALL_DEFAULT
const AFTER_11AM_SEND = "2030-01-07T20:00:00Z"; // first send at 11:00 local (A_am) -> next slot 14:00 local (A_pm)
const plusSeconds = (iso: string, s: number) => new Date(new Date(iso).getTime() + s * 1000).toISOString();

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Ctx = { org: string; rep: string; assignee: string; sequence: string };
type Lead = { property: string; contact: string; phone: string; enrollment: string | null };

const holder: { fx?: QueueFixture } = {};
/** Pin the SQL clock seam (norma_private.fn_norma_wallclock) for the rest of the current savepoint. */
const setWall = (db: Client, iso: string) =>
  db.query(`create or replace function norma_private.fn_norma_wallclock() returns timestamptz language sql volatile as $wall$ select '${iso}'::timestamptz $wall$`);
/** Savepoint-isolated test with the wall clock pinned to WALL_DEFAULT. */
const run = (fn: (db: Client) => Promise<void>) =>
  holder.fx!.isolated(async (db) => {
    await setWall(db, WALL_DEFAULT);
    await fn(db);
  });
/** Savepoint-isolated test that sees the migration's own default clock seam. */
const runRaw = (fn: (db: Client) => Promise<void>) => holder.fx!.isolated(fn);
/** Table-owner write with triggers off (guards, FKs): used only to backdate/force fixture state inside a savepoint. */
async function ownerWrite(db: Client, sql: string, params: unknown[] = []) {
  await db.query("set local session_replication_role = replica");
  try {
    return await db.query(sql, params);
  } finally {
    await db.query("set local session_replication_role = origin");
  }
}
/** Call merge_duplicate_properties as an authenticated member (it reads auth.uid()), committed inside the savepoint. */
async function mergeProps(db: Client, actor: string, keeper: string, loser: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [actor]);
  await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
  try {
    await db.query("select public.merge_duplicate_properties($1::uuid,$2::uuid)", [keeper, loser]);
  } finally {
    await db.query("select set_config('request.jwt.claim.sub','',true)");
    await db.query("select set_config('request.jwt.claim.role','',true)");
  }
}
const nextSlotFor = async (db: Client, state: string, sends: string[], now: string): Promise<Row> =>
  (await svcOne(db, "select public.fn_norma_queue_next_slot_for($1::text,$2::timestamptz[],$3::timestamptz) as r", [state, sends, now])).r as Row;
const nextSlotOf = async (db: Client, entry: string, now: string): Promise<Row> =>
  (await svcOne(db, "select public.fn_norma_queue_next_slot($1::uuid,$2::timestamptz) as r", [entry, now])).r as Row;
const sameInstant = async (db: Client, table: string, col: string, id: string, iso: string) =>
  (await one(db, `select ${col} = $2::timestamptz as ok from public.${table} where id=$1`, [id, iso])).ok as boolean;
const escalate = async (db: Client, requestId: string) => {
  await svc(db, "select public.fn_norma_mark_dispatch_unknown($1::uuid,'t',1::integer)", [requestId]);
  await svc(db, "select public.fn_norma_mark_needs_review($1::uuid,'t',1::integer)", [requestId]);
};
const markReviewed = async (db: Client, requestId: string, property: string, user: string): Promise<Row> =>
  (await svcOne(db, "select public.fn_norma_mark_reviewed($1::uuid,$2::uuid,$3::uuid) as r", [requestId, property, user])).r as Row;

// ---- rows that exist BEFORE the queue migration is applied ([E3], [F3], [G1]) -----------------------------
type Seeded = {
  ctx: Ctx;
  completed: { id: string; l: Lead }; // legacy call placed today, already completed
  unknown: { id: string; l: Lead }; // legacy dispatch_unknown, timestamps backdated 3 days, no send marker
  dispatching: { id: string; l: Lead }; // legacy worker claimed, send still pending when the migration lands
};
const seeded: { v?: Seeded } = {};
async function seedPreMigration(db: Client): Promise<Seeded> {
  const ctx = await newOrg(db);
  const mk = async () => {
    const l = await lead(db, ctx);
    const id = (await svcOne(db, "select * from public.fn_norma_create_request($1::uuid,$2::uuid,$3::text,$4::uuid,'ctx',$5::uuid)", [l.property, l.contact, l.phone, ctx.rep, ctx.assignee])).request_id as string;
    expect((await svcOne(db, "select public.fn_norma_claim_dispatch($1::uuid) as c", [id])).c, "pre-migration legacy claim").toBe(true);
    return { id, l };
  };
  const completed = await mk();
  expect(await bind(db, completed.id, "seed-completed")).toBe("bound");
  await complete(db, completed.id, "seed-completed", "callback_requested", { callback_raw: "monday" });
  const unknown = await mk();
  await svc(db, "select public.fn_norma_mark_dispatch_unknown($1::uuid,'t',1::integer)", [unknown.id]);
  await db.query("update public.norma_call_requests set dispatch_started_at = now() - interval '3 days' where id=$1", [unknown.id]);
  const dispatching = await mk();
  return { ctx, completed, unknown, dispatching };
}

let phoneCounter = 0;
const nextPhone = () => `+1816557${String(1000 + (phoneCounter++ % 9000)).padStart(4, "0")}`;

const one = async (db: Client, sql: string, params: unknown[] = []): Promise<Row> => (await db.query(sql, params)).rows[0]!;
const count = async (db: Client, sql: string, params: unknown[] = []) => Number((await one(db, sql, params)).n);
const dbNow = async (db: Client) => (await one(db, "select now()::text as t")).t as string;

async function newOrg(db: Client): Promise<Ctx> {
  const ctx: Ctx = { org: randomUUID(), rep: randomUUID(), assignee: randomUUID(), sequence: randomUUID() };
  await db.query("insert into auth.users(id) values ($1), ($2)", [ctx.rep, ctx.assignee]);
  await db.query("insert into public.organizations(id,name) values ($1,$2)", [ctx.org, `queue test ${randomUUID()}`]);
  await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [ctx.assignee, ctx.org]);
  await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','active')", [ctx.rep, ctx.org]);
  await db.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Norma drip')", [ctx.sequence, ctx.org]);
  await db.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','hi')", [ctx.sequence]);
  return ctx;
}

async function lead(
  db: Client,
  ctx: Ctx,
  o: { state?: string; dispo?: string | null; propStatus?: string; doNotContact?: boolean; noPhone?: boolean; sameContactAs?: Lead; enrollment?: boolean } = {},
): Promise<Lead> {
  const property = randomUUID();
  let contact = o.sameContactAs?.contact ?? randomUUID();
  const phone = o.sameContactAs?.phone ?? nextPhone();
  if (!o.sameContactAs) {
    await db.query(
      "insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type,do_not_contact) values ($1,$2,'Seller',$3,$4,$5)",
      [contact, ctx.org, o.noPhone ? null : phone, o.noPhone ? "unknown" : "mobile", o.doNotContact ?? false],
    );
  }
  contact = o.sameContactAs?.contact ?? contact;
  await db.query(
    "insert into public.properties(id,org_id,address,state,status,homeowner_contact_id,outreach_dispo) values ($1,$2,$3,$4,$5,$6,$7)",
    [property, ctx.org, `${property.slice(0, 6)} Main St`, o.state ?? "MO", o.propStatus ?? "new_lead", contact, o.dispo ?? null],
  );
  let enrollment: string | null = null;
  if (o.enrollment ?? true) {
    enrollment = (await one(db, "insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,next_run_at) values ($1,$2,$3,$4,'active',now()) returning id", [ctx.org, ctx.sequence, property, contact])).id;
  }
  return { property, contact, phone, enrollment };
}

type TryResult = { error: { code?: string; message?: string } | null; rowCount: number | null; rows: Row[] };
/** Run one statement under a role / jwt claim, inside a savepoint that is always rolled back. */
async function tryAs(db: Client, role: string | null, claimRole: string, sql: string, params: unknown[] = [], sub: string | null = null): Promise<TryResult> {
  if (role) await db.query(`set local role ${role}`);
  await db.query("select set_config('request.jwt.claim.role',$1,true)", [claimRole]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub ?? ""]);
  await db.query("savepoint try_as");
  const out: TryResult = { error: null, rowCount: null, rows: [] };
  try {
    const r = await db.query(sql, params);
    out.rowCount = r.rowCount;
    out.rows = r.rows;
  } catch (e) {
    out.error = e as { code?: string; message?: string };
  }
  await db.query("rollback to savepoint try_as");
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claim.role','',true)");
  return out;
}

async function svc(db: Client, sql: string, params: unknown[] = []): Promise<Row[]> {
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role','service_role',true)");
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.query("reset role").catch(() => {});
    await db.query("select set_config('request.jwt.claim.role','',true)").catch(() => {});
  }
}
const svcOne = async (db: Client, sql: string, params: unknown[] = []) => (await svc(db, sql, params))[0]!;
/** Service-role call that is expected to fail; returns the error. */
async function svcErr(db: Client, sql: string, params: unknown[] = []) {
  return (await tryAs(db, "service_role", "service_role", sql, params)).error;
}

// ---- queue helpers ---------------------------------------------------------
const ENTRY_COLS = "id, org_id, property_id, contact_id, requested_by, status, pause_reason, end_reason, blocked_reason, phase, display_tz, next_attempt_at, lease_token, lease_expires_at, dispatch_token, last_request_id, reply_ack_at, created_at";
const entryOf = (db: Client, id: string) => one(db, `select ${ENTRY_COLS} from public.norma_queue_entries where id=$1`, [id]);
const attemptsOf = async (db: Client, entryId: string) =>
  (await db.query("select * from public.norma_queue_attempts where entry_id=$1 order by sent_at", [entryId])).rows as Row[];
const requestOf = (db: Client, id: string) =>
  one(db, "select id, status, outcome, attempt, queue_entry_id, queue_lease_token, queue_dispatch_token, send_attempted_at, callback_assignee_id, dispatch_error, dispatch_started_at from public.norma_call_requests where id=$1", [id]);

async function enqueueRaw(db: Client, ctx: Ctx, props: string[], requestedBy = ctx.rep, context: string | null = "ctx") {
  return svc(db, "select * from public.fn_norma_queue_enqueue($1::uuid,$2::uuid,$3::uuid[],$4::text)", [ctx.org, requestedBy, props, context]);
}
/** Enqueue one lead (must succeed); backdate created_at (reply watermark) and next_attempt_at (due at every 2030 virtual time). */
async function enqueueOne(db: Client, ctx: Ctx, l: Lead, requestedBy = ctx.rep): Promise<string> {
  const row = (await enqueueRaw(db, ctx, [l.property], requestedBy))[0]!;
  expect(row).toMatchObject({ property_id: l.property, result: "queued" });
  await db.query("update public.norma_queue_entries set created_at = created_at - interval '1 day', next_attempt_at = '2029-12-01T00:00:00Z' where id=$1", [row.entry_id]);
  return row.entry_id as string;
}
const claimTx1 = async (db: Client, entry: string, now: string, enabled = true) =>
  svcOne(db, "select * from public.fn_norma_queue_claim($1::uuid,$2::timestamptz,$3::boolean)", [entry, now, enabled]);
const createV2 = (db: Client, l: Lead, requestedBy: string, assignee: string, entry: string | null = null, lease: string | null = null) =>
  svcOne(db, "select * from public.fn_norma_create_request_v2($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::uuid,$7::uuid,$8::uuid)", [l.property, l.contact, l.phone, requestedBy, "ctx", assignee, entry, lease]);
type V2Opts = { enabled?: boolean; maxC?: number; daily?: number; tz?: string; attempt?: number };
const claimV2 = async (db: Client, id: string, now: string, o: V2Opts = {}) =>
  (await svcOne(db, "select public.fn_norma_claim_dispatch_v2($1::uuid,$2::integer,$3::timestamptz,$4::boolean,$5::integer,$6::integer,$7::text) as r", [id, o.attempt ?? 1, now, o.enabled ?? true, o.maxC ?? 1000, o.daily ?? 100000, o.tz ?? "America/Chicago"])).r as string;
const markSending = async (db: Client, id: string, token: string | null) =>
  (await svcOne(db, "select public.fn_norma_mark_sending($1::uuid,$2::uuid,1) as r", [id, token])).r as string;
const settle = async (db: Client, id: string, outcome: string, source = "webhook") =>
  (await svcOne(db, "select public.fn_norma_queue_settle($1::uuid,$2::text,$3::text) as r", [id, outcome, source])).r as string;
const pauseEntry = async (db: Client, id: string, actor: string) => (await svcOne(db, "select public.fn_norma_queue_pause($1::uuid,$2::uuid) as r", [id, actor])).r as string;
const resumeEntry = async (db: Client, id: string, actor: string, now: string | null = null) => (await svcOne(db, "select public.fn_norma_queue_resume($1::uuid,$2::uuid,$3::timestamptz) as r", [id, actor, now])).r as string;
const cancelEntry = async (db: Client, id: string, actor: string) => (await svcOne(db, "select public.fn_norma_queue_cancel($1::uuid,$2::uuid) as r", [id, actor])).r as string;
const applyPresend = async (db: Client, requestId: string, result: string) =>
  (await svcOne(db, "select public.fn_norma_queue_apply_presend($1::uuid,$2::text) as r", [requestId, result])).r as string;
const releaseExpired = async (db: Client, now: string) => Number((await svcOne(db, "select public.fn_norma_queue_release_expired_leases($1::timestamptz) as n", [now])).n);
const sweepBlocks = async (db: Client) => Number((await svcOne(db, "select public.fn_norma_queue_sweep_blocks() as n")).n);
const sweepReplies = async (db: Client) => Number((await svcOne(db, "select public.fn_norma_queue_sweep_replies() as n")).n);
const pauseUnknownState = async (db: Client, entry: string) => (await svcOne(db, "select public.fn_norma_queue_pause_unknown_state($1::uuid) as r", [entry])).r as string;
/** claim with the optional rule-2 pre-check limits (PROPOSED trailing defaulted params). */
const claimTx1Cap = async (db: Client, entry: string, now: string, o: { maxC?: number | null; daily?: number | null; tz?: string } = {}) =>
  svcOne(db, "select * from public.fn_norma_queue_claim($1::uuid,$2::timestamptz,true,$3::integer,$4::integer,$5::text)", [entry, now, o.maxC ?? null, o.daily ?? null, o.tz ?? "America/Chicago"]);
const eligibilityOf = async (db: Client, l: Lead): Promise<Row> =>
  svcOne(db, "select * from public.fn_norma_eligibility($1::uuid,$2::uuid,$3::text)", [l.property, l.contact, l.phone]);
const stamp = (db: Client, requestId: string, at: string) => db.query("update public.norma_call_requests set send_attempted_at=$2::timestamptz where id=$1", [requestId, at]);
const bind = async (db: Client, id: string, callId: string) => (await svcOne(db, "select public.fn_norma_bind_call_id($1::uuid,$2::text,1::integer) as b", [id, callId])).b as string;
const complete = async (db: Client, id: string, callId: string, outcome: string, payload: Record<string, unknown> = {}) =>
  (await svcOne(db, "select public.fn_norma_complete_call($1::uuid,$2::text,$3::text,$4::jsonb) as r", [id, callId, outcome, JSON.stringify({ attempt: 1, ...payload })])).r as Row;
async function setControl(db: Client, enabled: boolean | null) {
  await db.query("delete from public.norma_queue_control");
  if (enabled !== null) await db.query("insert into public.norma_queue_control(singleton, enabled) values (true, $1)", [enabled]);
}

type Flight = { ctx: Ctx; l: Lead; entry: string; requestId: string; lease: string; dispatch: string };
/** Entry claimed at the virtual open time, request created and dispatch-claimed (status dispatching), no send marker. */
async function inFlight(db: Client, ctx?: Ctx, o: { state?: string; l?: Lead } = {}): Promise<Flight> {
  const c = ctx ?? (await newOrg(db));
  const l = o.l ?? (await lead(db, c, { state: o.state }));
  const entry = await enqueueOne(db, c, l);
  const claim = await claimTx1(db, entry, V_OPEN);
  expect(claim.result).toBe("claimed");
  const req = await createV2(db, l, c.rep, c.rep, entry, claim.lease_token);
  expect(req.outcome).toBe("created");
  expect(await claimV2(db, req.request_id, V_OPEN)).toBe("claimed");
  return { ctx: c, l, entry, requestId: req.request_id, lease: claim.lease_token, dispatch: claim.dispatch_token };
}
/** inFlight plus a send marker at V_OPEN (as if mark_sending had admitted the send); the SQL clock is pinned to V_OPEN. */
async function inFlightSent(db: Client, ctx?: Ctx): Promise<Flight> {
  const f = await inFlight(db, ctx);
  await stamp(db, f.requestId, V_OPEN);
  await setWall(db, V_OPEN);
  return f;
}
/** Entry claimed and request created (status requested, no dispatch claim); the SQL clock is pinned to V_OPEN. */
async function createdReq(db: Client, ctx?: Ctx, o: { state?: string; l?: Lead } = {}): Promise<Flight> {
  const c = ctx ?? (await newOrg(db));
  const l = o.l ?? (await lead(db, c, { state: o.state }));
  const entry = await enqueueOne(db, c, l);
  const claim = await claimTx1(db, entry, V_OPEN);
  expect(claim.result).toBe("claimed");
  const req = await createV2(db, l, c.rep, c.rep, entry, claim.lease_token);
  expect(req.outcome).toBe("created");
  await setWall(db, V_OPEN);
  return { ctx: c, l, entry, requestId: req.request_id, lease: claim.lease_token, dispatch: claim.dispatch_token };
}
/** A non-queue (button-style) request on a lead, created through v2 with no entry. */
async function plainRequest(db: Client, ctx: Ctx, l: Lead): Promise<string> {
  const r = await createV2(db, l, ctx.rep, ctx.assignee);
  expect(r.outcome).toBe("created");
  return r.request_id as string;
}
type Start = "queued" | "calling" | "paused" | "done" | "cancelled";
async function putEntryIn(db: Client, f: Flight, state: Start) {
  if (state === "paused") expect(await pauseEntry(db, f.entry, f.ctx.rep)).toMatch(/paused|noop/);
  else if (state === "cancelled") await cancelEntry(db, f.entry, f.ctx.rep);
  else if (state === "done") await db.query("update public.norma_queue_entries set status='done', end_reason='test_forced' where id=$1", [f.entry]);
  else if (state === "queued") await db.query("update public.norma_queue_entries set status='queued' where id=$1", [f.entry]);
  expect((await entryOf(db, f.entry)).status).toBe(state);
}
const inboundMessage = (db: Client, ctx: Ctx, l: Lead, createdAtSql = "now()", direction = "inbound") =>
  db.query(`insert into public.messages(org_id,channel,direction,property_id,contact_id,body,status,created_at) values ($1,'sms',$2,$3,$4,'reply',$5,${createdAtSql})`, [ctx.org, direction, l.property, l.contact, direction === "inbound" ? "received" : "sent"]);
const consent = (db: Client, ctx: Ctx, l: Lead, channel: string, type: string, occurredAtSql = "now()") =>
  db.query(`insert into public.consent_events(org_id,contact_id,channel,event_type,occurred_at) values ($1,$2,$3,$4,${occurredAtSql})`, [ctx.org, l.contact, channel, type]);

const NEW_TABLES = ["norma_queue_entries", "norma_queue_attempts", "norma_queue_digests", "norma_followup_reassignments", "norma_state_timezones", "norma_queue_control"] as const;
const NEW_RPCS = ["fn_norma_queue_enqueue", "fn_norma_queue_claim", "fn_norma_create_request_v2", "fn_norma_claim_dispatch_v2", "fn_norma_mark_sending", "fn_norma_queue_settle", "fn_norma_queue_pause", "fn_norma_queue_resume", "fn_norma_queue_cancel", "fn_norma_queue_block_reason", "fn_norma_queue_next_slot", "fn_norma_queue_next_slot_for", "fn_norma_queue_apply_presend", "fn_norma_queue_release_expired_leases", "fn_norma_queue_sweep_blocks", "fn_norma_queue_sweep_replies", "fn_norma_queue_pause_unknown_state"] as const;
const RPC_CALLS: Record<string, string> = {
  fn_norma_queue_enqueue: "select * from public.fn_norma_queue_enqueue($1::uuid,$1::uuid,array[$1::uuid],null)",
  fn_norma_queue_claim: "select * from public.fn_norma_queue_claim($1::uuid, now(), true)",
  fn_norma_create_request_v2: "select * from public.fn_norma_create_request_v2($1::uuid,$1::uuid,'+18165550100',$1::uuid,null,$1::uuid,$1::uuid,$1::uuid)",
  fn_norma_claim_dispatch_v2: "select public.fn_norma_claim_dispatch_v2($1::uuid,1,now(),true,10,10,'America/Chicago')",
  fn_norma_mark_sending: "select public.fn_norma_mark_sending($1::uuid,$1::uuid,1)",
  fn_norma_queue_settle: "select public.fn_norma_queue_settle($1::uuid,'no_answer','webhook')",
  fn_norma_queue_pause: "select public.fn_norma_queue_pause($1::uuid,$1::uuid)",
  fn_norma_queue_resume: "select public.fn_norma_queue_resume($1::uuid,$1::uuid,now())",
  fn_norma_queue_cancel: "select public.fn_norma_queue_cancel($1::uuid,$1::uuid)",
  fn_norma_queue_block_reason: "select public.fn_norma_queue_block_reason($1::uuid)",
  fn_norma_queue_next_slot: "select public.fn_norma_queue_next_slot($1::uuid, now())",
  fn_norma_queue_next_slot_for: "select public.fn_norma_queue_next_slot_for('MO', array[]::timestamptz[], now()) where $1::uuid is not null",
  fn_norma_queue_apply_presend: "select public.fn_norma_queue_apply_presend($1::uuid,'capacity_daily')",
  fn_norma_queue_release_expired_leases: "select public.fn_norma_queue_release_expired_leases(now()) where $1::uuid is not null",
  fn_norma_queue_sweep_blocks: "select public.fn_norma_queue_sweep_blocks() where $1::uuid is not null",
  fn_norma_queue_sweep_replies: "select public.fn_norma_queue_sweep_replies() where $1::uuid is not null",
  fn_norma_queue_pause_unknown_state: "select public.fn_norma_queue_pause_unknown_state($1::uuid)",
};

/** One entry + attempt + reassignment + digest in `ctx`'s org, built through real functions where possible. */
async function seedOrgRows(db: Client, ctx: Ctx) {
  const f = await inFlightSent(db, ctx);
  expect(await settle(db, f.requestId, "no_answer")).toBeTruthy();
  await db.query(
    "insert into public.norma_followup_reassignments(org_id,request_id,property_id,intended_assignee,kind,payload) values ($1,$2,$3,$4,'review_task','{}'::jsonb)",
    [ctx.org, f.requestId, f.l.property, ctx.rep],
  );
  await db.query("insert into public.norma_queue_digests(org_id,local_date,edition,payload) values ($1,'2030-01-07','morning','{}'::jsonb)", [ctx.org]);
  return f;
}
const WRITE_PROBES: Record<(typeof NEW_TABLES)[number], { insert: string; update: string }> = {
  norma_queue_entries: { insert: "insert into public.norma_queue_entries default values", update: "update public.norma_queue_entries set updated_at = now()" },
  norma_queue_attempts: { insert: "insert into public.norma_queue_attempts default values", update: "update public.norma_queue_attempts set updated_at = now()" },
  norma_queue_digests: { insert: "insert into public.norma_queue_digests default values", update: "update public.norma_queue_digests set attempts = attempts" },
  norma_followup_reassignments: { insert: "insert into public.norma_followup_reassignments default values", update: "update public.norma_followup_reassignments set status = status" },
  norma_state_timezones: { insert: "insert into public.norma_state_timezones default values", update: "update public.norma_state_timezones set timezone = timezone" },
  norma_queue_control: { insert: "insert into public.norma_queue_control default values", update: "update public.norma_queue_control set enabled = enabled" },
};
const denied = (r: TryResult) => r.error?.code === "42501" || (r.error === null && r.rowCount === 0);

describe("norma call queue (migration *_norma_call_queue)", () => {
  beforeAll(async () => { holder.fx = await openQueueFixture(dbUrl); }, 120_000);
  afterAll(async () => { await holder.fx?.close(); holder.fx = undefined; });

  // =========================================================================
  describe("security matrix (plan Security [B17], [C17 note], [E6])", () => {
    it.each(NEW_TABLES)("RLS is enabled on %s", (table) =>
      run(async (db) => {
        expect((await one(db, "select relrowsecurity as on from pg_class where oid = ('public.' || $1)::regclass", [table])).on).toBe(true);
      }));

    it("a member reads their own org's entries and attempts but not another org's", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const b = await newOrg(db);
        const fa = await seedOrgRows(db, a);
        const fb = await seedOrgRows(db, b);
        const asA = (sql: string) => tryAs(db, "authenticated", "authenticated", sql, [], a.rep);
        expect((await asA("select id from public.norma_queue_entries")).rows.map((r) => r.id)).toEqual([fa.entry]);
        expect((await asA("select entry_id from public.norma_queue_attempts")).rows.map((r) => r.entry_id)).toEqual([fa.entry]);
        expect((await asA(`select id from public.norma_queue_entries where id='${fb.entry}'`)).rows).toHaveLength(0);
        expect((await asA(`select entry_id from public.norma_queue_attempts where entry_id='${fb.entry}'`)).rows).toHaveLength(0);
      }));

    it("a non-member reads no entries or attempts", () =>
      run(async (db) => {
        const a = await newOrg(db);
        await seedOrgRows(db, a);
        const stranger = randomUUID();
        expect((await tryAs(db, "authenticated", "authenticated", "select id from public.norma_queue_entries", [], stranger)).rows).toHaveLength(0);
        expect((await tryAs(db, "authenticated", "authenticated", "select entry_id from public.norma_queue_attempts", [], stranger)).rows).toHaveLength(0);
      }));

    it("org members can read their own followup reassignments but not another org's", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const b = await newOrg(db);
        const fa = await seedOrgRows(db, a);
        await seedOrgRows(db, b);
        const r = await tryAs(db, "authenticated", "authenticated", "select request_id from public.norma_followup_reassignments", [], a.rep);
        expect(r.rows.map((x) => x.request_id)).toEqual([fa.requestId]);
      }));

    it.each(["norma_queue_digests", "norma_state_timezones"] as const)("%s has no member read access (service only)", (table) =>
      run(async (db) => {
        const a = await newOrg(db);
        await seedOrgRows(db, a);
        const r = await tryAs(db, "authenticated", "authenticated", `select * from public.${table}`, [], a.rep);
        expect(r.error?.code === "42501" || r.rows.length === 0).toBe(true);
      }));

    const writes = NEW_TABLES.flatMap((t) => (["insert", "update", "delete"] as const).map((op) => [t, op] as const));
    it.each(writes)("authenticated cannot write %s via %s (no privilege, no effect)", (table, op) =>
      run(async (db) => {
        const a = await newOrg(db);
        await seedOrgRows(db, a);
        await setControl(db, true);
        const sql = op === "delete" ? `delete from public.${table}` : WRITE_PROBES[table][op];
        const before = await count(db, `select count(*) as n from public.${table}`);
        const r = await tryAs(db, "authenticated", "authenticated", sql, [], a.rep);
        expect(denied(r), `${op} ${table}: ${r.error?.message ?? `rowCount ${r.rowCount}`}`).toBe(true);
        expect(await count(db, `select count(*) as n from public.${table}`)).toBe(before);
        const priv = (await one(db, "select has_table_privilege('authenticated', ('public.' || $1)::regclass, $2) as x", [table, op.toUpperCase()])).x;
        expect(priv, `authenticated must hold no ${op.toUpperCase()} privilege on ${table}`).toBe(false);
      }));

    it.each(NEW_TABLES)("anon cannot read or write %s", (table) =>
      run(async (db) => {
        const a = await newOrg(db);
        await seedOrgRows(db, a);
        await setControl(db, true);
        const read = await tryAs(db, "anon", "anon", `select * from public.${table}`);
        expect(read.error?.code === "42501" || read.rows.length === 0).toBe(true);
        for (const sql of [WRITE_PROBES[table].insert, WRITE_PROBES[table].update, `delete from public.${table}`]) {
          const r = await tryAs(db, "anon", "anon", sql);
          expect(denied(r), `${sql}: ${r.error?.message}`).toBe(true);
        }
      }));

    it.each(NEW_RPCS)("%s is SECURITY DEFINER, pins search_path, and EXECUTE is revoked from PUBLIC/anon/authenticated", (name) =>
      run(async (db) => {
        const procs = (await db.query("select oid, prosecdef, proconfig from pg_proc where pronamespace='public'::regnamespace and proname=$1", [name])).rows;
        expect(procs.length, `${name} must exist`).toBeGreaterThan(0);
        for (const p of procs) {
          expect(p.prosecdef).toBe(true);
          expect((p.proconfig ?? []).some((c: string) => c.startsWith("search_path="))).toBe(true);
          for (const role of ["anon", "authenticated"]) {
            expect((await one(db, "select has_function_privilege($1,$2::oid,'execute') as x", [role, p.oid])).x, `${role} may execute ${name}`).toBe(false);
          }
          expect((await one(db, "select exists(select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid=$1::oid and a.grantee=0 and a.privilege_type='EXECUTE') as x", [p.oid])).x, `PUBLIC may execute ${name}`).toBe(false);
          expect((await one(db, "select has_function_privilege('service_role',$1::oid,'execute') as x", [p.oid])).x).toBe(true);
        }
      }));

    it.each(NEW_RPCS)("%s refuses authenticated and anon callers", (name) =>
      run(async (db) => {
        const id = randomUUID();
        for (const role of ["authenticated", "anon"]) {
          const r = await tryAs(db, role, role, RPC_CALLS[name]!, [id]);
          expect(r.error?.code, `${role} -> ${name}`).toBe("42501");
        }
      }));

    it.each(NEW_RPCS)("%s rejects a non-service jwt in its body even for a privileged session", (name) =>
      run(async (db) => {
        const r = await tryAs(db, null, "authenticated", RPC_CALLS[name]!, [randomUUID()]);
        expect(r.error?.code, name).toBe("42501");
      }));

    it("norma_queue_control has no privileges for anon, authenticated or service_role, and no policies", () =>
      run(async (db) => {
        for (const role of ["anon", "authenticated", "service_role"]) {
          for (const priv of ["select", "insert", "update", "delete"]) {
            expect((await one(db, "select has_table_privilege($1,'public.norma_queue_control',$2) as x", [role, priv])).x, `${role} ${priv}`).toBe(false);
          }
        }
        expect(await count(db, "select count(*) as n from pg_policies where schemaname='public' and tablename='norma_queue_control'")).toBe(0);
      }));

    it("service_role cannot read or mutate norma_queue_control", () =>
      run(async (db) => {
        await setControl(db, false);
        expect((await tryAs(db, "service_role", "service_role", "select * from public.norma_queue_control")).error?.code).toBe("42501");
        expect((await tryAs(db, "service_role", "service_role", "update public.norma_queue_control set enabled=true")).error?.code).toBe("42501");
        expect((await one(db, "select enabled from public.norma_queue_control")).enabled).toBe(false);
      }));

    it("queue_entry_id on norma_call_requests is immutable", () =>
      run(async (db) => {
        const f = await inFlight(db);
        const other = await lead(db, f.ctx);
        const otherEntry = await enqueueOne(db, f.ctx, other);
        for (const target of [null, otherEntry]) {
          const r = await tryAs(db, null, "service_role", "update public.norma_call_requests set queue_entry_id=$2 where id=$1", [f.requestId, target]);
          expect(r.error, `re-pointing queue_entry_id to ${target}`).not.toBeNull();
        }
        expect((await requestOf(db, f.requestId)).queue_entry_id).toBe(f.entry);
      }));

    it("refuses a request linked to another org's entry (via create_v2 and via direct insert)", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const b = await newOrg(db);
        const fb = await inFlight(db, b);
        const la = await lead(db, a);
        const viaRpc = await svcErr(db, "select * from public.fn_norma_create_request_v2($1::uuid,$2::uuid,$3::text,$4::uuid,'ctx',$4::uuid,$5::uuid,$6::uuid)", [la.property, la.contact, la.phone, a.rep, fb.entry, fb.lease]);
        expect(viaRpc).not.toBeNull();
        const viaInsert = await tryAs(db, null, "service_role",
          "insert into public.norma_call_requests(org_id,property_id,contact_id,phone_e164,requested_by,callback_assignee_id,queue_entry_id) values ($1,$2,$3,$4,$5,$5,$6)",
          [a.org, la.property, la.contact, la.phone, a.rep, fb.entry]);
        expect(viaInsert.error).not.toBeNull();
        expect(await count(db, "select count(*) as n from public.norma_call_requests where property_id=$1", [la.property])).toBe(0);
      }));
  });

  // =========================================================================
  describe("zone parity [B16]", () => {
    it("norma_state_timezones rows equal STATE_TO_TZ exactly (same keys, same zones)", () =>
      run(async (db) => {
        const rows = (await db.query("select state, timezone from public.norma_state_timezones")).rows as Row[];
        const table = Object.fromEntries(rows.map((r) => [r.state as string, r.timezone as string]));
        expect(Object.keys(table).sort()).toEqual(Object.keys(STATE_TO_TZ).sort());
        expect(table).toEqual(STATE_TO_TZ);
      }));
  });

  // =========================================================================
  describe("enqueue (rule 1, rule 8, [C25]/[D12], Jarrad SMS decision)", () => {
    it("returns one result per lead, mixing queued and blocked, and inserts only the queued ones", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const good = await lead(db, ctx);
        const dead = await lead(db, ctx, { propStatus: "dead" });
        const good2 = await lead(db, ctx);
        const rows = await enqueueRaw(db, ctx, [good.property, dead.property, good2.property]);
        const by = Object.fromEntries(rows.map((r) => [r.property_id, r]));
        expect(rows).toHaveLength(3);
        expect(by[good.property]).toMatchObject({ result: "queued" });
        expect(by[dead.property]).toMatchObject({ result: "blocked", entry_id: null });
        expect(by[dead.property].reason).toBeTruthy();
        expect(by[good2.property]).toMatchObject({ result: "queued" });
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where org_id=$1", [ctx.org])).toBe(2);
      }));

    it("creates a queued phase-A entry with the requester, display zone from the property state, and next_attempt_at = the next window open", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx, { state: "MO" });
        const row = (await enqueueRaw(db, ctx, [l.property], ctx.rep, "wants cash"))[0]!; // wall clock: Mon 08:00 Chicago (closed)
        expect(row.result).toBe("queued");
        const e = await entryOf(db, row.entry_id);
        expect(e).toMatchObject({ status: "queued", phase: "A", display_tz: "America/Chicago", requested_by: ctx.rep, org_id: ctx.org, property_id: l.property, contact_id: l.contact });
        expect(await sameInstant(db, "norma_queue_entries", "next_attempt_at", row.entry_id, NEXT_OPEN)).toBe(true);
        // the function RETURNS the values it computed (the server action only passes them through)
        expect(row.display_tz).toBe("America/Chicago");
        expect(new Date(row.next_attempt_at as string).getTime()).toBe(new Date(NEXT_OPEN).getTime());
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where id=$1 and rep_context='wants cash'", [row.entry_id])).toBe(1);
      }));

    it.each([
      ["Sunday 11:00 local", V_SUNDAY],
      ["Saturday 19:31 local", V_SAT_1931],
      ["Saturday 19:30:00 local (half-open upper bound)", V_SAT_1930],
    ])("enqueued while the window is closed (%s): next_attempt_at is Monday 09:00 local", (_label, wall) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await setWall(db, wall);
        const row = (await enqueueRaw(db, ctx, [l.property]))[0]!;
        expect(row.result).toBe("queued");
        expect(await sameInstant(db, "norma_queue_entries", "next_attempt_at", row.entry_id, NEXT_OPEN)).toBe(true);
      }));

    it("is idempotent: enqueueing a live property again returns already_queued with the same entry", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const first = (await enqueueRaw(db, ctx, [l.property]))[0]!;
        const second = (await enqueueRaw(db, ctx, [l.property]))[0]!;
        expect(second).toMatchObject({ result: "already_queued", entry_id: first.entry_id });
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where property_id=$1", [l.property])).toBe(1);
      }));

    it("allows a fresh entry once the previous one is cancelled", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const first = (await enqueueRaw(db, ctx, [l.property]))[0]!;
        await cancelEntry(db, first.entry_id, ctx.rep);
        const again = (await enqueueRaw(db, ctx, [l.property]))[0]!;
        expect(again.result).toBe("queued");
        expect(again.entry_id).not.toBe(first.entry_id);
      }));

    it("enforces one live entry per property in the database", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await enqueueOne(db, ctx, l);
        const r = await tryAs(db, null, "service_role",
          "insert into public.norma_queue_entries(org_id,property_id,contact_id,requested_by,status,next_attempt_at,display_tz) values ($1,$2,$3,$4,'queued',now(),'America/Chicago')",
          [ctx.org, l.property, l.contact, ctx.rep]);
        expect(r.error?.code).toBe("23505");
      }));

    it.each(["requested", "needs_review"] as const)("refuses to enqueue a property that already has an open %s request", (status) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const id = await plainRequest(db, ctx, l);
        if (status === "needs_review") {
          expect(await claimV2(db, id, await dbNow(db))).toBe("claimed");
          expect(await bind(db, id, `call-${id}`)).toBe("bound");
          await svc(db, "select public.fn_norma_mark_needs_review($1::uuid,'t',1::integer)", [id]);
        }
        const row = (await enqueueRaw(db, ctx, [l.property]))[0]!;
        expect(row).toMatchObject({ result: "open_request", entry_id: null });
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where property_id=$1", [l.property])).toBe(0);
      }));

    const BLOCKED: [string, (db: Client, ctx: Ctx) => Promise<Lead>][] = [
      ["property status dead", (db, c) => lead(db, c, { propStatus: "dead" })],
      ["property status closed", (db, c) => lead(db, c, { propStatus: "closed" })],
      ["outreach_dispo not_interested", (db, c) => lead(db, c, { dispo: "not_interested" })],
      ["outreach_dispo wrong_number", (db, c) => lead(db, c, { dispo: "wrong_number" })],
      ["outreach_dispo bad_number", (db, c) => lead(db, c, { dispo: "bad_number" })],
      ["outreach_dispo dnc", (db, c) => lead(db, c, { dispo: "dnc" })],
      ["outreach_dispo opted_out", (db, c) => lead(db, c, { dispo: "opted_out" })],
      ["contact do_not_contact", (db, c) => lead(db, c, { doNotContact: true })],
      ["voice opt_out in consent_events", async (db, c) => { const l = await lead(db, c); await consent(db, c, l, "voice", "opt_out"); return l; }],
      ["voice provider_auto_opt_out in consent_events", async (db, c) => { const l = await lead(db, c); await consent(db, c, l, "voice", "provider_auto_opt_out"); return l; }],
      ["sms opt_out in consent_events (Jarrad: SMS opt-out blocks Norma)", async (db, c) => { const l = await lead(db, c); await consent(db, c, l, "sms", "opt_out"); return l; }],
      ["sms provider_auto_opt_out in consent_events", async (db, c) => { const l = await lead(db, c); await consent(db, c, l, "sms", "provider_auto_opt_out"); return l; }],
      ["no callable phone", (db, c) => lead(db, c, { noPhone: true })],
    ];
    it.each(BLOCKED)("blocks: %s", (_name, make) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await make(db, ctx);
        const row = (await enqueueRaw(db, ctx, [l.property]))[0]!;
        expect(row.result).toBe("blocked");
        expect(row.entry_id).toBeNull();
        expect(row.reason).toBeTruthy();
        expect((await svcOne(db, "select public.fn_norma_queue_block_reason($1::uuid) as r", [l.property])).r).toBe(row.reason);
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where property_id=$1", [l.property])).toBe(0);
      }));

    it("fn_norma_queue_block_reason is null for a clean lead", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        expect((await svcOne(db, "select public.fn_norma_queue_block_reason($1::uuid) as r", [l.property])).r).toBeNull();
      }));

    it("[ruling] blocked reasons reuse fn_norma_eligibility's own strings: enqueue reason and block_reason equal the source reason where eligibility refuses", () =>
      run(async (db) => {
        const HARD = new Set(["contact do_not_contact", "voice opt_out in consent_events", "sms opt_out in consent_events (Jarrad: SMS opt-out blocks Norma)"]);
        for (const [name, make] of BLOCKED) {
          const ctx = await newOrg(db);
          const l = await make(db, ctx);
          const elig = await eligibilityOf(db, l);
          if (HARD.has(name)) expect(elig.eligible, `${name}: eligibility must refuse`).toBe(false);
          if (!elig.eligible) {
            const row = (await enqueueRaw(db, ctx, [l.property]))[0]!;
            expect(row.reason, name).toBe(elig.block_reason);
            expect((await svcOne(db, "select public.fn_norma_queue_block_reason($1::uuid) as r", [l.property])).r, name).toBe(elig.block_reason);
          }
        }
      }));

    it.each(["contact do_not_contact", "voice opt_out", "sms opt_out"])("[ruling] a live entry's blocked_reason set by the %s trigger equals fn_norma_eligibility's reason", (kind) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        if (kind === "contact do_not_contact") await db.query("update public.contacts set do_not_contact=true where id=$1", [l.contact]);
        else await consent(db, ctx, l, kind.split(" ")[0]!, "opt_out");
        const elig = await eligibilityOf(db, l);
        expect(elig.eligible).toBe(false);
        expect((await entryOf(db, entry)).blocked_reason).toBe(elig.block_reason);
      }));

    it.each(["sms", "voice"])("%s consent uses latest-event precedence: a later opt-in re-allows", (channel) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await consent(db, ctx, l, channel, "opt_out", "now() - interval '2 days'");
        await consent(db, ctx, l, channel, "opt_in_confirmed", "now() - interval '1 day'");
        expect((await enqueueRaw(db, ctx, [l.property]))[0]!.result).toBe("queued");
      }));

    it("a later opt-out beats an earlier opt-in", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await consent(db, ctx, l, "sms", "opt_in_confirmed", "now() - interval '2 days'");
        await consent(db, ctx, l, "sms", "opt_out", "now() - interval '1 day'");
        expect((await enqueueRaw(db, ctx, [l.property]))[0]!.result).toBe("blocked");
      }));

    it("a help_request after an opt-out does not re-allow (help is informational, consent.ts)", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await consent(db, ctx, l, "sms", "opt_out", "now() - interval '2 days'");
        await consent(db, ctx, l, "sms", "help_request", "now() - interval '1 day'");
        expect((await enqueueRaw(db, ctx, [l.property]))[0]!.result).toBe("blocked");
      }));

    it("an unknown or missing property state is reported as unknown_state and not inserted", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx, { state: "ZZ" });
        const row = (await enqueueRaw(db, ctx, [l.property]))[0]!;
        expect(row).toMatchObject({ result: "unknown_state", entry_id: null });
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where property_id=$1", [l.property])).toBe(0);
      }));

    it.each(["no membership", "suspended membership"])("refuses a requester with %s and inserts nothing", (kind) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        let requester = randomUUID();
        await db.query("insert into auth.users(id) values ($1)", [requester]);
        if (kind === "suspended membership") {
          await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','suspended')", [requester, ctx.org]);
        }
        const err = await svcErr(db, "select * from public.fn_norma_queue_enqueue($1::uuid,$2::uuid,$3::uuid[],'ctx')", [ctx.org, requester, [l.property]]);
        expect(err?.message).toMatch(/requester_not_member/);
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where org_id=$1", [ctx.org])).toBe(0);
      }));

    it.todo("blocked_reason strings for queue-only causes (property status dead/closed, dispositions, no callable phone) that fn_norma_eligibility does not itself report are not fixed by the plan: needs Jarrad/Astra to approve the vocabulary before pinning");
    it.todo("enqueue chunk limit (<=200 property ids per call) is a server-action concern, not SQL: cover in the TS unit tests");
  });

  // =========================================================================
  describe("claim Tx1 (fn_norma_queue_claim, [C1])", () => {
    it("claims a due, in-window entry: calling, fresh tokens, 15-minute lease from p_now", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        const before = await entryOf(db, entry);
        const c = await claimTx1(db, entry, V_OPEN);
        expect(c).toMatchObject({ result: "claimed", entry_id: entry, property_id: l.property, contact_id: l.contact, phone_e164: l.phone, requested_by: ctx.rep });
        const e = await entryOf(db, entry);
        expect(e.status).toBe("calling");
        expect(e.lease_token).toBe(c.lease_token);
        expect(e.dispatch_token).toBe(c.dispatch_token);
        expect(e.lease_token).not.toBe(before.lease_token);
        expect((await one(db, "select extract(epoch from (lease_expires_at - $2::timestamptz))::int as s from public.norma_queue_entries where id=$1", [entry, V_OPEN])).s).toBe(900);
      }));

    it("does not claim an entry that is not yet due", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const entry = await enqueueOne(db, ctx, await lead(db, ctx));
        expect((await claimTx1(db, entry, V_NOT_DUE)).result).toBe("not_due");
        expect((await entryOf(db, entry)).status).toBe("queued");
      }));

    it("a second claim on an already-calling entry is not claimable", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const entry = await enqueueOne(db, ctx, await lead(db, ctx));
        expect((await claimTx1(db, entry, V_OPEN)).result).toBe("claimed");
        expect((await claimTx1(db, entry, V_OPEN)).result).toBe("not_claimable");
      }));

    it("returns disabled and stays queued when the queue flag is off", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const entry = await enqueueOne(db, ctx, await lead(db, ctx));
        expect((await claimTx1(db, entry, V_OPEN, false)).result).toBe("disabled");
        expect((await entryOf(db, entry)).status).toBe("queued");
      }));

    it.each([
      ["Sunday 11:00 local", V_SUNDAY, "window_closed"],
      ["Saturday 19:31 local", V_SAT_1931, "window_closed"],
      ["Saturday 19:30:00 local (upper bound excluded)", V_SAT_1930, "window_closed"],
      ["Saturday 19:29:59 local (last open second)", V_SAT_192959, "claimed"],
      ["Saturday 19:29 local", V_SAT_1929, "claimed"],
      ["Monday 08:59 local", V_MON_0859, "window_closed"],
      ["Monday 08:59:59 local", V_MON_085959, "window_closed"],
      ["Monday 09:00:00 local (lower bound included)", V_MON_0900, "claimed"],
      ["Monday 09:01 local", V_MON_0901, "claimed"],
    ])("window boundary, half-open [09:00, 19:30): %s -> %s", (_label, at, expected) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const entry = await enqueueOne(db, ctx, await lead(db, ctx));
        const c = await claimTx1(db, entry, at);
        expect(c.result).toBe(expected);
        const e = await entryOf(db, entry);
        if (expected === "window_closed") {
          expect(e.status).toBe("queued");
          expect(await count(db, "select count(*) as n from public.norma_queue_entries where id=$1 and next_attempt_at > $2::timestamptz", [entry, at])).toBe(1);
        } else {
          expect(e.status).toBe("calling");
        }
      }));

    it.each([
      ["19:29:59", V_SAT_192959, "claimed"],
      ["19:30:00", V_SAT_1930, "queue_refused"],
    ])("claim_dispatch_v2 uses the same half-open window at p_now %s -> %s", (_label, at, expected) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        const c = await claimTx1(db, entry, V_SAT_1929);
        const req = await createV2(db, l, ctx.rep, ctx.rep, entry, c.lease_token);
        const r = await claimV2(db, req.request_id, at);
        expect(expected === "claimed" ? r : r.split(":")[0]).toBe(expected);
      }));

    it("recomputes the zone from the CURRENT property state (state edited after enqueue)", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx, { state: "MO" });
        const entry = await enqueueOne(db, ctx, l);
        await db.query("update public.properties set state='HI' where id=$1", [l.property]); // Hawaii: 07:00 at V_OPEN
        expect((await claimTx1(db, entry, V_OPEN)).result).toBe("window_closed");
        expect((await entryOf(db, entry)).status).toBe("queued");
      }));

    it("create_v2 copies the entry's tokens, uses the requester as callback owner, and sets last_request_id", () =>
      run(async (db) => {
        const f = await inFlight(db);
        const r = await requestOf(db, f.requestId);
        expect(r).toMatchObject({ queue_entry_id: f.entry, queue_lease_token: f.lease, queue_dispatch_token: f.dispatch, callback_assignee_id: f.ctx.rep });
        expect((await entryOf(db, f.entry)).last_request_id).toBe(f.requestId);
      }));

    it("create_v2 refuses a stale lease token and creates no request", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await claimTx1(db, entry, V_OPEN);
        const err = await svcErr(db, "select * from public.fn_norma_create_request_v2($1::uuid,$2::uuid,$3::text,$4::uuid,'ctx',$4::uuid,$5::uuid,$6::uuid)", [l.property, l.contact, l.phone, ctx.rep, entry, randomUUID()]);
        expect(err).not.toBeNull();
        expect(await count(db, "select count(*) as n from public.norma_call_requests where property_id=$1", [l.property])).toBe(0);
      }));
    describe("[N2] rule-2 capacity_precheck (non-binding)", () => {
      /** A request from another org held in dispatching, optionally with a send marker today. */
      async function held(db: Client, marker: boolean) {
        const o = await newOrg(db);
        const id = await plainRequest(db, o, await lead(db, o));
        expect(await claimV2(db, id, V_OPEN)).toBe("claimed");
        if (marker) await stamp(db, id, V_OPEN);
        return id;
      }
      async function expectNothingCreated(db: Client, entry: string) {
        const e = await entryOf(db, entry);
        expect(e.status).toBe("queued");
        expect(e.lease_token).toBeNull();
        expect(await count(db, "select count(*) as n from public.norma_call_requests where queue_entry_id=$1", [entry])).toBe(0);
        expect(await attemptsOf(db, entry)).toHaveLength(0);
        // recomputed (PINNED): the stale backdated next_attempt_at is replaced by the scheduler slot at p_now
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where id=$1 and next_attempt_at >= $2::timestamptz", [entry, V_OPEN])).toBe(1);
      }
      it("at the concurrency cap: capacity_precheck, no request, entry stays queued with next_attempt_at recomputed, nothing counted", () =>
        run(async (db) => {
          await held(db, false);
          const ctx = await newOrg(db);
          const entry = await enqueueOne(db, ctx, await lead(db, ctx));
          expect((await claimTx1Cap(db, entry, V_OPEN, { maxC: 1 })).result).toBe("capacity_precheck");
          await expectNothingCreated(db, entry);
          expect((await claimTx1Cap(db, entry, V_OPEN, { maxC: 2 })).result).toBe("claimed"); // below the cap: non-binding check passes
        }));
      it("at the daily cap: capacity_precheck, nothing created or counted", () =>
        run(async (db) => {
          await held(db, true);
          const ctx = await newOrg(db);
          const entry = await enqueueOne(db, ctx, await lead(db, ctx));
          expect((await claimTx1Cap(db, entry, V_OPEN, { daily: 1 })).result).toBe("capacity_precheck");
          await expectNothingCreated(db, entry);
          expect((await claimTx1Cap(db, entry, V_OPEN, { daily: 2 })).result).toBe("claimed");
        }));
    });

    it("[rule 2] an open request on the property makes claim answer already_open: entry stays queued, nothing counted, no queue request created", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        const buttonId = (await svcOne(db, "select * from public.fn_norma_create_request($1::uuid,$2::uuid,$3::text,$4::uuid,'ctx',$5::uuid)", [l.property, l.contact, l.phone, ctx.rep, ctx.assignee])).request_id as string;
        const c = await claimTx1(db, entry, V_OPEN);
        expect(c.result).toBe("already_open");
        const e = await entryOf(db, entry);
        expect(e.status).toBe("queued");
        expect(e.next_attempt_at).not.toBeNull();
        expect(await attemptsOf(db, entry)).toHaveLength(0);
        expect(await count(db, "select count(*) as n from public.norma_call_requests where queue_entry_id=$1", [entry])).toBe(0);
        expect((await requestOf(db, buttonId)).status).toBe("requested");
      }));

    it("[B11] a requester who left the org after enqueue: claim answers blocked:requester_not_member and ends the entry", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await db.query("update public.memberships set access_status='suspended' where user_id=$1 and org_id=$2", [ctx.rep, ctx.org]);
        expect((await claimTx1(db, entry, V_OPEN)).result).toBe("blocked:requester_not_member");
        expect((await entryOf(db, entry)).status).toBe("done");
        expect(await count(db, "select count(*) as n from public.norma_call_requests where queue_entry_id=$1", [entry])).toBe(0);
      }));
  });

  // =========================================================================
  describe("dispatch admission: claim_dispatch_v2 ([C7], [D5], [E1], [E3], [C9])", () => {
    it("claims a queue request: dispatching with dispatch_started_at", () =>
      run(async (db) => {
        const f = await inFlight(db);
        const r = await requestOf(db, f.requestId);
        expect(r.status).toBe("dispatching");
        expect(r.dispatch_started_at).not.toBeNull();
      }));

    it("queue_refused when the queue flag is off; request stays requested", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        const c = await claimTx1(db, entry, V_OPEN);
        const req = await createV2(db, l, ctx.rep, ctx.rep, entry, c.lease_token);
        expect(await claimV2(db, req.request_id, V_OPEN, { enabled: false })).toMatch(/^queue_refused:/);
        expect((await requestOf(db, req.request_id)).status).toBe("requested");
      }));

    it("queue_refused when the window is closed at p_now", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        const c = await claimTx1(db, entry, V_OPEN);
        const req = await createV2(db, l, ctx.rep, ctx.rep, entry, c.lease_token);
        expect(await claimV2(db, req.request_id, V_SUNDAY)).toMatch(/^queue_refused:/);
        expect((await requestOf(db, req.request_id)).status).toBe("requested");
      }));

    it("queue_refused when the lease has expired at p_now", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        const c = await claimTx1(db, entry, V_OPEN);
        const req = await createV2(db, l, ctx.rep, ctx.rep, entry, c.lease_token);
        expect(await claimV2(db, req.request_id, "2030-01-07T17:16:00Z")).toMatch(/^queue_refused:/);
      }));

    it("queue_refused after the entry is paused (dispatch token rotated)", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        const c = await claimTx1(db, entry, V_OPEN);
        const req = await createV2(db, l, ctx.rep, ctx.rep, entry, c.lease_token);
        await pauseEntry(db, entry, ctx.rep);
        expect(await claimV2(db, req.request_id, V_OPEN)).toMatch(/^queue_refused:/);
      }));

    it("not_claimed when the request is not in requested", () =>
      run(async (db) => {
        const f = await inFlight(db);
        expect(await claimV2(db, f.requestId, V_OPEN)).toBe("not_claimed");
      }));

    it("legacy fn_norma_claim_dispatch(uuid) always returns false and writes nothing [E3]", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const id = await plainRequest(db, ctx, l);
        const before = await requestOf(db, id);
        expect((await svcOne(db, "select public.fn_norma_claim_dispatch($1::uuid) as c", [id])).c).toBe(false);
        expect((await svcOne(db, "select public.fn_norma_claim_dispatch($1::uuid, 1) as c", [id])).c).toBe(false);
        expect(await requestOf(db, id)).toEqual(before);
        expect(before.status).toBe("requested");
      }));

    it("legacy claim also returns false for a queue request and the catalog has exactly one (uuid, integer) overload", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        const c = await claimTx1(db, entry, V_OPEN);
        const req = await createV2(db, l, ctx.rep, ctx.rep, entry, c.lease_token);
        expect((await svcOne(db, "select public.fn_norma_claim_dispatch($1::uuid) as c", [req.request_id])).c).toBe(false);
        expect((await requestOf(db, req.request_id)).status).toBe("requested");
        const overloads = (await db.query("select pg_get_function_identity_arguments(oid) as a from pg_proc where pronamespace='public'::regnamespace and proname='fn_norma_claim_dispatch'")).rows;
        expect(overloads).toHaveLength(1);
        expect(overloads[0]!.a).toMatch(/uuid, \w+ integer|uuid, integer/);
      }));

    // ---- capacity ----------------------------------------------------------
    const OPEN_STATUSES = ["dispatching", "dispatched", "dispatch_unknown", "needs_review"] as const;
    async function holdInOrg(db: Client, ctx: Ctx, status: (typeof OPEN_STATUSES)[number], l?: Lead) {
      const lead1 = l ?? (await lead(db, ctx));
      const id = await plainRequest(db, ctx, lead1);
      expect(await claimV2(db, id, await dbNow(db))).toBe("claimed");
      if (status === "dispatched") expect(await bind(db, id, `call-${id}`)).toBe("bound");
      if (status === "dispatch_unknown") await svc(db, "select public.fn_norma_mark_dispatch_unknown($1::uuid,'t',1::integer)", [id]);
      if (status === "needs_review") await svc(db, "select public.fn_norma_mark_needs_review($1::uuid,'t',1::integer)", [id]);
      expect((await requestOf(db, id)).status).toBe(status);
      return { id, l: lead1 };
    }

    it.each(OPEN_STATUSES)("concurrency counts a %s request from ANOTHER org (provider-account-wide, [C7])", (status) =>
      run(async (db) => {
        const a = await newOrg(db);
        const b = await newOrg(db);
        await holdInOrg(db, b, status);
        const candidate = await plainRequest(db, a, await lead(db, a));
        expect(await claimV2(db, candidate, await dbNow(db), { maxC: 1 })).toBe("capacity_concurrency");
        expect((await requestOf(db, candidate)).status).toBe("requested");
        expect(await claimV2(db, candidate, await dbNow(db), { maxC: 2 })).toBe("claimed");
      }));

    it("does not count the candidate itself: limit 1 with nothing else open still claims", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const candidate = await plainRequest(db, a, await lead(db, a));
        expect(await claimV2(db, candidate, await dbNow(db), { maxC: 1 })).toBe("claimed");
      }));

    it("a completed or rejected request no longer holds a slot", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const done = await holdInOrg(db, a, "dispatched");
        await complete(db, done.id, `call-${done.id}`, "no_answer");
        const rejected = await holdInOrg(db, a, "dispatching");
        await svc(db, "select public.fn_norma_mark_dispatch_rejected($1::uuid,'t')", [rejected.id]);
        const candidate = await plainRequest(db, a, await lead(db, a));
        expect(await claimV2(db, candidate, await dbNow(db), { maxC: 1 })).toBe("claimed");
      }));

    it("an unresolved needs_review call older than 30 minutes still holds its slot [E1]", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const held = await holdInOrg(db, a, "needs_review");
        await db.query("update public.norma_call_requests set dispatch_started_at = now() - interval '2 hours' where id=$1", [held.id]);
        const candidate = await plainRequest(db, a, await lead(db, a));
        expect(await claimV2(db, candidate, await dbNow(db), { maxC: 1 })).toBe("capacity_concurrency");
      }));

    it("daily cap counts requests whose send_attempted_at is today and ignores older days", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const sent = await holdInOrg(db, a, "dispatched");
        await stamp(db, sent.id, await dbNow(db));
        await complete(db, sent.id, `call-${sent.id}`, "no_answer");
        const candidate = await plainRequest(db, a, await lead(db, a));
        expect(await claimV2(db, candidate, await dbNow(db), { daily: 1 })).toBe("capacity_daily");
        expect(await claimV2(db, candidate, await dbNow(db), { daily: 2 })).toBe("claimed");
      }));

    it("daily cap does not count a send from two days ago", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const sent = await holdInOrg(db, a, "dispatched");
        await db.query("update public.norma_call_requests set send_attempted_at = now() - interval '2 days' where id=$1", [sent.id]);
        await complete(db, sent.id, `call-${sent.id}`, "no_answer");
        const candidate = await plainRequest(db, a, await lead(db, a));
        expect(await claimV2(db, candidate, await dbNow(db), { daily: 1 })).toBe("claimed");
      }));

    // ---- number ownership ----------------------------------------------------
    it.each(OPEN_STATUSES)("number_busy while another request on the same phone is %s ([C9], [D5])", (status) =>
      run(async (db) => {
        const a = await newOrg(db);
        const first = await lead(db, a);
        const second = await lead(db, a, { sameContactAs: first });
        await holdInOrg(db, a, status, first);
        const candidate = await plainRequest(db, a, second);
        expect(await claimV2(db, candidate, await dbNow(db))).toBe("number_busy");
        expect((await requestOf(db, candidate)).status).toBe("requested");
      }));

    it("number_busy within 10 s of a send on the same number; free after the gap", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const first = await lead(db, a);
        const second = await lead(db, a, { sameContactAs: first });
        const sent = await holdInOrg(db, a, "dispatched", first);
        await complete(db, sent.id, `call-${sent.id}`, "no_answer");
        await db.query("update public.norma_call_requests set send_attempted_at = now() - interval '3 seconds' where id=$1", [sent.id]);
        const candidate = await plainRequest(db, a, second);
        expect(await claimV2(db, candidate, await dbNow(db))).toBe("number_busy");
        await db.query("update public.norma_call_requests set send_attempted_at = now() - interval '30 seconds' where id=$1", [sent.id]);
        expect(await claimV2(db, candidate, await dbNow(db))).toBe("claimed");
      }));

    it("[C8] 'today' is the day of p_now in the cap timezone (not the database day)", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const sent = await holdInOrg(db, a, "dispatched");
        await stamp(db, sent.id, "2030-01-07T18:00:00Z"); // Mon 12:00 Chicago
        await complete(db, sent.id, `call-${sent.id}`, "no_answer");
        const candidate = await plainRequest(db, a, await lead(db, a));
        expect(await claimV2(db, candidate, "2030-01-07T20:00:00Z", { daily: 1 })).toBe("capacity_daily"); // same Chicago day
        expect(await claimV2(db, candidate, "2030-01-08T20:00:00Z", { daily: 1 })).toBe("claimed"); // next Chicago day
      }));

    it("[C8] pre-midnight claim with a post-midnight uncertain send counts in the post-midnight day", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const held = await holdInOrg(db, a, "dispatching"); // claimed, no send marker yet
        const candidate = await plainRequest(db, a, await lead(db, a));
        const POST_MIDNIGHT = "2030-01-08T06:30:00Z"; // Tue 00:30 Chicago
        // a still-dispatching row without a marker counts toward the day it may send in (today = p_now's day)
        expect(await claimV2(db, candidate, POST_MIDNIGHT, { daily: 1 })).toBe("capacity_daily");
        // uncertain send marked AFTER midnight -> counts in the post-midnight day
        await stamp(db, held.id, "2030-01-08T06:10:00Z");
        await svc(db, "select public.fn_norma_mark_dispatch_unknown($1::uuid,'t',1::integer)", [held.id]);
        expect(await claimV2(db, candidate, POST_MIDNIGHT, { daily: 1 })).toBe("capacity_daily");
        // the same row marked BEFORE midnight (Mon 23:50 Chicago) belongs to the previous day
        await stamp(db, held.id, "2030-01-08T05:50:00Z");
        expect(await claimV2(db, candidate, POST_MIDNIGHT, { daily: 1 })).toBe("claimed");
      }));


    it("[G1c] no second request on the same number is admitted while an earlier one sits in needs_review; the legacy v1 claim stays false", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const first = await lead(db, a);
        const second = await lead(db, a, { sameContactAs: first });
        await holdInOrg(db, a, "needs_review", first);
        const candidate = await plainRequest(db, a, second);
        expect(await claimV2(db, candidate, await dbNow(db))).toBe("number_busy");
        expect((await svcOne(db, "select public.fn_norma_claim_dispatch($1::uuid) as c", [candidate])).c).toBe(false);
        expect((await requestOf(db, candidate)).status).toBe("requested");
      }));

    it("[G1d] a late completion BEFORE review applies its outcome to the original request, entry and attempt", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await escalate(db, f.requestId);
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "paused", pause_reason: "needs_review" });
        const res = await complete(db, f.requestId, "call-g1d", "callback_requested", { callback_raw: "monday" });
        expect(res.result).not.toBe("replayed");
        expect(await requestOf(db, f.requestId)).toMatchObject({ status: "completed", outcome: "callback_requested" });
        expect((await entryOf(db, f.entry)).status).toBe("done");
        expect((await attemptsOf(db, f.entry))[0]).toMatchObject({ resolution: "final", outcome: "callback_requested" });
      }));

    it("[G1e] a late completion AFTER review is answered replayed and changes nothing (no second settlement)", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await escalate(db, f.requestId);
        await markReviewed(db, f.requestId, f.l.property, f.ctx.rep);
        expect(await requestOf(db, f.requestId)).toMatchObject({ status: "completed", outcome: "reviewed" });
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "paused", pause_reason: "reviewed" });
        const entryBefore = await entryOf(db, f.entry);
        const attemptsBefore = await attemptsOf(db, f.entry);
        const res = await complete(db, f.requestId, "call-g1e", "callback_requested", { callback_raw: "monday" });
        expect(res).toMatchObject({ result: "replayed", status: "completed", outcome: "reviewed" });
        expect(await requestOf(db, f.requestId)).toMatchObject({ status: "completed", outcome: "reviewed" });
        expect(await entryOf(db, f.entry)).toEqual(entryBefore);
        expect(await attemptsOf(db, f.entry)).toEqual(attemptsBefore);
      }));
  });

  // =========================================================================
  describe("send-time admission: fn_norma_mark_sending ([C5], [D10], [E2], [E6], [H1], [C9])", () => {
    type Ready = { ctx: Ctx; l: Lead; entry: string; requestId: string; dispatch: string };
    /**
     * Queue request claimed at `claimAt` (entry claim + create + dispatch claim, all at p_now = claimAt), control row ON,
     * SQL wall clock pinned to `wall` (default claimAt). Entries are made due by backdating next_attempt_at in enqueueOne.
     */
    async function ready(db: Client, o: { state?: string; claimAt?: string; wall?: string } = {}): Promise<Ready> {
      const claimAt = o.claimAt ?? V_OPEN;
      const ctx = await newOrg(db);
      const l = await lead(db, ctx, { state: o.state ?? "MO" });
      const entry = await enqueueOne(db, ctx, l);
      const c = await claimTx1(db, entry, claimAt);
      expect(c.result).toBe("claimed");
      const req = await createV2(db, l, ctx.rep, ctx.rep, entry, c.lease_token);
      expect(await claimV2(db, req.request_id, claimAt)).toBe("claimed");
      await setControl(db, true);
      await setWall(db, o.wall ?? claimAt);
      return { ctx, l, entry, requestId: req.request_id as string, dispatch: c.dispatch_token as string };
    }
    async function expectRefused(db: Client, x: Ready, rotated: boolean) {
      expect(await markSending(db, x.requestId, x.dispatch)).toMatch(/^refused:/);
      const r = await requestOf(db, x.requestId);
      expect(r).toMatchObject({ status: "dispatch_rejected", send_attempted_at: null });
      expect(r.dispatch_error).toBeTruthy();
      expect(await attemptsOf(db, x.entry)).toHaveLength(0);
      if (rotated) expect((await entryOf(db, x.entry)).dispatch_token).not.toBe(r.queue_dispatch_token);
    }
    /** Button request (no queue entry) claimed at V_OPEN, wall clock pinned to `wall`. */
    async function buttonReady(db: Client, wall = V_OPEN) {
      const ctx = await newOrg(db);
      const l = await lead(db, ctx);
      const id = await plainRequest(db, ctx, l);
      expect(await claimV2(db, id, V_OPEN)).toBe("claimed");
      await setWall(db, wall);
      return { ctx, l, id };
    }

    it("baseline: admits the send, returns sending and stamps send_attempted_at with the single wall-clock reading", () =>
      run(async (db) => {
        const x = await ready(db);
        expect(await markSending(db, x.requestId, x.dispatch)).toBe("sending");
        expect(await sameInstant(db, "norma_call_requests", "send_attempted_at", x.requestId, V_OPEN)).toBe(true);
        expect((await requestOf(db, x.requestId)).status).toBe("dispatching");
      }));

    it("refuses after Pause", () =>
      run(async (db) => {
        const x = await ready(db);
        await pauseEntry(db, x.entry, x.ctx.rep);
        await expectRefused(db, x, true);
      }));

    it("refuses after Cancel", () =>
      run(async (db) => {
        const x = await ready(db);
        await cancelEntry(db, x.entry, x.ctx.rep);
        await expectRefused(db, x, true);
      }));

    it("refuses after an inbound reply parks the entry", () =>
      run(async (db) => {
        const x = await ready(db);
        await inboundMessage(db, x.ctx, x.l);
        expect((await entryOf(db, x.entry)).pause_reason).toBe("inbound_reply");
        await expectRefused(db, x, true);
      }));

    it.each([
      ["property status dead", "update public.properties set status='dead' where id=$1"],
      ["outreach_dispo dnc", "update public.properties set outreach_dispo='dnc' where id=$1"],
    ])("refuses after a block: %s", (_n, sql) =>
      run(async (db) => {
        const x = await ready(db);
        await db.query(sql, [x.l.property]);
        await expectRefused(db, x, true);
      }));

    it.each(["voice", "sms"])("[D10] refuses when a %s opt-out lands in consent_events between claim_v2 and mark_sending", (channel) =>
      run(async (db) => {
        const x = await ready(db);
        await consent(db, x.ctx, x.l, channel, "opt_out");
        await expectRefused(db, x, true);
      }));

    it("refuses when the queue control row is OFF", () =>
      run(async (db) => {
        const x = await ready(db);
        await setControl(db, false);
        await expectRefused(db, x, false);
      }));

    it("refuses when the queue control row is missing (missing = OFF)", () =>
      run(async (db) => {
        const x = await ready(db);
        await setControl(db, null);
        await expectRefused(db, x, false);
      }));

    it("refuses a stale dispatch token passed by the runtime", () =>
      run(async (db) => {
        const x = await ready(db);
        expect(await markSending(db, x.requestId, randomUUID())).toMatch(/^refused:/);
        expect((await requestOf(db, x.requestId)).send_attempted_at).toBeNull();
      }));

    it.each([
      ["19:29:59 (last open second)", V_SAT_192959, "sending"],
      ["19:30:00 (half-open upper bound)", V_SAT_1930, "refused"],
      ["19:31:00", V_SAT_1931, "refused"],
    ])("wall-clock window at mark_sending, claim at Sat 19:29 local: %s -> %s", (_label, wall, expected) =>
      run(async (db) => {
        const x = await ready(db, { claimAt: V_SAT_1929, wall });
        if (expected === "sending") {
          expect(await markSending(db, x.requestId, x.dispatch)).toBe("sending");
        } else {
          await expectRefused(db, x, false);
        }
      }));

    it("wall-clock window uses the CURRENT property zone (state edited after claim)", () =>
      run(async (db) => {
        const x = await ready(db);
        await db.query("update public.properties set state='HI' where id=$1", [x.l.property]); // 07:00 in Hawaii at V_OPEN
        await expectRefused(db, x, false);
      }));

    // ---- [H1] the 90 s freshness the presend fence used to enforce ----------------------------------------
    it("[H1] queue row: admits within 90 s of the dispatch claim and touches updated_at", () =>
      run(async (db) => {
        const x = await ready(db, { wall: plusSeconds(V_OPEN, 89) });
        await ownerWrite(db, "update public.norma_call_requests set updated_at='2000-01-01T00:00:00Z' where id=$1", [x.requestId]);
        expect(await markSending(db, x.requestId, x.dispatch)).toBe("sending");
        expect((await one(db, "select updated_at > '2000-01-01T00:00:00Z'::timestamptz as moved from public.norma_call_requests where id=$1", [x.requestId])).moved).toBe(true);
      }));

    it("[H1] queue row: refused once dispatch_started_at is older than 90 s -> dispatch_rejected, nothing sent", () =>
      run(async (db) => {
        const x = await ready(db, { wall: plusSeconds(V_OPEN, 91) });
        await expectRefused(db, x, false);
      }));

    it("[H1] button row: admits within 90 s with no token and no queue control row", () =>
      run(async (db) => {
        const x = await buttonReady(db, plusSeconds(V_OPEN, 30));
        expect(await markSending(db, x.id, null)).toBe("sending");
        expect(await sameInstant(db, "norma_call_requests", "send_attempted_at", x.id, plusSeconds(V_OPEN, 30))).toBe(true);
      }));

    it("[H1] button row: a stale refusal leaves the row dispatching (maps to not_claimed), never dispatch_rejected", () =>
      run(async (db) => {
        const x = await buttonReady(db, plusSeconds(V_OPEN, 91));
        expect(await markSending(db, x.id, null)).toMatch(/^refused:/);
        expect(await requestOf(db, x.id)).toMatchObject({ status: "dispatching", send_attempted_at: null });
      }));

    // ---- stalled worker ([C9]) -------------------------------------------------------------------------------
    it("[C9] after reconcile turns a stalled dispatching row into dispatch_unknown, the stalled worker's mark_sending is refused and the row is untouched", () =>
      run(async (db) => {
        const x = await ready(db);
        await svc(db, "select public.fn_norma_mark_dispatch_unknown($1::uuid,'stalled',1::integer)", [x.requestId]);
        expect(await markSending(db, x.requestId, x.dispatch)).toMatch(/^refused:/);
        expect(await requestOf(db, x.requestId)).toMatchObject({ status: "dispatch_unknown", send_attempted_at: null });
      }));

    // ---- [B4] button rows: eligibility/consent refusals CLOSE the request; fence-type refusals leave it dispatching ----
    it.each(["voice", "sms"])("[B4] a button row refused at mark_sending because a %s opt-out arrived after the claim is closed dispatch_rejected with ineligible:<eligibility reason>", (channel) =>
      run(async (db) => {
        const x = await buttonReady(db);
        await consent(db, x.ctx, x.l, channel, "opt_out");
        const elig = await eligibilityOf(db, x.l);
        expect(elig.eligible).toBe(false);
        expect(await markSending(db, x.id, null)).toMatch(/^refused:/);
        expect(await requestOf(db, x.id)).toMatchObject({ status: "dispatch_rejected", send_attempted_at: null, dispatch_error: `ineligible:${elig.block_reason}` });
      }));

    it("[B4] a button row refused because the contact became do_not_contact is closed dispatch_rejected with ineligible:<reason>", () =>
      run(async (db) => {
        const x = await buttonReady(db);
        await db.query("update public.contacts set do_not_contact=true where id=$1", [x.l.contact]);
        const elig = await eligibilityOf(db, x.l);
        expect(elig.eligible).toBe(false);
        expect(await markSending(db, x.id, null)).toMatch(/^refused:/);
        expect(await requestOf(db, x.id)).toMatchObject({ status: "dispatch_rejected", send_attempted_at: null, dispatch_error: `ineligible:${elig.block_reason}` });
      }));

    it("[B4/H1] a button row refused for a fence-type reason (not dispatching any more) is left exactly as it was", () =>
      run(async (db) => {
        const x = await buttonReady(db);
        await svc(db, "select public.fn_norma_mark_dispatch_unknown($1::uuid,'stalled',1::integer)", [x.id]);
        const before = await requestOf(db, x.id);
        expect(await markSending(db, x.id, null)).toMatch(/^refused:/);
        expect(await requestOf(db, x.id)).toEqual(before);
        expect(before.status).toBe("dispatch_unknown");
      }));

    it("[B4] queue rows: EVERY refusal closes the request dispatch_rejected, including an eligibility refusal", () =>
      run(async (db) => {
        const x = await ready(db);
        await consent(db, x.ctx, x.l, "sms", "opt_out");
        expect(await markSending(db, x.requestId, x.dispatch)).toMatch(/^refused:/);
        expect(await requestOf(db, x.requestId)).toMatchObject({ status: "dispatch_rejected", send_attempted_at: null });
      }));

    // ---- refusal vocabulary (contract 4, mark_sending) ------------------------------------------------------
    const FENCE = /^refused:(stale_claim|not_dispatching|lease_mismatch|lease_expired|token_rotated)$/;
    const ADMISSION = /^refused:(window_closed|queue_disabled|control_off|blocked)$/;
    it("refusal vocabulary: fence-type reasons", () =>
      run(async (db) => {
        const stale = await ready(db, { wall: plusSeconds(V_OPEN, 91) });
        expect(await markSending(db, stale.requestId, stale.dispatch)).toMatch(/^refused:stale_claim$/);
        const notDisp = await ready(db);
        await svc(db, "select public.fn_norma_mark_dispatch_unknown($1::uuid,'t',1::integer)", [notDisp.requestId]);
        expect(await markSending(db, notDisp.requestId, notDisp.dispatch)).toMatch(/^refused:not_dispatching$/);
        const rotated = await ready(db);
        await pauseEntry(db, rotated.entry, rotated.ctx.rep);
        expect(await markSending(db, rotated.requestId, rotated.dispatch)).toMatch(FENCE);
        const mismatch = await ready(db);
        expect(await markSending(db, mismatch.requestId, randomUUID())).toMatch(FENCE);
        const expired = await ready(db, { wall: plusSeconds(V_OPEN, 80) });
        await ownerWrite(db, "update public.norma_queue_entries set lease_expires_at=$2::timestamptz where id=$1", [expired.entry, plusSeconds(V_OPEN, 10)]);
        expect(await markSending(db, expired.requestId, expired.dispatch)).toMatch(/^refused:lease_expired$/);
      }));
    it("refusal vocabulary: admission reasons (window_closed, control_off, blocked) and queue_disabled for a missing control row", () =>
      run(async (db) => {
        const w = await ready(db, { claimAt: V_SAT_1929, wall: V_SAT_1930 });
        expect(await markSending(db, w.requestId, w.dispatch)).toBe("refused:window_closed");
        const off = await ready(db);
        await setControl(db, false);
        expect(await markSending(db, off.requestId, off.dispatch)).toBe("refused:control_off");
        const blocked = await ready(db);
        await db.query("update public.properties set status='dead' where id=$1", [blocked.l.property]);
        const br = await markSending(db, blocked.requestId, blocked.dispatch); // a block also rotates the dispatch token, so either vocabulary entry may fire first
        expect(br.match(ADMISSION) ?? br.match(FENCE)).not.toBeNull();
        const missing = await ready(db);
        await setControl(db, null);
        expect(await markSending(db, missing.requestId, missing.dispatch)).toMatch(/^refused:(control_off|queue_disabled)$/);
      }));
    it("refusal vocabulary: an eligibility refusal reads refused:ineligible:<reason>", () =>
      run(async (db) => {
        const x = await buttonReady(db);
        await db.query("update public.contacts set do_not_contact=true where id=$1", [x.l.contact]);
        const elig = await eligibilityOf(db, x.l);
        expect(await markSending(db, x.id, null)).toBe(`refused:ineligible:${elig.block_reason}`);
      }));

  });

  // =========================================================================
  describe("settlement matrix: fn_norma_queue_settle (rule 5, [C22], [E4], [F6], [B20])", () => {
    const STARTS: Start[] = ["queued", "calling", "paused", "done", "cancelled"];
    const OUTCOMES = ["no_answer", "callback_requested", "reached_no_callback", "not_interested", "wrong_number", "unknown", "reviewed"] as const;
    const TERMINAL = new Set(["callback_requested", "reached_no_callback", "not_interested", "wrong_number"]);
    type Expect = { status: string; pause_reason?: string };
    function expected(start: Start, outcome: (typeof OUTCOMES)[number]): Expect {
      if (start === "done" || start === "cancelled") return { status: start }; // absorbing wins
      if (TERMINAL.has(outcome)) return { status: "done" }; // terminal outcome, even if paused
      // no_answer: calling -> queued at the next slot; paused stays paused; a queued entry with a call still in flight
      // records the attempt, stays queued and has its slot recomputed (engineering resolution, no business rule added).
      // [N6] a paused entry keeps its pause_reason (rep_paused here) except that review resolution sets 'reviewed'.
      if (outcome === "no_answer") return start === "paused" ? { status: "paused", pause_reason: "rep_paused" } : { status: "queued" };
      if (start === "paused") return outcome === "reviewed" ? { status: "paused", pause_reason: "reviewed" } : { status: "paused", pause_reason: "rep_paused" };
      return { status: "paused", pause_reason: outcome === "unknown" ? "needs_review" : "reviewed" };
    }

    for (const start of STARTS) {
      for (const outcome of OUTCOMES) {
        const exp = expected(start, outcome);
        it(`entry ${start} + ${outcome} -> ${exp.status}${exp.pause_reason ? `/${exp.pause_reason}` : ""}, one attempt recorded`, () =>
          run(async (db) => {
            const f = await inFlightSent(db); // send marker at V_OPEN (Mon 11:00 Chicago), wall clock V_OPEN
            await putEntryIn(db, f, start);
            const source = outcome === "reviewed" ? "reviewed" : "webhook";
            await settle(db, f.requestId, outcome, source);
            const e = await entryOf(db, f.entry);
            expect(e.status).toBe(exp.status);
            if (exp.pause_reason) expect(e.pause_reason).toBe(exp.pause_reason);
            if ((start === "calling" || start === "queued") && outcome === "no_answer") {
              // 11:00 local send (A_am) -> next send >= 3 h later, inside A_pm [14:00,19:30): exactly 14:00 local the same day
              expect(await sameInstant(db, "norma_queue_entries", "next_attempt_at", f.entry, AFTER_11AM_SEND), "next_attempt_at").toBe(true);
              expect(e.phase).toBe("A");
            }
            const attempts = await attemptsOf(db, f.entry);
            expect(attempts).toHaveLength(1);
            expect(attempts[0]).toMatchObject({ request_id: f.requestId, outcome, resolution: outcome === "unknown" ? "pending" : "final", slot: "A_am" });
            expect(await count(db, "select count(*) as n from public.norma_queue_attempts where id=$1 and local_date = date '2030-01-07'", [attempts[0]!.id])).toBe(1);
            if (outcome !== "unknown") expect(attempts[0]!.final_source).toBe(source);
          }));
      }
    }

    it.each(OUTCOMES)("no attempts row when send_attempted_at is not set (%s) [F6]", (outcome) =>
      run(async (db) => {
        const f = await inFlight(db); // no send marker
        await settle(db, f.requestId, outcome, outcome === "reviewed" ? "reviewed" : "reconcile");
        expect(await attemptsOf(db, f.entry)).toHaveLength(0);
      }));

    it("[F6] unmarked request that escalates to unknown parks the entry paused/needs_review with no attempt", () =>
      run(async (db) => {
        const f = await inFlight(db);
        await settle(db, f.requestId, "unknown", "reconcile");
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "paused", pause_reason: "needs_review" });
        expect(await attemptsOf(db, f.entry)).toHaveLength(0);
      }));

    it("[F6] an unmarked (no send_attempted_at) no_answer settles with no attempts row AND the entry requeues, cadence unchanged", () =>
      run(async (db) => {
        const f = await inFlight(db); // calling, request dispatching, no send marker
        await settle(db, f.requestId, "no_answer", "reconcile");
        expect(await attemptsOf(db, f.entry)).toHaveLength(0);
        const e = await entryOf(db, f.entry);
        expect(e).toMatchObject({ status: "queued", phase: "A" });
        expect(e.next_attempt_at).not.toBeNull();
        expect((await one(db, "select phase_dates_used, phase_c_count from public.norma_queue_entries where id=$1", [f.entry]))).toMatchObject({ phase_dates_used: 0, phase_c_count: 0 });
      }));

    it("unknown on an entry already paused/rep_paused keeps pause_reason rep_paused (the attempt is still recorded pending)", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        expect(await pauseEntry(db, f.entry, f.ctx.rep)).toBe("paused");
        await settle(db, f.requestId, "unknown", "reconcile");
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "paused", pause_reason: "rep_paused" });
        expect((await attemptsOf(db, f.entry))[0]).toMatchObject({ resolution: "pending" });
      }));

    it("a second final settlement is a no-op (different outcome does not change the attempt or the entry)", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await settle(db, f.requestId, "no_answer");
        const afterFirst = await entryOf(db, f.entry);
        await settle(db, f.requestId, "callback_requested");
        expect(await entryOf(db, f.entry)).toEqual(afterFirst);
        const attempts = await attemptsOf(db, f.entry);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ outcome: "no_answer", resolution: "final" });
      }));

    it("replaying the same final settlement does not advance the schedule or duplicate the attempt", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await settle(db, f.requestId, "no_answer");
        const first = await entryOf(db, f.entry);
        await settle(db, f.requestId, "no_answer");
        expect(await entryOf(db, f.entry)).toEqual(first);
        expect(await attemptsOf(db, f.entry)).toHaveLength(1);
      }));

    it("a pending (unknown) attempt is resolved by a later outcome, which also moves the entry", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await settle(db, f.requestId, "unknown", "reconcile");
        expect((await attemptsOf(db, f.entry))[0]).toMatchObject({ resolution: "pending" });
        await settle(db, f.requestId, "callback_requested", "webhook");
        expect((await attemptsOf(db, f.entry))[0]).toMatchObject({ resolution: "final", outcome: "callback_requested" });
        expect((await entryOf(db, f.entry)).status).toBe("done");
      }));

    it("locates the entry by queue_entry_id even after dispatch_token rotation [E4]", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await pauseEntry(db, f.entry, f.ctx.rep);
        expect((await entryOf(db, f.entry)).dispatch_token).not.toBe((await requestOf(db, f.requestId)).queue_dispatch_token);
        await settle(db, f.requestId, "callback_requested");
        expect((await entryOf(db, f.entry)).status).toBe("done");
        expect(await attemptsOf(db, f.entry)).toHaveLength(1);
      }));

    it("[E4] send -> Pause -> callback completion -> done, and Resume is refused", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        expect(await bind(db, f.requestId, "call-e4a")).toBe("bound");
        await pauseEntry(db, f.entry, f.ctx.rep);
        await complete(db, f.requestId, "call-e4a", "callback_requested", { callback_raw: "tomorrow" });
        expect((await entryOf(db, f.entry)).status).toBe("done");
        expect(await resumeEntry(db, f.entry, f.ctx.rep)).toMatch(/^refused:/);
        expect((await entryOf(db, f.entry)).status).toBe("done");
      }));

    it("[E4] send -> inbound reply -> no_answer completion -> stays paused, attempt counted, Resume schedules the next slot", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        expect(await bind(db, f.requestId, "call-e4b")).toBe("bound");
        await inboundMessage(db, f.ctx, f.l);
        expect((await entryOf(db, f.entry)).pause_reason).toBe("inbound_reply");
        await complete(db, f.requestId, "call-e4b", "no_answer");
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
        expect(await attemptsOf(db, f.entry)).toHaveLength(1);
        expect(await resumeEntry(db, f.entry, f.ctx.rep, V_OPEN)).toBe("resumed");
        const e = await entryOf(db, f.entry);
        expect(e.status).toBe("queued");
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where id=$1 and next_attempt_at > $2::timestamptz", [f.entry, V_OPEN])).toBe(1);
      }));

    it("retry admission ON: a queue row's no_answer is settled by the queue, never rescheduled as attempt 2", () =>
      run(async (db) => {
        await db.query("update public.norma_retry_admission set enabled=true where singleton=true");
        const f = await inFlightSent(db);
        expect(await bind(db, f.requestId, "call-noretry")).toBe("bound");
        const res = await complete(db, f.requestId, "call-noretry", "no_answer");
        expect(res.retry).toBeUndefined();
        expect(res.status).not.toBe("requested");
        const req = (await svcOne(db, "select status, attempt, first_bland_call_id from public.norma_call_requests where id=$1", [f.requestId]));
        expect(req).toMatchObject({ status: "completed", attempt: 1, first_bland_call_id: null });
        expect((await entryOf(db, f.entry)).status).toBe("queued");
        expect(await attemptsOf(db, f.entry)).toHaveLength(1);
      }));

    it("[E4] send -> Cancel -> completion -> attempt finalised, entry stays cancelled", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        expect(await bind(db, f.requestId, "call-e4c")).toBe("bound");
        await cancelEntry(db, f.entry, f.ctx.rep);
        await complete(db, f.requestId, "call-e4c", "no_answer");
        expect((await entryOf(db, f.entry)).status).toBe("cancelled");
        expect((await attemptsOf(db, f.entry))[0]).toMatchObject({ resolution: "final", outcome: "no_answer" });
      }));

    it("completion (webhook path) settles through the same function: callback on a calling entry ends it and finalises the attempt", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        expect(await bind(db, f.requestId, "call-hook")).toBe("bound");
        await complete(db, f.requestId, "call-hook", "callback_requested", { callback_raw: "monday" });
        expect((await entryOf(db, f.entry)).status).toBe("done");
        expect((await attemptsOf(db, f.entry))[0]).toMatchObject({ resolution: "final", outcome: "callback_requested", final_source: "webhook" });
      }));

    // ---- button request on the same property ---------------------------------
    async function buttonOnQueuedProperty(db: Client, paused: boolean) {
      const ctx = await newOrg(db);
      const l = await lead(db, ctx);
      const entry = await enqueueOne(db, ctx, l);
      if (paused) await pauseEntry(db, entry, ctx.rep);
      const id = (await svcOne(db, "select * from public.fn_norma_create_request($1::uuid,$2::uuid,$3::text,$4::uuid,'ctx',$5::uuid)", [l.property, l.contact, l.phone, ctx.rep, ctx.assignee])).request_id as string;
      expect((await requestOf(db, id)).queue_entry_id).toBeNull();
      return { ctx, entry, id };
    }
    it.each([false, true])("a button request's terminal outcome ends a live entry (paused=%s)", (paused) =>
      run(async (db) => {
        const x = await buttonOnQueuedProperty(db, paused);
        await settle(db, x.id, "callback_requested");
        expect((await entryOf(db, x.entry)).status).toBe("done");
      }));
    it.each(["no_answer", "unknown", "reviewed"])("a button request's %s outcome does not change the entry", (outcome) =>
      run(async (db) => {
        const x = await buttonOnQueuedProperty(db, false);
        const before = await entryOf(db, x.entry);
        await settle(db, x.id, outcome, outcome === "reviewed" ? "reviewed" : "webhook");
        expect(await entryOf(db, x.entry)).toEqual(before);
      }));

    it.each(["no_answer", "callback_requested", "unknown", "reviewed"])("[rule 5] a button send never writes the queue attempts ledger (full send path, %s)", (outcome) =>
      run(async (db) => {
        const x = await buttonOnQueuedProperty(db, false);
        expect(await claimV2(db, x.id, V_OPEN)).toBe("claimed");
        await setWall(db, V_OPEN);
        expect(await markSending(db, x.id, null)).toBe("sending");
        expect(await bind(db, x.id, `call-btn-${outcome}`)).toBe("bound");
        if (outcome === "no_answer" || outcome === "callback_requested") await complete(db, x.id, `call-btn-${outcome}`, outcome, { callback_raw: "monday" });
        else await settle(db, x.id, outcome, outcome === "reviewed" ? "reviewed" : "webhook");
        expect(await attemptsOf(db, x.entry)).toHaveLength(0);
        expect(await count(db, "select count(*) as n from public.norma_queue_attempts where request_id=$1", [x.id])).toBe(0);
      }));

    // ---- blocks ---------------------------------------------------------------
    it.each(["no_answer", "unknown", "reviewed", "callback_requested"])("block on a calling entry then %s settlement -> done regardless of outcome [B20]", (outcome) =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await db.query("update public.properties set status='dead' where id=$1", [f.l.property]);
        const e = await entryOf(db, f.entry);
        expect(e.status).toBe("calling");
        expect(e.blocked_reason).toBeTruthy();
        await settle(db, f.requestId, outcome, outcome === "reviewed" ? "reviewed" : "webhook");
        expect((await entryOf(db, f.entry)).status).toBe("done");
      }));

    it.each(["queued", "paused"] as const)("a block on a %s entry ends it immediately", (state) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        if (state === "paused") await pauseEntry(db, entry, ctx.rep);
        await db.query("update public.properties set outreach_dispo='dnc' where id=$1", [l.property]);
        const e = await entryOf(db, entry);
        expect(e.status).toBe("done");
        expect(e.blocked_reason).toBeTruthy();
        expect(await resumeEntry(db, entry, ctx.rep)).toMatch(/^refused:/);
      }));

    it("a new voice opt-out in consent_events blocks a live entry", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await consent(db, ctx, l, "voice", "opt_out");
        expect(await entryOf(db, entry)).toMatchObject({ status: "done" });
      }));

    it("a new SMS opt-out in consent_events blocks a live entry (Jarrad decision)", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await consent(db, ctx, l, "sms", "opt_out");
        expect(await entryOf(db, entry)).toMatchObject({ status: "done" });
      }));

    it.todo("[B1] lock-order stress: completion vs block trigger vs claim vs resume on one property, 1,000 randomised runs: needs concurrent sessions (separate stress config)");
  });

  // =========================================================================
  describe("pause / resume / cancel (rule 9)", () => {
    it("pause moves a queued entry to paused/rep_paused; resume re-queues it and sets reply_ack_at", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const entry = await enqueueOne(db, ctx, await lead(db, ctx));
        expect(await pauseEntry(db, entry, ctx.rep)).toBe("paused");
        expect(await entryOf(db, entry)).toMatchObject({ status: "paused", pause_reason: "rep_paused" });
        expect(await resumeEntry(db, entry, ctx.rep)).toBe("resumed");
        const e = await entryOf(db, entry);
        expect(e.status).toBe("queued");
        expect(e.reply_ack_at).not.toBeNull();
        expect(e.next_attempt_at).not.toBeNull();
      }));

    it("resume is refused while an open request exists for the property", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await pauseEntry(db, f.entry, f.ctx.rep);
        expect(await resumeEntry(db, f.entry, f.ctx.rep)).toMatch(/^refused:/);
        expect((await entryOf(db, f.entry)).status).toBe("paused");
      }));

    it("cancel ends a live entry and leaves its in-flight request untouched", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await cancelEntry(db, f.entry, f.ctx.rep);
        expect((await entryOf(db, f.entry)).status).toBe("cancelled");
        expect((await requestOf(db, f.requestId)).status).toBe("dispatching");
      }));

    it.each(["done", "cancelled"] as const)("absorbing %s entries cannot be paused, resumed or re-opened", (state) =>
      run(async (db) => {
        const f = await inFlight(db);
        await putEntryIn(db, f, state);
        await pauseEntry(db, f.entry, f.ctx.rep);
        await resumeEntry(db, f.entry, f.ctx.rep);
        expect((await entryOf(db, f.entry)).status).toBe(state);
        const r = await tryAs(db, null, "service_role", "update public.norma_queue_entries set status='queued' where id=$1", [f.entry]);
        expect(r.error, "guard trigger must reject leaving an absorbing state").not.toBeNull();
      }));
  });

  // =========================================================================
  describe("pause / resume / cancel authorisation: any ACTIVE member of the entry's org (UI 'per-entry org authorisation')", () => {
    type ActorMaker = (db: Client, a: Ctx, b: Ctx) => Promise<string>;
    const ACTORS: [string, ActorMaker, boolean][] = [
      ["the requester", async (_d, a) => a.rep, true],
      ["another active member who is not the requester", async (_d, a) => a.assignee, true],
      ["a suspended member", async (db, a) => { const u = randomUUID(); await db.query("insert into auth.users(id) values ($1)", [u]); await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','suspended')", [u, a.org]); return u; }, false],
      ["a user with no membership", async (db) => { const u = randomUUID(); await db.query("insert into auth.users(id) values ($1)", [u]); return u; }, false],
      ["an active member of ANOTHER org", async (_d, _a, b) => b.rep, false],
      ["a uuid that is not a user", async () => randomUUID(), false],
    ];
    const OPS: [string, Start, (db: Client, id: string, actor: string) => Promise<string>, string, string][] = [
      ["pause", "queued", pauseEntry, "paused", "paused"],
      ["resume", "paused", (db, id, actor) => resumeEntry(db, id, actor), "resumed", "queued"],
      ["cancel", "queued", cancelEntry, "cancelled", "cancelled"],
    ];
    for (const [op, startState, call, okResult, endStatus] of OPS) {
      it.each(ACTORS.map(([n, m, allowed]) => [n, m, allowed] as const))(`${op} by %s`, (_n, make, allowed) =>
        run(async (db) => {
          const a = await newOrg(db);
          const b = await newOrg(db);
          const entry = await enqueueOne(db, a, await lead(db, a));
          if (startState === "paused") expect(await pauseEntry(db, entry, a.rep)).toBe("paused");
          const actor = await make(db, a, b);
          const before = await entryOf(db, entry);
          const r = await call(db, entry, actor);
          if (allowed) {
            expect(r).toBe(okResult);
            expect((await entryOf(db, entry)).status).toBe(endStatus);
          } else {
            expect(r).toMatch(/^refused:/);
            expect(await entryOf(db, entry)).toEqual(before);
          }
        }));
    }

    it("bulk resume refuses non-paused entries PER ROW and still resumes the paused ones", () =>
      run(async (db) => {
        const a = await newOrg(db);
        const mk = async () => enqueueOne(db, a, await lead(db, a));
        const paused = await mk();
        await pauseEntry(db, paused, a.rep);
        const queued = await mk();
        const calling = await mk();
        expect((await claimTx1(db, calling, V_OPEN)).result).toBe("claimed");
        const done = await mk();
        await db.query("update public.norma_queue_entries set status='done', end_reason='test_forced' where id=$1", [done]);
        const cancelled = await mk();
        await cancelEntry(db, cancelled, a.rep);
        const openRequest = await inFlightSent(db, a);
        await pauseEntry(db, openRequest.entry, a.rep);
        const before = Object.fromEntries(await Promise.all([queued, calling, done, cancelled, openRequest.entry].map(async (id) => [id, await entryOf(db, id)] as const)));
        for (const id of [queued, calling, done, cancelled, openRequest.entry]) {
          expect(await resumeEntry(db, id, a.rep), `resume ${id}`).toMatch(/^refused:/);
          expect(await entryOf(db, id)).toEqual(before[id]);
        }
        expect(await resumeEntry(db, paused, a.rep)).toBe("resumed");
        expect((await entryOf(db, paused)).status).toBe("queued");
      }));
  });

  // =========================================================================
  describe("inbound reply parking ([C19], [E4])", () => {
    it("an inbound message parks a queued entry as paused/inbound_reply", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await inboundMessage(db, ctx, l);
        expect(await entryOf(db, entry)).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
      }));

    it("parks even when the property has no drip enrollment", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx, { enrollment: false });
        const entry = await enqueueOne(db, ctx, l);
        await inboundMessage(db, ctx, l);
        expect(await entryOf(db, entry)).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
      }));

    it("an outbound message does not park", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await inboundMessage(db, ctx, l, "now()", "outbound");
        expect((await entryOf(db, entry)).status).toBe("queued");
      }));

    it("does not touch absorbing entries", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await cancelEntry(db, entry, ctx.rep);
        await inboundMessage(db, ctx, l);
        expect((await entryOf(db, entry)).status).toBe("cancelled");
      }));

    it("a message from before the entry existed does not park it", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l); // entry.created_at = now() - 1 day (fixture backdate)
        await inboundMessage(db, ctx, l, "now() - interval '2 days'");
        expect((await entryOf(db, entry)).status).toBe("queued");
      }));

    it("resume sets reply_ack_at so the same message does not re-park, but a newer reply does", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await inboundMessage(db, ctx, l);
        const msgAt = (await one(db, "select created_at from public.messages where property_id=$1", [l.property])).created_at as Date;
        expect(await resumeEntry(db, entry, ctx.rep)).toBe("resumed");
        const e = await entryOf(db, entry);
        expect(e.status).toBe("queued");
        expect((e.reply_ack_at as Date).getTime()).toBeGreaterThanOrEqual(msgAt.getTime());
        // delayed processing of an old reply (created before the ack) must not re-park
        await inboundMessage(db, ctx, l, "now() - interval '30 minutes'");
        expect((await entryOf(db, entry)).status).toBe("queued");
        // a genuinely newer reply parks again
        await inboundMessage(db, ctx, l, "now() + interval '1 minute'");
        expect(await entryOf(db, entry)).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
      }));

    it("parking a calling entry rotates the dispatch token", () =>
      run(async (db) => {
        const f = await inFlight(db);
        await inboundMessage(db, f.ctx, f.l);
        const e = await entryOf(db, f.entry);
        expect(e).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
        expect(e.dispatch_token).not.toBe(f.dispatch);
      }));

    it("[B19] a failure in the reply-parking helper aborts the inbound insert visibly (no silent loss of the park)", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        // PROPOSED seam: the messages trigger calls norma_private.fn_norma_queue_park_for_reply(property, message created_at).
        await db.query(
          `create or replace function norma_private.fn_norma_queue_park_for_reply(p_property_id uuid, p_message_created_at timestamptz) returns void language plpgsql as $f$ begin raise exception 'injected park failure' using errcode = 'P0001'; end $f$`,
        );
        await db.query("savepoint b19");
        let message = "";
        try {
          await inboundMessage(db, ctx, l);
        } catch (e) {
          message = (e as Error).message;
        }
        await db.query("rollback to savepoint b19");
        expect(message).toMatch(/injected park failure/);
        expect(await count(db, "select count(*) as n from public.messages where property_id=$1", [l.property])).toBe(0);
        expect((await entryOf(db, entry)).status).toBe("queued");
      }));
  });

  // =========================================================================
  describe("follow-up reassignment upsert ([B11], [C23])", () => {
    it("escalation with owner inactive -> callback completion with owner still inactive leaves ONE row of kind callback_task", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        expect(await bind(db, f.requestId, "call-c23")).toBe("bound");
        await db.query("update public.memberships set access_status='suspended' where user_id=$1 and org_id=$2", [f.ctx.rep, f.ctx.org]);
        await svc(db, "select public.fn_norma_mark_needs_review($1::uuid,'stalled',1::integer)", [f.requestId]);
        let rows = (await db.query("select kind, status, intended_assignee from public.norma_followup_reassignments where request_id=$1", [f.requestId])).rows;
        expect(rows).toEqual([{ kind: "review_task", status: "open", intended_assignee: f.ctx.rep }]);
        await complete(db, f.requestId, "call-c23", "callback_requested", { callback_raw: "monday" });
        rows = (await db.query("select kind, status, intended_assignee from public.norma_followup_reassignments where request_id=$1", [f.requestId])).rows;
        expect(rows).toEqual([{ kind: "callback_task", status: "open", intended_assignee: f.ctx.rep }]);
        // the outcome, attempt and entry transition still committed
        expect(await requestOf(db, f.requestId)).toMatchObject({ status: "completed", outcome: "callback_requested" });
        expect((await entryOf(db, f.entry)).status).toBe("done");
      }));

    it("completion with an inactive callback owner still commits the outcome and records a callback_task reassignment", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        expect(await bind(db, f.requestId, "call-iso")).toBe("bound");
        await db.query("update public.memberships set access_status='suspended' where user_id=$1 and org_id=$2", [f.ctx.rep, f.ctx.org]);
        await complete(db, f.requestId, "call-iso", "callback_requested", { callback_raw: "monday" });
        expect(await requestOf(db, f.requestId)).toMatchObject({ status: "completed", outcome: "callback_requested" });
        expect((await db.query("select kind from public.norma_followup_reassignments where request_id=$1", [f.requestId])).rows).toEqual([{ kind: "callback_task" }]);
        expect((await entryOf(db, f.entry)).status).toBe("done");
        expect(await attemptsOf(db, f.entry)).toHaveLength(1);
      }));

    it("norma_followup_reassignments is unique per request", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        const sql = "insert into public.norma_followup_reassignments(org_id,request_id,property_id,intended_assignee,kind,payload) values ($1,$2,$3,$4,'review_task','{}'::jsonb)";
        const args = [f.ctx.org, f.requestId, f.l.property, f.ctx.rep];
        await db.query(sql, args);
        expect((await tryAs(db, null, "service_role", sql, args)).error?.code).toBe("23505");
      }));

    // PROPOSED seam: norma_private.fn_norma_followup_reassignment_upsert(org, request, property, intended_assignee, kind, payload) returns void,
    // the single writer used by completion and escalation ([C23]).
    const upsertReassignment = (db: Client, f: Flight, kind: string, payload: Record<string, unknown>) =>
      db.query("select norma_private.fn_norma_followup_reassignment_upsert($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::jsonb)", [f.ctx.org, f.requestId, f.l.property, f.ctx.rep, kind, JSON.stringify(payload)]);
    const reassignmentRows = async (db: Client, requestId: string) =>
      (await db.query("select kind, status, payload from public.norma_followup_reassignments where request_id=$1", [requestId])).rows as Row[];

    it("[C23] a second review_task for the same request is a no-op (one row, first payload kept)", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await upsertReassignment(db, f, "review_task", { n: 1 });
        await upsertReassignment(db, f, "review_task", { n: 2 });
        expect(await reassignmentRows(db, f.requestId)).toEqual([{ kind: "review_task", status: "open", payload: { n: 1 } }]);
      }));

    it("[C23] callback_task supersedes review_task and resets status to open; a later review_task does not downgrade it", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await upsertReassignment(db, f, "review_task", { n: 1 });
        await db.query("update public.norma_followup_reassignments set status='resolved', resolved_at=now() where request_id=$1", [f.requestId]);
        await upsertReassignment(db, f, "callback_task", { n: 2 });
        expect(await reassignmentRows(db, f.requestId)).toEqual([{ kind: "callback_task", status: "open", payload: { n: 2 } }]);
        await upsertReassignment(db, f, "review_task", { n: 3 });
        expect(await reassignmentRows(db, f.requestId)).toEqual([{ kind: "callback_task", status: "open", payload: { n: 2 } }]);
      }));
  });

  // =========================================================================
  describe("pre-send outcomes: fn_norma_queue_apply_presend (plan rule 4, review B2)", () => {
    const REQUEUE = [
      "queue_refused:window_closed", "queue_refused:lease_expired", "capacity_concurrency", "capacity_daily", "number_busy",
      "gate:dispatch_disabled", "gate:number_not_allowed", "bland_not_configured", "stranded_requested_expired",
    ];
    const FROM = ["requested", "dispatching"] as const;
    const start = async (db: Client, from: (typeof FROM)[number]): Promise<Flight> => {
      if (from === "requested") return createdReq(db);
      const f = await inFlight(db);
      await setWall(db, V_OPEN);
      return f;
    };
    const counters = (db: Client, entry: string) => one(db, "select phase_dates_used, phase_c_count from public.norma_queue_entries where id=$1", [entry]);
    const snapshot = async (db: Client, f: Flight) => ({ e: await entryOf(db, f.entry), r: await requestOf(db, f.requestId), a: await attemptsOf(db, f.entry) });

    it.each(REQUEUE.flatMap((r) => FROM.map((f) => [r, f] as const)))("%s on a %s request -> request dispatch_rejected, entry queued at the recomputed slot, nothing counted", (result, from) =>
      run(async (db) => {
        const f = await start(db, from);
        expect(await applyPresend(db, f.requestId, result)).toBe("applied");
        expect(await requestOf(db, f.requestId)).toMatchObject({ status: "dispatch_rejected", dispatch_error: result, send_attempted_at: null });
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "queued", pause_reason: null, end_reason: null, blocked_reason: null, phase: "A" });
        const slot = await nextSlotOf(db, f.entry, V_OPEN);
        expect(slot.kind).toBe("slot");
        expect(await sameInstant(db, "norma_queue_entries", "next_attempt_at", f.entry, slot.at as string)).toBe(true);
        expect(await attemptsOf(db, f.entry)).toHaveLength(0);
        expect(await counters(db, f.entry)).toMatchObject({ phase_dates_used: 0, phase_c_count: 0 });
      }));

    it.each(["queue_refused:window_closed", "capacity_daily", "number_busy"])("%s while the window is closed (Sunday) -> next_attempt_at is Monday 09:00 local", (result) =>
      run(async (db) => {
        const f = await createdReq(db);
        await setWall(db, V_SUNDAY);
        expect(await applyPresend(db, f.requestId, result)).toBe("applied");
        expect(await sameInstant(db, "norma_queue_entries", "next_attempt_at", f.entry, NEXT_OPEN)).toBe(true);
      }));

    it("a requeued entry can be claimed again, and a stale second apply for the OLD request cannot requeue the new call", () =>
      run(async (db) => {
        const f = await createdReq(db);
        expect(await applyPresend(db, f.requestId, "capacity_daily")).toBe("applied");
        const LATER = "2030-01-07T18:00:00Z";
        const c = await claimTx1(db, f.entry, LATER);
        expect(c.result).toBe("claimed");
        const req2 = await createV2(db, f.l, f.ctx.rep, f.ctx.rep, f.entry, c.lease_token);
        expect(await applyPresend(db, f.requestId, "capacity_daily")).toBe("noop");
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "calling", last_request_id: req2.request_id });
        expect((await requestOf(db, req2.request_id)).status).toBe("requested");
      }));

    it("pre_send_error -> entry queued and due on the next tick, request closed, nothing counted", () =>
      run(async (db) => {
        const f = await start(db, "dispatching");
        expect(await applyPresend(db, f.requestId, "pre_send_error")).toBe("applied");
        expect(await requestOf(db, f.requestId)).toMatchObject({ status: "dispatch_rejected", dispatch_error: "pre_send_error" });
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "queued" });
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where id=$1 and next_attempt_at <= $2::timestamptz", [f.entry, V_OPEN])).toBe(1);
        expect(await attemptsOf(db, f.entry)).toHaveLength(0);
      }));

    it.each(["dnc_locked", "not_interested", "no_callable_number"].flatMap((r) => FROM.map((f) => [r, f] as const)))("ineligible:%s on a %s request -> entry done, blocked_reason and end_reason blocked:<reason>, nothing counted", (reason, from) =>
      run(async (db) => {
        const f = await start(db, from);
        expect(await applyPresend(db, f.requestId, `ineligible:${reason}`)).toBe("applied");
        expect(await requestOf(db, f.requestId)).toMatchObject({ status: "dispatch_rejected", dispatch_error: `ineligible:${reason}` });
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "done", blocked_reason: reason, end_reason: `blocked:${reason}` });
        expect(await attemptsOf(db, f.entry)).toHaveLength(0);
      }));

    it("ineligible with the REAL eligibility reason: the entry's blocked_reason equals fn_norma_eligibility's string exactly", () =>
      run(async (db) => {
        const f = await inFlight(db);
        await setWall(db, V_OPEN);
        await consent(db, f.ctx, f.l, "sms", "opt_out");
        const elig = await eligibilityOf(db, f.l);
        expect(elig.eligible).toBe(false);
        expect((await entryOf(db, f.entry)).blocked_reason).toBe(elig.block_reason);
        expect(await applyPresend(db, f.requestId, `ineligible:${elig.block_reason}`)).toBe("applied");
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "done", blocked_reason: elig.block_reason, end_reason: `blocked:${elig.block_reason}` });
      }));

    // PROPOSED result token for Bland 4xx except 408: `bland_rejected:<http status>`.
    it.each([400, 401, 403, 404, 422, 429].flatMap((c) => [true, false].map((m) => [c, m] as const)))("Bland %i (send marker set: %s) -> entry paused/provider_refused, request dispatch_rejected, NO attempts row", (code, marker) =>
      run(async (db) => {
        const f = marker ? await inFlightSent(db) : await start(db, "dispatching");
        expect(await applyPresend(db, f.requestId, `bland_rejected:${code}`)).toBe("applied");
        expect(await requestOf(db, f.requestId)).toMatchObject({ status: "dispatch_rejected", dispatch_error: `bland_rejected:${code}` });
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "paused", pause_reason: "provider_refused" });
        expect(await attemptsOf(db, f.entry)).toHaveLength(0);
        expect(await resumeEntry(db, f.entry, f.ctx.rep, V_OPEN)).toBe("resumed"); // no open request left
      }));

    // PROPOSED result token for Bland 408 / 5xx / timeout: `bland_unknown`.
    it("Bland 408/5xx/timeout (bland_unknown) with a send marker -> request dispatch_unknown, attempts row pending, entry stays calling", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        expect(await applyPresend(db, f.requestId, "bland_unknown")).toBe("applied");
        expect((await requestOf(db, f.requestId)).status).toBe("dispatch_unknown");
        expect((await entryOf(db, f.entry)).status).toBe("calling");
        const a = await attemptsOf(db, f.entry);
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({ request_id: f.requestId, resolution: "pending", outcome: "unknown", slot: "A_am" });
        expect(await sameInstant(db, "norma_queue_attempts", "sent_at", a[0]!.id, V_OPEN)).toBe(true);
      }));

    it("bland_unknown when the runtime already marked the request dispatch_unknown still writes exactly one pending attempt", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await svc(db, "select public.fn_norma_mark_dispatch_unknown($1::uuid,'send_unknown:timeout',1::integer)", [f.requestId]);
        expect(await applyPresend(db, f.requestId, "bland_unknown")).toMatch(/^(applied|noop)$/);
        expect(await attemptsOf(db, f.entry)).toHaveLength(1);
        expect(await applyPresend(db, f.requestId, "bland_unknown")).toBe("noop");
        expect(await attemptsOf(db, f.entry)).toHaveLength(1);
      }));

    it("bland_unknown without a send marker writes no attempts row [F6]", () =>
      run(async (db) => {
        const f = await start(db, "dispatching");
        await applyPresend(db, f.requestId, "bland_unknown");
        expect(await attemptsOf(db, f.entry)).toHaveLength(0);
        expect((await entryOf(db, f.entry)).status).toBe("calling");
      }));

    it("an unknown send is resolved later by the ordinary settlement: pending -> final, entry follows the outcome", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await applyPresend(db, f.requestId, "bland_unknown");
        await settle(db, f.requestId, "no_answer", "reconcile");
        expect((await attemptsOf(db, f.entry))[0]).toMatchObject({ resolution: "final", outcome: "no_answer" });
        expect((await entryOf(db, f.entry)).status).toBe("queued");
      }));

    // ---- precedence --------------------------------------------------------------------------------------
    it("a paused entry stays paused (keeps its pause_reason) while the request is closed", () =>
      run(async (db) => {
        const f = await createdReq(db);
        await pauseEntry(db, f.entry, f.ctx.rep);
        expect(await applyPresend(db, f.requestId, "capacity_daily")).toBe("applied");
        expect((await requestOf(db, f.requestId)).status).toBe("dispatch_rejected");
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "paused", pause_reason: "rep_paused" });
      }));
    it("a cancelled entry stays cancelled (absorbing) while the request is closed", () =>
      run(async (db) => {
        const f = await createdReq(db);
        await cancelEntry(db, f.entry, f.ctx.rep);
        await applyPresend(db, f.requestId, "bland_rejected:400");
        expect((await requestOf(db, f.requestId)).status).toBe("dispatch_rejected");
        expect((await entryOf(db, f.entry)).status).toBe("cancelled");
      }));
    it("a calling entry with blocked_reason set goes done on a requeue result (blocked beats scheduling)", () =>
      run(async (db) => {
        const f = await createdReq(db);
        await db.query("update public.properties set status='dead' where id=$1", [f.l.property]);
        expect((await entryOf(db, f.entry)).blocked_reason).toBeTruthy();
        await applyPresend(db, f.requestId, "capacity_daily");
        expect((await entryOf(db, f.entry)).status).toBe("done");
      }));
    it("ineligible on a paused entry ends it (blocked beats paused)", () =>
      run(async (db) => {
        const f = await createdReq(db);
        await pauseEntry(db, f.entry, f.ctx.rep);
        await applyPresend(db, f.requestId, "ineligible:dnc_locked");
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "done", end_reason: "blocked:dnc_locked" });
      }));
    it("an absorbing done entry keeps its original end_reason", () =>
      run(async (db) => {
        const f = await createdReq(db);
        await putEntryIn(db, f, "done");
        await applyPresend(db, f.requestId, "ineligible:dnc_locked");
        expect(await entryOf(db, f.entry)).toMatchObject({ status: "done", end_reason: "test_forced" });
      }));

    // ---- guards ---------------------------------------------------------------------------------------------
    it("an already-bound (dispatched) request is never closed or requeued by a pre-send result", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        expect(await bind(db, f.requestId, "call-bound")).toBe("bound");
        const before = await snapshot(db, f);
        expect(await applyPresend(db, f.requestId, "capacity_daily")).toBe("noop");
        expect(await snapshot(db, f)).toEqual(before);
      }));
    it("a button request (no queue entry) answers no_entry and is left untouched", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const id = await plainRequest(db, ctx, await lead(db, ctx));
        const before = await requestOf(db, id);
        expect(await applyPresend(db, id, "capacity_daily")).toBe("no_entry");
        expect(await requestOf(db, id)).toEqual(before);
      }));

    it.each(["capacity_daily", "pre_send_error", "ineligible:dnc_locked", "bland_rejected:400", "bland_unknown"])("idempotent: a second %s is a no-op", (result) =>
      run(async (db) => {
        const f = await inFlightSent(db);
        expect(await applyPresend(db, f.requestId, result)).toBe("applied");
        const after = await snapshot(db, f);
        expect(await applyPresend(db, f.requestId, result)).toBe("noop");
        expect(await snapshot(db, f)).toEqual(after);
      }));

    it("[S1] reconcile stranded_requested_expired on a queue row: entry queued, nothing counted, request closed with that reason, legacy claim cannot dial it", () =>
      run(async (db) => {
        const f = await createdReq(db);
        expect(await applyPresend(db, f.requestId, "stranded_requested_expired")).toBe("applied");
        expect(await requestOf(db, f.requestId)).toMatchObject({ status: "dispatch_rejected", dispatch_error: "stranded_requested_expired" });
        expect((await entryOf(db, f.entry)).status).toBe("queued");
        expect(await attemptsOf(db, f.entry)).toHaveLength(0);
        expect(await counters(db, f.entry)).toMatchObject({ phase_dates_used: 0, phase_c_count: 0 });
        expect((await svcOne(db, "select public.fn_norma_claim_dispatch($1::uuid) as c", [f.requestId])).c).toBe(false);
      }));
  });

  // =========================================================================
  describe("lease watchdog: fn_norma_queue_release_expired_leases(p_now) (tick step 2, review B2)", () => {
    const EXPIRED = "2030-01-07T17:16:00Z"; // claim at V_OPEN -> lease to 17:15
    const LIVE = "2030-01-07T17:14:00Z";
    async function claimedNoRequest(db: Client, ctx?: Ctx) {
      const c = ctx ?? (await newOrg(db));
      const l = await lead(db, c);
      const entry = await enqueueOne(db, c, l);
      const claim = await claimTx1(db, entry, V_OPEN);
      expect(claim.result).toBe("claimed");
      return { ctx: c, l, entry, lease: claim.lease_token as string };
    }

    it("calling + expired lease + no request -> queued at the recomputed slot, nothing counted; second call releases nothing", () =>
      run(async (db) => {
        const x = await claimedNoRequest(db);
        expect(await releaseExpired(db, EXPIRED)).toBe(1);
        expect((await entryOf(db, x.entry)).status).toBe("queued");
        const slot = await nextSlotOf(db, x.entry, EXPIRED);
        expect(await sameInstant(db, "norma_queue_entries", "next_attempt_at", x.entry, slot.at as string)).toBe(true);
        expect(await attemptsOf(db, x.entry)).toHaveLength(0);
        const after = await entryOf(db, x.entry);
        expect(await releaseExpired(db, EXPIRED)).toBe(0);
        expect(await entryOf(db, x.entry)).toEqual(after);
      }));

    it("a live lease is untouched", () =>
      run(async (db) => {
        const x = await claimedNoRequest(db);
        const before = await entryOf(db, x.entry);
        expect(await releaseExpired(db, LIVE)).toBe(0);
        expect(await entryOf(db, x.entry)).toEqual(before);
      }));

    const OPEN_KINDS = ["requested", "dispatching", "dispatched", "dispatch_unknown", "needs_review"] as const;
    it.each(OPEN_KINDS)("calling + expired lease + an OPEN %s request -> untouched", (kind) =>
      run(async (db) => {
        const f = kind === "requested" ? await createdReq(db) : await inFlightSent(db);
        if (kind === "dispatched") expect(await bind(db, f.requestId, "call-wd")).toBe("bound");
        if (kind === "dispatch_unknown") await svc(db, "select public.fn_norma_mark_dispatch_unknown($1::uuid,'t',1::integer)", [f.requestId]);
        if (kind === "needs_review") await svc(db, "select public.fn_norma_mark_needs_review($1::uuid,'t',1::integer)", [f.requestId]);
        // keep the entry in the state the watchdog must reason about: calling with an expired lease
        await ownerWrite(db, "update public.norma_queue_entries set status='calling', pause_reason=null, lease_expires_at=$2::timestamptz where id=$1", [f.entry, "2030-01-07T17:15:00Z"]);
        expect((await requestOf(db, f.requestId)).status).toBe(kind);
        const before = await entryOf(db, f.entry);
        expect(await releaseExpired(db, EXPIRED)).toBe(0);
        expect(await entryOf(db, f.entry)).toEqual(before);
      }));

    it("calling + expired lease + only a CLOSED (dispatch_rejected) request -> released", () =>
      run(async (db) => {
        const f = await inFlight(db);
        await svc(db, "select public.fn_norma_mark_dispatch_rejected($1::uuid,'t')", [f.requestId]);
        expect(await releaseExpired(db, EXPIRED)).toBe(1);
        expect((await entryOf(db, f.entry)).status).toBe("queued");
      }));

    it("calling with blocked_reason set and an expired lease -> done (blocked beats scheduling)", () =>
      run(async (db) => {
        const x = await claimedNoRequest(db);
        await db.query("update public.properties set status='dead' where id=$1", [x.l.property]);
        await releaseExpired(db, EXPIRED);
        expect((await entryOf(db, x.entry)).status).toBe("done");
      }));

    it("a stale worker holding the old lease can no longer create a request after the release", () =>
      run(async (db) => {
        const x = await claimedNoRequest(db);
        expect(await releaseExpired(db, EXPIRED)).toBe(1);
        const err = await svcErr(db, "select * from public.fn_norma_create_request_v2($1::uuid,$2::uuid,$3::text,$4::uuid,'ctx',$4::uuid,$5::uuid,$6::uuid)", [x.l.property, x.l.contact, x.l.phone, x.ctx.rep, x.entry, x.lease]);
        expect(err).not.toBeNull();
        expect(await count(db, "select count(*) as n from public.norma_call_requests where property_id=$1", [x.l.property])).toBe(0);
      }));

    it("returns the number released across entries and ignores queued / paused / absorbing entries", () =>
      run(async (db) => {
        const a = await claimedNoRequest(db);
        const b = await claimedNoRequest(db);
        await createdReq(db); // open request: untouched
        const ctx = await newOrg(db);
        const queued = await enqueueOne(db, ctx, await lead(db, ctx));
        const paused = await enqueueOne(db, ctx, await lead(db, ctx));
        await pauseEntry(db, paused, ctx.rep);
        const before = [await entryOf(db, queued), await entryOf(db, paused)];
        expect(await releaseExpired(db, EXPIRED)).toBe(2);
        expect([await entryOf(db, queued), await entryOf(db, paused)]).toEqual(before);
        expect((await entryOf(db, a.entry)).status).toBe("queued");
        expect((await entryOf(db, b.entry)).status).toBe("queued");
      }));
  });

  // =========================================================================
  describe("block sweep: fn_norma_queue_sweep_blocks() (tick step 3; backstop for missed triggers, review B2)", () => {
    /** Write a block with triggers OFF, so only the sweep can notice it. */
    const silentDead = (db: Client, l: Lead) => ownerWrite(db, "update public.properties set status='dead' where id=$1", [l.property]);
    const blockReasonOf = async (db: Client, l: Lead) => (await svcOne(db, "select public.fn_norma_queue_block_reason($1::uuid) as r", [l.property])).r as string;

    it("queued entry with a silent block -> done, blocked_reason = fn_norma_queue_block_reason, end_reason blocked:<reason>; second sweep is a no-op", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await silentDead(db, l);
        expect((await entryOf(db, entry)).status).toBe("queued"); // the trigger did not run
        expect(await sweepBlocks(db)).toBe(1);
        const reason = await blockReasonOf(db, l);
        expect(reason).toBeTruthy();
        expect(await entryOf(db, entry)).toMatchObject({ status: "done", blocked_reason: reason, end_reason: `blocked:${reason}` });
        const after = await entryOf(db, entry);
        expect(await sweepBlocks(db)).toBe(0);
        expect(await entryOf(db, entry)).toEqual(after);
      }));

    it("paused entry -> done", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await pauseEntry(db, entry, ctx.rep);
        await silentDead(db, l);
        expect(await sweepBlocks(db)).toBe(1);
        expect((await entryOf(db, entry)).status).toBe("done");
      }));

    it("calling entry keeps calling with blocked_reason set and a rotated dispatch token; settlement then converts it to done", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await silentDead(db, f.l);
        expect(await sweepBlocks(db)).toBe(1);
        const e = await entryOf(db, f.entry);
        expect(e).toMatchObject({ status: "calling", blocked_reason: await blockReasonOf(db, f.l) });
        expect(e.dispatch_token).not.toBe(f.dispatch);
        await settle(db, f.requestId, "no_answer");
        expect((await entryOf(db, f.entry)).status).toBe("done");
      }));

    it.each(["voice", "sms"])("a silent %s opt-out in consent_events is found by the sweep", (channel) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await ownerWrite(db, "insert into public.consent_events(org_id,contact_id,channel,event_type,occurred_at) values ($1,$2,$3,'opt_out',now())", [ctx.org, l.contact, channel]);
        expect(await sweepBlocks(db)).toBe(1);
        expect((await entryOf(db, entry)).status).toBe("done");
      }));

    it("returns the number newly blocked; clean and absorbing entries are untouched", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const bad1 = await lead(db, ctx);
        const bad2 = await lead(db, ctx);
        const clean = await lead(db, ctx);
        const gone = await lead(db, ctx);
        const e1 = await enqueueOne(db, ctx, bad1);
        const e2 = await enqueueOne(db, ctx, bad2);
        const e3 = await enqueueOne(db, ctx, clean);
        const e4 = await enqueueOne(db, ctx, gone);
        await cancelEntry(db, e4, ctx.rep);
        await silentDead(db, bad1);
        await silentDead(db, bad2);
        await silentDead(db, gone);
        const cleanBefore = await entryOf(db, e3);
        const cancelledBefore = await entryOf(db, e4);
        expect(await sweepBlocks(db)).toBe(2);
        expect((await entryOf(db, e1)).status).toBe("done");
        expect((await entryOf(db, e2)).status).toBe("done");
        expect(await entryOf(db, e3)).toEqual(cleanBefore);
        expect(await entryOf(db, e4)).toEqual(cancelledBefore);
      }));
  });

  // =========================================================================
  describe("reply sweep: fn_norma_queue_sweep_replies() (tick step 3; [B19]/[C19] watermark, review B2)", () => {
    const REPLY_AT = "2030-01-07T13:00:00Z"; // later than any fixture entry.created_at (backdated from real now)
    const LATER_REPLY = "2030-01-07T18:00:00Z"; // later than a resume at V_OPEN
    /** Insert an inbound message with the messages trigger OFF (as if the trigger path had missed it). */
    const silentInbound = (db: Client, ctx: Ctx, l: Lead, at: string, direction = "inbound") =>
      ownerWrite(db, "insert into public.messages(org_id,channel,direction,property_id,contact_id,body,status,created_at) values ($1,'sms',$2,$3,$4,'reply',$5,$6::timestamptz)", [ctx.org, direction, l.property, l.contact, direction === "inbound" ? "received" : "sent", at]);
    async function queued(db: Client) {
      const ctx = await newOrg(db);
      const l = await lead(db, ctx);
      return { ctx, l, entry: await enqueueOne(db, ctx, l) };
    }

    it("a missed inbound reply newer than the watermark parks a queued entry as paused/inbound_reply; second sweep is a no-op", () =>
      run(async (db) => {
        const x = await queued(db);
        await silentInbound(db, x.ctx, x.l, REPLY_AT);
        expect((await entryOf(db, x.entry)).status).toBe("queued");
        expect(await sweepReplies(db)).toBe(1);
        expect(await entryOf(db, x.entry)).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
        const after = await entryOf(db, x.entry);
        expect(await sweepReplies(db)).toBe(0);
        expect(await entryOf(db, x.entry)).toEqual(after);
      }));

    it("does not park for an outbound message, a message older than the entry, or a message on another property", () =>
      run(async (db) => {
        const x = await queued(db);
        const other = await lead(db, x.ctx);
        await silentInbound(db, x.ctx, x.l, REPLY_AT, "outbound");
        await silentInbound(db, x.ctx, x.l, "2000-01-01T00:00:00Z");
        await silentInbound(db, x.ctx, other, REPLY_AT);
        expect(await sweepReplies(db)).toBe(0);
        expect((await entryOf(db, x.entry)).status).toBe("queued");
      }));

    it("[C19] reply -> Resume -> sweep re-evaluating the SAME message leaves the entry queued; a genuinely newer reply parks it again", () =>
      run(async (db) => {
        const x = await queued(db);
        await inboundMessage(db, x.ctx, x.l, `'${REPLY_AT}'::timestamptz`); // trigger path parks it
        expect((await entryOf(db, x.entry)).pause_reason).toBe("inbound_reply");
        expect(await resumeEntry(db, x.entry, x.ctx.rep, V_OPEN)).toBe("resumed");
        expect(await sweepReplies(db)).toBe(0);
        expect((await entryOf(db, x.entry)).status).toBe("queued");
        await silentInbound(db, x.ctx, x.l, LATER_REPLY);
        expect(await sweepReplies(db)).toBe(1);
        expect(await entryOf(db, x.entry)).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
      }));

    it("only queued entries are swept: a paused entry keeps its reason, absorbing entries are untouched", () =>
      run(async (db) => {
        const a = await queued(db);
        await pauseEntry(db, a.entry, a.ctx.rep);
        const b = await queued(db);
        await cancelEntry(db, b.entry, b.ctx.rep);
        await silentInbound(db, a.ctx, a.l, REPLY_AT);
        await silentInbound(db, b.ctx, b.l, REPLY_AT);
        const before = [await entryOf(db, a.entry), await entryOf(db, b.entry)];
        expect(await sweepReplies(db)).toBe(0);
        expect([await entryOf(db, a.entry), await entryOf(db, b.entry)]).toEqual(before);
      }));

    it("[R1] the sweep parks ONLY queued entries: a calling entry with a missed reply is left alone by the sweep (its token is untouched); the messages trigger is what parks a calling entry, rotating the token", () =>
      run(async (db) => {
        const f = await inFlight(db);
        await silentInbound(db, f.ctx, f.l, REPLY_AT); // trigger off: as if the trigger path had missed it
        const before = await entryOf(db, f.entry);
        expect(before.status).toBe("calling");
        expect(await sweepReplies(db)).toBe(0);
        expect(await entryOf(db, f.entry)).toEqual(before);
        // the trigger path (a real inbound insert) parks the calling entry and rotates the dispatch token
        await inboundMessage(db, f.ctx, f.l, "now() + interval '1 minute'");
        const parked = await entryOf(db, f.entry);
        expect(parked).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
        expect(parked.dispatch_token).not.toBe(f.dispatch);
      }));
  });

  // =========================================================================
  describe("fn_norma_queue_pause_unknown_state(p_entry_id) (PROPOSED shape, review B2)", () => {
    const setState = (db: Client, l: Lead, state: string) => db.query("update public.properties set state=$2 where id=$1", [l.property, state]);
    it.each([["ZZ"], [""]])("a queued entry whose property state became %s -> paused/unknown_state; second call is a no-op", (state) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await setState(db, l, state);
        expect(await pauseUnknownState(db, entry)).toBe("paused");
        expect(await entryOf(db, entry)).toMatchObject({ status: "paused", pause_reason: "unknown_state" });
        const after = await entryOf(db, entry);
        expect(await pauseUnknownState(db, entry)).toBe("noop");
        expect(await entryOf(db, entry)).toEqual(after);
      }));
    it("a known state is a no-op", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const entry = await enqueueOne(db, ctx, await lead(db, ctx));
        const before = await entryOf(db, entry);
        expect(await pauseUnknownState(db, entry)).toBe("noop");
        expect(await entryOf(db, entry)).toEqual(before);
      }));
    it("a calling entry is parked and its dispatch token rotated; the in-flight call still settles (terminal outcome -> done)", () =>
      run(async (db) => {
        const f = await inFlightSent(db);
        await setState(db, f.l, "ZZ");
        expect(await pauseUnknownState(db, f.entry)).toBe("paused");
        const e = await entryOf(db, f.entry);
        expect(e).toMatchObject({ status: "paused", pause_reason: "unknown_state" });
        expect(e.dispatch_token).not.toBe(f.dispatch);
        await settle(db, f.requestId, "callback_requested");
        expect((await entryOf(db, f.entry)).status).toBe("done");
      }));
    it("an already-paused entry keeps its reason; absorbing entries are untouched", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l1 = await lead(db, ctx);
        const l2 = await lead(db, ctx);
        const paused = await enqueueOne(db, ctx, l1);
        await pauseEntry(db, paused, ctx.rep);
        const cancelled = await enqueueOne(db, ctx, l2);
        await cancelEntry(db, cancelled, ctx.rep);
        await setState(db, l1, "ZZ");
        await setState(db, l2, "ZZ");
        expect(await pauseUnknownState(db, paused)).toBe("noop");
        expect(await pauseUnknownState(db, cancelled)).toBe("noop");
        expect(await entryOf(db, paused)).toMatchObject({ status: "paused", pause_reason: "rep_paused" });
        expect((await entryOf(db, cancelled)).status).toBe("cancelled");
      }));
    it.each([["ZZ"], [""]])("[R2] claim on a property whose state is now %s answers unknown_state, the entry becomes paused/unknown_state, and Resume is refused:unknown_state until the state maps again", (state) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await setState(db, l, state);
        const claim = await claimTx1(db, entry, V_OPEN);
        expect(claim.result).toBe("unknown_state");
        expect(await entryOf(db, entry)).toMatchObject({ status: "paused", pause_reason: "unknown_state", lease_token: null });
        expect(await resumeEntry(db, entry, ctx.rep, V_OPEN)).toBe("refused:unknown_state");
        expect(await entryOf(db, entry)).toMatchObject({ status: "paused", pause_reason: "unknown_state" });
        await setState(db, l, "MO");
        expect(await resumeEntry(db, entry, ctx.rep, V_OPEN)).toBe("resumed");
        expect((await entryOf(db, entry)).status).toBe("queued");
      }));
  });

  // =========================================================================
  describe("clock seam: norma_private.fn_norma_wallclock", () => {
    it("exists in norma_private, returns timestamptz, is volatile and defaults to the real clock", () =>
      runRaw(async (db) => {
        const p = await one(db, "select p.prorettype::regtype::text as t, p.provolatile as v, p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='norma_private' and p.proname='fn_norma_wallclock'");
        expect(p.t).toBe("timestamp with time zone");
        expect(p.v).toBe("v");
        expect((await one(db, "select abs(extract(epoch from (norma_private.fn_norma_wallclock() - clock_timestamp()))) < 5 as ok")).ok).toBe(true);
      }));

    it("is not executable by anon or authenticated", () =>
      runRaw(async (db) => {
        const oid = (await one(db, "select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='norma_private' and p.proname='fn_norma_wallclock'")).oid;
        for (const role of ["anon", "authenticated"]) {
          expect((await one(db, "select has_function_privilege($1,$2::oid,'execute') as x", [role, oid])).x, role).toBe(false);
        }
      }));

    it("replacing it inside a savepoint moves the SQL clock (enqueue reads it) and the replacement rolls back with the savepoint", () =>
      runRaw(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await setWall(db, V_SUNDAY);
        const row = (await enqueueRaw(db, ctx, [l.property]))[0]!;
        expect(await sameInstant(db, "norma_queue_entries", "next_attempt_at", row.entry_id, NEXT_OPEN)).toBe(true);
      }));
  });

  // =========================================================================
  describe("scheduler: fn_norma_queue_next_slot (entry wrapper over the pure fn_norma_queue_next_slot_for)", () => {
    async function sentEntry(db: Client, state = "MO") {
      const ctx = await newOrg(db);
      const l = await lead(db, ctx, { state });
      const f = await inFlight(db, ctx, { l });
      await stamp(db, f.requestId, V_OPEN); // first send Mon 11:00 Chicago
      await setWall(db, V_OPEN);
      expect(await bind(db, f.requestId, `call-${f.requestId}`)).toBe("bound");
      await complete(db, f.requestId, `call-${f.requestId}`, "no_answer");
      return f;
    }
    const instant = (r: Row) => new Date(r.at as string).getTime();

    it("an 11:00 local send settles no_answer into exactly 14:00 local (A_pm); the wrapper, the pure function and next_attempt_at agree", () =>
      run(async (db) => {
        const f = await sentEntry(db);
        expect(await attemptsOf(db, f.entry)).toHaveLength(1);
        const wrapped = await nextSlotOf(db, f.entry, V_OPEN);
        const pure = await nextSlotFor(db, "MO", [V_OPEN], V_OPEN);
        expect(wrapped).toMatchObject({ kind: "slot", phase: "A", slot: "A_pm" });
        expect(instant(wrapped)).toBe(new Date(AFTER_11AM_SEND).getTime());
        expect(wrapped.kind).toBe(pure.kind);
        expect(instant(wrapped)).toBe(instant(pure));
        expect(await sameInstant(db, "norma_queue_entries", "next_attempt_at", f.entry, AFTER_11AM_SEND)).toBe(true);
      }));

    it("uses the CURRENT property state: edited to CA between sends, the same 09:00 PST send gives 14:00 PST", () =>
      run(async (db) => {
        const f = await sentEntry(db);
        await db.query("update public.properties set state='CA' where id=$1", [f.l.property]);
        const wrapped = await nextSlotOf(db, f.entry, V_OPEN);
        expect(wrapped).toMatchObject({ kind: "slot", phase: "A", slot: "A_pm" });
        expect(instant(wrapped)).toBe(new Date("2030-01-07T22:00:00Z").getTime()); // 14:00 PST
      }));

    it("an entry with no sends yet matches the pure function for the same state and now", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const entry = await enqueueOne(db, ctx, await lead(db, ctx));
        const wrapped = await nextSlotOf(db, entry, V_OPEN);
        const pure = await nextSlotFor(db, "MO", [], V_OPEN);
        expect(wrapped.kind).toBe("slot");
        expect(wrapped).toMatchObject({ kind: pure.kind, phase: pure.phase, slot: pure.slot });
        expect(instant(wrapped)).toBe(instant(pure));
      }));

    it("a property state outside the zone table answers unknown_state", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const entry = await enqueueOne(db, ctx, l);
        await db.query("update public.properties set state='ZZ' where id=$1", [l.property]);
        expect(await nextSlotOf(db, entry, V_OPEN)).toEqual({ kind: "unknown_state" });
      }));
  });

  // =========================================================================
  describe("consent opt-outs in consent_events block Norma on the BUTTON path too ([C25], Jarrad 2026-10-07: SMS and voice both block)", () => {
    const CHANNELS = ["sms", "voice"] as const;
    const eligibility = async (db: Client, l: Lead): Promise<Row> =>
      svcOne(db, "select * from public.fn_norma_eligibility($1::uuid,$2::uuid,$3::text)", [l.property, l.contact, l.phone]);
    const buttonCreate = async (db: Client, ctx: Ctx, l: Lead): Promise<Row> =>
      svcOne(db, "select * from public.fn_norma_create_request($1::uuid,$2::uuid,$3::text,$4::uuid,'ctx',$5::uuid)", [l.property, l.contact, l.phone, ctx.rep, ctx.assignee]);

    it("baseline: a clean lead is eligible and the button path creates a request", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        expect(await eligibility(db, l)).toMatchObject({ eligible: true });
        expect((await buttonCreate(db, ctx, l)).outcome).toBe("created");
      }));

    it.each(CHANNELS)("fn_norma_eligibility refuses a contact whose %s opt-out exists only in consent_events", (channel) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await consent(db, ctx, l, channel, "opt_out");
        const r = await eligibility(db, l);
        expect(r.eligible).toBe(false);
        expect(r.block_reason).toBeTruthy();
      }));

    it.each(CHANNELS)("fn_norma_eligibility: %s provider_auto_opt_out blocks too", (channel) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await consent(db, ctx, l, channel, "provider_auto_opt_out");
        expect((await eligibility(db, l)).eligible).toBe(false);
      }));

    it.each(CHANNELS)("fn_norma_eligibility: a LATER %s opt-in re-allows (latest-event precedence)", (channel) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await consent(db, ctx, l, channel, "opt_out", "now() - interval '2 days'");
        await consent(db, ctx, l, channel, "opt_in_confirmed", "now() - interval '1 day'");
        expect((await eligibility(db, l)).eligible).toBe(true);
      }));

    it.each(CHANNELS)("fn_norma_eligibility: a later %s opt-out beats an earlier opt-in, and help_request after an opt-out does not re-allow", (channel) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await consent(db, ctx, l, channel, "opt_in_confirmed", "now() - interval '3 days'");
        await consent(db, ctx, l, channel, "opt_out", "now() - interval '2 days'");
        expect((await eligibility(db, l)).eligible).toBe(false);
        await consent(db, ctx, l, channel, "help_request", "now() - interval '1 day'");
        expect((await eligibility(db, l)).eligible).toBe(false);
      }));

    it.each(CHANNELS)("fn_norma_create_request (button) refuses a %s opt-out held only in consent_events and creates nothing", (channel) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await consent(db, ctx, l, channel, "opt_out");
        const r = await buttonCreate(db, ctx, l);
        expect(r.outcome).toBe("blocked");
        expect(r.request_id).toBeNull();
        expect(r.block_reason).toBeTruthy();
        expect(await count(db, "select count(*) as n from public.norma_call_requests where property_id=$1", [l.property])).toBe(0);
      }));

    it.each(CHANNELS)("fn_norma_create_request (button): a later %s opt-in re-allows the call", (channel) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        await consent(db, ctx, l, channel, "opt_out", "now() - interval '2 days'");
        await consent(db, ctx, l, channel, "opt_in_confirmed", "now() - interval '1 day'");
        expect((await buttonCreate(db, ctx, l)).outcome).toBe("created");
      }));

    it.each(CHANNELS)("claim_dispatch_v2 refuses a reconcile-dispatched BUTTON row after a %s opt-out arrives: ineligible:*, request stays requested, nothing written", (channel) =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const l = await lead(db, ctx);
        const id = await plainRequest(db, ctx, l);
        await consent(db, ctx, l, channel, "opt_out");
        const before = await requestOf(db, id);
        expect(await claimV2(db, id, V_OPEN)).toMatch(/^ineligible:/);
        expect(await requestOf(db, id)).toEqual(before);
        expect(before.status).toBe("requested");
      }));

  });

  // =========================================================================
  describe("merge_duplicate_properties carries queue state ([H8])", () => {
    const entryRow = (db: Client, id: string) => one(db, "select id, property_id, status, end_reason from public.norma_queue_entries where id=$1", [id]);
    const bareLead = (db: Client, ctx: Ctx) => lead(db, ctx, { enrollment: false });

    it("a lone live entry on the loser follows the survivor and keeps its state and attempts ledger", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const keeper = await bareLead(db, ctx);
        const loser = await bareLead(db, ctx);
        const f = await inFlight(db, ctx, { l: loser });
        await stamp(db, f.requestId, V_OPEN);
        await setWall(db, V_OPEN);
        expect(await bind(db, f.requestId, "call-h8a")).toBe("bound");
        await complete(db, f.requestId, "call-h8a", "no_answer");
        expect(await attemptsOf(db, f.entry)).toHaveLength(1);
        await mergeProps(db, ctx.assignee, keeper.property, loser.property);
        expect(await entryRow(db, f.entry)).toMatchObject({ property_id: keeper.property, status: "queued" });
        expect(await attemptsOf(db, f.entry)).toHaveLength(1); // ledger survives the loser's request/property delete
      }));

    it("both properties have a live entry: the survivor's entry is kept, the loser's is cancelled with end_reason merged_into:<keeper entry id>", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const keeper = await bareLead(db, ctx);
        const loser = await bareLead(db, ctx);
        const keeperEntry = await enqueueOne(db, ctx, keeper);
        const loserEntry = await enqueueOne(db, ctx, loser);
        await mergeProps(db, ctx.assignee, keeper.property, loser.property);
        expect(await entryRow(db, keeperEntry)).toMatchObject({ property_id: keeper.property, status: "queued", end_reason: null });
        expect(await entryRow(db, loserEntry)).toMatchObject({ property_id: keeper.property, status: "cancelled", end_reason: `merged_into:${keeperEntry}` });
        expect(await count(db, "select count(*) as n from public.norma_queue_entries where property_id=$1 and status in ('queued','calling','paused')", [keeper.property])).toBe(1);
      }));

    it("an absorbing entry on the loser is repointed without changing its state, next to the survivor's live entry", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const keeper = await bareLead(db, ctx);
        const loser = await bareLead(db, ctx);
        const keeperEntry = await enqueueOne(db, ctx, keeper);
        const loserEntry = await enqueueOne(db, ctx, loser);
        await cancelEntry(db, loserEntry, ctx.rep);
        await mergeProps(db, ctx.assignee, keeper.property, loser.property);
        expect(await entryRow(db, loserEntry)).toMatchObject({ property_id: keeper.property, status: "cancelled", end_reason: expect.not.stringMatching(/^merged_into:/) });
        expect((await entryRow(db, keeperEntry)).status).toBe("queued");
      }));

    it("followup reassignments on the loser are repointed to the survivor", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const keeper = await bareLead(db, ctx);
        const loser = await bareLead(db, ctx);
        const f = await inFlight(db, ctx, { l: loser });
        await db.query(
          "insert into public.norma_followup_reassignments(org_id,request_id,property_id,intended_assignee,kind,payload) values ($1,$2,$3,$4,'review_task','{}'::jsonb)",
          [ctx.org, f.requestId, loser.property, ctx.rep],
        );
        await mergeProps(db, ctx.assignee, keeper.property, loser.property);
        expect((await db.query("select property_id from public.norma_followup_reassignments where org_id=$1", [ctx.org])).rows).toEqual([{ property_id: keeper.property }]);
      }));

    it("[N4] loser entry `calling` with an in-flight request: the request is cascade-deleted, the attempts row REMAINS (request_id is a non-FK snapshot), the loser entry is cancelled merged_into:<keeper ENTRY id>, the survivor is untouched", () =>
      run(async (db) => {
        const ctx = await newOrg(db);
        const keeper = await bareLead(db, ctx);
        const loser = await bareLead(db, ctx);
        const keeperEntry = await enqueueOne(db, ctx, keeper);
        const keeperBefore = await entryRow(db, keeperEntry);
        const f = await inFlight(db, ctx, { l: loser });
        await stamp(db, f.requestId, V_OPEN);
        await setWall(db, V_OPEN);
        expect(await bind(db, f.requestId, "call-n4")).toBe("bound"); // writes the pending attempts row
        expect(await attemptsOf(db, f.entry)).toHaveLength(1);
        expect((await entryRow(db, f.entry)).status).toBe("calling");
        await mergeProps(db, ctx.assignee, keeper.property, loser.property);
        expect(await count(db, "select count(*) as n from public.norma_call_requests where id=$1", [f.requestId])).toBe(0);
        const attempts = await attemptsOf(db, f.entry);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ request_id: f.requestId, resolution: "pending" });
        expect(await entryRow(db, f.entry)).toMatchObject({ property_id: keeper.property, status: "cancelled", end_reason: `merged_into:${keeperEntry}` });
        expect(await entryRow(db, keeperEntry)).toEqual(keeperBefore);
        expect(await attemptsOf(db, keeperEntry)).toHaveLength(0);
      }));

    it.todo("[H8] 'log both' (merge writes a log record for the kept and the cancelled entry): the plan does not say where or in what shape (lead_events? entry end_reason only?); needs Astra/Jarrad before pinning");
  });
});

// ===========================================================================
// Rows that exist BEFORE the queue migration is applied. Separate fixture (own connection + transaction,
// opened after the first describe has rolled back) so these seeded rows cannot skew the capacity counts above.
// ===========================================================================
describe("pre-migration rows seeded before the queue migration ([E3], [F3], [G1])", () => {
  beforeAll(async () => {
    holder.fx = await openQueueFixture(dbUrl, {
      beforeQueueMigration: async (db) => {
        seeded.v = await seedPreMigration(db);
      },
    });
  }, 120_000);
  afterAll(async () => {
    await holder.fx?.close();
    holder.fx = undefined;
  });

  // The seeded rows: completed-today (dispatched_at today), dispatch_unknown backdated 3 days with no send marker,
  // and a legacy worker that claimed but had not sent when the migration landed. All three count toward today.
  const SEEDED_TODAY = 3;
  const SEEDED_OPEN = 2; // dispatch_unknown + dispatching hold concurrency; the completed one does not

  it("[E3]/[F3] calls placed today before the migration, plus unresolved legacy rows, count toward today's cap", () =>
    run(async (db) => {
      const a = await newOrg(db);
      const candidate = await plainRequest(db, a, await lead(db, a));
      expect(await claimV2(db, candidate, await dbNow(db), { daily: SEEDED_TODAY })).toBe("capacity_daily");
      expect(await claimV2(db, candidate, await dbNow(db), { daily: SEEDED_TODAY + 1 })).toBe("claimed");
    }));

  it("[F3] unresolved legacy rows (dispatch_unknown, dispatching) hold concurrency; the completed one does not", () =>
    run(async (db) => {
      const a = await newOrg(db);
      const candidate = await plainRequest(db, a, await lead(db, a));
      expect(await claimV2(db, candidate, await dbNow(db), { maxC: SEEDED_OPEN })).toBe("capacity_concurrency");
      expect(await claimV2(db, candidate, await dbNow(db), { maxC: SEEDED_OPEN + 1 })).toBe("claimed");
    }));

  it.each(["unknown", "dispatching"] as const)("[F3]/[G1c] an unresolved legacy %s row still holds its number", (which) =>
    run(async (db) => {
      const s = seeded.v!;
      const second = await lead(db, s.ctx, { sameContactAs: s[which].l });
      const candidate = await plainRequest(db, s.ctx, second);
      expect(await claimV2(db, candidate, await dbNow(db))).toBe("number_busy");
      expect((await svcOne(db, "select public.fn_norma_claim_dispatch($1::uuid) as c", [candidate])).c).toBe(false);
    }));

  it("[F3] a legacy call completed seconds ago still spaces the next dial on its number (coalesce falls back to dispatched_at); free after 10 s", () =>
    run(async (db) => {
      const s = seeded.v!;
      const second = await lead(db, s.ctx, { sameContactAs: s.completed.l });
      const candidate = await plainRequest(db, s.ctx, second);
      expect(await claimV2(db, candidate, await dbNow(db))).toBe("number_busy"); // dispatched_at = this transaction's now()
      await db.query("update public.norma_call_requests set dispatched_at = now() - interval '30 seconds' where id=$1", [s.completed.id]);
      expect(await claimV2(db, candidate, await dbNow(db))).toBe("claimed");
    }));

  it("[G1] the legacy worker that claimed before the migration still sends and binds afterwards; no new v1 claim succeeds", () =>
    run(async (db) => {
      const s = seeded.v!;
      expect((await requestOf(db, s.dispatching.id)).status).toBe("dispatching");
      expect(await bind(db, s.dispatching.id, "call-g1-late")).toBe("bound");
      expect((await requestOf(db, s.dispatching.id)).status).toBe("dispatched");
      const fresh = await plainRequest(db, s.ctx, await lead(db, s.ctx));
      expect((await svcOne(db, "select public.fn_norma_claim_dispatch($1::uuid) as c", [fresh])).c).toBe(false);
      expect((await svcOne(db, "select public.fn_norma_claim_dispatch($1::uuid, 1) as c", [fresh])).c).toBe(false);
    }));
});

// ===========================================================================
// Concurrency: a run-owned disposable database with COMMITTED data and two (or more) real sessions
// ([C7], [E2], [E6], SKIP LOCKED). The rollback-only fixture above cannot show a race.
// ===========================================================================
describe("concurrency on a run-owned disposable database ([C7], [E2], [E6], [C1])", () => {
  const cf: { v?: ConcurrentFixture } = {};
  beforeAll(async () => { cf.v = await openConcurrentFixture(dbUrl); }, 300_000);
  afterAll(async () => { await cf.v?.close(); cf.v = undefined; });

  const CLAIM_AT = V_OPEN;
  /** Begin a transaction as service_role on `c` (the wrapper functions reject anything else). */
  async function beginService(c: Client) {
    await c.query("begin");
    await c.query("set local role service_role");
    await c.query("select set_config('request.jwt.claim.role','service_role',true)");
  }
  const pidOf = async (c: Client) => Number((await c.query("select pg_backend_pid() as p")).rows[0].p);
  /** True once `pid` is waiting on a lock; false if `settled()` becomes true or the timeout passes first. */
  async function waitBlocked(observer: Client, pid: number, settled: () => boolean, timeoutMs = 4000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && !settled()) {
      const r = await observer.query("select wait_event_type from pg_stat_activity where pid=$1", [pid]);
      if (r.rows[0]?.wait_event_type === "Lock") return true;
      await new Promise((res) => setTimeout(res, 25));
    }
    return false;
  }
  const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} did not return within ${ms} ms`)), ms))]);

  /** Committed: org + lead + entry claimed + request created + dispatch-claimed + control ON, at `claimAt`. */
  async function committedReady(claimAt = CLAIM_AT) {
    const fx = cf.v!;
    return fx.seed(async (db) => {
      await db.query("update public.zz_test_clock set at=$1::timestamptz", [claimAt]);
      const ctx = await newOrg(db);
      const l = await lead(db, ctx);
      const entry = await enqueueOne(db, ctx, l);
      const c = await claimTx1(db, entry, claimAt);
      expect(c.result).toBe("claimed");
      const req = await createV2(db, l, ctx.rep, ctx.rep, entry, c.lease_token);
      expect(await claimV2(db, req.request_id, claimAt)).toBe("claimed");
      await setControl(db, true);
      return { ctx, l, entry, requestId: req.request_id as string, dispatch: c.dispatch_token as string };
    });
  }
  const requestStatus = async (id: string) => (await cf.v!.owner.query("select status, send_attempted_at, dispatch_error from public.norma_call_requests where id=$1", [id])).rows[0] as Row;

  it("[C7] two orgs claiming at limit 1 at the same time: exactly one is claimed, the other is capacity_concurrency", async () => {
    const fx = cf.v!;
    await fx.resetRequests();
    await fx.setClock(CLAIM_AT);
    const [r1, r2] = await fx.seed(async (db) => {
      const a = await newOrg(db);
      const b = await newOrg(db);
      return [await plainRequest(db, a, await lead(db, a)), await plainRequest(db, b, await lead(db, b))];
    });
    const sql = "select public.fn_norma_claim_dispatch_v2($1::uuid,1,$2::timestamptz,true,1,100000,'America/Chicago') as r";
    const c1 = await fx.connect();
    const c2 = await fx.connect();
    await beginService(c1);
    const first = (await c1.query(sql, [r1, CLAIM_AT])).rows[0].r as string; // holds the global capacity lock until commit
    let settled = false;
    const second = (async () => {
      await beginService(c2);
      const r = (await c2.query(sql, [r2, CLAIM_AT])).rows[0].r as string;
      settled = true;
      return r;
    })();
    expect(await waitBlocked(fx.owner, await pidOf(c2), () => settled), "the second claim must wait on the global capacity lock").toBe(true);
    await c1.query("commit");
    const secondResult = await withTimeout(second, 10_000, "second claim");
    await c2.query("commit");
    expect(first).toBe("claimed");
    expect(secondResult).toBe("capacity_concurrency");
    expect(Number((await fx.owner.query("select count(*) as n from public.norma_call_requests where status='dispatching'")).rows[0].n)).toBe(1);
  }, 60_000);

  it("[C1] fn_norma_queue_claim never waits: while one session holds the entry, a second claim answers not_claimable at once", async () => {
    const fx = cf.v!;
    await fx.setClock(CLAIM_AT);
    const entry = await fx.seed(async (db) => {
      const ctx = await newOrg(db);
      return enqueueOne(db, ctx, await lead(db, ctx));
    });
    const c1 = await fx.connect();
    const c2 = await fx.connect();
    await beginService(c1);
    const first = (await c1.query("select * from public.fn_norma_queue_claim($1::uuid,$2::timestamptz,true)", [entry, CLAIM_AT])).rows[0];
    expect(first.result).toBe("claimed");
    await beginService(c2);
    const second = (await withTimeout(c2.query("select * from public.fn_norma_queue_claim($1::uuid,$2::timestamptz,true)", [entry, CLAIM_AT]), 3000, "SKIP LOCKED claim")).rows[0];
    expect(second.result).toBe("not_claimable");
    await c2.query("commit");
    await c1.query("commit");
    const e = (await fx.owner.query("select status, lease_token from public.norma_queue_entries where id=$1", [entry])).rows[0];
    expect(e).toMatchObject({ status: "calling", lease_token: first.lease_token });
  }, 60_000);

  it("[E6] an operator OFF update waits for an in-flight mark_sending admission, and every later admission is refused", async () => {
    const fx = cf.v!;
    await fx.resetRequests();
    const a = await committedReady();
    const b = await committedReady();
    const c1 = await fx.connect();
    const c3 = await fx.connect();
    await beginService(c1);
    expect((await c1.query("select public.fn_norma_mark_sending($1::uuid,$2::uuid,1) as r", [a.requestId, a.dispatch])).rows[0].r).toBe("sending"); // SHARE lock on the control row held to commit
    let updated = false;
    const c3pid = await pidOf(c3); // fetched BEFORE the blocking UPDATE: c3 is the blocked session, so it cannot answer a query afterwards
    const off = c3.query("update public.norma_queue_control set enabled=false").then(() => { updated = true; });
    expect(await waitBlocked(fx.owner, c3pid, () => updated), "the OFF update must wait for the in-flight admission").toBe(true);
    expect(updated).toBe(false);
    await c1.query("commit");
    await withTimeout(off, 10_000, "OFF update");
    expect(updated).toBe(true);
    // the admitted send stays admitted; the next admission sees OFF
    expect((await requestStatus(a.requestId)).send_attempted_at).not.toBeNull();
    const c4 = await fx.connect();
    await beginService(c4);
    const later = (await c4.query("select public.fn_norma_mark_sending($1::uuid,$2::uuid,1) as r", [b.requestId, b.dispatch])).rows[0].r as string;
    await c4.query("commit");
    expect(later).toBe("refused:control_off");
    expect((await requestStatus(b.requestId)).send_attempted_at).toBeNull();
  }, 60_000);

  it("[E2] mark_sending that starts at 19:29:59, blocks on a held lock and resumes at 19:30:01 reads the clock AFTER the locks and is refused", async () => {
    const fx = cf.v!;
    await fx.resetRequests();
    const SAT_192950 = "2030-01-06T01:29:50Z";
    const x = await committedReady(SAT_192950);
    await fx.setClock("2030-01-06T01:29:59Z"); // the wall clock the call starts with: last open second
    const holder = await fx.connect();
    const c2 = await fx.connect();
    await holder.query("begin");
    await holder.query("select * from public.norma_queue_control for update"); // contends with the admission's control-row SHARE lock
    let settled = false;
    const call = (async () => {
      await beginService(c2);
      const r = (await c2.query("select public.fn_norma_mark_sending($1::uuid,$2::uuid,1) as r", [x.requestId, x.dispatch])).rows[0].r as string;
      settled = true;
      return r;
    })();
    expect(await waitBlocked(fx.owner, await pidOf(c2), () => settled), "mark_sending must take its admission locks (control row SHARE) before reading the clock").toBe(true);
    await fx.setClock("2030-01-06T01:30:01Z"); // time passes while blocked
    await holder.query("commit");
    const result = await withTimeout(call, 10_000, "mark_sending");
    await c2.query("commit");
    expect(result).toBe("refused:window_closed");
    expect(await requestStatus(x.requestId)).toMatchObject({ status: "dispatch_rejected", send_attempted_at: null });
  }, 60_000);

  it.todo("[B1] lock-order stress (completion vs block trigger vs claim vs resume on one property, 1,000 randomised runs): probabilistic by design, not a deterministic assertion; belongs to the stress harness (src/lib/norma/stress, its own config), not this suite");
});
