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
const load = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8")
    .replace(/^\s*begin;\s*$/gim, "")
    .replace(/^\s*commit;\s*$/gim, "");
const migration = `${load("20261002120000_norma_call_requests.sql")}\n${load("20261002120100_norma_m2_hardening.sql")}`;

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

describe("norma m2 hardening", () => {
  it("eligibility: a '+' slot counts only when it is exactly +1 and ten digits", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const check = async (stored: string, dialled: string) => {
        await db.query("update public.contacts set phone_1=$1 where id=$2", [stored, l.contact]);
        return (
          await svc<{ eligible: boolean; block_reason: string | null }>(
            db,
            "select * from public.fn_norma_eligibility($1,$2,$3)",
            [l.property, l.contact, dialled],
          )
        ).rows[0]!;
      };
      // International number that is ten digits after '+': must NOT become +14412345678.
      expect(await check("+4412345678", "+14412345678")).toMatchObject({ eligible: false, block_reason: "phone_not_on_contact" });
      expect(await check("+44 1234 567890", "+14412345678")).toMatchObject({ eligible: false });
      // Genuine US shapes still match.
      expect(await check("+18165550142", "+18165550142")).toMatchObject({ eligible: true });
      expect(await check("+1 (816) 555-0142", "+18165550142")).toMatchObject({ eligible: true });
      expect(await check("(816) 555-0142", "+18165550142")).toMatchObject({ eligible: true });
      expect(await check("8165550142", "+18165550142")).toMatchObject({ eligible: true });
    });
  });

  it("hold-keeping completion writes the sequence_paused event for a drip created in the gap", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx, { enrollment: null });
      const req = await create(db, ctx, l);
      const id = req.request_id!;
      const callId = await dispatched(db, id);
      // Drip enrolled after the request opened (check-then-write gap).
      const gap = (
        await db.query<{ id: string }>(
          "insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,next_run_at) values ($1,$2,$3,$4,'active',now()) returning id",
          [ctx.org, ctx.sequence, l.property, l.contact],
        )
      ).rows[0]!.id;
      const res = await complete(db, id, callId, "reached_no_callback", {});
      expect(res.result).toBe("applied");
      expect(await enrollmentState(db, gap)).toEqual({ status: "paused", pause_reason: "norma_call" });
      const events = await db.query(
        "select payload from public.lead_events where property_id=$1 and event_type='sequence_paused' order by created_at",
        [l.property],
      );
      expect(events.rows.some((e) => e.payload.reason === "norma_call" && e.payload.count === 1)).toBe(true);
      // Replay writes nothing more.
      await complete(db, id, callId, "reached_no_callback", {});
      const again = await db.query("select 1 from public.lead_events where property_id=$1 and event_type='sequence_paused'", [l.property]);
      expect(again.rowCount).toBe(events.rowCount);
    });
  });
});
