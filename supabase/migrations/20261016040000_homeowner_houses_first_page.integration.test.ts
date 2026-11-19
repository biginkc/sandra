import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { loadHomeownerHouses, type HousesClient } from "@/lib/leads/homeowner-houses";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

// 20261016040000 adds fn_homeowner_houses_first_page: each homeowner's exact house count and first 50 houses by (address, id),
// for a page of homeowners in one call.
// SECURITY INVOKER, so the properties RLS from 054 is what keeps an org A member out of org B.
const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const migration = readFileSync(new URL("./20261016040000_homeowner_houses_first_page.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../rollbacks/20261016040000_homeowner_houses_first_page.sql", import.meta.url), "utf8");
const strip = (t: string) => t.replace(/^[\s\S]*?\bbegin;\s*/im, "").replace(/\s*commit;\s*$/i, "");

async function withDb(fn: (db: Client) => Promise<void>) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await db.query(strip(migration));
    await fn(db);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}

async function world(db: Client) {
  const a = randomUUID(), b = randomUUID(), member = randomUUID();
  const [c1, c2, cb] = [randomUUID(), randomUUID(), randomUUID()];
  await db.query("insert into auth.users(id,email) values ($1,$2)", [member, `${member}@example.invalid`]);
  await db.query("insert into public.organizations(id,name) values ($1,'Houses A'),($2,'Houses B')", [a, b]);
  await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [member, a]);
  await db.query("insert into public.contacts(id,org_id,first_name) values ($1,$4,'One'),($2,$4,'Two'),($3,$5,'B')", [c1, c2, cb, a, b]);
  const house = (org: string, contact: string, n: number, deleted = false) =>
    db.query(
      `insert into public.properties(org_id,homeowner_contact_id,address,state,deleted_at)
       select $1,$2,'H'||g||' '||$3,'MO',${deleted ? "now()" : "null"} from generate_series(1,$4) g`,
      [org, contact, randomUUID(), n],
    );
  await house(a, c1, 3);
  await house(a, c1, 2, true);
  await house(a, c2, 1);
  await house(b, cb, 4);
  return { a, b, member, c1, c2, cb };
}

async function asMember(db: Client, member: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)", [
    member,
    JSON.stringify({ sub: member, role: "authenticated" }),
  ]);
  await db.query("set local role authenticated");
}

const firstPage = async (db: Client, org: string, ids: string[]) =>
  (await db.query("select * from public.fn_homeowner_houses_first_page($1,$2::uuid[])", [org, ids])).rows;
const counts = async (db: Client, org: string, ids: string[]) =>
  Object.fromEntries((await firstPage(db, org, ids)).map((r) => [r.homeowner_contact_id, Number(r.house_count)]));
type HouseJson = { id: string; address: string };
const housesOf = async (db: Client, org: string, ids: string[], owner: string) =>
  ((await firstPage(db, org, ids)).find((r) => r.homeowner_contact_id === owner)?.houses ?? []) as HouseJson[];

describe("fn_homeowner_houses_first_page", () => {
  it("counts exactly per homeowner and leaves out deleted houses", async () => {
    await withDb(async (db) => {
      const w = await world(db);
      await asMember(db, w.member);
      expect(await counts(db, w.a, [w.c1, w.c2])).toEqual({ [w.c1]: 3, [w.c2]: 1 });
    });
  });

  it("returns at most 50 houses per owner, ordered by address then id, with the exact count on every row", async () => {
    await withDb(async (db) => {
      const w = await world(db);
      // 60 more houses for c1; 10 share one address so only the id tie-break orders them.
      await db.query(
        "insert into public.properties(org_id,homeowner_contact_id,address,state) select $1,$2,'B'||lpad(g::text,3,'0'),'MO' from generate_series(1,50) g",
        [w.a, w.c1],
      );
      await db.query("insert into public.properties(org_id,homeowner_contact_id,address,state) select $1,$2,'A Same St','MO' from generate_series(1,10)", [w.a, w.c1]);
      await asMember(db, w.member);
      const all = await firstPage(db, w.a, [w.c1, w.c2]);
      expect(all).toHaveLength(2); // one row per owner
      expect(Number(all.find((r) => r.homeowner_contact_id === w.c1).house_count)).toBe(63);
      const rows = await housesOf(db, w.a, [w.c1, w.c2], w.c1);
      expect(rows).toHaveLength(50);
      expect(Object.keys(rows[0]).sort()).toEqual(["address", "assigned_user_id", "city", "id", "state"]);
      await db.query("reset role");
      const expected = (await db.query(
        "select id from public.properties where org_id=$1 and homeowner_contact_id=$2 and deleted_at is null order by address, id limit 50",
        [w.a, w.c1],
      )).rows.map((r) => r.id);
      expect(rows.map((r) => r.id)).toEqual(expected);
      expect(rows.slice(0, 10).every((r) => r.address === "A Same St")).toBe(true);
    });
  });

  it("an org A member asking about org B gets nothing, through RLS", async () => {
    await withDb(async (db) => {
      const w = await world(db);
      await asMember(db, w.member);
      expect(await counts(db, w.b, [w.cb])).toEqual({});
      expect(await counts(db, w.a, [w.cb])).toEqual({});
    });
  });

  it("refuses more than 100 ids and accepts exactly 100", async () => {
    await withDb(async (db) => {
      const w = await world(db);
      await asMember(db, w.member);
      const ids = (n: number) => [w.c1, ...Array.from({ length: n - 1 }, () => randomUUID())];
      expect(await counts(db, w.a, ids(100))).toEqual({ [w.c1]: 3 });
      await db.query("savepoint cap");
      await expect(counts(db, w.a, ids(101))).rejects.toThrow(/Too many homeowners/);
      await db.query("rollback to savepoint cap");
    });
  });

  it("only authenticated may execute; anon may not", async () => {
    await withDb(async (db) => {
      const acl = (await db.query("select proacl::text acl from pg_proc where proname='fn_homeowner_houses_first_page'")).rows[0].acl;
      expect(acl).toContain("authenticated=X/");
      expect(acl).not.toMatch(/(^|[{,])(anon|service_role)?=X/);
      expect(acl).not.toContain("anon=");
      const def = (await db.query("select prosecdef from pg_proc where proname='fn_homeowner_houses_first_page'")).rows[0];
      expect(def.prosecdef).toBe(false);
    });
  });

  it("rollback drops the function cleanly and the migration reapplies", async () => {
    await withDb(async (db) => {
      await db.query(strip(rollback));
      expect((await db.query("select to_regprocedure('public.fn_homeowner_houses_first_page(uuid,uuid[])') f")).rows[0].f).toBeNull();
      await db.query(strip(migration));
      const w = await world(db);
      await asMember(db, w.member);
      expect(await counts(db, w.a, [w.c1])).toEqual({ [w.c1]: 3 });
    });
  });
});

// Through PostgREST as a signed-in member: the API caps every response at 1,000 rows, so this proves a page of 100 owners
// with more than 1,000 houses in total still comes back whole.
describe("fn_homeowner_houses_first_page through the API", () => {
  const apiUrl = process.env.TEST_SUPABASE_URL!;
  const anonKey = process.env.TEST_SUPABASE_ANON_KEY!;
  const service = createClient(apiUrl, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const cleanup: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
  });

  it("returns all 100 owners and their exact first pages past 1,000 houses", async () => {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(apiUrl)) throw new Error("local stack only");
    const db = new Client({ connectionString: url });
    await db.connect();
    cleanup.push(() => db.end());
    const org = randomUUID();
    const email = `houses-${randomUUID()}@example.invalid`;
    const password = `Houses-${randomUUID()}`;
    const { data: created, error: createError } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (createError || !created.user) throw new Error(createError?.message ?? "no user");
    const userId = created.user.id;
    cleanup.push(() => service.auth.admin.deleteUser(userId));
    await db.query("insert into public.organizations(id,name) values ($1,'Houses API')", [org]);
    cleanup.push(() => db.query("delete from public.organizations where id=$1", [org]));
    cleanup.push(() => db.query("delete from public.properties where org_id=$1", [org]));
    cleanup.push(() => db.query("delete from public.contacts where org_id=$1", [org]));
    cleanup.push(() => db.query("delete from public.memberships where org_id=$1", [org]));
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [userId, org]);
    const owners = (await db.query("insert into public.contacts(org_id,first_name) select $1,'O'||g from generate_series(1,100) g returning id", [org])).rows.map((r) => r.id as string);
    // 12 houses each = 1,200 houses; two per owner share an address so the id tie-break matters.
    await db.query(
      `insert into public.properties(org_id,homeowner_contact_id,address,state)
       select $1, o, case when g <= 2 then 'Same St' else 'H'||lpad(g::text,2,'0') end, 'MO'
       from unnest($2::uuid[]) o cross join generate_series(1,12) g`,
      [org, owners],
    );

    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password });
    if (signInError || !session.session) throw new Error(signInError?.message ?? "no session");
    const user = createClient(apiUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
    });

    const direct = await user.rpc("fn_homeowner_houses_first_page", { p_org_id: org, p_contact_ids: owners });
    expect(direct.error).toBeNull();
    expect(direct.data).toHaveLength(100);

    const result = await loadHomeownerHouses(user as unknown as HousesClient, { orgId: org, viewerId: userId, contactIds: owners });
    expect(Object.keys(result)).toHaveLength(100);
    for (const owner of owners) {
      const expected = (await db.query(
        "select id from public.properties where org_id=$1 and homeowner_contact_id=$2 and deleted_at is null order by address, id",
        [org, owner],
      )).rows.map((r) => r.id);
      expect(result[owner].count).toBe(12);
      expect(result[owner].houses.map((h) => h.propertyId)).toEqual(expected);
    }
  });
});
