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
const migration = [
  "20261002120000_norma_call_requests.sql",
  "20261002120100_norma_m2_hardening.sql",
  "20261002120200_norma_m2_review_fixes.sql",
].map(load).join("\n");

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

const one = async <T extends Record<string, unknown>>(db: Client, sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]!;

async function enrollmentState(db: Client, id: string) {
  return one<{ status: string; pause_reason: string | null }>(
    db,
    "select status, pause_reason from public.sequence_enrollments where id=$1",
    [id],
  );
}

describe("norma m2 review fixes", () => {
  const rejected = async (db: Client, id: string, expected: string | null) =>
    (
      await svc<{ r: string }>(db, "select public.fn_norma_mark_dispatch_rejected($1,'why',$2) as r", [id, expected])
    ).rows[0]!.r;

  it("close-while-dispatching: an expected-requested rejection cannot close a claimed row", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      // Another dispatcher claims between the caller's read and its close.
      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [id])).rows[0]!.c).toBe(true);
      expect(await rejected(db, id, "requested")).toBe("dispatching");
      expect((await one<{ status: string }>(db, "select status from public.norma_call_requests where id=$1", [id])).status).toBe("dispatching");
      expect(l.enrollment && (await enrollmentState(db, l.enrollment))).toEqual({ status: "paused", pause_reason: "norma_call" });
      // Post-claim paths (no expectation) keep the old semantics.
      expect(await rejected(db, id, null)).toBe("dispatch_rejected");
    });
  });

  it("an expected-requested rejection still closes a row that is still requested and releases its pauses", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      expect(await rejected(db, id, "requested")).toBe("dispatch_rejected");
      expect(l.enrollment && (await enrollmentState(db, l.enrollment))).toEqual({ status: "active", pause_reason: null });
    });
  });

  it("the old two-argument call shape still works (default expected status)", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await svc(db, "select public.fn_norma_claim_dispatch($1)", [id]);
      const r = await svc<{ r: string }>(db, "select public.fn_norma_mark_dispatch_rejected($1,'why') as r", [id]);
      expect(r.rows[0]!.r).toBe("dispatch_rejected");
    });
  });

  it("pushing next_check_at out does not touch updated_at; real changes still do", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await db.query("alter table public.norma_call_requests disable trigger norma_call_requests_guard");
      await db.query("update public.norma_call_requests set updated_at = now() - interval '1 hour' where id=$1", [id]);
      await db.query("alter table public.norma_call_requests enable trigger norma_call_requests_guard");
      const sel = "select updated_at, next_check_at from public.norma_call_requests where id=$1";
      const before = await one<{ updated_at: Date; next_check_at: Date }>(db, sel, [id]);
      await svc(db, "update public.norma_call_requests set next_check_at = now() + interval '10 minutes' where id=$1", [id]);
      const after = await one<{ updated_at: Date; next_check_at: Date }>(db, sel, [id]);
      expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
      expect(after.next_check_at.getTime()).toBeGreaterThan(before.next_check_at.getTime());
      await svc(db, "select public.fn_norma_claim_dispatch($1)", [id]);
      const claimed = await one<{ updated_at: Date }>(db, "select updated_at from public.norma_call_requests where id=$1", [id]);
      expect(claimed.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    });
  });

  it("new rows are immediately due for a check", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const r = await one<{ due: boolean }>(db, "select next_check_at <= now() as due from public.norma_call_requests where id=$1", [id]);
      expect(r.due).toBe(true);
    });
  });
});
