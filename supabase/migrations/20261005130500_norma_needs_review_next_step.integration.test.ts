import { describe, expect, it } from "vitest";

import { ROLLBACKS, WRITERS, complete, create, dispatched, lead, load, migrations, svc, tasksFor, withDb } from "@tests/integration/norma-next-step-support";

describe("fn_norma_mark_needs_review through fn_create_next_step", () => {
  it("opens one review task (kind task, due now, the existing description, Norma identity) and is idempotent", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await dispatched(db, id);
      expect((await svc<{ s: string }>(db, "select public.fn_norma_mark_needs_review($1,'stuck') as s", [id])).rows[0]!.s).toBe("needs_review");
      await svc(db, "select public.fn_norma_mark_needs_review($1,'stuck again')", [id]);
      const tasks = await tasksFor(db, l.property);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ type: "custom", mode: "phone", status: "open", assignee_id: ctx.assignee, source_key: `norma_call:${id}`, title: "Norma call needs review: outcome unknown", created_by: ctx.rep });
      expect(tasks[0].description).toMatch(/Norma may have called this seller/);
      expect(tasks[0].calendar_chain_id).toBeNull();
      expect(tasks[0].end_at).toBeNull();
      expect((await db.query("select count(*)::int n from public.lead_events where event_type='task_created' and source_id=$1", [tasks[0].id])).rows[0].n).toBe(1);
    });
  });

  it("a review task a human closed is not reopened by a repeated escalation", async () => {
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await dispatched(db, id);
      await svc(db, "select public.fn_norma_mark_needs_review($1,'stuck')", [id]);
      await db.query("update public.tasks set status='cancelled' where related_property_id=$1", [l.property]);
      await svc(db, "select public.fn_norma_mark_needs_review($1,'again')", [id]);
      expect((await tasksFor(db, l.property)).map((t) => t.status)).toEqual(["cancelled"]);
    });
  });

  it("a DNC-locked lead is escalated with no task; an unknown completion parks for review", async () => {
    await withDb(async (db, ctx) => {
      const d = await lead(db, ctx);
      const idd = (await create(db, ctx, d)).request_id!;
      await dispatched(db, idd);
      await db.query("set local session_replication_role='replica'");
      await db.query("update public.contacts set do_not_contact=true where id=$1", [d.contact]);
      await db.query("update public.properties set is_dnc_locked=true where id=$1", [d.property]);
      await db.query("set local session_replication_role='origin'");
      expect((await svc<{ s: string }>(db, "select public.fn_norma_mark_needs_review($1,'stuck') as s", [idd])).rows[0]!.s).toBe("needs_review");
      expect(await tasksFor(db, d.property)).toHaveLength(0);

      const u = await lead(db, ctx);
      const idu = (await create(db, ctx, u)).request_id!;
      expect(await complete(db, idu, await dispatched(db, idu), "unknown")).toMatchObject({ result: "applied", status: "needs_review" });
      expect((await tasksFor(db, u.property))[0]).toMatchObject({ type: "custom", title: "Norma call needs review: outcome unknown" });
    });
  });

  it("the rollback restores the legacy review insert", async () => {
    const sql = [migrations([WRITERS[1]]), load(ROLLBACKS[1]).replace(/^\s*begin;\s*$/gim, "")].join("\n");
    await withDb(async (db, ctx) => {
      const l = await lead(db, ctx);
      const id = (await create(db, ctx, l)).request_id!;
      await dispatched(db, id);
      await svc(db, "select public.fn_norma_mark_needs_review($1,'stuck')", [id]);
      expect((await tasksFor(db, l.property))[0]).toMatchObject({ type: "custom" });
    }, sql);
  });
});
