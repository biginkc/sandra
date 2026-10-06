import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createScratchDb, seedWorld, type Scratch, type World } from "./db";

let db: Scratch;
let world: World;
beforeAll(async () => { db = await createScratchDb(); world = await seedWorld(db.pool); });
afterAll(async () => { await db?.drop(); });

async function service() {
  const client = new Client({ connectionString: db.url, options: "-c role=service_role -c request.jwt.claim.role=service_role" });
  await client.connect();
  expect((await client.query("select current_user as role")).rows[0].role).toBe("service_role");
  return client;
}
async function ready(c: Client, call: string, preserveReply = false) {
  const l = await world.nextLead({ enrollments: [preserveReply ? "paused:inbound_reply" : "active"] });
  const id = (await c.query("select * from public.fn_norma_create_request($1,$2,$3,$4,'private admission test',$5)", [l.property, l.contact, l.phone, world.rep1, world.assignee])).rows[0].request_id;
  expect((await c.query("select public.fn_norma_claim_dispatch($1) as c", [id])).rows[0].c).toBe(true);
  expect((await c.query("select public.fn_norma_bind_call_id($1,$2) as b", [id, call])).rows[0].b).toBe("bound");
  return { id, l };
}
const complete = (c: Client, id: string, call: string) => c.query("select public.fn_norma_complete_call($1,$2,'no_answer','{\"attempt\":1}'::jsonb) as r", [id, call]);

describe("database OFF commit serializes with retry schedulers", () => {
  it("OFF waits for an admitted scheduler; an earlier-started READ COMMITTED caller then observes OFF", async () => {
    const admitted = await service();
    const later = await service();
    const operator = new Client({ connectionString: db.url });
    await operator.connect();
    let off: Promise<unknown> | undefined;
    try {
      await db.pool.query("update public.norma_retry_admission set enabled=true where singleton=true");
      const first = await ready(admitted, "admission-inflight-first");
      const second = await ready(later, "admission-after-off", true);
      await later.query("begin isolation level read committed");
      await later.query("select 1 from public.norma_call_requests limit 1");
      await admitted.query("begin");
      expect((await complete(admitted, first.id, "admission-inflight-first")).rows[0].r.retry).toBe(true);
      const pid = (await operator.query("select pg_backend_pid() as pid")).rows[0].pid;
      await operator.query("begin; set local statement_timeout='5s'");
      off = operator.query("update public.norma_retry_admission set enabled=false where singleton=true");
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const row = (await db.pool.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0];
        if (row?.wait_event_type === "Lock") { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting, "operator OFF must wait for scheduling SHARE lock").toBe(true);
      await admitted.query("commit");
      await off;
      await operator.query("commit");
      expect((await complete(later, second.id, "admission-after-off")).rows[0].r).toMatchObject({ status: "completed", released: 0 });
      await later.query("commit");
      const enrollments = (await db.pool.query("select status,pause_reason from public.sequence_enrollments where property_id=$1 order by status", [second.l.property])).rows;
      expect(enrollments).toEqual([{ status: "paused", pause_reason: "inbound_reply" }]);
      expect((await db.pool.query("select attempt,status from public.norma_call_requests where id=$1", [first.id])).rows[0]).toEqual({ attempt: 2, status: "requested" });
      // OFF prevents NEW admission; previously admitted attempt-2 data/holds survive.
      expect((await db.pool.query("select count(*)::int n from public.norma_enrollment_pauses where request_id=$1 and released_at is null", [first.id])).rows[0].n).toBe(1);
    } finally {
      await admitted.query("rollback").catch(() => undefined);
      await off?.catch(() => undefined);
      await operator.query("rollback").catch(() => undefined);
      await later.query("rollback").catch(() => undefined);
      await Promise.all([admitted.end(), later.end(), operator.end()]);
    }
  });

  it("an older repeatable-read snapshot aborts instead of scheduling after OFF", async () => {
    const caller = await service();
    try {
      await db.pool.query("update public.norma_retry_admission set enabled=true where singleton=true");
      const row = await ready(caller, "admission-old-snapshot");
      await caller.query("begin isolation level repeatable read");
      await caller.query("select 1 from public.norma_call_requests limit 1");
      await db.pool.query("update public.norma_retry_admission set enabled=false where singleton=true");
      await expect(complete(caller, row.id, "admission-old-snapshot")).rejects.toMatchObject({ code: "40001" });
      await caller.query("rollback");
      expect((await db.pool.query("select status,attempt,bland_call_id from public.norma_call_requests where id=$1", [row.id])).rows[0]).toEqual({ status: "dispatched", attempt: 1, bland_call_id: "admission-old-snapshot" });
      expect((await complete(caller, row.id, "admission-old-snapshot")).rows[0].r).toMatchObject({ status: "completed", released: 1 });
    } finally {
      await caller.query("rollback").catch(() => undefined);
      await caller.end();
    }
  });
});
