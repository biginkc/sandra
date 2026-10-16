import { describe, expect, it } from "vitest";

import { complete, create, dispatched, lead, load, migrations, svc, tasksFor, withDb } from "@tests/integration/norma-next-step-support";

const UNION = load("20261008090100_norma_retry_next_step_union_reviewed.sql");
const RECOVERY = load("../rollbacks/20261008090100_norma_retry_next_step_union_reviewed.sql");
const SQL = `${migrations()}\n${UNION}`;

describe("operator-owned database retry admission", () => {
  it.each(["dispatching", "dispatched"])("defaults OFF and completes %s attempt one with baseline pause release", async (status) => {
    await withDb(async (db, ctx) => {
      expect((await db.query("select enabled from public.norma_retry_admission")).rows).toEqual([{ enabled: false }]);
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      expect((await db.query("select status,pause_reason from public.sequence_enrollments where id=$1", [l.enrollment])).rows[0]).toMatchObject({ status: "paused", pause_reason: "norma_call" });
      const call = `admission-off-${status}`;
      if (status === "dispatched") await dispatched(db, id, call);
      else expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [id])).rows[0].c).toBe(true);
      const result = await complete(db, id, call, "no_answer", { attempt: 1 });
      expect(result).toMatchObject({ result: "applied", status: "completed", outcome: "no_answer", released: 1 });
      expect(result).not.toHaveProperty("retry");
      expect((await db.query("select status,attempt,first_bland_call_id,bland_call_id from public.norma_call_requests where id=$1", [id])).rows[0]).toEqual({ status: "completed", attempt: 1, first_bland_call_id: null, bland_call_id: call });
      expect((await db.query("select status,pause_reason from public.sequence_enrollments where id=$1", [l.enrollment])).rows[0]).toMatchObject({ status: "active", pause_reason: null });
      expect(await tasksFor(db, l.property)).toHaveLength(0);
      expect((await db.query("select count(*)::int n from public.lead_events where property_id=$1 and event_type='norma_call_attempt_no_answer'", [l.property])).rows[0].n).toBe(0);
      expect((await db.query("select count(*)::int n from public.lead_events where property_id=$1 and event_type='norma_call_completed'", [l.property])).rows[0].n).toBe(1);
      expect(await complete(db, id, call, "no_answer", { attempt: 1 })).toMatchObject({ result: "replayed" });
    }, SQL);
  });

  it("fails closed when the singleton row is missing without breaking first-call completion", async () => {
    await withDb(async (db, ctx) => {
      await db.query("delete from public.norma_retry_admission");
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const call = await dispatched(db, id);
      expect(await complete(db, id, call, "no_answer", { attempt: 1 })).toMatchObject({ status: "completed", released: 1 });
    }, SQL);
  });

  it("allows exactly one explicitly enabled retry, keeps its holds, and settles attempt two normally", async () => {
    await withDb(async (db, ctx) => {
      await db.query("update public.norma_retry_admission set enabled=true where singleton=true");
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const call = await dispatched(db, id, "enabled-first");
      expect(await complete(db, id, call, "no_answer", { attempt: 1 })).toMatchObject({ result: "applied", status: "requested", retry: true });
      expect((await db.query("select status,pause_reason from public.sequence_enrollments where id=$1", [l.enrollment])).rows[0]).toMatchObject({ status: "paused", pause_reason: "norma_call" });
      expect((await db.query("select count(*)::int n from public.norma_enrollment_pauses where request_id=$1 and released_at is null", [id])).rows[0].n).toBe(1);
      expect(await tasksFor(db, l.property)).toHaveLength(0);
      expect(await complete(db, id, call, "no_answer", { attempt: 1 })).toMatchObject({ result: "replayed" });
      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1,2) as c", [id])).rows[0].c).toBe(true);
      expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,'enabled-second',2) as b", [id])).rows[0].b).toBe("bound");
      // OFF does not erase or abandon an already admitted attempt two.
      await db.query("update public.norma_retry_admission set enabled=false where singleton=true");
      expect(await complete(db, id, "enabled-second", "no_answer", { attempt: 2 })).toMatchObject({ status: "completed", released: 1 });
      expect((await db.query("select attempt,first_bland_call_id,bland_call_id from public.norma_call_requests where id=$1", [id])).rows[0]).toEqual({ attempt: 2, first_bland_call_id: call, bland_call_id: "enabled-second" });
      expect((await db.query("select count(*)::int n from public.lead_events where property_id=$1 and event_type='norma_call_attempt_no_answer'", [l.property])).rows[0].n).toBe(1);
    }, SQL);
  });

  it("keeps legacy omitted-attempt callers single-shot even when admission is enabled", async () => {
    await withDb(async (db, ctx) => {
      await db.query("update public.norma_retry_admission set enabled=true where singleton=true");
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const call = await dispatched(db, id);
      const result = await complete(db, id, call, "no_answer");
      expect(result).toMatchObject({ status: "completed", released: 1 });
      expect(result).not.toHaveProperty("retry");
    }, SQL);
  });

  it.each(["needs_review", "dispatch_unknown"])("never retries historical %s even when explicitly enabled", async (status) => {
    await withDb(async (db, ctx) => {
      await db.query("update public.norma_retry_admission set enabled=true where singleton=true");
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [id])).rows[0].c).toBe(true);
      await svc(db, status === "needs_review" ? "select public.fn_norma_mark_needs_review($1,'historical')" : "select public.fn_norma_mark_dispatch_unknown($1,'historical')", [id]);
      const result = await complete(db, id, "historical-call", "no_answer", { attempt: 1 });
      expect(result).toMatchObject({ status: "completed", released: 1 });
      expect(result).not.toHaveProperty("retry");
    }, SQL);
  });

  it("denies every application role any control-table read or mutation", async () => {
    await withDb(async (db) => {
      expect((await db.query("select relrowsecurity from pg_class where oid='public.norma_retry_admission'::regclass")).rows[0].relrowsecurity).toBe(true);
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const sql of ["select * from public.norma_retry_admission", "update public.norma_retry_admission set enabled=true", "insert into public.norma_retry_admission values(true,true)", "delete from public.norma_retry_admission", "truncate public.norma_retry_admission"]) {
          await db.query("savepoint permission_probe");
          await db.query(`set local role ${role}`);
          let code: string | undefined;
          try { await db.query(sql); } catch (error) { code = (error as { code: string }).code; }
          await db.query("rollback to savepoint permission_probe");
          expect(code, `${role}: ${sql}`).toBe("42501");
        }
      }
      expect((await db.query("select enabled from public.norma_retry_admission")).rows).toEqual([{ enabled: false }]);
    }, SQL);
  });

  it("also prevents direct service-role DML from bypassing the OFF scheduling boundary", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await dispatched(db, id, "direct-first");
      await db.query("savepoint direct_retry");
      await db.query("set local role service_role");
      await expect(db.query("update public.norma_call_requests set attempt=2,status='requested',first_attempt_outcome='no_answer',first_bland_call_id=bland_call_id,bland_call_id=null,dispatch_started_at=null where id=$1", [id])).rejects.toMatchObject({ code: "42501", message: "NORMA_RETRY_DISABLED: operator admission is OFF" });
      await db.query("rollback to savepoint direct_retry");
      expect((await db.query("select attempt,status,bland_call_id from public.norma_call_requests where id=$1", [id])).rows[0]).toEqual({ attempt: 1, status: "dispatched", bland_call_id: "direct-first" });
    }, SQL);
  });

  it.each([false, true])("rejects NULL retry classification rather than laundering an attempt transition (enabled=%s)", async (enabled) => {
    await withDb(async (db, ctx) => {
      await db.query("update public.norma_retry_admission set enabled=$1 where singleton=true", [enabled]);
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await dispatched(db, id, "null-first");
      await db.query("savepoint null_retry");
      await db.query("set local role service_role");
      await expect(db.query("update public.norma_call_requests set attempt=2,status='requested',first_attempt_outcome=null,first_bland_call_id=bland_call_id,bland_call_id=null,dispatch_started_at=null where id=$1", [id])).rejects.toMatchObject({ code: "23514" });
      await db.query("rollback to savepoint null_retry");
      expect((await db.query("select attempt,status,bland_call_id from public.norma_call_requests where id=$1", [id])).rows[0]).toEqual({ attempt: 1, status: "dispatched", bland_call_id: "null-first" });
    }, SQL);
  });

  it.each([false, true])("forward recovery preserves the operator's explicit enabled=%s decision", async (enabled) => {
    await withDb(async (db, ctx) => {
      await db.query("update public.norma_retry_admission set enabled=$1 where singleton=true", [enabled]);
      await db.query(RECOVERY);
      expect((await db.query("select enabled from public.norma_retry_admission")).rows).toEqual([{ enabled }]);
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const call = await dispatched(db, id);
      expect(await complete(db, id, call, "no_answer", { attempt: 1 })).toMatchObject(enabled ? { status: "requested", retry: true } : { status: "completed", released: 1 });
    }, SQL);
  });
});
