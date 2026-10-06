import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";
import { applyMyLeadsChain } from "@tests/integration/my-leads-housekeeping-fixture";

// Local-only: every test runs inside one transaction that is rolled back, so
// the loopback database is left as it was found. The migrations are replayed
// inside the transaction.
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const load = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8")
    .replace(/^\s*begin;\s*$/gim, "")
    .replace(/^\s*commit;\s*$/gim, "");
const migration = [
  "20261002120000_norma_call_requests.sql",
  "20261002120100_norma_m2_hardening.sql",
  "20261002120200_norma_m2_review_fixes.sql",
  "20261002120300_norma_dnc_lock_task_writes.sql",
  "20261002120400_norma_create_request_serialize.sql",
  "20261002120500_norma_lock_order.sql",
  "20261008090100_norma_retry_next_step_union_reviewed.sql",
].map(load).join("\n");

type Ctx = {
  org: string;
  rep: string;
  rep2: string;
  assignee: string;
  outsider: string;
  suspended: string;
  otherOrg: string;
  otherOrgMember: string;
  sequence: string;
};
type Lead = { property: string; contact: string; phone: string; enrollment: string | null };

let phoneCounter = 0;
const nextPhone = () => `+1816556${String(1000 + (phoneCounter++ % 9000)).padStart(4, "0")}`;

async function withDb(fn: (db: Client, ctx: Ctx) => Promise<void>) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await applyMyLeadsChain(db, []);
    await applyMyLeadsChain(db, ["schema", "createFn"]);
    await db.query(migration);
    const ctx: Ctx = {
      org: randomUUID(), rep: randomUUID(), rep2: randomUUID(), assignee: randomUUID(), outsider: randomUUID(),
      suspended: randomUUID(), otherOrg: randomUUID(), otherOrgMember: randomUUID(), sequence: randomUUID(),
    };
    await db.query("insert into auth.users(id) values ($1), ($2), ($3), ($4), ($5), ($6)", [
      ctx.rep, ctx.rep2, ctx.assignee, ctx.outsider, ctx.suspended, ctx.otherOrgMember,
    ]);
    await db.query("insert into public.organizations(id,name) values ($1,'norma test'), ($2,'other org')", [ctx.org, ctx.otherOrg]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [ctx.assignee, ctx.org]);
    for (const rep of [ctx.rep, ctx.rep2]) {
      await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','active')", [rep, ctx.org]);
    }
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','suspended')", [ctx.suspended, ctx.org]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [ctx.otherOrgMember, ctx.otherOrg]);
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

const one = async <T extends Record<string, unknown>>(db: Client, sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]!;
const count = async (db: Client, sql: string, params: unknown[]) => Number((await one<{ n: string }>(db, sql, params)).n);

async function create(db: Client, ctx: Ctx, l: Lead) {
  const r = await svc<{ outcome: string; request_id: string | null }>(
    db,
    "select * from public.fn_norma_create_request($1,$2,$3,$4,$5,$6)",
    [l.property, l.contact, l.phone, ctx.rep, "ctx", ctx.assignee],
  );
  return r.rows[0]!;
}
const claim = async (db: Client, id: string) =>
  (await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [id])).rows[0]!.c;
const bind = async (db: Client, id: string, callId: string) =>
  (await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2) as b", [id, callId])).rows[0]!.b;
const complete = async (db: Client, id: string, callId: string, outcome: string) =>
  (await svc<{ r: Record<string, unknown> }>(db, "select public.fn_norma_complete_call($1,$2,$3,'{}'::jsonb) as r", [id, callId, outcome])).rows[0]!.r;
const review = async (db: Client, requestId: string, property: string, user: string | null) =>
  (await svc<{ r: Record<string, unknown> }>(db, "select public.fn_norma_mark_reviewed($1,$2,$3) as r", [requestId, property, user])).rows[0]!.r;
const hold = async (db: Client, property: string) =>
  (await svc<{ h: boolean }>(db, "select public.fn_norma_hold_active($1) as h", [property])).rows[0]!.h;
const enrollmentState = (db: Client, id: string) =>
  one<{ status: string; pause_reason: string | null }>(db, "select status, pause_reason from public.sequence_enrollments where id=$1", [id]);
const rowOf = (db: Client, id: string) =>
  one<{ status: string; outcome: string | null; reviewed_by: string | null; reviewed_at: string | null; completed_at: string | null; bland_call_id: string | null }>(
    db,
    "select status, outcome, reviewed_by, reviewed_at, completed_at, bland_call_id from public.norma_call_requests where id=$1",
    [id],
  );
const reviewEvents = (db: Client, id: string) =>
  count(db, "select count(*) as n from public.lead_events where event_type='norma_call_reviewed' and payload->>'request_id'=$1", [id]);
const reviewTask = (db: Client, id: string) =>
  one<{ status: string; completed_by: string | null; completed_at: string | null }>(
    db,
    "select status, completed_by, completed_at from public.tasks where source_key=$1",
    [`norma_call:${id}`],
  );

/** A request parked in needs_review (the call result did not map to a known outcome), with its open review task. */
async function parked(db: Client, ctx: Ctx, opts: Parameters<typeof lead>[2] = {}, callId = "call-1") {
  const l = await lead(db, ctx, opts);
  const id = (await create(db, ctx, l)).request_id!;
  expect(await claim(db, id)).toBe(true);
  expect(await bind(db, id, callId)).toBe("bound");
  expect(await complete(db, id, callId, "unknown")).toMatchObject({ status: "needs_review", outcome: "unknown" });
  return { l, id };
}

describe("norma mark reviewed (migration 20261008090100)", () => {
  it("moves needs_review to completed/reviewed, records who and when, closes the task, writes one event", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx);
      expect(await hold(db, l.property)).toBe(true);
      expect(await reviewTask(db, id)).toMatchObject({ status: "open" });

      expect(await review(db, id, l.property, ctx.rep)).toMatchObject({ result: "reviewed", status: "completed", task_closed: true });

      const row = await rowOf(db, id);
      expect(row).toMatchObject({ status: "completed", outcome: "reviewed", reviewed_by: ctx.rep, bland_call_id: "call-1" });
      expect(row.reviewed_at).not.toBeNull();
      expect(row.completed_at).not.toBeNull();
      expect(await reviewTask(db, id)).toMatchObject({ status: "completed", completed_by: ctx.rep });
      expect(await hold(db, l.property)).toBe(false);

      const ev = await one<{ actor_type: string; actor_id: string; payload: Record<string, unknown> }>(
        db,
        "select actor_type, actor_id, payload from public.lead_events where event_type='norma_call_reviewed' and payload->>'request_id'=$1",
        [id],
      );
      expect(ev).toMatchObject({ actor_type: "user", actor_id: ctx.rep });
      expect(ev.payload).toMatchObject({ request_id: id, previous_outcome: "unknown", task_closed: true, drips_kept_paused: 1 });
      // Nothing about this is a call result: no completion event, no Slack row.
      expect(await count(db, "select count(*) as n from public.lead_events where event_type='norma_call_completed' and payload->>'request_id'=$1", [id])).toBe(0);
      expect(await count(db, "select count(*) as n from public.norma_notifications where request_id=$1", [id])).toBe(0);
    });
  });

  it("keeps the drip paused: nothing resumes, and the request's own pause rows can never be released later", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx);
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      await review(db, id, l.property, ctx.rep);
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      expect(await count(db, "select count(*) as n from public.lead_events where event_type='sequence_resumed' and property_id=$1", [l.property])).toBe(0);
      expect(await one(db, "select release_result from public.norma_enrollment_pauses where request_id=$1", [id])).toEqual({ release_result: "kept_paused_reviewed" });
      // A later release attempt (any caller) is a no-op.
      const released = await svc<{ n: number }>(db, "select public.fn_norma_release_pauses($1) as n", [id]);
      expect(released.rows[0]!.n).toBe(0);
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
    });
  });

  it("a softphone pause or a drip that appeared while the call was parked is held, not resumed", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx, { enrollment: null });
      const softphone = (
        await db.query<{ id: string }>(
          "insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,pause_reason,next_run_at) values ($1,$2,$3,$4,'paused','call_in_progress',now()) returning id",
          [ctx.org, ctx.sequence, l.property, l.contact],
        )
      ).rows[0]!.id;
      await review(db, id, l.property, ctx.rep);
      expect(await enrollmentState(db, softphone)).toEqual({ status: "paused", pause_reason: "norma_call" });
    });
  });

  it("is idempotent: a replay, from the same or another member, changes nothing and still succeeds", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx);
      await review(db, id, l.property, ctx.rep);
      const first = await rowOf(db, id);
      for (const user of [ctx.rep, ctx.rep2, ctx.rep]) {
        expect(await review(db, id, l.property, user)).toMatchObject({ result: "already_reviewed", status: "completed" });
      }
      expect(await rowOf(db, id)).toEqual(first);
      expect(first.reviewed_by).toBe(ctx.rep);
      expect(await reviewEvents(db, id)).toBe(1);
    });
  });

  it("fails closed on authorisation: no user, a stranger, another org's member, a suspended member", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx);
      for (const user of [null, randomUUID(), ctx.outsider, ctx.otherOrgMember, ctx.suspended]) {
        expect(await review(db, id, l.property, user)).toMatchObject({ result: "not_authorized" });
      }
      expect(await rowOf(db, id)).toMatchObject({ status: "needs_review", outcome: "unknown", reviewed_by: null, reviewed_at: null });
      expect(await reviewTask(db, id)).toMatchObject({ status: "open" });
      expect(await reviewEvents(db, id)).toBe(0);
      expect(await hold(db, l.property)).toBe(true);
    });
  });

  it("a request that does not exist, or whose property does not match, is not found", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx);
      const other = await lead(db, ctx, { enrollment: null });
      expect(await review(db, randomUUID(), l.property, ctx.rep)).toMatchObject({ result: "not_found" });
      expect(await review(db, id, other.property, ctx.rep)).toMatchObject({ result: "not_found" });
      expect(await review(db, id, randomUUID(), ctx.rep)).toMatchObject({ result: "not_found" });
      expect((await rowOf(db, id)).status).toBe("needs_review");
    });
  });

  it("only service_role may call it (a member's own session, anon, and public are refused)", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx);
      for (const role of ["authenticated", "anon"]) {
        await db.query("savepoint s");
        await db.query(`set local role ${role}`);
        await expect(db.query("select public.fn_norma_mark_reviewed($1,$2,$3)", [id, l.property, ctx.rep])).rejects.toMatchObject({ code: "42501" });
        await db.query("rollback to savepoint s");
        await db.query("reset role");
      }
      const meta = await one<{ secdef: boolean; config: string[] | null }>(
        db,
        "select prosecdef as secdef, proconfig as config from pg_proc where proname='fn_norma_mark_reviewed'",
      );
      expect(meta.secdef).toBe(true);
      expect(meta.config).toContain("search_path=public, pg_temp");
      expect((await rowOf(db, id)).status).toBe("needs_review");
    });
  });

  it.each([
    ["requested", async () => undefined],
    ["dispatching", async (db: Client, id: string) => void (await claim(db, id))],
    ["dispatched", async (db: Client, id: string) => void ((await claim(db, id)), await bind(db, id, "call-1"))],
  ])("refuses a request that is %s (not parked for review)", async (status, prep) => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await prep(db, id);
      expect(await review(db, id, l.property, ctx.rep)).toMatchObject({ result: "invalid_state", status });
      expect((await rowOf(db, id)).status).toBe(status);
      expect(await hold(db, l.property)).toBe(true);
      expect(await reviewEvents(db, id)).toBe(0);
    });
  });

  it("refuses dispatch_unknown, dispatch_rejected and a call that already completed with its own outcome", async () => {
    await withDb(async (db, ctx) => {
      const a = await lead(db, ctx);
      const unknownId = (await create(db, ctx, a)).request_id!;
      await claim(db, unknownId);
      await svc(db, "select public.fn_norma_mark_dispatch_unknown($1,'timeout')", [unknownId]);
      expect(await review(db, unknownId, a.property, ctx.rep)).toMatchObject({ result: "invalid_state", status: "dispatch_unknown" });

      const b = await lead(db, ctx);
      const rejectedId = (await create(db, ctx, b)).request_id!;
      await claim(db, rejectedId);
      await svc(db, "select public.fn_norma_mark_dispatch_rejected($1,'bad number')", [rejectedId]);
      expect(await review(db, rejectedId, b.property, ctx.rep)).toMatchObject({ result: "invalid_state", status: "dispatch_rejected" });

      const c = await lead(db, ctx);
      const doneId = (await create(db, ctx, c)).request_id!;
      await claim(db, doneId);
      await bind(db, doneId, "call-9");
      await complete(db, doneId, "call-9", "not_interested");
      expect(await review(db, doneId, c.property, ctx.rep)).toMatchObject({ result: "invalid_state", status: "completed" });
      expect(await rowOf(db, doneId)).toMatchObject({ status: "completed", outcome: "not_interested", reviewed_by: null });

      expect((await rowOf(db, unknownId)).status).toBe("dispatch_unknown");
      expect((await rowOf(db, rejectedId)).status).toBe("dispatch_rejected");
    });
  });

  it.each([["property lock", "lock"], ["contact do-not-contact flag", "contact"]] as const)(
    "on a do-not-contact lead (%s) the request still completes and the task guard's refusal leaves the task as it is",
    async (_label, how) => {
      await withDb(async (db, ctx) => {
        const { l, id } = await parked(db, ctx);
        if (how === "lock") await db.query("update public.properties set is_dnc_locked = true, outreach_dispo = 'dnc' where id = $1", [l.property]);
        else await db.query("update public.contacts set do_not_contact = true where id = $1", [l.contact]);
        // The guard really does refuse a task write now.
        await db.query("savepoint probe");
        await expect(db.query("update public.tasks set status='completed' where source_key=$1", [`norma_call:${id}`])).rejects.toThrow(/DNC_LOCKED/);
        await db.query("rollback to savepoint probe");

        expect(await review(db, id, l.property, ctx.rep)).toMatchObject({ result: "reviewed", status: "completed", task_closed: false });
        expect(await rowOf(db, id)).toMatchObject({ status: "completed", outcome: "reviewed", reviewed_by: ctx.rep });
        expect(await reviewTask(db, id)).toMatchObject({ status: "open", completed_by: null });
        expect((await reviewEvents(db, id))).toBe(1);
        expect(await review(db, id, l.property, ctx.rep)).toMatchObject({ result: "already_reviewed" });
      });
    },
  );

  it("a new Norma request is allowed again afterwards (normal eligibility still applies), and pauses the drip again", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx);
      expect((await create(db, ctx, l)).outcome).toBe("already_open");
      await review(db, id, l.property, ctx.rep);
      const second = await create(db, ctx, l);
      expect(second.outcome).toBe("created");
      expect(second.request_id).not.toBe(id);
      expect(await hold(db, l.property)).toBe(true);
      expect(await enrollmentState(db, l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      // The reviewed request is untouched by the new one.
      expect(await rowOf(db, id)).toMatchObject({ status: "completed", outcome: "reviewed", reviewed_by: ctx.rep });
    });
  });

  it("review does not bypass eligibility: a lead that became do-not-contact cannot be called again", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx);
      await review(db, id, l.property, ctx.rep);
      await db.query("update public.properties set is_dnc_locked = true, outreach_dispo = 'dnc' where id = $1", [l.property]);
      expect(await create(db, ctx, l)).toMatchObject({ outcome: "blocked" });
    });
  });

  it("handles the review/provider race with one terminal winner and no resume or Slack side effect", async () => {
    await withDb(async (db, ctx) => {
      const reviewedFirst = await parked(db, ctx);
      expect(await review(db, reviewedFirst.id, reviewedFirst.l.property, ctx.rep)).toMatchObject({ result: "reviewed", status: "completed" });
      expect(await complete(db, reviewedFirst.id, "call-1", "callback_requested")).toMatchObject({ result: "replayed" });
      expect(await reviewEvents(db, reviewedFirst.id)).toBe(1);
      expect(await count(db, "select count(*) as n from public.norma_notifications where request_id=$1", [reviewedFirst.id])).toBe(0);
      expect(await count(db, "select count(*) as n from public.lead_events where event_type='sequence_resumed' and property_id=$1", [reviewedFirst.l.property])).toBe(0);
      expect((await svc<{ n: number }>(db, "select public.fn_norma_release_pauses($1) as n", [reviewedFirst.id])).rows[0]!.n).toBe(0);
      expect(await enrollmentState(db, reviewedFirst.l.enrollment!)).toEqual({ status: "paused", pause_reason: "norma_call" });

      const providerFirst = await parked(db, ctx, {}, "call-2");
      expect(await complete(db, providerFirst.id, "call-2", "callback_requested")).toMatchObject({ result: "applied", status: "completed", outcome: "callback_requested" });
      expect(await review(db, providerFirst.id, providerFirst.l.property, ctx.rep)).toMatchObject({ result: "invalid_state", status: "completed" });
      expect(await reviewEvents(db, providerFirst.id)).toBe(0);
      expect(await count(db, "select count(*) as n from public.norma_notifications where request_id=$1", [providerFirst.id])).toBe(1);
    });
  });

  it("a late Bland result for the reviewed call is a no-op: it cannot overwrite the review or open a task", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx);
      await review(db, id, l.property, ctx.rep);
      const before = await rowOf(db, id);
      for (const outcome of ["callback_requested", "no_answer", "unknown"]) {
        expect(await complete(db, id, "call-1", outcome)).toMatchObject({ result: "replayed", status: "completed", outcome: "reviewed" });
      }
      expect(await rowOf(db, id)).toEqual(before);
      expect(await reviewTask(db, id)).toMatchObject({ status: "completed" });
      expect(await count(db, "select count(*) as n from public.norma_notifications where request_id=$1", [id])).toBe(0);
    });
  });

  it("'reviewed' can only come from this function: Bland cannot report it, and the row rules hold", async () => {
    await withDb(async (db, ctx) => {
      const { l, id } = await parked(db, ctx);
      await db.query("savepoint s1");
      await db.query("set local role service_role");
      await db.query("select set_config('request.jwt.claim.role','service_role',true)");
      await expect(db.query("select public.fn_norma_complete_call($1,'call-1','reviewed','{}'::jsonb)", [id])).rejects.toMatchObject({ code: "22023" });
      await db.query("rollback to savepoint s1");
      await db.query("reset role");
      // The outcome and the review stamp come together or not at all.
      await db.query("savepoint s2");
      await expect(db.query("update public.norma_call_requests set status='completed', outcome='reviewed', completed_at=now() where id=$1", [id])).rejects.toMatchObject({ code: "23514" });
      await db.query("rollback to savepoint s2");
      await db.query("savepoint s3");
      await expect(db.query("update public.norma_call_requests set reviewed_at=now() where id=$1", [id])).rejects.toMatchObject({ code: "23514" });
      await db.query("rollback to savepoint s3");
      await review(db, id, l.property, ctx.rep);
      // A reviewed request is final like any completed one.
      await db.query("savepoint s4");
      await expect(db.query("update public.norma_call_requests set status='needs_review' where id=$1", [id])).rejects.toThrow(/NORMA_TRANSITION/);
      await db.query("rollback to savepoint s4");
    });
  });
});
