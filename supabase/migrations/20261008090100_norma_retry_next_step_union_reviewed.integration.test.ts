import { describe, expect, it } from "vitest";

import { complete, create, dispatched, lead, load, migrations, svc, tasksFor, withDb } from "@tests/integration/norma-next-step-support";

const UNION = load("20261008090100_norma_retry_next_step_union_reviewed.sql");
// Existing retry/fencing scenarios deliberately opt in in their rolled-back fixture.
// Dedicated admission tests exercise the unmodified default-OFF migration.
const ENABLE_RETRY = "update public.norma_retry_admission set enabled=true where singleton=true;";
const ROLLBACK = load("../rollbacks/20261008090100_norma_retry_next_step_union_reviewed.sql");

describe("Norma retry and My Leads next step union", () => {
  it("fences attempt one, completes attempt two into a phone appointment, and replays idempotently", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const first = await dispatched(db, id, "union-call-1");

      expect(await complete(db, id, first, "no_answer", { attempt: 1 })).toMatchObject({ retry: true, status: "requested" });
      expect(await complete(db, id, first, "callback_requested", { attempt: 1 })).toMatchObject({ result: "replayed" });
      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1,$2) as c", [id, 1])).rows[0]!.c).toBe(false);
      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1,$2) as c", [id, 2])).rows[0]!.c).toBe(true);
      expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2,$3) as b", [id, "stale-call", 1])).rows[0]!.b).toBe("stale_attempt");
      expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2,$3) as b", [id, "union-call-2", 2])).rows[0]!.b).toBe("bound");

      expect(await complete(db, id, "union-call-2", "callback_requested", {
        attempt: 2,
        callback_requested_for: "2030-10-06T14:00:00Z",
        callback_raw: "tomorrow",
      })).toMatchObject({ result: "applied", status: "completed" });
      expect(await complete(db, id, "union-call-2", "callback_requested", { attempt: 2 })).toMatchObject({ result: "replayed" });

      const tasks = await tasksFor(db, l.property);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ type: "appointment", mode: "phone", status: "open", source_key: `norma_call:${id}` });
      expect(tasks[0].description).toContain("tomorrow");
    }, `${migrations()}\n${UNION}\n${ENABLE_RETRY}`);
  });

  it("uses the shared review writer and preserves DNC read-only task behavior", async () => {
    await withDb(async (db, ctx) => {
      const reviewLead = await lead(db, ctx);
      const reviewId = (await create(db, ctx, reviewLead)).request_id!;
      await dispatched(db, reviewId, "union-review");
      expect((await svc<{ result: string }>(db, "select public.fn_norma_mark_needs_review($1,'uncertain') as result", [reviewId])).rows[0]!.result).toBe("needs_review");
      expect((await tasksFor(db, reviewLead.property))[0]).toMatchObject({ type: "custom", source_key: `norma_call:${reviewId}` });

      const dnc = await lead(db, ctx);
      const dncId = (await create(db, ctx, dnc)).request_id!;
      const dncCall = await dispatched(db, dncId, "union-dnc");
      await db.query("set local session_replication_role='replica'");
      await db.query("update public.contacts set do_not_contact=true where id=$1", [dnc.contact]);
      await db.query("update public.properties set is_dnc_locked=true where id=$1", [dnc.property]);
      await db.query("set local session_replication_role='origin'");
      expect(await complete(db, dncId, dncCall, "callback_requested", { callback_raw: "do not call" })).toMatchObject({ status: "completed", task_id: null });
      expect(await tasksFor(db, dnc.property)).toHaveLength(0);
    }, `${migrations()}\n${UNION}\n${ENABLE_RETRY}`);
  });

  it("requires explicit attempt one metadata for retry and rejects legacy mutators on attempt two", async () => {
    await withDb(async (db, ctx) => {
      const missing = await lead(db, ctx);
      const missingId = (await create(db, ctx, missing)).request_id!;
      const missingCall = await dispatched(db, missingId, "union-missing");
      const missingResult = await complete(db, missingId, missingCall, "no_answer");
      expect(missingResult).toMatchObject({ status: "completed" });
      expect(missingResult).not.toHaveProperty("retry");

      const invalid = await lead(db, ctx);
      const invalidId = (await create(db, ctx, invalid)).request_id!;
      const invalidCall = await dispatched(db, invalidId, "union-invalid");
      expect(await complete(db, invalidId, invalidCall, "no_answer", { attempt: "bogus" })).toMatchObject({ result: "stale_attempt" });

      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await dispatched(db, id, "union-first");
      expect(await complete(db, id, "union-first", "no_answer", { attempt: 1 })).toMatchObject({ retry: true, status: "requested" });

      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as c", [id])).rows[0]!.c).toBe(false);
      expect((await svc<{ r: string }>(db, "select public.fn_norma_mark_dispatch_rejected($1,'expired') as r", [id])).rows[0]!.r).toBe("requested");
      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1,$2) as c", [id, 2])).rows[0]!.c).toBe(true);
      expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2) as b", [id, "foreign-legacy"])).rows[0]!.b).toBe("already_completed");
      expect((await svc<{ r: string }>(db, "select public.fn_norma_mark_dispatch_unknown($1,'late') as r", [id])).rows[0]!.r).toBe("dispatching");
      expect((await svc<{ r: string }>(db, "select public.fn_norma_mark_needs_review($1,'late') as r", [id])).rows[0]!.r).toBe("dispatching");
      expect((await svc<{ r: string }>(db, "select public.fn_norma_mark_dispatch_rejected($1,'late') as r", [id])).rows[0]!.r).toBe("dispatching");
      expect((await svc<{ r: string }>(db, "select public.fn_norma_mark_dispatch_unknown($1,'timeout',$2) as r", [id, 2])).rows[0]!.r).toBe("dispatch_unknown");
      expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2,$3) as b", [id, "union-second", 2])).rows[0]!.b).toBe("bound");
      expect((await svc<{ r: string }>(db, "select public.fn_norma_mark_needs_review($1,'review',$2) as r", [id, 2])).rows[0]!.r).toBe("needs_review");
      expect((await svc<{ r: string }>(db, "select public.fn_norma_mark_dispatch_rejected($1,'late') as r", [id])).rows[0]!.r).toBe("needs_review");
    }, `${migrations()}\n${UNION}\n${ENABLE_RETRY}`);
  });

  it("keeps retry and shared next-step behavior after the safe rollback repair", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await dispatched(db, id, "rollback-first");
      expect(await complete(db, id, "rollback-first", "no_answer", { attempt: 1 })).toMatchObject({ retry: true });
      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1,$2) as c", [id, 2])).rows[0]!.c).toBe(true);
      expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2,$3) as b", [id, "rollback-second", 2])).rows[0]!.b).toBe("bound");
      expect(await complete(db, id, "rollback-second", "callback_requested", { attempt: 2 })).toMatchObject({ status: "completed" });
      expect((await tasksFor(db, l.property))[0]).toMatchObject({ type: "appointment", mode: "phone" });

      const legacy = await lead(db, ctx);
      const legacyId = (await create(db, ctx, legacy)).request_id!;
      const legacyCall = await dispatched(db, legacyId, "rollback-legacy");
      expect(await complete(db, legacyId, legacyCall, "no_answer")).toMatchObject({ result: "applied", status: "completed" });
      expect(await complete(db, legacyId, legacyCall, "no_answer")).toMatchObject({ result: "replayed" });
    }, `${migrations()}\n${UNION}\n${ROLLBACK}\n${ENABLE_RETRY}`);
  });

  it("leaves attempt two unchanged for every legacy or malformed completion payload", async () => {
    const payloads: Record<string, unknown>[] = [
      {}, { attempt: null }, { attempt: "2 " }, { attempt: true },
      { attempt: "02" }, { attempt: "99999999999999999999" },
    ];
    await withDb(async (db, ctx) => {
      const snapshot = async (id: string, property: string) => ({
        request: (await db.query("select to_jsonb(r) as row from public.norma_call_requests r where id=$1", [id])).rows[0]?.row,
        enrollment: (await db.query("select to_jsonb(e) as row from public.sequence_enrollments e where property_id=$1 order by id", [property])).rows,
        tasks: (await db.query("select to_jsonb(t) as row from public.tasks t where related_property_id=$1 order by id", [property])).rows,
        events: (await db.query("select to_jsonb(e) as row from public.lead_events e where property_id=$1 order by id", [property])).rows,
        notifications: (await db.query("select to_jsonb(n) as row from public.norma_notifications n where request_id=$1 order by id", [id])).rows,
      });
      for (const [index, payload] of payloads.entries()) {
        for (const bound of [false, true]) {
          const l = await lead(db, ctx);
          const id = (await create(db, ctx, l)).request_id!;
          await dispatched(db, id, `matrix-first-${index}-${bound}`);
          expect(await complete(db, id, `matrix-first-${index}-${bound}`, "no_answer", { attempt: 1 })).toMatchObject({ retry: true });
          expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1,$2) as c", [id, 2])).rows[0]!.c).toBe(true);
          if (bound) expect((await svc<{ b: string }>(db, "select public.fn_norma_bind_call_id($1,$2,$3) as b", [id, `matrix-second-${index}`, 2])).rows[0]!.b).toBe("bound");
          const before = await snapshot(id, l.property);
          const call = bound ? `matrix-second-${index}` : `forged-second-${index}`;
          for (const outcome of ["no_answer", "callback_requested", "unknown"] as const) {
            expect(await complete(db, id, call, outcome, payload), `${outcome} bound=${bound} payload=${JSON.stringify(payload)}`).toMatchObject({ result: "stale_attempt" });
            expect(await snapshot(id, l.property)).toEqual(before);
          }
        }
      }
      const numeric = await lead(db, ctx);
      const numericId = (await create(db, ctx, numeric)).request_id!;
      await dispatched(db, numericId, "matrix-number-first");
      expect(await complete(db, numericId, "matrix-number-first", "no_answer", { attempt: 1 })).toMatchObject({ retry: true });
      expect((await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1,$2) as c", [numericId, 2])).rows[0]!.c).toBe(true);
      const numericBefore = await snapshot(numericId, numeric.property);
      expect((await svc<{ r: Record<string, unknown> }>(db, "select public.fn_norma_complete_call($1,$2,$3,$4::jsonb) as r", [numericId, "matrix-number-second", "callback_requested", '{"attempt":2.0}'])).rows[0]!.r).toMatchObject({ result: "stale_attempt" });
      expect(await snapshot(numericId, numeric.property)).toEqual(numericBefore);
    }, `${migrations()}\n${UNION}\n${ENABLE_RETRY}`);
  });

  it("keeps omitted-attempt RPC calls legacy-compatible on attempt one and fenced on attempt two", async () => {
    await withDb(async (db, ctx) => {
      const snapshot = async (id: string, property: string) => ({
        request: (await db.query("select to_jsonb(r) as row from public.norma_call_requests r where id=$1", [id])).rows[0]?.row,
        enrollment: (await db.query("select to_jsonb(e) as row from public.sequence_enrollments e where property_id=$1 order by id", [property])).rows,
        tasks: (await db.query("select to_jsonb(t) as row from public.tasks t where related_property_id=$1 order by id", [property])).rows,
        events: (await db.query("select to_jsonb(e) as row from public.lead_events e where property_id=$1 order by id", [property])).rows,
        notifications: (await db.query("select to_jsonb(n) as row from public.norma_notifications n where request_id=$1 order by id", [id])).rows,
      });

      const claimLead = await lead(db, ctx);
      const claimId = (await create(db, ctx, claimLead)).request_id!;
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_claim_dispatch(p_request_id => $1) as value", [claimId])).rows[0].value).toBe(true);

      const bindLead = await lead(db, ctx);
      const bindId = (await create(db, ctx, bindLead)).request_id!;
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_claim_dispatch(p_request_id => $1) as value", [bindId])).rows[0].value).toBe(true);
      expect((await svc<{ value: string }>(db, "select public.fn_norma_bind_call_id(p_request_id => $1, p_call_id => $2) as value", [bindId, "legacy-fresh-bind"])).rows[0].value).toBe("bound");
      expect((await db.query("select status,bland_call_id from public.norma_call_requests where id=$1", [bindId])).rows[0]).toMatchObject({ status: "dispatched", bland_call_id: "legacy-fresh-bind" });

      const rejectLead = await lead(db, ctx);
      const rejectId = (await create(db, ctx, rejectLead)).request_id!;
      expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_dispatch_rejected(p_request_id => $1, p_reason => $2, p_expected_status => $3) as value", [rejectId, "expired", "requested"])).rows[0].value).toBe("dispatch_rejected");

      const unknownLead = await lead(db, ctx);
      const unknownId = (await create(db, ctx, unknownLead)).request_id!;
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_claim_dispatch(p_request_id => $1) as value", [unknownId])).rows[0].value).toBe(true);
      expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_dispatch_unknown(p_request_id => $1, p_reason => $2) as value", [unknownId, "timeout"])).rows[0].value).toBe("dispatch_unknown");

      const reviewLead = await lead(db, ctx);
      const reviewId = (await create(db, ctx, reviewLead)).request_id!;
      await dispatched(db, reviewId, "legacy-positive-review");
      expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_needs_review(p_request_id => $1, p_reason => $2) as value", [reviewId, "uncertain"])).rows[0].value).toBe("needs_review");

      const first = await lead(db, ctx);
      const firstId = (await create(db, ctx, first)).request_id!;
      const firstCall = await dispatched(db, firstId, "legacy-shape-first");
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_claim_dispatch(p_request_id => $1) as value", [firstId])).rows[0].value).toBe(false);
      expect((await svc<{ value: string }>(db, "select public.fn_norma_bind_call_id(p_request_id => $1, p_call_id => $2) as value", [firstId, firstCall])).rows[0].value).toBe("bound");
      expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_dispatch_rejected(p_request_id => $1, p_reason => $2, p_expected_status => $3) as value", [firstId, "late", "dispatching"])).rows[0].value).toBe("dispatched");
      expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_dispatch_unknown(p_request_id => $1, p_reason => $2) as value", [firstId, "late"])).rows[0].value).toBe("dispatched");
      expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_needs_review(p_request_id => $1, p_reason => $2) as value", [firstId, "late"])).rows[0].value).toBe("needs_review");

      for (const state of ["requested", "dispatching", "dispatched"] as const) {
        const l = await lead(db, ctx);
        const id = (await create(db, ctx, l)).request_id!;
        const firstAttemptCall = await dispatched(db, id, `legacy-shape-${state}`);
        expect(await complete(db, id, firstAttemptCall, "no_answer", { attempt: 1 })).toMatchObject({ retry: true });
        if (state !== "requested") expect((await svc<{ value: boolean }>(db, "select public.fn_norma_claim_dispatch(p_request_id => $1, p_expected_attempt => 2) as value", [id])).rows[0].value).toBe(true);
        if (state === "dispatched") expect((await svc<{ value: string }>(db, "select public.fn_norma_bind_call_id(p_request_id => $1, p_call_id => $2, p_expected_attempt => 2) as value", [id, `legacy-current-${state}`])).rows[0].value).toBe("bound");
        const before = await snapshot(id, l.property);
        expect((await svc<{ value: boolean }>(db, "select public.fn_norma_claim_dispatch(p_request_id => $1) as value", [id])).rows[0].value).toBe(false);
        expect((await svc<{ value: string }>(db, "select public.fn_norma_bind_call_id(p_request_id => $1, p_call_id => $2) as value", [id, `legacy-foreign-${state}`])).rows[0].value).toBe("already_completed");
        expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_dispatch_rejected(p_request_id => $1, p_reason => $2, p_expected_status => $3) as value", [id, "late", state])).rows[0].value).toBe(state);
        expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_dispatch_unknown(p_request_id => $1, p_reason => $2) as value", [id, "late"])).rows[0].value).toBe(state);
        expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_needs_review(p_request_id => $1, p_reason => $2) as value", [id, "late"])).rows[0].value).toBe(state);
        expect(await snapshot(id, l.property)).toEqual(before);
      }
    }, `${migrations()}\n${UNION}\n${ENABLE_RETRY}`);
  });

  it("keeps one service-role-only overload for every Norma RPC", async () => {
    await withDb(async (db, ctx) => {
      const names = ["fn_norma_claim_dispatch", "fn_norma_bind_call_id", "fn_norma_mark_dispatch_rejected", "fn_norma_mark_dispatch_unknown", "fn_norma_mark_needs_review", "fn_norma_complete_call", "fn_norma_presend_fence"];
      const rows = (await db.query(`
        select p.proname,
               count(distinct p.oid)::int as overloads,
               bool_and(p.prosecdef) as security_definer,
               bool_and(p.proconfig @> array['search_path=public, pg_temp']) as safe_path,
               bool_and(has_function_privilege('anon', p.oid, 'execute')) as anon_execute,
               bool_and(has_function_privilege('authenticated', p.oid, 'execute')) as authenticated_execute,
               bool_and(has_function_privilege('service_role', p.oid, 'execute')) as service_execute,
               coalesce(bool_or(x.grantee = 0 and x.privilege_type = 'EXECUTE'), false) as public_execute
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x on true
         where n.nspname = 'public' and p.proname = any($1::text[])
         group by p.proname
         order by p.proname`, [names])).rows;
      expect(rows).toHaveLength(names.length);
      for (const row of rows) expect(row).toMatchObject({ overloads: 1, security_definer: true, safe_path: true, anon_execute: false, authenticated_execute: false, service_execute: true, public_execute: false });

      const claimLead = await lead(db, ctx);
      const claimId = (await create(db, ctx, claimLead)).request_id!;
      const claimCall = await dispatched(db, claimId, "named-claim");
      const fenceLead = await lead(db, ctx);
      const fenceId = (await create(db, ctx, fenceLead)).request_id!;
      await db.query("set local role service_role");
      await db.query("select set_config('request.jwt.claim.role','service_role',true)");
      expect((await db.query("select public.fn_norma_claim_dispatch(p_request_id => $1, p_expected_attempt => $2) as value", [claimId, 1])).rows[0].value).toBe(false);
      expect((await db.query("select public.fn_norma_bind_call_id(p_request_id => $1, p_call_id => $2, p_expected_attempt => $3) as value", [claimId, claimCall, 1])).rows[0].value).toBe("bound");
      expect((await db.query("select public.fn_norma_mark_dispatch_rejected(p_request_id => $1, p_reason => $2, p_expected_status => $3, p_expected_attempt => $4) as value", [claimId, "late", "dispatching", 1])).rows[0].value).toBe("dispatched");
      expect((await db.query("select public.fn_norma_mark_dispatch_unknown(p_request_id => $1, p_reason => $2, p_expected_attempt => $3) as value", [claimId, "late", 1])).rows[0].value).toBe("dispatched");
      expect((await db.query("select public.fn_norma_mark_needs_review(p_request_id => $1, p_reason => $2, p_expected_attempt => $3) as value", [claimId, "late", 1])).rows[0].value).toBe("needs_review");
      expect((await db.query("select public.fn_norma_complete_call(p_request_id => $1, p_call_id => $2, p_outcome => $3, p_payload => $4::jsonb) as value", [claimId, claimCall, "callback_requested", "{}"])) .rows[0].value).toMatchObject({ result: "applied" });
      expect((await db.query("select public.fn_norma_claim_dispatch(p_request_id => $1) as value", [fenceId])).rows[0].value).toBe(true);
      expect((await db.query("select public.fn_norma_presend_fence(p_request_id => $1) as value", [fenceId])).rows[0].value).toBe(true);
    }, `${migrations()}\n${UNION}\n${ENABLE_RETRY}`);
  });

  it("admits only a fresh dispatching row at the matching attempt and fails closed otherwise", async () => {
    await withDb(async (db, ctx) => {
      const first = await lead(db, ctx);
      const firstId = (await create(db, ctx, first)).request_id!;
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_claim_dispatch($1) as value", [firstId])).rows[0].value).toBe(true);
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_presend_fence($1) as value", [firstId])).rows[0].value).toBe(true);
      await db.query("update public.norma_call_requests set dispatch_started_at = clock_timestamp() - interval '91 seconds' where id=$1", [firstId]);
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_presend_fence($1) as value", [firstId])).rows[0].value).toBe(false);

      const retry = await lead(db, ctx);
      const retryId = (await create(db, ctx, retry)).request_id!;
      const firstCall = await dispatched(db, retryId, "fence-first");
      expect(await complete(db, retryId, firstCall, "no_answer", { attempt: 1 })).toMatchObject({ retry: true });
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_claim_dispatch($1,$2) as value", [retryId, 2])).rows[0].value).toBe(true);
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_presend_fence($1,$2) as value", [retryId, 1])).rows[0].value).toBe(false);
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_presend_fence($1,$2) as value", [retryId, 2])).rows[0].value).toBe(true);
      await db.query("update public.norma_call_requests set dispatch_started_at = clock_timestamp() - interval '91 seconds' where id=$1", [retryId]);
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_presend_fence($1,$2) as value", [retryId, 2])).rows[0].value).toBe(false);
      expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_dispatch_unknown($1,'timeout',$2) as value", [retryId, 2])).rows[0].value).toBe("dispatch_unknown");
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_presend_fence($1,$2) as value", [retryId, 2])).rows[0].value).toBe(false);

      const completed = await lead(db, ctx);
      const completedId = (await create(db, ctx, completed)).request_id!;
      const completedCall = await dispatched(db, completedId, "fence-completed");
      expect(await complete(db, completedId, completedCall, "callback_requested", {})).toMatchObject({ result: "applied" });
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_presend_fence($1) as value", [completedId])).rows[0].value).toBe(false);

      const reviewed = await lead(db, ctx);
      const reviewedId = (await create(db, ctx, reviewed)).request_id!;
      await dispatched(db, reviewedId, "fence-reviewed");
      expect((await svc<{ value: string }>(db, "select public.fn_norma_mark_needs_review($1,'fence',$2) as value", [reviewedId, 1])).rows[0].value).toBe("needs_review");
      expect((await svc<{ result: string }>(db, "select (public.fn_norma_mark_reviewed($1,$2,$3)->>'result') as result", [reviewedId, reviewed.property, ctx.assignee])).rows[0].result).toBe("reviewed");
      expect((await svc<{ value: boolean }>(db, "select public.fn_norma_presend_fence($1) as value", [reviewedId])).rows[0].value).toBe(false);
    }, `${migrations()}\n${UNION}\n${ENABLE_RETRY}`);
  });

  it("keeps the recovery SQL body identical to the forward repair", () => {
    const marker = "-- contract while restoring the shared fn_create_next_step task and review writers.";
    expect(ROLLBACK.slice(ROLLBACK.indexOf(marker))).toBe(UNION.slice(UNION.indexOf(marker)));
  });
  it("falls back to a fresh keyed next step when the request key is closed", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id, "closed-key-call");
      await db.query("set local role service_role");
      await db.query("select set_config('request.jwt.claim.role','service_role',true), set_config('request.jwt.claim.sub',$1,true)", [ctx.assignee]);
      const closedTaskId = (await db.query(
        "select public.fn_create_next_step(p_org => $1, p_actor => $2, p_assignee => $2, p_kind => 'appointment', p_title => 'Closed callback', p_due_at => now(), p_property => $3, p_contact => $4, p_mode => 'phone', p_source_key => $5, p_origin => 'norma') as result",
        [ctx.org, ctx.assignee, l.property, l.contact, `norma_call:${id}`],
      )).rows[0].result.task_id;
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
      await db.query(
        "select public.fn_reschedule_appointment(p_task => $1, p_new_start => now() + interval '1 day', p_new_end => now() + interval '1 day 15 minutes', p_timezone => 'America/Chicago')",
        [closedTaskId],
      );
      expect(await complete(db, id, callId, "callback_requested", { callback_raw: "tomorrow" })).toMatchObject({ result: "applied", status: "completed" });
      const rows = (await db.query(
        "select type,status,mode,source_key from public.tasks where related_property_id=$1 order by created_at,id",
        [l.property],
      )).rows;
      expect(rows).toHaveLength(3);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "appointment", status: "completed", source_key: `norma_call:${id}` }),
        expect.objectContaining({ type: "appointment", status: "open", mode: "phone", source_key: `norma_call:${id}:${callId}` }),
      ]));
    }, `${migrations()}\n${UNION}\n${ENABLE_RETRY}`);
  });

});
