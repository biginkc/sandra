/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Trigger-maintained filter cache on public.properties: correctness under
 * insert / update / delete / move of messages, tasks, property_lists and
 * property_tags, DNC-locked properties, forged client writes, bulk
 * statements, concurrent writers and the backfill (refresh) path.
 *
 * LOCAL-ONLY (assertLocalOnlyEnvironment):
 *   npx vitest run --config vitest.filter-local.config.ts
 */
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, TEST_ORG_B_ID, clientForUser, createOrgUser, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import { assertLocalOnlyEnvironment } from "@/lib/testing/local-only-guard";

assertLocalOnlyEnvironment();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const svc = createTestClient();
let pg: Client;
let userA: any;
const authUsers: string[] = [];
let userAId = "";

const COLS = "has_inbound_message hi, has_outbound_message ho, has_unread_inbound hu, has_open_tasks ot, filter_list_ids lids, filter_tag_ids tids, filter_list_count lc";
async function prop(extra = ""): Promise<string> {
  const { rows } = await pg.query(`insert into public.properties (org_id, address, state, status ${extra ? "," + extra.split("=")[0] : ""}) values ('${BMH_ORG_ID}', $1, 'MO', 'prospect' ${extra ? ",'" + extra.split("=")[1] + "'" : ""}) returning id`, [`T ${randomUUID()}`]);
  return rows[0].id;
}
async function cache(id: string) {
  const { rows } = await pg.query(`select ${COLS} from public.properties where id = $1`, [id]);
  return rows[0];
}
async function msg(pid: string | null, direction: "inbound" | "outbound", opts: { read?: boolean; org?: string } = {}) {
  const { rows } = await pg.query(
    `insert into public.messages (org_id, property_id, channel, direction, body, read_at) values ($1, $2, 'sms', $3, 'x', $4) returning id`,
    [opts.org ?? BMH_ORG_ID, pid, direction, opts.read ? new Date().toISOString() : null],
  );
  return rows[0].id as string;
}
async function task(pid: string, status = "open") {
  const { rows } = await pg.query(
    `insert into public.tasks (org_id, assignee_id, created_by, related_property_id, type, status, title, due_at) values ($1, $2, $2, $3, 'follow_up', $4, 't', now()) returning id`,
    [BMH_ORG_ID, userAId, pid, status],
  );
  return rows[0].id as string;
}
async function mkTag() {
  return (await pg.query(`insert into public.tags (org_id, name, category) values ($1, $2, 'custom') returning id`, [BMH_ORG_ID, `t-${randomUUID()}`])).rows[0].id as string;
}
async function mkList() {
  return (await pg.query(`insert into public.lists (org_id, name) values ($1, $2) returning id`, [BMH_ORG_ID, `l-${randomUUID()}`])).rows[0].id as string;
}

beforeAll(async () => {
  await resetTenantTables(svc);
  await seedTwoOrgs(svc);
  const a = await createOrgUser(svc, { orgId: BMH_ORG_ID, email: `tc-${randomUUID()}@example.test`, role: "owner" });
  authUsers.push(a.userId);
  userAId = a.userId;
  userA = clientForUser(a.jwt);
  pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL! });
  await pg.connect();
}, 120_000);

afterAll(async () => {
  await pg?.end();
  for (const id of authUsers) await svc.auth.admin.deleteUser(id).catch(() => undefined);
  await resetTenantTables(svc);
}, 120_000);

describe("messages", () => {
  it("insert / read / direction change / move / delete keep has_inbound, has_outbound, has_unread in sync", async () => {
    const p = await prop();
    const q = await prop();
    expect(await cache(p)).toMatchObject({ hi: false, ho: false, hu: false });
    const m1 = await msg(p, "inbound");
    expect(await cache(p)).toMatchObject({ hi: true, ho: false, hu: true });
    const m2 = await msg(p, "outbound");
    expect(await cache(p)).toMatchObject({ hi: true, ho: true, hu: true });
    await pg.query(`update public.messages set read_at = now() where id = $1`, [m1]);
    expect(await cache(p)).toMatchObject({ hi: true, ho: true, hu: false });
    await pg.query(`update public.messages set status = 'delivered' where id = $1`, [m2]); // irrelevant column
    expect(await cache(p)).toMatchObject({ hi: true, ho: true, hu: false });
    await pg.query(`update public.messages set direction = 'outbound' where id = $1`, [m1]);
    expect(await cache(p)).toMatchObject({ hi: false, ho: true, hu: false });
    await pg.query(`update public.messages set direction = 'inbound', read_at = null where id = $1`, [m1]);
    expect(await cache(p)).toMatchObject({ hi: true, hu: true });
    // move the inbound message to q: both properties refresh
    await pg.query(`update public.messages set property_id = $2 where id = $1`, [m1, q]);
    expect(await cache(p)).toMatchObject({ hi: false, ho: true, hu: false });
    expect(await cache(q)).toMatchObject({ hi: true, ho: false, hu: true });
    await pg.query(`delete from public.messages where property_id = any($1)`, [[p, q]]);
    expect(await cache(p)).toMatchObject({ hi: false, ho: false, hu: false });
    expect(await cache(q)).toMatchObject({ hi: false, ho: false, hu: false });
  });

  it("orphan messages and messages from another org do not count", async () => {
    const p = await prop();
    await msg(null, "inbound");
    await msg(p, "inbound", { org: TEST_ORG_B_ID });
    expect(await cache(p)).toMatchObject({ hi: false, ho: false, hu: false });
  });
});

describe("tasks", () => {
  it("only status=open counts; status change, move and delete refresh", async () => {
    const p = await prop();
    const q = await prop();
    const t = await task(p, "completed");
    expect((await cache(p)).ot).toBe(false);
    await pg.query(`update public.tasks set status = 'open' where id = $1`, [t]);
    expect((await cache(p)).ot).toBe(true);
    await pg.query(`update public.tasks set related_property_id = $2 where id = $1`, [t, q]);
    expect((await cache(p)).ot).toBe(false);
    expect((await cache(q)).ot).toBe(true);
    await pg.query(`update public.tasks set status = 'snoozed' where id = $1`, [t]);
    expect((await cache(q)).ot).toBe(false);
    await pg.query(`update public.tasks set status = 'open' where id = $1`, [t]);
    await pg.query(`delete from public.tasks where id = $1`, [t]);
    expect((await cache(q)).ot).toBe(false);
  });
});

describe("property_lists / property_tags", () => {
  it("maintain sorted id arrays and the list count through insert, move and delete", async () => {
    const p = await prop();
    const q = await prop();
    const [l1, l2] = [await mkList(), await mkList()];
    const [t1, t2] = [await mkTag(), await mkTag()];
    await pg.query(`insert into public.property_lists (org_id, property_id, list_id) values ('${BMH_ORG_ID}', $1, $2), ('${BMH_ORG_ID}', $1, $3)`, [p, l1, l2]);
    await pg.query(`insert into public.property_tags (org_id, property_id, tag_id) values ('${BMH_ORG_ID}', $1, $2), ('${BMH_ORG_ID}', $1, $3)`, [p, t1, t2]);
    const c = await cache(p);
    expect(c.lc).toBe(2);
    expect([...c.lids].sort()).toEqual([l1, l2].sort());
    expect([...c.tids].sort()).toEqual([t1, t2].sort());
    await pg.query(`update public.property_lists set property_id = $2 where property_id = $1 and list_id = $3`, [p, q, l1]);
    expect(await cache(p)).toMatchObject({ lc: 1, lids: [l2] });
    expect(await cache(q)).toMatchObject({ lc: 1, lids: [l1] });
    await pg.query(`delete from public.property_tags where property_id = $1 and tag_id = $2`, [p, t1]);
    expect((await cache(p)).tids).toEqual([t2]);
    await pg.query(`delete from public.property_lists where property_id = any($1)`, [[p, q]]);
    expect(await cache(p)).toMatchObject({ lc: 0, lids: [] });
    expect(await cache(q)).toMatchObject({ lc: 0, lids: [] });
  });
});

describe("DNC-locked properties and forged writes", () => {
  it("an inbound message on a DNC-locked property still refreshes the cache; the lock stays read-only", async () => {
    const p = await prop();
    await pg.query(`update public.properties set outreach_dispo = 'dnc' where id = $1`, [p]);
    const { rows } = await pg.query(`select is_dnc_locked from public.properties where id = $1`, [p]);
    expect(rows[0].is_dnc_locked).toBe(true);
    await msg(p, "inbound"); // e.g. a STOP reply — must not throw
    expect(await cache(p)).toMatchObject({ hi: true, hu: true });
    await expect(pg.query(`update public.properties set address = 'changed' where id = $1`, [p])).rejects.toThrow(/DNC_LOCKED/);
    await expect(pg.query(`update public.properties set is_dnc_locked = false where id = $1`, [p])).rejects.toThrow(/DNC_LOCKED/);
    // a combined update (cache + real column) is NOT treated as cache-only
    await expect(pg.query(`select set_config('sandra.filter_cache_writer','on',false)`).then(() => pg.query(`update public.properties set address = 'x', has_open_tasks = true where id = $1`, [p]))).rejects.toThrow(/DNC_LOCKED/);
    await pg.query(`select set_config('sandra.filter_cache_writer','off',false)`);
  });

  it("clients cannot forge cache columns on insert or update", async () => {
    const { data, error } = await userA.from("properties").insert({ org_id: BMH_ORG_ID, address: `forge ${randomUUID()}`, state: "MO", status: "prospect", has_inbound_message: true, has_unread_inbound: true, has_open_tasks: true, filter_list_count: 5 }).select("*").single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ has_inbound_message: false, has_unread_inbound: false, has_open_tasks: false, filter_list_count: 0 });
    await userA.from("properties").update({ has_outbound_message: true, filter_list_count: 3 }).eq("id", data.id);
    expect(await cache(data.id)).toMatchObject({ ho: false, lc: 0 });
  });
});

describe("bulk statements, concurrency and backfill", () => {
  it("a 6,000-row single-statement insert refreshes 2,000 properties set-based and correctly, fast", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2000; i += 500) {
      const { rows } = await pg.query(`insert into public.properties (org_id, address, state, status) select '${BMH_ORG_ID}', 'bulk ' || g || ' ' || gen_random_uuid(), 'MO', 'prospect' from generate_series(1, 500) g returning id`);
      ids.push(...rows.map((r) => r.id));
    }
    const t0 = Date.now();
    await pg.query(
      `insert into public.messages (org_id, property_id, channel, direction, body, read_at)
       select '${BMH_ORG_ID}', ids.id, 'sms', case when k % 3 = 0 then 'inbound' else 'outbound' end, 'b', case when k % 3 = 0 and idx % 2 = 0 then now() end
         from unnest($1::uuid[]) with ordinality as ids(id, idx) cross join generate_series(1, 3) k`,
      [ids],
    );
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(15_000);
    const { rows } = await pg.query(
      `select count(*) filter (where has_inbound_message and has_outbound_message and (has_unread_inbound = (m.idx % 2 = 1)))::int ok, count(*)::int n
         from public.properties p join unnest($1::uuid[]) with ordinality as m(id, idx) on m.id = p.id`,
      [ids],
    );
    expect(rows[0]).toEqual({ ok: 2000, n: 2000 });
  });

  it("concurrent writers on one property both land (no stale overwrite)", async () => {
    const p = await prop();
    const a = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL! });
    const b = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL! });
    await a.connect();
    await b.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      const ins = (c: Client, dir: string) => c.query(`insert into public.messages (org_id, property_id, channel, direction, body) values ('${BMH_ORG_ID}', $1, 'sms', $2, 'c')`, [p, dir]);
      await ins(a, "inbound"); // a's refresh now holds the property row lock
      const bDone = ins(b, "outbound"); // b's refresh must wait for a
      await new Promise((r) => setTimeout(r, 400));
      await a.query("commit");
      await bDone;
      await b.query("commit");
    } finally {
      await a.end();
      await b.end();
    }
    expect(await cache(p)).toMatchObject({ hi: true, ho: true, hu: true });
  });

  it("refresh_property_filter_cache (the backfill path) repairs stale rows written with triggers off", async () => {
    const p = await prop();
    await pg.query("begin");
    await pg.query("set local session_replication_role = replica");
    await msg(p, "inbound");
    await task(p);
    await pg.query("commit");
    expect(await cache(p)).toMatchObject({ hi: false, ot: false }); // stale, as after a trigger-less bulk load
    await pg.query(`select public.refresh_property_filter_cache($1::uuid[])`, [[p]]);
    expect(await cache(p)).toMatchObject({ hi: true, hu: true, ot: true });
  });

  it("refresh_property_filter_cache is not callable by authenticated clients", async () => {
    const { error } = await userA.rpc("refresh_property_filter_cache", { p_ids: [] });
    expect(error).toBeTruthy();
  });
});

describe("lock order and pin hardening", () => {
  const BARRIER = `pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0)`;

  it("a cache refresh waits for the exclusive global-DNC barrier BEFORE taking row locks (no inversion/deadlock)", async () => {
    const p = await prop();
    const x = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL! });
    const y = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL! });
    await x.connect();
    await y.connect();
    try {
      await x.query("begin");
      await x.query(`select pg_catalog.pg_advisory_xact_lock(${BARRIER})`); // global DNC writer path
      await y.query("begin");
      let yDone = false;
      const yInsert = y
        .query(`insert into public.messages (org_id, property_id, channel, direction, body) values ('${BMH_ORG_ID}', $1, 'sms', 'inbound', 'z')`, [p])
        .then(() => { yDone = true; });
      await new Promise((r) => setTimeout(r, 500));
      expect(yDone).toBe(false); // blocked on the barrier, holding no property row lock
      // The DNC writer now touches the same property row: would deadlock if y held the row lock.
      await x.query(`update public.properties set address = address || '' where id = $1`, [p]);
      await x.query("commit");
      await yInsert;
      await y.query("commit");
    } finally {
      await x.end();
      await y.end();
    }
    expect(await cache(p)).toMatchObject({ hi: true, hu: true });
  });

  it("the writer GUC alone does not unpin: a non-owner role setting it still cannot forge the cache", async () => {
    const p = await prop();
    await pg.query("begin");
    await pg.query("set local role service_role");
    await pg.query(`select set_config('sandra.filter_cache_writer', 'on', true)`);
    await pg.query(`update public.properties set has_open_tasks = true, filter_list_count = 7 where id = $1`, [p]);
    await pg.query("rollback");
    await pg.query("begin");
    await pg.query("set local role service_role");
    await pg.query(`select set_config('sandra.filter_cache_writer', 'on', true)`);
    await pg.query(`update public.properties set has_open_tasks = true, filter_list_count = 7 where id = $1`, [p]);
    await pg.query("commit");
    expect(await cache(p)).toMatchObject({ ot: false, lc: 0 });
  });
});


describe("rows whose id changes, and property org moves", () => {
  it("UPDATE that changes a child's id together with its property/direction refreshes BOTH properties", async () => {
    const p = await prop();
    const q = await prop();
    const [l1] = [await mkList()];
    const t1 = await mkTag();
    const m = await msg(p, "inbound");
    const tk = await task(p);
    await pg.query(`insert into public.property_lists (org_id, property_id, list_id) values ('${BMH_ORG_ID}', $1, $2)`, [p, l1]);
    await pg.query(`insert into public.property_tags (org_id, property_id, tag_id) values ('${BMH_ORG_ID}', $1, $2)`, [p, t1]);
    expect(await cache(p)).toMatchObject({ hi: true, hu: true, ot: true, lc: 1 });
    await pg.query(`update public.messages set id = gen_random_uuid(), property_id = $2, direction = 'outbound' where id = $1`, [m, q]);
    await pg.query(`update public.tasks set id = gen_random_uuid(), related_property_id = $2 where id = $1`, [tk, q]);
    await pg.query(`update public.property_lists set id = gen_random_uuid(), property_id = $2 where property_id = $1`, [p, q]);
    await pg.query(`update public.property_tags set id = gen_random_uuid(), property_id = $2 where property_id = $1`, [p, q]);
    expect(await cache(p)).toMatchObject({ hi: false, ho: false, hu: false, ot: false, lc: 0, lids: [], tids: [] });
    expect(await cache(q)).toMatchObject({ hi: false, ho: true, hu: false, ot: true, lc: 1, lids: [l1], tids: [t1] });
  });

  it("moving a property to another org drops old-org children and counts new-org children", async () => {
    const p = await prop();
    await msg(p, "inbound");
    expect(await cache(p)).toMatchObject({ hi: true, hu: true });
    await pg.query(`update public.properties set org_id = $2 where id = $1`, [p, TEST_ORG_B_ID]);
    expect(await cache(p)).toMatchObject({ hi: false, hu: false });
    await msg(p, "outbound", { org: TEST_ORG_B_ID });
    expect(await cache(p)).toMatchObject({ hi: false, ho: true });
    await pg.query(`update public.properties set org_id = $2 where id = $1`, [p, BMH_ORG_ID]);
    expect(await cache(p)).toMatchObject({ hi: true, ho: false, hu: true });
  });
});

describe("generated columns are derived from the catalog", () => {
  it("a generated column added later does not break cache refresh on a DNC-locked property", async () => {
    const p = await prop();
    await pg.query(`update public.properties set outreach_dispo = 'dnc' where id = $1`, [p]);
    await pg.query(`alter table public.properties add column zz_gen_probe text generated always as (lower(coalesce(address, ''))) stored`);
    try {
      await msg(p, "inbound"); // would raise DNC_LOCKED if the generated column were not ignored
      expect(await cache(p)).toMatchObject({ hi: true, hu: true });
    } finally {
      await pg.query(`alter table public.properties drop column zz_gen_probe`);
    }
  });
});

describe("insert fast path (skip when cached flags already cover the row)", () => {
  const truth = async (id: string) => {
    const { rows } = await pg.query(
      `select exists(select 1 from public.messages where property_id=$1 and org_id=$2 and direction='inbound') hi,
              exists(select 1 from public.messages where property_id=$1 and org_id=$2 and direction='outbound') ho,
              exists(select 1 from public.messages where property_id=$1 and org_id=$2 and direction='inbound' and read_at is null) hu,
              exists(select 1 from public.tasks where related_property_id=$1 and org_id=$2 and status='open') ot`,
      [id, BMH_ORG_ID],
    );
    return rows[0];
  };
  const cacheTruth = async (id: string) => {
    const c = await cache(id);
    return { hi: c.hi, ho: c.ho, hu: c.hu, ot: c.ot };
  };
  const conn = async () => { const c = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL! }); await c.connect(); return c; };

  it("a covered insert skips (no property update) while an uncovered one still flips the flag", async () => {
    const p = await prop();
    await msg(p, "inbound");
    const before = (await pg.query(`select xmin::text x from public.properties where id=$1`, [p])).rows[0].x;
    await msg(p, "inbound", { read: true }); // covered: has_inbound already true and read
    await msg(p, "outbound"); // not covered: has_outbound false -> refresh flips it
    expect(await cache(p)).toMatchObject({ hi: true, ho: true, hu: true });
    const afterSkipOnly = (await pg.query(`select xmin::text x from public.properties where id=$1`, [p])).rows[0].x;
    expect(afterSkipOnly).not.toBe(before); // outbound flip updated the row
    const x1 = afterSkipOnly;
    await msg(p, "outbound"); // covered now -> skip: row version must not change
    await msg(p, "inbound", { read: true });
    const x2 = (await pg.query(`select xmin::text x from public.properties where id=$1`, [p])).rows[0].x;
    expect(x2).toBe(x1);
    await task(p, "completed"); // non-open task never changes the cache
    expect((await pg.query(`select xmin::text x from public.properties where id=$1`, [p])).rows[0].x).toBe(x1);
  });

  it("race: a clearing tx (delete the only inbound) vs a skipping insert -> final cache equals truth (both orders)", async () => {
    for (const order of ["clearer-first", "inserter-first"]) {
      for (let i = 0; i < 6; i++) {
        const p = await prop();
        const m = await msg(p, "inbound", { read: true });
        const a = await conn(); // clearer
        const b = await conn(); // inserter (looks covered)
        try {
          const clear = async () => { await a.query("begin"); await a.query(`delete from public.messages where id=$1`, [m]); await sleep(150); await a.query("commit"); };
          const ins = async () => { await b.query("begin"); await b.query(`insert into public.messages (org_id, property_id, channel, direction, body, read_at) values ('${BMH_ORG_ID}', $1, 'sms', 'inbound', 'r', now())`, [p]); await sleep(150); await b.query("commit"); };
          if (order === "clearer-first") { const c = clear(); await sleep(40 + i * 20); await Promise.all([c, ins()]); }
          else { const t = ins(); await sleep(40 + i * 20); await Promise.all([t, clear()]); }
        } finally { await a.end(); await b.end(); }
        expect(await cacheTruth(p), `${order} #${i}`).toEqual(await truth(p));
      }
    }
  });

  it("randomised concurrent workload on a few hot properties: cache == truth afterwards", async () => {
    const props = [await prop(), await prop(), await prop()];
    const workers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => conn()));
    const opts = ["inbound-read", "inbound-unread", "outbound"] as const;
    try {
      await Promise.all(workers.map(async (c, w) => {
        for (let i = 0; i < 40; i++) {
          const p = props[(w + i) % 3];
          const r = (w * 7 + i * 13) % 10;
          try {
            await c.query("begin");
            if (r < 5) {
              const o = opts[(w + i) % 3];
              await c.query(`insert into public.messages (org_id, property_id, channel, direction, body, read_at) values ('${BMH_ORG_ID}', $1, 'sms', $2, 'w', $3)`, [p, o.startsWith("inbound") ? "inbound" : "outbound", o === "inbound-read" ? new Date().toISOString() : null]);
            } else if (r < 7) {
              await c.query(`delete from public.messages where id in (select id from public.messages where property_id=$1 order by created_at limit 2)`, [p]);
            } else if (r < 8) {
              await c.query(`update public.messages set read_at = now() where property_id=$1 and direction='inbound' and read_at is null`, [p]);
            } else if (r < 9) {
              await c.query(`insert into public.tasks (org_id, assignee_id, created_by, related_property_id, type, status, title, due_at) values ($1,$2,$2,$3,'follow_up','open','t',now())`, [BMH_ORG_ID, userAId, p]);
            } else {
              await c.query(`update public.tasks set status='completed' where related_property_id=$1 and status='open'`, [p]);
            }
            await c.query("commit");
          } catch (e: any) {
            await c.query("rollback").catch(() => {});
            if (e.code !== "40P01") throw e; // deadlock is the documented, retryable outcome
          }
        }
      }));
    } finally { await Promise.all(workers.map((c) => c.end())); }
    for (const p of props) expect(await cacheTruth(p)).toEqual(await truth(p));
  });
});
