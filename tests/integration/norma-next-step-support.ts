// Shared fixtures for the P1a-writers Norma integration tests. Local-only: every test runs in
// one transaction that is rolled back. The whole Norma migration chain is replayed, then the
// P1a-core next-step schema and fn_create_next_step, then the P1a-writers Norma migrations.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { expect } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const dir = `${path.join(process.cwd(), "supabase/migrations")}/`;
export const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
export const load = (file: string, base = dir) =>
  readFileSync(`${base}${file}`, "utf8").replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");

const NORMA_BEFORE = readdirSync(dir)
  .filter((f) => /^\d{14}_norma_.+\.sql$/.test(f) && f < "20261005")
  .sort();
const CORE = ["20261005120000_next_step_schema.sql", "20261005120500_fn_create_next_step.sql"];
export const WRITERS = ["20261005130400_norma_complete_call_next_step.sql", "20261005130500_norma_needs_review_next_step.sql"];
export const ROLLBACKS = WRITERS.map((f) => `../rollbacks/${f}`);
export const migrations = (writers: string[] = WRITERS) => [...NORMA_BEFORE, ...CORE, ...writers].map((f) => load(f)).join("\n");

export type Ctx = { org: string; rep: string; assignee: string; sequence: string };
export type Lead = { property: string; contact: string; phone: string; enrollment: string | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

let phoneCounter = 0;
const nextPhone = () => `+1816557${String(1000 + (phoneCounter++ % 9000)).padStart(4, "0")}`;

export async function withDb(fn: (db: Client, ctx: Ctx) => Promise<void>, sql = migrations()) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await db.query(sql);
    const ctx: Ctx = { org: randomUUID(), rep: randomUUID(), assignee: randomUUID(), sequence: randomUUID() };
    await db.query("insert into auth.users(id) values ($1), ($2)", [ctx.rep, ctx.assignee]);
    await db.query("insert into public.organizations(id,name) values ($1,'norma next step')", [ctx.org]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [ctx.assignee, ctx.org]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','active')", [ctx.rep, ctx.org]);
    await db.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)", [ctx.org]);
    await db.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Norma drip')", [ctx.sequence, ctx.org]);
    await db.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','hi')", [ctx.sequence]);
    await fn(db, ctx);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}

export async function lead(db: Client, ctx: Ctx, opts: { dnc?: boolean } = {}): Promise<Lead> {
  const property = randomUUID();
  const contact = randomUUID();
  const phone = nextPhone();
  await db.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Seller',$3,'mobile')", [contact, ctx.org, phone]);
  await db.query(
    "insert into public.properties(id,org_id,address,state,status,homeowner_contact_id) values ($1,$2,$3,'MO','new_lead',$4)",
    [property, ctx.org, `${property.slice(0, 6)} Main St`, contact],
  );
  const enrollment = (
    await db.query<{ id: string }>(
      "insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,next_run_at) values ($1,$2,$3,$4,'active',now()) returning id",
      [ctx.org, ctx.sequence, property, contact],
    )
  ).rows[0]!.id;
  if (opts.dnc) {
    await db.query("set local session_replication_role='replica'");
    await db.query("update public.contacts set do_not_contact=true where id=$1", [contact]);
    await db.query("update public.properties set is_dnc_locked=true where id=$1", [property]);
    await db.query("set local session_replication_role='origin'");
  }
  return { property, contact, phone, enrollment };
}

export async function svc<T extends Record<string, unknown> = Record<string, unknown>>(db: Client, sql: string, params: unknown[] = []) {
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role','service_role',true)");
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claim.role','',true)");
  }
}

export async function create(db: Client, ctx: Ctx, l: Lead) {
  const r = await svc<{ outcome: string; request_id: string | null }>(db, "select * from public.fn_norma_create_request($1,$2,$3,$4,$5,$6)", [l.property, l.contact, l.phone, ctx.rep, "ctx", ctx.assignee]);
  return r.rows[0]!;
}

export async function dispatched(db: Client, requestId: string, callId = `call-${randomUUID()}`) {
  expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [requestId])).rows[0]!.c).toBe(true);
  expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2) as b", [requestId, callId])).rows[0]!.b).toBe("bound");
  return callId;
}

export async function complete(db: Client, requestId: string, callId: string, outcome: string, payload: Record<string, unknown> = {}) {
  const r = await svc<{ r: Json }>(db, "select public.fn_norma_complete_call($1,$2,$3,$4::jsonb) as r", [requestId, callId, outcome, JSON.stringify(payload)]);
  return r.rows[0]!.r as Json;
}

export const tasksFor = async (db: Client, property: string) =>
  (await db.query("select * from public.tasks where related_property_id=$1 order by created_at, id", [property])).rows as Json[];
