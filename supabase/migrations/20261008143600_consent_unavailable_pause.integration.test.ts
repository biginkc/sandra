import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * consent_unavailable pause (20261008143600). Local-only; every test runs in a
 * transaction that is rolled back. Applies only this migration on top of the
 * already-migrated local database (resume_sequence_enrollment from
 * 20261002120000 must be present).
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const MIGRATION = readFileSync(path.join(__dirname, "20261008143600_consent_unavailable_pause.sql"), "utf8")
  .replace(/^\s*begin;\s*$/gim, "")
  .replace(/^\s*commit;\s*$/gim, "");

type Ctx = { enrollment: string };

async function withDb(fn: (db: Client, ctx: Ctx) => Promise<void>) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await db.query(MIGRATION);
    const org = randomUUID();
    const sequence = randomUUID();
    const property = randomUUID();
    const contact = randomUUID();
    await db.query("insert into public.organizations(id,name) values ($1,'consent unavailable')", [org]);
    await db.query("insert into public.sequences(id,org_id,name) values ($1,$2,'drip')", [sequence, org]);
    await db.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','hi')", [sequence]);
    await db.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Seller','+18165571234','mobile')", [contact, org]);
    await db.query("insert into public.properties(id,org_id,address,state,status,homeowner_contact_id) values ($1,$2,'1 Main St','MO','new_lead',$3)", [property, org, contact]);
    const enrollment = (await db.query<{ id: string }>(
      "insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,next_run_at) values ($1,$2,$3,$4,'active',now()) returning id",
      [org, sequence, property, contact],
    )).rows[0]!.id;
    await fn(db, { enrollment });
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}

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

async function pauseConsentUnavailable(db: Client, enrollment: string, withDeferredRows: number) {
  const step = (await db.query<{ id: string }>(
    "select st.id from public.sequence_steps st join public.sequence_enrollments e on e.sequence_id = st.sequence_id where e.id = $1 and st.step_index = e.current_step_index",
    [enrollment],
  )).rows[0]!.id;
  for (let i = 0; i < withDeferredRows; i += 1) {
    await db.query(
      `insert into public.sequence_step_runs (enrollment_id, step_id, claim_active, attempt_outcome, failure_reason, recovery_action, run_at, scheduled_for)
       select e.id, $2, false, 'not_attempted', 'consent_unavailable', 'consent_unavailable_deferred', now(), now()
         from public.sequence_enrollments e where e.id = $1`,
      [enrollment, step],
    );
  }
  await db.query(
    "update public.sequence_enrollments set status='paused', pause_reason='consent_unavailable', next_run_at=now() - interval '1 hour' where id=$1",
    [enrollment],
  );
}

const resume = (db: Client, enrollment: string) =>
  svc<{ outcome: string; next_run_at: string | null }>(db, "select * from public.resume_sequence_enrollment($1)", [enrollment]);

describe("consent_unavailable pause reason", () => {
  it("resumes a paused consent_unavailable enrollment and schedules next_run_at", async () => {
    await withDb(async (db, ctx) => {
      const l = { enrollment: ctx.enrollment };
      await pauseConsentUnavailable(db, l.enrollment, 12);
      const r = (await resume(db, l.enrollment)).rows[0]!;
      expect(r.outcome).toBe("resumed");
      expect(r.next_run_at).not.toBeNull();
      expect((await db.query("select status, pause_reason, next_run_at from public.sequence_enrollments where id=$1", [l.enrollment])).rows[0]).toMatchObject({ status: "active", pause_reason: null, next_run_at: expect.any(Date) });
    });
  });

  it("relabels the earlier outage's deferred rows so they stop counting toward the next cap", async () => {
    await withDb(async (db, ctx) => {
      const l = { enrollment: ctx.enrollment };
      await pauseConsentUnavailable(db, l.enrollment, 12);
      await resume(db, l.enrollment);
      const rows = (await db.query("select recovery_action, count(*)::int n from public.sequence_step_runs where enrollment_id=$1 group by 1", [l.enrollment])).rows;
      expect(rows).toEqual([{ recovery_action: "consent_unavailable_resumed", n: 12 }]);
    });
  });

  it("still refuses plain resume for reconciliation_required and provider_failed", async () => {
    await withDb(async (db, ctx) => {
      for (const reason of ["reconciliation_required", "provider_failed"]) {
        const l = { enrollment: ctx.enrollment };
        await db.query("update public.sequence_enrollments set status='paused', pause_reason=$2 where id=$1", [l.enrollment, reason]);
        expect((await resume(db, l.enrollment)).rows[0]!.outcome).toBe("retry_required");
      }
    });
  });

  it("adds ai_reply_dead_letters.resolution_reason with a service_role column grant when the table exists", async () => {
    await withDb(async (db, ctx) => {
      void ctx;
      await db.query("drop table if exists public.ai_reply_dead_letters cascade");
      await db.query("create table public.ai_reply_dead_letters (id uuid primary key default gen_random_uuid(), resolved_at timestamptz)");
      await db.query("grant select on table public.ai_reply_dead_letters to service_role");
      await db.query(MIGRATION);
      expect((await db.query("select is_nullable from information_schema.columns where table_name='ai_reply_dead_letters' and column_name='resolution_reason'")).rows[0]?.is_nullable).toBe("YES");
      const id = (await db.query("insert into public.ai_reply_dead_letters default values returning id")).rows[0].id;
      await svc(db, "update public.ai_reply_dead_letters set resolution_reason='unreconcilable:no_reply' where id=$1", [id]);
      expect((await db.query("select resolution_reason from public.ai_reply_dead_letters where id=$1", [id])).rows[0].resolution_reason).toBe("unreconcilable:no_reply");
    });
  });
});
