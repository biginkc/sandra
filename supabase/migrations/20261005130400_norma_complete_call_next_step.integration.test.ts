import { describe, expect, it } from "vitest";

import { ROLLBACKS, WRITERS, complete, create, dispatched, lead, load, migrations, svc, tasksFor, withDb } from "@tests/integration/norma-next-step-support";

describe("fn_norma_complete_call through fn_create_next_step", () => {
  it("a callback outcome is one open phone appointment (15 minutes) with the Norma identity; a replay adds nothing", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id);
      const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const payload = { callback_requested_for: due, callback_raw: "Monday at 10", callback_timezone: "America/Chicago", summary: "wants a call" };
      expect(await complete(db, id, callId, "callback_requested", payload)).toMatchObject({ result: "applied", status: "completed" });
      expect(await complete(db, id, callId, "callback_requested", payload)).toMatchObject({ result: "replayed" });
      const tasks = await tasksFor(db, l.property);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ type: "appointment", mode: "phone", status: "open", assignee_id: ctx.assignee, source_key: `norma_call:${id}`, created_by: ctx.rep });
      expect(new Date(tasks[0].due_at).toISOString()).toBe(due);
      expect(new Date(tasks[0].end_at).getTime() - new Date(tasks[0].due_at).getTime()).toBe(900_000);
      expect(tasks[0].calendar_chain_id).toBeTruthy();
      expect(tasks[0].description).toContain("Monday at 10");
      expect((await db.query("select count(*)::int n from public.task_calendar_mutations where source_task_id=$1", [tasks[0].id])).rows[0].n).toBe(0);
      expect((await db.query("select source from public.acquisition_appointment_attribution where task_id=$1", [tasks[0].id])).rows).toEqual([{ source: "booking_insert" }]);
      // exactly one task_created event per Norma task (the stress invariant), written by the shared function
      const ev = (await db.query("select actor_type, source_type from public.lead_events where event_type='task_created' and source_id=$1", [tasks[0].id])).rows;
      expect(ev).toEqual([{ actor_type: "system", source_type: "tasks.created" }]);
    });
  });

  it("task cardinality and kind by outcome: appointment for callback/reached, custom task for wrong_number/unknown, none for no_answer/not_interested", async () => {
    await withDb(async (db, ctx) => {
      const expected: Record<string, { n: number; type?: string }> = {
        callback_requested: { n: 1, type: "appointment" }, reached_no_callback: { n: 1, type: "appointment" },
        wrong_number: { n: 1, type: "custom" }, unknown: { n: 1, type: "custom" },
        no_answer: { n: 0 }, not_interested: { n: 0 },
      };
      for (const [outcome, want] of Object.entries(expected)) {
        const l = await lead(db, ctx);
        const id = (await create(db, ctx, l)).request_id!;
        await complete(db, id, await dispatched(db, id), outcome);
        const rows = await tasksFor(db, l.property);
        expect(rows, outcome).toHaveLength(want.n);
        if (want.type) expect(rows[0], outcome).toMatchObject({ type: want.type, mode: "phone", assignee_id: ctx.assignee });
        if (want.type === "custom") expect(rows[0].calendar_chain_id).toBeNull();
      }
    });
  });

  it("a review task becomes the callback appointment in place (same row, key kept, chain set, conversion attribution)", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id);
      await svc(db, "select public.fn_norma_mark_needs_review($1,'stuck')", [id]);
      const [review] = await tasksFor(db, l.property);
      expect(review).toMatchObject({ type: "custom", status: "open" });
      expect(await complete(db, id, callId, "callback_requested", { callback_raw: "tomorrow" })).toMatchObject({ result: "applied" });
      const tasks = await tasksFor(db, l.property);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ id: review.id, type: "appointment", mode: "phone", status: "open", source_key: `norma_call:${id}` });
      expect(tasks[0].calendar_chain_id).toBeTruthy();
      expect(tasks[0].title).not.toMatch(/needs review/i);
      expect((await db.query("select source from public.acquisition_appointment_attribution where task_id=$1", [review.id])).rows).toEqual([{ source: "next_step_conversion" }]);
      expect((await db.query("select count(*)::int n from public.lead_events where event_type='task_created' and source_id=$1", [review.id])).rows[0].n).toBe(1);
    });
  });

  it("a late real outcome reopens a review task a human already closed, and a late no_answer cancels it", async () => {
    await withDb(async (db, ctx) => {
      for (const closed of ["completed", "cancelled"]) {
        const l = await lead(db, ctx);
        const id = (await create(db, ctx, l)).request_id!;
        const callId = await dispatched(db, id);
        await svc(db, "select public.fn_norma_mark_needs_review($1,'stuck')", [id]);
        await db.query("update public.tasks set status=$2, completed_at=case when $2='completed' then now() end where related_property_id=$1", [l.property, closed]);
        expect(await complete(db, id, callId, "callback_requested", { callback_requested_for: "2030-10-06T14:00:00Z" })).toMatchObject({ result: "applied" });
        const rows = await tasksFor(db, l.property);
        expect(rows, closed).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "open", type: "appointment", completed_at: null });
      }
      const b = await lead(db, ctx);
      const idb = (await create(db, ctx, b)).request_id!;
      const callB = await dispatched(db, idb);
      await svc(db, "select public.fn_norma_mark_needs_review($1,'stuck')", [idb]);
      expect(await complete(db, idb, callB, "no_answer")).toMatchObject({ result: "applied" });
      expect((await tasksFor(db, b.property)).map((t) => t.status)).toEqual(["cancelled"]);
    });
  });

  it("a keyed appointment that was closed, rescheduled or superseded is not reopened: the result becomes a fresh next step", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id);
      // The request is not completed yet, but a keyed appointment already exists and was closed
      // (a human held it): completing now must not reopen it.
      const key = `norma_call:${id}`;
      const closedId = (await svc<{ id: string }>(db, `select (public.fn_create_next_step(p_org := $1, p_actor := $2, p_assignee := $2, p_kind := 'appointment', p_title := 'Earlier', p_due_at := now() + interval '1 day', p_property := $3, p_contact := $4, p_mode := 'phone', p_source_key := $5, p_origin := 'norma') ->> 'task_id')::uuid as id`, [ctx.org, ctx.assignee, l.property, l.contact, key])).rows[0]!.id;
      await db.query("select set_config('sandra.allow_appointment_time_move','on',true)");
      await db.query("update public.tasks set status='completed', outcome='held', completed_at=now() where id=$1", [closedId]);
      await db.query("select set_config('sandra.allow_appointment_time_move','',true)");
      expect(await complete(db, id, callId, "callback_requested", { callback_raw: "again" })).toMatchObject({ result: "applied", status: "completed" });
      const tasks = await tasksFor(db, l.property);
      expect(tasks).toHaveLength(2);
      const closedRow = tasks.find((t) => t.id === closedId)!;
      expect(closedRow).toMatchObject({ status: "completed", outcome: "held" });
      const fresh = tasks.find((t) => t.id !== closedId)!;
      expect(fresh).toMatchObject({ type: "appointment", status: "open", mode: "phone" });
      expect(fresh.source_key).toBe(`norma_call:${id}:${callId}`);
      // Deterministic: a repeat of the same fresh write (same request + call id) lands on the
      // same row, so there is never a second open callback.
      const due = new Date(Date.now() + 86_400_000).toISOString();
      await svc(db, `select public.fn_create_next_step(p_org := $1, p_actor := $2, p_assignee := $2, p_kind := 'appointment', p_title := 't', p_due_at := $3, p_property := $4, p_contact := $5, p_mode := 'phone', p_description := 'once more', p_source_key := $6, p_origin := 'norma')`, [ctx.org, ctx.assignee, due, l.property, l.contact, fresh.source_key]);
      const again = await tasksFor(db, l.property);
      expect(again).toHaveLength(2);
      expect(again.filter((t) => t.status === "open")).toHaveLength(1);
      expect(again.find((t) => t.id === fresh.id)!.description).toContain("once more");
      expect(fresh.calendar_chain_id).not.toBe(closedRow.calendar_chain_id);
    });
  });

  it("a DNC-locked lead still records the result with no task; a wrong number stays a custom task", async () => {
    await withDb(async (db, ctx) => {
      const d = await lead(db, ctx);
      const idd = (await create(db, ctx, d)).request_id!;
      const callD = await dispatched(db, idd);
      await db.query("set local session_replication_role='replica'");
      await db.query("update public.contacts set do_not_contact=true where id=$1", [d.contact]);
      await db.query("update public.properties set is_dnc_locked=true where id=$1", [d.property]);
      await db.query("set local session_replication_role='origin'");
      expect(await complete(db, idd, callD, "callback_requested", { callback_raw: "x" })).toMatchObject({ result: "applied", status: "completed", task_id: null });
      expect(await tasksFor(db, d.property)).toHaveLength(0);
      expect((await db.query("select status, outcome from public.norma_call_requests where id=$1", [idd])).rows).toEqual([{ status: "completed", outcome: "callback_requested" }]);

      const w = await lead(db, ctx);
      const idw = (await create(db, ctx, w)).request_id!;
      await complete(db, idw, await dispatched(db, idw), "wrong_number");
      expect((await tasksFor(db, w.property))[0]).toMatchObject({ type: "custom", mode: "phone" });
    });
  });

  it("an inactive requester does not break the completion: the assignee is the actor", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      const callId = await dispatched(db, id);
      await db.query("update public.memberships set access_status='suspended' where user_id=$1 and org_id=$2", [ctx.rep, ctx.org]);
      expect(await complete(db, id, callId, "callback_requested", {})).toMatchObject({ result: "applied" });
      expect((await tasksFor(db, l.property))[0]).toMatchObject({ type: "appointment", created_by: ctx.assignee });
    });
  });

  it("the rollback restores the legacy callback insert", async () => {
    const sql = [migrations([WRITERS[0]]), load(ROLLBACKS[0]).replace(/^\s*begin;\s*$/gim, "")].join("\n");
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await complete(db, id, await dispatched(db, id), "callback_requested", {});
      expect((await tasksFor(db, l.property))[0]).toMatchObject({ type: "callback" });
    }, sql);
  });
});
