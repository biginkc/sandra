import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

// 20261016040000 adds fn_homeowner_house_counts: exact "Owns N houses" counts for a page of homeowners in one call.
// SECURITY INVOKER, so the properties RLS from 054 is what keeps an org A member out of org B.
const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const migration = readFileSync(new URL("./20261016040000_homeowner_house_counts.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../rollbacks/20261016040000_homeowner_house_counts.sql", import.meta.url), "utf8");
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

const counts = async (db: Client, org: string, ids: string[]) =>
  Object.fromEntries(
    (await db.query("select homeowner_contact_id id, house_count n from public.fn_homeowner_house_counts($1,$2::uuid[])", [org, ids])).rows.map(
      (r) => [r.id, Number(r.n)],
    ),
  );

describe("fn_homeowner_house_counts", () => {
  it("counts exactly per homeowner and leaves out deleted houses", async () => {
    await withDb(async (db) => {
      const w = await world(db);
      await asMember(db, w.member);
      expect(await counts(db, w.a, [w.c1, w.c2])).toEqual({ [w.c1]: 3, [w.c2]: 1 });
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
      const acl = (await db.query("select proacl::text acl from pg_proc where proname='fn_homeowner_house_counts'")).rows[0].acl;
      expect(acl).toContain("authenticated=X/");
      expect(acl).not.toMatch(/(^|[{,])(anon|service_role)?=X/);
      expect(acl).not.toContain("anon=");
      const def = (await db.query("select prosecdef from pg_proc where proname='fn_homeowner_house_counts'")).rows[0];
      expect(def.prosecdef).toBe(false);
    });
  });

  it("rollback drops the function cleanly and the migration reapplies", async () => {
    await withDb(async (db) => {
      await db.query(strip(rollback));
      expect((await db.query("select to_regprocedure('public.fn_homeowner_house_counts(uuid,uuid[])') f")).rows[0].f).toBeNull();
      await db.query(strip(migration));
      const w = await world(db);
      await asMember(db, w.member);
      expect(await counts(db, w.a, [w.c1])).toEqual({ [w.c1]: 3 });
    });
  });
});
