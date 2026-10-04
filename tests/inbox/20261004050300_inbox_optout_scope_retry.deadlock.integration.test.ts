import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const connectionString = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);

type Fixture = { org: string; actor: string; contact: string; property: string; sibling: string; enrollment: string; siblingEnrollment: string; sequence: string };

async function seedCommittedFixture(): Promise<Fixture> {
  const actor = randomUUID();
  const f = { org: randomUUID(), actor, contact: randomUUID(), property: randomUUID(), sibling: randomUUID(), enrollment: randomUUID(), siblingEnrollment: randomUUID(), sequence: randomUUID() };
  const db = new Client({ connectionString });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("insert into public.organizations(id,name) values($1,$2)", [f.org, `DLK2 ${f.org}`]);
    await db.query("insert into auth.users(id,email) values($1,$2)", [actor, `dlk2-${actor}@example.invalid`]);
    await db.query("insert into public.memberships(org_id,user_id,role,access_status) values($1,$2,'owner','active')", [f.org, actor]);
    await db.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values($1,$2,'DLK2',$3,'mobile')", [f.contact, f.org, `+1816555${f.contact.slice(-4)}`]);
    await db.query("insert into public.properties(id,org_id,address,state,homeowner_contact_id) values($1,$2,'DLK2 Way','MO',$4),($3,$2,'DLK2 Sibling Way','MO',$4)", [f.property, f.org, f.sibling, f.contact]);
    await db.query("insert into public.sequences(id,org_id,name) values($1,$2,'DLK2 sequence')", [f.sequence, f.org]);
    await db.query("insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,next_run_at) values($1,$2,$3,$4,'active',clock_timestamp()),($5,$2,$3,$6,'active',clock_timestamp())", [f.enrollment, f.org, f.sequence, f.property, f.siblingEnrollment, f.sibling]);
    await db.query("commit");
    return f;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

async function runDeadlock(
  firstN: (db: Client, f: Fixture) => Promise<unknown>,
  firstO: (db: Client, f: Fixture) => Promise<unknown>,
  secondN: (db: Client, f: Fixture) => Promise<unknown>,
  secondO: (db: Client, f: Fixture) => Promise<unknown>,
  f: Fixture,
) {
  const norma = new Client({ connectionString });
  const optout = new Client({ connectionString });
  await Promise.all([norma.connect(), optout.connect()]);
  try {
    await Promise.all([norma.query("begin"), optout.query("begin")]);
    await Promise.all([norma.query("set local deadlock_timeout='50ms'"), optout.query("set local deadlock_timeout='50ms'")]);
    await firstN(norma, f);
    await firstO(optout, f);
    const outcomes = await Promise.allSettled([secondN(norma, f), secondO(optout, f)]);
    const deadlocks = outcomes.filter((outcome) => outcome.status === "rejected" && (outcome.reason as { code?: string }).code === "40P01");
    expect(deadlocks).toHaveLength(1);
    await Promise.all([norma.query("rollback").catch(() => undefined), optout.query("rollback").catch(() => undefined)]);
  } finally {
    await Promise.all([norma.end(), optout.end()]);
  }
}

describe("DLK2-4 Inbox lock-cycle reproductions", () => {
  beforeAll(() => assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL));

  it("reproduces the same-property cycle: Norma enrollment -> property, opt-out property -> enrollment", async () => {
    const f = await seedCommittedFixture();
    await runDeadlock(
      (db, fixture) => db.query("select id from public.sequence_enrollments where id=$1 for update", [fixture.enrollment]),
      (db, fixture) => db.query("select id from public.properties where id=$1 for update", [fixture.property]),
      (db, fixture) => db.query("select id from public.properties where id=$1 for update", [fixture.property]),
      (db, fixture) => db.query("select id from public.sequence_enrollments where id=$1 for update", [fixture.enrollment]),
      f,
    );
  });

  it("reproduces the sibling-property/same-contact cycle: Norma P2 -> scope, opt-out scope -> P2", async () => {
    const f = await seedCommittedFixture();
    await runDeadlock(
      async (db, fixture) => {
        await db.query("select id from public.sequence_enrollments where id=$1 for update", [fixture.siblingEnrollment]);
        await db.query("select id from public.contacts where id=$1 for update", [fixture.contact]);
        return db.query("select id from public.properties where id=$1 for update", [fixture.sibling]);
      },
      async (db, fixture) => {
        await db.query("select id from public.properties where id=$1 for update", [fixture.property]);
        return db.query("select contact_id from inbox_operation_domain.sms_scopes where org_id=$1 and contact_id=$2 for update", [fixture.org, fixture.contact]);
      },
      (db, fixture) => db.query("select contact_id from inbox_operation_domain.sms_scopes where org_id=$1 and contact_id=$2 for update", [fixture.org, fixture.contact]),
      (db, fixture) => db.query("select id from public.properties where id=$1 for update", [fixture.sibling]),
      f,
    );
  });
});
