import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";
import { dropEvolvedNormaDispatchOverloads } from "@tests/integration/my-leads-housekeeping-fixture";

// Local-only: every test runs inside one transaction that is rolled back, so
// the loopback database is left as it was found. The migration itself is
// replayed inside the transaction.
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const migration = readFileSync(new URL("./20261002120000_norma_call_requests.sql", import.meta.url), "utf8")
  .replace(/^\s*begin;\s*$/gim, "")
  .replace(/^\s*commit;\s*$/gim, "");

type Ctx = { org: string; rep: string; assignee: string; sequence: string };
type Lead = { property: string; contact: string; phone: string; enrollment: string | null };

let phoneCounter = 0;
const nextPhone = () => `+1816556${String(1000 + (phoneCounter++ % 9000)).padStart(4, "0")}`;

async function withDb(fn: (db: Client, ctx: Ctx) => Promise<void>) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await dropEvolvedNormaDispatchOverloads(db);
    await db.query(migration);
    const ctx: Ctx = { org: randomUUID(), rep: randomUUID(), assignee: randomUUID(), sequence: randomUUID() };
    await db.query("insert into auth.users(id) values ($1), ($2)", [ctx.rep, ctx.assignee]);
    await db.query("insert into public.organizations(id,name) values ($1,'norma test')", [ctx.org]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [ctx.assignee, ctx.org]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','active')", [ctx.rep, ctx.org]);
    await db.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Norma drip')", [ctx.sequence, ctx.org]);
    await db.query(
      "insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','hi')",
      [ctx.sequence],
    );
    await fn(db, ctx);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}

async function lead(
  db: Client,
  ctx: Ctx,
  opts: { enrollment?: "active" | `paused:${string}` | null; dispo?: string | null } = {},
): Promise<Lead> {
  const property = randomUUID();
  const contact = randomUUID();
  const phone = nextPhone();
  await db.query(
    "insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Seller',$3,'mobile')",
    [contact, ctx.org, phone],
  );
  await db.query(
    "insert into public.properties(id,org_id,address,state,status,homeowner_contact_id,outreach_dispo) values ($1,$2,$3,'MO','new_lead',$4,$5)",
    [property, ctx.org, `${property.slice(0, 6)} Main St`, contact, opts.dispo ?? null],
  );
  let enrollment: string | null = null;
  const mode = opts.enrollment === undefined ? "active" : opts.enrollment;
  if (mode) {
    const paused = mode.startsWith("paused:");
    enrollment = (
      await db.query<{ id: string }>(
        "insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,pause_reason,next_run_at) values ($1,$2,$3,$4,$5,$6,now()) returning id",
        [ctx.org, ctx.sequence, property, contact, paused ? "paused" : "active", paused ? mode.slice(7) : null],
      )
    ).rows[0]!.id;
  }
  return { property, contact, phone, enrollment };
}

/** Run one statement as the service role, restoring the superuser role after. */
async function svc<T extends Record<string, unknown> = Record<string, unknown>>(db: Client, sql: string, params: unknown[] = []) {
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role','service_role',true)");
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claim.role','',true)");
  }
}

async function svcError(db: Client, sql: string, params: unknown[] = [], role = "service_role") {
  await db.query(`set local role ${role}`);
  await db.query(`select set_config('request.jwt.claim.role','${role}',true)`);
  await db.query("savepoint expect_error");
  let error: { code?: string; message?: string } | null = null;
  try {
    await db.query(sql, params);
  } catch (e) {
    error = e as { code?: string; message?: string };
  }
  await db.query("rollback to savepoint expect_error");
  await db.query("reset role");
  return error;
}

async function create(db: Client, ctx: Ctx, l: Lead, context: string | null = "ctx") {
  const r = await svc<{ outcome: string; request_id: string | null; idempotency_key: string | null; block_reason: string | null }>(
    db,
    "select * from public.fn_norma_create_request($1,$2,$3,$4,$5,$6)",
    [l.property, l.contact, l.phone, ctx.rep, context, ctx.assignee],
  );
  return r.rows[0]!;
}

async function dispatched(db: Client, requestId: string, callId = `call-${randomUUID()}`) {
  expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [requestId])).rows[0]!.c).toBe(true);
  expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2) as b", [requestId, callId])).rows[0]!.b).toBe("bound");
  return callId;
}

async function complete(db: Client, requestId: string, callId: string, outcome: string, payload: Record<string, unknown> = {}) {
  const r = await svc<{ r: Record<string, unknown> }>(
    db,
    "select public.fn_norma_complete_call($1,$2,$3,$4::jsonb) as r",
    [requestId, callId, outcome, JSON.stringify(payload)],
  );
  return r.rows[0]!.r;
}

const one = async <T extends Record<string, unknown>>(db: Client, sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]!;

async function enrollmentState(db: Client, id: string) {
  return one<{ status: string; pause_reason: string | null }>(
    db,
    "select status, pause_reason from public.sequence_enrollments where id=$1",
    [id],
  );
}

// NOTE: these tests run on one connection inside one transaction, so the
// "interleaving" / "race" cases are ORDERING tests: they replay a specific
// sequence of events deterministically. They are not concurrency proof; real
// two-connection barrier tests belong to the stress-gate milestone.
describe("norma_call_requests data layer", () => {
  it("eligibility: allows a clean lead and blocks DNC lock, contact DNC, global registry, ownership, not_interested", async () => {
    await withDb(async (db, ctx) => {
      const clean = await lead(db, ctx);
      const el = (l: Lead, phone = l.phone, contact = l.contact) =>
        svc<{ eligible: boolean; block_reason: string | null }>(
          db,
          "select * from public.fn_norma_eligibility($1,$2,$3)",
          [l.property, contact, phone],
        ).then((r) => r.rows[0]!);
      expect(await el(clean)).toEqual({ eligible: true, block_reason: null });

      // Voice DNC is not SMS opt-out: an SMS opt-out alone does not block Norma.
      const smsOptOut = await lead(db, ctx);
      await db.query("update public.contacts set sms_opted_out=true where id=$1", [smsOptOut.contact]);
      expect((await el(smsOptOut)).eligible).toBe(true);

      const locked = await lead(db, ctx);
      await db.query("update public.properties set outreach_dispo='dnc' where id=$1", [locked.property]);
      expect(await el(locked)).toEqual({ eligible: false, block_reason: "dnc_locked" });

      const contactDnc = await lead(db, ctx);
      await db.query("update public.contacts set do_not_contact=true where id=$1", [contactDnc.contact]);
      expect((await el(contactDnc)).eligible).toBe(false);

      // Exact-number lookup in the global registry, with no property/contact flag set.
      const registry = await lead(db, ctx);
      await db.query(
        `insert into public.global_phone_dnc_registry
           (org_id,phone_e164,first_consumer_id,first_source_event_id,first_evidence_sha256)
         values ($1,$2,gen_random_uuid(),'evt',repeat('a',64))`,
        [ctx.org, registry.phone],
      );
      // Re-enable the contact flag the registry trigger would ratchet so only the registry path is under test.
      await db.query("alter table public.contacts disable trigger user");
      await db.query("update public.contacts set do_not_contact=false where id=$1", [registry.contact]);
      await db.query("alter table public.contacts enable trigger user");
      expect(await el(registry)).toEqual({ eligible: false, block_reason: "global_dnc_registry" });

      const other = await lead(db, ctx);
      expect(await el(other, other.phone, clean.contact)).toEqual({ eligible: false, block_reason: "contact_not_on_property" });
      expect(await el(other, "+18165559999")).toEqual({ eligible: false, block_reason: "phone_not_on_contact" });
      expect(await el(other, "8165550000")).toEqual({ eligible: false, block_reason: "invalid_request" });

      const notInterested = await lead(db, ctx, { dispo: "not_interested" });
      expect(await el(notInterested)).toEqual({ eligible: false, block_reason: "not_interested" });

      const gone = await svc<{ eligible: boolean; block_reason: string }>(db, "select * from public.fn_norma_eligibility($1,$2,$3)", [
        randomUUID(), clean.contact, clean.phone,
      ]);
      expect(gone.rows[0]).toEqual({ eligible: false, block_reason: "property_not_found" });
    });
  });

  it("eligibility fails closed when a lookup errors", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      await db.query("alter table public.global_phone_dnc_registry rename to global_phone_dnc_registry_broken");
      const r = await svc<{ eligible: boolean; block_reason: string }>(db, "select * from public.fn_norma_eligibility($1,$2,$3)", [
        l.property, l.contact, l.phone,
      ]);
      expect(r.rows[0]).toEqual({ eligible: false, block_reason: "eligibility_check_failed" });
    });
  });

  it("create_request is atomic: one open request per lead, pauses recorded, blocked requests leave nothing", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const a = await create(db, ctx, l);
      expect(a.outcome).toBe("created");
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect((await one<{ n: string }>(db, "select count(*) n from public.norma_enrollment_pauses where request_id=$1", [a.request_id])).n).toBe("1");
      expect((await one<{ n: string }>(db, "select count(*) n from public.lead_events where property_id=$1 and event_type='norma_call_requested'", [l.property])).n).toBe("1");

      // Button hammer: every further request for the same lead returns the open one.
      for (let i = 0; i < 5; i++) {
        const dup = await create(db, ctx, l);
        expect(dup.outcome).toBe("already_open");
        expect(dup.request_id).toBe(a.request_id);
      }
      expect((await one<{ n: string }>(db, "select count(*) n from public.norma_call_requests where property_id=$1", [l.property])).n).toBe("1");

      const blocked = await lead(db, ctx, { dispo: "not_interested" });
      const b = await create(db, ctx, blocked);
      expect(b).toMatchObject({ outcome: "blocked", block_reason: "not_interested", request_id: null });
      expect((await one<{ n: string }>(db, "select count(*) n from public.norma_call_requests where property_id=$1", [blocked.property])).n).toBe("0");
      expect(await enrollmentState(db, blocked.enrollment!)).toEqual({ status: "active", pause_reason: null });

      const outsider = randomUUID();
      await db.query("insert into auth.users(id) values ($1)", [outsider]);
      const l2 = await lead(db, ctx);
      const r = await svc<{ outcome: string; block_reason: string }>(db, "select * from public.fn_norma_create_request($1,$2,$3,$4,null,$5)", [
        l2.property, l2.contact, l2.phone, outsider, ctx.assignee,
      ]);
      expect(r.rows[0]).toMatchObject({ outcome: "blocked", block_reason: "requester_not_member" });
    });
  });

  it("transitions are monotonic and nothing leaves completed", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const { request_id: id } = await create(db, ctx, l);
      const setStatus = async (status: string, extra = "") => {
        await db.query("savepoint t");
        try {
          await db.query(`update public.norma_call_requests set status=$2 ${extra} where id=$1`, [id, status]);
          return null;
        } catch (e) {
          await db.query("rollback to savepoint t");
          return (e as { code?: string }).code;
        }
      };
      // requested cannot jump ahead
      expect(await setStatus("dispatched")).toBe("23514");
      expect(await setStatus("completed", ", outcome='no_answer', completed_at=now()")).toBe("23514");
      expect(await setStatus("needs_review")).toBe("23514");

      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [id!])).rows[0]!.c).toBe(true);
      // second claim loses
      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [id!])).rows[0]!.c).toBe(false);
      expect(await setStatus("requested")).toBe("23514");

      const callId = `call-${randomUUID()}`;
      await svc(db, "select public.fn_norma_bind_call_id($1,$2)", [id!, callId]);
      // dispatched cannot go back or sideways
      expect(await setStatus("dispatching")).toBe("23514");
      expect(await setStatus("dispatch_unknown")).toBe("23514");
      expect(await setStatus("dispatch_rejected")).toBe("23514");

      await complete(db, id!, callId, "no_answer");
      // completed is final: no status, outcome, id or completed_at change
      for (const s of ["requested", "dispatching", "dispatched", "dispatch_unknown", "needs_review", "dispatch_rejected"]) {
        expect(await setStatus(s)).toBe("23514");
      }
      await db.query("savepoint o");
      await expect(db.query("update public.norma_call_requests set outcome='wrong_number' where id=$1", [id])).rejects.toMatchObject({ code: "23514" });
      await db.query("rollback to savepoint o");
      await db.query("savepoint c");
      await expect(db.query("update public.norma_call_requests set bland_call_id='other' where id=$1", [id])).rejects.toMatchObject({ code: "23514" });
      await db.query("rollback to savepoint c");

      // bind never overwrites a completed request
      const bound = await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2) as b", [id!, "late-id"]);
      expect(bound.rows[0]!.b).toBe("already_completed");
      expect((await one<{ bland_call_id: string }>(db, "select bland_call_id from public.norma_call_requests where id=$1", [id])).bland_call_id).toBe(callId);

      // dispatch_rejected is terminal too, and only a no-call request can reach it
      const l2 = await lead(db, ctx);
      const r2 = (await create(db, ctx, l2)).request_id!;
      await svc(db, "select public.fn_norma_claim_dispatch($1)", [r2]);
      expect((await svc<{ s: string }>(db, "select public.fn_norma_mark_dispatch_rejected($1,'bad') as s", [r2])).rows[0]!.s).toBe("dispatch_rejected");
      await db.query("savepoint r");
      await expect(db.query("update public.norma_call_requests set status='dispatching' where id=$1", [r2])).rejects.toMatchObject({ code: "23514" });
      await db.query("rollback to savepoint r");

      // Identity columns are frozen.
      await db.query("savepoint i");
      await expect(db.query("update public.norma_call_requests set phone_e164='+18165550000' where id=$1", [r2])).rejects.toMatchObject({ code: "23514" });
      await db.query("rollback to savepoint i");
    });
  });

  it("dispatch helpers: unknown/needs_review fences, rejected releases owned pauses, unknown never regresses a bound call", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await svc(db, "select public.fn_norma_claim_dispatch($1)", [id]);
      expect((await svc<{ s: string }>(db, "select public.fn_norma_mark_dispatch_unknown($1,'timeout') as s", [id])).rows[0]!.s).toBe("dispatch_unknown");
      // An unresolved attempt still blocks a redial and keeps the pause.
      expect((await create(db, ctx, l)).outcome).toBe("already_open");
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });

      // The id arrives late: dispatch_unknown -> dispatched.
      await svc(db, "select public.fn_norma_bind_call_id($1,'late')", [id]);
      expect((await one<{ status: string }>(db, "select status from public.norma_call_requests where id=$1", [id])).status).toBe("dispatched");
      // A stale 'unknown' write cannot regress it.
      expect((await svc<{ s: string }>(db, "select public.fn_norma_mark_dispatch_unknown($1,'x') as s", [id])).rows[0]!.s).toBe("dispatched");
      // A bound call can never be 'rejected'.
      expect((await svc<{ s: string }>(db, "select public.fn_norma_mark_dispatch_rejected($1,'x') as s", [id])).rows[0]!.s).toBe("dispatched");
      // A different id is refused.
      expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,'different') as b", [id])).rows[0]!.b).toBe("call_id_conflict");

      // Rejection of a never-created call releases the pause.
      const l2 = await lead(db, ctx);
      const id2 = (await create(db, ctx, l2)).request_id!;
      await svc(db, "select public.fn_norma_claim_dispatch($1)", [id2]);
      await svc(db, "select public.fn_norma_mark_dispatch_rejected($1,'4xx')", [id2]);
      expect(await enrollmentState(db, l2.enrollment!)).toEqual({ status: "active", pause_reason: null });
      expect((await create(db, ctx, l2)).outcome).toBe("created");
    });
  });

  it("completion is replay-safe: one event, one notification, one task, no second effect", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id);
      const payload = {
        summary: "Wants cash soon",
        qualification: { timeline: "30 days" },
        callback_requested_for: "2026-10-05T15:00:00Z",
        callback_timezone: "America/Chicago",
        callback_raw: "Monday at 10",
      };
      const first = await complete(db, id, callId, "callback_requested", payload);
      expect(first).toMatchObject({ result: "applied", status: "completed", outcome: "callback_requested" });
      for (let i = 0; i < 4; i++) {
        expect(await complete(db, id, callId, "callback_requested", payload)).toMatchObject({ result: "replayed" });
      }
      // A replay with a different outcome changes nothing.
      expect(await complete(db, id, callId, "no_answer")).toMatchObject({ result: "replayed", outcome: "callback_requested" });
      // A different call id for a completed or bound request is refused with no effects.
      expect(await complete(db, id, "someone-else", "wrong_number")).toMatchObject({ result: "call_id_mismatch" });

      const tasks = (await db.query("select type,assignee_id,due_at,title,status from public.tasks where related_property_id=$1", [l.property])).rows;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ type: "callback", assignee_id: ctx.assignee, status: "open" });
      expect(new Date(tasks[0].due_at).toISOString()).toBe("2026-10-05T15:00:00.000Z");
      expect(tasks[0].title).toMatch(/unconfirmed/i);
      expect((await one<{ n: string }>(db, "select count(*) n from public.lead_events where property_id=$1 and event_type='norma_call_completed'", [l.property])).n).toBe("1");
      expect((await one<{ n: string }>(db, "select count(*) n from public.norma_notifications where request_id=$1", [id])).n).toBe("1");
      // Callback keeps the drip paused.
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      const row = await one<{ qualification: unknown; callback_timezone: string; status: string }>(db, "select qualification,callback_timezone,status from public.norma_call_requests where id=$1", [id]);
      expect(row).toMatchObject({ qualification: { timeline: "30 days" }, callback_timezone: "America/Chicago", status: "completed" });
    });
  });

  it("completion accepts the webhook before the id is stored, and rejects a request that never dispatched", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      // still `requested`: not completable
      expect(await complete(db, id, "c1", "no_answer")).toMatchObject({ result: "invalid_state", status: "requested" });
      await svc(db, "select public.fn_norma_claim_dispatch($1)", [id]);
      // webhook beats the send-call response
      expect(await complete(db, id, "c1", "no_answer")).toMatchObject({ result: "applied", status: "completed" });
      // the late bind is a no-op
      expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,'c1') as b", [id])).rows[0]!.b).toBe("already_completed");
      expect(await complete(db, id, "", "no_answer")).toMatchObject({ result: "call_id_required" });
      expect(await svcError(db, "select public.fn_norma_complete_call($1,'c',$2,'{}')", [id, "bogus"])).toMatchObject({ code: "22023" });
    });
  });

  it("completion from needs_review reconciles the single review task (retitle, or close)", async () => {
    await withDb(async (db, ctx) => {
      // escalation -> late callback completion -> replay
      const a = await lead(db, ctx);
      const ida = (await create(db, ctx, a)).request_id!;
      const callA = await dispatched(db, ida);
      expect((await svc<{ s: string }>(db, "select public.fn_norma_mark_needs_review($1,'stuck') as s", [ida])).rows[0]!.s).toBe("needs_review");
      // idempotent escalation
      await svc(db, "select public.fn_norma_mark_needs_review($1,'stuck again')", [ida]);
      let tasks = (await db.query("select id,type,title,status from public.tasks where related_property_id=$1", [a.property])).rows;
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toMatch(/needs review/i);
      const reviewTaskId = tasks[0].id;
      // still blocks a redial and keeps the pause
      expect((await create(db, ctx, a)).outcome).toBe("already_open");
      expect(await enrollmentState(db, a.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });

      expect(await complete(db, ida, callA, "callback_requested", { callback_raw: "tomorrow" })).toMatchObject({ result: "applied" });
      tasks = (await db.query("select id,type,title,status from public.tasks where related_property_id=$1", [a.property])).rows;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ id: reviewTaskId, type: "callback", status: "open" });
      expect(tasks[0].title).not.toMatch(/needs review/i);
      expect(await complete(db, ida, callA, "callback_requested")).toMatchObject({ result: "replayed" });
      expect((await db.query("select 1 from public.tasks where related_property_id=$1", [a.property])).rowCount).toBe(1);

      // escalation -> late no_answer closes the review task and releases the drip
      const b = await lead(db, ctx);
      const idb = (await create(db, ctx, b)).request_id!;
      const callB = await dispatched(db, idb);
      await svc(db, "select public.fn_norma_mark_needs_review($1,'stuck')", [idb]);
      expect(await complete(db, idb, callB, "no_answer")).toMatchObject({ result: "applied", released: 1 });
      expect((await db.query("select status from public.tasks where related_property_id=$1", [b.property])).rows).toEqual([{ status: "cancelled" }]);
      expect(await enrollmentState(db, b.enrollment!)).toEqual({ status: "active", pause_reason: null });
    });
  });

  it("a late real outcome reopens a review task a human already closed", async () => {
    await withDb(async (db, ctx) => {
      for (const closed of ["completed", "cancelled"]) {
        const l = await lead(db, ctx);
        const id = (await create(db, ctx, l)).request_id!;
        const callId = await dispatched(db, id);
        await svc(db, "select public.fn_norma_mark_needs_review($1,'stuck')", [id]);
        await db.query("update public.tasks set status=$2, completed_at=case when $2='completed' then now() end where related_property_id=$1", [l.property, closed]);
        expect(await complete(db, id, callId, "callback_requested", { callback_requested_for: "2026-10-06T14:00:00Z" })).toMatchObject({ result: "applied" });
        const rows = (await db.query("select status,type,due_at,completed_at,title from public.tasks where related_property_id=$1", [l.property])).rows;
        expect(rows, closed).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "open", type: "callback", completed_at: null });
        expect(new Date(rows[0].due_at).toISOString()).toBe("2026-10-06T14:00:00.000Z");
        expect(rows[0].title).not.toMatch(/needs review/i);
      }
    });
  });

  it("phone ownership: formatted US numbers match in full; non-US or ambiguous numbers never do", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const el = (phone: string) =>
        svc<{ eligible: boolean; block_reason: string | null }>(db, "select * from public.fn_norma_eligibility($1,$2,$3)", [l.property, l.contact, phone]).then((r) => r.rows[0]!);
      const store = (v: string) => db.query("update public.contacts set phone_1=$2 where id=$1", [l.contact, v]);
      for (const stored of ["(816) 555-0142", "816-555-0142", "+18165550142", "1 (816) 555-0142", "18165550142"]) {
        await store(stored);
        expect(await el("+18165550142"), stored).toEqual({ eligible: true, block_reason: null });
        expect((await el("+18165550143")).block_reason, stored).toBe("phone_not_on_contact");
      }
      // a non-US dialled number is refused outright, even if its last 10 digits match
      await store("(207) 946-0958");
      expect((await el("+442079460958")).block_reason).toBe("invalid_request");
      expect((await el("+12079460958")).eligible).toBe(true);
      // a contact storing a non-US number: the US look-alike is refused
      await store("+442079460958");
      expect((await el("+12079460958")).block_reason).toBe("phone_not_on_contact");
      // short or odd stored values are ignored, not suffix-matched
      await store("555-0142");
      expect((await el("+18165550142")).block_reason).toBe("phone_not_on_contact");
      await store("+1 816 555 0142 ext 9");
      expect((await el("+18165550142")).block_reason).toBe("phone_not_on_contact");
    });
  });

  it("an unmapped result parks the request in needs_review with a task, keeps the hold, and a later real outcome still applies once", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id);
      expect(await complete(db, id, callId, "unknown", { summary: "garbled" })).toMatchObject({ result: "applied", status: "needs_review" });
      expect(await complete(db, id, callId, "unknown")).toMatchObject({ result: "replayed" });
      const row = await one<{ status: string; outcome: string }>(db, "select status,outcome from public.norma_call_requests where id=$1", [id]);
      expect(row).toEqual({ status: "needs_review", outcome: "unknown" });
      expect((await db.query("select 1 from public.tasks where related_property_id=$1", [l.property])).rowCount).toBe(1);
      expect((await db.query("select 1 from public.norma_notifications where request_id=$1", [id])).rowCount).toBe(0);
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect((await create(db, ctx, l)).outcome).toBe("already_open");
      expect(await complete(db, id, callId, "reached_no_callback")).toMatchObject({ result: "applied", status: "completed" });
      expect((await db.query("select 1 from public.tasks where related_property_id=$1", [l.property])).rowCount).toBe(1);
    });
  });

  it("task cardinality is outcome specific: one for callback/reached/wrong_number/unknown, none for no_answer/not_interested", async () => {
    await withDb(async (db, ctx) => {
      const expected: Record<string, { tasks: number; type?: string }> = {
        no_answer: { tasks: 0 },
        not_interested: { tasks: 0 },
        callback_requested: { tasks: 1, type: "callback" },
        reached_no_callback: { tasks: 1, type: "callback" },
        wrong_number: { tasks: 1, type: "custom" },
        unknown: { tasks: 1, type: "custom" },
      };
      for (const [outcome, want] of Object.entries(expected)) {
        const l = await lead(db, ctx);
        const id = (await create(db, ctx, l)).request_id!;
        const callId = await dispatched(db, id);
        await complete(db, id, callId, outcome);
        await complete(db, id, callId, outcome); // replay
        const rows = (await db.query("select type,assignee_id,due_at from public.tasks where related_property_id=$1", [l.property])).rows;
        expect(rows, outcome).toHaveLength(want.tasks);
        if (want.type) expect(rows[0]).toMatchObject({ type: want.type, assignee_id: ctx.assignee });
        expect(
          (await one<{ n: string }>(db, "select count(*) n from public.lead_events where property_id=$1 and event_type='norma_call_completed'", [l.property])).n,
          outcome,
        ).toBe(outcome === "unknown" ? "0" : "1");
      }
    });
  });

  it("not_interested writes the disposition itself, keeps the pause, and never downgrades DNC or stronger dispositions", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id);
      await complete(db, id, callId, "not_interested");
      expect((await one<{ outreach_dispo: string; is_dnc_locked: boolean }>(db, "select outreach_dispo,is_dnc_locked from public.properties where id=$1", [l.property]))).toEqual({
        outreach_dispo: "not_interested",
        is_dnc_locked: false,
      });
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect((await one<{ n: string }>(db, "select count(*) n from public.lead_events where property_id=$1 and event_type='dispo_set'", [l.property])).n).toBe("1");
      expect((await create(db, ctx, l)).block_reason).toBe("not_interested");

      // DNC arrives while the call is in flight (lead locks, enrollment opts out).
      const d = await lead(db, ctx);
      const idd = (await create(db, ctx, d)).request_id!;
      const callD = await dispatched(db, idd);
      await db.query("update public.sequence_enrollments set status='opted_out',pause_reason='dnc',next_run_at=null where id=$1", [d.enrollment]);
      await db.query("update public.properties set outreach_dispo='dnc' where id=$1", [d.property]);
      expect(await complete(db, idd, callD, "not_interested")).toMatchObject({ result: "applied", status: "completed" });
      expect((await one<{ outreach_dispo: string; is_dnc_locked: boolean }>(db, "select outreach_dispo,is_dnc_locked from public.properties where id=$1", [d.property]))).toEqual({
        outreach_dispo: "dnc",
        is_dnc_locked: true,
      });
      expect(await enrollmentState(db, d.enrollment!)).toEqual({ status: "opted_out", pause_reason: "dnc" });
      expect((await one<{ n: string }>(db, "select count(*) n from public.lead_events where property_id=$1 and event_type='dispo_set'", [d.property])).n).toBe("0");

      // Contact-level DNC without the property lock yet: still no disposition write.
      const c = await lead(db, ctx);
      const idc = (await create(db, ctx, c)).request_id!;
      const callC = await dispatched(db, idc);
      await db.query("alter table public.contacts disable trigger user");
      await db.query("update public.contacts set do_not_contact=true where id=$1", [c.contact]);
      await db.query("alter table public.contacts enable trigger user");
      await complete(db, idc, callC, "not_interested");
      expect((await one<{ outreach_dispo: string | null }>(db, "select outreach_dispo from public.properties where id=$1", [c.property])).outreach_dispo).toBeNull();

      // Terminal dispositions are preserved (opted_out, wrong_number, bad_number).
      for (const dispo of ["opted_out", "wrong_number", "bad_number"]) {
        const t = await lead(db, ctx, { enrollment: null });
        // not_interested eligibility is irrelevant here: these dispositions do not block the request.
        const idt = (await create(db, ctx, t)).request_id!;
        const callT = await dispatched(db, idt);
        await db.query("update public.properties set outreach_dispo=$2 where id=$1", [t.property, dispo]);
        await complete(db, idt, callT, "not_interested");
        expect((await one<{ outreach_dispo: string }>(db, "select outreach_dispo from public.properties where id=$1", [t.property])).outreach_dispo).toBe(dispo);
      }
    });
  });

  it("wrong_number flags only that number: no property disposition, drip stays held, task created, number never dialled again", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id);
      await complete(db, id, callId, "wrong_number", { summary: "not the owner" });
      expect((await one<{ outreach_dispo: string | null }>(db, "select outreach_dispo from public.properties where id=$1", [l.property])).outreach_dispo).toBeNull();
      expect((await db.query("select 1 from public.lead_events where property_id=$1 and event_type='dispo_set'", [l.property])).rowCount).toBe(0);
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      const task = await one<{ description: string; assignee_id: string }>(db, "select description,assignee_id from public.tasks where related_property_id=$1", [l.property]);
      expect(task.description).toContain(l.phone);
      expect(task.assignee_id).toBe(ctx.assignee);
      // the same number is refused afterwards, on this lead and on any other lead that holds it
      expect((await create(db, ctx, l)).block_reason).toBe("wrong_number_flagged");
      // another number on the same lead is still callable
      const second = nextPhone();
      await db.query("update public.contacts set phone_2=$2, phone_2_type='mobile' where id=$1", [l.contact, second]);
      const r = await svc<{ outcome: string }>(db, "select * from public.fn_norma_create_request($1,$2,$3,$4,null,$5)", [l.property, l.contact, second, ctx.rep, ctx.assignee]);
      expect(r.rows[0]!.outcome).toBe("created");
    });
  });

  it("a hold-keeping outcome also pauses an enrollment created in the check-then-write gap", async () => {
    await withDb(async (db, ctx) => {
      for (const outcome of ["callback_requested", "reached_no_callback", "not_interested", "wrong_number"]) {
        const l = await lead(db, ctx, { enrollment: null });
        const id = (await create(db, ctx, l)).request_id!;
        const callId = await dispatched(db, id);
        // a drip sneaks in while the request is open
        const sneaky = (await db.query<{ id: string }>(
          "insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,next_run_at) values ($1,$2,$3,$4,'active',now()) returning id",
          [ctx.org, ctx.sequence, l.property, l.contact],
        )).rows[0]!.id;
        await complete(db, id, callId, outcome);
        expect(await enrollmentState(db, sneaky), outcome).toEqual({ status: "paused", pause_reason: "norma_call" });
      }
      // no_answer is different: nothing of ours to release, the new drip keeps running
      const l = await lead(db, ctx, { enrollment: null });
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id);
      const e = (await db.query<{ id: string }>("insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,next_run_at) values ($1,$2,$3,$4,'active',now()) returning id", [ctx.org, ctx.sequence, l.property, l.contact])).rows[0]!.id;
      await complete(db, id, callId, "no_answer");
      expect(await enrollmentState(db, e)).toEqual({ status: "active", pause_reason: null });
    });
  });

  it("owned-pause release: confirmed no_answer resumes only still-owned pauses; reply, takeover, DNC and disposition changes are preserved", async () => {
    await withDb(async (db, ctx) => {
      const plain = await lead(db, ctx);
      const replied = await lead(db, ctx);
      const takeover = await lead(db, ctx);
      const dnc = await lead(db, ctx);
      const dispoChanged = await lead(db, ctx);
      const terminal = await lead(db, ctx);
      const calls = new Map<string, { id: string; call: string }>();
      for (const [name, l] of Object.entries({ plain, replied, takeover, dnc, dispoChanged, terminal })) {
        const id = (await create(db, ctx, l)).request_id!;
        calls.set(name, { id, call: await dispatched(db, id) });
      }
      // Intervening events while the hold is open.
      await svc(db, "select public.fn_norma_upgrade_pauses_for_reply($1,'inbound_reply')", [replied.property]);
      await svc(db, "select public.fn_norma_upgrade_pauses_for_reply($1,'rep_sms_human_takeover')", [takeover.property]);
      await db.query("update public.sequence_enrollments set status='opted_out',pause_reason='dnc',next_run_at=null where id=$1", [dnc.enrollment]);
      await db.query("update public.properties set outreach_dispo='dnc' where id=$1", [dnc.property]);
      await db.query("update public.properties set outreach_dispo='nurture' where id=$1", [dispoChanged.property]);
      await db.query("update public.sequence_enrollments set pause_reason='status_terminal' where id=$1", [terminal.enrollment]);

      for (const { id, call } of calls.values()) {
        expect(await complete(db, id, call, "no_answer")).toMatchObject({ result: "applied" });
      }
      expect(await enrollmentState(db, plain.enrollment!)).toEqual({ status: "active", pause_reason: null });
      expect(await enrollmentState(db, replied.enrollment!)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
      expect(await enrollmentState(db, takeover.enrollment!)).toEqual({ status: "paused", pause_reason: "rep_sms_human_takeover" });
      expect(await enrollmentState(db, dnc.enrollment!)).toEqual({ status: "opted_out", pause_reason: "dnc" });
      expect(await enrollmentState(db, dispoChanged.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await enrollmentState(db, terminal.enrollment!)).toEqual({ status: "paused", pause_reason: "status_terminal" });
      const results = (
        await db.query<{ n: string; release_result: string }>(
          "select release_result, count(*) n from public.norma_enrollment_pauses group by 1 order by 1",
        )
      ).rows;
      expect(Object.fromEntries(results.map((r) => [r.release_result, Number(r.n)]))).toMatchObject({
        resumed: 1,
        reason_changed: 4,
        not_eligible: 1,
      });
      // releasing again is a no-op
      expect((await svc<{ n: number }>(db, "select public.fn_norma_release_pauses($1) as n", [calls.get("plain")!.id])).rows[0]!.n).toBe(0);
    });
  });

  it("reached outcomes keep the drip paused", async () => {
    await withDb(async (db, ctx) => {
      for (const outcome of ["callback_requested", "reached_no_callback", "not_interested", "wrong_number"]) {
        const l = await lead(db, ctx);
        const id = (await create(db, ctx, l)).request_id!;
        await complete(db, id, await dispatched(db, id), outcome);
        expect(await enrollmentState(db, l.enrollment!), outcome).toEqual({ status: "paused", pause_reason: "norma_call" });
      }
    });
  });

  it("softphone pause under a Norma hold (ordering test): cleanup and the stale sweep do not resume; no_answer lets the sweep resume; reached keeps it paused", async () => {
    await withDb(async (db, ctx) => {
      const sweepIds = (l: Lead) => [l.enrollment];
      const resume = async (l: Lead, expected: string | null) =>
        (await svc<{ outcome: string }>(db, "select outcome from public.resume_sequence_enrollment($1,null,$2)", [l.enrollment, expected])).rows[0]!.outcome;
      const sweep = async (l: Lead) =>
        (await svc<{ n: number }>(db, "select public.sweep_resume_call_in_progress($1::uuid[], now()) as n", [sweepIds(l)])).rows[0]!.n;

      // 1. existing softphone pause -> Norma request (not owned: stays call_in_progress)
      const a = await lead(db, ctx, { enrollment: "paused:call_in_progress" });
      const reqA = (await create(db, ctx, a)).request_id!;
      expect(await enrollmentState(db, a.enrollment!)).toEqual({ status: "paused", pause_reason: "call_in_progress" });
      expect((await one<{ n: string }>(db, "select count(*) n from public.norma_enrollment_pauses where request_id=$1", [reqA])).n).toBe("0");
      const callA = await dispatched(db, reqA);
      // 2. softphone cleanup and stale sweep must not resume
      expect(await resume(a, "call_in_progress")).toBe("norma_hold");
      expect(await sweep(a)).toBe(0);
      expect(await enrollmentState(db, a.enrollment!)).toEqual({ status: "paused", pause_reason: "call_in_progress" });
      // 3. a manual resume is refused too (whatever the reason)
      expect(await resume(a, null)).toBe("norma_hold");
      // 4. Norma no_answer: nothing of ours to release, softphone pause untouched...
      await complete(db, reqA, callA, "no_answer");
      expect(await enrollmentState(db, a.enrollment!)).toEqual({ status: "paused", pause_reason: "call_in_progress" });
      // ...and the existing sweep picks it up afterwards
      expect(await sweep(a)).toBe(1);
      expect(await enrollmentState(db, a.enrollment!)).toEqual({ status: "active", pause_reason: null });

      // 5. Norma reached the seller: the non-owned softphone pause is converted and stays paused
      const b = await lead(db, ctx, { enrollment: "paused:call_in_progress" });
      const reqB = (await create(db, ctx, b)).request_id!;
      await complete(db, reqB, await dispatched(db, reqB), "reached_no_callback");
      expect(await enrollmentState(db, b.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await resume(b, "call_in_progress")).toBe("pause_reason_changed");
      expect(await sweep(b)).toBe(0);
      expect(await enrollmentState(db, b.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
    });
  });

  it("manual resume of an owned pause is refused during the hold and works after a confirmed no_answer is released elsewhere", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const resume = async () =>
        (await svc<{ outcome: string }>(db, "select outcome from public.resume_sequence_enrollment($1,null,null)", [l.enrollment])).rows[0]!.outcome;
      expect(await resume()).toBe("norma_hold");
      const callId = await dispatched(db, id);
      expect(await resume()).toBe("norma_hold");
      await complete(db, id, callId, "reached_no_callback");
      // hold over, drip stays paused as norma_call; a human may now resume it
      expect(await resume()).toBe("resumed");
    });
  });

  it("Retry on a provider_failed pause is refused during a Norma hold (enrollment stays paused) and works once the hold ends", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx, { enrollment: "paused:provider_failed" });
      const retry = async () =>
        (await svc<{ outcome: string }>(db, "select outcome from public.retry_sequence_step($1,null)", [l.enrollment])).rows[0]!.outcome;
      const id = (await create(db, ctx, l)).request_id!;
      expect(await retry()).toBe("norma_hold");
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "provider_failed" });
      const callId = await dispatched(db, id);
      expect(await retry()).toBe("norma_hold");
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "provider_failed" });
      await complete(db, id, callId, "no_answer");
      expect(await retry()).toBe("retried");
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "active", pause_reason: null });
    });
  });

  it("[I1] ordering test: cleanup selects -> reply upgrades -> Norma no-answer -> cleanup RPC: the reply pause survives", async () => {
    await withDb(async (db, ctx) => {
      for (const reason of ["inbound_reply", "rep_sms_human_takeover"] as const) {
        // existing softphone pause, then a Norma request
        const l = await lead(db, ctx, { enrollment: "paused:call_in_progress" });
        const id = (await create(db, ctx, l)).request_id!;
        const callId = await dispatched(db, id);
        // cleanup SELECTs its candidates (reason call_in_progress) ...
        const candidates = (await db.query("select id from public.sequence_enrollments where property_id=$1 and status='paused' and pause_reason='call_in_progress'", [l.property])).rows;
        expect(candidates).toHaveLength(1);
        // ... a seller reply (or rep takeover) lands and upgrades the pause ...
        expect((await svc<{ n: number }>(db, "select public.fn_norma_upgrade_pauses_for_reply($1,$2) as n", [l.property, reason])).rows[0]!.n).toBe(1);
        // ... Norma confirms no-answer, ending the hold ...
        await complete(db, id, callId, "no_answer");
        // ... and only then does cleanup call the RPC with its expected reason.
        const out = await svc<{ outcome: string }>(db, "select outcome from public.resume_sequence_enrollment($1,null,'call_in_progress')", [candidates[0].id]);
        expect(out.rows[0]!.outcome).toBe("pause_reason_changed");
        expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: reason });
        // the stale sweep (which only touches call_in_progress) leaves it alone as well
        expect((await svc<{ n: number }>(db, "select public.sweep_resume_call_in_progress($1::uuid[], now()) as n", [[l.enrollment]])).rows[0]!.n).toBe(0);
        expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: reason });
      }
    });
  });

  it("[H1] reply/takeover upgrade only applies under an open hold and never overrides terminal or DNC reasons", async () => {
    await withDb(async (db, ctx) => {
      const noHold = await lead(db, ctx, { enrollment: "paused:norma_call" });
      expect((await svc<{ n: number }>(db, "select public.fn_norma_upgrade_pauses_for_reply($1,'inbound_reply') as n", [noHold.property])).rows[0]!.n).toBe(0);
      expect(await enrollmentState(db, noHold.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });

      for (const reason of ["status_terminal", "consent_revoked", "status_acquisition_active", "appointment_booked", "provider_failed"]) {
        const l = await lead(db, ctx, { enrollment: `paused:${reason}` });
        await create(db, ctx, l);
        await svc(db, "select public.fn_norma_upgrade_pauses_for_reply($1,'inbound_reply')", [l.property]);
        expect((await enrollmentState(db, l.enrollment!)).pause_reason, reason).toBe(reason);
      }
      const owned = await lead(db, ctx);
      await create(db, ctx, owned);
      expect((await svc<{ n: number }>(db, "select public.fn_norma_upgrade_pauses_for_reply($1,'inbound_reply') as n", [owned.property])).rows[0]!.n).toBe(1);
      expect(await enrollmentState(db, owned.enrollment!)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
      expect(await svcError(db, "select public.fn_norma_upgrade_pauses_for_reply($1,'dnc')", [owned.property])).toMatchObject({ code: "22023" });
    });
  });

  it("resume RPC without a hold keeps its existing behaviour (expected reason is optional)", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx, { enrollment: "paused:inbound_reply" });
      const run = async (expected: string | null) =>
        (await svc<{ outcome: string }>(db, "select outcome from public.resume_sequence_enrollment($1,null,$2)", [l.enrollment, expected])).rows[0]!.outcome;
      expect(await run("call_in_progress")).toBe("pause_reason_changed");
      expect(await run(null)).toBe("resumed");
      expect(await run(null)).toBe("not_paused");
      // the original two-argument call shape still works
      const l2 = await lead(db, ctx, { enrollment: "paused:inbound_reply" });
      const r = await svc<{ outcome: string }>(db, "select outcome from public.resume_sequence_enrollment($1,null)", [l2.enrollment]);
      expect(r.rows[0]!.outcome).toBe("resumed");
    });
  });

  it("a signed-in member's resume is refused under a hold, via the existing RPC grants", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const asMember = async () => {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [ctx.rep]);
        try {
          return (await db.query<{ outcome: string }>("select outcome from public.resume_sequence_enrollment($1,$2,null)", [l.enrollment, ctx.rep])).rows[0]!.outcome;
        } finally {
          await db.query("reset role");
        }
      };
      expect(await asMember()).toBe("norma_hold");
      await complete(db, id, await dispatched(db, id), "reached_no_callback");
      expect(await asMember()).toBe("resumed");
    });
  });

  it("completion is one transaction: an injected failure rolls every effect back", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id);
      await db.query(
        `create function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$`,
      );
      await db.query("create trigger boom before insert on public.norma_notifications for each row execute function pg_temp.boom()");
      await db.query("savepoint attempt");
      await db.query("set local role service_role");
      await db.query("select set_config('request.jwt.claim.role','service_role',true)");
      await expect(db.query("select public.fn_norma_complete_call($1,$2,'wrong_number','{}')", [id, callId])).rejects.toThrow(/injected/);
      await db.query("rollback to savepoint attempt");
      await db.query("reset role");
      expect((await one<{ status: string; outcome: string | null }>(db, "select status,outcome from public.norma_call_requests where id=$1", [id]))).toEqual({ status: "dispatched", outcome: null });
      expect((await db.query("select 1 from public.tasks where related_property_id=$1", [l.property])).rowCount).toBe(0);
      expect((await one<{ outreach_dispo: string | null }>(db, "select outreach_dispo from public.properties where id=$1", [l.property])).outreach_dispo).toBeNull();
      expect((await db.query("select 1 from public.lead_events where property_id=$1 and event_type in ('norma_call_completed','dispo_set')", [l.property])).rowCount).toBe(0);
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      // and a retry after the fault clears still completes exactly once
      await db.query("drop trigger boom on public.norma_notifications");
      expect(await complete(db, id, callId, "wrong_number")).toMatchObject({ result: "applied" });
    });
  });

  it("tasks.source_key is unique per org", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const ins = () =>
        db.query(
          "insert into public.tasks(org_id,assignee_id,related_property_id,type,title,due_at,created_by,source_key) values ($1,$2,$3,'custom','t',now(),$2,'k1')",
          [ctx.org, ctx.assignee, l.property],
        );
      await ins();
      await db.query("savepoint dup");
      await expect(ins()).rejects.toMatchObject({ code: "23505" });
      await db.query("rollback to savepoint dup");
      // null source keys stay unconstrained
      await db.query("insert into public.tasks(org_id,assignee_id,related_property_id,type,title,due_at,created_by) values ($1,$2,$3,'custom','a',now(),$2),($1,$2,$3,'custom','b',now(),$2)", [ctx.org, ctx.assignee, l.property]);
    });
  });

  it("every function is service-role only; authenticated members can only read requests", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const calls = [
        "select public.fn_norma_hold_active($1)",
        "select * from public.fn_norma_eligibility($1,$1,'+18165550100')",
        "select public.fn_norma_pause_for_request($1)",
        "select public.fn_norma_release_pauses($1)",
        "select * from public.fn_norma_create_request($1,$1,'+18165550100',$1,null,$1)",
        "select public.fn_norma_claim_dispatch($1)",
        "select public.fn_norma_bind_call_id($1,'x')",
        "select public.fn_norma_mark_dispatch_rejected($1,'x')",
        "select public.fn_norma_mark_dispatch_unknown($1,'x')",
        "select public.fn_norma_mark_needs_review($1,'x')",
        "select public.fn_norma_complete_call($1,'x','no_answer','{}')",
        "select public.fn_norma_upgrade_pauses_for_reply($1,'inbound_reply')",
        "select public.sweep_resume_call_in_progress(array[$1]::uuid[], now())",
      ];
      for (const role of ["authenticated", "anon"]) {
        for (const sql of calls) {
          expect(await svcError(db, sql, [id], role), `${role}: ${sql}`).toMatchObject({ code: "42501" });
        }
      }
      // writes are not granted to authenticated either
      expect(await svcError(db, "update public.norma_call_requests set summary='x'", [], "authenticated")).toMatchObject({ code: "42501" });
      expect(await svcError(db, "select * from public.norma_notifications", [], "authenticated")).toMatchObject({ code: "42501" });
      expect(await svcError(db, "select * from public.norma_enrollment_pauses", [], "authenticated")).toMatchObject({ code: "42501" });
      // an active member can read requests in their org
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [ctx.rep]);
      expect((await db.query("select id from public.norma_call_requests where id=$1", [id])).rowCount).toBe(1);
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [randomUUID()]);
      expect((await db.query("select id from public.norma_call_requests where id=$1", [id])).rowCount).toBe(0);
      await db.query("reset role");
    });
  });
});
